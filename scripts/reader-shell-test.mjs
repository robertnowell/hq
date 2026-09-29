#!/usr/bin/env node
// Who gets the hub (29 Sep 2026). A person handed a link, with no agent, no
// paired Mac and no team, reads the document alone: no sidebar, no collapse
// button. The author, reading the same address, keeps the hub. Two throwaway
// users, created and deleted the way cross-tenant-test does.
//
//   HQ_URL                where the app is      (default http://127.0.0.1:3111)
//   HQ_APP_DATABASE_URL   the app's own role    (from .env.local; RLS applies)
import { createHash, randomBytes } from "crypto";
import { readFileSync } from "fs";
import pg from "pg";

const URL_ = process.env.HQ_URL ?? "http://127.0.0.1:3111";
if (!process.env.HQ_APP_DATABASE_URL) {
  for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
    const m = l.match(/^HQ_APP_DATABASE_URL=(.*)$/); if (m) process.env.HQ_APP_DATABASE_URL = m[1].trim();
  }
}
const pool = new pg.Pool({ connectionString: process.env.HQ_APP_DATABASE_URL, max: 2 });
const run = randomBytes(4).toString("hex");
const asUser = async (uid, fn) => {
  const c = await pool.connect();
  try { await c.query(`begin; select set_config('hq.user_id', '${uid}', true)`); const o = await fn(c); await c.query("commit"); return o; }
  catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
};
const mkUser = async (name) => {
  const { rows } = await pool.query(`select * from hq_resolve_user($1)`, [`rs-${run}-${name}`]);
  const id = rows[0].id, token = "hq_" + randomBytes(32).toString("base64url");
  await asUser(id, (c) => c.query(`insert into device_tokens (user_id, name, token_sha256) values ($1,'rs',$2)`,
    [id, createHash("sha256").update(token).digest("hex")]));
  return { id, token, name };
};
const http = async (user, path) => {
  const r = await fetch(URL_ + path, { redirect: "manual", headers: { authorization: `Bearer ${user.token}`,
    ...(process.env.VERCEL_BYPASS ? { "x-vercel-protection-bypass": process.env.VERCEL_BYPASS } : {}) } });
  return { status: r.status, body: await r.text() };
};
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });
const A = await mkUser("author"), R = await mkUser("reader");
try {
  const html = `<!doctype html><html><head><title>rs ${run}</title></head><body><p>shared ${run}</p></body></html>`;
  const ing = await fetch(URL_ + "/api/ingest", { method: "POST", headers: { authorization: `Bearer ${A.token}`, "content-type": "application/json",
    ...(process.env.VERCEL_BYPASS ? { "x-vercel-protection-bypass": process.env.VERCEL_BYPASS } : {}) },
    body: JSON.stringify({ session_id: `rs-${run}-session`, slug: `rs-${run}`, title: `rs ${run}`, html, device: "rs" }) });
  if (ing.status !== 201) throw new Error(`ingest: ${ing.status} ${(await ing.text()).slice(0, 200)}`);
  const doc = (await ing.json()).id;
  await pool.query(`select * from hq_set_visibility($1, $2, 'link', $3)`, [A.id, doc, `rs-${run}`]);

  let r = await http(R, `/d/${doc}`);
  check("the reader can open the link", r.status === 200, `${r.status}`);
  check("the reader gets the bare shell", r.body.includes('data-shell="bare"'), r.body.includes('data-shell="hub"') ? "got hub" : "no shell marker");
  check("with no sidebar", !r.body.includes('class="hq-side'), "");
  check("and the document frame", r.body.includes(`/d/${doc}/raw`), "");
  r = await http(R, "/documents");
  check("the reader's list of shared pages is bare too", r.status === 200 && r.body.includes('data-shell="bare"'), `${r.status}`);
  r = await http(A, `/d/${doc}`);
  check("the author keeps the hub on the same address", r.status === 200 && r.body.includes('data-shell="hub"') && r.body.includes('class="hq-side'), `${r.status}`);
} finally {
  for (const u of [A, R]) await asUser(u.id, (c) => c.query(`delete from users where id=$1`, [u.id])).catch((e) => console.error("cleanup", u.name, e.message));
  await pool.end();
}
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed against ${URL_}`);
process.exit(failed ? 1 : 0);
