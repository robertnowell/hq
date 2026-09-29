-- Turns: the noun the hub is actually made of.
--
-- A hub page is not a list of documents. It is a conversation, newest first,
-- and a document appears UNDER the turn that produced it. Without this table
-- the app can only render the former, which is what it did and why it was
-- rejected. The fields are the ones the panel's summariser already writes and
-- the hub already renders -- headline/deck at the top, then found/proposes/
-- why/next/asked/risk -- so this is a move, not a new invention.
create table if not exists turns (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id)  on delete cascade,
  agent_id    uuid not null references agents(id) on delete cascade,
  -- sessionId:eventRowid from the panel's store. The idempotency key: a
  -- re-run of the backfill updates in place rather than duplicating a turn.
  source_key  text not null,
  at          timestamptz not null,
  topic       text not null,
  headline    text, deck text,
  happened    text,
  findings    text, solution text, rationale text,
  next_step   text, question text, risk text,
  branch      text,
  unique (user_id, source_key)
);

-- The hub's only access pattern: one agent's turns, newest first.
create index if not exists turns_agent_at on turns (agent_id, at desc);

alter table turns enable row level security;
alter table turns force  row level security;
drop policy if exists turns_tenant on turns;
create policy turns_tenant on turns
  using (user_id = hq_current_user_id())
  with check (user_id = hq_current_user_id());
grant select, insert, update, delete on turns to hq_app;
