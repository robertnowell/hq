// Drill: a Mac reports its agent-rules health; the hourly fleet check sees it.
//
// 30 Sep 2026: a Mac's agents followed old rules and wrote reports nothing
// uploaded, unseen for six days. This pairs a throwaway Mac, sends a report
// with problems (undelivered pages, Codex hooks awaiting approval), checks the
// row and the fleet check's answer, then sends a clean report and checks it
// clears. Run against a server on a Neon branch; exit 0 is the only pass.
//
//   HQ_URL=http://localhost:3199 HQ_APP_DATABASE_URL=… CRON_SECRET=… node scripts/fleet-health-test.mjs
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";

const URL_ = process.env.HQ_URL ?? "http://localhost:3199";
const CRON = process.env.CRON_SECRET;
if (!process.env.HQ_APP_DATABASE_URL || !CRON) { console.error("need HQ_APP_DATABASE_URL and CRON_SECRET"); process.exit(2); }
const pool = new pg.Pool({ connectionString: process.env.HQ_APP_DATABASE_URL, max: 3 });
const asUser = async (id, fn) => {
  const c = await pool.connect();
  try {
    await c.query(`begin; select set_config('hq.user_id', '${id}', true)`);
    const out = await fn(c); await c.query("commit"); return out;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const hash = (s) => createHash("sha256").update(s).digest("hex");
const run = randomBytes(4).toString("hex");
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  -- ${detail}` : ""}`);
  if (!ok) failed++;
};
const post = (token, body) => fetch(`${URL_}/api/ingest/health`, {
  method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const cron = async () => (await fetch(`${URL_}/api/cron/fleet`, { headers: { authorization: `Bearer ${CRON}` } })).json();

let userId = null;
try {
  userId = (await pool.query(`select id from hq_resolve_user($1)`, [`fleet-${run}`])).rows[0].id;
  const code = randomBytes(32).toString("base64url");
  await asUser(userId, (c) => c.query(
    `insert into device_claims (code_sha256, user_id, device_name, expires_at)
     values ($1, $2, $3, now() + interval '10 minutes')`, [hash(code), userId, `fleet-${run}`]));
  const claimed = await fetch(`${URL_}/api/devices/claim`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const { token } = await claimed.json();
  check("a Mac pairs", !!token);

  check("no credential: 401", (await post(null, { device: "x", edition: "y" })).status === 401);
  check("missing device: 400", (await post(token, { edition: "y" })).status === 400);

  const device = `fleet-mac-${run}`;
  const bad = await post(token, {
    device, edition: "com.example.dev", app_commit: "abc", rules_fingerprint: "f1", rules_source: "store",
    hooks: { "claude-code": "healthy", codex: "repaired" }, skills: { "claude-code": "healthy" },
    approvals: { codex: "pending" }, stale_personal_skills: ["deep-research"],
    undelivered: { count: 2, samples: ["f6300e08/aeo-pr-questions.html"] }, trigger: "hourly",
  });
  const badBody = await bad.json();
  check("a report with problems is stored and its problems named",
    bad.status === 200 && badBody.problems.length === 3, JSON.stringify(badBody));
  const row = await asUser(userId, (c) => c.query(`select * from device_health where device = $1`, [device]));
  check("one row per Mac and edition", row.rows.length === 1 && row.rows[0].undelivered === 2);

  const seen = await cron();
  const mine = (seen.problems ?? []).find((p) => p.device === device);
  check("the fleet check names this Mac and what is wrong",
    !!mine && mine.problems.some((p) => p.includes("not delivered")) && mine.problems.some((p) => p.includes("awaiting approval")),
    JSON.stringify(seen).slice(0, 300));

  const good = await post(token, {
    device, edition: "com.example.dev", rules_fingerprint: "f2", rules_source: "store",
    hooks: { "claude-code": "healthy", codex: "healthy" }, skills: { "claude-code": "healthy" },
    approvals: { codex: "granted" }, stale_personal_skills: [], undelivered: { count: 0, samples: [] },
  });
  check("a clean report names no problems", (await good.json()).problems.length === 0);
  const after = await cron();
  check("and the fleet check no longer names this Mac", !(after.problems ?? []).some((p) => p.device === device));
  const rows = await asUser(userId, (c) => c.query(`select count(*)::int as n from device_health`));
  check("the report replaced the old one", rows.rows[0].n === 1);

  const unauth = await fetch(`${URL_}/api/cron/fleet`);
  check("the fleet check refuses without the cron secret", unauth.status === 401);
} catch (e) {
  console.log("FAIL  drill crashed --", e.message); failed++;
} finally {
  if (userId) {
    await asUser(userId, (c) => c.query(`delete from device_health`)).catch(() => {});
    await pool.query(`delete from device_tokens where user_id = $1`, [userId]).catch(() => {});
  }
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
