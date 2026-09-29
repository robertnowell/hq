-- What a document asks of its reader. Ruled 28 Sep 2026 (hq-app-cll.8).
--
-- One stored fact, set at ingest from the page's own "Needs you" block
-- (lib/asks.ts): the sentence it asks, or null when it asks nothing. A
-- document needs you while it asks something and nobody has cleared it; the
-- existing Clear is still the only thing that clears. The sidebar count, the
-- home block and /needs all read this column, so they cannot disagree.
alter table documents add column if not exists asks text;
create index if not exists documents_asking on documents (user_id, produced_at desc) where asks is not null;
