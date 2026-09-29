-- Who has already been given money, and on whose machine.
--
-- The welcome credit is $10 of real vendor spend given to anyone who signs in.
-- The ledger enforces ONE grant per account -- UNIQUE (account_id, grant_key)
-- -- and accounts are free to create, so on its own that guarantee says only
-- "ten dollars per account", which is not a limit.
--
-- The token route has always said this is the hub's problem: "the hub decides
-- eligibility because eligibility is an identity and abuse question, and the
-- ledger cannot see those." This is that decision, written down.
--
-- The machine is the limit, not the account. A grant is only ever applied to
-- an account reached through a MINTED TOKEN, and a token is only minted for a
-- paired Mac holding a non-exportable key -- so free money already costs an
-- attacker a real machine. Keying on that key's thumbprint makes a second
-- account on the same Mac cost a second Mac, which is the whole point.
--
-- What it deliberately does NOT do:
--   * fingerprint hardware. A reinstall, or a second macOS user, is a new key
--     and gets its own welcome credit. That is the accepted cost of not
--     identifying a person's computer; the alternative is worse to own.
--   * block anybody. An account that is not promotionally eligible still
--     works, still pairs, still spends -- it just spends its own money.

create table if not exists welcome_grants (
  -- The thumbprint of the device key that was paired when the grant was
  -- claimed. One row per machine that has ever been given free money.
  device_key_jkt text primary key,
  user_id        uuid not null references users(id) on delete cascade,
  claimed_at     timestamptz not null default now()
);

create index if not exists welcome_grants_user on welcome_grants (user_id);

-- Eligible, and claimed in the same breath.
--
-- Returns true when this machine has never been given the welcome credit, OR
-- when it was given to THIS user -- because the mint runs every fifteen
-- minutes for the same person and must keep answering the same way. The
-- insert is what makes it a claim rather than a question: two sign-ups racing
-- on one machine cannot both be told yes.
--
-- A device with no key thumbprint (paired before key binding existed) is not
-- eligible. It cannot be issued a bound token either, so this is consistent
-- rather than strict: there is no machine here to attribute a grant to.
create or replace function hq_claim_welcome(p_user uuid, p_jkt text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare owner uuid;
begin
  if p_jkt is null or p_jkt = '' then return false; end if;

  insert into welcome_grants (device_key_jkt, user_id)
  values (p_jkt, p_user)
  on conflict (device_key_jkt) do nothing;

  select user_id into owner from welcome_grants where device_key_jkt = p_jkt;
  return owner = p_user;
end;
$$;

revoke all on function hq_claim_welcome(uuid, text) from public;
grant execute on function hq_claim_welcome(uuid, text) to hq_app;

-- What has been given away, for the operator who has to notice a bad day.
create or replace function hq_welcome_rate()
returns table (last_day bigint, last_hour bigint, total bigint)
language sql security definer set search_path = public as $$
  select
    (select count(*) from welcome_grants where claimed_at > now() - interval '1 day'),
    (select count(*) from welcome_grants where claimed_at > now() - interval '1 hour'),
    (select count(*) from welcome_grants);
$$;

revoke all on function hq_welcome_rate() from public;
grant execute on function hq_welcome_rate() to hq_app;
