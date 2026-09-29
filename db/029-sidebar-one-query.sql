-- The sidebar's other tenants, in one call. hq-app-cll.3 (was 9d9.6), 29 Sep.
--
-- layout.tsx ran my_teams, shared_with_me and one team_documents per team on
-- every request, and again every ten seconds under the arrivals poll: four
-- plus N round trips on a pool of two per function. What is the reader's own
-- (agents, devices, labels, needs) is now one query under their own policy
-- (lib/queries.ts sidebarOwn); what belongs to other tenants is this one
-- definer function, built only from the functions that already hold the
-- rules, so it cannot disagree with the team page or Shared with you.

create or replace function hq_sidebar_teams(p_user uuid)
returns jsonb
language sql security definer stable set search_path = public, pg_temp
as $$
  with t as (select * from hq_my_teams(p_user) limit 20),
  shared as (select * from hq_shared_with_me(p_user, 500))
  select jsonb_build_object(
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.org_id, 'domain', t.domain, 'name', t.name, 'member', t.member,
               'pages', t.pages, 'unread', t.unread,
               'docs', coalesce((
                 select jsonb_agg(jsonb_build_object('id', d.id, 'title', coalesce(d.title, d.slug), 'at', d.shared_at)
                                  order by d.shared_at desc)
                   from hq_team_documents(p_user, t.domain, 5) d), '[]'::jsonb))
             order by t.newest desc nulls last)
        from t), '[]'::jsonb),
    'shared', jsonb_build_object(
      'count', (select count(*) from shared),
      'unread', (select count(*) from shared where not read)));
$$;
revoke all on function hq_sidebar_teams(uuid) from public;
grant execute on function hq_sidebar_teams(uuid) to hq_app;

-- Topic counts run per tenant from here on (research 28 Sep): the labels
-- index was the one GIN index on documents without the tenant in front.
create index if not exists documents_labels_by_user on documents using gin (user_id, labels);
drop index if exists documents_labels;
