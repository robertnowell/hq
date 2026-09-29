-- Every time we checked whether the two records of the money still agree.
--
-- The reconciler itself reads and never writes to either system. This is the
-- only thing it writes: the fact that it ran, and what it saw. Without it a
-- divergence is a line in a log that ages out, and "when did this start?" has
-- no answer -- which is the first question anybody asks about missing money.
--
-- There is no tenant column and no RLS. A reconciliation is deliberately
-- CROSS-tenant: its whole job is to look at everyone, and nobody but us ever
-- reads it. It is reached through a security definer function, the same shape
-- as hq_autopay_candidates, rather than by granting the app broad access.

create table if not exists reconciliations (
  id          bigserial primary key,
  ran_at      timestamptz not null default now(),
  window_days int  not null,
  -- What was compared, and how much of it agreed. `compared = agreed` is the
  -- only good state; the gap is the story.
  compared    int  not null,
  agreed      int  not null,
  -- One line per disagreement, with the Stripe identifier to chase it. Empty
  -- when all is well, which is most of the time and is worth recording too:
  -- a run that found nothing is evidence, and a gap in these rows means the
  -- check STOPPED, which is its own kind of bad news.
  findings    jsonb not null default '[]'::jsonb,
  -- How long it took, so a check that is quietly falling behind its schedule
  -- is visible before it starts timing out.
  took_ms     int  not null
);

create index if not exists reconciliations_recent on reconciliations (ran_at desc);
create index if not exists reconciliations_trouble on reconciliations (ran_at desc)
  where jsonb_array_length(findings) > 0;

create or replace function hq_record_reconciliation(
  p_window_days int, p_compared int, p_agreed int, p_findings jsonb, p_took_ms int
) returns bigint
language sql security definer set search_path = public as $$
  insert into reconciliations (window_days, compared, agreed, findings, took_ms)
  values (p_window_days, p_compared, p_agreed, coalesce(p_findings, '[]'::jsonb), p_took_ms)
  returning id;
$$;

revoke all on function hq_record_reconciliation(int, int, int, jsonb, int) from public;
grant execute on function hq_record_reconciliation(int, int, int, jsonb, int) to hq_app;

-- The last run, and the last run that found something. Two questions a person
-- actually asks: "is it still checking?" and "when did it last see trouble?"
create or replace function hq_reconciliation_state()
returns table (
  last_at timestamptz, last_ok boolean, last_compared int, last_agreed int,
  trouble_at timestamptz, trouble_findings jsonb
)
language sql security definer set search_path = public as $$
  select
    (select ran_at from reconciliations order by ran_at desc limit 1),
    (select jsonb_array_length(findings) = 0 from reconciliations order by ran_at desc limit 1),
    (select compared from reconciliations order by ran_at desc limit 1),
    (select agreed   from reconciliations order by ran_at desc limit 1),
    (select ran_at   from reconciliations where jsonb_array_length(findings) > 0 order by ran_at desc limit 1),
    (select findings from reconciliations where jsonb_array_length(findings) > 0 order by ran_at desc limit 1);
$$;

revoke all on function hq_reconciliation_state() from public;
grant execute on function hq_reconciliation_state() to hq_app;

-- Who to compare, across every tenant.
--
-- Reconciliation is deliberately cross-tenant, and `billing` is under FORCE
-- row level security, so an ordinary read of it from a job with no tenant
-- context returns NOTHING -- silently. The first run of the scheduled check
-- did exactly that: it compared zero movements and reported that Stripe and
-- the ledger told the same story. A check that checks nothing must never be
-- able to pass, so it gets a security definer function of its own, the same
-- shape as hq_autopay_candidates, exposing only what the comparison needs.
create or replace function hq_reconciliation_candidates()
returns table (user_id uuid, stripe_customer_id text)
language sql security definer set search_path = public as $$
  select user_id, stripe_customer_id from billing where stripe_customer_id is not null;
$$;

revoke all on function hq_reconciliation_candidates() from public;
grant execute on function hq_reconciliation_candidates() to hq_app;
