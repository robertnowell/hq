# Shipping observations

`/shipping` shows running source, main, GitHub's designated latest release, release attempts,
open PR blockers and the 20 most recently updated merged PRs. An agent's page
shows its PRs when this Mac has a matching session-to-PR receipt. A receipt is
an attribution, not an instruction to merge. Unknown owners remain unknown.

GitHub's `latestRelease` is a designation, not the newest publication timestamp.
The UI names it explicitly and links all releases; a newer published build can
exist while an older one still carries the Latest badge.

The Mac observer reads GitHub and installed app processes once per minute.
The browser reads saved observations every 30 seconds. After three minutes,
or any failed refresh, the UI labels the data stale. GitHub failure preserves
the last successful observation's timestamp. Sleeping or disconnecting the Mac
therefore becomes a visible stale state, not a permanently green dashboard.

Run with Node 22 after deploying the API:

```
node scripts/shipping-status.mjs --print
node scripts/install-shipping-observer.mjs
```

The launch agent uses the existing GitHub CLI account and paired hub credential,
copied into no configuration or log. The installed observer lives in
`~/Library/Application Support/hq/shipping/`, so removing a worktree does not
break it. It sends only to `https://hq.tranquilitybase.dev`, refuses redirects,
and performs no branch, merge or app mutation. Stop it with:

```
node scripts/install-shipping-observer.mjs --stop
```

Observations are private objects in the existing document bucket. Storage keys
come from authenticated user/device identities, not uploaded IDs; reads include
only active devices belonging to that user. Revocation hides its observations.
Generation preconditions reject concurrent overwrites; timestamps reject older
observations. There are no public/signed URLs and no database schema change.

A running claim requires a single process at an installed product path, a full
source stamp and bundle/executable timestamps preceding that process. The
observer rechecks the process after GitHub responds. A recently merged PR is
labelled included only when its merge commit is in the running source's most
recent 100 ancestors. A squash-equivalent preview or an older ancestor outside
that window stays unverified. This is intentional: matching a build number or
a PR's green checks is not proof of what is running. Launch-drill health is a
separate delivery concern and is not inferred by this view.

The first slice is project/PR visibility. It does not yet sync the complete
Beads task graph, create a merge queue, retry delivery, or expose every blocker
inside GitHub's generic BLOCKED state. GitHub remains the detail link for those.
It displays the separately installed delivery worker's last phase/heartbeat when
available; a missing or old heartbeat does not imply an active retry. The status
observer itself remains read-only and never performs that worker's app mutations.

Validation:

```
node --experimental-strip-types --test scripts/shipping-status-test.mjs
npm run build
npm run start -- -p 3147
node --env-file=.env.local scripts/shipping-isolation-test.mjs
```

The integration drill creates and removes its own two users and private objects.
It checks positive reads/writes, tenant/device forgery, older writes, revoked
devices, unauthenticated requests, payload bounds and private response caching.


## Merge admission visibility (#554)

The observer reads fresh PR head/labels and audit completion times. A native
GitHub auto-merge request is explicitly outside the supervised queue; the
`merge-queue` label is separate evidence. Holds, conflicts, dual coordinators,
behind-main status and removed admission have distinct copy. A passing native
request behind main for five minutes is flagged as stalled outside the queue.
That flag observes existing intent; it never admits a PR or edits a branch.

The optional per-PR `queue` payload includes bounded owner, merge mode, state,
observation time and passing-since time. Local handoff state is used only when
its head/mode match fresh GitHub data and it is at most three minutes old;
failed observations cannot override fresh remote facts. Missing labels or a
truncated label list cannot establish admission. Older clients remain accepted
without claiming supervised admission. The worker's `awaiting_merge` and
`attention` phases remain distinct from idle. The snapshot's existing global
stale/unavailable behavior still applies.
