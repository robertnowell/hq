import { sameSecret } from "@/lib/pairing";
import { NextResponse } from "next/server";
import {
  autopayCandidates, claimTopUp, finishTopUp, gatewayBalance, microsToCents, stripe,
} from "@/lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The check that keeps people topped up.
 *
 * It decides, and it charges. It does NOT credit: the webhook does that, from
 * Stripe's own account of what happened. That division is the point. If this
 * route both charged and credited, a crash between the two would leave money
 * taken and no credit given, and the only record of it would be a log line.
 * As it stands the worst crash here loses a decision, and a decision is free
 * to make again five minutes later.
 *
 * Stripe's own idempotency key is derived from the person and the minute, so
 * two overlapping runs cannot become two charges even if the database lock
 * below were somehow lost.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const offered = req.headers.get("authorization");
  if (!secret || !sameSecret(offered ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "auth_required" }, { status: 401 });
  }

  const started = Date.now();
  const seen = { checked: 0, low: 0, charged: 0, declined: 0, skipped: 0 };

  for (const person of await autopayCandidates()) {
    // Time-boxed on purpose. A run that does not finish is not a failure --
    // the next one picks up whoever was missed, and nobody's balance changes
    // faster than the gap between runs.
    if (Date.now() - started > 45_000) break;
    seen.checked++;

    let balance: bigint;
    try {
      balance = await gatewayBalance(person.userId);
    } catch {
      // The Gateway being unreachable is not a reason to buy anything. It is
      // a reason to do nothing and look again next time.
      seen.skipped++;
      continue;
    }
    if (balance >= person.below) continue;
    seen.low++;

    // Claim, or come away with nothing. The UPDATE inside is the lock, so two
    // runs racing cannot both charge this person.
    const claim = await claimTopUp(person.userId);
    if (!claim) { seen.skipped++; continue; }

    // A ceiling, not an increment: buy the gap between here and the rule.
    const cents = microsToCents(claim.upto - balance);
    if (cents < 50) {                     // below Stripe's own minimum charge
      await finishTopUp(person.userId, true);
      seen.skipped++;
      continue;
    }

    try {
      const s = stripe();
      const methods = await s.paymentMethods.list({ customer: claim.customerId, type: "card", limit: 1 });
      const card = methods.data[0];
      if (!card) throw new Error("no card on file");
      await s.paymentIntents.create({
        amount: cents,
        currency: "usd",
        customer: claim.customerId,
        payment_method: card.id,
        // Nobody is at a browser: this is the charge a person consented to
        // when they put the card in, made while they are asleep.
        off_session: true,
        confirm: true,
        description: "Tranquility Base credit",
        // So the webhook can tell an unattended top-up from a charge somebody
        // made at a browser. The first of these is announced by email; a
        // checkout the person just completed needs no announcing.
        metadata: { autopay: "1" },
      }, {
        // Belt and braces beside the database lock: the same person in the
        // same minute is the same charge to Stripe, whatever we do.
        idempotencyKey: `topup:${person.userId}:${Math.floor(Date.now() / 60_000)}`,
      });
      // Not marked done here. The webhook credits and clears the claim, from
      // Stripe's account rather than ours.
      seen.charged++;
    } catch (error) {
      // Paused, not retried. One attempt, then it waits for a human.
      const why = (error as { message?: string }).message ?? "the payment could not be taken";
      await finishTopUp(person.userId, false, why);
      seen.declined++;
    }
  }

  // No user ids, no amounts, no card details: enough to know it ran and what
  // it did, and nothing that would be a leak in a log aggregator.
  return NextResponse.json({ ...seen, ms: Date.now() - started });
}
