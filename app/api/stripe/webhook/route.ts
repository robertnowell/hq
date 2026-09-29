import { NextResponse } from "next/server";
import { centsToMicros, creditGateway, finishTopUp, rememberCard, reverseGateway, stripe, userForCustomer } from "@/lib/billing";

export const runtime = "nodejs";          // the signature check needs the raw body
export const dynamic = "force-dynamic";

/**
 * What Stripe tells us, verified.
 *
 * Three things matter here and only three:
 *
 * 1. The signature. An unverified webhook is an open endpoint that credits
 *    accounts, so this fails closed on a missing secret rather than trusting
 *    the body.
 * 2. The grant key. It is the PAYMENT INTENT's id, never this request's, and
 *    that single choice is what makes duplicate, out-of-order and retried
 *    deliveries all credit exactly once — the Gateway's ledger has a UNIQUE
 *    on it. There is no idempotency table here because there does not need
 *    to be one.
 * 3. Returning 200 for things we do not act on. Stripe retries a non-2xx for
 *    days, and an event we have no opinion about is not a failure.
 */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.headers.get("stripe-signature");
  if (!secret || !signature) return NextResponse.json({ error: "unsigned" }, { status: 400 });

  let event;
  try {
    event = stripe().webhooks.constructEvent(await req.text(), signature, secret);
  } catch {
    // Deliberately terse: a forged body should learn nothing from the reply.
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }

  try {
    switch (event.type) {
      case "payment_intent.succeeded": {
        const intent = event.data.object;
        const customer = typeof intent.customer === "string" ? intent.customer : null;
        if (!customer) break;
        const userId = await userForCustomer(customer);
        if (!userId) break;               // a customer we do not know is not ours to credit
        // The payment is the key. Every delivery of this event, in any order,
        // any number of times, produces the same one.
        await creditGateway(userId, `stripe:${intent.id}`, centsToMicros(intent.amount_received));
        // A card that worked un-pauses the person, and is the card we show.
        await rememberCard(userId, customer);
        await finishTopUp(userId, true);
        break;
      }
      case "payment_intent.payment_failed": {
        const intent = event.data.object;
        const customer = typeof intent.customer === "string" ? intent.customer : null;
        const userId = customer ? await userForCustomer(customer) : null;
        if (!userId) break;
        // Paused, not retried. One attempt, then it waits for a human: the
        // alternative is a bank-fee spiral nobody asked for. Ruled 23 Sep.
        await finishTopUp(userId, false,
          intent.last_payment_error?.message ?? "the bank declined the payment");
        break;
      }
      case "charge.refunded": {
        const charge = event.data.object;
        const customer = typeof charge.customer === "string" ? charge.customer : null;
        const userId = customer ? await userForCustomer(customer) : null;
        if (!userId) break;
        // One reversal per REFUND, keyed on the refund's own id -- not on the
        // charge and its running total. Stripe sends this event again for
        // each partial refund carrying the cumulative `amount_refunded`, so
        // reversing that number would take $5 and then $10 back off a $10
        // charge. A refund object never changes its amount, which makes the
        // key idempotent and the amounts add up to exactly what was given
        // back. Listed from the API rather than read off the event, because
        // the embedded `refunds` may be truncated.
        const refunds = await stripe().refunds.list({ charge: charge.id, limit: 100 });
        for (const refund of refunds.data) {
          if (refund.status !== "succeeded" && refund.status !== "pending") continue;
          const back = await reverseGateway(userId,
            `stripe:refund:${refund.id}`, centsToMicros(refund.amount));
          // Money refunded after it was spent is a real loss, not an error,
          // and it is the sort of thing that should be visible rather than
          // implied.
          if (BigInt(back.shortMicros) > 0n) {
            console.warn("refund exceeded the balance", { refund: refund.id, shortMicros: back.shortMicros });
          }
        }
        break;
      }
      case "charge.dispute.created": {
        const dispute = event.data.object;
        const charge = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
        const customer = typeof dispute.payment_intent === "string" ? null : null;
        // A dispute names a charge, not a customer, so the charge is fetched
        // to find whose it was. A chargeback takes the credit back at once:
        // waiting for the dispute to resolve would let somebody spend money
        // that is already being pulled from our account.
        if (!charge) break;
        const full = await stripe().charges.retrieve(charge);
        const who = typeof full.customer === "string" ? await userForCustomer(full.customer) : null;
        if (!who) break;
        void customer;
        await reverseGateway(who, `stripe:dispute:${dispute.id}`, centsToMicros(dispute.amount));
        // And the card stops being used for anything else until a human looks.
        await finishTopUp(who, false, "a payment was disputed");
        break;
      }
      case "setup_intent.succeeded": {
        const setup = event.data.object;
        const customer = typeof setup.customer === "string" ? setup.customer : null;
        const userId = customer ? await userForCustomer(customer) : null;
        if (userId && customer) await rememberCard(userId, customer);
        break;
      }
    }
  } catch (error) {
    // Our own failure, not Stripe's: ask to be told again rather than losing
    // a payment somebody made.
    console.error("stripe webhook", event.type, (error as Error).message);
    return NextResponse.json({ error: "not handled" }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
