import { takeQuota } from "@/lib/quota";
import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";

export const runtime = "nodejs";

/** The most one note may carry into the database. */
const MAX_TEXT = 8_000;
/** The most one call may carry. The Mac sends at most this many per batch. */
const MAX_NOTES = 500;
const SOURCES = new Set(["handsfree", "dictation"]);

type NoteIn = {
  source_key: string; at: string; source: string; kind?: string | null;
  text: string; agent_session?: string | null; agent_name?: string | null;
};

/**
 * Accept a batch of things the developer said, from a laptop.
 *
 * Idempotent on (user, source_key), like every mirrored record: the Mac may
 * resend anything, a backfill is this same call over the whole of its
 * history, and a dictation whose words or status changed after it was first
 * sent is sent again and updated in place.
 *
 * Nothing here creates an agent. A dictation names the session it went to,
 * and the page reads that session's current name through `agents` when the
 * hub knows it; a note is not evidence that an agent exists.
 */
export async function POST(req: Request) {
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const notes: NoteIn[] = Array.isArray(body?.notes) ? body.notes : [];
  if (!notes.length) return Response.json({ error: "notes[] is required" }, { status: 400 });
  if (notes.length > MAX_NOTES) {
    return Response.json({ error: `at most ${MAX_NOTES} notes per call` }, { status: 413 });
  }
  for (const n of notes) {
    if (typeof n?.source_key !== "string" || !n.source_key || typeof n.at !== "string"
        || Number.isNaN(Date.parse(n.at)) || !SOURCES.has(n.source)
        || typeof n.text !== "string") {
      return Response.json(
        { error: "each note needs source_key, an ISO at, source handsfree|dictation, and text" },
        { status: 400 });
    }
    // Cut rather than refuse: a long dictation is still a dictation, and a
    // 413 here would stall the mirror's cursor on it forever.
    if (n.text.length > MAX_TEXT) n.text = `${n.text.slice(0, MAX_TEXT)}…`;
  }
  const over = await takeQuota(me.userId, "note", notes.length, Buffer.byteLength(JSON.stringify(notes), "utf8"));
  if (over) return over;
  // One key, one row per call. Postgres refuses an upsert that touches the
  // same row twice in one statement, so a batch that repeats a key keeps the
  // last copy, which is the newest thing the Mac knew.
  const byKey = new Map<string, NoteIn>();
  for (const n of notes) byKey.set(n.source_key, n);
  const rows = [...byKey.values()];

  const out = await asUser(me.userId, async (c) => {
    const col = <K extends keyof NoteIn>(k: K) =>
      rows.map((n) => (typeof n[k] === "string" && n[k] !== "" ? n[k] : null) as string | null);
    const r = await c.query(
      `insert into notes (user_id, source_key, at, source, kind, text, agent_session, agent_name)
       select $1, x.source_key, x.at::timestamptz, x.source, x.kind, coalesce(x.text, ''),
              x.agent_session, x.agent_name
         from unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[])
              as x(source_key, at, source, kind, text, agent_session, agent_name)
       on conflict (user_id, source_key) do update set
         at = excluded.at, text = excluded.text, kind = excluded.kind,
         agent_session = excluded.agent_session,
         -- A resend that could not name the agent must not erase a name
         -- already here: the session may have left the Mac's store since.
         agent_name = coalesce(excluded.agent_name, notes.agent_name)
       returning (xmax = 0) as inserted`,
      [me.userId, col("source_key"), col("at"), col("source"), col("kind"), col("text"),
       col("agent_session"), col("agent_name")],
    );
    await c.query(
      `insert into ingest_heartbeat (user_id, device_name, last_seen_at)
       values ($1, $2, now())
       on conflict (user_id, device_name) do update set last_seen_at = now()`,
      [me.userId, body.device ?? "unknown"],
    );
    return { received: notes.length, inserted: r.rows.filter((x) => x.inserted).length };
  });
  return Response.json(out, { status: 200 });
}
