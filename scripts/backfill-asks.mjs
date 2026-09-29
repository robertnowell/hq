// What each existing page asks, read from its stored bytes (hq-app-cll.8).
//
// db/027 adds documents.asks and ingest fills it for every page that
// arrives from now on. This fills it for pages already here, newest first,
// within a window: a page older than that is not waiting on anyone. It runs
// as the owner (it reads every tenant's rows) and only ever writes asks on
// rows where it is null. The parser is lib/asks.ts, transcribed below; the
// two must stay the same, and the drill checks the ingest side.
//
//   HQ_GCS_SA_KEY_B64=… HQ_GCS_BUCKET=… node scripts/backfill-asks.mjs "$OWNER_URL" [days]
import pg from "pg";
import { Storage } from "@google-cloud/storage";

const url = process.argv[2];
const days = Number(process.argv[3] ?? 30);
if (!url) { console.error("owner database url required"); process.exit(2); }
const creds = JSON.parse(Buffer.from(process.env.HQ_GCS_SA_KEY_B64 ?? "", "base64").toString());
const bucket = new Storage({ credentials: creds, projectId: creds.project_id }).bucket(process.env.HQ_GCS_BUCKET ?? "");

function text(s) {
  return s.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&middot;/g, "·").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}
function pageAsks(html) {
  const block = html.match(/<div\s+class=["']you["'][^>]*>([\s\S]{0,4000}?)<\/div>\s*(?:<p[^>]*>([\s\S]{0,2000}?)<\/p>)?/i);
  if (!block) return null;
  const kicker = text(block[1]);
  if (!/needs you/i.test(kicker) || /nothing/i.test(kicker)) return null;
  const sentence = text(block[2] ?? "");
  return sentence ? sentence.slice(0, 300) : kicker.replace(/^.*?needs you\s*[·:-]?\s*/i, "").slice(0, 300) || null;
}

const pool = new pg.Pool({ connectionString: url, max: 2 });
const { rows } = await pool.query(
  `select id, storage_key from documents
    where asks is null and storage_key is not null
      and coalesce(produced_at, created_at) > now() - make_interval(days => $1)
    order by coalesce(produced_at, created_at) desc`, [days]);
let asked = 0, none = 0, missing = 0;
for (const r of rows) {
  try {
    const [buf] = await bucket.file(r.storage_key).download();
    const a = pageAsks(buf.toString("utf8"));
    if (a) { await pool.query(`update documents set asks = $2 where id = $1 and asks is null`, [r.id, a]); asked++; }
    else none++;
  } catch { missing++; }
}
console.log(JSON.stringify({ window_days: days, scanned: rows.length, asks: asked, asks_nothing: none, unreadable: missing }));
await pool.end();
