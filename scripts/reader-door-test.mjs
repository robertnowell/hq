#!/usr/bin/env node
// The reader's door, walked in a phone-sized browser (29 Sep 2026). A reader
// sent a link by text enters their email, leaves for their inbox, taps the
// link again and enters the code. Before this, the second tap started a new
// sign-in (a second code; the one they fetched was dead), and a first-time
// reader who did get in landed on "/" instead of the document.
//
// Needs the dev Clerk instance with production's sign-in settings (email code
// only) and bot protection off, so a headless browser can sign up; +clerk_test
// addresses take the code 424242. Throwaway author, document and readers are
// deleted at the end.
//
//   HQ_URL   where the app is   (default http://127.0.0.1:3141)
//   CHROME   a Chrome binary    (default the installed Google Chrome)
import { createHash, randomBytes } from "crypto";
import { readFileSync } from "fs";
import pg from "pg";
import { chromium, devices } from "playwright";

const BASE = process.env.HQ_URL ?? "http://127.0.0.1:3141";
const env = {};
for (const l of readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
}
const pool = new pg.Pool({ connectionString: process.env.HQ_APP_DATABASE_URL ?? env.HQ_APP_DATABASE_URL, max: 2 });
const run = randomBytes(4).toString("hex");
const asUser = async (uid, fn) => { const c = await pool.connect();
  try { await c.query(`begin; select set_config('hq.user_id', '${uid}', true)`); const o = await fn(c); await c.query("commit"); return o; }
  catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); } };

// The author and a link-shared document.
const { rows } = await pool.query(`select * from hq_resolve_user($1)`, [`rd-${run}-author`]);
const author = rows[0].id, token = "hq_" + randomBytes(32).toString("base64url");
await asUser(author, (c) => c.query(`insert into device_tokens (user_id, name, token_sha256) values ($1,'rd',$2)`,
  [author, createHash("sha256").update(token).digest("hex")]));
const ing = await fetch(BASE + "/api/ingest", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ session_id: `rd-${run}-session`, slug: `rd-${run}`, title: `Door ${run}`,
    html: `<!doctype html><html><head><title>Door ${run}</title></head><body><h1>door ${run}</h1></body></html>`, device: "rd" }) });
if (ing.status !== 201) throw new Error(`ingest: ${ing.status} ${(await ing.text()).slice(0, 200)}`);
const doc = (await ing.json()).id;
await pool.query(`select * from hq_set_visibility($1, $2, 'link', $3)`, [author, doc, `rd-${run}`]);

const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok, detail });
const readers = [];
const CODE = 'input[autocomplete="one-time-code"], [data-input-otp] input, input[inputmode="numeric"]';

