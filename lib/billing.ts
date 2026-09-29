import Stripe from "stripe";
import { asUser, pool } from "./db";

/**
 * Billing: the card, the rule, and the two calls to the Gateway.
 *
 * The split this file lives on: the hub owns the CARD and the POLICY, because
 * the card is entered here. The Gateway owns the LEDGER and holds no card, no
 * threshold and no consent flag. So nothing here is money — it is a rule about
 * money that lives somewhere else, and the worst a bug here can do is buy at
 * the wrong moment. It can never charge twice for one payment: that guarantee
 * is the ledger's UNIQUE (account_id, grant_key), keyed on the payment id.
 */

/** Cents, because that is what Stripe counts in. Micros, because that is what
 *  the ledger counts in. A million micros is a dollar; a cent is 10,000. */
export const centsToMicros = (cents: number) => BigInt(cents) * 10_000n;
export const microsToCents = (micros: bigint) => Number(micros / 10_000n);
export const money = (micros: bigint | string) =>
  `$${(Number(BigInt(micros)) / 1_000_000).toFixed(2)}`;

let client: Stripe | undefined;
export function stripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is not set; billing does not guess");
  // Pinned rather than floating: a processor that changes shape under a
  // running deployment is how a charge becomes a mystery.
  return (client ??= new Stripe(key, { apiVersion: "2026-08-26.dahlia" }));
}

export type Billing = {
  userId: string;
  customerId: string | null;
  card: { brand: string; last4: string; exp: string } | null;
  autopay: boolean;
  belowMicros: bigint;
  uptoMicros: bigint;
  pausedAt: Date | null;
  pausedReason: string | null;
};

/** The person's billing row, made on first sight with the ruled defaults. */
export async function billingFor(userId: string): Promise<Billing> {
  return asUser(userId, async (c) => {
    await c.query(
      `insert into billing (user_id) values ($1) on conflict (user_id) do nothing`,
      [userId],
    );
    const { rows: [r] } = await c.query(
      `select * from billing where user_id = $1`, [userId],
    );
    return {
      userId,
      customerId: r.stripe_customer_id,
      card: r.card_last4 ? { brand: r.card_brand, last4: r.card_last4, exp: r.card_exp } : null,
      autopay: r.autopay,
      belowMicros: BigInt(r.below_micros),
      uptoMicros: BigInt(r.upto_micros),
      pausedAt: r.paused_at,
      pausedReason: r.paused_reason,
    };
  });
}

// MARK: - the two calls to the Gateway
//
// Both carry the shared service secret rather than a person's token, because
// the caller is a service. They are the only two things this hub asks the
// Gateway about money, and neither one can be reached by a person's token.

function gatewayBase(): string {
  const base = process.env.HQ_GATEWAY_BASE;
  if (!base) throw new Error("HQ_GATEWAY_BASE is not set; billing does not guess");
  return base.replace(/\/+$/, "");
}

function serviceHeaders(): Record<string, string> {
  const token = process.env.HQ_GATEWAY_SERVICE_TOKEN;
  if (!token) throw new Error("HQ_GATEWAY_SERVICE_TOKEN is not set");
  return { authorization: `Service ${token}`, "content-type": "application/json" };
}

export async function gatewayBalance(userId: string): Promise<bigint> {
  const r = await fetch(`${gatewayBase()}/v1/service/accounts/${userId}/balance`, {
    headers: serviceHeaders(), cache: "no-store",
  });
  if (!r.ok) throw new Error(`gateway balance ${r.status}`);
  const body = await r.json();
  return BigInt(body.balance.availableMicros);
}

/**
 * Tell the Gateway money was bought.
 *
 * `grantKey` is derived from the PAYMENT, never from this request — one key
 * per payment for ever. That is what makes a redelivered webhook, an
 * out-of-order one, and a retry after a lost reply all credit exactly once,
 * without a state machine on this side.
 */
export async function creditGateway(userId: string, grantKey: string, micros: bigint) {
  const r = await fetch(`${gatewayBase()}/v1/service/credits`, {
    method: "POST", headers: serviceHeaders(),
    body: JSON.stringify({ version: "1", userId, grantKey, micros: micros.toString() }),
  });
  if (!r.ok) throw new Error(`gateway credit ${r.status}`);
  return r.json();
}

/**
 * Money given back: a refund, or a chargeback.
 *
 * The mirror of `creditGateway`, and deliberately not that call with a minus
 * sign — a reversal is its own record with its own key, so a refund delivered
 * twice takes back once. `shortMicros` comes back when the person had already
 * spent what is being refunded; that is a loss to us rather than a debt to
 * them, and it must not be retried.
 */
