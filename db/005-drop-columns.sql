-- Two columns that stopped meaning anything, and a search that had stopped
-- working without anyone noticing.
--
-- documents.html: every document moved to the bucket on 8 Sep; the column
-- has held null on every row since. And the generated search column `tsv`
-- was still defined over it, so it has been NULL on every document since
-- the same day: the search box matched nothing and no query ever said so.
-- The drill's "search for B's word finds nothing for A" passed because
-- search found nothing for anyone. This redefines tsv over body_text, the
-- stripped text the storage split introduced, and rebuilds the index.
--
-- users.email: a copy of something Clerk owns, which drifts. Asked 8 Sep,
-- settled by the product decision of 9 Sep (teams come through Clerk
-- Organizations, so the provider is the address book, not us).
--
-- Apply AFTER the code that no longer reads them is running: the previous
-- build selects both.
begin;

drop index if exists documents_search;
alter table documents drop column if exists tsv;
alter table documents drop column if exists html;
alter table documents add column tsv tsvector generated always as (
  to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body_text, ''))
) stored;
create index documents_search on documents using gin (user_id, tsv);

drop function if exists hq_resolve_user(text, text);
create or replace function hq_resolve_user(p_external_id text)
returns table (id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  insert into users (external_id)
       values (p_external_id)
  on conflict (external_id) do update set external_id = excluded.external_id
    returning users.id;
end $$;
revoke all on function hq_resolve_user(text) from public;
grant execute on function hq_resolve_user(text) to hq_app;

alter table users drop column if exists email;

commit;
