import { Fragment } from "react";
import Link from "next/link";
import { FULL_TURNS, type TurnRow, type DocRow } from "@/lib/queries";
import { when } from "./when";
import { Stamp, Day } from "./stamp";
import { dayKey } from "./day";
import { Clear } from "./clear";
import { Publish } from "./publish";

/**
 * The hub: a conversation, newest first, with each document sitting under
 * the turn that produced it.
 *
 * The thing this replaced was a flat list of files ranked by date, which
 * answers "what exists" -- a question nobody opens a hub to ask. What a
 * reader wants is what happened and what it produced, in that order, because
 * a report is only legible next to the turn that asked for it.
 *
 * Resolution degrades with age, borrowed from time-series downsampling
 * rather than from any rule about prose: the newest turns print every field,
 * older ones collapse to a headline and their documents. A hub that printed
 * four hundred turns in full would be a log file.
 */
// The query decides this too -- it only fetches verbatim text for the turns
// that print in full -- so the number lives there and both read it.
const FULL = FULL_TURNS;

export function Hub({ turns, byTurn, inFlight, showAgent, more = 0, index, empty }: {
  turns: TurnRow[];
  byTurn: Map<string, DocRow[]>;
  inFlight: DocRow[];
  showAgent: boolean;
  /** Turns that exist and are not printed. Named, never silently dropped. */
  more?: number;
  /** Every document, whether or not its turn is still on the page. */
  index?: DocRow[];
  /** What an empty stream says. Each page knows what is missing and what to
      do about it; "Nothing here yet" knows neither. */
  empty?: React.ReactNode;
  /** Whether this viewer is the account this hub publishes from. */
}) {
  if (turns.length === 0 && inFlight.length === 0) {
    return <p style={{ color: "var(--muted)" }}>{empty ?? "Nothing here yet."}</p>;
  }
  return (
    <ol className="hq-turns">
      {inFlight.length > 0 && (() => {
        // "Still in flight" is a claim about NOW, and it was being made about
        // an agent whose last turn was a month before its last document --
        // four-day-old files under a live-sounding heading. Documents newer
        // than every turn mean one of two things and the page should say
        // which: a turn genuinely still running, or a stretch of work no
        // brief ever covered.
        const newest = turns.length ? new Date(turns[0].at).getTime() : 0;
        const live = newest > 0 && Date.now() - newest < 2 * 3600 * 1000;
        return (
          <li className="hq-turn" data-tier="full">
            <div className="when">
              {live ? "since the last turn ended" : "after the last recorded turn"}
            </div>
            <div className="what">{live ? "Still in flight" : "Not filed under a turn"}</div>
            {!live && (
              <p className="h">
                Written after the newest turn this agent recorded, so no brief
                covers them.
              </p>
            )}
            <Made docs={inFlight} showAgent={showAgent} />
          </li>
        );
      })()}
      {/* A day header before the first turn of each day: Linear's changelog
          groups under a date, and a list of sixty turns reads as one run
          without it. Ruled 28 Sep 2026 from the editorial pass. */}
      {turns.map((t, i) => (
        <Fragment key={t.id}>
          {(i === 0 || dayKey(turns[i - 1].at) !== dayKey(t.at)) && (
            <li className="hq-day"><Day t={t.at} /></li>
          )}
          <Turn t={t} docs={byTurn.get(t.id) ?? []}
                full={i < FULL} showAgent={showAgent} />
        </Fragment>
      ))}
      {more > 0 && (
        <li className="hq-digest">
          Before that — {more} more {more === 1 ? "turn" : "turns"}.
          {index && index.length > 0
            ? " Everything they produced is in the index above."
            : ""}
        </li>
      )}
    </ol>
  );
}

/**
 * The index: every document, flat, newest first.
 *
 * The turn blocks below stop at a horizon; this does not. It is the answer
 * to "where is that report" for a page written eleven turns ago, which is a
 * question the turn structure alone answers badly. Since 1 Oct 2026 it sits
 * at the top of an agent's page, under the shipping tracker, and its lit
 * lamps are what the separate New list used to show.
 */
export function Index({ docs, showAgent }: { docs: DocRow[]; showAgent: boolean }) {
  if (docs.length === 0) return null;
  return (
    <section className="hq-index">
      <h2>Index &middot; {docs.length}</h2>
      <Made docs={docs} showAgent={showAgent} />
    </section>
  );
}

