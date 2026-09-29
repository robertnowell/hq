import { pool } from "./db";

/**
 * A daily push budget, per account and kind (db/025). Taken before anything
 * is written: a call that would go over is refused whole, with a message a
 * person or an agent can act on, and a 429 the Mac mirror backs off from.
 */
export type QuotaKind = "document" | "turn" | "note" | "asset";

export async function takeQuota(userId: string, kind: QuotaKind, count: number, bytes: number): Promise<Response | null> {
  const { rows: [q] } = await pool.query(
    `select * from hq_quota_take($1, $2, $3, $4)`, [userId, kind, count, Math.max(0, Math.round(bytes))]);
  if (q.ok) return null;
  const mb = (n: number) => `${Math.round(Number(n) / 1e6)} MB`;
  return Response.json({
    error: "daily limit reached",
    detail: `This account has pushed ${q.used_count} ${kind}s (${mb(q.used_bytes)}) today, UTC; the daily limit is ${q.limit_count} ${kind}s and ${mb(q.limit_bytes)}. It resets at midnight UTC.`,
  }, { status: 429, headers: { "retry-after": String(secondsToUtcMidnight()) } });
}

function secondsToUtcMidnight(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}
