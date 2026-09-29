import type { ShippingIssue, ShippingPR, ShippingSnapshot } from "./shipping";

/**
 * The work strip's model: seven fixed stages and one flag.
 *
 * Ruled 28 Sep 2026 after the pipeline research (agent a8e3f054,
 * 2026-09-28-work-pipeline-view). Every mature tracker keeps a small fixed set
 * of categories under its named states; Linear draws "blocked" as a flag, not
 * a status; GOV.UK colours only the rows that need action. So: a row's stage is
 * one of seven, in order, and whether it needs the reader is a separate flag
 * with two tiers. Dev and Prod are read from the installed bundles by ancestry,
 * live or not; Released is the tag marked Latest.
 */
export const STAGES = ["Planned", "Working", "Proposed", "Merged", "Dev", "Released", "Prod"] as const;
export type Stage = typeof STAGES[number] | "Dropped" | "Done";
export type Flag = { tier: "blocked" | "attention" | "moving"; text: string } | null;
export type StripRow = {
  key: string; kind: "pr" | "issue";
  /** What the work is, in its own words: the pull request's or issue's title. */
  label: string;
  /** The number or id, which means nothing to a reader on its own (29 Sep), so it goes last and small. */
  ref: string;
  url: string | null;
  stage: Stage; flag: Flag; note: string; sessions: string[]; number?: number;
};

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const daysSince = (iso: string | null, now: number) => iso ? Math.floor((now - Date.parse(iso)) / 86_400_000) : null;
const still = (iso: string | null, now: number) => { const d = daysSince(iso, now); return d !== null && d >= 2 ? ` · ${d} d` : ""; };

export function prStage(p: ShippingPR, s: ShippingSnapshot, now = Date.now()): { stage: Stage; flag: Flag; note: string } {
  if (p.state === "MERGED") {
    if (p.inProd) return { stage: "Prod", flag: null, note: `in Prod${s.installed.prod ? ", build " + s.installed.prod.build : ""}` };
    if (p.inRelease) return { stage: "Released", flag: null, note: `tagged ${s.release?.tag.split("-")[0] ?? ""}${s.installed.prod ? ", Prod is at " + s.installed.prod.build : ""}` };
    if (p.inDev || p.running) return { stage: "Dev", flag: null, note: `in Dev${s.installed.dev ? ", build " + s.installed.dev.build : ""}` };
    const deploys = !!(s.installed.dev || s.installed.prod || s.release);
    return { stage: "Merged", flag: null, note: deploys ? "merged, not built yet" : "merged" };
  }
  if (p.state === "CLOSED") return { stage: "Dropped", flag: null, note: "closed without merging" };
  const age = still(p.updatedAt, now);
  const q = p.queue;
  if (q && ["competing", "handoff_blocked", "awaiting_readmission", "admission_removed"].includes(q.state)) return { stage: "Proposed", flag: { tier: "blocked", text: q.state === "competing" ? "two merge coordinators" + age : "admission needs you" + age }, note: "" };
  if (q?.state === "held") return { stage: "Proposed", flag: { tier: "attention", text: "held" + age }, note: "" };
  if (p.mergeStateStatus === "DIRTY") return { stage: "Proposed", flag: { tier: "blocked", text: "merge conflict" + age }, note: "" };
  if (p.checks.some(c => FAILED.has(c.conclusion))) return { stage: "Proposed", flag: { tier: "blocked", text: "checks failed" + age }, note: "" };
  if (p.checks.some(c => c.status !== "COMPLETED")) return { stage: "Proposed", flag: { tier: "moving", text: "checks running" }, note: "" };
  if (p.isDraft) return { stage: "Proposed", flag: null, note: "draft" + age };
  if (p.mergeStateStatus === "BEHIND") {
    if (q?.mode === "kodiak") return { stage: "Proposed", flag: { tier: "moving", text: "queue updating it" }, note: "" };
    if (q?.mode === "github_auto_merge" && !q.attention) return { stage: "Proposed", flag: { tier: "moving", text: "auto-merge waiting" }, note: "" };
    return { stage: "Proposed", flag: { tier: "attention", text: "behind main, unadmitted" + age }, note: "" };
  }
  if (p.mergeStateStatus === "CLEAN" && (p.autoMerge || q?.mode === "kodiak")) return { stage: "Proposed", flag: { tier: "moving", text: "queued to merge" }, note: "" };
  if (p.mergeStateStatus === "CLEAN") return { stage: "Proposed", flag: { tier: "attention", text: "checks pass, waiting to be mergedsted" + age }, note: "" };
  if (p.mergeStateStatus === "BLOCKED") return { stage: "Proposed", flag: { tier: "attention", text: "blocked by merge rules" + age }, note: "" };
  return { stage: "Proposed", flag: null, note: "open" + age };
}

