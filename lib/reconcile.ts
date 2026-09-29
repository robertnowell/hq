import { pool } from "./db";
import { centsToMicros, stripe } from "./billing";

/**
 * Stripe's account of the money, against the ledger's.
 *
 * ONE implementation, called by the scheduled check and by the script. Two
 * copies of a comparison drift, and drifting copies of the same truth is the
 * exact failure this thing exists to catch -- it would be a poor joke to
 * write it twice.
 *
 * It READS. It never credits, reverses, refunds or pauses anything. Every
 * disagreement is reported with the identifier needed to chase it, because
 * "Stripe took money we never credited" is not a conclusion a scheduled job
 * should act on by itself.
 */

/** The four ways the two records can disagree, in the words a person would use. */
export type Finding = {
  userId: string;
  key: string;
  /** What Stripe says moved, in micros. Negative means money went back. */
  expectedMicros: string;
  /** What the ledger holds, or null when it holds nothing at all. */
  ledgerMicros: string | null;
  said: string;
};

export type Reconciliation = {
  windowDays: number;
  /** How many accounts had a card and were therefore worth comparing. */
  accounts: number;
  compared: number;
  agreed: number;
  findings: Finding[];
  tookMs: number;
};

/**
 * A check that checked nothing has not passed.
 *
 * The first scheduled run compared zero movements and reported that the two
 * records told the same story. They might have; it had not looked. `billing`
 * is under FORCE row level security and the job runs with no tenant context,
 * so an ordinary read returned an empty list and every loop below simply did
 * not execute. Nothing threw. Nothing was logged. It was a green tick over an
 * empty room.
 *
 * So emptiness is now a stated outcome rather than an absence of findings,
 * and the caller must treat it as a failure to run.
 */
export const lookedAtNothing = (r: Reconciliation) => r.accounts === 0 || r.compared === 0;

const money = (m: bigint) => `${m < 0n ? "-" : ""}$${(Math.abs(Number(m)) / 1e6).toFixed(2)}`;

function gateway(): { base: string; headers: Record<string, string> } {
  const base = process.env.HQ_GATEWAY_BASE?.replace(/\/+$/, "");
  const token = process.env.HQ_GATEWAY_SERVICE_TOKEN;
  if (!base || !token) throw new Error("the Gateway is not configured; reconciliation does not guess");
  return { base, headers: { authorization: `Service ${token}`, "content-type": "application/json" } };
}

/**
 * What the ledger holds under exactly these keys.
 *
 * Deliberately NOT the activity feed. That answers with the twenty most
 * recent movements, so a payment from last month reads as missing rather than
 * as old -- the first version of this reported eleven false alarms on an
 * account that had been verified by hand the day before. A reconciler that
 * cries wolf is worse than none, because the day it is right nobody looks.
 */
async function ledgerFor(userId: string, keys: string[]) {
  if (!keys.length) return { found: {} as Record<string, string>, missing: [] as string[], duplicated: [] as string[] };
  const { base, headers } = gateway();
  const r = await fetch(`${base}/v1/service/ledger/lookup`, {
    method: "POST", headers, cache: "no-store",
    body: JSON.stringify({ version: "1", userId, keys }),
  });
  if (!r.ok) throw new Error(`gateway lookup ${r.status}`);
  return r.json() as Promise<{ found: Record<string, string>; missing: string[]; duplicated?: string[] }>;
}

export async function reconcile(windowDays = 30, budgetMs = 45_000): Promise<Reconciliation> {
  const started = Date.now();
  const since = Math.floor(Date.now() / 1000) - windowDays * 86_400;
  const s = stripe();
  const findings: Finding[] = [];
  let compared = 0, agreed = 0;

  // A customer id is the only thing the two systems share, so people without
  // one cannot disagree about a payment: they have never made one.
  //
  // Through a security definer function, not a plain select: `billing` is
  // under FORCE row level security and this job has no tenant context, so a
  // direct read returns an empty list rather than an error. That is how the
  // first scheduled run passed while looking at nobody.
  const { rows: people } = await pool.query(`select * from hq_reconciliation_candidates()`);

  for (const { user_id: userId, stripe_customer_id: customer } of people) {
    // Time-boxed like the autopay check, and for the same reason: a run that
    // does not finish is not a failure, because the next one starts over and
    // nothing here changes faster than the gap between runs.
    if (Date.now() - started > budgetMs) break;

    const expect: Array<{ key: string; micros: bigint; said: (m: bigint, had: bigint | null) => string }> = [];
    for await (const intent of s.paymentIntents.list({ customer, limit: 100, created: { gte: since } })) {
      if (intent.status !== "succeeded" || !intent.amount_received) continue;
      expect.push({
        key: `stripe:${intent.id}`, micros: centsToMicros(intent.amount_received),
        said: (m, had) => had === null
          ? `took ${money(m)} and never credited it`
          : `took ${money(m)} but credited ${money(had)}`,
      });
      if (!intent.latest_charge) continue;
      for await (const refund of s.refunds.list({ charge: intent.latest_charge as string, limit: 100 })) {
        if (refund.status !== "succeeded" && refund.status !== "pending") continue;
        expect.push({
          key: `stripe:refund:${refund.id}`, micros: -centsToMicros(refund.amount),
          said: (m, had) => had === null
            ? `refunded ${money(-m)} and never took the credit back`
            : `refunded ${money(-m)} but reversed ${money(-had)}`,
        });
      }
    }
    for await (const dispute of s.disputes.list({ limit: 100, created: { gte: since } })) {
      const charge = typeof dispute.charge === "string" ? await s.charges.retrieve(dispute.charge) : null;
      if (charge?.customer !== customer) continue;
      expect.push({
        key: `stripe:dispute:${dispute.id}`, micros: -centsToMicros(dispute.amount),
        said: (m, had) => had === null
          ? `disputed ${money(-m)} and the credit is still here`
          : `disputed ${money(-m)} but reversed ${money(-had)}`,
      });
    }

    const answer = await ledgerFor(userId, expect.map(e => e.key));
    for (const e of expect) {
      compared++;
      const raw = answer.found[e.key];
      const had = raw === undefined ? null : BigInt(raw);
      if (had !== null && had === e.micros) { agreed++; continue; }
      findings.push({ userId, key: e.key, expectedMicros: e.micros.toString(),
        ledgerMicros: had === null ? null : had.toString(), said: e.said(e.micros, had) });
    }
    // One key, two ledger rows. Unreachable through the service, which is
    // precisely why it is worth saying out loud if it ever happens.
    for (const key of answer.duplicated ?? []) {
      findings.push({ userId, key, expectedMicros: "0", ledgerMicros: null,
        said: "written more than once in the ledger" });
    }
  }

  return { windowDays, accounts: people.length, compared, agreed, findings, tookMs: Date.now() - started };
}

export async function recordReconciliation(r: Reconciliation) {
  const { rows: [row] } = await pool.query(
    `select hq_record_reconciliation($1, $2, $3, $4::jsonb, $5) as id`,
    [r.windowDays, r.compared, r.agreed, JSON.stringify(r.findings), r.tookMs]);
  return row.id as string;
}
