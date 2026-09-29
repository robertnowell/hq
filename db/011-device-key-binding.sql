-- A paired Mac brings a key that cannot leave it.
--
-- The device token in `device_tokens` is a long-lived secret in a file. That
-- is fine for mirroring pages and it is not fine for spending money: anyone
-- who can read the file can mint a fresh, perfectly valid Gateway token and
-- spend the balance. Binding only the short-lived Gateway token to a key
-- would harden the window and leave the door, which is the shape of a
-- security change that measures well and changes nothing.
--
-- So the binding happens HERE, at pairing. The Mac generates a P-256 key in
-- its Secure Enclave, where it is non-exportable by construction, and sends
-- the PUBLIC half when it collects the pairing it already proved it started.
-- From then on the token in the file is inert on its own: every Gateway
-- request must also carry a fresh signature from a key that never left the
-- machine. See contracts/gateway/v1/TOKEN.md in the native repo.
--
-- The thumbprint, not the key. RFC 7638 defines a canonical SHA-256 JWK
-- thumbprint; that value is what a DPoP-bound access token carries as
-- `cnf.jkt`, so storing it is storing exactly the comparison we will make,
-- with no room for two implementations to canonicalize differently.
alter table device_tokens add column if not exists key_jkt text;

-- Deliberately nullable, and deliberately not backfilled. A device paired
-- before this migration has no key and can never acquire one retroactively:
-- there is nothing to prove possession WITH. Such a device keeps working for
-- the mirror and cannot be granted spending authority, and the way to give
-- it that is to pair again. That is the whole migration cost of doing this
-- now rather than later, and today it is one Mac.
comment on column device_tokens.key_jkt is
  'RFC 7638 SHA-256 JWK thumbprint of the device''s non-exportable public key. '
  'Null means paired before key binding: mirror yes, spending no.';

-- Collecting a pairing now records the key alongside the token.
--
-- The parameter has a default so that the two-argument call still resolves
-- during the window between this migration running and the new code being
-- live. The old two-argument function is dropped in the same breath, because
-- leaving both would make a two-argument call ambiguous rather than
-- compatible.
drop function if exists hq_claim_device(text, text);

create or replace function hq_claim_device(p_hash text, p_token_hash text, p_jkt text default null)
returns table (status text, device_id uuid, device_name text)
language plpgsql security definer set search_path = public, pg_temp
as $$
declare c device_claims%rowtype; new_id uuid;
begin
  update device_claims set polls = polls + 1
   where code_sha256 = p_hash returning * into c;

  -- Unchanged from 007: an unknown code and a pending one answer identically,
  -- and one statement per state so the answer and the poll count cannot
  -- disagree.
  if not found then status := 'pending'; return next; return; end if;
  if c.polls > 400 then status := 'slow_down'; return next; return; end if;
  if c.claimed_at is not null then status := 'claimed'; return next; return; end if;
  if c.expires_at < now() then status := 'expired'; return next; return; end if;

  insert into device_tokens (user_id, name, token_sha256, key_jkt)
       values (c.user_id, c.device_name, p_token_hash, p_jkt)
    returning id into new_id;
  update device_claims set claimed_at = now() where code_sha256 = p_hash;

  status := 'ok'; device_id := new_id; device_name := c.device_name;
  return next;
end $$;
revoke all on function hq_claim_device(text, text, text) from public;
grant execute on function hq_claim_device(text, text, text) to hq_app;

-- Exchanging a token now also says which key that device proved possession
-- of, so the mint can bind the access token it issues without a second
-- lookup. Same shape and same reasoning as 004: security definer, pinned
-- search path, and it cannot run inside a tenant scope because it is what
-- establishes the tenant.
-- A return type cannot be changed by CREATE OR REPLACE, so this one is
-- dropped and rebuilt. That is a sub-second window in which token auth
-- fails closed rather than open, which is the right direction to fail.
drop function if exists hq_user_for_token(text);

create function hq_user_for_token(p_hash text)
returns table (user_id uuid, token_id uuid, key_jkt text)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
  update device_tokens set last_used_at = now()
   where token_sha256 = p_hash and revoked_at is null
   returning device_tokens.user_id, device_tokens.id, device_tokens.key_jkt;
end $$;
revoke all on function hq_user_for_token(text) from public;
grant execute on function hq_user_for_token(text) to hq_app;
