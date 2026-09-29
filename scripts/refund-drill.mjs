/**
 * Money given back, against the real Stripe and the real Gateway.
 *
 * Buys $10 on the saved card, refunds $5, then refunds the rest, and asserts
 * the ledger ends exactly where it started. The two halves are the point: a
 * partial refund followed by a full one is where a handler that reverses
 * Stripe's RUNNING TOTAL takes back $15 for a $10 charge, and no unit test
 * catches that because the shape of the second event is Stripe's, not ours.
 *
 * Balance alone cannot be the assertion: the person may be spending while
 * this runs. So it asserts on the ledger's own reversal lines, and reports
 * the balance drift separately rather than folding it into a pass.
 *
 *   claude-secrets run --inject STRIPE_TEST_SECRET_KEY=SK \
 *     --inject HQ_GATEWAY_SERVICE_TOKEN=SVC -- node scripts/refund-drill.mjs
 */
import Stripe from "stripe";

const GATEWAY = process.env.GATEWAY;
if (!GATEWAY) { console.error("set GATEWAY to the gateway base URL"); process.exit(2); }
const USER = process.env.USER_ID;
if (!USER) { console.error("set USER_ID to the hub user the drill acts as"); process.exit(2); }
const CUSTOMER = process.env.CUSTOMER;
if (!CUSTOMER) { console.error("set CUSTOMER to the Stripe test customer id"); process.exit(2); }
const s = new Stripe(process.env.SK, { apiVersion: "2026-08-26.dahlia" });

const money = (m) => `$${(Number(BigInt(m)) / 1e6).toFixed(2)}`;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const svc = { authorization: `Service ${process.env.SVC}` };

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
/** Webhooks are not synchronous. Wait for the LINE, not for a wall-clock guess. */
async function until(what, find, seconds = 90) {
  for (let i = 0; i < seconds; i++) {
    const hit = find(await activity());
    if (hit) return hit;
    await wait(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}
const line = (key) => (entries) => entries.find(e => e.grantKey === key);

const problems = [];
const check = (ok, said) => { console.log(`${ok ? "  ok " : "  !! "}${said}`); if (!ok) problems.push(said); };

const opening = await balance();
console.log(`balance ${money(opening)}`);

// 1. Buy $10 on the card already on file.
const pm = (await s.paymentMethods.list({ customer: CUSTOMER, type: "card", limit: 1 })).data[0];
if (!pm) throw new Error("no saved card to drill against");
const intent = await s.paymentIntents.create({
  amount: 1000, currency: "usd", customer: CUSTOMER, payment_method: pm.id,
  off_session: true, confirm: true, description: "refund drill",
}, { idempotencyKey: `refund-drill-${Date.now()}` });
console.log(`bought $10.00 (${intent.id}, ${intent.status})`);
const bought = await until("the credit", line(`stripe:${intent.id}`));
check(BigInt(bought.micros) === 10_000_000n, `credited ${money(bought.micros)}`);
const afterBuying = await balance();

// 2. Half of it back.
const charge = intent.latest_charge;
const first = await s.refunds.create({ charge, amount: 500 });
console.log(`refunded $5.00 (${first.id})`);
const backOnce = await until("the first reversal", line(`stripe:refund:${first.id}`));
check(BigInt(backOnce.micros) === -5_000_000n, `took back ${money(backOnce.micros)}`);
check(backOnce.kind === "refunded", `and it reads as "${backOnce.kind}" on the page`);

// 3. The rest. This is the half that a running-total key gets wrong.
const second = await s.refunds.create({ charge, amount: 500 });
console.log(`refunded the rest (${second.id})`);
const backTwice = await until("the second reversal", line(`stripe:refund:${second.id}`));
check(BigInt(backTwice.micros) === -5_000_000n, `took back ${money(backTwice.micros)}`);

// 4. Nothing else moved. Everything this charge touched, summed.
await wait(5000);   // a redelivery, if one is coming, arrives inside this
const mine = (await activity()).filter(e =>
  e.grantKey === `stripe:${intent.id}` || e.grantKey?.startsWith("stripe:refund:"));
const net = mine.reduce((t, e) => t + BigInt(e.micros), 0n);
check(net === 0n, `the whole episode nets to ${money(net)}`);

const closing = await balance();
const drift = closing - opening;
console.log(`balance ${money(opening)} -> ${money(afterBuying)} -> ${money(closing)}`);
if (drift !== 0n) console.log(`  (${money(drift)} of ordinary spending happened alongside this)`);

console.log(problems.length ? `\nFAILED: ${problems.length} assertion(s)` : "\nPASSED");
process.exit(problems.length ? 1 : 0);
