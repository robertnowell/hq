import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What the panel calls each agent.
 *
 * A name is derived on the laptop from the panel's own sources (the harness's
 * tab title, else the Codex thread name, else the callsign, else the working
 * directory) and it changes as the conversation does, so the drainer sends
 * the current name for every session it knows and this route makes the app
 * agree. An agent the app has not seen is not created here: a name with no
 * turns and no pages is nothing to show.
 *
 * Older agents were mirrored under the 8-character head of their session id;
 * both spellings are matched so a rename reaches them too.
 */
export async function POST(req: Request) {
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const names: { session_id?: string; title?: string }[] = Array.isArray(body?.names) ? body.names : [];
  const rows = names.filter((n) => typeof n.session_id === "string" && n.session_id.length >= 8
                                && typeof n.title === "string" && n.title.trim().length > 0)
                    .slice(0, 500);
  if (rows.length === 0) return Response.json({ renamed: 0 });

  const renamed = await asUser(me.userId, async (c) => {
    const r = await c.query(
      `update agents a
          set title = n.title
         from unnest($1::text[], $2::text[]) as n(session_id, title)
        where a.user_id = $3
          and (a.source_session_id = n.session_id or a.source_session_id = left(n.session_id, 8))
          and a.title is distinct from n.title`,
      [rows.map((n) => n.session_id), rows.map((n) => n.title!.trim()), me.userId]);
    return r.rowCount ?? 0;
  });
  return Response.json({ renamed });
}
