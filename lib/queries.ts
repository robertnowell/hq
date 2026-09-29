import { asUser } from "./db";
import { shareBase } from "./publishing";

export type AgentRow = {
  id: string; title: string | null; source_session_id: string;
  last_active_at: string; docs: number; unread: number; needs: number;
  turns: number; headline: string | null;
};
export type DocRow = {
  id: string; title: string | null; slug: string; produced_at: string | null;
  created_at: string; agent_id: string; agent_title: string | null;
  opened: boolean; cleared: boolean; published_url: string | null;
  /** Set only by a person pressing Share. */
  published_at: string | null; public_slug: string | null;
  /** private | team | link. Ruled 27 Sep 2026. */
  visibility: "private" | "team" | "link";
  /** Where this person's shared page is read: their site if they have one,
      else the hub's own address. Computed per account, not per row. */
  share_url: string | null;
};

/**
 * The sidebar: most recently moved at the top.
 *
 * It was a stack -- anything outstanding floated above recency, the August
 * ruling -- until 10 Sep, when Robert asked for the agent that just returned
 * to animate to the top. With several hundred agents carrying an unread
 * document, "outstanding first" had become "everything first", and a
 * returning agent whose pages you had read sat under all of them. Recency is
 * the order; the lamps stay on the rows as badges, which is where you look
 * for them.
 */
/** Whether this person has any agent at all: the front door's one question, without the agents query. */
export function hasAgents(userId: string) {
  return asUser(userId, async (c) => (await c.query<{ x: boolean }>(`select exists (select 1 from agents) as x`)).rows[0].x);
}

export function agents(userId: string) {
  return asUser(userId, async (c) => (await c.query<AgentRow>(AGENTS_SQL)).rows);
}

/**
 * Everything the sidebar needs that is the reader's own, in one statement
 * under their own policy (hq-app-cll.3, 29 Sep). The layout used to run the
 * agents and heartbeats queries as two transactions per request, plus four
 * or more calls for teams; with this and hq_sidebar_teams it is two.
 */
export type SidebarOwn = {
  agents: AgentRow[]; heartbeats: Heartbeat[];
  labels: { label: string; n: number }[]; needs: number;
};
export function sidebarOwn(userId: string) {
  return asUser(userId, async (c) => {
    const r = await c.query<SidebarOwn>(`
      with ag as (${AGENTS_SQL}),
      hb as (select device_name, last_seen_at, note from ingest_heartbeat
              order by last_seen_at desc limit 5),
      lb as (select l as label, count(*)::int as n from documents, unnest(labels) l
              group by l order by count(*) desc, l limit 12)
      select coalesce((select json_agg(ag) from ag), '[]') as agents,
             coalesce((select json_agg(hb) from hb), '[]') as heartbeats,
             coalesce((select json_agg(lb) from lb), '[]') as labels,
             (select count(*)::int from documents d
               where d.asks is not null
                 and not exists (select 1 from document_events e
                                  where e.document_id = d.id and e.kind = 'cleared')) as needs`);
    return r.rows[0];
  });
}

const AGENTS_SQL = `
      select a.id, a.title, a.source_session_id, a.last_active_at,
             count(d.id)::int as docs,
             -- IS NOT TRUE, not NOT. A LEFT JOIN LATERAL that matches
             -- nothing yields NULL, and "not NULL" is NULL rather than true,
             -- so a FILTER written the obvious way counts zero rows and every
             -- badge silently reads 0. That is what it did.
             count(*) filter (where d.id is not null
                                and e_open.seen is not true)::int as unread,
             -- "needs you" is a document that asks something (its own dark
             -- block, stored at ingest as asks) and that nobody has cleared.
             -- One definition, the same one /needs and the home read (28 Sep).
             count(*) filter (where d.asks is not null
                                and e_clear.seen is not true)::int as needs,
             -- Counted, not joined: joining turns as well would multiply the
             -- document rows by the turn rows and every badge would lie.
             coalesce(t.n, 0)::int as turns, t.headline
        from agents a
        left join documents d on d.agent_id = a.id
        -- LEFT, not INNER. An agent that talked for an hour and wrote no file
        -- is still an agent; the inner join hid 305 of them.
        left join lateral (
          select count(*) as n,
                 (array_agg(tt.headline order by tt.at desc)
                   filter (where tt.headline is not null))[1] as headline
            from turns tt where tt.agent_id = a.id) t on true
        left join lateral (select true as seen from document_events e
                            where e.document_id = d.id and e.kind='opened' limit 1) e_open on true
        left join lateral (select true as seen from document_events e
                            where e.document_id = d.id and e.kind='cleared' limit 1) e_clear on true
       group by a.id, t.n, t.headline
       order by a.last_active_at desc
       limit 500`;

