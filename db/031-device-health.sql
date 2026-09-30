-- Each Mac's agent-rules health, reported hourly by Tranquility Base.
--
-- 30 Sep 2026: a MacBook's agents wrote fourteen reports into a folder its
-- uploader never read, following page rules two months old, and nothing
-- noticed for six days: every stage looked healthy on its own. The research
-- (agents/8592f355/2026-09-30-agent-rules-durable-delivery) put the fix in
-- two halves: every machine converges on the rules its app ships, and every
-- machine REPORTS what it runs and what it failed to deliver, so the hub can
-- see drift within the hour. This is the second half's table.
--
-- One row per (person, Mac, app edition): the latest report only. Dev and
-- Prod are different editions and may legitimately run different rules.

create table if not exists device_health (
  user_id           uuid not null references users(id) on delete cascade,
  device            text not null,
  edition           text not null,
  app_commit        text,
  rules_fingerprint text,
  rules_source      text,
  undelivered       int  not null default 0,
  problems          text[] not null default '{}',
  report            jsonb not null,
  reported_at       timestamptz not null default now(),
  primary key (user_id, device, edition)
);
alter table device_health enable row level security;
alter table device_health force  row level security;
drop policy if exists device_health_tenant on device_health;
create policy device_health_tenant on device_health
  using (user_id = hq_current_user_id())
  with check (user_id = hq_current_user_id());
grant select, insert, update, delete on device_health to hq_app;

-- What the hourly check alarms on, across every account: the Macs whose
-- latest report (within the last three hours) names a problem. A Mac that is
-- asleep or off is not a problem, so silence is not counted here; the check's
-- own heartbeat covers the check itself going quiet.
create or replace function hq_fleet_problems()
returns table (device text, edition text, problems text[], undelivered int,
               rules_fingerprint text, reported_at timestamptz)
language sql security definer stable set search_path = public, pg_temp
as $$
  select h.device, h.edition, h.problems, h.undelivered, h.rules_fingerprint, h.reported_at
    from device_health h
   where h.reported_at > now() - interval '3 hours'
     and cardinality(h.problems) > 0
   order by h.reported_at desc
   limit 50;
$$;
revoke all on function hq_fleet_problems() from public;
grant execute on function hq_fleet_problems() to hq_app;

-- How many Macs reported at all in the window, so "no problems" can be told
-- apart from "nobody reported".
create or replace function hq_fleet_reporting()
returns int
language sql security definer stable set search_path = public, pg_temp
as $$
  select count(*)::int from device_health where reported_at > now() - interval '3 hours';
$$;
revoke all on function hq_fleet_reporting() from public;
grant execute on function hq_fleet_reporting() to hq_app;
