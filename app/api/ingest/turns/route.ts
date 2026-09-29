import { takeQuota } from "@/lib/quota";
import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";

export const runtime = "nodejs";

/** The most either half of a turn may carry into the database. */
const MAX_TEXT = 8_000;

type TurnIn = {
  session_id: string; source_key: string; at: string; topic?: string | null;
  headline?: string | null; deck?: string | null; happened?: string | null;
  findings?: string | null; solution?: string | null; rationale?: string | null;
  next_step?: string | null; question?: string | null; risk?: string | null;
  branch?: string | null; prompt?: string | null; prose?: string | null;
  agent_title?: string | null; cwd?: string | null;
};

/**
 * Accept a batch of turns from a laptop.
 *
 * A turn is the noun the hub is made of, and until this route existed the
 * only way one reached the app was a script writing to Postgres directly --
 * a second path beside /api/ingest, which the plan forbids. Idempotent on
 * (user, source_key): the drainer may resend anything, and a re-run of the
 * backfill is this same call over the whole store.
 *
 * An agent that talked and wrote nothing is still an agent, so the agent
 * row is upserted here too, named from the panel's own callsign.
 */
export async function POST(req: Request) {
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const turns: TurnIn[] = Array.isArray(body?.turns) ? body.turns : [];
  if (!turns.length) return Response.json({ error: "turns[] is required" }, { status: 400 });
  if (turns.length > 200) return Response.json({ error: "at most 200 turns per call" }, { status: 413 });
  for (const t of turns) {
    if (!t?.session_id || !t?.source_key || !t?.at || Number.isNaN(Date.parse(t.at))) {
      return Response.json({ error: "each turn needs session_id, source_key and an ISO at" }, { status: 400 });
    }
    // Cut rather than refuse: a long turn is still a turn, and a 413 here
    // would stall the mirror's cursor on it forever.
    // Every text field, not just the long ones: an uncapped headline was a
    // way to grow the database without limit (safety review, 29 Sep).
    for (const [k, v] of Object.entries(t) as [keyof TurnIn, unknown][]) {
      if (typeof v === "string" && v.length > MAX_TEXT) (t as Record<string, unknown>)[k] = `${v.slice(0, MAX_TEXT)}…`;
    }
  }
  const over = await takeQuota(me.userId, "turn", turns.length, Buffer.byteLength(JSON.stringify(turns), "utf8"));
  if (over) return over;

  const out = await asUser(me.userId, async (c) => {
    let written = 0;
    const agents = new Map<string, string>();
    for (const t of turns) {
      let agentId = agents.get(t.session_id);
      if (!agentId) {
        const a = await c.query(
          `insert into agents (user_id, source_session_id, title, cwd, first_seen_at, last_active_at)
             values ($1, $2, $3, $4, $5, $5)
           on conflict (user_id, source_session_id) do update
             -- The panel's name for a session wins, every time it changes:
             -- keeping the first name ever seen is how 73 agents stayed
             -- "New agent", the placeholder topic of a session's first brief.
             set title = coalesce(nullif(excluded.title, ''), agents.title),
                 cwd = coalesce(agents.cwd, excluded.cwd),
                 first_seen_at = least(agents.first_seen_at, excluded.first_seen_at),
                 last_active_at = greatest(agents.last_active_at, excluded.last_active_at)
           returning id`,
          [me.userId, t.session_id, t.agent_title ?? null, t.cwd ?? null, t.at],
        );
        agentId = a.rows[0].id as string;
        agents.set(t.session_id, agentId);
      }
    }
    // One statement for the whole batch. A turn per round trip against a
    // database in us-east-1 made the first full drain a ten-minute job; a
    // hundred rows through unnest is one.
    const col = <K extends keyof TurnIn>(k: K) => turns.map((t) => (t[k] ?? null) as string | null);
    const r = await c.query(
      `insert into turns (user_id, agent_id, source_key, at, topic, headline, deck,
                          happened, findings, solution, rationale,
                          next_step, question, risk, branch, prompt, prose)
       select $1, a.id, x.source_key, x.at::timestamptz, coalesce(x.topic, ''), x.headline, x.deck,
              x.happened, x.findings, x.solution, x.rationale,
              x.next_step, x.question, x.risk, x.branch, x.prompt, x.prose
         from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                     $8::text[], $9::text[], $10::text[], $11::text[], $12::text[],
                     $13::text[], $14::text[], $15::text[], $16::text[], $17::text[])
              as x(session_id, source_key, at, topic, headline, deck, happened, findings,
                   solution, rationale, next_step, question, risk, branch, prompt, prose)
         join agents a on a.source_session_id = x.session_id
       on conflict (user_id, source_key) do update set
         at=excluded.at, topic=excluded.topic, headline=excluded.headline,
         deck=excluded.deck, happened=excluded.happened, findings=excluded.findings,
         solution=excluded.solution, rationale=excluded.rationale,
         next_step=excluded.next_step, question=excluded.question,
         risk=excluded.risk, branch=excluded.branch,
         -- A resend that carries no words must not erase words already here:
         -- an older panel, or a transcript that has since been rotated away,
         -- would otherwise blank the columns on every re-drain.
         prompt=coalesce(excluded.prompt, turns.prompt),
         prose=coalesce(excluded.prose, turns.prose)
       returning (xmax = 0) as inserted`,
      [me.userId, col("session_id"), col("source_key"), col("at"), col("topic"), col("headline"),
       col("deck"), col("happened"), col("findings"), col("solution"), col("rationale"),
       col("next_step"), col("question"), col("risk"), col("branch"),
       col("prompt"), col("prose")],
    );
    written = r.rows.filter((x) => x.inserted).length;
    await c.query(
      `insert into ingest_heartbeat (user_id, device_name, last_seen_at)
       values ($1, $2, now())
       on conflict (user_id, device_name) do update set last_seen_at = now()`,
      [me.userId, body.device ?? "unknown"],
    );
    return { received: turns.length, inserted: written, agents: agents.size };
  });
  return Response.json(out, { status: 200 });
}
