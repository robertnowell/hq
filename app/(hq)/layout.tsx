import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { identify } from "@/lib/auth";
import { agents as loadAgents, heartbeats as loadHeartbeats } from "@/lib/queries";
import { Side } from "./side";
import { type SideRow, type SideTeam, type SideShared } from "./side-shape";
import { myTeams, teamDocuments, sharedWithMe } from "@/lib/sharing";
import { Arrivals } from "../arrivals";

export const dynamic = "force-dynamic";

/**
 * The shell, above the segment that changes.
 *
 * The sidebar and the arrivals poller live here rather than in each page so
 * that moving between agents re-renders only the main pane. Previously both
 * were part of the page and every click paid for the agent query, the auth
 * round trip and a full document load.
 */
export default async function HqLayout({ children }: { children: React.ReactNode }) {
  const h = await headers();
  const me = await identify(new Request("http://local", { headers: h }));
  if (!me) {
    // The front door, and back here afterwards. The path rides the header
    // the middleware set; the root itself needs no return address.
    const here = h.get("x-hq-path") ?? "/";
    redirect(here === "/" ? "/sign-in" : `/sign-in?redirect_url=${encodeURIComponent(here)}`);
  }
  const [ags, beats, tms, mine] = await Promise.all([
    loadAgents(me.userId), loadHeartbeats(me.userId), myTeams(me.userId).catch(() => []),
    sharedWithMe(me.userId, 200).catch(() => []),
  ]);
  const shared: SideShared = { count: mine.length, unread: mine.filter((d) => !d.read).length };
  // Teams, with their five newest pages each. A section that is empty is not
  // drawn, so a person with no team and no agents sees neither and a client's
  // contractor sees one. Bounded: twenty teams is more than anyone has.
  const teams: SideTeam[] = await Promise.all(tms.slice(0, 20).map(async (t) => {
    const docs = await teamDocuments(me.userId, t.domain, 5).catch(() => []);
    return { id: t.org_id, domain: t.domain, name: t.name, member: t.member, unread: t.unread, pages: t.pages,
             docs: docs.map((d) => ({ id: d.id, title: d.title ?? d.slug, at: d.shared_at })) };
  }));
  // Serialise the sidebar, not the census.
  //
  // `Side` is a client component, so whatever it is handed is written into
  // the flight payload of EVERY page as well as rendered into the HTML.
  // Passing all 469 agents cost ~400 KB a page even after the render was
  // capped, because capping the render does not cap the props. Only the rows
  // that are printed, and only the fields a row prints, cross the boundary.
  // Every agent, slim. The 400 KB problem was the FIELDS crossing the
  // boundary, not the rows; seven fields for 500 agents is under 80 KB, and
  // a sidebar that says "60" when there are 511 reads as a bug.
  const rows: SideRow[] = ags.map((a) => ({
    id: a.id, title: a.title, source_session_id: a.source_session_id,
    last_active_at: a.last_active_at, turns: a.turns,
    unread: a.unread, needs: a.needs,
  }));
  return (
    <div className="hq-shell">
      <Side agents={rows} rest={ags.length - rows.length} teams={teams} shared={shared}
            unread={ags.reduce((n, a) => n + a.unread, 0) + teams.reduce((n, t) => n + t.unread, 0)}
            mirror={beats.map((b) => ({ device: b.device_name, at: b.last_seen_at, note: b.note }))} />
      <main className="hq-main">
        <Arrivals startedAt={new Date().toISOString()} />
        <div className="hq-inner">{children}</div>
      </main>
    </div>
  );
}
