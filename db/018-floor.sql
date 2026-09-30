-- Whose floor might not cover a block.
--
-- A metered session reserves a whole block up front. If a person's autopay
-- floor sits BELOW that block price there is a band where their balance looks
-- healthy, autopay is content, and nothing can start -- and nothing tells
-- anybody. A price change on 25 Sep opened exactly that band ($2.00 floor
-- against a $2.55 half-hour block) and it was closed by halving the block,
-- not by noticing.
--
-- The hub owns the floor and the Gateway owns the fare, so neither can check
-- the relationship alone. This is the hub's half: the floors, cross-tenant,
-- for the hourly pass that already asks the Gateway for the fare.
create or replace function hq_autopay_floors()
returns table (user_id uuid, below_micros bigint, autopay boolean)
language sql security definer set search_path = public as $$
  select user_id, below_micros, autopay from billing;
$$;

revoke all on function hq_autopay_floors() from public;
grant execute on function hq_autopay_floors() to hq_app;
