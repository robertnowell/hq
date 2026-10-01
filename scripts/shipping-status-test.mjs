import test from "node:test";
import assert from "node:assert/strict";
import { parseShipping, prBlocker } from "../lib/shipping.ts";
import { receiptMap, checkContexts, mergeQueue } from "./shipping-status.mjs";
const snapshot = { repo: "owner/repo", checkedAt: new Date().toISOString(), prs: [], runs: [] };
const pr = { number: 1, title: "Change", state: "OPEN", mergeStateStatus: "CLEAN", isDraft: false, autoMerge: true,
  running: false, sessions: [], checks: [{ name: "Audit", status: "COMPLETED", conclusion: "SUCCESS" }] };

test("unknown, missing and invalid identities cannot become current or running", () => {
  const s = parseShipping({ ...snapshot, runtime: { sha: "abc", relation: "current" }, mainSha: "main", userId: "someone-else" });
  assert.equal(s.runtime, null); assert.equal(s.mainSha, null); assert.equal(s.userId, undefined);
  assert.throws(() => parseShipping({ ...snapshot, repo: "../../other-user" }));
  assert.throws(() => parseShipping({ ...snapshot, checkedAt: new Date(Date.now() + 600_000).toISOString() }));
  assert.throws(() => parseShipping({ ...snapshot, prs: [{ number: -1 }] }));
});
test("merge admission, merge completion and running inclusion are different states", () => {
  assert.equal(prBlocker(pr), "Ready; auto-merge requested");
  assert.equal(prBlocker({ ...pr, mergeStateStatus: "BEHIND" }), "Behind main; no supervised admission observed");
  assert.equal(prBlocker({ ...pr, state: "MERGED" }), "Merged; running inclusion not verified");
  assert.equal(prBlocker({ ...pr, state: "MERGED", running: true }), "Included in running app");
  assert.equal(parseShipping({ ...snapshot, prs: [{ ...pr, running: true }] }).prs[0].running, false);
});
test("failures and conflicts are not hidden behind green-looking merge state", () => {
  assert.equal(prBlocker({ ...pr, checks: [{ status: "COMPLETED", conclusion: "TIMED_OUT" }] }), "Check failed or canceled");
  assert.equal(prBlocker({ ...pr, mergeStateStatus: "DIRTY" }), "Merge conflict");
  assert.equal(prBlocker({ ...pr, checks: [] }), "Status not yet determined");
  assert.equal(prBlocker({ ...pr, checks: [{ status: "QUEUED", conclusion: "" }] }), "Checks running");
});
test("ownership is only linked through valid matching repository receipts", () => {
  const map = receiptMap([
    ["session-12345678", "123\thttps://github.com/owner/repo/pull/1\n124\thttps://github.com/owner/repo/pull/1"],
    ["session-87654321", "123\thttps://github.com/other/repo/pull/1\n124\thttps://github.com/owner/repo/pull/2"],
    ["../unsafe", "123\thttps://github.com/owner/repo/pull/1"],
  ], "owner/repo");
  assert.deepEqual([...map.get(1)], ["session-12345678"]);
  assert.deepEqual([...map.get(2)], ["session-87654321"]);
});
test("legacy status contexts preserve pending and error conclusions", () => {
  assert.deepEqual(checkContexts([{ context: "old", state: "PENDING" }])[0], { name: "old", status: "IN_PROGRESS", conclusion: "PENDING" });
  assert.equal(checkContexts([{ context: "old", state: "ERROR" }])[0].conclusion, "FAILURE");
});
test("missing or invalid worker reports never imply delivery is active", () => {
  assert.equal(parseShipping(snapshot).delivery, null);
  assert.equal(parseShipping({ ...snapshot, delivery: { phase: "running" } }).delivery, null);
  assert.equal(parseShipping({ ...snapshot, delivery: { phase: "running", checkedAt: new Date(Date.now() + 600_000).toISOString() } }).delivery, null);
  const d = parseShipping({ ...snapshot, delivery: { phase: "invented", checkedAt: snapshot.checkedAt, targetSha: "main" } }).delivery;
  assert.equal(d.phase, "unavailable"); assert.equal(d.targetSha, null);
});

const now = Date.parse("2026-09-21T17:30:00Z");
const graphPR = { ...pr, headRefOid: "a".repeat(40), labels: { nodes: [], pageInfo: { hasNextPage: false } },
  mergeStateStatus: "BEHIND", autoMergeRequest: { enabledAt: "2026-09-21T16:06:20Z" },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
    { name: "Source audit", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2026-09-21T16:12:09Z" }
  ] } } } }] } };
