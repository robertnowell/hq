/**
 * Run the reconciliation the scheduler runs, on demand, and show what it saw.
 *
 * This deliberately does NOT reimplement the comparison. It calls the
 * deployed route, which is the same code the hourly check runs, and then
 * reads back the row it wrote. Two copies of a comparison drift, and drifting
 * copies of one truth is precisely the failure being checked for -- writing
 * it twice would be a poor joke.
 *
 * So a green run here means the SCHEDULED check works, not that some local
 * script does. That is the whole point: deployed is not exercised.
 *
 *   claude-secrets run --inject CRON_SECRET=CRON --inject HQ_DATABASE_URL=DBU \
 *     -- node scripts/reconcile-cash.mjs
 */
import pg from "pg";

const HUB = process.env.HUB ?? "https://hq.tranquilitybase.dev";
const money = (m) => `${BigInt(m) < 0n ? "-" : ""}$${(Math.abs(Number(BigInt(m))) / 1e6).toFixed(2)}`;

const r = await fetch(`${HUB}/api/cron/reconcile`, {
  headers: { authorization: `Bearer ${process.env.CRON}` },
});
const body = await r.json().catch(() => ({}));
if (!r.ok) {
  // Including "nothing_compared", which is a failure and not a quiet day.
  console.log(`the check could not run: ${r.status} ${JSON.stringify(body)}`);
  process.exit(1);
}
console.log(`${body.accounts} account(s), ${body.compared} movement(s) compared, ${body.agreed} agreed, ${body.tookMs}ms`);

const db = new pg.Client({ connectionString: process.env.DBU, ssl: { rejectUnauthorized: false } });
await db.connect();
const { rows: [row] } = await db.query(
  `select ran_at, window_days, compared, agreed, findings, took_ms
     from reconciliations order by ran_at desc limit 1`);
const { rows: history } = await db.query(
  `select date_trunc('hour', ran_at) at time zone 'UTC' as hour, count(*) runs,
          sum(case when jsonb_array_length(findings) > 0 then 1 else 0 end) unhappy
     from reconciliations where ran_at > now() - interval '24 hours'
    group by 1 order by 1 desc limit 6`);
await db.end();

if (!row) { console.log("nothing was recorded, which should not be possible"); process.exit(1); }
for (const f of row.findings) {
  console.log(`  !! ${f.userId.slice(0, 8)} ${f.said}`);
  console.log(`       ${f.key}  ledger holds ${f.ledgerMicros === null ? "nothing" : money(f.ledgerMicros)}`);
}
console.log(row.findings.length
  ? `\nFAILED: ${row.findings.length} disagreement(s), recorded at ${row.ran_at.toISOString()}`
  : `\nStripe and the ledger tell the same story (recorded ${row.ran_at.toISOString()})`);

// A gap in these rows means the check STOPPED, which no single run can show.
console.log("\nlast 24h:");
for (const h of history) {
  console.log(`  ${h.hour.toISOString().slice(0, 13)}h  ${h.runs} run(s)${Number(h.unhappy) ? `, ${h.unhappy} with findings` : ""}`);
}
process.exit(row.findings.length ? 1 : 0);