function Turn({ t, docs, full, showAgent }: {
  t: TurnRow; docs: DocRow[]; full: boolean; showAgent: boolean;
}) {
  const head = t.headline ?? t.topic;
  return (
    <li className="hq-turn" data-tier={full ? "full" : "line"}>
      <div className="when">
        <Stamp t={t.at} />
        {showAgent && (
          <>
            {" · "}
            <Link href={`/a/${t.agent_id}`} className="who">
              {t.agent_title ?? t.agent_session.slice(0, 8)}
            </Link>
          </>
        )}
        {t.branch && <span className="branch">{t.branch}</span>}
      </div>
      <div className="what">{head}</div>
      {full ? (
        <>
          {t.deck && <p className="deck">{t.deck}</p>}
          {t.happened && t.happened !== head && <p className="h">{t.happened}</p>}
          <Field label="found"    v={t.findings} />
          <Field label="proposes" v={t.solution} />
          <Field label="why"      v={t.rationale} />
          <Field label="next"     v={t.next_step} />
          <Field label="asked"    v={t.question} />
          <Field label="risk"     v={t.risk} risky />
          <Said prompt={t.prompt} prose={t.prose} thin={!t.headline} />
        </>
      ) : (
        t.deck && <p className="deck">{t.deck}</p>
      )}
      <Made docs={docs} showAgent={false} />
    </li>
  );
}

/**
 * What was said, verbatim: the prompt, then the agent's prose.
 *
 * The same two paragraphs the panel's own hub has printed under every turn
 * block for weeks, from the same source. A brief is a summary and the
 * transcript is the evidence; a summary with no way down to the source is a
 * claim you have to take on faith, and for the quarter of turns whose brief
 * is one sentence it is barely even a claim.
 *
 * Collapsed when there is a brief to read instead, because a hub is a summary
 * of a day and eight transcripts in a row is not that. Open when the brief is
 * that one thin sentence, because then this is the only account of the turn
 * there is and a click would hide the turn.
 */
function Said({ prompt, prose, thin }: {
  prompt: string | null; prose: string | null; thin: boolean;
}) {
  const asked = prompt?.trim() ? prompt : null;
  const said = prose?.trim() ? prose : null;
  if (!asked && !said) return null;
  return (
    <details className="hq-said" open={thin}>
      <summary>what was said</summary>
      {asked && <div className="said ask">{block(asked)}</div>}
      {said && <div className="said">{block(said)}</div>}
    </details>
  );
}

/**
 * The agent's markdown, rendered as the little of it that actually appears:
 * paragraphs, dash bullets, bold and inline code. Everything else prints as
 * itself. No html is ever built from this text -- it is a model's output
 * arriving from a laptop, and the only safe renderer for that is one that
 * makes React elements out of it.
 */
function block(text: string) {
  return text.trim().split(/\n{2,}/).map((para, i) => {
    const lines = para.split("\n");
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
      return (
        <ul key={i}>
          {lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*[-*]\s+/, ""))}</li>)}
        </ul>
      );
    }
    return <p key={i}>{inline(para)}</p>;
  });
}

function inline(s: string) {
  // One pass over **bold** and `code`, in source order, so a line carrying
  // both keeps them where they were written.
  const out: React.ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    out.push(m[1] ? <b key={k++}>{m[1]}</b> : <code key={k++}>{m[2]}</code>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function Field({ label, v, risky }: { label: string; v: string | null; risky?: boolean }) {
  if (!v || !v.trim()) return null;
  return (
    <p className={risky ? "m risky" : "m"}>
      <span className="tag">{label}</span>{v}
    </p>
  );
}

/**
 * What the turn made.
 *
 * TWO lamp states, filled and hollow, meaning unread and read. Nothing else.
 *
 * There were three. Amber meant "read and not cleared", and it could not
 * survive the question asked of it: what is a person supposed to DO about an
 * amber lamp on a two-week-old report? Either they made that decision long
 * ago or it did not matter, and no signal the system can compute distinguishes
 * those. A lamp has to mean an action is available, and on a document the only
 * true one is "you have not read this".
 *
 * So the metaphor stays consistent -- filled or not, the way a lamp is on or
 * off -- and read state is the only thing it claims. Clearing still exists as
 * an explicit human act; it just no longer pretends to be a light.
 */
function Made({ docs, showAgent }: { docs: DocRow[]; showAgent: boolean }) {
  if (docs.length === 0) return null;
  return (
    <ul className="made">
      {docs.map((d) => (
        <li key={d.id}>
          <span className="lamp" data-state={d.opened ? "read" : "unread"} />
          <a className="page" href={`/d/${d.id}`}>{d.title ?? d.slug}</a>
          {d.published_url && (
            <a className="live" href={d.published_url} target="_blank" rel="noopener"
               title={d.published_url}>published</a>
          )}
          <span className="when">
            {showAgent && d.agent_title ? d.agent_title + " · " : ""}
            {when(d.produced_at ?? d.created_at)}
          </span>
          <Clear id={d.id} cleared={d.cleared} />
          <Publish id={d.id} title={d.title ?? d.slug} published={!!d.published_at}
                   url={d.share_url} visibility={d.visibility} />
        </li>
      ))}
    </ul>
  );
}
