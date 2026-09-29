#!/usr/bin/env node
// The Notes drill: the ingest route's contract and what the page makes of it.
//
// One throwaway user, a device token minted the way the app mints them, a
// handful of invented notes, and assertions against the route and the
// rendered /notes page: idempotency, the cut at 8,000 characters, chunks,
// the three filters and the Older link. The user is deleted at the end
// (cascade). Isolation between users is cross-tenant-test.mjs's job.
//
//   HQ_URL                where the app is      (default http://127.0.0.1:3111)
//   HQ_APP_DATABASE_URL   the app's own role    (from .env.local; RLS applies)
//
// Exit 0 only if every check passes.
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
const { rows: [u] } = await pool.query(`select * from hq_resolve_user($1)`, [`nt-${run}`]);
const token = "hq_" + randomBytes(32).toString("base64url");
await asUser(u.id, (c) => c.query(`insert into device_tokens (user_id, name, token_sha256) values ($1,'nt',$2)`,
  [u.id, createHash("sha256").update(token).digest("hex")]));

const http = async (path, init = {}, auth = true) => {
  const r = await fetch(URL_ + path, { ...init, redirect: "manual",
    headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) } });
  return { status: r.status, body: await r.text() };
};
const post = (notes, auth = true) => http("/api/ingest/notes", { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ device: "nt", notes }) }, auth);
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); };
const count = (s, needle) => s.split(needle).length - 1;
// The page escapes what it prints; the drill compares against the same.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#x27;");

// Invented speech, one clock. Three lines to one agent inside two minutes
// (one chunk), a line to another agent (a chunk of its own), two hands-free
// lines (one chunk) and one more after a pause (its own chunk).
const t0 = Date.parse("2026-09-20T17:00:00.000Z");
const at = (s) => new Date(t0 + s * 1000).toISOString();
const X = `nt-${run}-agent-x`, Y = `nt-${run}-agent-y`;
const said = [
  { source_key: `dictation:${run}-1`, at: at(0), source: "dictation", kind: "confirmed",
    text: `first ${run} about the harbour lights`, agent_session: X, agent_name: "Lighthouse" },
  { source_key: `dictation:${run}-2`, at: at(60), source: "dictation", kind: "confirmed",
    text: `second ${run}\nwith a line break`, agent_session: X, agent_name: "Lighthouse" },
  { source_key: `dictation:${run}-3`, at: at(170), source: "dictation", kind: "discarded",
    text: `third ${run} ok then`, agent_session: X, agent_name: "Lighthouse" },
  { source_key: `dictation:${run}-4`, at: at(200), source: "dictation", kind: "confirmed",
    text: `fourth ${run} to the other one`, agent_session: Y, agent_name: "Ferry" },
  { source_key: `ledger:hf-${run}:1`, at: at(400), source: "handsfree", kind: "talk",
    text: `fifth ${run} spoken aloud` },
  { source_key: `ledger:hf-${run}:2`, at: at(430), source: "handsfree", kind: "command",
    text: `sixth ${run} to the manager` },
  { source_key: `ledger:hf-${run}:3`, at: at(900), source: "handsfree", kind: "talk",
    text: `seventh ${run} after a pause` },
];

