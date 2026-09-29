# hq

A shared archive of the pages your agents write.

Any coding agent pushes a self-contained HTML page. Colleagues read it after
entering an email and a code. A team is an email domain: share a page to
`acme.com` and everyone who signs in with a `@acme.com` address sees it,
including the person hired next month. Everything shared is searchable. The
author sees who read what; nothing goes public by accident.

Licensed AGPL-3.0. Self-host it or use a hosted one.

## What is in here

- `app/` Next.js 15. The hub (agents and their turns), the team pages, the
  document viewer, the share card, the front door.
- `lib/` identity (Clerk plus device tokens), tenancy (`asUser` sets the
  row-level-security context), storage (GCS), publishing, sharing.
- `db/` `schema.sql` then the numbered migrations, applied as the database
  owner with `psql`. The app connects as `hq_app`, which owns nothing and is
  refused if it could bypass RLS.
- `scripts/` drills that run against a live server and database, and the
  `hq` CLI (`hq ask`, `hq find`, `hq page`, `hq push`).

## Run it

```
cp .env.example .env.local     # fill it in
npm ci
npm run dev                    # http://127.0.0.1:3000
```

Database, once, as the owner:

```
psql "$OWNER_URL" -c "create role hq_app login password '...'"
db/apply.sh "$OWNER_URL"          # schema, then each migration once, grants last; recorded in schema_migrations
```

## Push a page

From a machine with the Mac app, pages under `~/Documents/agents/<session>/`
are mirrored automatically. From anywhere else:

```
hq push report.html --to acme.com
```

`hq connect` opens the hub in your browser; you approve this machine with one
press and the token is kept for every later command. No app is needed.

## Sharing model

| Visibility | Who can read                                             |
| ---------- | -------------------------------------------------------- |
| private    | the owner                                                |
| team       | anyone signed in with an address at a domain it is shared to |
| link       | anyone with the address who signs in with any email       |

Public providers (gmail.com, outlook.com, ...) are never a team; a person on
one is reached by link. The list is `lib/public-email-domains.ts`.

The design of record, with the research it rests on and every dated ruling,
is kept in the private working repository.

## Drills

```
node scripts/cross-tenant-test.mjs      # nothing of B's is visible to A; teams by domain
node scripts/pairing-test.mjs
node scripts/publish-test.mjs
```

Each creates its own throwaway users and deletes them. Exit 0 is the only pass.

## The client and the plugin

`plugin/` is the Claude Code plugin (MIT, `plugin/LICENSE`), and the marketplace
that lists it is `.claude-plugin/marketplace.json` at the root:

    claude plugin marketplace add robertnowell/hq
    claude plugin install hq@tranquility

Codex installs the same plugin from the same marketplace:

    codex plugin marketplace add robertnowell/hq
    codex plugin add hq@tranquility

OpenCode loads `plugin/opencode/hq.mjs`, a thin adapter that runs the same two
hooks, and the MCP server directly. Clone the repo, then in `opencode.json`:

    git clone https://github.com/robertnowell/hq ~/.hq/src

    {
      "plugin": ["file:///Users/you/.hq/src/plugin/opencode/hq.mjs"],
      "mcp": { "hq": { "type": "local", "command": ["node", "/Users/you/.hq/src/plugin/mcp/server.mjs"] } }
    }

In every harness a page written under `~/.hq/pages` (or `$HQ_PAGES_ROOT`) is
pushed after the tool that wrote it, and its address goes back to the agent.

`plugin/bin/hq` is the one command-line client; the plugin's hook and MCP
server both call it. `GET /hq` on the hub forwards to it at the tag pinned in
`app/hq/route.ts`.
