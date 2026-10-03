import { getDocument } from "@/lib/blobs";
import { publicIndex, siteOwnerUserId, SITE_BASE } from "@/lib/publishing";
import { forTheSite, runsCode } from "@/lib/note-record";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A published page that runs its own code, whole, for the connected site to
 * frame.
 *
 * The site renders a note from its record, and the record carries no scripts:
 * nothing anybody wrote runs on the site's origin. A page whose point IS its
 * code (3 Oct 2026: a blind listening test, every Listen button dead on
 * robertnowell.dev) is framed from here instead, and the record names this
 * address in `frame`.
 *
 * It is the same rule as the hub's own document frame (app/d/[id]/raw): the
 * page runs in a null origin, so no cookie reaches any request it makes and
 * it can read neither this hub nor the site around it. Only the connected
 * site may frame it, and only pages that feed lists are served, so this
 * reaches nothing notes.json does not already publish.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return notFound();
  const owner = siteOwnerUserId();
  if (!owner) return notFound();
  const row = (await publicIndex({ ownedBy: owner })).find((r) => r.public_slug === slug);
  if (!row?.storage_key) return notFound();
  const html = await getDocument(row.storage_key);
  // Only a page that runs code is framed; any other page is the record's.
  if (html === null || !runsCode(html)) return notFound();

  const site = new URL(SITE_BASE).origin;
  const www = site.replace("://", "://www.");
  return new Response(withHeight(forTheSite(html)), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Withdrawn means withdrawn: the site revalidates on its own schedule.
      "cache-control": "public, max-age=0, must-revalidate",
      "content-security-policy":
        "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; " +
        `frame-ancestors ${site} ${www}`,
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      // The site's own page is the indexed one; this is its insides.
      "x-robots-tag": "noindex",
    },
  });
}

/**
 * Tell the frame's parent how tall the page is, so the site can size the
 * frame to it and the page scrolls with the site rather than inside a box.
 */
function withHeight(html: string): string {
  const tell = `<script>(()=>{const h=()=>parent.postMessage({tbFrameHeight:document.documentElement.scrollHeight},"*");` +
    `addEventListener("load",h);new ResizeObserver(h).observe(document.documentElement);h();})();</script>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${tell}</body>`) : html + tell;
}

function notFound() {
  return new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "x-robots-tag": "noindex" },
  });
}