// One reader: email, (the second tap), code. Returns where they ended.
async function walk(o) {
  try { return await walkOnce(o); }
  catch (e) { return { resumed: false, words: "", end: `stopped: ${e.message.split("\n")[0]}` }; }
}
async function walkOnce({ start, email, retap, otherFirst }) {
  const ctx = await browser.newContext({ ...devices["iPhone 13"] });
  const p = await ctx.newPage();
  if (process.env.DEBUG) p.on("response", async (r) => { if (r.url().includes("clerk") && r.request().method() !== "GET") console.error("net:", r.status(), r.request().method(), r.url().replace(/\?.*/, "").slice(-60), r.status() >= 400 ? (await r.text().catch(() => "")).slice(0, 250) : ""); });
  if (process.env.DEBUG) p.on("console", (m) => m.type() === "error" && console.error("console:", m.text().slice(0, 300)));
  const submit = async (e) => {
    await p.waitForSelector('input[name="identifier"]', { timeout: 30000 });
    await p.waitForTimeout(1000);   // the card hydrates after it is drawn
    await p.fill('input[name="identifier"]', e);
    await p.getByRole("button", { name: /^Continue/ }).click();
    await p.waitForSelector(CODE, { state: "attached", timeout: 30000 }).catch(async (e) => { if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT }); if (process.env.DEBUG) console.error("at:", p.url(), await p.evaluate(() => JSON.stringify({ up: window.Clerk?.client?.signUp?.id, upEmail: window.Clerk?.client?.signUp?.emailAddress, inn: window.Clerk?.client?.signIn?.status }))); throw e; });
  };
  await p.goto(BASE + start);
  if (otherFirst) {          // a typo: the wrong address, then "Use a different email"
    await submit(otherFirst);
    await p.getByRole("button", { name: "Use a different email" }).click();
    await p.waitForLoadState("load");
  }
  await submit(email);
  if (retap) { await p.goto(BASE + start); await p.waitForTimeout(4000); }
  const resumed = await p.$(CODE);
  const words = await p.textContent(".gate-sub").catch(() => "");
  if (resumed) {
    await resumed.click(); await p.keyboard.type("424242");
    // The door is already at the document's address, so wait for the
    // document itself, or for the sign-in to have gone somewhere else.
    await p.waitForSelector(`iframe[src*="/d/${doc}/raw"]`, { state: "attached", timeout: 30000 }).catch(() => {});
  }
  // On the document means the document, not its door: the frame is drawn.
  const inside = await p.$(`iframe[src*="/d/${doc}/raw"]`);
  const end = new URL(p.url()).pathname + (inside ? "" : " (at the door, or no document)");
  await ctx.close();
  return { resumed: !!resumed, words, end };
}

try {
  const fresh = (n) => { const e = `rd-${run}-${n}+clerk_test@example.com`; readers.push(e); return e; };
  let r = await walk({ start: `/d/${doc}`, email: fresh("new"), retap: true });
  check("a new reader who taps the link again is still at the code", r.resumed, r.end);
  check("and is told where the code went", r.words.includes(`rd-${run}-new`), r.words);
  check("and lands on the document", r.end === `/d/${doc}`, r.end);

  r = await walk({ start: `/d/${doc}`, email: fresh("direct") });
  check("a new reader who goes straight through lands on the document, not the hub", r.end === `/d/${doc}`, r.end);

  const back = readers[0];
  r = await walk({ start: `/d/${doc}`, email: back, retap: true });
  check("a returning reader who taps again is still at the code", r.resumed, r.end);
  check("and lands on the document", r.end === `/d/${doc}`, r.end);

  r = await walk({ start: `/p/rd-${run}`, email: fresh("old-link"), retap: true });
  check("on the older /p link too, a new reader resumes", r.resumed, r.end);
  check("and lands on the document", r.end === `/d/${doc}`, r.end);

  r = await walk({ start: `/d/${doc}`, email: fresh("right"), otherFirst: fresh("typo"), retap: true });
  check("a reader who mistyped can start over, and the second address is the one resumed", r.resumed && r.words.includes(`rd-${run}-right`), r.words);
  check("and lands on the document", r.end === `/d/${doc}`, r.end);
} finally {
  await browser.close();
  // Readers made real Clerk users on the dev instance and hub users here.
  for (const email of readers) {
    const q = await fetch(`https://api.clerk.com/v1/users?email_address=${encodeURIComponent(email)}`, { headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}` } });
    for (const u of q.ok ? await q.json() : []) {
      await fetch(`https://api.clerk.com/v1/users/${u.id}`, { method: "DELETE", headers: { authorization: `Bearer ${env.CLERK_SECRET_KEY}` } });
      const h = await pool.query(`select id from hq_resolve_user($1)`, [u.id]).catch(() => ({ rows: [] }));
      for (const x of h.rows) await asUser(x.id, (c) => c.query(`delete from users where id=$1`, [x.id])).catch(() => {});
    }
  }
  await asUser(author, (c) => c.query(`delete from users where id=$1`, [author])).catch((e) => console.error("cleanup author", e.message));
  await pool.end();
}
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.ok ? "" : r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed against ${BASE}`);
process.exit(failed ? 1 : 0);
