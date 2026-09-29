import { identify } from "@/lib/auth";
import { recordRead } from "@/lib/sharing";

export const runtime = "nodejs";

/**
 * A reader's beacon: "I have this page open, and have for N more seconds."
 *
 * Sent by the app's own chrome around the document, not by the document,
 * because the document runs in a null origin and cannot carry a session.
 * Bounded per call; the database adds it up. Refused for a document the
 * person may not read, silently, because there is nothing to record.
 *
 * The only place the reader's time is counted, and it is never shown to the
 * reader: analytics live with the owner (ruled 27 Sep).
 */
export async function POST(req: Request) {
  const me = await identify(req);
  if (!me) return new Response(null, { status: 401 });
  const body = await req.json().catch(() => null);
  const id = typeof body?.document_id === "string" ? body.document_id : null;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return new Response(null, { status: 400 });
  const seconds = Number(body?.seconds ?? 0);
  await recordRead(me.userId, id, Number.isFinite(seconds) ? seconds : 0);
  return new Response(null, { status: 204 });
}
