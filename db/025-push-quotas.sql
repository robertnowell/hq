-- Per-account daily push quotas. Safety review, 29 Sep 2026 (hq-app-cll.19).
--
-- Documents were capped at 4 MB each, but an account could push without
-- limit, growing Postgres and storage for everyone. Each account now has a
-- daily budget per kind, taken atomically before anything is written; a
-- call that would exceed it is refused whole and writes nothing.
--
-- The limits sit well above real use, measured 29 Sep: the busiest day ever
-- was 864 documents (a backfill), 4,125 turns and 233 notes.
--   document  2,000 a day, 500 MB
--   turn     20,000 a day, 200 MB
--   note      5,000 a day,  50 MB
--   asset     2,000 a day, 1 GB
-- A day is the UTC calendar day.

create table if not exists ingest_usage (
  user_id uuid not null references users(id) on delete cascade,
  day     date not null default (now() at time zone 'utc')::date,
  kind    text not null check (kind in ('document','turn','note','asset')),
  count   integer not null default 0,
  bytes   bigint  not null default 0,
  primary key (user_id, day, kind)
);
alter table ingest_usage enable row level security;
alter table ingest_usage force row level security;

create or replace function hq_quota_take(p_user uuid, p_kind text, p_count int, p_bytes bigint)
returns table (ok boolean, used_count int, used_bytes bigint, limit_count int, limit_bytes bigint)
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  lc int; lb bigint; c int; b bigint;
  today date := (now() at time zone 'utc')::date;
begin
  select l.c, l.b into lc, lb from (values
    ('document', 2000,  500000000::bigint),
    ('turn',     20000, 200000000::bigint),
    ('note',     5000,   50000000::bigint),
    ('asset',    2000, 1000000000::bigint)) as l(k, c, b)
   where l.k = p_kind;
  if lc is null then raise exception 'unknown quota kind %', p_kind using errcode = '22023'; end if;

  insert into ingest_usage (user_id, day, kind, count, bytes)
  values (p_user, today, p_kind, 0, 0)
  on conflict (user_id, day, kind) do nothing;

  -- Take the budget only if the whole call fits; the row lock serialises
  -- concurrent calls for the same account and kind.
  update ingest_usage u
     set count = u.count + greatest(p_count, 0), bytes = u.bytes + greatest(p_bytes, 0)
   where u.user_id = p_user and u.day = today and u.kind = p_kind
     and u.count + greatest(p_count, 0) <= lc and u.bytes + greatest(p_bytes, 0) <= lb
  returning u.count, u.bytes into c, b;

  if found then
    return query select true, c, b, lc, lb;
  else
    select u.count, u.bytes into c, b from ingest_usage u where u.user_id = p_user and u.day = today and u.kind = p_kind;
    return query select false, c, b, lc, lb;
  end if;
end $$;
revoke all on function hq_quota_take(uuid, text, int, bigint) from public;
grant execute on function hq_quota_take(uuid, text, int, bigint) to hq_app;
