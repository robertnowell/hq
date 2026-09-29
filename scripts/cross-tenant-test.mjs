#!/usr/bin/env node
// The one drill the build plan said never to defer.
//
// Sign in as user A, enumerate every route with user B's ids, and assert that
// nothing of B's comes back: no row, no 200. Two throwaway users are created
// through the same SECURITY DEFINER function the app uses, given device
// tokens the same way the app mints them, and deleted at the end (cascade).
//
//   HQ_URL                where the app is      (default http://127.0.0.1:3111)
//   HQ_APP_DATABASE_URL   the app's own role    (from .env.local; RLS applies)
//
// Exit 0 only if every check passes. Anything else is a failed isolation.
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
  const { rows } = await pool.query(`select * from hq_resolve_user($1)`, [`ct-${run}-${name}`]);
  const id = rows[0].id;
  const token = "hq_" + randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  await asUser(id, (c) => c.query(`insert into device_tokens (user_id, name, token_sha256) values ($1,'ct',$2)`, [id, hash]));
  return { id, token, name };
};
const http = async (user, path, init = {}) => {
  const r = await fetch(URL_ + path, { ...init, redirect: "manual",
    headers: { authorization: `Bearer ${user.token}`, ...(init.headers ?? {}) } });
  return { status: r.status, body: await r.text(), location: r.headers.get("location") ?? "" };
};
const ingest = async (user, word) => {
  const html = `<!doctype html><html><head><title>ct ${user.name} ${word}</title></head><body><p>${word} belongs to ${user.name} only</p></body></html>`;
  const r = await http(user, "/api/ingest", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: `ct-${run}-${user.name}-session`, slug: `ct-${word}`, title: `ct ${user.name} ${word}`, html, device: "ct" }) });
  if (r.status !== 201) throw new Error(`ingest as ${user.name}: ${r.status} ${r.body.slice(0, 200)}`);
  return JSON.parse(r.body).id;
};

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); };

