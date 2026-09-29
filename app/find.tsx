import { Suspense } from "react";
import { search as runSearch } from "@/lib/queries";
import { SearchBox } from "./search-box";
import { when } from "./when";
import { Clear } from "./clear";

/**
 * Search results are a list, and that is correct.
 *
 * A hub is turn-structured because a reader browsing it wants context; a
 * reader who typed a query has already supplied the context and wants the
 * matching lines. The two views answer different questions, so they are
 * allowed to look different.
 */
export async function Find({ userId, q, back }: {
  userId: string; q: string; back: string;
}) {
  const hits = await runSearch(userId, q);
  return (
    <>
      <p className="hq-sub">
        {hits.length === 60 ? "60+" : hits.length} matching
        {hits.length === 1 ? " document" : " documents"} for{" "}
        <b style={{ color: "var(--heading)" }}>{q}</b>
        {" · "}<a href={back} style={{ color: "var(--accent)" }}>clear</a>
      </p>
      <ul className="made hits">
        {hits.map((d) => (
          <li key={d.id}>
            <span className="lamp" data-state={d.opened ? "read" : "unread"} />
            <a className="page" href={`/d/${d.id}`}>{d.title ?? d.slug}</a>
            <span className="when">
              {d.agent_title ? d.agent_title + " · " : ""}
              {when(d.produced_at ?? d.created_at)}
            </span>
            <Clear id={d.id} cleared={d.cleared} />
            {d.snippet && <Snippet text={d.snippet} />}
          </li>
        ))}
      </ul>
    </>
  );
}

Find.Box = function Box({ initial }: { initial: string }) {
  return <Suspense><SearchBox initial={initial} /></Suspense>;
};

/**
 * The matching line, with the hit marked.
 *
 * ts_headline is asked for << >> rather than <b> so the snippet can be split
 * on a delimiter that cannot appear in the document, and the emphasis added
 * as real elements. Interpolating a database string as HTML would let every
 * document inject markup into this page.
 */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/<<|>>/);
  return (
    <div className="snip">
      {parts.map((p, i) =>
        i % 2
          ? <mark key={i}>{p}</mark>
          : <span key={i}>{p}</span>,
      )}
    </div>
  );
}
