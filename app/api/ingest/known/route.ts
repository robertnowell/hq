import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Which of these content hashes does the app already hold?
 *
 * The drainer's first run on a laptop walks the whole archive. Posting every
 * document to find out it is already there would write 175 MB to the bucket
 * to learn nothing; asking first costs one round trip. The answer is scoped
 * to the caller, so a hash another user happens to hold reads as unknown and
 * gets its own row.
 */
export async function POST(req: Request) {
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const hashes: string[] = Array.isArray(body?.hashes)
    ? body.hashes.filter((h: unknown) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h))
    : [];
  if (!hashes.length) return Response.json({ known: [] });
  if (hashes.length > 5000) return Response.json({ error: "at most 5000 hashes per call" }, { status: 413 });
  const known = await asUser(me.userId, async (c) => {
    const r = await c.query(
      `select content_hash from documents where content_hash = any($1::text[])`, [hashes]);
    return r.rows.map((x) => x.content_hash as string);
  });
  return Response.json({ known });
}
