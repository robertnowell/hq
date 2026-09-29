import { identify } from "@/lib/auth";
import { turnsFor } from "@/lib/queries";
import { answer, detailed, limitFrom, originOf, pageURL, unauthenticated, withinBudget }
  from "@/lib/read-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What an agent has said, newest first.
 *
 *   GET /api/turns?session=<harness session id>&limit=10&before=<iso>&detail=full
 *
 * Concise by default: the headline, the deck, what is next, what it is asking
 * and what it thinks the risk is. `detail=full` adds what happened, what it
 * found, what it proposes and why, and the turn itself: what was asked and
 * what the agent said, verbatim. That roughly triples the size and is usually
 * not wanted. Without a session it is every agent, which is the
 * cheapest way to read the whole account's last hour.
 */
export async function GET(req: Request) {
  const me = await identify(req);
  if (!me) return unauthenticated();

  const url = new URL(req.url);
  const before = url.searchParams.get("before");
  if (before && Number.isNaN(Date.parse(before))) {
    return Response.json({ error: "invalid_request", detail: "before must be a timestamp" },
                         { status: 400 });
  }
  const limit = limitFrom(url);
  const rows = await turnsFor(me.userId, {
    session: url.searchParams.get("session") ?? undefined,
    before: before ?? undefined,
    limit: limit + 1,
    detail: detailed(url),
  });
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const origin = originOf(req);

  const { kept, dropped } = withinBudget(page.map((t) => ({
    at: t.at, agent: t.agent, session: t.session, topic: t.topic,
    headline: t.headline, deck: t.deck,
    next_step: t.next_step, question: t.question, risk: t.risk,
    ...(t.happened !== undefined ? {
      happened: t.happened, findings: t.findings,
      solution: t.solution, rationale: t.rationale,
      // The turn itself. By far the largest thing a turn carries, which is
      // exactly why it is behind detail=full, and null on turns older than
      // the tail of the transcript the panel reads.
      prompt: t.prompt, prose: t.prose,
    } : {}),
    url: pageURL(origin, t.session),
  })));

  const last = kept[kept.length - 1];
  return answer({ turns: kept },
    // Keyset, not offset: the order is a timestamp, so "older than the last
    // one you saw" cannot repeat or skip a turn when a new one lands.
    { dropped, cursor: (more || dropped > 0) && last
        ? Buffer.from(String(last.at)).toString("base64url") : null });
}