export async function reverseGateway(userId: string, reversalKey: string, micros: bigint) {
  const r = await fetch(`${gatewayBase()}/v1/service/reversals`, {
    method: "POST", headers: serviceHeaders(),
    body: JSON.stringify({ version: "1", userId, reversalKey, micros: micros.toString() }),
  });
  if (!r.ok) throw new Error(`gateway reversal ${r.status}`);
  return r.json() as Promise<{ takenMicros: string; shortMicros: string }>;
}

// MARK: - the two hosted pages
//
// We never render a card field. Both of these hand the person to Stripe and
// take them back, so no card number touches this app and its compliance is
// inherited rather than earned.

export async function fundsCheckout(b: Billing, cents: number, returnTo: string) {
  const s = stripe();
  const customer = b.customerId ?? (await s.customers.create({ metadata: { hqUserId: b.userId } })).id;
  if (!b.customerId) await saveCustomer(b.userId, customer);
  return s.checkout.sessions.create({
    mode: "payment",
    customer,
    // Kept for the next charge without asking again: this IS the consent to
    // top up, which is why adding funds and adding a card are one flow.
    payment_intent_data: { setup_future_usage: "off_session" },
    line_items: [{
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: cents,
        product_data: { name: "Tranquility Base credit" },
      },
    }],
    success_url: `${returnTo}?bought=1`,
    cancel_url: returnTo,
    metadata: { hqUserId: b.userId },
  });
}

export async function saveCustomer(userId: string, customerId: string) {
  await asUser(userId, (c) =>
    c.query(`update billing set stripe_customer_id = $2, updated_at = now() where user_id = $1`,
      [userId, customerId]));
}

/** What the card is, read back from Stripe after it is attached. We keep four
 *  digits and a brand so a page can say which card without holding one. */
export async function rememberCard(userId: string, customerId: string) {
  const s = stripe();
  const methods = await s.paymentMethods.list({ customer: customerId, type: "card", limit: 1 });
  const card = methods.data[0]?.card;
  await asUser(userId, (c) =>
    c.query(`update billing set card_brand = $2, card_last4 = $3, card_exp = $4,
             paused_at = null, paused_reason = null, updated_at = now() where user_id = $1`,
      [userId, card?.brand ?? null, card?.last4 ?? null,
       card ? `${String(card.exp_month).padStart(2, "0")}/${String(card.exp_year).slice(-2)}` : null]));
}

export async function saveRule(userId: string, belowMicros: bigint, uptoMicros: bigint) {
  if (uptoMicros <= belowMicros || belowMicros < 0n) throw new Error("the ceiling must be above the floor");
  // A top-up is a card charge: bounded here whatever the form sends.
  if (uptoMicros > 200_000_000n) throw new Error("the ceiling can be at most $200");
  await asUser(userId, (c) =>
    c.query(`update billing set below_micros = $2, upto_micros = $3, updated_at = now() where user_id = $1`,
      [userId, belowMicros.toString(), uptoMicros.toString()]));
}

export async function setAutopay(userId: string, on: boolean) {
  await asUser(userId, (c) =>
    c.query(`update billing set autopay = $2, paused_at = null, paused_reason = null,
             updated_at = now() where user_id = $1`, [userId, on]));
}

// MARK: - the scheduled check
//
// Cross-tenant on purpose, so it runs through security definer functions
// rather than under anybody's context, the same way the revocation feed does.

export async function autopayCandidates(): Promise<{ userId: string; below: bigint; upto: bigint }[]> {
  const { rows } = await pool.query(`select * from hq_autopay_candidates()`);
  return rows.map((r) => ({ userId: r.user_id, below: BigInt(r.below_micros), upto: BigInt(r.upto_micros) }));
}

/** Claim this person's top-up, or come away with nothing. The UPDATE inside is
 *  the lock, so two checks racing cannot both charge. */
export async function claimTopUp(userId: string) {
  const { rows: [r] } = await pool.query(`select * from hq_claim_topup($1)`, [userId]);
  return r ? { customerId: r.stripe_customer_id as string, upto: BigInt(r.upto_micros) } : null;
}

export async function finishTopUp(userId: string, ok: boolean, why?: string) {
  await pool.query(`select hq_finish_topup($1, $2, $3)`, [userId, ok, why ?? null]);
}

export async function userForCustomer(customerId: string): Promise<string | null> {
  const { rows: [r] } = await pool.query(`select hq_user_for_customer($1) as id`, [customerId]);
  return r?.id ?? null;
}
