// Forget the agents that were never yours: the machines.
//
// The mirror stopped sending headless runs on 13 Sep (HubMirror.isRobot), but
// the rows it had already sent stay until something removes them. 126 of the
// 316 classifiable sessions holding a brief on this Mac were started by
// `claude -p` -- cron runs, fleet voters, our own harnesses -- and the hub
// shows 500 agents, so roughly two rows in five were a robot.
//
// The verdict is the grid's, and it is POSITIVE evidence only: a transcript
// whose first lines declare `entrypoint: sdk-cli`. An absence is never
// evidence -- no transcript, or a transcript we could not read, and the agent
// stays. That asymmetry is the whole design: a stray robot row costs one
// glance, a deleted conversation costs the work.
//
// An agent that WROTE something is kept whatever started it. A report a cron
// wrote is still a report; across 140 headless directories on this Mac there
// are two of them, so the rule costs almost nothing and cannot lose a page.
//
//   node scripts/forget-machines.mjs            # says what it would do
//   node scripts/forget-machines.mjs --delete   # does it
import { readFileSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import pg from "pg";

const PROJECTS = join(process.env.HOME, ".claude/projects");
const APPLY = process.argv.includes("--delete");

/** The first `entrypoint` a transcript declares, from its head only. */
function entrypoint(path) {
  let head;
  try { head = readFileSync(path, "utf8").slice(0, 65536); } catch { return null; }
  for (const line of head.split("\n")) {
    if (!line.includes('"entrypoint"')) continue;
    try { const o = JSON.parse(line); if (o.entrypoint) return o.entrypoint; } catch { /* partial tail line */ }
  }
  return null;
}

const headless = new Set();
for (const dir of readdirSync(PROJECTS)) {
  let files;
  try { files = readdirSync(join(PROJECTS, dir)); } catch { continue; }
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const id = f.slice(0, -6);
    if (id.length !== 36) continue;                   // orphan and sidecar files
    if (entrypoint(join(PROJECTS, dir, f)) === "sdk-cli") headless.add(id);
  }
}
console.log(`transcripts on this Mac declaring sdk-cli: ${headless.size}`);

const pool = new pg.Pool({ connectionString: process.env.HQ_APP_DATABASE_URL, max: 4 });

// Whose hub. Taken from this Mac's own device token rather than an env var:
// `users` is behind RLS whose policy needs the very id you are looking for, so
// a plain select returns zero rows. hq_user_for_token is the door the app
// itself uses, and the token is already here because the mirror writes with
// it. The plaintext is hashed before it is sent, exactly as identify() does.
const token = JSON.parse(readFileSync(
  join(process.env.HOME, "Library/Application Support/VoiceDispatch/secrets.json"), "utf8"))["hub-token"];
if (!token) { console.error("this Mac is not connected to a hub"); process.exit(1); }
const u = await pool.query("select user_id from hq_user_for_token($1)",
                           [createHash("sha256").update(token.trim()).digest("hex")]);
if (!u.rows[0]) { console.error("this Mac's token is not recognised by the hub"); process.exit(1); }
const USER = u.rows[0].user_id;

const c = await pool.connect();
await c.query(`begin; select set_config('hq.user_id', '${USER}', true)`);

const { rows } = await c.query(`
  select a.id, a.source_session_id, a.title,
         (select count(*)::int from documents d where d.agent_id = a.id) as docs,
         (select count(*)::int from turns t where t.agent_id = a.id) as turns
    from agents a
   where a.source_session_id = any($1::text[])
   order by a.last_active_at desc`, [[...headless]]);

const keep = rows.filter((r) => r.docs > 0);
const drop = rows.filter((r) => r.docs === 0);
console.log(`hub rows matching a machine: ${rows.length}`);
console.log(`  keeping ${keep.length} that wrote a page: ` +
            keep.map((r) => `${r.title ?? r.source_session_id.slice(0, 8)} (${r.docs})`).join(", "));
console.log(`  ${APPLY ? "deleting" : "would delete"} ${drop.length} rows carrying ${
  drop.reduce((n, r) => n + r.turns, 0)} turns and no pages`);
for (const r of drop.slice(0, 8)) console.log(`      ${r.source_session_id.slice(0, 8)}  ${r.title ?? "-"}`);
if (drop.length > 8) console.log(`      ... and ${drop.length - 8} more`);

if (APPLY && drop.length) {
  const ids = drop.map((r) => r.id);
  const t = await c.query(`delete from turns where agent_id = any($1::uuid[])`, [ids]);
  const a = await c.query(`delete from agents where id = any($1::uuid[])`, [ids]);
  console.log(`deleted ${a.rowCount} agents and ${t.rowCount} turns`);
}
await c.query(APPLY ? "commit" : "rollback");
c.release();
await pool.end();
