-- Sharing, v1. Ruled 27 Sep 2026 (agent 8592f355, page sharing-spec-v1).
--
-- A document is PRIVATE, shared to a TEAM, or open to anyone with the LINK.
-- A team is an email domain. Membership is not a table: a user is in the
-- team whose domain equals the domain of their verified sign-in address, and
-- public providers (gmail.com and the like) are never a domain. Nothing is
-- curated by an owner, so nothing goes stale, and a person who joins a
-- company after a page was shared to it sees the page the first time they
-- sign in. That is Google's shared-drive rule and Notion's open teamspace,
-- and it is the whole point of using the domain.
--
-- Readers are identified: a reader's address is kept on their user row at
-- the sign-in that verified it, so the owner can see who read what. The 9 Sep
-- decision dropped `users.email` because it was a drifting copy kept for a
-- backfill script; this brings an address back for a different reason, as a
-- product fact the owner is promised. Analytics live in the owner's share
-- card and never on top of the content (ruled 27 Sep).
--
-- Everything cross-tenant goes through SECURITY DEFINER functions, the same
-- shape as hq_resolve_user and hq_published: the app role holds no direct
-- access to orgs, and reads shares and reads only through owner-scoped
-- policies.

begin;

-- ------------------------------------------------------------- users

alter table users add column if not exists address           text;
alter table users add column if not exists domain            text;
alter table users add column if not exists domain_checked_at timestamptz;
create index if not exists users_by_domain on users (domain) where domain is not null;

-- Who is asking, and whether we have ever looked at their address.
-- The upsert half is hq_resolve_user's; this returns the two facts identify()
-- needs to decide whether to ask the identity provider once.
create or replace function hq_identity(p_external_id text)
returns table (id uuid, domain text, domain_checked_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
  insert into users (external_id) values (p_external_id)
  on conflict (external_id) do update set external_id = excluded.external_id
    returning users.id, users.domain, users.domain_checked_at;
end $$;
revoke all on function hq_identity(text) from public;
grant execute on function hq_identity(text) to hq_app;

-- Recorded once, from the verified address. p_domain is null for a public
-- provider; the row still records that the check happened.
create or replace function hq_set_identity(p_user uuid, p_address text, p_domain text)
returns void
language sql security definer set search_path = public, pg_temp
as $$
  update users set address = p_address, domain = p_domain, domain_checked_at = now()
   where id = p_user;
$$;
revoke all on function hq_set_identity(uuid, text, text) from public;
grant execute on function hq_set_identity(uuid, text, text) to hq_app;

-- --------------------------------------------------------------- orgs

create table if not exists orgs (
  id         uuid primary key default gen_random_uuid(),
  -- Lower-case, the part after the @. Unique: a domain is one team.
  domain     text not null unique,
  name       text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table orgs enable row level security;
alter table orgs force  row level security;
-- No policy and no grant: the app reaches orgs only through the functions
-- below. A list of every company using the hub is not something a tenant
-- may enumerate.

-- --------------------------------------------------------- documents

alter table documents add column if not exists visibility text not null default 'private'
  check (visibility in ('private', 'team', 'link'));
alter table documents add column if not exists labels  text[] not null default '{}';
alter table documents add column if not exists summary text;
create index if not exists documents_labels on documents using gin (labels);

-- A page somebody had already shared by link keeps that state under the new
-- column. published_at stays as the link timestamp the site feed reads.
update documents set visibility = 'link'
 where published_at is not null and visibility = 'private';

-- ------------------------------------------------------------- shares

create table if not exists shares (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  org_id      uuid not null references orgs(id) on delete cascade,
  shared_by   uuid not null references users(id) on delete cascade,
  shared_at   timestamptz not null default now(),
  -- Ending a share keeps the row: the team page drops it, the history stays.
  ended_at    timestamptz
);
create unique index if not exists shares_live on shares (document_id, org_id) where ended_at is null;
create index if not exists shares_by_org on shares (org_id, shared_at desc) where ended_at is null;
create index if not exists shares_by_document on shares (document_id);

alter table shares enable row level security;
alter table shares force  row level security;
drop policy if exists shares_owner on shares;
-- The owner sees their own shares. Nobody else reads this table directly.
create policy shares_owner on shares
  using (shared_by = hq_current_user_id());
grant select on shares to hq_app;

-- -------------------------------------------------------------- reads

create table if not exists reads (
  document_id uuid not null references documents(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  first_at    timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  seconds     int not null default 0,
  primary key (document_id, user_id)
);
create index if not exists reads_by_user on reads (user_id, last_at desc);

alter table reads enable row level security;
alter table reads force  row level security;
drop policy if exists reads_owner on reads;
-- The document's owner may see who read it. The reader writes through
-- hq_record_read, never directly.
create policy reads_owner on reads
  using (exists (select 1 from documents d
                  where d.id = reads.document_id and d.user_id = hq_current_user_id()));
grant select on reads to hq_app;

-- ------------------------------------------------------------ access

-- May this person read this document. The one rule, in one place.
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
                 join orgs  o on o.id = s.org_id
                 join users u on u.id = p_user
                where s.document_id = d.id and s.ended_at is null
                  and u.domain is not null and u.domain = o.domain))
       ));
