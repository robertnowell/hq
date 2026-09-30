/**
 * What counts as a problem in a Mac's agent-rules health report (30 Sep 2026).
 * One place, read by the ingest route and by the drill.
 */
/** The problems a report names, in words a person can act on. */
export function problemsOf(r: {
  hooks: Record<string, string>; skills: Record<string, string>; approvals: Record<string, string>;
  stale: string[]; undelivered: number; source: string;
}): string[] {
  const out: string[] = [];
  if (r.undelivered > 0) out.push(`${r.undelivered} report(s) written and not delivered`);
  for (const [h, s] of Object.entries(r.hooks)) if (s.startsWith("not_repaired")) out.push(`${h} hooks: ${s}`);
  for (const [h, s] of Object.entries(r.skills)) if (s.startsWith("not_repaired")) out.push(`${h} skills: ${s}`);
  for (const [h, s] of Object.entries(r.approvals)) if (s === "pending") out.push(`${h} hooks awaiting approval, so they do not run`);
  if (r.stale.length) out.push(`personal skill(s) stating a retired rule: ${r.stale.join(", ")}`);
  if (r.source === "learned") out.push("rules could not be staged from the app");
  return out;
}

