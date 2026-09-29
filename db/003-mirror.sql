-- The mirror: live ingest of documents and turns from a laptop.
--
-- ingested_at on turns is when the row ARRIVED, distinct from `at` (when the
-- turn happened). The arrivals poller asks "what reached the app since I last
-- looked", and a backfilled turn from last week must not masquerade as news
-- just because its `at` is recent-ish, nor be missed because it is old.
alter table turns add column if not exists ingested_at timestamptz not null default now();
create index if not exists turns_ingested on turns (user_id, ingested_at desc);

-- What the last drain said about itself. A run that failed is a different
-- fact from a run that has not happened, and the sidebar prints both.
alter table ingest_heartbeat add column if not exists note text;
