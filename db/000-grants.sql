-- What the app role may touch. Idempotent; apply after schema.sql and the
-- numbered migrations, as the owner.
--
-- These grants were first made by hand on 7 Sep 2026 and "left no trace"
-- (db/007). Read back from the live database on 27 Sep 2026 and written
-- down so a fresh install reproduces production. Row-level security, forced
-- on every table, is what keeps a grant on `users` from meaning "every
-- user": the policy users_self narrows it to one row.
--
--   create role hq_app login password '...';   -- once, by hand
grant usage on schema public to hq_app;
grant select, insert, update, delete on
  users, agents, documents, document_events, ingest_heartbeat,
  device_tokens, device_claims, turns
to hq_app;
grant usage on sequence document_events_id_seq to hq_app;
-- Tranquility Base only; harmless if the tables exist and unused.
do $$ begin
  if to_regclass('public.billing') is not null then
    grant select, insert, update on billing to hq_app;
  end if;
  if to_regclass('public.notes') is not null then
    grant select, insert, update, delete on notes to hq_app;
  end if;
end $$;
-- Functions grant their own execute rights where they are defined.
