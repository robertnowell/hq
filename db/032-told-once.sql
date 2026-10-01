-- The first unattended charge is announced, once.
--
-- Autopay is on by default once a card is added, which Robert ruled on 23 Sep
-- and which is right: the card IS the consent. But a charge somebody consented
-- to in principle and has never seen happen is still a surprise the first time
-- it lands on a statement. Ruled 1 Oct: we email on the first one.
--
-- Once. A webhook is delivered more than once by design, so the telling is
-- CLAIMED rather than checked -- the same shape as every other
-- exactly-once decision here: an UPDATE that only one caller can win.
alter table billing add column if not exists first_charge_told_at timestamptz;

-- True for exactly one caller, ever, per person. A second delivery of the same
-- event, or two deliveries racing, get false and send nothing.
create or replace function hq_claim_first_charge_telling(p_user uuid)
returns boolean
language sql security definer set search_path = public, pg_temp as $$
  update billing set first_charge_told_at = now()
   where user_id = p_user and first_charge_told_at is null
  returning true;
$$;

revoke all on function hq_claim_first_charge_telling(uuid) from public;
grant execute on function hq_claim_first_charge_telling(uuid) to hq_app;
