/**
 * Every refund Stripe has, against every reversal the ledger has.
 *
 * A webhook that was never subscribed, or a delivery that was dropped for
 * days, leaves money refunded to a card and still spendable here. Nothing
 * else notices: the balance is simply too high, forever. This lists the
 * difference, and with --fix reverses what is missing under the same key the
 * webhook would have used, so a later delivery is still a no-op.
 */
import Stripe from "stripe";

const GATEWAY = process.env.GATEWAY;
if (!GATEWAY) { console.error("set GATEWAY to the gateway base URL"); process.exit(2); }
const USER = process.env.USER_ID;
if (!USER) { console.error("set USER_ID to the hub user the drill acts as"); process.exit(2); }
const CUSTOMER = process.env.CUSTOMER;
if (!CUSTOMER) { console.error("set CUSTOMER to the Stripe test customer id"); process.exit(2); }
const FIX = process.argv.includes("--fix");
const s = new Stripe(process.env.SK, { apiVersion: "2026-08-26.dahlia" });
const svc = { authorization: `Service ${process.env.SVC}`, "content-type": "application/json" };
const money = (m) => `$${(Number(BigInt(m)) / 1e6).toFixed(2)}`;

const r = await fetch(`${GATEWAY}/v1/service/accounts/${USER}/activity`, { headers: svc });
const known = new Set((await r.json()).entries.map(e => e.grantKey).filter(Boolean));

let missing = 0n;
for await (const charge of s.charges.list({ customer: CUSTOMER, limit: 100 })) {
  if (!charge.refunded && charge.amount_refunded === 0) continue;
  for await (const refund of s.refunds.list({ charge: charge.id, limit: 100 })) {
    const key = `stripe:refund:${refund.id}`;
    if (known.has(key)) continue;
    missing += BigInt(refund.amount) * 10_000n;
    console.log(`${FIX ? "reversing" : "unreversed"} ${money(BigInt(refund.amount) * 10_000n)} ${refund.id} (${charge.id})`);
    if (!FIX) continue;
    const put = await fetch(`${GATEWAY}/v1/service/reversals`, {
      method: "POST", headers: svc,
      body: JSON.stringify({ version: "1", userId: USER, reversalKey: key,
        micros: (BigInt(refund.amount) * 10_000n).toString() }),
    });
    if (!put.ok) throw new Error(`reversal ${put.status}`);
    const done = await put.json();
    console.log(`  took ${money(done.takenMicros)}${BigInt(done.shortMicros) > 0n ? `, ${money(done.shortMicros)} short` : ""}`);
  }
}
console.log(missing === 0n ? "every refund is reversed" :
  FIX ? `reversed ${money(missing)}` : `${money(missing)} refunded and still spendable -- re-run with --fix`);