try {
  let r = await post(said, false);
  check("no credential is 401", r.status === 401, `${r.status}`);
  r = await post([]);
  check("an empty batch is 400", r.status === 400, `${r.status}`);
  r = await post([{ ...said[0], source: "email" }]);
  check("an unknown source is 400", r.status === 400, `${r.status}`);
  r = await post([{ ...said[0], at: "yesterday" }]);
  check("a bad time is 400", r.status === 400, `${r.status}`);
  r = await post(Array.from({ length: 501 }, (_, i) => ({ ...said[0], source_key: `x${i}` })));
  check("501 notes is 413", r.status === 413, `${r.status}`);

  r = await post(said);
  check("a batch is stored", r.status === 200 && JSON.parse(r.body).inserted === said.length, r.body);
  r = await post(said);
  check("the same batch again inserts nothing", r.status === 200 && JSON.parse(r.body).inserted === 0, r.body);
  r = await post([{ ...said[0], text: `first ${run} about the harbour lights, corrected` },
                  { ...said[0], text: `first ${run} about the harbour lights, corrected twice` }]);
  const first = await asUser(u.id, async (c) => (await c.query(
    `select text from notes where source_key=$1`, [said[0].source_key])).rows[0].text);
  check("a resend updates in place, last copy wins",
    r.status === 200 && first.endsWith("corrected twice"), first);
  await post([said[0]]);

  const long = "w".repeat(9000);
  r = await post([{ source_key: `dictation:${run}-long`, at: at(-86400 * 3), source: "dictation", text: long }]);
  const stored = await asUser(u.id, async (c) => (await c.query(
    `select length(text)::int n from notes where source_key=$1`, [`dictation:${run}-long`])).rows[0].n);
  check("a long note is cut to 8,000 characters, not refused", r.status === 200 && stored === 8001, `n=${stored}`);

  // The page.
  r = await http(`/notes`);
  const page = r.body;
  check("/notes renders", r.status === 200, `${r.status}`);
  check("every line is printed", said.every((n) => page.includes(esc(n.text))));
  // The long note is three days earlier, so its chunk is a fifth.
  check("chunks: one per agent run, one per hands-free stretch",
    count(page, 'class="nt-chunk"') === 5, `n=${count(page, 'class="nt-chunk"')}`);
  check("a chunk's lines are in the order said",
    page.indexOf(esc(said[0].text)) < page.indexOf(esc(said[1].text))
      && page.indexOf(esc(said[1].text)) < page.indexOf(esc(said[2].text)));
  check("newest chunk first",
    page.indexOf(esc(said[6].text)) < page.indexOf(esc(said[4].text))
      && page.indexOf(esc(said[4].text)) < page.indexOf(esc(said[0].text)));
  check("a dictation chunk names its agent", page.includes("Dictated to Lighthouse") && page.includes("Dictated to Ferry"));
  check("a hands-free chunk says so", page.includes("Hands-free"));
  check("a copy control per chunk and per line",
    count(page, 'class="nt-copy"') === 5 && count(page, 'class="nt-copy-line"') === said.length + 1);
  check("a dictation that never went says so", count(page, 'class="nt-tag"') === 1);
  check("days are headed", count(page, 'class="nt-day"') === 2, `n=${count(page, 'class="nt-day"')}`);

  // The hub's name wins over the one the Mac sent, so a rename reaches old notes.
  await asUser(u.id, (c) => c.query(
    `insert into agents (user_id, source_session_id, title, first_seen_at, last_active_at)
     values ($1, $2, 'Lighthouse renamed', now(), now())`, [u.id, X]));
  r = await http(`/notes`);
  check("the agent's current name is used", r.body.includes("Dictated to Lighthouse renamed"));

  r = await http(`/notes?source=handsfree`);
  check("source filter: hands-free only",
    r.body.includes(esc(said[4].text)) && !r.body.includes(esc(said[0].text)));
  r = await http(`/notes?source=dictation`);
  check("source filter: dictations only",
    r.body.includes(esc(said[3].text)) && !r.body.includes(esc(said[4].text)));
  r = await http(`/notes?agent=Ferry`);
  check("agent filter",
    r.body.includes(esc(said[3].text)) && !r.body.includes(esc(said[1].text)) && !r.body.includes(esc(said[5].text)));
  check("the dropdown lists the agents", r.body.includes(">Lighthouse renamed</option>") && r.body.includes(">Ferry</option>"));
  r = await http(`/notes?q=${encodeURIComponent("harbour light")}`);
  check("search matches words, stemmed", r.body.includes(esc(said[0].text)) && !r.body.includes(esc(said[3].text)));
  r = await http(`/notes?q=${encodeURIComponent(`"to the manager" ${run}`)}`);
  check("search takes a quoted phrase", r.body.includes(esc(said[5].text)) && !r.body.includes(esc(said[3].text)));
  r = await http(`/notes?q=ok`);
  check("a two-letter query is a substring match", r.body.includes(esc(said[2].text)) && !r.body.includes(esc(said[1].text)));
  r = await http(`/notes?q=${encodeURIComponent("the other")}`);
  check("a stop-word query falls back to a substring match",
    r.body.includes(esc(said[3].text)) && !r.body.includes(esc(said[0].text)));
  r = await http(`/notes?q=zzz${run}`);
  check("a search with no match says so", r.body.includes("Nothing you have said matches this."));

  // Paging: 301 more notes, one a second, is two pages with nothing lost.
  const many = Array.from({ length: 301 }, (_, i) => ({ source_key: `ledger:pg-${run}:${i}`,
    at: new Date(t0 + 86400_000 + i * 1000).toISOString(), source: "handsfree", kind: "talk",
    text: `page line ${i} ${run}` }));
  await post(many.slice(0, 200)); await post(many.slice(200));
  r = await http(`/notes?source=handsfree`);
  const lines1 = count(r.body, 'class="nt-line"');
  const older = r.body.match(/href="(\/notes\?[^"]*before=[^"]*)"/)?.[1]?.replace(/&amp;/g, "&");
  check("page one holds 300 notes and an Older link", lines1 === 300 && !!older, `n=${lines1}`);
  r = await http(older ?? "/notes");
  const lines2 = count(r.body, 'class="nt-line"');
  // 304 hands-free notes in all: 301 here and the three above.
  check("Older holds the rest, filters kept", lines2 === 4 && r.body.includes(esc(said[4].text))
    && r.body.includes(esc(`page line 0 ${run}`)) && !r.body.includes(esc(said[0].text)), `n=${lines2}`);
  check("and nothing is on both pages", !r.body.includes(esc(`page line 1 ${run}`)));
} finally {
  await asUser(u.id, (c) => c.query(`delete from users where id=$1`, [u.id])).catch((e) => console.error("cleanup", e.message));
  await pool.end();
}
const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(w)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed against ${URL_}`);
process.exit(failed ? 1 : 0);