$$;
revoke all on function hq_can_read(uuid, uuid) from public;
grant execute on function hq_can_read(uuid, uuid) to hq_app;

-- One document, for a reader who is not its owner. Null when they may not.
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
             and o.domain = (select domain from users where users.id = p_user)
           limit 1)
    from documents d
    join agents a on a.id = d.agent_id
    join users ou on ou.id = d.user_id
   where d.id = p_document and hq_can_read(p_user, p_document);
$$;
revoke all on function hq_document_for_reader(uuid, uuid) from public;
grant execute on function hq_document_for_reader(uuid, uuid) to hq_app;

-- A read, recorded. Upsert: the first open sets first_at, every beacon adds
-- seconds. Refused silently when the person may not read; there is nothing
-- to record.
create or replace function hq_record_read(p_user uuid, p_document uuid, p_seconds int)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not hq_can_read(p_user, p_document) then return; end if;
  insert into reads (document_id, user_id, seconds)
       values (p_document, p_user, greatest(coalesce(p_seconds, 0), 0))
  on conflict (document_id, user_id) do update
    set last_at = now(),
        seconds = reads.seconds + greatest(coalesce(excluded.seconds, 0), 0);
end $$;
revoke all on function hq_record_read(uuid, uuid, int) from public;
grant execute on function hq_record_read(uuid, uuid, int) to hq_app;

-- ------------------------------------------------------------ sharing

-- Share one of my documents to a domain. Creates the team the first time
-- anyone names it (Figma's trick, Notion's rule), records the share, and
-- makes the document a team document. The public-provider refusal happens
-- in the app, where the list lives; here the only guard is ownership.
-- The output columns are named so that neither shadows a table column inside
-- the body: "domain" as an OUT variable made `on conflict (domain)` ambiguous
-- and the first drill run refused every share.
create or replace function hq_share_to_domain(p_user uuid, p_document uuid, p_domain text)
returns table (org_id uuid, org_domain text)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_org uuid; v_domain text := lower(trim(p_domain));
begin
  if not exists (select 1 from documents d where d.id = p_document and d.user_id = p_user) then
    raise exception 'not your document' using errcode = '42501';
  end if;
  if v_domain !~ '^[a-z0-9.-]+\.[a-z]{2,}$' then
    raise exception 'not a domain' using errcode = '22023';
  end if;
  insert into orgs (domain, name, created_by) values (v_domain, v_domain, p_user)
  on conflict (domain) do nothing;
  select o.id into v_org from orgs o where o.domain = v_domain;
  insert into shares (document_id, org_id, shared_by) values (p_document, v_org, p_user)
  on conflict do nothing;
  update documents set visibility = 'team', published_at = null where id = p_document;
  return query select v_org, v_domain;
end $$;
revoke all on function hq_share_to_domain(uuid, uuid, text) from public;
grant execute on function hq_share_to_domain(uuid, uuid, text) to hq_app;

-- End every live share of one of my documents. Visibility is set by the
-- caller, which knows whether it is going private or to the link.
create or replace function hq_unshare(p_user uuid, p_document uuid)
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare n int;
begin
  update shares set ended_at = now()
   where document_id = p_document and shared_by = p_user and ended_at is null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function hq_unshare(uuid, uuid) from public;
grant execute on function hq_unshare(uuid, uuid) to hq_app;

