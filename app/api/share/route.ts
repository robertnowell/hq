import { identify } from "@/lib/auth";
import { shareToTeam, shareByLink, setPrivate, shareState } from "@/lib/sharing";

export const runtime = "nodejs";

/**
 * Sharing, for a machine: the same three transitions the card makes, for the
 * `hq push --to` path. A device token may share what its person owns and
 * nothing else; the functions in db/018 check ownership.
 *
 *   POST { document_id, to: "acme.com" }   share to a team
 *   POST { document_id, to: "link" }         anyone with the link
 *   POST { document_id, to: "private" }      only the owner
 */
export async function POST(req: Request) {
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const id = typeof body?.document_id === "string" ? body.document_id : "";
  const to = typeof body?.to === "string" ? body.to.trim().toLowerCase() : "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || !to) {
    return Response.json({ error: "invalid_request", detail: "document_id and to are required" }, { status: 400 });
  }
  const r = to === "private" ? await setPrivate(me.userId, id)
          : to === "link"    ? await shareByLink(me.userId, id, true)
          :                    await shareToTeam(me.userId, id, to);
  if (!r.ok) return Response.json({ error: "refused", detail: "why" in r ? r.why : "review" }, { status: 422 });
  const state = await shareState(me.userId, id);
  return Response.json({ ok: true, ...state });
}

export async function GET(req: Request) {
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("document_id") ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return Response.json({ error: "invalid_request" }, { status: 400 });
  const state = await shareState(me.userId, id);
  if (!state) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(state);
}
