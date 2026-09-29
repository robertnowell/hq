-- The opens log. Ruled 28 Sep 2026 (team hub epic, hq-app-cll.2).
--
-- The home needs two lists the store could not answer: what I opened
-- recently, and what my company opened most this week. `reads` holds one row
-- per reader per document (first_at, last_at, seconds) and is the reader
-- list; document_events.opened is an owner-only flag written on every fetch.
-- Neither has a per-open history, and owners never had a read at all.
--
-- One append-only table, written for owners and readers alike through one
-- function that checks access first. A reload inside thirty minutes is the
-- same visit and writes nothing. Rows older than ninety days are pruned by
-- the writer itself, a little at a time.
--
-- Privacy (design of record, 27 Sep: analytics belong to the owner, viewer
-- opt-out; research 28 Sep: Superhuman): no function here names who opened
-- anything. Popular returns counts, and the number of distinct readers so
-- the page can refuse to rank a team too small to rank.

create table if not exists opens (
  id          bigint generated always as identity primary key,
  document_id uuid not null references documents(id) on delete cascade,
  user_id     uuid not null references users(id) on delete cascade,
  at          timestamptz not null default now()
);
create index if not exists opens_by_user on opens (user_id, at desc);
create index if not exists opens_by_document on opens (document_id, at desc);

-- A person sees their own opens and nothing else. Writes go through
-- hq_record_open; aggregates through the definer functions below.
alter table opens enable row level security;
alter table opens force row level security;
drop policy if exists opens_self on opens;
create policy opens_self on opens for select using (user_id = hq_current_user_id());
grant select on opens to hq_app;

create or replace function hq_record_open(p_user uuid, p_document uuid)
returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not hq_can_read(p_user, p_document) then return; end if;
  if exists (select 1 from opens
              where user_id = p_user and document_id = p_document
                and at > now() - interval '30 minutes') then
    return;
  end if;
  insert into opens (document_id, user_id) values (p_document, p_user);
  -- Retention, paid for by the writers: about one write in a hundred clears
  -- a bounded slice of anything past ninety days.
  if random() < 0.01 then
    delete from opens where id in (
      select id from opens where at < now() - interval '90 days' limit 5000);
  end if;
end $$;
revoke all on function hq_record_open(uuid, uuid) from public;
grant execute on function hq_record_open(uuid, uuid) to hq_app;

-- What this person opened, newest first, one row per document, only what
-- they may still read. Titles come from here because a teammate's document
-- is not visible to them under the documents policy.
create or replace function hq_recently_opened(p_user uuid, p_limit int)
returns table (id uuid, title text, summary text, opened_at timestamptz,
               owner_id uuid, agent_title text, team_domain text)
language sql security definer stable set search_path = public, pg_temp
as $$
  with mine as (
    select document_id, max(at) as opened_at
      from opens where user_id = p_user and at > now() - interval '90 days'
     group by document_id)
  select d.id, d.title, d.summary, m.opened_at, d.user_id, a.title,
         (select o.domain from shares s join orgs o on o.id = s.org_id
           where s.document_id = d.id and s.ended_at is null and d.visibility = 'team'
             and hq_is_member(p_user, o.id) limit 1)
    from mine m
    join documents d on d.id = m.document_id
    join agents a on a.id = d.agent_id
   where hq_can_read(p_user, d.id)
   order by m.opened_at desc
   limit greatest(1, least(coalesce(p_limit, 5), 50));
$$;
revoke all on function hq_recently_opened(uuid, int) from public;
grant execute on function hq_recently_opened(uuid, int) to hq_app;

-- The most-opened documents this person may read, over the last p_days.
-- Candidates: their own documents, and live team pages of every company
-- they belong to. Counted: opens by anyone, never named. `readers` is the
-- number of distinct people behind the count across the whole list, which
-- is what the page gates on (research 28 Sep: at five people "popular" is
-- the same three pages every week).
create or replace function hq_popular(p_user uuid, p_days int, p_limit int)
returns table (id uuid, title text, summary text, opens int, openers int,
               owner_id uuid, agent_title text, team_domain text, readers int)
language sql security definer stable set search_path = public, pg_temp
as $$
  with window_ as (select now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 90))) as since),
  candidates as (
    select d.id, null::text as team_domain from documents d where d.user_id = p_user
    union
    select d.id, o.domain
      from memberships m
      join orgs o on o.id = m.org_id
      join shares s on s.org_id = m.org_id and s.ended_at is null
      join documents d on d.id = s.document_id and d.visibility = 'team'
     where m.user_id = p_user and m.ended_at is null),
  counted as (
    select c.id, max(c.team_domain) as team_domain,
           count(op.id)::int as opens, count(distinct op.user_id)::int as openers
      from candidates c
      join opens op on op.document_id = c.id and op.at > (select since from window_)
     group by c.id),
  everyone as (
    select count(distinct op.user_id)::int as n
      from candidates c
      join opens op on op.document_id = c.id and op.at > (select since from window_))
  select d.id, d.title, d.summary, k.opens, k.openers, d.user_id, a.title, k.team_domain,
         (select n from everyone)
    from counted k
    join documents d on d.id = k.id
    join agents a on a.id = d.agent_id
   order by k.opens desc, k.openers desc, d.id
   limit greatest(1, least(coalesce(p_limit, 5), 50));
$$;
revoke all on function hq_popular(uuid, int, int) from public;
grant execute on function hq_popular(uuid, int, int) to hq_app;
