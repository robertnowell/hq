import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";
import { problemsOf } from "@/lib/fleet-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A Mac's agent-rules health, sent hourly by Tranquility Base.
 *
 * 30 Sep 2026: agents on one Mac followed two-month-old page rules and wrote
 * fourteen reports nothing uploaded, unseen for six days. Each Mac now says
 * which rules its agents read, whether its repair worked for every harness
 * (Claude Code, Codex, OpenCode), and how many pages its agents wrote that
 * never reached this hub. The hourly fleet check (/api/cron/fleet) alarms on
 * the problems derived here.
 *
 * A paired Mac only: a person in a browser has no rules to report.
 */
type Report = {
  device?: unknown; edition?: unknown; app_commit?: unknown;
  rules_fingerprint?: unknown; rules_source?: unknown;
  hooks?: unknown; skills?: unknown; approvals?: unknown;
  stale_personal_skills?: unknown; undelivered?: unknown; trigger?: unknown; page_problems?: unknown;
};

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");
const states = (v: unknown): Record<string, string> =>
  v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 20)
        .filter(([, s]) => typeof s === "string").map(([k, s]) => [k.slice(0, 40), (s as string).slice(0, 300)]))
    : {};

export async function POST(req: Request) {
  const who = await identify(req);
  if (!who) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!who.deviceId) return Response.json({ error: "device_required" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as Report | null;
  if (!body || typeof body !== "object") return Response.json({ error: "bad_request" }, { status: 400 });

  const device = str(body.device, 120);
  const edition = str(body.edition, 120);
  if (!device || !edition) return Response.json({ error: "device and edition are required" }, { status: 400 });
  const hooks = states(body.hooks), skills = states(body.skills), approvals = states(body.approvals);
  const stale = Array.isArray(body.stale_personal_skills)
    ? body.stale_personal_skills.filter((s): s is string => typeof s === "string").slice(0, 20).map((s) => s.slice(0, 80))
    : [];
  const u = body.undelivered as { count?: unknown; samples?: unknown } | undefined;
  const undelivered = typeof u?.count === "number" && u.count >= 0 ? Math.min(Math.floor(u.count), 100_000) : 0;
  const samples = Array.isArray(u?.samples)
    ? u!.samples.filter((s): s is string => typeof s === "string").slice(0, 5).map((s) => s.slice(0, 200))
    : [];
  const source = str(body.rules_source, 20);
  const pp = body.page_problems as { count?: unknown; samples?: unknown } | undefined;
  const pageProblems = typeof pp?.count === "number" && pp.count >= 0 ? Math.min(Math.floor(pp.count), 100_000) : 0;
  const pageSamples = Array.isArray(pp?.samples)
    ? pp!.samples.filter((s): s is string => typeof s === "string").slice(0, 5).map((s) => s.slice(0, 300))
    : [];
  const problems = problemsOf({ hooks, skills, approvals, stale, undelivered, source, pageProblems });
  const report = { hooks, skills, approvals, stale_personal_skills: stale, undelivered_samples: samples, page_problems: pageProblems, page_problem_samples: pageSamples,
                   trigger: str(body.trigger, 20) };

  await asUser(who.userId, (c) => c.query(
    `insert into device_health (user_id, device, edition, app_commit, rules_fingerprint, rules_source,
                                undelivered, problems, report, reported_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, now())
     on conflict (user_id, device, edition) do update set
       app_commit = excluded.app_commit, rules_fingerprint = excluded.rules_fingerprint,
       rules_source = excluded.rules_source, undelivered = excluded.undelivered,
       problems = excluded.problems, report = excluded.report, reported_at = now()`,
    [who.userId, device, edition, str(body.app_commit, 64), str(body.rules_fingerprint, 64), source,
     undelivered, problems, JSON.stringify(report)]));
  return Response.json({ ok: true, problems });
}
