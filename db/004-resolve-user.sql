-- Identity bootstrap without the email.
--
-- Additive: the one-argument form is created beside the two-argument one so
-- the code that calls it can ship before the column it no longer needs is
-- dropped (005). external_id is the tenancy key and always was; the address
-- is read from the identity provider where it is shown.
create or replace function hq_resolve_user(p_external_id text)
returns table (id uuid)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  insert into users (external_id, email)
       values (p_external_id, '')
  on conflict (external_id) do update set external_id = excluded.external_id
    returning users.id;
end $$;

revoke all on function hq_resolve_user(text) from public;
grant execute on function hq_resolve_user(text) to hq_app;
