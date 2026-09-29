// Move document bytes out of Postgres and into the private bucket.
//
// Ordered so that no step can lose a document:
//   1. read html from the row
//   2. write the blob, and read it back to confirm the bytes match
//   3. only then set storage_key and body_text on the row
//   4. html is cleared in a SEPARATE pass, after every row is verified
//
// A crash at any point leaves either an unreferenced blob (harmless, the key
// is content-addressed so a re-run reuses it) or a row that still has its
// html (also harmless, it just has not moved yet). The one state that must
// never exist -- a row pointing at a blob that is not there -- is prevented
// by verifying the read-back before writing the key.
import { createHash } from "crypto";
import pg from "pg";
import { Storage } from "@google-cloud/storage";

const creds = JSON.parse(Buffer.from(process.env.HQ_GCS_SA_KEY_B64, "base64").toString());
const storage = new Storage({
  projectId: creds.project_id,
  credentials: { client_email: creds.client_email, private_key: creds.private_key },
});
const bucket = storage.bucket(process.env.HQ_GCS_BUCKET ?? "");
const pool = new pg.Pool({ connectionString: process.env.HQ_DATABASE_URL, max: 4 });

const strip = (h) => h.replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ")
                      .replace(/<[^>]*>/g, " ")
                      .replace(/\s+/g, " ").trim();

let done = 0, already = 0, failed = 0, bytes = 0;
const BATCH = 25;

for (;;) {
  const { rows } = await pool.query(
    `select id, user_id, content_hash, html from documents
      where storage_key is null and html is not null limit $1`, [BATCH]);
  if (!rows.length) break;

  for (const r of rows) {
    const key = `u/${r.user_id}/${r.content_hash}.html`;
    try {
      const file = bucket.file(key);
      await file.save(r.html, { contentType: "text/html; charset=utf-8", resumable: false });

      // Read it back. A write that reports success and stored the wrong
      // bytes is exactly the failure this whole ordering exists to prevent.
      const [buf] = await file.download();
      const back = createHash("sha256").update(buf.toString("utf8")).digest("hex");
      if (back !== r.content_hash) {
        console.error(`  MISMATCH ${r.id} ${key}`); failed++; continue;
      }

      await pool.query(
        `update documents set storage_key = $1, body_text = $2 where id = $3`,
        [key, strip(r.html), r.id]);
      done++; bytes += r.html.length;
    } catch (e) {
      failed++; console.error(`  ${r.id}: ${e.message}`);
    }
  }
  if (done % 100 < BATCH) console.log(`  ${done} moved, ${(bytes/1e6).toFixed(0)} MB`);
}

const left = await pool.query(
  `select count(*)::int n from documents where storage_key is null`);
console.log(`\nmoved ${done}, failed ${failed}, still unmoved ${left.rows[0].n}, ${(bytes/1e6).toFixed(1)} MB`);
await pool.end();
process.exit(failed ? 1 : 0);
