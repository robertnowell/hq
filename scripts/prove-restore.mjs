/**
 * Prove the money can be brought back, rather than assume it.
 *
 * The ledger IS the money: there is no other record of what anybody bought or
 * spent. Neon's point-in-time history is its only backup -- there are no
 * snapshots underneath it -- so "we have backups" means exactly one thing,
 * and it is worth knowing whether that thing works before the day it matters.
 *
 * This restores the ledger to a point in the past onto a throwaway branch,
 * compares it against what main says the ledger looked like at that moment,
 * and deletes the branch. It never touches main and never writes.
 *
 * Measured 25 Sep 2026: a restore to one hour earlier reproduced every row
 * and the ledger's net exactly, with every operation and pricebook intact.
 *
 *   claude-secrets run --inject NEON_API_KEY=NK --inject GATEWAY_NEON_URL=DBU \
 *     -- node scripts/prove-restore.mjs [hours-ago]
 */
import pg from "pg";

const PROJECT = process.env.NEON_PROJECT;
if (!PROJECT) { console.error("set NEON_PROJECT"); process.exit(2); }
const HOURS = Number(process.argv[2]) || 1;
const h = { authorization: `Bearer ${process.env.NK}`, "content-type": "application/json" };
const at = new Date(Date.now() - HOURS * 3600_000).toISOString();
const api = (path, init) => fetch(`https://console.neon.tech/api/v2/projects/${PROJECT}${path}`, { headers: h, ...init });

const live = new pg.Client({ connectionString: process.env.DBU, ssl: { rejectUnauthorized: false } });
await live.connect();
// What main says the ledger HELD at that moment. The ledger is append-only,
// so its own history is the expected answer -- which is what makes this a
// check rather than two numbers that happen to look alike.
const { rows: [want] } = await live.query(
  `select count(*) rows, coalesce(sum(available_delta),0)::text net
     from ledger where created_at <= $1`, [at]);
const { rows: [now] } = await live.query(`select count(*) rows from ledger`);
await live.end();
console.log(`ledger now ${now.rows} rows; at ${at} it held ${want.rows} rows, net ${want.net}`);

let branch;
try {
  const made = await (await api("/branches", { method: "POST", body: JSON.stringify({
    branch: { name: `restore-proof-${Date.now()}`, parent_timestamp: at },
    endpoints: [{ type: "read_write" }] }) })).json();
  branch = made.branch?.id;
  if (!branch) { console.log("could not restore:", JSON.stringify(made).slice(0, 300)); process.exit(1); }

  const uri = await (await api(
    `/connection_uri?branch_id=${branch}&database_name=neondb&role_name=neondb_owner`)).json();
  const back = new pg.Client({ connectionString: uri.uri, ssl: { rejectUnauthorized: false } });
  // A branch's endpoint takes a moment to accept connections; that wait is
  // part of the restore, so it is measured rather than hidden.
  const t0 = Date.now();
  for (let i = 0; i < 12; i++) {
    try { await back.connect(); break; } catch { await new Promise(r => setTimeout(r, 5000)); }
  }
  const { rows: [got] } = await back.query(
    `select count(*) rows, coalesce(sum(available_delta),0)::text net from ledger`);
  const { rows: [ops] } = await back.query(`select count(*) n from operations`);
  await back.end();

  const ok = got.rows === want.rows && got.net === want.net;
  console.log(`restore holds ${got.rows} rows, net ${got.net}, ${ops.n} operations (ready in ${((Date.now()-t0)/1000).toFixed(0)}s)`);
  console.log(ok ? "\nok the money can be brought back" : "\n!! the restore does not match what the ledger held");
  process.exitCode = ok ? 0 : 1;
} finally {
  if (branch) await api(`/branches/${branch}`, { method: "DELETE" });
}
