-- Pairing a Mac to this hub.
--
-- The Mac has no credential yet, which is the whole problem: it cannot prove
-- who it is, so it cannot be told anything. The way out is that the MAC
-- invents the secret, not the hub and not a web page. It generates a code,
-- shows a phrase derived from it, and opens the hub in a browser where a
-- signed-in person can approve a device by that name. The Mac then asks,
-- with the code, whether anything is waiting for it.
--
-- A claim row is therefore a record that a PERSON approved a pairing. It
-- holds no token. The token is minted at collection, in hq_claim_device, so
-- a readable copy of a live credential never exists in this database -- the
-- same rule device_tokens already states about itself.
--
-- Ruled 12 Sep 2026 after a research pass; the alternatives (a loopback
-- listener the browser is redirected to, a URL scheme carrying the token)
-- are rejected in that record and should not be revisited without reading
-- it.
create table if not exists device_claims (
  -- The code is never stored. Only its fingerprint, so a leaked backup does
  -- not let anyone collect a pending pairing.
  code_sha256 text primary key,
  user_id     uuid not null references users(id) on delete cascade,
  device_name text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  claimed_at  timestamptz,
  -- Cheap abuse ceiling: an honest client polls every two seconds for ten
  -- minutes, which is three hundred.
  polls       int not null default 0
);
create index if not exists device_claims_expiry on device_claims (expires_at);

alter table device_claims enable row level security;
alter table device_claims force row level security;
drop policy if exists device_claims_own on device_claims;
create policy device_claims_own on device_claims
  using (user_id = hq_current_user_id())
  with check (user_id = hq_current_user_id());

-- The app role reaches this table like every other one. Recorded here rather
-- than applied by hand, because the grants on the first six tables were done
-- out of band and left no trace in this directory: the seventh table failed
-- its first drill on a permission error that the schema could not explain.
grant select, insert, update, delete on table device_claims to hq_app;

-- Collecting a pairing cannot run inside a tenant scope, for the same reason
-- exchanging a token cannot: the lookup is what establishes which tenant
-- this is. Same shape as hq_user_for_token -- security definer, pinned
-- search path, execute granted only to the app role.
--
-- The caller mints the token and passes only its hash. One statement per
-- state so the answer and the poll count cannot disagree.
create or replace function hq_claim_device(p_hash text, p_token_hash text)
returns table (status text, device_id uuid, device_name text)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare c device_claims%rowtype; new_id uuid;
begin
  update device_claims set polls = polls + 1
   where code_sha256 = p_hash returning * into c;

  -- An unknown code and a pending one answer identically. The code is 256
  -- bits, so this is not load bearing, but a caller learns nothing either
  -- way and that is free.
  if not found then status := 'pending'; return next; return; end if;
  if c.polls > 400 then status := 'slow_down'; return next; return; end if;
  if c.claimed_at is not null then status := 'claimed'; return next; return; end if;
  if c.expires_at < now() then status := 'expired'; return next; return; end if;

  insert into device_tokens (user_id, name, token_sha256)
       values (c.user_id, c.device_name, p_token_hash)
    returning id into new_id;
  update device_claims set claimed_at = now() where code_sha256 = p_hash;

  status := 'ok'; device_id := new_id; device_name := c.device_name;
  return next;
end $$;
revoke all on function hq_claim_device(text, text) from public;
grant execute on function hq_claim_device(text, text) to hq_app;

-- Claimed and expired rows are kept for a day so a second collection can say
-- "expired" rather than "pending", which is the difference between a client
-- that stops and one that polls for ten minutes at nothing.
create or replace function hq_expire_claims() returns void
language sql security definer set search_path = public, pg_temp
as $$ delete from device_claims where expires_at < now() - interval '1 day' $$;
revoke all on function hq_expire_claims() from public;
grant execute on function hq_expire_claims() to hq_app;
