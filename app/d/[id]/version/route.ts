import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which bytes a document has right now.
 *
 * A page on disk is rewritten over its life, and the ingest route keeps the
 * same id and swaps the bytes: a rewrite is not news, so it raises no event
 * and the arrivals poll never hears of it. The one place that needs to hear
 * of it is a tab already showing the old bytes. On 28 Sep a reader opened a
 * page ten seconds before its fill arrived and sat looking at the empty
 * template, because nothing on the page could tell the frame to fetch again.
 *
 * Two fields, on purpose: the hash says whether anything changed, and the
 * character count says whether what the reader had was a page at all.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "not_found" }, { status: 404 });

  const row = await asUser(me.userId, async (c) => {
    const r = await c.query(
      `select content_hash, length(body_text) as chars from documents where id = $1`, [id]);
    return r.rows[0] ?? null;
  });
  if (!row) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ hash: row.content_hash, chars: Number(row.chars) },
    { headers: { "cache-control": "private, no-store" } });
}
