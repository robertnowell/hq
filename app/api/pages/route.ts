import { identify } from "@/lib/auth";
import { pagesFor } from "@/lib/queries";
import { answer, badRequest, limitFrom, originOf, pageURL, unauthenticated, withinBudget }
  from "@/lib/read-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One agent's newest pages, as pointers.
 *
 *   GET /api/pages?session=<id>&limit=5
 *
 * Pointers only, by the rule every read route here follows: title, slug,
 * when, whether it has been opened, and the url that opens it. The bytes
 * come from that url. Built for the Mac's Hub window sidebar.
 */
export async function GET(req: Request) {
  const me = await identify(req);
  if (!me) return unauthenticated();

  const url = new URL(req.url);
  const session = (url.searchParams.get("session") ?? "").trim();
  if (!/^[A-Za-z0-9-]{8,64}$/.test(session)) return badRequest("session is not a session id");

  const rows = await pagesFor(me.userId, session, limitFrom(url));
  const origin = originOf(req);
  const { kept, dropped } = withinBudget(rows.map((r) => ({
    title: r.title, slug: r.slug, at: r.at, opened: r.opened,
    url: pageURL(origin, session, r.slug),
  })));
  return answer({ pages: kept }, { dropped });
}
