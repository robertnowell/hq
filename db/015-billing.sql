-- Where a person's billing policy lives: the card, the rule, and nothing else.
--
-- The split is deliberate and it is the whole design. This hub owns the card
-- and the POLICY -- whether to top up, below what, and to what -- because the
-- card is entered here and the browser is here. The Gateway owns the LEDGER
-- and holds none of this: no card, no threshold, no consent flag. It answers
-- what a balance is and credits what it is told was paid for.
--
-- So nothing in this table is money. It is a rule about money that lives
-- somewhere else, and the worst a bug here can do is buy at the wrong moment,
-- never charge twice for the same payment -- that guarantee is the ledger's
-- UNIQUE (account_id, grant_key), and it is keyed on the payment id.

create table if not exists billing (
  user_id            uuid primary key references users(id) on delete cascade,
  -- Stripe's customer, created the first time a card is added. Everything
  -- about the card itself stays at Stripe; we keep the handle and the last
  -- four so a page can say which card without holding one.
  stripe_customer_id text unique,
  card_brand         text,
  card_last4         text check (card_last4 is null or card_last4 ~ '^[0-9]{4}$'),
  card_exp           text,
  -- Adding a card IS the consent to top up, so this defaults true and only a
  -- deliberate act turns it off. Ruled 23 Sep 2026.
  autopay            boolean not null default true,
  -- "When my balance falls below X, top it up to Y." A ceiling rather than an
  -- increment, so the number on the page means the same thing whoever reads it.
  below_micros       bigint  not null default 2000000  check (below_micros >= 0),
  upto_micros        bigint  not null default 12000000 check (upto_micros > 0),
  check (upto_micros > below_micros),
  -- A declined card pauses rather than retries: one attempt, then it waits for
  -- a human. The alternative is a bank-fee spiral nobody asked for.
  paused_at          timestamptz,
  paused_reason      text,
  -- Set while a top-up is in flight, so a second check cannot start another.
  -- Recharge is serialized (CL-08), and this is where.
  charging_since     timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table billing enable row level security;
alter table billing force row level security;

drop policy if exists billing_own on billing;
create policy billing_own on billing
  using (user_id = hq_current_user_id())
  with check (user_id = hq_current_user_id());

grant select, insert, update on billing to hq_app;

-- The scheduled check runs under no tenant context, because it is deliberately
-- cross-tenant: it must see everyone whose balance might be low. Same shape as
-- hq_revoked_devices -- one security definer function, pinned search path,
-- granted only to the app role, exposing only what the caller needs.
--
-- What it exposes is thin on purpose: who to ask about, and the rule to apply.
-- No card, no customer id, no history. The caller gets a customer id only when
-- it has decided to charge, through hq_billing_for_charge below.
create or replace function hq_autopay_candidates()
returns table (user_id uuid, below_micros bigint, upto_micros bigint)
language sql security definer set search_path = public, pg_temp
as $$
  select user_id, below_micros, upto_micros from billing
   where autopay
     and stripe_customer_id is not null
     and paused_at is null
     -- A top-up already in flight is not a candidate. Ten minutes is far
     -- longer than a charge takes and far shorter than a person notices.
     and (charging_since is null or charging_since < now() - interval '10 minutes')
$$;
revoke all on function hq_autopay_candidates() from public;
grant execute on function hq_autopay_candidates() to hq_app;

-- Claim one person's top-up, or get nothing. The UPDATE is the lock: two
-- checks racing cannot both come away with a customer to charge.
create or replace function hq_claim_topup(who uuid)
returns table (stripe_customer_id text, upto_micros bigint)
language sql security definer set search_path = public, pg_temp
as $$
  update billing set charging_since = now(), updated_at = now()
   where user_id = who and autopay and stripe_customer_id is not null
     and paused_at is null
     and (charging_since is null or charging_since < now() - interval '10 minutes')
  returning stripe_customer_id, upto_micros
$$;
revoke all on function hq_claim_topup(uuid) from public;
grant execute on function hq_claim_topup(uuid) to hq_app;

-- A charge finished, one way or the other. Success clears the claim; a
-- decline clears it and pauses, which is what stops the retry spiral.
create or replace function hq_finish_topup(who uuid, ok boolean, why text)
returns void
language sql security definer set search_path = public, pg_temp
as $$
  update billing
     set charging_since = null,
         paused_at      = case when ok then null else now() end,
         paused_reason  = case when ok then null else why end,
         updated_at     = now()
   where user_id = who
$$;
revoke all on function hq_finish_topup(uuid, boolean, text) from public;
grant execute on function hq_finish_topup(uuid, boolean, text) to hq_app;

-- The webhook runs under no tenant context either: Stripe tells us a customer
-- paid, and the customer id is the only thing we can look a person up by.
create or replace function hq_user_for_customer(customer text)
returns uuid
language sql security definer set search_path = public, pg_temp
as $$ select user_id from billing where stripe_customer_id = customer $$;
revoke all on function hq_user_for_customer(text) from public;
grant execute on function hq_user_for_customer(text) to hq_app;
