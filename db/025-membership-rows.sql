-- Membership is rows. Ruled 28 Sep 2026 (team hub epic, hq-app-cll.16).
--
-- Until now a person was in a team because users.domain equalled
-- orgs.domain, and every function that lists or admits a team page
-- recomputed that equality. The rule of 27 Sep still decides who joins: a
-- verified sign-in address at a company's domain makes you a member, public
-- providers and relays never do, and a late joiner sees every live team
-- page the first time they sign in. What changes is that the result is
-- stored, so a second way in (an invitation, a second verified address) is
-- a row with a different `via`, and a person who leaves a company leaves a
-- dated row behind rather than silently changing a comparison.
--
-- The rows are written in one place: two triggers. A user's domain changes
-- (hq_set_identity, which identify() now calls at first sight and once a
-- day) and their domain membership follows; an org is created (a first share
-- to a domain, or a profile lookup) and everyone already at that domain joins
-- it. Every function that asked "same domain?" now asks hq_is_member.

create table if not exists memberships (
  org_id   uuid not null references orgs(id) on delete cascade,
  user_id  uuid not null references users(id) on delete cascade,
  via      text not null check (via in ('domain')),
  since    timestamptz not null default now(),
  ended_at timestamptz
);
create unique index if not exists memberships_live
  on memberships (org_id, user_id) where ended_at is null;
create index if not exists memberships_by_user
  on memberships (user_id) where ended_at is null;

-- Like orgs: no policy and no grant. Reached only through the functions
-- below; who belongs to which company is not something a tenant enumerates.
alter table memberships enable row level security;
alter table memberships force row level security;

-- --------------------------------------------------------------- the rule

create or replace function hq_is_member(p_user uuid, p_org uuid)
returns boolean
language sql security definer stable set search_path = public, pg_temp
as $$
  select exists (select 1 from memberships m
                  where m.org_id = p_org and m.user_id = p_user and m.ended_at is null);
$$;
revoke all on function hq_is_member(uuid, uuid) from public;
grant execute on function hq_is_member(uuid, uuid) to hq_app;

-- A user's domain changed (or was read for the first time): end the domain
-- membership that no longer matches, open the one that does if that company
-- exists here. Idempotent; a daily re-read with no change writes nothing.
create or replace function hq_membership_follow_user()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update memberships m set ended_at = now()
    from orgs o
   where m.user_id = new.id and m.via = 'domain' and m.ended_at is null
     and o.id = m.org_id
     and (new.domain is null or o.domain <> new.domain);
  if new.domain is not null then
    insert into memberships (org_id, user_id, via)
    select o.id, new.id, 'domain' from orgs o where o.domain = new.domain
    on conflict do nothing;
  end if;
  return new;
end $$;

drop trigger if exists users_membership on users;
create trigger users_membership
  after insert or update of domain on users
  for each row execute function hq_membership_follow_user();

-- A company appeared: everyone already signed in at its domain joins.
create or replace function hq_membership_follow_org()
returns trigger
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  insert into memberships (org_id, user_id, via)
  select new.id, u.id, 'domain' from users u where u.domain = new.domain
  on conflict do nothing;
  return new;
end $$;

drop trigger if exists orgs_membership on orgs;
create trigger orgs_membership
  after insert on orgs
  for each row execute function hq_membership_follow_org();

-- Everyone who is a member today by the old comparison.
insert into memberships (org_id, user_id, via)
select o.id, u.id, 'domain'
  from users u join orgs o on o.domain = u.domain
 where u.domain is not null
on conflict do nothing;

-- --------------------------------------------------------------- readers

create or replace function hq_can_read(p_user uuid, p_document uuid)
returns boolean
language sql security definer stable set search_path = public, pg_temp
as $$
  select exists (
    select 1 from documents d
     where d.id = p_document
       and (
         d.user_id = p_user
         or d.visibility = 'link'
         or (d.visibility = 'team' and exists (
               select 1 from shares s
                where s.document_id = d.id and s.ended_at is null
                  and hq_is_member(p_user, s.org_id)))
       ));
$$;
revoke all on function hq_can_read(uuid, uuid) from public;
grant execute on function hq_can_read(uuid, uuid) to hq_app;

create or replace function hq_document_for_reader(p_user uuid, p_document uuid)
returns table (id uuid, title text, slug text, storage_key text, visibility text,
               owner_id uuid, owner_address text, agent_title text, source_session_id text,
               team_domain text)
language sql security definer stable set search_path = public, pg_temp
as $$
  select d.id, d.title, d.slug, d.storage_key, d.visibility,
         d.user_id, ou.address, a.title, a.source_session_id,
         (select o.domain from shares s join orgs o on o.id = s.org_id
           where s.document_id = d.id and s.ended_at is null
             and hq_is_member(p_user, o.id)
           limit 1)
    from documents d
    join agents a on a.id = d.agent_id
    join users ou on ou.id = d.user_id
   where d.id = p_document and hq_can_read(p_user, p_document);
$$;
revoke all on function hq_document_for_reader(uuid, uuid) from public;
grant execute on function hq_document_for_reader(uuid, uuid) to hq_app;

create or replace function hq_shared_with_me(p_user uuid, p_limit int)
returns table (id uuid, title text, slug text, summary text, shared_at timestamptz,
               owner_address text, team_domain text, read boolean)
