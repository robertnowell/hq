// Give agents the names people already know them by, and a real last-active
// date.
//
// The backfill stamped last_active_at = now() on all 160, so every agent had
// an identical timestamp and the "stack, not queue" ordering had nothing to
// sort on. It now comes from the newest document the agent actually wrote.
//
// Names come from the hub page the old system already writes, whose <title>
// is the name a person recognises. His rule from August: agents have names,
// never show a hash.
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import pg from "pg";

const ROOT = join(process.env.HOME, "Documents/agents");
const pool = new pg.Pool({ connectionString: process.env.HQ_DATABASE_URL, max: 4 });
const u = await pool.query("select id from users where external_id=$1", [process.env.HQ_EXTERNAL_ID]);
const USER = u.rows[0].id;

// A hub title is only a name if it reads like one. Some are transcript
// fragments that happened to land in a <title>, and a bad name is worse than
// an honest short id.
function usable(raw) {
  let t = raw.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  t = t.replace(/\s*[—–-]\s*agent\s*$/i, "");
  t = t.replace(/\s*[·|]\s*(hub|Tranquility Base).*$/i, "").trim();
  if (!t) return null;
  if (/^agent\s+[0-9a-f]{6,}/i.test(t)) return null;      // "Agent 019db12b"
  if (/^[0-9a-f-]{8,40}$/i.test(t)) return null;          // a bare id
  if (t.length < 4 || t.length > 90) return null;         // fragments, essays
  if (/\[Image #\d/.test(t)) return null;                 // pasted transcript
  if (!/[a-z]/.test(t)) return null;
  return t;
}

const rows = await pool.query(
  "select id, source_session_id from agents where user_id=$1", [USER]);

let named = 0, kept = 0;
for (const a of rows.rows) {
  const idx = join(ROOT, a.source_session_id, "index.html");
  if (existsSync(idx)) {
    const m = readFileSync(idx, "utf8").slice(0, 8000).match(/<title>([\s\S]*?)<\/title>/);
    const t = m && usable(m[1]);
    if (t) { await pool.query("update agents set title=$1 where id=$2", [t, a.id]); named++; }
    else kept++;
  } else kept++;

  await pool.query(
    `update agents set last_active_at = coalesce(
        (select max(coalesce(produced_at, created_at)) from documents where agent_id=$1),
        last_active_at) where id=$1`, [a.id]);
}
console.log(`named ${named}, left as short id ${kept}, of ${rows.rowCount}`);
await pool.end();
