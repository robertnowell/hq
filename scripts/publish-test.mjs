#!/usr/bin/env node
// The link surface: what a stranger sees, and what a signed-in reader sees.
//
// Publishing itself is a click by one account, which a script cannot hold a
// session for, so this drill calls the same function that click calls
// (hq_set_visibility, since 27 Sep the one writer of link state) and then
// asks two questions: what does the open web see (a front door, nothing
// else), and what does a person who entered their email see (the page,
// stripped of anything that was only true on the author's Mac).
//
//   HQ_URL                where the app is      (default the production hub)
//   HQ_APP_DATABASE_URL   the app's own role    (from .env.local; RLS applies)
import { randomBytes, createHash } from "crypto";
import { readFileSync } from "fs";
import pg from "pg";

const URL_ = process.env.HQ_URL ?? "https://hq.tranquilitybase.dev";
let db = process.env.HQ_APP_DATABASE_URL;
if (!db) {
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  db = env.match(/^HQ_APP_DATABASE_URL=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
}
const pool = new pg.Pool({ connectionString: db, max: 3 });
const asUser = async (id, fn) => {
  const c = await pool.connect();
  try { await c.query(`begin; select set_config('hq.user_id', '${id}', true)`);
    const o = await fn(c); await c.query("commit"); return o; }
  catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
};

const run = randomBytes(4).toString("hex");
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  -- ${detail}` : ""}`);
  if (!ok) failed++;
};
const get = async (path, token = null) => {
  const r = await fetch(URL_ + path, { redirect: "manual",
    headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: await r.text(), headers: r.headers };
};
const mint = async (id) => {
  const token = "hq_" + randomBytes(32).toString("base64url");
  await asUser(id, (c) => c.query(
    `insert into device_tokens (user_id, name, token_sha256) values ($1, 'drill', $2)`,
    [id, createHash("sha256").update(token).digest("hex")]));
  return token;
};

const users = [];
try {
  const { rows } = await pool.query(`select * from hq_resolve_user($1)`, [`pub-${run}`]);
  const me = rows[0].id; users.push(me);
  // A device token, minted the way the app mints them, so the page can be
  // ingested through the real route and land in the bucket the real reader
  // fetches from. A row written straight into the table would have no bytes.
  const token = await mint(me);
  // A reader: another account, signed in (a device token stands in for the
  // browser session here), who was handed the link.
  const reader = (await pool.query(`select * from hq_resolve_user($1)`, [`pub-${run}-reader`])).rows[0].id;
  users.push(reader);
  const rtoken = await mint(reader);

  // A page with everything a published page must not leak: the stamped
  // footer, the author's home directory, and an app-scheme link.
  const slug = `drill-${run}`;
  const html = `<!doctype html><html><head><title>Drill ${run}</title></head><body>
<p>public body text ${run}</p>
<footer data-tb-agent="${run}">
  <a href="https://hq.tranquilitybase.dev/open?session=${run}">Open hub</a>
  <a href="tranquilitybase://discuss?session=${run}&ref=/Users/someone/Documents/agents/${run}/x.html">Discuss</a>
</footer></body></html>`;

  const ing = await fetch(`${URL_}/api/ingest`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ session_id: `pub-${run}-session`, slug, title: `Drill ${run}`,
                           html, device: "drill" }),
  });
  if (ing.status !== 201) throw new Error(`ingest: ${ing.status} ${(await ing.text()).slice(0, 200)}`);
  const doc = (await ing.json()).id;

  // Nothing is shared until somebody shares it: a signed-in reader gets 404.
  check("an unshared page is not at its address", (await get(`/p/${slug}`, rtoken)).status === 404);

  await pool.query(`select * from hq_set_visibility($1, $2, 'link', $3)`, [me, doc, slug]);

  // Since 27 Sep a link reader signs in: an email and a code. A stranger with
  // no session is sent to the front door and back; nothing is served to them.
  const stranger = await get(`/p/${slug}`);
  check("a shared page sends a stranger to the front door",
    stranger.status === 307 && (stranger.headers.get("location") ?? "").includes("/sign-in"), `${stranger.status}`);
  check("and serves them nothing", !stranger.body.includes(`public body text ${run}`));
  // Since 29 Sep /p forwards a signed-in reader to /d/<id>, the one address;
  // the reader's copy is served and cleaned there.
  const fwd = await get(`/p/${slug}`, rtoken);
  check("a signed-in reader of an old /p link is forwarded to /d/<id>",
    fwd.status === 308 && (fwd.headers.get("location") ?? "").endsWith(`/d/${doc}`), `${fwd.status} ${fwd.headers.get("location") ?? ""}`);
  const pub = await get(`/d/${doc}/raw`, rtoken);
  check("a signed-in reader gets the page", pub.status === 200, `${pub.status}`);
  check("it carries the page's own words", pub.body.includes(`public body text ${run}`));
  check("the stamped footer is gone", !pub.body.includes("data-tb-agent"));
  check("no local path is published", !pub.body.includes("/Users/"), "a home directory leaked");
  check("no app-scheme link survives", !pub.body.includes("tranquilitybase://"));
  // A shared page is a link somebody was handed, not a publication. The
  // indexed copy, where there is one, belongs to the connected site.
  check("crawlers are told to stay away",
    (pub.headers.get("x-robots-tag") ?? "").includes("noindex"),
    pub.headers.get("x-robots-tag") ?? "");
  const around = await get(`/d/${doc}`, rtoken);
  check("and the page around it says so itself", around.body.includes('noindex'));
  check("no canonical to somebody else's site",
    !pub.body.includes("rel=\"canonical\""),
    "this drill's user has no site connected, so there is nowhere to point");
  check("no shared cache may hold it: one reader, one session",
    (pub.headers.get("cache-control") ?? "").startsWith("private"),
    pub.headers.get("cache-control") ?? "");
  const rd = await asUser(me, (c) => c.query(`select count(*)::int n from reads where document_id = $1`, [doc]));
  check("the owner can see the read", rd.rows[0].n === 1, `n=${rd.rows[0].n}`);

  // The feed the personal site renders from. This drill's user has no site
  // connected, so its page must NOT be in it: sharing is for everybody and
  // landing on somebody's website is not.
  const feed = await get("/p/notes.json");
  const recs = JSON.parse(feed.body || "[]");
  check("a stranger's shared page is not in the site's feed",
    !recs.some((r) => r.slug === slug), `${feed.status}, ${recs.length} record(s)`);
  check("the feed is readable and well formed", feed.status === 200 && Array.isArray(recs));

  const robots = await get("/robots.txt");
  check("robots asks crawlers off the whole hub",
    robots.status === 200 && robots.body.includes("Disallow: /")
      && !robots.body.includes("Allow:"),
    robots.body.slice(0, 80));

  // The address is the only way in: a document id is not one.
  check("a document id is not a public address", (await get(`/p/${doc}`, rtoken)).status === 404);
  check("a made-up address is not a hint", (await get(`/p/${slug}-nope`, rtoken)).status === 404);
  // And the document's own address still serves a stranger nothing but the
  // door (since 28 Sep the door is on the address itself, not a redirect).
  const priv = await get(`/d/${doc}`);
  check("the private view still refuses a stranger",
    (priv.status === 200 && priv.body.includes("gate-modal") && !priv.body.includes(`public body text ${run}`)) || priv.status === 401 || priv.status === 307,
    `${priv.status}`);

  await pool.query(`select * from hq_set_visibility($1, $2, 'private', null)`, [me, doc]);
  check("making it private takes it off the web at once",
    (await get(`/p/${slug}`, rtoken)).status === 404);
  const afterFeed = JSON.parse((await get("/p/notes.json")).body || "[]");
  check("and out of the feed the site renders",
    !afterFeed.some((r) => r.slug === slug));
  const kept = await asUser(me, (c) => c.query(
    `select public_slug from documents where id = $1`, [doc]));
  check("the address is kept, so putting it back restores the link",
    kept.rows[0].public_slug === slug);
} finally {
  for (const id of users) {
    const gone = await asUser(id, (c) => c.query(`delete from users where id = $1`, [id]))
      .catch((e) => { console.error(`cleanup ${id}: ${e.message}`); return null; });
    if (gone && gone.rowCount !== 1) console.error(`cleanup ${id}: deleted ${gone.rowCount} rows`);
  }
  await pool.end();
}
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
