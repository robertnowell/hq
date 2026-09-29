import { identify } from "@/lib/auth";
import { agentBriefs } from "@/lib/queries";
import { answer, limitFrom, originOf, pageURL, unauthenticated, withinBudget }
  from "@/lib/read-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Who is working, on what, and when they last moved.
 *
 * The answer to the question that started this: "what is everyone working on".
 * It reads as a list of agents with their last headline, which is the thing a
 * person or a model actually wants, rather than a page of rows to interpret.
 *
 *   GET /api/agents?active=7d&limit=10
 *
 * Every row carries the session id the agent knows itself by and a url that
 * opens it, so the next call is obvious without being explained.
 */
export async function GET(req: Request) {
  const me = await identify(req);
  if (!me) return unauthenticated();

  const url = new URL(req.url);
  const active = url.searchParams.get("active") ?? "7d";
  const days = Number(active.replace(/[^0-9.]/g, "")) || 7;
  const rows = await agentBriefs(me.userId, { days, limit: limitFrom(url) });

  const origin = originOf(req);
  const { kept, dropped } = withinBudget(rows.map((r) => ({
    agent: r.agent, session: r.session, last_active: r.last_active,
    turns: r.turns, pages: r.pages, headline: r.headline,
    working_in: r.cwd ? r.cwd.split("/").filter(Boolean).slice(-2).join("/") : null,
    url: pageURL(origin, r.session),
  })));

  return answer({ agents: kept, active_within: `${days}d` }, { dropped });
}
