-- Notes: everything the developer has said, in the words they said it.
--
-- The hub held what the agents wrote and what they did, and nothing of what
-- the person running them said, although the Mac keeps all of it: every
-- dictation the panel transcribed (its Recents) and every line spoken in
-- hands-free (the ledger). Somebody who wants the thing they said to an agent
-- on Tuesday had to find the agent, then the turn, then hope the transcript
-- still carried the prompt. This is the list itself, newest first.
--
-- One row per thing said, keyed the way every mirrored table is keyed: by the
-- user and a source key the Mac derives from its own record, so any resend is
-- an update in place and the mirror is free to backfill whenever it likes.
--   ledger:<hands-free session>:<line number>
--   dictation:<utterance id>
--
-- `agent_session` is who a dictation went to, by the harness's session id,
-- which is also `agents.source_session_id`: the page reads the agent's name
-- through that join, so a rename reaches old notes, and falls back to the
-- `agent_name` the Mac sent for an agent the hub has never seen.
create table if not exists notes (
  user_id       uuid not null references users(id) on delete cascade,
  source_key    text not null,
  at            timestamptz not null,
  source        text not null check (source in ('handsfree', 'dictation')),
  kind          text,
  text          text not null,
  agent_session text,
  agent_name    text,
  tsv           tsvector generated always as (to_tsvector('english', text)) stored,
  primary key (user_id, source_key)
);

-- The page's only order: one person's notes, newest first, paged on `at`.
create index if not exists notes_by_at on notes (user_id, at desc);
-- Tenant column first, for the same reason as documents_search: a search can
-- never cross a user boundary, even if the planner chooses this index.
create index if not exists notes_search on notes using gin (user_id, tsv);

alter table notes enable row level security;
alter table notes force  row level security;
drop policy if exists notes_tenant on notes;
create policy notes_tenant on notes
  using (user_id = hq_current_user_id())
  with check (user_id = hq_current_user_id());
grant select, insert, update, delete on notes to hq_app;
