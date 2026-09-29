// Live API/storage isolation drill. Creates and removes only its own two users.
// node --env-file=.env.local scripts/shipping-isolation-test.mjs
import { createHash, randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import pg from "pg";
import { Storage } from "@google-cloud/storage";
const base = process.env.HQ_URL ?? "http://127.0.0.1:3147";
const pool = new pg.Pool({ connectionString: process.env.HQ_APP_DATABASE_URL, max: 2 });
const creds = JSON.parse(Buffer.from(process.env.HQ_GCS_SA_KEY_B64, "base64").toString());
const storage = new Storage({ projectId: creds.project_id, credentials: { client_email: creds.client_email, private_key: creds.private_key } });
const bucket = storage.bucket(process.env.HQ_GCS_BUCKET ?? "");
const users = [], run = randomBytes(6).toString("hex");
const asUser = async (id, fn) => {
  const c = await pool.connect();
  try { await c.query("begin"); await c.query("select set_config('hq.user_id',$1,true)", [id]); const r = await fn(c); await c.query("commit"); return r; }
  catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
async function makeUser(name) {
  const id = (await pool.query("select id from hq_resolve_user($1)", [`shipping-test-${run}-${name}`])).rows[0].id;
  const user = { id, token: "hq_" + randomBytes(32).toString("base64url"), name }; users.push(user);
  user.device = (await asUser(id, c => c.query("insert into device_tokens(user_id,name,token_sha256) values($1,$2,$3) returning id",
    [id, name, createHash("sha256").update(user.token).digest("hex")]))).rows[0].id;
  return user;
}
const http = (user, method = "GET", body) => fetch(`${base}/api/shipping`, { method, redirect: "manual",
  headers: { ...(user ? { authorization: `Bearer ${user.token}` } : {}), "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
try {
  const a = await makeUser("A"), b = await makeUser("B");
  const snapshot = { repo: `fixture/shipping-${run}`, checkedAt: new Date().toISOString(), deviceName: "forged", prs: [], runs: [] };
  assert.equal((await http(null)).status, 401);
  assert.equal((await http({ token: "hq_invalid" }, "POST", snapshot)).status, 401);
  assert.equal((await http(a, "POST", { ...snapshot, userId: b.id, deviceId: b.device })).status, 200);
  let res = await http(a); assert.equal(res.status, 200); assert.match(res.headers.get("cache-control"), /no-store/);
  let data = await res.json(); assert.equal(data.snapshots.length, 1); assert.equal(data.snapshots[0].deviceName, "A");
  res = await http(b); assert.deepEqual((await res.json()).snapshots, []);
  assert.equal((await http(b, "POST", snapshot)).status, 200);
  const old = { ...snapshot, checkedAt: new Date(Date.now() - 3600_000).toISOString() };
  assert.equal((await http(a, "POST", old)).status, 409);
  assert.equal((await (await http(a)).json()).snapshots[0].checkedAt, snapshot.checkedAt);
  assert.equal((await http(a, "POST", { ...snapshot, repo: "../../unsafe" })).status, 400);
  assert.equal((await http(a, "POST", { ...snapshot, pad: "x".repeat(210_000) })).status, 413);
  // A second active device can read, but the revoked device's stored status is hidden.
  const token2 = "hq_" + randomBytes(32).toString("base64url");
  await asUser(a.id, c => c.query("insert into device_tokens(user_id,name,token_sha256) values($1,'A2',$2)", [a.id, createHash("sha256").update(token2).digest("hex")]));
  await asUser(a.id, c => c.query("update device_tokens set revoked_at=now() where id=$1", [a.device]));
  assert.equal((await http(a)).status, 401);
  assert.deepEqual((await (await http({ token: token2 })).json()).snapshots, []);
  assert.equal((await (await http(b)).json()).snapshots[0].deviceName, "B");
  console.log("PASS shipping API: positive reads/writes, forged ownership, tenant isolation, old-write refusal, input bounds, revoked devices, private caching");
} finally {
  for (const u of users) {
    await bucket.deleteFiles({ prefix: `u/${u.id}/shipping/` });
    await asUser(u.id, c => c.query("delete from users where id=$1", [u.id]));
  }
  await pool.end();
}