export function documents(userId: string, agentId?: string) {
  return asUser(userId, async (c) => {
    const r = await c.query<DocRow>(`
      select d.id, d.title, d.slug, d.produced_at, d.created_at, d.agent_id,
             d.published_url, d.published_at, d.public_slug, d.visibility, a.title as agent_title,
             exists(select 1 from document_events e
                     where e.document_id=d.id and e.kind='opened')  as opened,
             exists(select 1 from document_events e
                     where e.document_id=d.id and e.kind='cleared')  as cleared
        from documents d join agents a on a.id = d.agent_id
       where ($1::uuid is null or d.agent_id = $1::uuid)
       order by coalesce(d.produced_at, d.created_at) desc
       limit 300`, [agentId ?? null]);
    const base = shareBase(userId);
    return r.rows.map((d) => ({
      ...d, share_url: d.public_slug ? `${base}/${d.public_slug}` : null,
    }));
  });
}

/**
 * Search document bodies, scoped to one user.
 *
 * The tenant predicate and the text predicate are in the same WHERE clause
 * against a (user_id, tsv) GIN index, so a search cannot cross a boundary
 * even if the index is not chosen -- and at this size the planner sensibly
 * prefers a scan, which returns in about 12ms.
 *
 * websearch_to_tsquery rather than plainto_tsquery: it accepts quoted
 * phrases and OR the way a person expects from a search box, and it never
 * throws on malformed input, which matters when the input is every
 * keystroke.
 */
export function search(userId: string, q: string) {
  return asUser(userId, async (c) => {
    const r = await c.query<DocRow & { rank: number; snippet: string }>(`
      select d.id, d.title, d.slug, d.produced_at, d.created_at, d.agent_id,
             a.title as agent_title,
             exists(select 1 from document_events e
                     where e.document_id=d.id and e.kind='opened')  as opened,
             exists(select 1 from document_events e
                     where e.document_id=d.id and e.kind='cleared') as cleared,
             ts_rank(d.tsv, websearch_to_tsquery('english', $1)) as rank,
             -- body_text, stripped once at write time. This used to strip
             -- markup from the full document on every query, which was 400 of
             -- the 500 ms a search took. The column was unaffordable while the
             -- html sat beside it; moving the html to the bucket made 7.7 MB
             -- of text cheap.
             ts_headline('english', coalesce(d.body_text, ''),
               websearch_to_tsquery('english', $1),
               'MaxWords=22, MinWords=8, ShortWord=3, MaxFragments=1, StartSel=<<, StopSel=>>'
             ) as snippet
        from documents d join agents a on a.id = d.agent_id
       where d.tsv @@ websearch_to_tsquery('english', $1)
       order by rank desc, coalesce(d.produced_at, d.created_at) desc
       limit 60`, [q]);
    return r.rows;
  });
}

/**
 * How many turns print in full, and so how many carry their verbatim text.
 *
 * It lives here rather than in the component because the query has to know:
 * the text is the largest column a turn has, and fetching it for turns that
 * will only ever render as a headline is the whole cost for none of the use.
 */
export const FULL_TURNS = 8;

export type TurnRow = {
  id: string; at: string; topic: string;
  headline: string | null; deck: string | null; happened: string | null;
  findings: string | null; solution: string | null; rationale: string | null;
  next_step: string | null; question: string | null; risk: string | null;
  branch: string | null; agent_id: string; agent_title: string | null;
  agent_session: string;
  /** The turn itself, verbatim from the harness transcript: what the person
      asked and what the agent said in prose. Null for older turns, which are
      past the tail the panel reads. */
  prompt: string | null; prose: string | null;
};

/**
 * A hub is a conversation, not a directory listing.
 *
 * This is the query the app was missing. `documents()` answers "what files
 * exist"; nobody opens a hub to ask that. They open it to ask what happened,
 * and a document is only interesting as the thing a particular turn produced.
 */
