-- Project folders, mirrored from the Mac. Ruled 29 Sep 2026 in Tranquility
-- Base (docs/rulings/ruling-project-folders.md): agents are grouped on the
-- panel by dragging one onto another; the hub groups them the same way,
-- because a second client renders the first.
--
-- One row per person holding the panel's whole folder book, exactly as the
-- Mac keeps it in projects.json: folders in the user's order, each with its
-- name and collapsed flag, and members keyed by the conversation's origin
-- session id. The hub never edits it; the Mac sends it whenever it changes.

create table if not exists agent_folders (
  user_id    uuid primary key references users(id) on delete cascade,
  book       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table agent_folders enable row level security;
alter table agent_folders force  row level security;
drop policy if exists agent_folders_tenant on agent_folders;
create policy agent_folders_tenant on agent_folders
  using (user_id = hq_current_user_id())
  with check (user_id = hq_current_user_id());
grant select, insert, update, delete on agent_folders to hq_app;