-- ---------------------------------------------------------- the teams

-- The teams a person sees: the one their domain puts them in, and the ones
-- they have shared to as an author. `member` says which.
create or replace function hq_my_teams(p_user uuid)
returns table (org_id uuid, domain text, name text, member boolean,
               pages int, unread int, newest timestamptz)
language sql security definer stable set search_path = public, pg_temp
as $$
  with me as (select domain from users where id = p_user),
  live as (select s.org_id, s.document_id, s.shared_at, s.shared_by from shares s where s.ended_at is null),
  mine as (
    select o.id, o.domain, o.name, (o.domain = (select domain from me)) as member
      from orgs o
     where o.domain = (select domain from me)
        or exists (select 1 from live l where l.org_id = o.id and l.shared_by = p_user)
  )
  select m.id, m.domain, coalesce(m.name, m.domain), m.member,
         (select count(*)::int from live l join documents d on d.id = l.document_id
           where l.org_id = m.id and d.visibility = 'team') as pages,
         (select count(*)::int from live l join documents d on d.id = l.document_id
           where l.org_id = m.id and d.visibility = 'team' and d.user_id <> p_user
             and not exists (select 1 from reads r where r.document_id = d.id and r.user_id = p_user)) as unread,
         (select max(l.shared_at) from live l where l.org_id = m.id) as newest
    from mine m
   order by newest desc nulls last;
$$;
revoke all on function hq_my_teams(uuid) from public;
grant execute on function hq_my_teams(uuid) to hq_app;

-- Everything shared to one team, newest first, for a member or an author.
create or replace function hq_team_documents(p_user uuid, p_domain text, p_limit int)
returns table (id uuid, title text, slug text, summary text, labels text[],
               produced_at timestamptz, shared_at timestamptz,
               agent_title text, source_session_id text,
               owner_id uuid, owner_address text, read boolean)
language sql security definer stable set search_path = public, pg_temp
as $$
  with o as (select id, domain from orgs where domain = lower(p_domain)),
  allowed as (
    select exists (select 1 from users u, o where u.id = p_user and u.domain = o.domain)
        or exists (select 1 from shares s, o where s.org_id = o.id and s.shared_by = p_user) as ok)
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
     and (select ok from allowed)
   order by s.shared_at desc
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;
revoke all on function hq_team_documents(uuid, text, int) from public;
grant execute on function hq_team_documents(uuid, text, int) to hq_app;

-- Who read one of my documents, for the share card.
create or replace function hq_readers(p_user uuid, p_document uuid)
returns table (address text, domain text, first_at timestamptz, last_at timestamptz, seconds int)
language sql security definer stable set search_path = public, pg_temp
as $$
  select u.address, u.domain, r.first_at, r.last_at, r.seconds
    from reads r join users u on u.id = r.user_id
    join documents d on d.id = r.document_id
   where r.document_id = p_document and d.user_id = p_user
   order by r.last_at desc;
$$;
revoke all on function hq_readers(uuid, uuid) from public;
grant execute on function hq_readers(uuid, uuid) to hq_app;

commit;

-- Added after the first draft: a machine credential names a user, and the
-- user's team is on their row. The token exchange cannot see users, so this
-- reads one column for one id.
begin;
create or replace function hq_domain_of(p_user uuid)
returns table (domain text)
language sql security definer stable set search_path = public, pg_temp
as $$ select u.domain from users u where u.id = p_user $$;
revoke all on function hq_domain_of(uuid) from public;
grant execute on function hq_domain_of(uuid) to hq_app;
commit;

-- Two small readers the app needs beside the big ones: my shares of one
-- document by domain (the share card), and ending one team's share.
begin;
create or replace function hq_shares_of(p_user uuid, p_document uuid)
returns table (domain text, shared_at timestamptz)
language sql security definer stable set search_path = public, pg_temp
as $$
  select o.domain, s.shared_at
    from shares s join orgs o on o.id = s.org_id
   where s.document_id = p_document and s.shared_by = p_user and s.ended_at is null
   order by s.shared_at desc;
$$;
revoke all on function hq_shares_of(uuid, uuid) from public;
grant execute on function hq_shares_of(uuid, uuid) to hq_app;

