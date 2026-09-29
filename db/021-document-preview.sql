-- A document's preview, for the link unfurler. Ruled 28 Sep 2026.
--
-- iMessage, Slack and the rest fetch a link with no session and show what
-- the page says about itself. A shared document's address now answers them
-- with the document's own title and summary, and, when it is shared with a
-- company, that company's mark; a private document, or one that does not
-- exist, answers with nothing, and the two are the same nothing. The owner
-- always gets their own title. Nothing of the content ever leaves here.
create or replace function hq_document_preview(p_document uuid, p_user uuid)
returns table (doc_title text, doc_summary text, doc_visibility text,
               org_name text, org_logo_url text)
language sql security definer stable set search_path = public, pg_temp
as $$
  with team as (
    select o.name, o.logo_url
      from shares s join orgs o on o.id = s.org_id
     where s.document_id = p_document and s.ended_at is null
     order by s.shared_at desc limit 1)
  select d.title, d.summary, d.visibility,
         case when d.visibility = 'team' then (select name from team) end,
         case when d.visibility = 'team' then (select logo_url from team) end
    from documents d
   where d.id = p_document
     and (d.visibility in ('team', 'link') or (p_user is not null and d.user_id = p_user));
$$;
revoke all on function hq_document_preview(uuid, uuid) from public;
grant execute on function hq_document_preview(uuid, uuid) to hq_app;
