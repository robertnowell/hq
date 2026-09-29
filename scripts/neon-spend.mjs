/**
 * What each database costs, separately, inside one shared bill.
 *
 * One Neon org can hold several products' databases. One bill is fine; not
 * knowing which product spent it is not. Neon's
 * per-project consumption API is gated to Scale plans and answers 403 on
 * Launch -- but the ordinary project listing carries `cpu_used_sec` and
 * `synthetic_storage_size` per project, reset monthly, which is enough to
 * split the bill without paying for a bigger plan to be told.
 *
 * The numbers are month-to-date and the compute figure is an estimate: Neon
 * bills CU-hours, this reads CPU-seconds, and they coincide only while a
 * project runs at one compute unit. Both of ours do. It is a split of a bill,
 * not an invoice, and it is labelled that way rather than dressed up.
 *
 *   claude-secrets run --inject NEON_API_KEY=NK -- node scripts/neon-spend.mjs
 */
const ORG = process.env.NEON_ORG;
if (!ORG) { console.error("set NEON_ORG"); process.exit(2); }
const CU_HOUR = 0.106;        // Launch plan, neon.com/pricing, read 26 Sep 2026
const GB_MONTH = 0.35;
/** Which projects belong to which product. Anything unlisted is "other". */
// NEON_PROJECTS: "project-id=Product,project-id=Product".
const OURS = Object.fromEntries((process.env.NEON_PROJECTS ?? "").split(",").filter(Boolean).map((e) => e.split("=")));

const r = await fetch(`https://console.neon.tech/api/v2/projects?org_id=${ORG}&limit=100`, {
  headers: { authorization: `Bearer ${process.env.NK}` },
});
if (!r.ok) { console.error(`neon ${r.status}`); process.exit(1); }
const { projects } = await r.json();

const usd = (n) => `$${n.toFixed(2)}`;
const rows = projects.map(p => {
  const hours = (p.cpu_used_sec ?? 0) / 3600;
  const gb = (p.synthetic_storage_size ?? 0) / 1073741824;
  return { name: p.name, id: p.id, who: OURS[p.id] ?? "other",
           hours, gb, cost: hours * CU_HOUR + gb * GB_MONTH };
}).sort((a, b) => b.cost - a.cost);

console.log(`month to date, org ${ORG}\n`);
console.log("project".padEnd(22) + "owner".padEnd(18) + "CU-h".padStart(8) + "storage".padStart(10) + "cost".padStart(10));
for (const x of rows) {
  console.log(x.name.padEnd(22) + x.who.padEnd(18) +
    x.hours.toFixed(1).padStart(8) + `${x.gb.toFixed(2)} GB`.padStart(10) + usd(x.cost).padStart(10));
}
const by = {};
for (const x of rows) by[x.who] = (by[x.who] ?? 0) + x.cost;
console.log();
for (const [who, cost] of Object.entries(by).sort((a, b) => b[1] - a[1])) {
  console.log(`${who.padEnd(40)} ${usd(cost).padStart(10)}`);
}
console.log(`${"TOTAL".padEnd(40)} ${usd(Object.values(by).reduce((a, b) => a + b, 0)).padStart(10)}`);
console.log(`\ncompute estimated from CPU-seconds at ${usd(CU_HOUR)}/CU-hour; storage at ${usd(GB_MONTH)}/GB-month.`);
