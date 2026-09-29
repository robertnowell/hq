import { identify } from "@/lib/auth";
import { pageText } from "@/lib/queries";
import { answer, badRequest, originOf, pageURL, unauthenticated } from "@/lib/read-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Roughly 12,000 tokens of text, well under what a tool result may carry. */
const MAX_TEXT = 48_000;

/**
 * One page, as text, by the two things an agent already knows.
 *
 *   GET /api/page?session=<harness session id>&slug=<the page's slug>
 *
 * The fetch half. Text rather than html because the reader is a model: the
 * markup is a third of the tokens and none of the meaning. A page longer than
 * the budget is cut at the budget and says so, with the address to read the
 * rest in a browser, rather than being silently shortened.
 */
export async function GET(req: Request) {
  const me = await identify(req);
  if (!me) return unauthenticated();

  const url = new URL(req.url);
  const session = (url.searchParams.get("session") ?? "").trim();
  const slug = (url.searchParams.get("slug") ?? "").trim();
  if (!session || !slug) return badRequest("session and slug are both required");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(session)) return badRequest("session is not a session id");
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(slug)) return badRequest("slug is not a slug");

  const doc = await pageText(me.userId, session, slug);
  // Somebody else's page and a page that does not exist are one answer.
  if (!doc) return Response.json({ error: "not_found" }, { status: 404 });

  const whole = doc.text ?? "";
  const text = whole.slice(0, MAX_TEXT);
  const cut = whole.length > text.length;

  return answer({
    title: doc.title, agent: doc.agent, session: doc.session, slug: doc.slug,
    at: doc.at, url: pageURL(originOf(req), doc.session, doc.slug),
    characters: whole.length,
    text,
    ...(cut ? { truncated_at: MAX_TEXT, note: "Cut to fit. Open the url for the rest." } : {}),
  });
}
