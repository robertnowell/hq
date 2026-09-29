import { asUser } from "./db";

/** How many notes one page of the stream prints. */
export const NOTES_PAGE = 300;
/** Two lines further apart than this are two chunks, whoever they went to. */
export const CHUNK_GAP_MS = 2 * 60_000;

export type NoteSource = "handsfree" | "dictation";

export type NoteRow = {
  source_key: string;
  at: string;
  /** `at` as Postgres prints it, full precision, for the Older link. */
  at_key: string;
  source: NoteSource;
  kind: string | null;
  text: string;
  agent_session: string | null;
  /** The hub's current name for the session, else the one the Mac sent. */
  agent_name: string | null;
};

export type NoteFilter = {
  source?: NoteSource;
  /** An agent's name, as the dropdown lists it. */
  agent?: string;
  q?: string;
  /** The Older cursor: notes strictly before this (at, source_key). */
  before?: { at: string; key: string };
};

/**
 * One page of the stream, newest first, plus one row to know if there is more.
 *
 * Search is the document search's rule -- websearch_to_tsquery against the
 * stored vector, under the tenant column in one GIN index -- except for a
 * query of one or two characters ("ok", "PR", "5"), or one made only of
 * stop words ("the", "to be"), which the English vector cannot find because
 * it never holds them. Those fall back to a substring match, which on one
 * person's notes is a scan of a few thousand short rows.
 *
 * The agent filter matches the name the page shows, so it goes through the
 * same coalesce as the column rather than the raw `agent_name`.
 */
export function notes(userId: string, f: NoteFilter = {}) {
  return asUser(userId, async (c) => {
    const q = (f.q ?? "").trim();
    const short = q.length > 0 && q.length < 3;
    const r = await c.query<NoteRow>(`
      select n.source_key,
             -- ISO text, not a Date. pg hands a timestamptz back as a Date,
             -- and a Date that meets Date.parse is first printed without its
             -- milliseconds, which reorders lines said within one second.
             to_char(n.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at,
             n.at::text as at_key, n.source, n.kind, n.text,
             n.agent_session, coalesce(nullif(a.title, ''), n.agent_name) as agent_name
        from notes n
        left join agents a on a.user_id = n.user_id and a.source_session_id = n.agent_session
       where n.user_id = hq_current_user_id()
         and ($1::text is null or n.source = $1)
         and ($2::text is null or coalesce(nullif(a.title, ''), n.agent_name) = $2)
         and ($3::text is null or case
               -- Every constant here is known when the statement is planned,
               -- so the planner folds the case and keeps the index for words.
               when $5::boolean or numnode(websearch_to_tsquery('english', $3)) = 0
                 then n.text ilike '%' || $4 || '%'
               else n.tsv @@ websearch_to_tsquery('english', $3) end)
         and ($6::timestamptz is null or (n.at, n.source_key) < ($6::timestamptz, $7::text))
       order by n.at desc, n.source_key desc
       limit $8`,
      [f.source ?? null, f.agent ?? null, q || null, escapeLike(q), short,
       f.before?.at ?? null, f.before?.key ?? "", NOTES_PAGE + 1]);
    return { rows: r.rows.slice(0, NOTES_PAGE), more: r.rows.length > NOTES_PAGE };
  });
}

/** The names the agent dropdown offers: every agent a dictation went to. */
export function noteAgents(userId: string) {
  return asUser(userId, async (c) => {
    const r = await c.query<{ name: string }>(`
      select distinct coalesce(nullif(a.title, ''), n.agent_name) as name
        from notes n
        left join agents a on a.user_id = n.user_id and a.source_session_id = n.agent_session
       where n.user_id = hq_current_user_id()
         and n.agent_session is not null
         and coalesce(nullif(a.title, ''), n.agent_name) is not null
       order by 1`);
    return r.rows.map((x) => x.name);
  });
}

/** `%` and `_` are the user's characters, not wildcards. */
function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export type Chunk = {
  key: string;
  source: NoteSource;
  agent_session: string | null;
  agent_name: string | null;
  /** When the first line of the chunk was said. */
  at: string;
  /** In the order said, oldest first. */
  lines: { key: string; at: string; text: string; kind: string | null }[];
};

/**
 * Newest-first notes into newest-first chunks of lines in the order said.
 *
 * A chunk is a run of notes with the same source and the same agent session,
 * each said within two minutes of the one before: one breath of dictation to
 * one agent, or one stretch of talk in hands-free. Anything else between them
 * -- a different agent, the other source, or a pause -- starts a new chunk.
 */
export function chunk(rows: Pick<NoteRow, "source_key" | "at" | "source" | "kind" | "text"
  | "agent_session" | "agent_name">[], gapMs = CHUNK_GAP_MS): Chunk[] {
  const out: Chunk[] = [];
  // Walk oldest first, so "the previous note" means the one said before.
  const asc = [...rows].sort((a, b) =>
    Date.parse(a.at) - Date.parse(b.at) || (a.source_key < b.source_key ? -1 : 1));
  let cur: Chunk | null = null;
  let last = 0;
  for (const n of asc) {
    const t = Date.parse(n.at);
    const joins = cur !== null && cur.source === n.source
      && cur.agent_session === (n.agent_session ?? null) && t - last <= gapMs;
    if (!joins) {
      cur = { key: n.source_key, source: n.source, agent_session: n.agent_session ?? null,
              agent_name: n.agent_name ?? null, at: n.at, lines: [] };
      out.push(cur);
    }
    cur!.lines.push({ key: n.source_key, at: n.at, text: n.text, kind: n.kind });
    last = t;
  }
  return out.reverse();
}
