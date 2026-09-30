// Drill: a connected Mac signs its Hub window in (POST /api/devices/web-session).
//
// Ruled 30 Sep 2026: the Mac app and the hub are one account. This proves the
// route hands a one-time sign-in ticket ONLY to a paired device that also
// proves possession of its key, and that the ticket really signs a browser in
// as that person.
//
// Creates a throwaway Clerk user (on the instance CLERK_SECRET_KEY belongs to,
// which must be the one the server under test uses), a hub user and a paired
// device with its own P-256 key; deletes them at the end. Exit 0 is the only
// pass.
//
// Run it against a BUILT server (next build, next start): under next dev,
// the first compile of a page can hot-reload it mid sign-in and drop the
// ticket, which production never does.
//
//   HQ_URL=http://localhost:3199 HQ_APP_DATABASE_URL=… CLERK_SECRET_KEY=sk_… \
//     node scripts/web-session-test.mjs
import { createHash, randomBytes } from "node:crypto";
import pg from "pg";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

const URL_ = process.env.HQ_URL ?? "http://localhost:3199";
const ISSUER = process.env.HQ_GATEWAY_ISSUER ?? "https://hq.tranquilitybase.dev";
const CK = process.env.CLERK_SECRET_KEY;
if (!process.env.HQ_APP_DATABASE_URL || !CK) { console.error("need HQ_APP_DATABASE_URL and CLERK_SECRET_KEY"); process.exit(2); }
const pool = new pg.Pool({ connectionString: process.env.HQ_APP_DATABASE_URL, max: 3 });
const asUser = async (id, fn) => {
  const c = await pool.connect();
  try {
    await c.query(`begin; select set_config('hq.user_id', '${id}', true)`);
    const out = await fn(c); await c.query("commit"); return out;
  } catch (e) { await c.query("rollback"); throw e; } finally { c.release(); }
};
const clerk = (path, init = {}) => fetch(`https://api.clerk.com/v1${path}`, {
  ...init, headers: { authorization: `Bearer ${CK}`, "content-type": "application/json", ...(init.headers ?? {}) },
});
const hash = (s) => createHash("sha256").update(s).digest("hex");
const run = randomBytes(4).toString("hex");
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  -- ${detail}` : ""}`);
  if (!ok) failed++;
};

