-- The Gateway asks which Macs were disconnected, and can actually be told.
--
-- The first version of this route queried `device_tokens` through the ordinary
-- app pool. That table has FORCED row-level security keyed on
-- hq_current_user_id(), and the feed runs under no tenant context, because it
-- is deliberately cross-tenant: it must return every user's revoked devices.
-- So the policy matched nothing, the route returned 200 with an empty list,
-- and the Gateway recorded a successful refresh. Revocation would never have
-- reached it, silently, and no test noticed because no test ran the route
-- under its real database role.
--
-- The fix is the pattern this schema already uses for exactly this shape of
-- problem, in hq_user_for_token and hq_claim_device: one security definer
-- function with a pinned search path, granted only to the app role, exposing
-- only what the caller needs. Not a bypass on the table, and not an owner
-- connection in the app.
--
-- What it exposes is deliberately thin: the id of a revoked device and when.
-- No user id, no name, no token hash. Something that can see across every
-- tenant should be able to say as little as possible.
create or replace function hq_revoked_devices()
returns table (device_id uuid, revoked_at timestamptz)
language sql security definer set search_path = public, pg_temp
as $$
  select id, revoked_at from device_tokens where revoked_at is not null
$$;
revoke all on function hq_revoked_devices() from public;
grant execute on function hq_revoked_devices() to hq_app;

-- Whole-set, with no cursor and no page.
--
-- The incremental version was wrong three ways: a row limit stalls forever
-- when more rows than the limit share a timestamp; now() is transaction-start
-- time, so a late-committing transaction carries an old stamp and is stepped
-- over permanently; and a cursor shared between Gateway instances lets one
-- consume rows another never sees. A snapshot has none of those properties
-- because it has no memory. Revisit when the count is large enough to measure.
