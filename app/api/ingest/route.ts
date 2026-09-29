import { createHash } from "crypto";
import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";
import { putDocument, documentKey } from "@/lib/blobs";
import { pageAsks } from "@/lib/asks";
import { headMeta } from "@/lib/head-meta";

export const runtime = "nodejs";

/**
 * Accept one document from a laptop.
 *
 * Idempotent by content hash: the same bytes posted twice produce one
 * document and the second call returns the first one's id. That is what lets
 * a retrying uploader be dumb -- it can send the same file as many times as
 * it likes without creating duplicates, so it never has to track what it has
 * already sent.
 */
/** Only an http(s) address is a published address; anything else is nothing. */
const publishedUrl = (v: unknown): string | null =>
  typeof v === "string" && /^https?:\/\/\S+$/.test(v.trim()) && v.length < 2048 ? v.trim() : null;

export async function POST(req: Request) {
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const body = await req.json().catch(() => null);
  if (!body?.html || !body?.session_id) {
    return Response.json(
      { error: "html and session_id are required" },
      { status: 400 },
    );
  }

  const html: string = body.html;
  // A ceiling, stated. The function runtime this is headed for refuses
  // bodies over 4.5 MB anyway; refusing here, with a reason, means the
  // drainer logs it and the heartbeat says so, rather than a silent 413 from
  // a proxy. A page this large is inline images, and the drainer's guard
  // should have moved them out before this call.
  if (Buffer.byteLength(html, "utf8") > 4 * 1024 * 1024) {
    return Response.json(
      { error: "document over 4 MB; inline images belong in the media bucket" },
      { status: 413 },
    );
  }
  const hash = createHash("sha256").update(html).digest("hex");

  // Blob first, row second. A failure between them leaves an unreferenced
  // blob, which is harmless and gets reused on the next attempt because the
  // key is the content hash. The reverse order would leave a row whose
  // document cannot be read.
  const key = documentKey(me.userId, hash);
  await putDocument(key, html);

  const bodyText = html
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // The page's own labels and one-line summary, from its head. Every page is
  // already asked to carry them; storing them is what lets the team page
  // list a document as a sentence and group by subject later without a
  // migration (ruled 27 Sep: labels now, collections later).
  const { labels, summary } = headMeta(html);
  // What the page asks of its reader, from its own dark block (28 Sep).
  const asks = pageAsks(html);

  const out = await asUser(me.userId, async (c) => {
    // A page's arrival is not the agent's activity; the page's own date is.
    // A second Mac's first mirror uploads weeks of pages in one minute, and
    // with `now()` here every one of those agents jumped to the top of the
    // list as if it had just spoken (17 Sep, 86 pages, "it overwrote
    // everything"). Nothing was overwritten; the order was. The turns route
    // already keeps the greatest of what it knew and what arrived, so this
    // does the same with the page's produced_at, and falls back to now() only
    // for a page that carries no date.
    const active = body.produced_at ?? null;
    const agent = await c.query(
      `insert into agents (user_id, source_session_id, title, cwd, last_active_at)
         values ($1, $2, $3, $4, coalesce($5::timestamptz, now()))
       on conflict (user_id, source_session_id) do update
         set last_active_at = greatest(agents.last_active_at, coalesce($5::timestamptz, now())),
             title = coalesce(agents.title, excluded.title)
       returning id`,
      [me.userId, body.session_id, body.agent_title ?? null, body.cwd ?? null, active],
    );

    const agentId = agent.rows[0].id;
    const slug = body.slug ?? hash.slice(0, 12);

    // Identity is the document, not its bytes.
    //
    // The same bytes twice are one document: the (user_id, content_hash)
    // conflict returns the existing row and emits no second `delivered`.
    // But a page on disk is REWRITTEN over its life -- a footer stamped in,
    // a correction, a reindex -- and 166 of 1,753 archive files have been.
    // Keying identity purely on the hash would make every rewrite a new
    // document beside the old one, with the old one's read state stranded.
    // So a new hash at an address this agent already has (same slug) is an
    // update in place: same id, same events, new bytes. A rewrite is not
    // news, so it is not re-delivered either; only a human clears a lamp and
    // only a genuinely new document lights one.
    const same = await c.query(
      `select id from documents where content_hash = $1`, [hash]);
    let id: string, inserted = false;
    if (same.rows[0]) {
      id = same.rows[0].id;
    } else {
      const prior = await c.query(
        `select id from documents where agent_id = $1 and slug = $2
          order by created_at desc limit 1`, [agentId, slug]);
      if (prior.rows[0]) {
        id = prior.rows[0].id;
        await c.query(
          `update documents
              set title = coalesce($2, title), storage_key = $3, body_text = $4,
                  content_hash = $5,
                  produced_at = coalesce(produced_at, $6),
                  published_url = coalesce($7, published_url),
                  labels = $8, summary = coalesce($9, summary), asks = $10
            where id = $1`,
          [id, body.title ?? null, key, bodyText, hash, body.produced_at ?? null,
           publishedUrl(body.published_url), labels, summary, asks]);
      } else {
        const doc = await c.query(
          `insert into documents
             (user_id, agent_id, slug, title, storage_key, body_text, content_hash, produced_at,
              published_url, labels, summary, asks)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           returning id`,
          [me.userId, agentId, slug, body.title ?? null, key, bodyText, hash,
           body.produced_at ?? null, publishedUrl(body.published_url), labels, summary, asks]);
        id = doc.rows[0].id;
        inserted = true;
      }
    }

    if (inserted) {
      await c.query(
        `insert into document_events (user_id, document_id, kind)
         values ($1, $2, 'delivered')`,
        [me.userId, id],
      );
    }

    await c.query(
      `insert into ingest_heartbeat (user_id, device_name, last_seen_at)
       values ($1, $2, now())
       on conflict (user_id, device_name) do update set last_seen_at = now()`,
      [me.userId, body.device ?? "unknown"],
    );

    return { id, created: inserted };
  });

  return Response.json(out, { status: out.created ? 201 : 200 });
}
