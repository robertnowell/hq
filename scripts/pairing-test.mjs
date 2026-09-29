// The pairing drill: a Mac collects exactly one token, once, and only when a
// person approved it.
//
// Run by hand, like the cross-tenant drill beside it:
//   node scripts/pairing-test.mjs
//
// It talks to the deployed app over HTTP for the unauthenticated half (the
// claim route, which is the only route in the app a stranger can reach) and
// to the database directly for the half a signed-in page would do, because
// there is no way to hold a Clerk session from a script.
import { randomBytes, createHash } from "crypto";
import pg from "pg";
import { readFileSync } from "fs";

const URL_ = process.env.HQ_URL ?? "https://hq.tranquilitybase.dev";
let db = process.env.HQ_APP_DATABASE_URL;
if (!db) {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  db = env.match(/^HQ_APP_DATABASE_URL=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
}
const pool = new pg.Pool({ connectionString: db, max: 3 });
const asUser = async (id, fn) => {
  const c = await pool.connect();
  try {
    await c.query(`begin; select set_config('hq.user_id', '${id}', true)`);
    const out = await fn(c); await c.query("commit"); return out;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};

const run = randomBytes(4).toString("hex");
const hash = (s) => createHash("sha256").update(s).digest("hex");
const newCode = () => randomBytes(32).toString("base64url");
const claim = async (code) => {
  const r = await fetch(`${URL_}/api/devices/claim`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const approve = (userId, code, name) =>
  asUser(userId, (c) => c.query(
    `insert into device_claims (code_sha256, user_id, device_name, expires_at)
     values ($1, $2, $3, now() + interval '10 minutes')`, [hash(code), userId, name]));

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  -- ${detail}` : ""}`);
  if (!ok) failed++;
};

const users = [];
const mkUser = async (n) => {
  const { rows } = await pool.query(`select * from hq_resolve_user($1)`, [`pair-${run}-${n}`]);
  users.push(rows[0].id); return rows[0].id;
};

try {
  const a = await mkUser("a"), b = await mkUser("b");

  // Shape
  check("a malformed code is refused", (await claim("nope")).status === 400);
  check("a missing code is refused",
    (await fetch(`${URL_}/api/devices/claim`, { method: "POST",
      headers: { "content-type": "application/json" }, body: "{}" })).status === 400);

  // An unapproved code waits, and says nothing about whether it exists
  const unknown = newCode();
  const pending = await claim(unknown);
  check("an unknown code is pending, not an error",
    pending.status === 202 && pending.body.error === "authorization_pending",
    `${pending.status} ${JSON.stringify(pending.body)}`);

  // The happy path
  const code = newCode();
  await approve(a, code, `drill-${run}`);
  const got = await claim(code);
  check("an approved code yields a token once",
    got.status === 200 && typeof got.body.token === "string" && got.body.token.startsWith("hq_"),
    `${got.status} ${JSON.stringify(got.body).slice(0, 120)}`);
  check("the token names the device the person approved",
    got.body.device_name === `drill-${run}`);

  // Single use
  const again = await claim(code);
  check("a second collection is refused",
    again.status === 410 && again.body.error === "expired_token",
    `${again.status} ${JSON.stringify(again.body)}`);

  // The token works, and is scoped to the person who approved it
  const withToken = async (t, path) =>
    fetch(`${URL_}${path}`, { headers: { authorization: `Bearer ${t}` }, redirect: "manual" });
  const list = await withToken(got.body.token, "/api/devices");
  const listed = await list.json().catch(() => ({}));
  check("the collected token authenticates", list.status === 200);
  check("it sees only its own owner's devices",
    (listed.devices ?? []).every((d) => d.name === `drill-${run}`),
    JSON.stringify(listed).slice(0, 160));

  // Expiry
  const stale = newCode();
  await approve(a, stale, "stale");
  await asUser(a, (c) => c.query(
    `update device_claims set expires_at = now() - interval '1 minute' where code_sha256 = $1`,
    [hash(stale)]));
  const old = await claim(stale);
  check("an expired code is refused", old.status === 410, `${old.status}`);

  // The claim is bound to the approver, never to whoever polls
  const bCode = newCode();
  await approve(b, bCode, "b-mac");
  const bGot = await claim(bCode);
  const bList = await withToken(bGot.body.token, "/api/devices");
  const bListed = await bList.json().catch(() => ({}));
  check("a token collected for B belongs to B, never to A",
    (bListed.devices ?? []).every((d) => d.name === "b-mac"),
    JSON.stringify(bListed).slice(0, 160));

  // Nothing readable is left behind
  // Under the owner's scope, because outside one the policy correctly shows
  // nothing -- which is its own check, so make it one.
  const leftover = await asUser(a, (c) => c.query(
    `select count(*)::int as n from device_claims where code_sha256 = $1 and claimed_at is not null`,
    [hash(code)]));
  check("a claimed row is kept, and holds no token", leftover.rows[0].n === 1);
  const { rows: unscoped } = await pool.query(
    `select count(*)::int as n from device_claims where code_sha256 = $1`, [hash(code)]);
  check("with no tenant context the claim is invisible", unscoped[0].n === 0);
  const cols = await pool.query(
    `select count(*)::int as n from information_schema.columns
      where table_name = 'device_claims' and column_name in ('token','secret')`);
  check("the claims table has no column that could hold a token", cols.rows[0].n === 0);

  // Revoking, which is the other half of minting: a key that cannot be taken
  // back is a key you can only regret. The page does this through a server
  // action, which a script cannot hold a session for, so the drill performs
  // the same UPDATE inside the same tenant scope lib/devices.ts uses.
  const revoke = (uid, id) => asUser(uid, (c) => c.query(
    `update device_tokens set revoked_at = now() where id = $1 and revoked_at is null`, [id]));

  const mine = await withToken(got.body.token, "/api/devices");
  const rows = (await mine.json()).devices ?? [];
  const target = rows.find((d) => d.name === `drill-${run}`);
  check("a live device is listed with no revoked_at", !!target && target.revoked_at === null);

  // A's device id, presented in B's scope: RLS decides, not a WHERE clause.
  const crossed = await revoke(b, target.id);
  check("one person cannot revoke another's Mac", (crossed.rowCount ?? 0) === 0);
  check("and that token still works",
    (await withToken(got.body.token, "/api/devices")).status === 200);

  const done = await revoke(a, target.id);
  check("its owner can revoke it", (done.rowCount ?? 0) === 1);
  check("a revoked token is refused at once",
    (await withToken(got.body.token, "/api/devices")).status === 401);
  check("revoking twice changes nothing",
    ((await revoke(a, target.id)).rowCount ?? 0) === 0);
  const after = await asUser(a, (c) => c.query(
    `select revoked_at from device_tokens where id = $1`, [target.id]));
  check("the row is kept, stamped, so the history survives",
    after.rows.length === 1 && after.rows[0].revoked_at !== null);
} finally {
  // Inside each user's own scope, or nothing happens.
  //
  // This used to delete through the bare pool, which is the app role with
  // row-level security forced: outside a tenant context the row is invisible,
  // so the DELETE matched nothing, reported nothing, and every run of this
  // drill left a user, its device tokens and its claims in the production
  // database. Eighteen of them, found 13 Sep. A cleanup that cannot fail
  // loudly has to be written so it cannot fail silently either.
  for (const id of users) {
    const gone = await asUser(id, (c) => c.query(`delete from users where id = $1`, [id]))
      .catch((e) => { console.error(`cleanup ${id}: ${e.message}`); return null; });
    if (gone && gone.rowCount !== 1) console.error(`cleanup ${id}: deleted ${gone.rowCount} rows`);
  }
  await pool.end();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