create or replace function hq_unshare_domain(p_user uuid, p_document uuid, p_domain text)
returns int
language plpgsql security definer set search_path = public, pg_temp
as $$
declare n int;
begin
  update shares s set ended_at = now()
    from orgs o
   where o.id = s.org_id and o.domain = lower(p_domain)
     and s.document_id = p_document and s.shared_by = p_user and s.ended_at is null;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function hq_unshare_domain(uuid, uuid, text) from public;
grant execute on function hq_unshare_domain(uuid, uuid, text) to hq_app;
commit;

-- ------------------------------------------------ one truth for visibility
--
-- Seam 1 (architecture pass, 27 Sep): "link" was stored twice, as
-- visibility='link' and as published_at, and the two readers each checked
-- one half. This is the single writer. published_at stays as the timestamp
-- the site feed reads; it is set and cleared HERE and nowhere else, in the
-- same statement as visibility, so the two can never disagree again.
begin;
create or replace function hq_set_visibility(p_user uuid, p_document uuid, p_visibility text, p_slug text)
returns table (visibility text, public_slug text, published_at timestamptz)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if p_visibility not in ('private', 'team', 'link') then
    raise exception 'not a visibility' using errcode = '22023';
  end if;
  if not exists (select 1 from documents d where d.id = p_document and d.user_id = p_user) then
    raise exception 'not your document' using errcode = '42501';
  end if;
  if p_visibility <> 'team' then
    update shares s set ended_at = now()
     where s.document_id = p_document and s.shared_by = p_user and s.ended_at is null;
  end if;
  update documents d
     set visibility   = p_visibility,
         public_slug  = case when p_visibility = 'link' then coalesce(d.public_slug, p_slug) else d.public_slug end,
         published_at = case when p_visibility = 'link' then coalesce(d.published_at, now()) else null end
   where d.id = p_document;
  return query select d.visibility, d.public_slug, d.published_at from documents d where d.id = p_document;
end $$;
revoke all on function hq_set_visibility(uuid, uuid, text, text) from public;
grant execute on function hq_set_visibility(uuid, uuid, text, text) to hq_app;

-- hq_share_to_domain no longer touches published_at itself; it delegates.
create or replace function hq_share_to_domain(p_user uuid, p_document uuid, p_domain text)
returns table (org_id uuid, org_domain text)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_org uuid; v_domain text := lower(trim(p_domain));
begin
  if not exists (select 1 from documents d where d.id = p_document and d.user_id = p_user) then
    raise exception 'not your document' using errcode = '42501';
  end if;
  if v_domain !~ '^[a-z0-9.-]+\.[a-z]{2,}$' then
    raise exception 'not a domain' using errcode = '22023';
  end if;
  insert into orgs (domain, name, created_by) values (v_domain, v_domain, p_user)
  on conflict (domain) do nothing;
  select o.id into v_org from orgs o where o.domain = v_domain;
  insert into shares (document_id, org_id, shared_by) values (p_document, v_org, p_user)
  on conflict do nothing;
  perform hq_set_visibility(p_user, p_document, 'team', null);
  return query select v_org, v_domain;
end $$;

-- ------------------------------------------------------- team search
--
-- Seam 2: search ran inside the tenant scope, so a member could not find
-- what was shared to them. Same tsv, same ranking, reached through the
-- shares of one team, for a member or an author.
create or replace function hq_team_search(p_user uuid, p_domain text, p_q text, p_limit int)
returns table (id uuid, title text, slug text, summary text, labels text[],
               shared_at timestamptz, agent_title text, source_session_id text,
               owner_address text, rank real, snippet text)
language sql security definer stable set search_path = public, pg_temp
as $$
  with o as (select id, domain from orgs where domain = lower(p_domain)),
  allowed as (
    select exists (select 1 from users u, o where u.id = p_user and u.domain = o.domain)
        or exists (select 1 from shares s, o where s.org_id = o.id and s.shared_by = p_user) as ok)
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
     and (select ok from allowed)
     and d.tsv @@ websearch_to_tsquery('english', p_q)
   order by rank desc, s.shared_at desc
   limit greatest(1, least(coalesce(p_limit, 30), 100));
$$;
revoke all on function hq_team_search(uuid, text, text, int) from public;
grant execute on function hq_team_search(uuid, text, text, int) to hq_app;
commit;
