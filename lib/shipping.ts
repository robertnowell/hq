export type ShippingPR = {
  number: number; title: string; state: string; mergeStateStatus: string;
  isDraft: boolean; autoMerge: boolean; sessions: string[];
  running: boolean;
  /** Where this merge has reached, by ancestry against what is installed and tagged. */
  inDev: boolean; inRelease: boolean; inProd: boolean;
  updatedAt: string | null;
  branch: string | null;
  /** Issue ids this pull request carries in its branch or title, or that cite it. */
  issues: string[];
  queue?: { mode: string; state: string; owner: string | null; observedAt: string; readySince: string | null; attention: boolean } | null;
  checks: { name: string; status: string; conclusion: string }[];
};
export type ShippingIssue = {
  id: string; title: string; status: string; priority: number | null; type: string;
  blocks: string[]; prs: number[]; updatedAt: string | null; closedAt: string | null;
};
export type ShippingSnapshot = {
  repo: string; checkedAt: string; deviceName: string; sourceError: string | null;
  mainSha: string | null;
  /** Both installed bundles, from disk, running or not. */
  installed: { dev?: { sha: string; build: string; running: boolean }; prod?: { sha: string; build: string; running: boolean } };
  /** The beads tracker beside the checkout; empty when there is none. */
  issues: ShippingIssue[];
  runtime: { sha: string; build: string; channel: string; relation: string; behind: number | null } | null;
  /** The cloud agent as this Mac last saw it answer a session: the commit its
      `ready` line carried, and how many changes to the bot main has beyond it (hf-27). */
  cloud: { name: string; build: string; sha: string | null; behind: number | null; servedAt: string } | null;
  release: { sha: string | null; tag: string; publishedAt: string } | null;
  prs: ShippingPR[];
  runs: { id: number; name: string; status: string; conclusion: string; sha: string }[];
  preview: { owner: string; expiresAt: string } | null;
  delivery: { phase: string; checkedAt: string; targetSha: string | null; reason: string | null } | null;
  captureActive: boolean;
};

const sha = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const text = (v: unknown, n = 200) => typeof v === "string" ? v.slice(0, n) : "";
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const array = (v: unknown, n: number) => Array.isArray(v) ? v.slice(0, n) : [];
const validDate = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));

