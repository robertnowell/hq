import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";
import { turns as loadTurns, documents as loadDocs, fileDocuments } from "@/lib/queries";
import { Hub, Index, Fresh } from "../../../hub";
import { Find } from "../../../find";
import { Stamp } from "../../../stamp";
import { Shipping } from "../../../shipping";

export const dynamic = "force-dynamic";

/**
 * One agent's hub.
 *
 * The head is the same three lines the panel's own hub prints: what this
 * agent is called, the headline of its newest turn, and the deck saying what
 * is left. Then the byline -- session, working directory, when it last moved
 * -- because a hub with no provenance is just a page of claims.
 */
export default async function AgentPage(
  { params, searchParams }: {
    params: Promise<{ id: string }>;
    searchParams: Promise<{ q?: string }>;
  },
) {
  const { id } = await params;
  const { q } = await searchParams;
  const h = await headers();
  const me = await identify(new Request("http://local", { headers: h }));
  if (!me) notFound();

  // A truncated or mistyped id is a 404, not a 500. Postgres rejects a
  // malformed uuid with an error, so without this a hand-edited URL returns
  // a server error page -- which reads as "the app is broken" rather than
  // "no such agent".
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) notFound();

  const a = await asUser(me.userId, async (c) => {
    const r = await c.query(
      `select id, title, source_session_id, cwd, last_active_at from agents where id = $1`,
      [id]);
    return r.rows[0] ?? null;
  });
  // Somebody else's agent and a nonexistent agent are the same 404.
  if (!a) notFound();

  const query = (q ?? "").trim();
  // Load enough turns to file every document correctly, then render only the
  // recent horizon. Filing needs the whole timeline; the reader does not --
  // 400 turn blocks was an 810 KB page, which is a log file with a stylesheet.
  const [ts, docs] = await Promise.all([
    loadTurns(me.userId, id, 400),
    loadDocs(me.userId, id),
  ]);
  const { byTurn, inFlight } = fileDocuments(ts, docs);
  const HORIZON = 30;
  const shown = ts.slice(0, HORIZON);
  const latest = ts[0];
  // "Last moved" mixed a page landing at 8:40 with a last turn at 8:16 and
  // read as a contradiction. Say which is which.
  const newestPage = docs.map((d) => d.produced_at ?? d.created_at).sort().pop() ?? null;
  const cwd = a.cwd ? a.cwd.split("/").filter(Boolean).pop() : null;

  return (
    <>
      <p className="hq-kicker">Agent</p>
      {/* The house shape, 27 Sep 2026: the name at headline size, the newest
          claim in bold at the head of the lede, then the dark block saying
          what needs you. The same three levels every report opens with, and
          the same ones the panel's own hub took the same day. */}
      <h1 className="hq-h1 hq-h1--name">{a.title ?? a.source_session_id.slice(0, 8)}</h1>
      {(latest?.headline || latest?.deck) && (
        <p className="hq-lede">
          {latest?.headline && <b>{latest.headline}</b>}
          {latest?.headline && latest?.deck && " "}
          {latest?.deck}
        </p>
      )}
      <div className="hq-you">
        <p className="k">
          {latest?.question ? "Needs you · one question"
            : latest?.next_step ? "Proposes next · nothing to decide yet"
            : "Nothing to decide"}
        </p>
        <p className="q">{latest?.question ?? latest?.next_step ?? "The last turn asked nothing of you."}</p>
      </div>
      {/* The facts strip: the postmortem's metadata block, in numbers, under
          the needs-you block. Ruled 28 Sep 2026 from the editorial pass. */}
      <dl className="hq-facts">
        <dt>Turns</dt><dd>{ts.length}</dd>
        <dt>Documents</dt><dd>{docs.length}</dd>
        <dt>Unread</dt><dd>{docs.filter((d) => !d.opened).length}</dd>
        <dt>Last turn</dt><dd>{latest?.at ? <Stamp t={latest.at} /> : "—"}</dd>
      </dl>
      <p className="hq-byline">
        session {a.source_session_id.slice(0, 8)}
        {cwd && <> &middot; in {cwd}</>}
        {newestPage && (!latest?.at || newestPage > latest.at) && <> &middot; a page at <Stamp t={newestPage} /></>}
        {!latest?.at && !newestPage && a.last_active_at && <> &middot; last moved <Stamp t={a.last_active_at} /></>}
      </p>
      {/* The fundamental thing an agent page is FOR: getting back into the
          conversation that wrote all of this. It was reachable only from a
          footer inside a page, which meant an agent with no pages had no way
          back at all.

          This one carries the SESSION, because the conversation is what an
          agent page is about. A document's bar carries a ref instead and
          starts a fresh agent on that page; the two are different questions
          and the panel routes on which parameter arrives. */}
      <p>
        <a className="hq-discuss"
           href={`tranquilitybase://discuss?session=${encodeURIComponent(a.source_session_id)}`}>
          Discuss with agent
        </a>
      </p>
      <Shipping session={a.source_session_id} />
      <Find.Box initial={query} />
      {query
        ? <Find userId={me.userId} q={query} back={`/a/${id}`} />
        : <>
            <Fresh docs={docs} showAgent={false} />
            <Hub turns={shown} byTurn={byTurn} inFlight={inFlight}
                 empty="This agent has not finished a turn yet. Its first one will appear here."
                 showAgent={false} more={Math.max(0, ts.length - shown.length)}
                 index={docs} />
            <Index docs={docs} showAgent={false} />
          </>}
    </>
  );
}