const A = await mkUser("a"), B = await mkUser("b");
try {
  const wordA = `alpha${run}`, wordB = `bravo${run}`;
  const docA = await ingest(A, wordA), docB = await ingest(B, wordB);
  const docASlug = `ct-${wordA}`;
  const agentB = await asUser(B.id, async (c) => (await c.query(`select agent_id from documents where id=$1`, [docB])).rows[0].agent_id);
  const agentA = await asUser(A.id, async (c) => (await c.query(`select agent_id from documents where id=$1`, [docA])).rows[0].agent_id);

  // Sanity: A can see A. A test that only proves nothing is visible would
  // pass against a dead server.
  // The reading surface is two things since 13 Sep: the app's page, which
  // holds the chrome, and the frame inside it, which holds the bytes.
  let r = await http(A, `/d/${docA}/raw`);
  check("A reads own document", r.status === 200 && r.body.includes(wordA), `${r.status}`);
  r = await http(A, `/d/${docA}`);
  check("and the page around it is the app's", r.status === 200 && r.body.includes("/raw"),
    `${r.status}`);
  // The document is served in a null origin: sandboxed, and never
  // allow-same-origin, or a script inside it would be us.
  const csp = (await fetch(URL_ + `/d/${docA}/raw`, { headers: { authorization: `Bearer ${A.token}` } })).headers.get("content-security-policy") ?? "";
  check("/d/ is sandboxed to a null origin", /(^|;|\s)sandbox(\s|$)/.test(csp.split(";")[0] + " ") && !csp.includes("allow-same-origin"), csp.slice(0, 60) || "no header");
  check("and only this app may frame it", csp.includes("frame-ancestors 'self'"),
    csp.slice(0, 80));

  // Every route, with B's ids, as A.
  r = await http(A, `/d/${docB}/raw`);
  check("/d/<B doc> is 404 for A", r.status === 404 && !r.body.includes(wordB), `${r.status}`);
  r = await http(A, `/d/${docB}`);
  check("and its page is too", r.status === 404 && !r.body.includes(wordB), `${r.status}`);
  r = await http(A, `/a/${agentB}`);
  // The id is in the request URL, so a 404 page that echoes the path is not
  // a leak; B's content and B's session id would be.
  check("/a/<B agent> is 404 for A", r.status === 404 && !r.body.includes(wordB) && !r.body.includes(`ct-${run}-b-session`), `${r.status}${r.body.includes(agentB) ? " (page echoes the requested id)" : ""}`);
  r = await http(A, `/api/since?since=1970-01-01T00:00:00Z`);
  check("/api/since never lists B", r.status === 200 && !r.body.includes(docB) && !r.body.includes(wordB), `${r.status}`);
  // The home is a redirect now (to your own top agent, or to the front door
  // when signed out), so this checks the DESTINATION as well as the page:
  // sending A to B's agent would be the leak, and a 200-only assertion here
  // silently stopped testing anything the day the front door landed.
  r = await http(A, `/`);
  const home = r.status === 200 ? "/" : r.location;
  check("/ never sends A to B's agent",
    !home.includes(agentB), `${r.status} -> ${home}`);
  if (r.status !== 200 && home.startsWith("/")) r = await http(A, home);
  check("/ never shows B", r.status === 200 && !r.body.includes(docB) && !r.body.includes(agentB) && !r.body.includes(wordB), `${r.status}`);
  // The share page is an authenticated surface of its own, and it names a
  // document by id, which is exactly the shape that leaks when a page forgets
  // to run inside the tenant scope.
  r = await http(A, `/share/${docB}`);
  check("/share never opens B's document", r.status === 404, `${r.status}`);

  r = await http(A, `/agents`);
  check("/agents never lists B's agent", r.status === 200 && !r.body.includes(agentB) && !r.body.includes(`ct-${run}-b-session`), `${r.status}`);
  // Positive control first. A search that finds nothing for anyone would
  // pass the isolation check below for the wrong reason; it did, for two
  // days, while the search vector was null on every row.
  r = await http(A, `/?q=${wordA}`);
  check("search finds A's own document for A", r.status === 200 && r.body.includes(docA), `${r.status}`);
  r = await http(A, `/?q=${wordB}`);
  check("search for B's word finds nothing for A", r.status === 200 && !r.body.includes(docB) && !r.body.includes(`${wordB} belongs`), `${r.status}`);
  // The read API, added 14 Sep. Every route gets a positive control first:
  // a route that answers nothing to anybody passes an isolation check for the
  // wrong reason, which this drill has already been fooled by once.
  r = await http(A, `/api/agents?active=365d&limit=50`);
  check("/api/agents answers A about A",
    r.status === 200 && r.body.includes(`ct-${run}-a-session`), `${r.status}`);
  check("/api/agents never names B's session",
    !r.body.includes(`ct-${run}-b-session`), r.body.slice(0, 120));

  r = await http(A, `/api/search?q=${wordA}`);
  check("/api/search finds A's own word", r.status === 200 && r.body.includes(docASlug),
    `${r.status} ${r.body.slice(0, 120)}`);
  r = await http(A, `/api/search?q=${wordB}`);
  // The response echoes the query, which is not a leak: what would be one is
  // a result. So this reads the results rather than the whole body.
  const hitsB = JSON.parse(r.body || "{}").results ?? [];
  check("/api/search never finds B's word",
    r.status === 200 && hitsB.length === 0 && !r.body.includes(`ct-${run}-b-session`),
    r.body.slice(0, 140));

  r = await http(A, `/api/turns?session=ct-${run}-b-session`);
  check("/api/turns is empty for B's session",
    r.status === 200 && !r.body.includes(`ct-${run}-b-session`), `${r.status}`);

  r = await http(A, `/api/page?session=ct-${run}-b-session&slug=ct-${wordB}`);
  check("/api/page refuses B's page", r.status === 404 && !r.body.includes(wordB),
    `${r.status}`);
  r = await http(A, `/api/page?session=ct-${run}-a-session&slug=ct-${wordA}`);
  check("/api/page serves A's own page",
    r.status === 200 && r.body.includes(wordA), `${r.status}`);
  check("and the read API says how to reach it",
    r.body.includes("/open?session="), r.body.slice(0, 120));

  r = await http(A, `/api/devices`);
  // Every device belongs to A, and none of B's appear. NOT "exactly one":
  // a person may connect a second Mac, and pinning the count made this drill
  // fail on a feature rather than on a leak (12 Sep).
  check("/api/devices lists only A's tokens", r.status === 200 && (() => {
    const d = JSON.parse(r.body).devices ?? [];
    return d.length >= 1 && d.every((x) => x.name === "ct");
  })(), `${r.status} n=${(() => { try { return JSON.parse(r.body).devices.length; } catch { return "?"; } })()}`);
  // The idempotency key is per user: A posting B's exact bytes must get its
  // OWN row, not B's id.
  const dup = await http(A, "/api/ingest", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: `ct-${run}-a-session`, html: `<!doctype html><html><head><title>ct b ${wordB}</title></head><body><p>${wordB} belongs to b only</p></body></html>` }) });
  check("A re-posting B's bytes gets a new id, not B's", dup.status === 201 && JSON.parse(dup.body).id !== docB, `${dup.status}`);

  // Notes, added 26 Sep: what a person said is the most private thing the
  // hub holds. Each user says one word; each word must stay with its owner
  // on the page, in the page's search, and in the table.
  const say = (user, word) => http(user, "/api/ingest/notes", { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device: "ct", notes: [{ source_key: `dictation:ct-${run}-${user.name}`,
      at: new Date().toISOString(), source: "dictation", kind: "confirmed",
      text: `${word} was said by ${user.name}`, agent_session: `ct-${run}-${user.name}-session`,
      agent_name: `ct agent ${user.name}` }] }) });
  const saidA = `said${wordA}`, saidB = `said${wordB}`;
  r = await say(A, saidA);
  check("A can post a note", r.status === 200, `${r.status} ${r.body.slice(0, 80)}`);
  r = await say(B, saidB);
  check("B can post a note", r.status === 200, `${r.status} ${r.body.slice(0, 80)}`);
  r = await http(A, `/notes`);
  check("/notes shows A what A said", r.status === 200 && r.body.includes(saidA), `${r.status}`);
  check("/notes never shows A what B said",
    !r.body.includes(saidB) && !r.body.includes(`ct agent b`), `${r.status}`);
  r = await http(A, `/notes?q=${saidA}`);
  check("notes search finds A's own words for A", r.status === 200 && r.body.includes(`${saidA} was said`), `${r.status}`);
  r = await http(A, `/notes?q=${saidB}`);
  // The query is echoed into the search box, which is not a leak; the
  // sentence it would have matched is.
  check("notes search for B's word finds nothing for A",
    r.status === 200 && !r.body.includes(`${saidB} was said`), `${r.status}`);
  // B posting A's exact key must write B's own row, never overwrite A's.
  await http(B, "/api/ingest/notes", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ notes: [{ source_key: `dictation:ct-${run}-a`, at: new Date().toISOString(),
      source: "dictation", text: `overwritten by b` }] }) });
  const kept = await asUser(A.id, async (c) => (await c.query(
    `select text from notes where source_key=$1`, [`dictation:ct-${run}-a`])).rows[0]?.text);
  check("B reusing A's note key cannot touch A's note", kept === `${saidA} was said by a`, `${kept}`);
  const nB = await asUser(A.id, async (c) => (await c.query(
    `select count(*)::int n from notes where user_id=$1`, [B.id])).rows[0].n);
  check("RLS: A's context cannot select B's notes", nB === 0, `n=${nB}`);
  const nw = await asUser(A.id, async (c) => { try { await c.query(
    `insert into notes (user_id, source_key, at, source, text) values ($1,'x',now(),'dictation','x')`, [B.id]);
    return "inserted"; } catch { return "refused"; } });
  check("RLS: A cannot write a note as B", nw === "refused", nw);
  const nbare = await pool.query(`select count(*)::int n from notes`);
  check("no tenant context: zero notes (fails closed)", nbare.rows[0].n === 0, `n=${nbare.rows[0].n}`);

  // Underneath the routes: the database itself.
  const n = await asUser(A.id, async (c) => (await c.query(`select count(*)::int n from documents where id=$1`, [docB])).rows[0].n);
  check("RLS: A's context cannot select B's row", n === 0, `n=${n}`);
  const ev = await asUser(A.id, async (c) => { try { await c.query(`insert into document_events (user_id, document_id, kind) values ($1,$2,'opened')`, [B.id, docB]); return "inserted"; } catch (e) { return "refused"; } });
  check("RLS: A cannot write an event on B's document", ev === "refused", ev);
  const bare = await pool.query(`select count(*)::int n from documents`);
  check("no tenant context: zero rows (fails closed)", bare.rows[0].n === 0, `n=${bare.rows[0].n}`);
  // A credential that does not work is not the same as none: the bytes say
  // 401 rather than falling through to whoever is signed in on this host.
  const bad = await fetch(URL_ + `/d/${docB}/raw`, { headers: { authorization: "Bearer hq_garbage" } });
  check("a bad token is 401, never a fall-through", bad.status === 401, `${bad.status}`);
  // The page around them cannot answer 401 (it is a page). Since 28 Sep the
  // address answers for itself with the document door, so the guarantee is
  // that a person with no session gets the door and none of the content:
  // not the words, and not the title either, since B's page is private.
  const badPage = await fetch(URL_ + `/d/${docB}`, {
    headers: { authorization: "Bearer hq_garbage" }, redirect: "manual" });
  const badBody = await badPage.text();
  check("and its page is the door, with nothing of B's on it",
    badPage.status === 200 && badBody.includes("gate-modal") && !badBody.includes(wordB) && !badBody.includes(`ct ${B.name}`),
    `${badPage.status}`);
  // Safety review, 29 Sep: a device token is a machine's credential. It may
  // push and read; it may not act as the person on account pages (approve a
  // machine, revoke devices, billing), where only a browser session counts.
  for (const page of ["/devices", "/billing", "/connect"]) {
    const t = await fetch(URL_ + page, { headers: { authorization: `Bearer ${A.token}` }, redirect: "manual" });
    const tb = await t.text();
    check(`a device token is not a person on ${page}`, t.status !== 200 || !tb.includes("Revoke") && !tb.includes("autopay") && !tb.includes("Connect this"), `${t.status}`);
  }
  // A cookie-riding POST from another site is refused before it reaches a route.
  const xs = await fetch(URL_ + "/api/reads", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" , redirect: "manual" });
  check("a cross-site POST to the API is refused", xs.status === 403, `${xs.status}`);
  const fr = await fetch(URL_ + "/sign-in", { redirect: "manual" });
  check("the hub cannot be framed by another site", (fr.headers.get("x-frame-options") ?? "").toUpperCase() === "SAMEORIGIN", fr.headers.get("x-frame-options") ?? "none");
  // Daily push quotas (db/025). B's note budget is used up in one call to
  // the function; B's next push is refused whole, with a reason, and A is
  // untouched. B is a throwaway account, deleted at the end of the drill.
  const before = (await pool.query(`select used_count, limit_count from hq_quota_take($1, 'note', 0, 0)`, [B.id])).rows[0];
  const took = (await pool.query(`select ok from hq_quota_take($1, 'note', $2, 0)`, [B.id, before.limit_count - before.used_count])).rows[0].ok;
  check("a budget can be taken up to its limit", took === true, String(took));
  const q1 = await http(B, "/api/ingest/notes", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ notes: [{ source_key: `q-${run}`, at: new Date().toISOString(), source: "dictation", text: "over" }] }) });
  check("a push past the daily limit is refused with a reason", q1.status === 429 && q1.body.includes("daily limit"), `${q1.status} ${q1.body.slice(0, 80)}`);
  const q2 = (await pool.query(`select ok from hq_quota_take($1, 'note', 1, 0)`, [A.id])).rows[0].ok;
  check("and another account's budget is its own", q2 === true, String(q2));
  const none = await fetch(URL_ + `/api/since?since=1970-01-01T00:00:00Z`);
  check("no credential is 401", none.status === 401, `${none.status}`);

  // ------------------------------------------------------------ needs you
  //
  // One definition (28 Sep, db/027): a page asks when its own dark block says
  // what it needs; it stops when a person clears it. Opening is not answering.
  const page = async (u, slug, you) => {
    const html = `<!doctype html><html><head><title>ct ${u.name} ${slug}</title></head><body><h1>x</h1>${you}<p>body</p></body></html>`;
    const res = await http(u, "/api/ingest", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: `ct-${run}-${u.name}-session`, slug: `ct-${slug}`, title: `ct ${u.name} ${slug}`, html, device: "ct" }) });
    return JSON.parse(res.body).id;
  };
  const askWord = `asks${run}`;
  const docAsk = await page(A, `ask-${run}`, `<div class="you"><div class="k">Needs you &middot; one go</div>\n<p>Merge the ${askWord} change.</p></div>`);
  const docQuiet = await page(A, `quiet-${run}`, `<div class="you"><div class="k">Needs you &middot; nothing to decide</div>\n<p>It shipped.</p></div>`);
  const asksOf = async (doc) => asUser(A.id, async (c) => (await c.query(`select asks from documents where id = $1`, [doc])).rows[0]?.asks ?? null);
  check("a page that asks stores the sentence it asks", (await asksOf(docAsk)) === `Merge the ${askWord} change.`, String(await asksOf(docAsk)));
  check("a page that needs nothing stores nothing", (await asksOf(docQuiet)) === null, String(await asksOf(docQuiet)));
  r = await http(A, "/needs");
  check("A's /needs lists the page that asks, with its sentence", r.status === 200 && r.body.includes(docAsk) && r.body.includes(askWord), `${r.status}`);
  check("and not the page that needs nothing", !r.body.includes(docQuiet), "");
  r = await http(B, "/needs");
  check("B's /needs never shows A's", r.status === 200 && !r.body.includes(docAsk) && !r.body.includes(askWord), `${r.status}`);
  const needsA = async () => asUser(A.id, async (c) => (await c.query(
    `select coalesce(sum(n), 0)::int n from (select count(*) filter (where d.asks is not null and not exists (
        select 1 from document_events e where e.document_id = d.id and e.kind = 'cleared')) n
       from documents d join agents a on a.id = d.agent_id where a.source_session_id = $1) x`, [`ct-${run}-${A.name}-session`])).rows[0].n);
  check("A's agent counts one page needing A", await needsA() === 1, `n=${await needsA()}`);
  await asUser(A.id, (c) => c.query(`insert into document_events (user_id, document_id, kind) values ($1, $2, 'cleared')`, [A.id, docAsk]));
  r = await http(A, "/needs");
  check("cleared, it leaves /needs", r.status === 200 && !r.body.includes(docAsk), `${r.status}`);
  check("and the agent's count", await needsA() === 0, `n=${await needsA()}`);

  // ------------------------------------------------------------ teams
  //
  // Sharing v1 (27 Sep 2026). A team is a domain. A owns a page and shares it
  // to acme.test; C signs in with an address there, G with a Gmail
  // address. C reads it, G does not, B (another company) does not; ending
  // the share closes it for C; a link share opens it to G; private closes
  // it for everyone but A. Every step has a positive control first.
  const C = await mkUser("c"), G = await mkUser("g");
  await pool.query(`select hq_set_identity($1, $2, $3)`, [A.id, `a-${run}@alpha.test`, "alpha.test"]);
  await pool.query(`select hq_set_identity($1, $2, $3)`, [B.id, `b-${run}@other.test`, "other.test"]);
  await pool.query(`select hq_set_identity($1, $2, $3)`, [C.id, `c-${run}@acme.test`, "acme.test"]);
  await pool.query(`select hq_set_identity($1, $2, $3)`, [G.id, `g-${run}@gmail.com`, null]);
  const share = (u, to) => http(u, "/api/share", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ document_id: docA, to }) });

  r = await http(C, `/d/${docA}/raw`);
  check("before any share, C cannot read A's page", r.status === 404, `${r.status}`);
  r = await share(B, "acme.test");
  check("B cannot share A's page", r.status === 422 || r.status === 404, `${r.status}`);
  r = await share(A, "gmail.com");
  check("sharing to a public provider is refused, by name", r.status === 422 && r.body.includes("gmail.com"), `${r.status} ${r.body.slice(0, 80)}`);
  r = await share(A, "acme.test");
  check("A shares to acme.test", r.status === 200 && r.body.includes('"team"') && r.body.includes("acme.test"), `${r.status} ${r.body.slice(0, 100)}`);
  // Teams are addressed by id (28 Sep); the domain address forwards.
  const acme = (await pool.query(`select org_id from hq_my_teams($1) where domain = 'acme.test'`, [C.id])).rows[0]?.org_id;
  check("the team has an id", !!acme, String(acme));
  r = await http(C, `/d/${docA}/raw`);
  check("C at acme.test reads it", r.status === 200 && r.body.includes(wordA), `${r.status}`);
  r = await http(C, `/d/${docA}`);
  check("and the page around it is the reader's, not the owner's", r.status === 200 && !r.body.includes("Discuss") && r.body.includes("/raw"), `${r.status}`);
  r = await http(G, `/d/${docA}/raw`);
  check("G on gmail cannot", r.status === 404, `${r.status}`);
  r = await http(B, `/d/${docA}/raw`);
  check("B at other.test cannot", r.status === 404, `${r.status}`);
  r = await http(C, `/t/${acme}`);
  check("C's team page lists it", r.status === 200 && r.body.includes(docA), `${r.status}`);
  // Seam 2: search inside the team finds what was shared, and only that.
  r = await http(C, `/t/${acme}?q=${wordA}`);
  check("C can search the team and find A's page", r.status === 200 && r.body.includes(docA), `${r.status}`);
  r = await http(C, `/t/${acme}?q=${wordB}`);
  // The page echoes the query ("nothing matches bravo…"), which is not a leak;
  // B's id or B's sentence would be.
  check("team search never finds B's private page", r.status === 200 && !r.body.includes(docB) && !r.body.includes(`${wordB} belongs`), `${r.status}`);
  r = await http(G, `/t/${acme}?q=${wordA}`);
  check("G cannot search a team they are not in", r.status === 404, `${r.status}`);
  r = await http(G, `/t/${acme}`);
  check("G has no team page for acme.test", r.status === 404, `${r.status}`);
  r = await http(A, `/t/${acme}`);
  check("A, who shared here, sees the team page too", r.status === 200 && r.body.includes(docA), `${r.status}`);

  // Membership is rows (28 Sep, db/025). The domain rule still decides who
  // joins; the result is stored, follows a changed address, and reaches a
  // company that appears after its people signed in.
  r = await http(C, `/t/acme.test`);
  check("the domain address forwards to the team's id", [307, 308].includes(r.status) && r.location.endsWith(`/t/${acme}`), `${r.status} ${r.location}`);
  const isMember = async (u, org) => (await pool.query(`select hq_is_member($1, $2) m`, [u.id, org])).rows[0].m;
  check("C is a member of acme.test by a stored row", await isMember(C, acme) === true, "");
  check("A, who only shared there, is not", await isMember(A, acme) === false, "");
  await pool.query(`select hq_set_identity($1, $2, $3)`, [C.id, `c-${run}@elsewhere.test`, "elsewhere.test"]);
  check("C moves to another company and leaves acme.test", await isMember(C, acme) === false, "");
  r = await http(C, `/d/${docA}/raw`);
  check("and can no longer read its team page", r.status === 404, `${r.status}`);
  r = await http(C, `/t/${acme}`);
  check("nor open the team", r.status === 404, `${r.status}`);
  await pool.query(`select hq_set_identity($1, $2, $3)`, [C.id, `c-${run}@acme.test`, "acme.test"]);
  r = await http(C, `/d/${docA}/raw`);
  check("C comes back and reads it again", r.status === 200 && r.body.includes(wordA), `${r.status}`);
  const lateDomain = `late${run}.test`.toLowerCase();
  const D = await mkUser("d");
  await pool.query(`select hq_set_identity($1, $2, $3)`, [D.id, `d-${run}@${lateDomain}`, lateDomain]);
  const wordL = `lima${run}`;
  const docL = await ingest(A, wordL);
  r = await http(A, "/api/share", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ document_id: docL, to: lateDomain }) });
  check("A shares to a company nobody had shared to before", r.status === 200 && r.body.includes('"team"'), `${r.status} ${r.body.slice(0, 100)}`);
  r = await http(D, `/d/${docL}/raw`);
  check("D, who signed in there first, is a member the moment it appears", r.status === 200 && r.body.includes(wordL), `${r.status}`);
  r = await http(B, `/d/${docL}/raw`);
  check("and B still is not", r.status === 404, `${r.status}`);

  // The opens log (29 Sep, db/026). One open per visit, owner or reader,
  // readable only by the person who opened; the home's two lists come from
  // functions that never name who.
  const opensOf = async (u, doc) => asUser(u.id, async (c) => (await c.query(
    `select count(*)::int n from opens where user_id = $1 and document_id = $2`, [u.id, doc])).rows[0].n);
  r = await http(C, `/d/${docA}/raw`);
  r = await http(C, `/d/${docA}/raw`);
  check("C's views of A's page are one open, not one per reload", await opensOf(C, docA) === 1, `n=${await opensOf(C, docA)}`);
  const cSeesOthers = await asUser(A.id, async (c) => (await c.query(`select count(*)::int n from opens where user_id = $1`, [C.id])).rows[0].n);
  check("A cannot read C's opens", cSeesOthers === 0, `n=${cSeesOthers}`);
  await pool.query(`select hq_record_open($1, $2)`, [B.id, docA]);
  check("B cannot record an open of a page B may not read", await opensOf(B, docA) === 0, `n=${await opensOf(B, docA)}`);
  r = await http(A, `/d/${docA}/raw`);
  check("the owner's own view is an open too", await opensOf(A, docA) === 1, `n=${await opensOf(A, docA)}`);
  const recentC = (await pool.query(`select id from hq_recently_opened($1, 5)`, [C.id])).rows.map((x) => x.id);
  check("C's recently opened lists A's team page", recentC.includes(docA), JSON.stringify(recentC));
  const recentB = (await pool.query(`select id from hq_recently_opened($1, 5)`, [B.id])).rows.map((x) => x.id);
  check("B's never does", !recentB.includes(docA) && !recentB.includes(docL), JSON.stringify(recentB));
  const popA = (await pool.query(`select * from hq_popular($1, 7, 10)`, [A.id])).rows;
  const pa = popA.find((x) => x.id === docA);
  check("A's popular counts A's page, by number, from two people", !!pa && pa.opens === 2 && pa.openers === 2, JSON.stringify(pa ?? null));
  check("and names nobody", popA.every((x) => !JSON.stringify(x).includes(C.id)), "");
  const popB = (await pool.query(`select id from hq_popular($1, 7, 10)`, [B.id])).rows.map((x) => x.id);
  check("B's popular holds nothing of A's or acme's", !popB.includes(docA) && !popB.includes(docL), JSON.stringify(popB));

  // The outsider (audit 28 Sep, db/022). G, on gmail, shares a page of their
  // OWN to acme.test. That must show G their own page there and nothing
  // of anyone else's: not A's title, not A's words in a search, not a count
  // that includes A's page. Ending the share ends it. Before db/022 every
  // one of these leaked.
  const wordG = `golf${run}`;
  const docG = await ingest(G, wordG);
  const shareG = (to) => http(G, "/api/share", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ document_id: docG, to }) });
  r = await shareG("acme.test");
  check("G shares their own page to acme.test", r.status === 200 && r.body.includes('"team"'), `${r.status} ${r.body.slice(0, 100)}`);
  r = await http(G, `/t/${acme}`);
  check("G's team page lists G's own page", r.status === 200 && r.body.includes(docG), `${r.status}`);
  check("and never A's page", !r.body.includes(docA) && !r.body.includes(`ct ${A.name}`), `${r.status}`);
  r = await http(G, `/t/${acme}?q=${wordA}`);
  check("G's search of acme.test never finds A's words", r.status === 200 && !r.body.includes(docA) && !r.body.includes(`${wordA} belongs`), `${r.status}`);
  const gTeams = (await pool.query(`select domain, member, pages from hq_my_teams($1)`, [G.id])).rows;
  const gCof = gTeams.find((t) => t.domain === "acme.test");
  check("G's sidebar counts one page there, not two", !!gCof && gCof.member === false && gCof.pages === 1, JSON.stringify(gCof ?? null));
  const cCof = (await pool.query(`select pages from hq_my_teams($1) where domain = 'acme.test'`, [C.id])).rows[0];
  check("C, a member, counts both", cCof?.pages === 2, JSON.stringify(cCof ?? null));
  r = await http(C, `/t/${acme}`);
  check("and C's team page lists both", r.status === 200 && r.body.includes(docA) && r.body.includes(docG), `${r.status}`);
  r = await shareG("private");
  check("G ends the share", r.status === 200 && r.body.includes('"private"'), `${r.status}`);
  r = await http(G, `/t/${acme}`);
  check("and G has no team page for acme.test again", r.status === 404, `${r.status}`);
  const gDocs = (await pool.query(`select count(*)::int n from hq_team_documents($1, 'acme.test', 50)`, [G.id])).rows[0].n;
  check("nor any rows from the function directly", gDocs === 0, `n=${gDocs}`);
  const rd = await asUser(A.id, async (c) => (await c.query(`select count(*)::int n from reads where document_id=$1`, [docA])).rows[0].n);
  check("C's read is recorded for A", rd >= 1, `n=${rd}`);
  const rdC = await asUser(C.id, async (c) => (await c.query(`select count(*)::int n from reads where document_id=$1`, [docA])).rows[0].n);
  check("and C cannot see the reads table", rdC === 0, `n=${rdC}`);
  r = await share(A, "link");
  const linkRes = r;
  check("A shares by link", r.status === 200 && r.body.includes('"link"'), `${r.status} ${r.body.slice(0, 100)}`);
  r = await http(G, `/d/${docA}/raw`);
  check("now G, signed in, reads it", r.status === 200 && r.body.includes(wordA), `${r.status}`);
  r = await http(C, `/d/${docA}/raw`);
  check("a link share is not a team share: C still reads (link)", r.status === 200, `${r.status}`);
  r = await http(C, `/t/${acme}`);
  check("but the team page no longer lists it", r.status === 404 || !r.body.includes(docA), `${r.status}`);
  const anon = await fetch(URL_ + `/p/${docASlug}`, { redirect: "manual" });
  check("/p/<slug> without a session goes to the front door", anon.status === 307 && (anon.headers.get("location") ?? "").includes("/sign-in"), `${anon.status}`);
  const agree = await asUser(A.id, async (c) => (await c.query(`select visibility, (published_at is not null) as pub, public_slug is not null as slug from documents where id=$1`, [docA])).rows[0]);
  check("seam 1: link visibility and published_at agree", agree.visibility === "link" && agree.pub === true, JSON.stringify(agree));
  check("a link share mints no slug (29 Sep: /d/<id> is the address)", agree.slug === false, JSON.stringify(agree));
  check("and the API hands out /d/<id>", linkRes.body.includes(`/d/${docA}`) && !linkRes.body.includes("/p/"), linkRes.body.slice(0, 160));
  // Two accounts, one title (audit 28 Sep): link sharing used to mint a
  // slug under RLS and collide for ever with the other account's.
  const same = `same title ${run}`;
  const sameHtml = `<!doctype html><html><head><title>${same}</title></head><body><p>x</p></body></html>`;
  const pushSame = async (u) => JSON.parse((await http(u, "/api/ingest", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ session_id: `ct-${run}-${u.name}-same`, slug: "weekly-status", title: same, html: sameHtml + u.name, device: "ct" }) })).body).id;
  const sA = await pushSame(A), sB = await pushSame(B);
  const linkIt = (u, id) => http(u, "/api/share", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ document_id: id, to: "link" }) });
  const lA = await linkIt(A, sA), lB = await linkIt(B, sB);
  check("A and B both link-share a page called weekly-status", lA.status === 200 && lB.status === 200, `${lA.status} ${lB.status} ${lB.body.slice(0, 120)}`);
  check("each is handed its own /d address", lA.body.includes(`/d/${sA}`) && lB.body.includes(`/d/${sB}`), "");
  const taken = (await pool.query(`select hq_slug_taken('no-such-slug-${run}') as t`)).rows[0].t;
  check("hq_slug_taken answers across accounts, false for a free name", taken === false, String(taken));
  r = await share(A, "private");
  check("A makes it private", r.status === 200 && r.body.includes('"private"'), `${r.status}`);
  const agree2 = await asUser(A.id, async (c) => (await c.query(`select visibility, (published_at is null) as unpub, public_slug is not null as slug from documents where id=$1`, [docA])).rows[0]);
  check("seam 1: private clears published_at", agree2.visibility === "private" && agree2.unpub === true, JSON.stringify(agree2));
  r = await http(G, `/d/${docA}/raw`);
  check("G is out again", r.status === 404, `${r.status}`);
  r = await http(C, `/d/${docA}/raw`);
  check("and so is C", r.status === 404, `${r.status}`);
  r = await http(A, `/d/${docA}/raw`);
  check("A still reads their own page", r.status === 200 && r.body.includes(wordA), `${r.status}`);
  for (const u of [C, G, D]) await asUser(u.id, (c) => c.query(`delete from users where id=$1`, [u.id])).catch(() => {});
} finally {
  for (const u of [A, B]) await asUser(u.id, (c) => c.query(`delete from users where id=$1`, [u.id])).catch((e) => console.error("cleanup", u.name, e.message));
  await pool.end();
}
const w = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(w)}  ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed against ${URL_}`);
process.exit(failed ? 1 : 0);
