import { headers } from "next/headers";
import { identify } from "@/lib/auth";
import { chunk, noteAgents, notes as loadNotes, type NoteFilter } from "@/lib/notes";
import { NoteFilters } from "./filters";
import { NotesStream } from "./stream";

export const dynamic = "force-dynamic";

type Params = { source?: string; agent?: string; q?: string; before?: string; key?: string };

/**
 * Notes: everything you have said, newest first.
 *
 * Two sources, one stream. Dictations are what the panel transcribed and
 * sent to an agent; hands-free is what the ledger heard you say to the
 * manager. Both arrive from the Mac's mirror, keyed so a resend is an update.
 *
 * The filters are the URL, like search everywhere else in the hub, so a
 * filtered view survives a refresh and the back button leaves it.
 */
export default async function NotesPage({ searchParams }: { searchParams: Promise<Params> }) {
  const p = await searchParams;
  const h = await headers();
  const me = await identify(new Request("http://local", { headers: h }));
  if (!me) return null;

  const source = p.source === "handsfree" || p.source === "dictation" ? p.source : undefined;
  const filter: NoteFilter = {
    source,
    agent: p.agent?.trim() || undefined,
    q: (p.q ?? "").trim().slice(0, 200) || undefined,
    before: p.before && !Number.isNaN(Date.parse(p.before))
      ? { at: p.before, key: p.key ?? "" } : undefined,
  };
  const [{ rows, more }, agents] = await Promise.all([
    loadNotes(me.userId, filter), noteAgents(me.userId)]);

  const keep = new URLSearchParams();
  if (filter.source) keep.set("source", filter.source);
  if (filter.agent) keep.set("agent", filter.agent);
  if (filter.q) keep.set("q", filter.q);
  const last = rows[rows.length - 1];
  const older = more && last
    ? `/notes?${new URLSearchParams([...keep, ["before", last.at_key], ["key", last.source_key]])}`
    : null;
  const newest = filter.before ? `/notes${keep.size ? `?${keep}` : ""}` : null;
  const filtered = !!(filter.source || filter.agent || filter.q);

  return (
    <>
      <p className="hq-kicker">Notes</p>
      <h1 className="hq-h1">Everything you have said</h1>
      <p className="hq-deck">
        What you dictated to your agents and what you said in hands-free, newest first,
        in the words that were transcribed.
      </p>
      <NoteFilters source={filter.source ?? ""} agent={filter.agent ?? ""} q={filter.q ?? ""}
                   agents={agents} />
      {rows.length === 0 ? (
        <p className="hq-sub">
          {filtered
            ? "Nothing you have said matches this."
            : "Nothing yet. Once your Mac is connected, what you dictate and what you say in hands-free appears here."}
        </p>
      ) : (
        <NotesStream chunks={chunk(rows)} />
      )}
      {(older || newest) && (
        <p className="nt-pager">
          {newest && <a href={newest}>Newest</a>}
          {older && <a href={older}>Older</a>}
        </p>
      )}
    </>
  );
}
