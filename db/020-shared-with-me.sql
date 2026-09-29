-- Shared with you. Ruled 27 Sep 2026.
--
-- A person who arrives by a link, or by their company's domain, owns
-- nothing here and needs one list: what has been shared with them. Their
-- team's pages come from the live shares on their domain; the pages they
-- were sent by link are the ones they have opened (a read is the only
-- record a link leaves). Both through one SECURITY DEFINER function, like
-- every other cross-tenant read, so the rule lives in one place.
create or replace function hq_shared_with_me(p_user uuid, p_limit int)
returns table (id uuid, title text, slug text, summary text, shared_at timestamptz,
               owner_address text, team_domain text, read boolean)
language sql security definer stable set search_path = public, pg_temp
as $$
  with me as (select domain from users where users.id = p_user),
  by_team as (
    select d.id, s.shared_at, o.domain as team_domain
      from shares s
      join orgs o on o.id = s.org_id
      join documents d on d.id = s.document_id, me
     where s.ended_at is null and d.visibility = 'team'
       and me.domain is not null and o.domain = me.domain
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
   limit p_limit;
$$;
revoke all on function hq_shared_with_me(uuid, int) from public;
grant execute on function hq_shared_with_me(uuid, int) to hq_app;
