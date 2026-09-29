-- The hq app: agents, documents, and per-user derived read state.
--
-- Two rules this schema exists to enforce, both ruled 7 Sep 2026:
--
--   1. Every row is keyed on a user. A document is visible only to the user
--      it belongs to. That is the WHERE clause on every query; the RLS
--      policies at the bottom are the net under it, because application
--      scoping fails OPEN (no context, no filter, every row) while RLS
--      fails CLOSED (no context, no rows).
--
--   2. State is DERIVED FROM EVENTS, not stored. A document is unread
--      because no `opened` event exists, not because a column says so.
--      This is the lesson from Tranquility Base: a stored state machine
--      drifts from its own history, an event log cannot. It also makes
--      "read but still waiting on you" fall out for free rather than
--      needing two columns kept in sync.

create extension if not exists pgcrypto;
-- btree_gin gives GIN an operator class for plain scalar types like uuid, so
-- the tenant column and the tsvector can share ONE index. Without it, Postgres
-- refuses the composite index outright:
--   ERROR: data type uuid has no default operator class for access method "gin"
-- The alternative is two indexes combined by a bitmap AND, which works but
-- makes the tenant predicate and the search predicate cooperate less well.
create extension if not exists btree_gin;

-- ---------------------------------------------------------------- users

create table if not exists users (
  id          uuid primary key default gen_random_uuid(),
  -- The identity provider's own id. Clerk today; the column does not care.
  external_id text unique not null,
  email       text not null,
  created_at  timestamptz not null default now()
);

-- --------------------------------------------------------------- agents

-- An agent is one working session that produced documents. It is also the
-- thing a `task` would hang off later: adding tasks is a nullable task_id
-- here, an ALTER TABLE, not a migration.
create table if not exists agents (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  -- The harness's own session id, whatever harness it was. Unique per user
  -- so the same id from two people never collides.
  source_session_id text not null,
  title             text,
  cwd               text,
  first_seen_at     timestamptz not null default now(),
  last_active_at    timestamptz not null default now(),
  unique (user_id, source_session_id)
);

create index if not exists agents_by_activity
  on agents (user_id, last_active_at desc);

-- ------------------------------------------------------------ documents

create table if not exists documents (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  agent_id      uuid not null references agents(id) on delete cascade,

  slug          text not null,
  title         text,

  -- The document itself. Postgres TOASTs anything over ~2 kB, so a 20-500 kB
  -- page lives out of line and the main table stays small enough that listing
  -- queries never touch a body.
  html          text not null,

  -- sha256 of the html. Doubles as the idempotency key on ingest: the same
  -- bytes uploaded twice are one document, and a retried hook cannot create
  -- a duplicate.
  content_hash  text not null,

  -- Searchable body text. Generated, so it cannot drift from the html.
  tsv           tsvector generated always as (
                  to_tsvector('english', coalesce(title,'') || ' ' ||
                    regexp_replace(html, '<[^>]*>', ' ', 'g'))
                ) stored,

  produced_at   timestamptz,          -- when the agent wrote it
  created_at    timestamptz not null default now(),   -- when it landed here

  -- Null means private. Setting it is the deliberate act of publishing, and
  -- nothing sets it automatically.
  published_at  timestamptz,

  unique (user_id, content_hash)
);

create index if not exists documents_by_agent
  on documents (user_id, agent_id, produced_at desc);
create index if not exists documents_by_created
  on documents (user_id, created_at desc);
-- Tenant column first so a search can never cross a user boundary, and the
-- planner still gets the tsvector.
create index if not exists documents_search
  on documents using gin (user_id, tsv);

-- ------------------------------------------------------- document events

