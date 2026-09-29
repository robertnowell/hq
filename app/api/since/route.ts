import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What has arrived since a moment.
 *
 * Polled, not streamed. On this runtime a long-lived connection is capped by
 * the function's max duration and dies on a timer regardless, so reconnect
 * and catch up is the normal path either way -- and polling is that with no
 * resumption state to get wrong and no proxy able to buffer the stream into
 * silence. A failed poll is a failed request, which is visible.
 */
export async function GET(req: Request) {
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const since = new URL(req.url).searchParams.get("since");
  // A malformed timestamp used to reach Postgres, raise, and come back as a
  // 500. The caller's mistake is a 400, and saying so is the difference
  // between a client that fixes itself and one that retries forever.
  if (since !== null && Number.isNaN(Date.parse(since))) {
    return Response.json({ error: "invalid_request", detail: "since must be a timestamp" },
                         { status: 400 });
  }
  const { docs, turns } = await asUser(me.userId, async (c) => {
    const d = await c.query(
      `select d.id, d.title, d.slug, d.created_at, a.title as agent_title
         from documents d join agents a on a.id = d.agent_id
        where d.created_at > coalesce($1::timestamptz, now())
        order by d.created_at desc limit 20`,
      [since],
    );
    // A turn is an agent coming back. It is announced by when it ARRIVED,
    // not by when it happened: a backfilled turn from last week is not news,
    // and a turn from a minute ago that reached the app just now is.
    const t = await c.query(
      `select t.id, t.agent_id, t.headline, t.topic, t.question, t.ingested_at,
              a.title as agent_title
         from turns t join agents a on a.id = t.agent_id
        where t.ingested_at > coalesce($1::timestamptz, now())
        order by t.ingested_at desc limit 20`,
      [since],
    );
    return { docs: d.rows, turns: t.rows };
  });
  return Response.json({ now: new Date().toISOString(), arrived: docs, turns });
}