export function turns(userId: string, agentId?: string, limit = 40) {
  // Bounded here rather than trusted from the caller. It was a plain argument
  // and the pages pass 30 and 400; the moment a route passes a number from a
  // query string, an unbounded limit is a way to ask for everything.
  limit = Math.min(Math.max(Math.floor(limit), 1), 500);
  return asUser(userId, async (c) => {
    const r = await c.query<TurnRow>(`
      select t.id, t.at, t.topic, t.headline, t.deck, t.happened, t.findings,
             t.solution, t.rationale, t.next_step, t.question, t.risk, t.branch,
             -- The words only for the turns that will print them. A hub loads
             -- 400 turns to file its documents and renders thirty; at a
             -- kilobyte or two a turn, fetching every one's conversation is
             -- half a megabyte off the database to render eight of them.
             case when row_number() over (order by t.at desc) <= ${FULL_TURNS}
                  then t.prompt end as prompt,
             case when row_number() over (order by t.at desc) <= ${FULL_TURNS}
                  then t.prose end as prose,
             t.agent_id, a.title as agent_title,
             a.source_session_id as agent_session
        from turns t join agents a on a.id = t.agent_id
       where ($1::uuid is null or t.agent_id = $1::uuid)
       order by t.at desc
       limit $2`, [agentId ?? null, limit]);
    return r.rows;
  });
}

/**
 * Attach each document to the turn that made it.
 *
 * A brief is written when a turn ENDS; a document is written during it. So a
 * document belongs to the EARLIEST turn stamped at or after it -- not the
 * latest one before it, which would file every document one turn late. Both
 * sides are timestamped, so this is a join on a fact rather than on position;
 * aligning two lists by position is the guess that has gone wrong here before.
 *
 * Documents newer than every turn are from a turn still in progress and are
 * returned separately rather than forced onto the newest block, because a
 * turn that has not ended cannot yet claim anything.
 */
export function fileDocuments<T extends { produced_at: string | null; created_at: string }>(
  turns: { id: string; at: string }[], docs: T[],
) {
  const byTurn = new Map<string, T[]>();
  const inFlight: T[] = [];
  // Turns arrive newest-first; walk oldest-first so the first match is the
  // earliest turn at or after the document.
  const asc = [...turns].reverse();
  const stamps = asc.map((t) => new Date(t.at).getTime());
  for (const d of docs) {
    const at = new Date(d.produced_at ?? d.created_at).getTime();
    // Binary search for the first turn stamped at or after this document.
    let lo = 0, hi = asc.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (stamps[mid] < at) lo = mid + 1; else hi = mid; }
    if (lo === asc.length) { inFlight.push(d); continue; }
    const key = asc[lo].id;
    (byTurn.get(key) ?? byTurn.set(key, []).get(key)!).push(d);
  }
  return { byTurn, inFlight };
}

export type Heartbeat = { device_name: string; last_seen_at: string; note: string | null };

/**
 * When each laptop last drained into the app, and what it said.
 *
 * The mirror is a hook-driven drain, so a long silence while nothing is
 * being written is normal and a run that failed is not. Both are printed;
 * neither is inferred.
 */
export function heartbeats(userId: string) {
  return asUser(userId, async (c) => {
    const r = await c.query<Heartbeat>(
      `select device_name, last_seen_at, note from ingest_heartbeat
        order by last_seen_at desc limit 5`);
    return r.rows;
  });
}

// ---------------------------------------------------------------- the read API
//
// The queries behind /api/agents, /api/search, /api/turns and /api/page.
// Separate from the ones above because they answer a machine rather than draw
// a page: they take bounded limits, they never return a body inside a list,
// and they carry the identifiers an agent already knows itself by (the
// harness session id, the page's slug) rather than our own uuids.

export type AgentBrief = {
  agent: string | null; session: string; last_active: string;
  turns: number; pages: number; headline: string | null; cwd: string | null;
};

/**
 * Who has moved lately, and the last thing each said.
 *
 * The answer to "what is everyone working on". Ordered by recency because
 * that is what the question means; bounded because the caller is a machine
 * that will happily ask for everything.
 */
