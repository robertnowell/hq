import { publicDocument } from "@/lib/publishing";
import { identify } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The older link address, /p/<slug>, kept so links sent before 29 Sep 2026
 * still open. It serves nothing itself any more: a stranger goes to the
 * front door and back, a signed-in person is forwarded to the document's
 * one address, /d/<id>, which decides who may read it (hq_can_read) and
 * cleans a reader's copy. No new /p addresses are made (audit 28 Sep: the
 * slug was the only secret, and it was the page's title).
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return notFound();

  // Since 27 Sep 2026 a link reader signs in: an email and a code, no
  // password, no account to make. The address is what lets the owner see
  // who read the page, and what lets them make it private again when
  // somebody unexpected turns up. A stranger with no session is sent to the
  // front door and back here.
  const me = await identify(req);
  if (!me) {
    const here = `/p/${slug}`;
    return Response.redirect(new URL(`/sign-in?redirect_url=${encodeURIComponent(here)}`, req.url), 307);
  }

  const doc = await publicDocument(slug);
  if (!doc) return notFound();
  // Since 29 Sep a document has one address, /d/<id>, and one door. A /p
  // link somebody was sent before then still works: it forwards there, and
  // the read is recorded when the frame loads, not here.
  return Response.redirect(new URL(`/d/${doc.id}`, req.url), 308);
}

/** Unpublished and never-existed are the same answer, deliberately. */
function notFound() {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
  });
}

