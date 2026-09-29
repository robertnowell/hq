-- A company's team page is for its members. Ruled 29 Sep 2026.
--
-- The audit of 28 Sep found that anyone who had ever shared one page to a
-- company counted as "allowed" on that company's team page, and allowed
-- meant every page: titles, summaries, author addresses, and search excerpts
-- of the text. A gmail account could share one page to a company's domain and
-- read that company's whole list.
--
-- The rule now, in all three functions that list a team:
--   a member (users.domain = orgs.domain) sees every live team page;
--   a non-member author sees only their own live shares, and nothing once
--   they end them.
-- One predicate, written the same way in each, so the page list, the search
-- and the sidebar count cannot disagree again.

create or replace function hq_my_teams(p_user uuid)
returns table (org_id uuid, domain text, name text, member boolean,
               pages int, unread int, newest timestamptz)
language sql security definer stable set search_path = public, pg_temp
as $$
  with me as (select domain from users where id = p_user),
  live as (select s.org_id, s.document_id, s.shared_at, s.shared_by from shares s where s.ended_at is null),
  mine as (
    select o.id, o.domain, o.name, coalesce(o.domain = (select domain from me), false) as member
      from orgs o
     where o.domain = (select domain from me)
        or exists (select 1 from live l where l.org_id = o.id and l.shared_by = p_user)
  ),
  -- What this person may see of each team: everything for a member, their
  -- own shares for an author.
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
  with o as (select id, domain from orgs where domain = lower(p_domain)),
  me as (select coalesce(u.domain = o.domain, false) as member from users u, o where u.id = p_user)
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
  with o as (select id, domain from orgs where domain = lower(p_domain)),
  me as (select coalesce(u.domain = o.domain, false) as member from users u, o where u.id = p_user)
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
