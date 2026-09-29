/**
 * A chargeback, against the real Stripe.
 *
 * Buys $10 on a card Stripe disputes the moment it is charged, and asserts
 * three things: the credit comes back out of the ledger at once, the card is
 * paused so nothing else is bought on it, and the disputed line is readable
 * on the billing page. A dispute is not a refund -- the money is being pulled
 * from our account by the bank, and waiting for the dispute to RESOLVE would
 * leave somebody spending money that is already gone.
 *
 * It puts everything back afterwards: the dispute card is detached, the real
 * card is restored as the one on file, and the pause is lifted. That cleanup
 * runs even when an assertion fails, because a drill that leaves the owner's
 * billing paused is worse than no drill.
 *
 *   claude-secrets run --inject STRIPE_TEST_SECRET_KEY=SK \
 *     --inject HQ_GATEWAY_SERVICE_TOKEN=SVC --inject HQ_DATABASE_URL=DBU \
 *     -- node scripts/chargeback-drill.mjs
 */
import Stripe from "stripe";
import pg from "pg";

const GATEWAY = process.env.GATEWAY;
if (!GATEWAY) { console.error("set GATEWAY to the gateway base URL"); process.exit(2); }
const USER = process.env.USER_ID;
if (!USER) { console.error("set USER_ID to the hub user the drill acts as"); process.exit(2); }
const CUSTOMER = process.env.CUSTOMER;
if (!CUSTOMER) { console.error("set CUSTOMER to the Stripe test customer id"); process.exit(2); }
/** Stripe's fraudulent-dispute test card, 4000000000000259, as a token, so no
 *  card number is ever typed into anything of ours. */
const DISPUTED = "pm_card_createDispute";

const s = new Stripe(process.env.SK, { apiVersion: "2026-08-26.dahlia" });
const svc = { authorization: `Service ${process.env.SVC}` };
const db = new pg.Client({ connectionString: process.env.DBU, ssl: { rejectUnauthorized: false } });
const money = (m) => `$${(Number(BigInt(m)) / 1e6).toFixed(2)}`;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

const problems = [];
const check = (ok, said) => { console.log(`${ok ? "  ok " : "  !! "}${said}`); if (!ok) problems.push(said); };

async function balance() {
  const r = await fetch(`${GATEWAY}/v1/service/accounts/${USER}/balance`, { headers: svc });
  if (!r.ok) throw new Error(`balance ${r.status}`);
  return BigInt((await r.json()).balance.availableMicros);
}
async function activity() {
  const r = await fetch(`${GATEWAY}/v1/service/accounts/${USER}/activity`, { headers: svc });
  if (!r.ok) throw new Error(`activity ${r.status}`);
  return (await r.json()).entries;
}
async function until(what, get, seconds = 120) {
  for (let i = 0; i < seconds; i++) {
    const hit = await get();
    if (hit) return hit;
    await wait(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const billingRow = async () => {
  // Two statements, because a multi-command string cannot carry a parameter.
  await db.query("begin");
  await db.query(`select set_config('hq.user_id', $1, true)`, [USER]);
  const { rows: [r] } = await db.query(
    `select card_brand, card_last4, paused_at, paused_reason from billing where user_id = $1`, [USER]);
  await db.query("commit");
  return r;
};

await db.connect();
const opening = await balance();
const before = await billingRow();
console.log(`balance ${money(opening)}, card ${before.card_brand} ${before.card_last4}, ${before.paused_at ? "paused" : "not paused"}`);

let intent, dispute, attached;
try {
  // 1. A card that will be disputed the moment it is charged. Attaching the
  // TOKEN produces a payment method with an id of its own -- the token is not
  // that id, and detaching the token later silently does nothing, which is
  // how the first run of this drill left the disputed card on file.
  attached = (await s.paymentMethods.attach(DISPUTED, { customer: CUSTOMER })).id;
  intent = await s.paymentIntents.create({
    amount: 1000, currency: "usd", customer: CUSTOMER, payment_method: attached,
    off_session: true, confirm: true, description: "chargeback drill",
  }, { idempotencyKey: `chargeback-drill-${Date.now()}` });
  console.log(`bought $10.00 (${intent.id}, ${intent.status})`);

  const credited = await until("the credit",
    async () => (await activity()).find(e => e.grantKey === `stripe:${intent.id}`));
  check(BigInt(credited.micros) === 10_000_000n, `credited ${money(credited.micros)}`);

  // 2. Stripe raises the dispute on its own; we only have to see it.
  dispute = await until("Stripe to raise the dispute",
    async () => (await s.disputes.list({ charge: intent.latest_charge, limit: 1 })).data[0]);
  console.log(`disputed (${dispute.id}, ${dispute.reason})`);

  // 3. The credit comes back out, at once, keyed on the dispute.
  const back = await until("the reversal",
    async () => (await activity()).find(e => e.grantKey === `stripe:dispute:${dispute.id}`));
  check(BigInt(back.micros) === -10_000_000n, `took back ${money(back.micros)}`);
  check(back.kind === "refunded", `and it reads as "${back.kind}" on the page`);

  // 4. And nothing else is bought on that card until a human looks.
  const after = await until("the card to be paused", async () => {
    const r = await billingRow();
    return r.paused_at ? r : null;
  }, 60);
  check(!!after.paused_at, `card paused: "${after.paused_reason}"`);

  const closing = await balance();
  check(closing === opening, `balance ${money(opening)} -> ${money(closing)}`);
} catch (error) {
  problems.push(error.message);
  console.log(`  !! ${error.message}`);
} finally {
  // Put it all back, whatever happened above.
  console.log("restoring");
  if (attached) { try { await s.paymentMethods.detach(attached); } catch { /* already gone */ } }
  // Back to the card that was on file when this started, named rather than
  // inferred: "the most recent card" is what put the disputed one here.
  await db.query("begin");
  await db.query(`select set_config('hq.user_id', $1, true)`, [USER]);
  await db.query(
    `update billing set card_brand = $2, card_last4 = $3, paused_at = null,
       paused_reason = null, charging_since = null, updated_at = now() where user_id = $1`,
    [USER, before.card_brand, before.card_last4]);
  await db.query("commit");
  const now = await billingRow();
  console.log(`  card ${now.card_brand} ${now.card_last4}, ${now.paused_at ? "STILL PAUSED" : "not paused"}`);
  if (now.paused_at) problems.push("the drill left billing paused");
  await db.end();
}

console.log(problems.length ? `\nFAILED: ${problems.length} assertion(s)` : "\nPASSED");
process.exit(problems.length ? 1 : 0);
