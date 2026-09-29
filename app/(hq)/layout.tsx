import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { identify } from "@/lib/auth";
import { sidebarOwn } from "@/lib/queries";
import { Side } from "./side";
import { type SideRow, type SideTeam, type SideShared } from "./side-shape";
import { sidebarTeams } from "@/lib/sharing";
import { Arrivals } from "../arrivals";
import { SideToggle } from "../side-toggle";

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
  // Two calls, not four plus one per team (hq-app-cll.3, 29 Sep): the
  // reader's own rows under their own policy, and other tenants' through the
  // one definer function built from the rules the team pages use.
  const [own, other] = await Promise.all([
    sidebarOwn(me.userId),
    sidebarTeams(me.userId).catch(() => ({ teams: [], shared: { count: 0, unread: 0 } })),
  ]);
  const ags = own.agents, beats = own.heartbeats;
  const shared: SideShared = other.shared;
  const teams: SideTeam[] = other.teams;
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
  // WHO GETS THE HUB, decided once, here, from rows already loaded above
  // (Robert, 29 Sep: a person opening a shared link "should be basically
  // like, just the document"). A workspace is an agent, a paired Mac, or a
  // team membership; teammates keep the hub for their team page. Without
  // one the shell is bare: no sidebar, no collapse button, no arrivals. Not
  // stored, not a cookie, not a client flag: a person moves between the two
  // only by creating the data, and nothing else is allowed to ask.
  const workspace = ags.length > 0 || beats.length > 0 || teams.some((t) => t.member);
  if (!workspace) {
    return (
      <div className="hq-shell hq-shell--bare" data-shell="bare">
        <main className="hq-main"><div className="hq-inner">{children}</div></main>
      </div>
    );
  }
  return (
    <div className="hq-shell" data-shell="hub">
      <Side agents={rows} rest={ags.length - rows.length} teams={teams} shared={shared}
            unread={ags.reduce((n, a) => n + a.unread, 0) + teams.reduce((n, t) => n + t.unread, 0)}
            mirror={beats.map((b) => ({ device: b.device_name, at: b.last_seen_at, note: b.note }))} />
      <main className="hq-main">
        <SideToggle floating />
        <Arrivals startedAt={new Date().toISOString()} />
        <div className="hq-inner">{children}</div>
      </main>
    </div>
  );
}
