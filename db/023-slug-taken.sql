-- Is a public slug taken, by anyone? Ruled 29 Sep 2026.
--
-- mintSlug asked "select 1 from documents where public_slug = $1" inside the
-- caller's tenant scope, so row-level security hid every other account's
-- slugs while the unique index is global: a second account whose title
-- matched somebody's shared page failed for ever (audit 28 Sep). Link
-- sharing no longer mints slugs at all; publishing to a site still does,
-- and asks here. Returns a boolean and nothing else, so it reveals only
-- that a name is in use.
create or replace function hq_slug_taken(p_slug text)
returns boolean
language sql security definer stable set search_path = public, pg_temp
as $$ select exists (select 1 from documents where public_slug = p_slug) $$;
revoke all on function hq_slug_taken(text) from public;
grant execute on function hq_slug_taken(text) to hq_app;