test("the incident is native auto-merge stalled outside the queue", () => {
  const queue = mergeQueue(graphPR, null, now);
  assert.equal(queue.mode, "github_auto_merge"); assert.equal(queue.state, "native_auto_merge");
  assert.equal(queue.attention, true); assert.equal(queue.readySince, "2026-09-21T16:12:09.000Z");
  assert.equal(prBlocker({ ...graphPR, queue }, now), "Stalled outside queue; admission needed");
});
test("actual labels, holds and competing merge mechanisms are distinct", () => {
  const p = { ...graphPR, labels: { nodes: [{ name: "merge-queue" }] } };
  assert.equal(mergeQueue(p, null, now).mode, "competing");
  const queued = mergeQueue({ ...p, autoMergeRequest: null }, null, now);
  assert.equal(queued.state, "queued");
  assert.equal(prBlocker({ ...pr, mergeStateStatus: "BEHIND", queue: queued }, now), "Behind main; supervised queue owns update");
  assert.equal(mergeQueue({ ...p, labels: { nodes: [{ name: "queue-hold" }] } }, null, now).state, "held");
  assert.equal(mergeQueue({ ...p, labels: { nodes: [], pageInfo: { hasNextPage: true } } }, null, now).mode, "unknown");
});
test("missing, pending and future-dated audit evidence cannot start stall age", () => {
  for (const c of [[], [{ name: "Source audit", status: "IN_PROGRESS" }],
    [{ name: "Source audit", status: "COMPLETED", conclusion: "SUCCESS", completedAt: "2027-01-01T00:00:00Z" }]]) {
    const q = mergeQueue({ ...graphPR, commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: c } } } }] } }, null, now);
    assert.equal(q.attention, false); assert.equal(q.readySince, null);
  }
});
test("local handoff state must match the fresh remote head and mode", () => {
  const record = { head_sha: graphPR.headRefOid, merge_mode: "github_auto_merge", queue_observed_at: now / 1000,
    queue_state: "handoff_blocked", queue_owner: "session-12345678" };
  assert.equal(mergeQueue(graphPR, record, now).state, "handoff_blocked");
  assert.equal(mergeQueue(graphPR, { ...record, head_sha: "b".repeat(40) }, now).state, "native_auto_merge");
  assert.equal(mergeQueue(graphPR, { ...record, queue_observed_at: 1 }, now).state, "native_auto_merge");
  assert.equal(mergeQueue(graphPR, { ...record, queue_observation_error: "offline" }, now).state, "native_auto_merge");
});
test("queue payload is bounded and old observations cannot imply progress", () => {
  const checkedAt = new Date().toISOString();
  const queue = { mode: "kodiak", state: "queued", owner: "x".repeat(200), observedAt: checkedAt, readySince: "2099-01-01T00:00:00Z" };
  const parsed = parseShipping({ ...snapshot, prs: [{ ...pr, queue }] }).prs[0];
  assert.equal(parsed.queue.owner.length, 100); assert.equal(parsed.queue.readySince, null);
  assert.equal(prBlocker(parsed, Date.parse(checkedAt) + 181000), "Merge observation out of date");
  assert.equal(parseShipping({ ...snapshot, delivery: { phase: "awaiting_merge", checkedAt } }).delivery.phase, "awaiting_merge");
});

test("the cloud agent's build is the one its last session said, and nothing else passes for one (hf-27)", () => {
  const full = "f467aaf773f7703f2590e6815236a994a2b21b74";
  const s = parseShipping({ ...snapshot, cloud: { name: "Hands-free manager", build: "f467aaf", sha: full, behind: 1, servedAt: "2026-09-29T23:28:14.540Z" } });
  assert.deepEqual(s.cloud, { name: "Hands-free manager", build: "f467aaf", sha: full, behind: 1, servedAt: "2026-09-29T23:28:14.540Z" });
  assert.equal(parseShipping({ ...snapshot, cloud: { build: "not-a-sha", servedAt: "2026-09-29T23:28:14Z" } }).cloud, null);
  assert.equal(parseShipping({ ...snapshot, cloud: { build: "f467aaf" } }).cloud, null, "no session time, no claim");
  assert.equal(parseShipping({ ...snapshot }).cloud, null);
});