-- The append-only log that read state is derived from.
--
--   delivered  the document arrived and was surfaced to this user
--   opened     the user opened it
--   cleared    the user explicitly dismissed it
--
-- Derivations:
--   unread   = delivered, no opened
--   read     = opened
--   waiting  = delivered, no cleared        <- independent of opened
--
-- `waiting` never references `opened`, which is what makes "read and still
-- needs me" representable. Nothing in this system writes a `cleared` event
-- except a human click. That is enforceable by grep, which is the point.
create table if not exists document_events (
  id          bigserial primary key,
  user_id     uuid not null references users(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  kind        text not null check (kind in ('delivered','opened','cleared')),
  at          timestamptz not null default now()
);

create index if not exists document_events_lookup
  on document_events (user_id, document_id, kind);
create index if not exists document_events_recent
  on document_events (user_id, at desc);

-- ------------------------------------------------------------- heartbeat

-- A hook that stops firing produces no error, so the absence of a signal is
-- what gets monitored. The UI reads this to say "last seen 3 days ago".
create table if not exists ingest_heartbeat (
  user_id      uuid not null references users(id) on delete cascade,
  device_name  text not null,
  last_seen_at timestamptz not null default now(),
  primary key (user_id, device_name)
);

-- ------------------------------------------------------------------ RLS

-- The net. Table owners bypass RLS unless FORCE is set, and most frameworks
-- connect as the owning role, which silently disables every policy below.
-- The app connects as `hq_app`, created separately, which owns nothing.
alter table users            enable row level security;
alter table agents           enable row level security;
alter table documents        enable row level security;
alter table document_events  enable row level security;
alter table ingest_heartbeat enable row level security;

alter table users            force row level security;
alter table agents           force row level security;
alter table documents        force row level security;
alter table document_events  force row level security;
alter table ingest_heartbeat force row level security;

-- current_setting(..., true) returns null rather than raising when unset,
-- so "no tenant context" evaluates to no rows instead of an error.
create or replace function hq_current_user_id() returns uuid
  language sql stable as
$$ select nullif(current_setting('hq.user_id', true), '')::uuid $$;

drop policy if exists users_self on users;
create policy users_self on users
  using (id = hq_current_user_id());

drop policy if exists agents_own on agents;
create policy agents_own on agents
  using (user_id = hq_current_user_id())
  with check (user_id = hq_current_user_id());

drop policy if exists documents_own on documents;
create policy documents_own on documents
  using (user_id = hq_current_user_id())
  with check (user_id = hq_current_user_id());

drop policy if exists document_events_own on document_events;
create policy document_events_own on document_events
  using (user_id = hq_current_user_id())
  with check (user_id = hq_current_user_id());

drop policy if exists ingest_heartbeat_own on ingest_heartbeat;
create policy ingest_heartbeat_own on ingest_heartbeat
  using (user_id = hq_current_user_id())
  with check (user_id = hq_current_user_id());

-- ------------------------------------------------- identity bootstrap

-- Resolving who you are cannot happen inside your own tenant scope: the RLS
-- policy on `users` needs the id you are trying to look up. Chicken and egg.
--
-- SECURITY DEFINER runs this one function as its owner, which does have the
-- rights to touch `users`, so the app can exchange an external id for an
-- internal one without holding a privileged connection of its own. The
-- function is the ONLY privileged path in the system, it takes exactly two
-- arguments, and it can only ever return one user's row.
--
-- search_path is pinned because a SECURITY DEFINER function that resolves
-- names through a caller-controlled search_path is a privilege escalation.
create or replace function hq_resolve_user(p_external_id text, p_email text)
returns table (id uuid, email text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  insert into users (external_id, email)
       values (p_external_id, p_email)
  on conflict (external_id) do update set email = excluded.email
    returning users.id, users.email;
end $$;

revoke all on function hq_resolve_user(text, text) from public;
grant execute on function hq_resolve_user(text, text) to hq_app;

-- ------------------------------------------------------- device tokens

-- A laptop is not a person. It gets its own credential, scoped to one user,
-- revocable on its own, and never a stand-in for a browser session.
--
-- Only the hash is stored. A token that can be read back out of the database
-- is a second copy of the secret, and there is no reason for one to exist:
-- the value is shown once at mint time and never again.
create table if not exists device_tokens (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null,
  token_sha256 text not null unique,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index if not exists device_tokens_by_user on device_tokens (user_id);

alter table device_tokens enable row level security;
alter table device_tokens force row level security;
drop policy if exists device_tokens_own on device_tokens;
create policy device_tokens_own on device_tokens
  using (user_id = hq_current_user_id())
  with check (user_id = hq_current_user_id());

-- Exchanging a token for a user cannot run inside a tenant scope, for the
-- same reason resolving a Clerk id cannot: the lookup is what establishes
-- which tenant this is. Same shape as hq_resolve_user, same narrow surface.
create or replace function hq_user_for_token(p_hash text)
returns table (user_id uuid, token_id uuid)
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  return query
  update device_tokens set last_used_at = now()
   where token_sha256 = p_hash and revoked_at is null
   returning device_tokens.user_id, device_tokens.id;
end $$;
revoke all on function hq_user_for_token(text) from public;
grant execute on function hq_user_for_token(text) to hq_app;

-- NOT DONE, deliberately, and worth knowing why.
--
-- A stored body_text column would make search snippets cheap: ts_headline
-- currently re-strips markup on every query, which was 400 of the 500 ms a
-- search took. Adding it failed:
--
--   ERROR: could not extend file because project size limit (512 MB) has
--          been exceeded
--
-- 132 MB of html is a 219 MB table with its indexes, on a 512 MB plan. There
-- is no room for a second copy of the text. The snippet is bounded to the
-- first 20 kB of each document instead, and the real decision -- keep the
-- HTML in Postgres on a bigger plan, or move it to object storage and keep
-- only text and metadata here -- is deferred until it has to be made.

-- Documents live in the bucket now. storage_key points at them, body_text is
-- the stripped text search reads. html remains as a nullable column holding
-- nothing, so the migration is reversible in shape; dropping it is a one-line
-- change once this has run for a while.
alter table documents add column if not exists storage_key text;
alter table documents add column if not exists body_text  text;
alter table documents alter column html drop not null;