language sql security definer stable set search_path = public, pg_temp
as $$
  with by_team as (
    select d.id, s.shared_at, o.domain as team_domain
      from memberships m
      join orgs o on o.id = m.org_id
      join shares s on s.org_id = m.org_id
      join documents d on d.id = s.document_id
     where m.user_id = p_user and m.ended_at is null
       and s.ended_at is null and d.visibility = 'team'
       and d.user_id <> p_user),
  by_link as (
    select d.id, r.first_at as shared_at, null::text as team_domain
      from reads r
      join documents d on d.id = r.document_id
     where r.user_id = p_user and d.visibility = 'link' and d.user_id <> p_user),
  either as (select * from by_team union all select * from by_link),
  one as (select distinct on (e.id) e.id, e.shared_at, e.team_domain from either e order by e.id, e.shared_at desc)
  select d.id, d.title, d.slug, d.summary, one.shared_at, u.address, one.team_domain,
         exists (select 1 from reads r where r.document_id = d.id and r.user_id = p_user)
    from one
    join documents d on d.id = one.id
    join users u on u.id = d.user_id
   order by one.shared_at desc
   limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;
revoke all on function hq_shared_with_me(uuid, int) from public;
grant execute on function hq_shared_with_me(uuid, int) to hq_app;

-- --------------------------------------------------------------- team pages
-- The rule of db/022 is unchanged: a member sees every live team page; a
-- non-member author sees only their own live shares. Only "member" is now a
-- row instead of a comparison.

create or replace function hq_my_teams(p_user uuid)
returns table (org_id uuid, domain text, name text, member boolean,
               pages int, unread int, newest timestamptz)
language sql security definer stable set search_path = public, pg_temp
as $$
  with live as (select s.org_id, s.document_id, s.shared_at, s.shared_by from shares s where s.ended_at is null),
  mine as (
    select o.id, o.domain, o.name, hq_is_member(p_user, o.id) as member
      from orgs o
     where hq_is_member(p_user, o.id)
        or exists (select 1 from live l where l.org_id = o.id and l.shared_by = p_user)
  ),
  visible as (
    select m.id as org_id, l.document_id, l.shared_at
      from mine m join live l on l.org_id = m.id
     where m.member or l.shared_by = p_user
  )
  select m.id, m.domain, coalesce(m.name, m.domain), m.member,
         (select count(*)::int from visible v join documents d on d.id = v.document_id
           where v.org_id = m.id and d.visibility = 'team') as pages,
         (select count(*)::int from visible v join documents d on d.id = v.document_id
           where v.org_id = m.id and d.visibility = 'team' and d.user_id <> p_user
             and not exists (select 1 from reads r where r.document_id = d.id and r.user_id = p_user)) as unread,
         (select max(v.shared_at) from visible v where v.org_id = m.id) as newest
    from mine m
   order by newest desc nulls last;
$$;
revoke all on function hq_my_teams(uuid) from public;
grant execute on function hq_my_teams(uuid) to hq_app;

create or replace function hq_team_documents(p_user uuid, p_domain text, p_limit int)
returns table (id uuid, title text, slug text, summary text, labels text[],
               produced_at timestamptz, shared_at timestamptz,
               agent_title text, source_session_id text,
               owner_id uuid, owner_address text, read boolean)
language sql security definer stable set search_path = public, pg_temp
as $$
  with o as (select id from orgs where domain = lower(p_domain)),
  me as (select hq_is_member(p_user, o.id) as member from o)
  select d.id, d.title, d.slug, d.summary, d.labels,
         d.produced_at, s.shared_at,
         a.title, a.source_session_id,
         d.user_id, u.address,
         exists (select 1 from reads r where r.document_id = d.id and r.user_id = p_user) as read
    from shares s
    join o on o.id = s.org_id
    join documents d on d.id = s.document_id
    join agents a on a.id = d.agent_id
    join users u on u.id = d.user_id
   where s.ended_at is null and d.visibility = 'team'
     and (coalesce((select member from me), false) or s.shared_by = p_user)
   order by s.shared_at desc
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;
revoke all on function hq_team_documents(uuid, text, int) from public;
grant execute on function hq_team_documents(uuid, text, int) to hq_app;

create or replace function hq_team_search(p_user uuid, p_domain text, p_q text, p_limit int)
returns table (id uuid, title text, slug text, summary text, labels text[],
               shared_at timestamptz, agent_title text, source_session_id text,
               owner_address text, rank real, snippet text)
language sql security definer stable set search_path = public, pg_temp
as $$
  with o as (select id from orgs where domain = lower(p_domain)),
  me as (select hq_is_member(p_user, o.id) as member from o)
  select d.id, d.title, d.slug, d.summary, d.labels, s.shared_at,
         a.title, a.source_session_id, u.address,
         ts_rank(d.tsv, websearch_to_tsquery('english', p_q)) as rank,
         ts_headline('english', coalesce(d.body_text, ''), websearch_to_tsquery('english', p_q),
           'MaxWords=22, MinWords=8, ShortWord=3, MaxFragments=1, StartSel=<<, StopSel=>>') as snippet
    from shares s join o on o.id = s.org_id
    join documents d on d.id = s.document_id
    join agents a on a.id = d.agent_id
    join users u on u.id = d.user_id
   where s.ended_at is null and d.visibility = 'team'
     and (coalesce((select member from me), false) or s.shared_by = p_user)
     and d.tsv @@ websearch_to_tsquery('english', p_q)
   order by rank desc, s.shared_at desc
   limit greatest(1, least(coalesce(p_limit, 30), 100));
$$;
revoke all on function hq_team_search(uuid, text, text, int) from public;
grant execute on function hq_team_search(uuid, text, text, int) to hq_app;
