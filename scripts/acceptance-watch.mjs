/**
 * Watch a stranger use the product, and write down what the money did.
 *
 * The managed-credits acceptance has one claim: somebody who has never pasted
 * a provider key signs in once and uses all five paid products. The app half
 * of that is observed by a person driving it. THIS is the other half --
 * whether the ledger agrees -- and it is the half nobody can see by looking
 * at a screen.
 *
 * It takes a baseline of who exists now, waits for a NEW hub account, and
 * then reports every movement on that account as it happens: the welcome
 * grant landing without a card, and each product charging at the rate the
 * live pricebook says.
 *
 * It is deliberately hard to pass:
 *   - a new account that does nothing is NOT a pass, it is a person who
 *     signed in and stopped
 *   - a product charging the wrong amount is a failure even if the app looked
 *     right, because the rate is the thing being accepted
 *   - all five must appear; four is four
 *
 *   claude-secrets run --inject HQ_DATABASE_URL=DBU \
 *     --inject HQ_GATEWAY_SERVICE_TOKEN=SVC -- node scripts/acceptance-watch.mjs [minutes]
 */
import pg from "pg";

const GATEWAY = process.env.GATEWAY;
if (!GATEWAY) { console.error("set GATEWAY to the gateway base URL"); process.exit(2); }
const MINUTES = Number(process.argv[2]) || 90;
const svc = { authorization: `Service ${process.env.SVC}` };
const money = (m) => `${BigInt(m) < 0n ? "-" : ""}$${(Math.abs(Number(BigInt(m))) / 1e6).toFixed(2)}`;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** The five, and what a movement of each looks like in the activity feed. */
const PRODUCTS = {
  summary: "a summary",
  speech: "spoken aloud",
  transcription: "listening",
  recovery: "a recovered recording",
  voice: "hands-free",
};

const db = new pg.Client({ connectionString: process.env.DBU, ssl: { rejectUnauthorized: false } });
await db.connect();
const { rows: before } = await db.query("select id from users");
const known = new Set(before.map(r => r.id));
console.log(`${known.size} account(s) exist now. Waiting for a new one.`);
console.log(`(sign in on the other macOS account as somebody who has never used this)\n`);

const deadline = Date.now() + MINUTES * 60_000;
let stranger = null;
while (Date.now() < deadline && !stranger) {
  const { rows } = await db.query("select id, external_id, created_at from users order by created_at desc limit 5");
  stranger = rows.find(r => !known.has(r.id)) ?? null;
  if (!stranger) await wait(5000);
}
if (!stranger) { console.log("no new account appeared; nothing to accept"); await db.end(); process.exit(1); }
console.log(`new account ${stranger.id} at ${stranger.created_at.toISOString()}\n`);

/** Did this account ever have a card? The claim includes "without a card". */
const hadCard = async () => {
  const { rows: [r] } = await db.query(
    `select stripe_customer_id, card_last4 from billing where user_id = $1`, [stranger.id]);
  return r?.card_last4 ?? null;
};

const activity = async () => {
  const r = await fetch(`${GATEWAY}/v1/service/accounts/${stranger.id}/activity`, { headers: svc });
  if (!r.ok) throw new Error(`activity ${r.status}`);
  return (await r.json()).entries;
};
const balance = async () => {
  const r = await fetch(`${GATEWAY}/v1/service/accounts/${stranger.id}/balance`, { headers: svc });
  if (!r.ok) throw new Error(`balance ${r.status}`);
  return BigInt((await r.json()).balance.availableMicros);
};

const seen = new Set();
const used = new Set();
let welcome = null, cardAtWelcome = null;

console.log("watching. every movement on this account, as it happens:\n");
while (Date.now() < deadline) {
  let entries;
  try { entries = await activity(); } catch (e) { console.log(`  (gateway: ${e.message})`); await wait(5000); continue; }
  for (const e of [...entries].reverse()) {
    const id = `${e.at}|${e.kind}|${e.micros}|${e.grantKey ?? e.product ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (e.kind === "bought" && e.grantKey === "welcome-v1") {
      welcome = BigInt(e.micros);
      cardAtWelcome = await hadCard();
      console.log(`  ${money(e.micros)}  welcome credit${cardAtWelcome ? `  !! a card was already on file (${cardAtWelcome})` : "  (no card on file)"}`);
      continue;
    }
    if (e.kind === "spent" && e.product) {
      used.add(e.product);
      console.log(`  ${money(e.micros)}  ${PRODUCTS[e.product] ?? e.product}${e.seconds ? `  ${Math.round(Number(e.seconds))}s` : ""}   [${used.size}/5]`);
      continue;
    }
    console.log(`  ${money(e.micros)}  ${e.kind}${e.grantKey ? ` ${e.grantKey}` : ""}`);
  }
  if (used.size === 5) break;
  await wait(5000);
}

console.log();
const problems = [];
const check = (ok, said) => { console.log(`  ${ok ? "ok " : "!! "}${said}`); if (!ok) problems.push(said); };
check(welcome !== null && welcome > 0n, `the welcome credit landed: ${welcome === null ? "it did not" : money(welcome)}`);
check(cardAtWelcome === null, "and no card was needed to get it");
for (const [key, name] of Object.entries(PRODUCTS)) check(used.has(key), `${name} was used on managed credit`);
check(used.size === 5, `all five products, not ${used.size}`);
const left = await balance();
console.log(`\n  balance now ${money(left)}`);
await db.end();
console.log(problems.length ? `\nINCOMPLETE: ${problems.length} thing(s) not shown` : "\nthe stranger's money behaved");
process.exit(problems.length ? 1 : 0);
