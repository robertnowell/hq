-- The document door names the company. Ruled 27 Sep, built 29 Sep
-- (hq-app-9d9.12): a page shared to a team says "enter your acme.com email"
-- before sign-in, so a person at the wrong address knows before the code,
-- not after. hq_document_preview already returned the company's name and
-- mark for team pages to the unfurler; it now returns its domain too, and
-- nothing else changes about who sees what.
drop function if exists hq_document_preview(uuid, uuid);
create or replace function hq_document_preview(p_document uuid, p_user uuid)
returns table (doc_title text, doc_summary text, doc_visibility text,
               org_name text, org_logo_url text, org_domain text)
language sql security definer stable set search_path = public, pg_temp
as $$
  with team as (
    select o.name, o.logo_url, o.domain
      from shares s join orgs o on o.id = s.org_id
     where s.document_id = p_document and s.ended_at is null
     order by s.shared_at desc limit 1)
  select d.title, d.summary, d.visibility,
         case when d.visibility = 'team' then (select name from team) end,
         case when d.visibility = 'team' then (select logo_url from team) end,
         case when d.visibility = 'team' then (select domain from team) end
    from documents d
   where d.id = p_document
     and (d.visibility in ('team', 'link') or (p_user is not null and d.user_id = p_user));
$$;
revoke all on function hq_document_preview(uuid, uuid) from public;
grant execute on function hq_document_preview(uuid, uuid) to hq_app;