// A DPoP proof exactly as the Mac makes one (DeviceKey.proof).
const ROUTE = "/api/devices/web-session";
const proof = async (key, { htu = new URL(ROUTE, ISSUER).toString(), htm = "POST", iat } = {}) => {
  const jwk = await exportJWK(key.publicKey);
  return new SignJWT({ jti: randomBytes(16).toString("hex"), htm, htu, ...(iat ? { iat } : {}) })
    .setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y } })
    .setIssuedAt(iat).sign(key.privateKey);
};
const ask = (headers = {}, body = {}) => fetch(`${URL_}${ROUTE}`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

let clerkId = null, hubUser = null;
try {
  // A real person on the Clerk instance, and their hub row.
  const made = await clerk("/users", { method: "POST", body: JSON.stringify({
    email_address: [`web-session-${run}+clerk_test@example.com`], skip_password_requirement: true,
  }) });
  const u = await made.json();
  if (!made.ok) throw new Error(`clerk user: ${JSON.stringify(u).slice(0, 300)}`);
  clerkId = u.id;
  hubUser = (await pool.query(`select id from hq_identity($1)`, [clerkId])).rows[0].id;

  // Pair a device the way a Mac does: approve a code, then collect it with a key.
  const key = await generateKeyPair("ES256", { extractable: true });
  const pub = await exportJWK(key.publicKey);
  const code = randomBytes(32).toString("base64url");
  await asUser(hubUser, (c) => c.query(
    `insert into device_claims (code_sha256, user_id, device_name, expires_at)
     values ($1, $2, $3, now() + interval '10 minutes')`, [hash(code), hubUser, `drill-${run}`]));
  const claimed = await fetch(`${URL_}/api/devices/claim`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, key: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y } }),
  });
  const { token } = await claimed.json();
  check("the device pairs with its key", claimed.status === 200 && !!token);
  const bearer = { authorization: `Bearer ${token}` };

  // Refusals: every missing or wrong half.
  check("no credential: 401", (await ask()).status === 401);
  check("a garbage token: 401", (await ask({ authorization: "Bearer hq_nope" })).status === 401);
  check("token without a proof: 401", (await ask(bearer)).status === 401);
  const other = await generateKeyPair("ES256", { extractable: true });
  check("token with another key's proof: 401", (await ask({ ...bearer, dpop: await proof(other) })).status === 401);
  check("proof for another route: 401",
    (await ask({ ...bearer, dpop: await proof(key, { htu: new URL("/api/gateway/token", ISSUER).toString() }) })).status === 401);
  check("stale proof: 401",
    (await ask({ ...bearer, dpop: await proof(key, { iat: Math.floor(Date.now() / 1000) - 600 }) })).status === 401);
  const cookieOnly = await fetch(`${URL_}${ROUTE}`, { method: "POST", headers: { "content-type": "application/json", cookie: "__session=x" }, body: "{}" });
  check("a browser cookie alone: 401", cookieOnly.status === 401);

  // The real thing.
  const ok = await ask({ ...bearer, dpop: await proof(key) }, { next: "/shipping" });
  const got = await ok.json().catch(() => ({}));
  const ticketUrl = got.url ? new URL(got.url) : null;
  check("token plus its own key's proof: 200 with a ticket",
    ok.status === 200 && !!ticketUrl?.searchParams.get("__clerk_ticket"), JSON.stringify(got).slice(0, 200));
  check("it lands where asked", ticketUrl?.searchParams.get("redirect_url") === "/shipping");
  check("the ticket is not cached", ok.headers.get("cache-control") === "no-store");

  const evil = await (await ask({ ...bearer, dpop: await proof(key) }, { next: "//evil.example/x" })).json();
  check("a redirect off the hub is refused (lands on /)", new URL(evil.url).searchParams.get("redirect_url") === "/");
  const slash = await (await ask({ ...bearer, dpop: await proof(key) }, { next: "/\\evil.example/x" })).json();
  check("a backslash redirect is refused too (lands on /)", new URL(slash.url).searchParams.get("redirect_url") === "/");

  // The ticket signs a browser in as exactly this person.
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await (await browser.newContext()).newPage();
    if (process.env.DRILL_TRACE) {
      page.on("console", (m) => console.log("  console:", m.type(), m.text().slice(0, 200)));
      page.on("response", async (r) => {
        const u = r.url();
        if (/clerk|sign-in|shipping/.test(u)) console.log("  http:", r.status(), r.request().method(), u.replace(/__clerk_ticket=[^&]+/, "__clerk_ticket=…").slice(0, 160));
      });
    }
    const local = new URL(ticketUrl.pathname + ticketUrl.search, URL_).toString();
    // A Clerk DEVELOPMENT instance does a browser handshake on a fresh
    // context's first visit and can drop the ticket during it; production
    // does not. Settle the handshake first, as the Hub window's first load
    // already has by the time it asks for a ticket.
    await page.goto(new URL("/sign-in", URL_).toString(), { waitUntil: "networkidle", timeout: 60_000 });
    // Minted now, as the app does once its window has loaded: a ticket lives
    // sixty seconds, and a dev server's first compile can use most of that.
    const fresh = new URL((await (await ask({ ...bearer, dpop: await proof(key) }, { next: "/shipping" })).json()).url);
    const local2 = new URL(fresh.pathname + fresh.search, URL_).toString();
    await page.goto(local2, { waitUntil: "load", timeout: 60_000 });
    await page.waitForURL((u) => u.pathname === "/shipping", { timeout: 45_000 }).catch(() => {});
    await page.waitForFunction(() => window.Clerk?.loaded && window.Clerk.user, null, { timeout: 15_000 }).catch(() => {});
    const signedInAs = await page.evaluate(() => window.Clerk?.user?.id ?? null);
    check("the ticket signs the browser in as that person", signedInAs === clerkId,
      `got ${signedInAs} at ${page.url()}: ${(await page.evaluate(() => document.body.innerText)).slice(0, 200).replace(/\s+/g, " ")}`);
    const again = await (await browser.newContext()).newPage();
    await again.goto(new URL("/sign-in", URL_).toString(), { waitUntil: "networkidle", timeout: 60_000 });
    await again.goto(local2, { waitUntil: "networkidle", timeout: 60_000 });
    await again.waitForTimeout(4000);
    const second = await again.evaluate(() => window.Clerk?.user?.id ?? null);
    check("the same ticket does not work twice", second === null, `got ${second}`);
  } finally { await browser.close(); }
} catch (e) {
  console.log("FAIL  drill crashed --", e.message); failed++;
} finally {
  if (hubUser) {
    await pool.query(`delete from device_tokens where user_id = $1`, [hubUser]).catch(() => {});
    await pool.query(`delete from device_claims where user_id = $1`, [hubUser]).catch(() => {});
    await pool.query(`delete from users where id = $1`, [hubUser]).catch((e) => console.log("note: hub user left:", e.message));
  }
  if (clerkId) await clerk(`/users/${clerkId}`, { method: "DELETE" }).catch(() => {});
  await pool.end();
}
console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
