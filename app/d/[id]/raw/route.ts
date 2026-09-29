import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";
import { getDocument } from "@/lib/blobs";
import { hubLinks, linkTargets } from "@/lib/hub-links";
import { documentForReader, recordRead } from "@/lib/sharing";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The bytes of one document, and nothing else.
 *
 * This used to BE the document page, with the app's chrome injected into the
 * agent's own html. That worked and it cost more than it looked: the page was
 * served under a sandbox with an opaque origin, so nothing the app drew into
 * it could carry a session, and the share control had to open a separate
 * browser window to do its work. Robert, 13 Sep, on seeing that: "isn't this
 * a React app? Why is it a separate browser window?"
 *
 * So the relationship is the other way round now. The app's page is the
 * parent, in React, with a session; this is the frame inside it, sandboxed,
 * unable to reach anything of ours. That is also how every product that
 * renders somebody else's html does it, and for the same reason.
 *
 * The authorization check is right next to the fetch, deliberately, and not in
 * middleware. Both Vercel and Clerk publish that guidance for the same reason:
 * a middleware bug or a matcher that does not cover a route exposes content,
 * and it does so silently.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const me = await identify(req);
  if (!me) return new Response("unauthenticated", { status: 401 });

  const { id } = await ctx.params;
  if (!UUID.test(id)) return new Response("not found", { status: 404 });

  const row = await asUser(me.userId, async (c) => {
    const r = await c.query(
      `select d.id, d.storage_key, a.source_session_id
         from documents d join agents a on a.id = d.agent_id
        where d.id = $1`,
      [id],
    );
    if (!r.rows[0]) return null;
    // Opening is an event, not a column. Read state is derived from these,
    // and this is the request that actually puts the words on a screen.
    await c.query(
      `insert into document_events (user_id, document_id, kind)
       values ($1, $2, 'opened')`,
      [me.userId, id],
    );
    return r.rows[0];
  });
  // Not mine: a teammate or a link reader. The read is recorded on the
  // reader's own row (never a document_event, which is the owner's lamp).
  // A private document of somebody else's and one that does not exist stay
  // the same 404.
  const shared = row ? null : await documentForReader(me.userId, id);
  if (!row && !shared) return new Response("not found", { status: 404 });
  if (shared) await recordRead(me.userId, id, 0);
  const rec = row ?? { storage_key: shared!.storage_key, source_session_id: shared!.source_session_id };

  const html = rec.storage_key ? await getDocument(rec.storage_key) : null;
  if (html === null) {
    // A row pointing at a blob that is not there. Never silently render an
    // empty document -- that looks like a report with nothing in it.
    return new Response("document bytes are missing", { status: 502 });
  }

  // A reader's copy is cleaned the way /p always cleaned it: the app scheme
  // means nothing to them and carries a path on the author's laptop.
  const body = linkTargets(withoutStamp(hubLinks(html, rec.source_session_id)));
  return new Response(shared ? forAReader(body) : body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // private: this response belongs to one user, so no shared cache may
      // hold it. no-cache: the browser may store it but must revalidate.
      "cache-control": "private, no-cache",
      // The document runs in a null origin. wikihub's design, adopted as a
      // design: agent-written HTML is served, and may run its own scripts
      // (charts, toggles), but it is not US. Without allow-same-origin the
      // page has an opaque origin: no cookies reach any request it makes,
      // no server action will accept it, no other document is readable, no
      // storage is shared with the app. Nested inside our own page it still
      // cannot reach the parent, which is the whole point of putting it
      // there. frame-ancestors keeps it ours to frame.
      // A reader's copy may not navigate the tab it sits in: a page someone
      // else wrote must not be able to swap the hub for a look-alike sign-in
      // on one click (safety review, 29 Sep). The owner's own copy keeps it.
      "content-security-policy":
        "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox " +
        (shared ? "" : "allow-top-navigation-by-user-activation ") + "allow-modals; frame-ancestors 'self'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

/**
 * The footer the file carries, removed for the hub's own view.
 *
 * It exists so a page carries its authorship wherever it travels, on disk or
 * in somebody's downloads. Inside the hub nothing it says is missing: the bar
 * above this frame names the agent and links to it.
 */
function forAReader(html: string): string {
  return html
    .replace(/href="tranquilitybase:\/\/[^"]*"/gi, 'href="#"')
    .replace(/(["'(])file:\/\/\/Users\/[^"')\s]*/gi, "$1#");
}

function withoutStamp(html: string): string {
  return html.replace(/<footer[^>]*data-tb-agent=[\s\S]*?<\/footer>/gi, "");
}
