# Dispatch: the shape, written down before it is built

Ruled 7 Sep 2026: "Dispatch is a row, not a call." This page says what the row
is, who claims it, how it reaches the agent, and what happens when it does
not. Nothing here is built yet (hq-app-kqi). It exists because the record
said the shape was decided without saying what was decided.

## The one sentence

A reply typed in the app is a row in `queued_turns`. A worker on the machine
that owns the session claims the row with `FOR UPDATE SKIP LOCKED`, delivers
the text into the session, and marks the row delivered. A row nobody claims
turns amber on the agent it was meant for, and never disappears on its own.

## The table

```sql
create table queued_turns (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  agent_id      uuid not null references agents(id) on delete cascade,
  in_reply_to   uuid references turns(id),      -- the turn being answered, if any
  body          text not null,
  status        text not null default 'queued'
                check (status in ('queued','claimed','delivered','failed','expired')),
  claimed_by    text,                            -- device name, from the token
  claimed_at    timestamptz,
  delivered_at  timestamptz,
  attempts      int not null default 0,
  error         text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '24 hours'
);
create index queued_turns_open on queued_turns (user_id, status, created_at)
  where status in ('queued','claimed');
-- RLS exactly as every other table: enable, force, policy on user_id.
```

Status is an explicit enum because a row must be able to say what happened
to it. It is the one place in the schema where stored state is allowed,
and only because the row *is* the event: it has no history to derive from.

## Who claims

`scripts/dispatch-worker.mjs`, on the Mac, authenticated with the same device
token the mirror uses. It runs as a **launchd agent**, not a hook: a reply to
an idle agent has no hook to ride, and this worker never reads `~/Documents`,
so the TCC refusal that forced the mirror onto hooks does not apply. It needs
tmux and the panel's queue, both outside the protected folders.

Poll: `POST /api/dispatch/claim { device }` every 15 seconds. The server runs

```sql
update queued_turns q set status='claimed', claimed_by=$2, claimed_at=now(),
       attempts=attempts+1
 where q.id = (select id from queued_turns
                where user_id=$1 and status='queued' and expires_at > now()
                order by created_at limit 1 for update skip locked)
returning q.*, (select source_session_id from agents a where a.id=q.agent_id);
```

One row per call. Two workers cannot claim the same row; a worker that dies
mid-claim leaves a `claimed` row older than the claim timeout (2 minutes),
which the watchdog returns to `queued` with `attempts` intact. Three attempts
and the row is `failed`, with the last error stored.

## How it reaches the agent

The worker hands `(source_session_id, body)` to Tranquility Base's existing
reply path, `TmuxTransport`, which already delivers byte-exact text into a
session's pane via `tmux load-buffer` and routes by session state
(`ReplyDestination`). The worker does not reimplement delivery; it calls
`tbase reply --session <id> --text-file <path>` (a CLI entry to add, thin
wrapper over what the panel does on a voice reply). If the session is gone
and cannot be revived, the row fails with `error='session gone'`.

Delivered means the transport returned success. Whether the agent then
*acted* is what the next turn's brief will say, through the mirror.

## The failure surface

- **Unclaimed after 10 minutes**: the agent's row in the sidebar and the
  document the reply was typed on show an amber "reply waiting" mark. The
  mark comes from a query over `queued_turns`, never from a column on the
  agent. Nothing clears it except delivery or the human withdrawing the
  reply.
- **Failed**: same mark, red, with the stored error, and a retry button that
  sets the row back to `queued` with attempts reset.
- **Expired**: 24 hours unclaimed. Shown once, then folded into the agent's
  history as "reply expired". Never silently dropped.
- **Mac asleep**: rows simply wait; the worker catches up on wake. The
  10-minute amber is the honest signal that the Mac is not there.
- **The worker itself**: it posts to `/api/heartbeat` with `device` set to
  `<name>-dispatch`, so the sidebar's mirror line shows it beside the drain.

## What the app shows

On a turn block: a reply box. On send, the row is written and the box shows
"queued" with the time, then "delivered" when the worker reports back
(the arrivals poller already refreshes the page). The turn that answers it
arrives through the mirror as any other turn and nests under the reply.

## Not decided here, on purpose

- Cloud runners claiming rows (a cloud container instead of a Mac).
  The claim protocol is device-agnostic by construction; nothing above needs
  to change for it, which is the point of a row rather than a call.
- Whether a reply may target a *document* rather than an agent. Today the
  document knows its agent, so the agent is always the address.