export function agentBriefs(userId: string, opts: { days?: number; limit?: number } = {}) {
  const days = Math.min(Math.max(opts.days ?? 7, 1), 365);
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  return asUser(userId, async (c) => {
    const r = await c.query<AgentBrief>(`
      select a.title as agent, a.source_session_id as session,
             a.last_active_at as last_active, a.cwd,
             coalesce(t.n, 0)::int as turns,
             coalesce(d.n, 0)::int as pages,
             t.headline
        from agents a
        left join lateral (
          select count(*) as n,
                 (array_agg(tt.headline order by tt.at desc)
                   filter (where tt.headline is not null))[1] as headline
            from turns tt where tt.agent_id = a.id) t on true
        left join lateral (
          select count(*) as n from documents dd where dd.agent_id = a.id) d on true
       where a.last_active_at > now() - ($1 || ' days')::interval
       order by a.last_active_at desc
       limit $2`, [String(days), limit]);
    return r.rows;
  });
}

export type Hit = {
  kind: "turn" | "page";
  title: string | null; agent: string | null; session: string;
  slug: string | null; at: string; snippet: string; rank: number;
};

/**
 * One search across both kinds of thing an agent leaves behind.
 *
 * Pages are matched on the stored tsvector, which is indexed. Turns are
 * matched on their text built at query time: there are a few thousand of them
 * and they are short, so the scan is cheap, and a generated column plus an
 * index is the change to make when that stops being true rather than before.
 *
 * The snippet is one fragment, because the result is a pointer. Whoever wants
 * the rest of it asks for the page. ts_headline will not accept empty
 * delimiters, so it keeps its default bold tags and the route strips them: a
 * machine reader wants the sentence, not the emphasis.
 */
export function searchAll(
  userId: string,
  q: string,
  opts: { kind?: "turns" | "pages" | "both"; limit?: number; offset?: number } = {},
) {
  const kind = opts.kind ?? "both";
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const offset = Math.min(Math.max(opts.offset ?? 0, 0), 200);
  return asUser(userId, async (c) => {
    const parts: string[] = [];
    if (kind !== "turns") {
      parts.push(`
        select 'page'::text as kind, d.title, a.title as agent,
               a.source_session_id as session, d.slug,
               coalesce(d.produced_at, d.created_at) as at,
               ts_headline('english', coalesce(d.body_text, ''),
                 websearch_to_tsquery('english', $1),
                 'MaxWords=34, MinWords=12, ShortWord=3, MaxFragments=1') as snippet,
               ts_rank(d.tsv, websearch_to_tsquery('english', $1)) as rank
          from documents d join agents a on a.id = d.agent_id
         where d.tsv @@ websearch_to_tsquery('english', $1)`);
    }
    if (kind !== "pages") {
      parts.push(`
        select 'turn'::text as kind, t.headline as title, a.title as agent,
               a.source_session_id as session, null::text as slug,
               t.at,
               -- The brief first, because it is the written summary and reads
               -- better than a fragment of the transcript; the verbatim words
               -- only when the brief is the one thin sentence that IS the
               -- topic, which is about a quarter of turns.
               left(coalesce(
                 nullif(concat_ws(' ', t.deck, t.findings, t.next_step,
                                  t.question, t.risk), ''),
                 t.prose, t.happened), 400) as snippet,
               ts_rank(to_tsvector('english',
                 concat_ws(' ', t.headline, t.deck, t.happened, t.findings,
                           t.solution, t.rationale, t.next_step, t.question,
                           t.risk, t.prompt, t.prose)),
                 websearch_to_tsquery('english', $1)) as rank
          from turns t join agents a on a.id = t.agent_id
         where to_tsvector('english',
                 concat_ws(' ', t.headline, t.deck, t.happened, t.findings,
                           t.solution, t.rationale, t.next_step, t.question,
                           t.risk, t.prompt, t.prose))
               @@ websearch_to_tsquery('english', $1)`);
    }
    const r = await c.query<Hit>(
      `${parts.join(" union all ")}
       order by rank desc, at desc
       limit $2 offset $3`, [q, limit, offset]);
    return r.rows;
  });
}

export type TurnBrief = {
  at: string; headline: string | null; deck: string | null;
  next_step: string | null; question: string | null; risk: string | null;
  topic: string; session: string; agent: string | null;
  findings?: string | null; solution?: string | null;
  rationale?: string | null; happened?: string | null;
  prompt?: string | null; prose?: string | null;
};

