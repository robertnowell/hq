-- Safety review, 29 Sep 2026.
--
-- 1. The welcome credit has a global daily ceiling. A grant is keyed to a
--    device key's thumbprint, and nothing yet proves that key lives in a real
--    Mac's secure hardware, so software-made keys could each claim one. Until
--    the Mac app attests its key (App Attest), no more than ten NEW grants
--    are made in any 24 hours; a machine that already holds its grant keeps
--    answering yes. Refusals are counted where the operator already looks.
-- 2. Every SECURITY DEFINER function searches pg_temp last, as PostgreSQL's
--    own guidance requires; five billing functions did not.

create table if not exists welcome_refusals (
  device_key_jkt text not null,
  user_id        uuid not null references users(id) on delete cascade,
  refused_at     timestamptz not null default now()
);
-- Reached only through the definer functions below, like welcome_grants.
alter table welcome_refusals enable row level security;
alter table welcome_refusals force row level security;

create or replace function hq_claim_welcome(p_user uuid, p_jkt text)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare owner uuid; recent int;
begin
  if p_jkt is null or p_jkt = '' then return false; end if;

  select user_id into owner from welcome_grants where device_key_jkt = p_jkt;
  if owner is not null then return owner = p_user; end if;

  -- A new machine. Serialise the ceiling check so two claims cannot both
  -- read nine and both insert.
  perform pg_advisory_xact_lock(hashtext('hq_claim_welcome'));
  select count(*) into recent from welcome_grants where claimed_at > now() - interval '1 day';
  if recent >= 10 then
    insert into welcome_refusals (device_key_jkt, user_id) values (p_jkt, p_user);
    return false;
  end if;

  insert into welcome_grants (device_key_jkt, user_id)
  values (p_jkt, p_user)
  on conflict (device_key_jkt) do nothing;
  select user_id into owner from welcome_grants where device_key_jkt = p_jkt;
  return owner = p_user;
end;
$$;
revoke all on function hq_claim_welcome(uuid, text) from public;
grant execute on function hq_claim_welcome(uuid, text) to hq_app;

drop function if exists hq_welcome_rate();
create or replace function hq_welcome_rate()
returns table (last_day bigint, last_hour bigint, total bigint, refused_last_day bigint)
language sql security definer set search_path = public, pg_temp as $$
  select
    (select count(*) from welcome_grants where claimed_at > now() - interval '1 day'),
    (select count(*) from welcome_grants where claimed_at > now() - interval '1 hour'),
    (select count(*) from welcome_grants),
    (select count(*) from welcome_refusals where refused_at > now() - interval '1 day');
$$;
revoke all on function hq_welcome_rate() from public;
grant execute on function hq_welcome_rate() to hq_app;

alter function hq_reconciliation_candidates() set search_path = public, pg_temp;
alter function hq_record_reconciliation(integer, integer, integer, jsonb, integer) set search_path = public, pg_temp;
alter function hq_reconciliation_state() set search_path = public, pg_temp;
