/**
 * The shared shape of every answer this hub gives a machine.
 *
 * Settled by the research pass on 14 Sep (record:
 * 2026-09-14-agentic-search-over-the-hub). Four rules, each with a source:
 *
 *  1. SEARCH RETURNS POINTERS, CONTENT COMES ON A SECOND CALL. It is the one
 *     invariant across every vendor who has shipped agent-facing retrieval:
 *     OpenAI's connector spec mandates exactly search and fetch, Atlassian
 *     implemented the same pair independently, and the ones who ship sixteen
 *     or twenty-nine tools still keep the split inside them.
 *  2. EVERY RESULT CARRIES A URL, because that is what makes a citation
 *     possible. OpenAI's spec is explicit that citation metadata appears only
 *     when the url is a non-empty string.
 *  3. CONCISE BY DEFAULT, DETAIL ON REQUEST. Anthropic measured the same
 *     information at 206 tokens verbose and 72 pared down.
 *  4. THE ANSWER FITS. Claude Code caps a tool result at 25,000 tokens and
 *     expects the tool to paginate and truncate itself rather than be cut off.
 *     So every response here has a budget, says when it hit it, and hands back
 *     a cursor instead of a wall.
 *
 * And one rule of our own: the identifiers are the ones a person would
 * recognise, the harness session id and the page's slug, never the internal
 * uuid. Anthropic's guidance against "low-level technical identifiers" is the
 * general form; the specific reason here is that the session id is what the
 * agent already knows itself by.
 */

/** What a machine may ask for at once, whatever it asks for. */
export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 10;

/**
 * The character budget for one response body.
 *
 * Roughly 15,000 tokens at four characters a token, which leaves room under
 * the 25,000-token ceiling for the harness's own framing. A response that
 * would exceed it is cut at a whole result and says so.
 */
export const BUDGET = 60_000;

export function limitFrom(url: URL, fallback = DEFAULT_LIMIT): number {
  const raw = Number(url.searchParams.get("limit"));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

/** Whether the caller asked for the long form. */
export function detailed(url: URL): boolean {
  return (url.searchParams.get("detail") ?? "").toLowerCase() === "full";
}

/**
 * A cursor is an opaque string to the caller and an offset to us.
 *
 * Keyset pagination is better and is what /api/turns uses, because its order
 * is a timestamp. A ranked search has no such key: rank is computed per query
 * and ties are common, so the honest cheap answer is an offset, bounded so it
 * cannot become a way to walk the whole corpus one page at a time.
 */
export const MAX_OFFSET = 200;

export function offsetFrom(url: URL): number {
  const c = url.searchParams.get("cursor");
  if (!c) return 0;
  const n = Number(Buffer.from(c, "base64url").toString("utf8"));
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_OFFSET) : 0;
}

export function cursorFor(offset: number): string | null {
  return offset > 0 && offset <= MAX_OFFSET
    ? Buffer.from(String(offset), "utf8").toString("base64url") : null;
}

/**
 * Cut a list of results to the budget, at a whole result.
 *
 * Returns what fits and how many were dropped, so the answer can say "and 12
 * more, ask again with this cursor" rather than ending mid-sentence.
 */
export function withinBudget<T>(rows: T[], budget = BUDGET): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let size = 0;
  for (const r of rows) {
    const cost = JSON.stringify(r).length;
    if (size + cost > budget && kept.length > 0) break;
    kept.push(r);
    size += cost;
  }
  return { kept, dropped: rows.length - kept.length };
}

/** Where a person, or an agent that wants to link, opens this. */
export function pageURL(base: string, session: string, slug?: string | null): string {
  const u = new URL("/open", base);
  u.searchParams.set("session", session);
  if (slug) u.searchParams.set("slug", slug);
  return u.toString();
}

/**
 * The hub's own address, as the edge actually served it.
 *
 * Behind a proxy the request's host can be the internal one, and a url that
 * points at a machine nobody can reach is worse than no url at all.
 */
export function originOf(req: Request): string {
  const h = req.headers;
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "hq.tranquilitybase.dev";
  const proto = (h.get("x-forwarded-proto")?.split(",")[0] ?? "https").trim();
  return `${proto}://${host}`;
}

/** One shape for every answer, so a caller learns it once. */
export function answer(
  body: Record<string, unknown>,
  extra: { dropped?: number; cursor?: string | null } = {},
): Response {
  const out: Record<string, unknown> = { ...body };
  if (extra.dropped && extra.dropped > 0) {
    out.truncated = extra.dropped;
    out.note = `${extra.dropped} more result(s) did not fit; ask again with the cursor.`;
  }
  if (extra.cursor) out.cursor = extra.cursor;
  return Response.json(out, {
    headers: {
      // One reader, one account: never a shared cache. Short enough that a
      // polling agent is cheap and long enough that a burst of identical
      // questions is one query.
      "cache-control": "private, max-age=5",
    },
  });
}

export function unauthenticated(): Response {
  return Response.json({ error: "unauthenticated" }, { status: 401 });
}

export function badRequest(why: string): Response {
  return Response.json({ error: "invalid_request", detail: why }, { status: 400 });
}