/**
 * What one agent has said, newest first.
 *
 * Keyset paginated on the timestamp, which is the order, so a caller walking
 * backwards cannot be shown the same turn twice or skip one when a new turn
 * lands mid-walk.
 */
export function turnsFor(
  userId: string,
  opts: { session?: string; before?: string; limit?: number; detail?: boolean } = {},
) {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const long = opts.detail === true;
  return asUser(userId, async (c) => {
    const r = await c.query<TurnBrief>(`
      select t.at, t.headline, t.deck, t.next_step, t.question, t.risk, t.topic,
             a.source_session_id as session, a.title as agent
             ${long ? ", t.happened, t.findings, t.solution, t.rationale, t.prompt, t.prose" : ""}
        from turns t join agents a on a.id = t.agent_id
       where ($1::text is null or a.source_session_id = $1
              or a.source_session_id = left($1, 8))
         and ($2::timestamptz is null or t.at < $2::timestamptz)
       order by t.at desc
       limit $3`, [opts.session ?? null, opts.before ?? null, limit]);
    return r.rows;
  });
}

export type PageText = {
  title: string | null; slug: string; session: string; agent: string | null;
  at: string; text: string;
};

/**
 * One page, as text, by the two things an agent already knows.
 *
 * The fetch half of search-then-fetch. Text rather than html because the
 * caller is a model: the markup is a third of the tokens and none of the
 * meaning. The bytes stay in the bucket; this reads the stripped copy the
 * search already indexes.
 */
export function pageText(userId: string, session: string, slug: string) {
  return asUser(userId, async (c) => {
    const r = await c.query<PageText>(`
      select d.title, d.slug, a.source_session_id as session, a.title as agent,
             coalesce(d.produced_at, d.created_at) as at,
             coalesce(d.body_text, '') as text
        from documents d join agents a on a.id = d.agent_id
       where (a.source_session_id = $1 or a.source_session_id = left($1, 8))
         and d.slug = $2
       order by coalesce(d.produced_at, d.created_at) desc
       limit 1`, [session, slug]);
    return r.rows[0] ?? null;
  });
}

export type PageBrief = { title: string | null; slug: string; at: string; opened: boolean };

/**
 * One agent's newest pages, as pointers. The Mac's Hub window lists five
 * under each agent in its sidebar (tranquility-base hf-o8t, 29 Sep 2026);
 * the web sidebar never needed a list endpoint because it renders server
 * side. `opened` is the owner's lamp, the same fact the web view reads.
 */
export function pagesFor(userId: string, session: string, limit = 5) {
  const n = Math.min(Math.max(limit, 1), 50);
  return asUser(userId, async (c) => {
    const r = await c.query<PageBrief>(`
      select d.title, d.slug, coalesce(d.produced_at, d.created_at) as at,
             exists(select 1 from document_events e
                     where e.document_id = d.id and e.kind = 'opened') as opened
        from documents d join agents a on a.id = d.agent_id
       where a.source_session_id = $1 or a.source_session_id = left($1, 8)
       order by coalesce(d.produced_at, d.created_at) desc
       limit $2`, [session, n]);
    return r.rows;
  });
}

export type NeedsRow = {
  id: string; title: string | null; slug: string; asks: string;
  at: string; agent_id: string; agent_title: string | null; opened: boolean;
};

/**
 * Every document of mine that asks something and that nobody has cleared,
 * newest first. The one definition of "needs you" (28 Sep, hq-app-cll.8):
 * the sidebar count and the home block read the same rows.
 */
export function needsYou(userId: string, limit = 100) {
  return asUser(userId, async (c) => {
    const r = await c.query<NeedsRow>(`
      select d.id, d.title, d.slug, d.asks, coalesce(d.produced_at, d.created_at) as at,
             a.id as agent_id, a.title as agent_title,
             exists (select 1 from document_events e
                      where e.document_id = d.id and e.kind = 'opened') as opened
        from documents d join agents a on a.id = d.agent_id
       where d.asks is not null
         and not exists (select 1 from document_events e
                          where e.document_id = d.id and e.kind = 'cleared')
       order by coalesce(d.produced_at, d.created_at) desc
       limit $1`, [Math.max(1, Math.min(limit, 500))]);
    return r.rows;
  });
}
