import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The one contract a client needs: "this session, this file" -> a page.
 *
 *   /open?session=<harness session id>&slug=<slug>   -> the document
 *   /open?session=<harness session id>               -> the agent
 *
 * The panel, the hub footers and the page-writing skills can all link here
 * without knowing the app's ids, which are minted on arrival. A native
 * client later is a client of the same route. Not mirrored yet is said
 * plainly, never rendered as an empty page.
 */
export async function GET(req: Request) {
  const me = await identify(req);
  const url = new URL(req.url);
  const session = url.searchParams.get("session")?.trim() ?? "";
  const slug = url.searchParams.get("slug")?.trim() ?? "";
  if (!me) {
    // Sign in first, then come back to exactly this address.
    return Response.redirect(new URL(`/sign-in?redirect_url=${encodeURIComponent(url.pathname + url.search)}`, url), 302);
  }
  if (!session) return new Response("session is required", { status: 400 });

  const hit = await asUser(me.userId, async (c) => {
    // The directory name is the session id; an 8-character head matches too,
    // for the older page footers that carry only that.
    const a = await c.query(
      `select id from agents
        where source_session_id = $1 or ($2 and source_session_id like $1 || '%')
        order by last_active_at desc limit 1`,
      [session, session.length === 8],
    );
    if (!a.rows[0]) return null;
    const agentId = a.rows[0].id as string;
    if (!slug) return { agentId, docId: null };
    const d = await c.query(
      `select id from documents where agent_id = $1 and slug = $2
        order by created_at desc limit 1`, [agentId, slug]);
    return { agentId, docId: d.rows[0]?.id ?? null };
  });

  // Nothing from this agent has reached the hub yet: a brand-new agent whose
  // first turn is still being summarised, or a Mac whose panel is not
  // running. That is a page that waits, not a line of text; the panel's
  // sweep is twenty seconds, so the page asks again on its own.
  if (!hit) return new Response(waiting(session), {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
  if (slug && !hit.docId) {
    // The agent is here, the page is not yet. Land on the agent rather than
    // on nothing; the next drain brings the page.
    return Response.redirect(new URL(`/a/${hit.agentId}?missing=${encodeURIComponent(slug)}`, url), 302);
  }
  return Response.redirect(new URL(hit.docId ? `/d/${hit.docId}` : `/a/${hit.agentId}`, url), 302);
}

function waiting(session: string) {
  const short = session.slice(0, 8);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>Not here yet</title>
<style>
:root{--bg:#fcfbf8;--ink:#1f1e1c;--heading:#141312;--muted:#57534c;--faint:#6e6a63;--line:#ddd9cf;--accent:#1f4f8f}
@media (prefers-color-scheme:dark){:root{--bg:#131310;--ink:#eceae2;--heading:#f3f1e9;--muted:#a5a196;--faint:#77746c;--line:#33322d}}
html,body{margin:0;background:var(--bg);color:var(--ink)}
body{font:17px/1.6 'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
main{max-width:34rem;text-align:center}
svg{width:40px;height:40px;fill:var(--heading)}
h1{font:400 28px/1.25 inherit;color:var(--heading);margin:14px 0 8px}
p{color:var(--muted);margin:8px 0}
.m{font:13px/1.5 ui-monospace,Menlo,monospace;color:var(--faint)}
a{color:var(--accent)}
</style></head><body><main>
<svg viewBox="0 0 16 16" aria-hidden="true"><path fill-rule="evenodd" d="M8 1.3a4.9 4.9 0 1 0 0 9.8 4.9 4.9 0 0 0 0-9.8zm0 1.6a3.3 3.3 0 1 1 0 6.6 3.3 3.3 0 0 1 0-6.6zM1.5 12.8h13v1.6h-13z"/></svg>
<h1>Nothing from this agent has reached the hub yet.</h1>
<p>A new agent appears here after its first turn, usually within a minute. This page checks again on its own every ten seconds.</p>
<p>If it stays empty, Tranquility Base is not running on the Mac where the agent lives, or that Mac is not connected to this hub.</p>
<p class="m">agent ${short} \u00b7 <a href="/">your hub</a></p>
</main></body></html>`;
}
