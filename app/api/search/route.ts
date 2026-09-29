import { identify } from "@/lib/auth";
import { searchAll } from "@/lib/queries";
import { answer, badRequest, cursorFor, limitFrom, offsetFrom, originOf, pageURL,
         unauthenticated, withinBudget } from "@/lib/read-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One search over everything this account's agents have written.
 *
 *   GET /api/search?q=pairing&kind=both&limit=10&cursor=...
 *
 * Turns and pages in one ranked list, because an agent asking a question does
 * not know which of the two holds the answer. Each hit is a POINTER: what it
 * is, who wrote it, when, one fragment, and the address to fetch. The page's
 * text is never in here; that is what /api/page is for, and keeping the two
 * apart is the one thing every vendor who has shipped this agrees on.
 */
export async function GET(req: Request) {
  const me = await identify(req);
  if (!me) return unauthenticated();

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return badRequest("q is required");
  if (q.length > 200) return badRequest("q is too long");

  const kindParam = (url.searchParams.get("kind") ?? "both").toLowerCase();
  const kind = kindParam === "turns" || kindParam === "pages" ? kindParam : "both";
  const limit = limitFrom(url);
  const offset = offsetFrom(url);

  const hits = await searchAll(me.userId, q, { kind, limit: limit + 1, offset });
  const more = hits.length > limit;
  const origin = originOf(req);

  const { kept, dropped } = withinBudget(hits.slice(0, limit).map((h) => ({
    kind: h.kind,
    title: h.title,
    agent: h.agent,
    session: h.session,
    slug: h.slug,
    at: h.at,
    // ts_headline marks the match in bold and will not be talked out of it.
    // The words are the signal; the markup is noise to this reader.
    snippet: (h.snippet ?? "").replace(/<\/?b>/g, "").replace(/\s+/g, " ").trim(),
    url: pageURL(origin, h.session, h.slug),
  })));

  return answer({ query: q, kind, results: kept },
    { dropped, cursor: more || dropped > 0 ? cursorFor(offset + kept.length) : null });
}
