// Correct produced_at from the hook's own record.
//
// The backfill used the file's MTIME, which is not when a document was
// written -- it is when the file was last touched. Pages get rewritten:
// footers stamped in, republished, reindexed. 166 of 1,753 archive files
// have an mtime more than an hour after their creation, and for those the
// document lands under whatever turn happened to be running when something
// rewrote it, or under no turn at all.
//
// The panel's hook already records the truth: `epochMs<TAB>path`, appended
// the moment it first sees a page, deduplicated with the FIRST write kept.
// Against that record the filing rule is exact -- on the session that
// prompted this, all four documents were written 12 to 48 seconds before the
// brief that closed their turn.
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import pg from "pg";

const REC = join(process.env.HOME, "Library/Application Support/VoiceDispatch/artifacts");
const EMAIL = process.argv[2];
if (!EMAIL) { console.error("usage: fix-produced-at.mjs <external id, the Clerk user id>"); process.exit(1); }

const pool = new pg.Pool({ connectionString: process.env.HQ_DATABASE_URL, max: 4 });
const who = await pool.query("select id from users where external_id = $1", [EMAIL]);
if (!who.rows[0]) { console.error(`no user ${EMAIL}`); process.exit(1); }
const USER = who.rows[0].id;

// path -> earliest epoch ms the hook logged for it.
const first = new Map();
for (const f of readdirSync(REC)) {
  let body; try { body = readFileSync(join(REC, f), "utf8"); } catch { continue; }
  for (const line of body.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 1) continue;                       // path-only lines carry no stamp
    const ms = Number(line.slice(0, tab));
    const path = line.slice(tab + 1).trim();
    if (!Number.isFinite(ms) || ms <= 0 || !path) continue;
    const prev = first.get(path);
    if (prev === undefined || ms < prev) first.set(path, ms);
  }
}
console.log(`artifact log: ${first.size} documents with a recorded first write`);

// Match on the path the archive actually uses: <session>/<slug>.html. The
// hook logs some pages under the 8-character slug directory instead, so both
// spellings are tried before giving up.
const docs = await pool.query(`
  select d.id, d.slug, a.source_session_id as session
    from documents d join agents a on a.id = d.agent_id
   where d.user_id = $1`, [USER]);

const home = process.env.HOME;

/**
 * The archive spells a page's path three ways and the log uses all of them.
 *
 *   <session>/<slug>.html            the full 36-character id
 *   <short>/<slug>.html              the 8-character slug directory, which is
 *                                    4,335 of the 5,552 paths in the log
 *   <short>/<dir>/index.html         a report in its own directory, which the
 *                                    document backfill flattened to the slug
 *                                    "<dir>-index"
 *
 * Trying only the first two matched 370 of 870 documents and left the rest
 * on an mtime, which is the thing this script exists to stop trusting.
 */
function candidates(session, slug) {
  const root = `${home}/Documents/agents`;
  const short = session.slice(0, 8);
  const out = [];
  for (const dir of [session, short]) {
    out.push(`${root}/${dir}/${slug}.html`);
    out.push(`${root}/${dir}/${slug}/index.html`);
    if (slug.endsWith("-index")) {
      const inner = slug.slice(0, -"-index".length);
      out.push(`${root}/${dir}/${inner}/index.html`);
      out.push(`${root}/${dir}/${inner}/report.html`);
    }
  }
  return out;
}

let fixed = 0, moved = 0, unmatched = 0, totalShift = 0;
for (const d of docs.rows) {
  const hit = candidates(d.session, d.slug)
    .map((c) => first.get(c)).find((v) => v !== undefined);
  if (hit === undefined) { unmatched++; continue; }
  const r = await pool.query(
    `update documents set produced_at = to_timestamp($2/1000.0)
      where id = $1 and user_id = $3
        and (produced_at is null
             or abs(extract(epoch from produced_at) - $2/1000.0) > 60)
      returning extract(epoch from produced_at) as was`,
    [d.id, hit, USER]);
  fixed++;
  if (r.rows[0]) { moved++; totalShift += Math.abs(r.rows[0].was - hit / 1000); }
}
console.log(`matched to the log:  ${fixed}`);
console.log(`timestamp corrected: ${moved}` +
  (moved ? `  (average move ${Math.round(totalShift / moved / 3600)} hours)` : ""));
console.log(`no record found:     ${unmatched}  (written before the hook, or moved since)`);
await pool.end();