/** Project data comes from a paired Mac; identity and storage keys never do. */
export function parseShipping(value: unknown): ShippingSnapshot {
  const s = obj(value);
  if (typeof s.repo !== "string" || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(s.repo) || s.repo.length > 200) throw new Error("invalid repository");
  if (!validDate(s.checkedAt) || Date.parse(s.checkedAt as string) > Date.now() + 300_000) throw new Error("invalid check time");
  const r = obj(s.runtime), release = obj(s.release), preview = obj(s.preview), delivery = obj(s.delivery);
  return {
    repo: s.repo, checkedAt: new Date(s.checkedAt as string).toISOString(),
    captureActive: s.captureActive === true,
    deviceName: text(s.deviceName, 80), sourceError: s.sourceError ? text(s.sourceError) : null,
    mainSha: sha(s.mainSha) ? s.mainSha : null,
    installed: (() => {
      const i = obj(s.installed), out: ShippingSnapshot["installed"] = {};
      for (const k of ["dev", "prod"] as const) { const b = obj(i[k]); if (sha(b.sha)) out[k] = { sha: b.sha, build: text(b.build, 40), running: b.running === true }; }
      return out;
    })(),
    issues: array(s.issues, 300).flatMap(v => {
      const i = obj(v); const id = text(i.id, 60);
      if (!/^[a-zA-Z0-9_.-]{1,60}$/.test(id)) return [];
      return [{ id, title: text(i.title), status: ["open", "in_progress", "blocked", "deferred", "closed", "pinned", "hooked"].includes(String(i.status)) ? String(i.status) : "open",
        priority: Number.isInteger(i.priority) ? Number(i.priority) : null, type: text(i.type, 30),
        blocks: array(i.blocks, 10).filter((x): x is string => typeof x === "string").map(x => x.slice(0, 60)),
        prs: array(i.prs, 10).filter((x): x is number => Number.isInteger(x) && Number(x) > 0),
        updatedAt: validDate(i.updatedAt) ? new Date(i.updatedAt as string).toISOString() : null,
        closedAt: validDate(i.closedAt) ? new Date(i.closedAt as string).toISOString() : null }];
    }),
    runtime: sha(r.sha) ? { sha: r.sha, build: text(r.build, 40), channel: text(r.channel, 30),
      relation: ["current", "behind", "preview", "unknown"].includes(String(r.relation)) ? String(r.relation) : "unknown",
      behind: Number.isInteger(r.behind) && Number(r.behind) >= 0 ? Number(r.behind) : null } : null,
    cloud: (() => {
      const c = obj(s.cloud);
      if (typeof c.build !== "string" || !/^[0-9a-f]{7,40}$/.test(c.build) || !validDate(c.servedAt)) return null;
      return { name: text(c.name, 60) || "Cloud agent", build: c.build.slice(0, 8), sha: sha(c.sha) ? c.sha : null,
        behind: Number.isInteger(c.behind) && Number(c.behind) >= 0 ? Number(c.behind) : null,
        servedAt: new Date(c.servedAt as string).toISOString() };
    })(),
    release: release.tag && validDate(release.publishedAt) ? { tag: text(release.tag, 150),
      sha: sha(release.sha) ? release.sha : null, publishedAt: new Date(release.publishedAt as string).toISOString() } : null,
    prs: array(s.prs, 100).map(value => {
      const p = obj(value), q = obj(p.queue);
      if (!Number.isInteger(p.number) || Number(p.number) < 1) throw new Error("invalid PR number");
      return { number: Number(p.number), title: text(p.title), state: text(p.state, 20),
        mergeStateStatus: text(p.mergeStateStatus, 30), isDraft: p.isDraft === true, autoMerge: p.autoMerge === true,
        running: p.state === "MERGED" && p.running === true,
        inDev: p.state === "MERGED" && p.inDev === true, inRelease: p.state === "MERGED" && p.inRelease === true, inProd: p.state === "MERGED" && p.inProd === true,
        updatedAt: validDate(p.updatedAt) ? new Date(p.updatedAt as string).toISOString() : null,
        branch: p.branch ? text(p.branch, 200) : null,
        issues: array(p.issues, 10).filter((x): x is string => typeof x === "string" && /^[a-zA-Z0-9_.-]{1,60}$/.test(x)),
        queue: validDate(q.observedAt) && Date.parse(q.observedAt as string) <= Date.now() + 300_000 ? {
          mode: ["none", "github_auto_merge", "kodiak", "competing"].includes(String(q.mode)) ? String(q.mode) : "unknown",
          state: ["queued", "native_auto_merge", "held", "conflict", "competing", "handoff_blocked", "awaiting_readmission", "admission_removed", "not_admitted"].includes(String(q.state)) ? String(q.state) : "unknown",
          owner: q.owner ? text(q.owner, 100) : null, observedAt: new Date(q.observedAt as string).toISOString(),
          readySince: validDate(q.readySince) && Date.parse(q.readySince as string) <= Date.parse(q.observedAt as string) ? new Date(q.readySince as string).toISOString() : null,
          attention: q.attention === true } : null,
        sessions: array(p.sessions, 20).filter((x): x is string => typeof x === "string" && /^[a-zA-Z0-9_-]{8,100}$/.test(x)),
        checks: array(p.checks, 100).map(v => { const c = obj(v); return { name: text(c.name, 100), status: text(c.status, 30), conclusion: text(c.conclusion, 30) }; }) };
    }),
    runs: array(s.runs, 10).map(v => {
      const r = obj(v);
      if (!Number.isSafeInteger(r.id) || Number(r.id) < 1) throw new Error("invalid workflow run");
      return { id: Number(r.id), name: text(r.name, 100), status: text(r.status, 30), conclusion: text(r.conclusion, 30), sha: sha(r.sha) ? r.sha : "" };
    }),
    preview: preview.owner && validDate(preview.expiresAt) ? { owner: text(preview.owner, 100), expiresAt: new Date(preview.expiresAt as string).toISOString() } : null,
    delivery: validDate(delivery.checkedAt) && Date.parse(delivery.checkedAt as string) <= Date.now() + 300_000 ? { phase: ["idle", "checking", "activating", "running", "failed", "deferred", "unavailable", "awaiting_merge", "attention"].includes(String(delivery.phase)) ? String(delivery.phase) : "unavailable",
      checkedAt: new Date(delivery.checkedAt as string).toISOString(), targetSha: sha(delivery.targetSha) ? delivery.targetSha : null,
      reason: delivery.reason ? text(delivery.reason) : null } : null,
  };
}

export function prBlocker(p: ShippingPR, now = Date.now()): string {
  if (p.state === "MERGED") return p.running ? "Included in running app" : "Merged; running inclusion not verified";
  if (p.state === "CLOSED") return "Closed without merging";
  if (p.isDraft) return "Draft";
  const q = p.queue;
  if (q && now - Date.parse(q.observedAt) > 180_000) return "Merge observation out of date";
  if (q?.state === "held") return "Explicit queue hold";
  if (q?.state === "competing") return "Two merge coordinators armed; owner handoff needed";
  if (q?.state === "handoff_blocked") return "Admission handoff needs owner review";
  if (["awaiting_readmission", "admission_removed"].includes(q?.state ?? "")) return "Admission removed; owner review needed";
  if (p.mergeStateStatus === "DIRTY") return "Merge conflict";
  if (p.checks.some(c => ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(c.conclusion))) return "Check failed or canceled";
  if (p.checks.some(c => c.status !== "COMPLETED")) return "Checks running";
  if (p.mergeStateStatus === "BEHIND") {
    if (q?.mode === "kodiak") return "Behind main; supervised queue owns update";
    if (q?.mode === "github_auto_merge") return q.attention ? "Stalled outside queue; admission needed" : "Behind main; native auto-merge waiting outside queue";
    return "Behind main; no supervised admission observed";
  }
  if (q?.mode === "kodiak") return "Supervised queue admission observed";
  if (q?.mode === "github_auto_merge") return "Native auto-merge enabled; outside supervised queue";
  if (p.mergeStateStatus === "CLEAN" && p.checks.length) return p.autoMerge ? "Ready; auto-merge requested" : "Checks passed; merge not requested";
  return p.mergeStateStatus === "BLOCKED" ? "Blocked by merge rules" : "Status not yet determined";
}