export function issueStage(i: ShippingIssue, s: ShippingSnapshot, byNumber: Map<number, ShippingPR>, now = Date.now()): { stage: Stage; flag: Flag; note: string } {
  const cited = i.prs.map(n => byNumber.get(n)).filter((p): p is ShippingPR => !!p);
  if (cited.length) {
    // The issue is wherever its newest cited pull request is.
    const p = cited.sort((a, b) => b.number - a.number)[0];
    const r = prStage(p, s, now);
    // Merged but the issue is still open. Not closed for you: an issue can
    // span several pull requests (hf-6 had two on 28 Sep), so a merge is
    // evidence, not proof. Flagged so the owner decides.
    if (p.state === "MERGED" && i.status !== "closed" && !r.flag)
      return { ...r, flag: { tier: "attention", text: `merged; close ${i.id}?` }, note: "" };
    return { ...r, note: `PR #${p.number}${r.note ? ": " + r.note : ""}` };
  }
  if (i.status === "closed") return { stage: "Done", flag: null, note: "closed, no pull request cited" };
  const open = new Set(s.issues.filter(x => x.status !== "closed").map(x => x.id));
  const waits = i.blocks.filter(b => open.has(b));
  if (i.status === "blocked" || waits.length) return { stage: i.status === "in_progress" ? "Working" : "Planned", flag: { tier: "attention", text: waits.length ? `after ${waits[0]}` : "blocked" }, note: "" };
  if (i.status === "in_progress" || i.status === "hooked") return { stage: "Working", flag: null, note: "started" + still(i.updatedAt, now) };
  if (i.status === "deferred" || i.status === "pinned") return { stage: "Planned", flag: null, note: i.status };
  return { stage: "Planned", flag: null, note: "no branch yet" };
}

export function stripRows(s: ShippingSnapshot, now = Date.now()): StripRow[] {
  const byNumber = new Map(s.prs.map(p => [p.number, p]));
  const prs: StripRow[] = s.prs.map(p => {
    const r = prStage(p, s, now);
    const note = p.issues.length && r.note ? `${r.note} · ${p.issues.join(", ")}` : r.note;
    return { key: `pr-${p.number}`, kind: "pr" as const, number: p.number, label: p.title, ref: `#${p.number}`,
      url: `https://github.com/${s.repo}/pull/${p.number}`, sessions: p.sessions, ...r, note };
  });
  const issues: StripRow[] = s.issues.map(i => {
    const r = issueStage(i, s, byNumber, now);
    const sessions = [...new Set(i.prs.flatMap(n => byNumber.get(n)?.sessions ?? []))];
    return { key: `issue-${i.id}`, kind: "issue" as const, label: i.title, ref: i.id, url: null, sessions, ...r };
  }).filter(r => r.stage !== "Done");
  return [...prs, ...issues];
}

const TIER_ORDER = { blocked: 0, attention: 1, moving: 2 } as const;
export function rowOrder(a: StripRow, b: StripRow): number {
  const ta = a.flag ? TIER_ORDER[a.flag.tier] : 3, tb = b.flag ? TIER_ORDER[b.flag.tier] : 3;
  if (ta !== tb) return ta - tb;
  const sa = STAGES.indexOf(a.stage as typeof STAGES[number]), sb = STAGES.indexOf(b.stage as typeof STAGES[number]);
  if (sa !== sb) return sb - sa;
  return (b.number ?? 0) - (a.number ?? 0);
}
