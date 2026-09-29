import Link from "next/link";
import { headers } from "next/headers";
import { identify } from "@/lib/auth";
import { documents as loadDocs, needsYou } from "@/lib/queries";
import { recentlyOpened, popular, sharedWithMe, sidebarTeams } from "@/lib/sharing";
import { dayKey } from "../../day";
import { Day, Stamp } from "../../stamp";
import { Find } from "../../find";
import "./home.css";

export const dynamic = "force-dynamic";

/** Below this many distinct readers, "popular" is the same three pages every week. */
const POPULAR_FLOOR = 5;

type Row = { id: string; title: string; at: string; agent: string | null; team: string | null };

/**
 * The reader's home. Preview at /home (hq-app-cll.4); / still redirects
 * until the front door flips (cll.5).
 *
 * Ruled 28 Sep 2026 after the research pass: navigate first, search last.
 * What you opened and what asks something of you are ON the page, always,
 * never behind a search box's focus (Google's Quick Access tried the box
 * first and moved the list onto the home). Then the company's activity by
 * day, with Popular as a second tab only once enough people read to rank.
 * Then the teams, as cards. Every row says team, agent and time.
 */
export default async function Home(
  { searchParams }: { searchParams: Promise<{ q?: string; tab?: string }> },
) {
  const h = await headers();
  const me = await identify(new Request("http://local", { headers: h }));
  if (!me) return null;
  const { q, tab } = await searchParams;
  const query = (q ?? "").trim();
  if (query) return <Find userId={me.userId} q={query} back="/home" />;

  const [recent, needs, own, shared, pop, side] = await Promise.all([
    recentlyOpened(me.userId, 6).catch(() => []),
    needsYou(me.userId, 200).catch(() => []),
    loadDocs(me.userId).catch(() => []),
    sharedWithMe(me.userId, 100).catch(() => []),
    popular(me.userId, 7, 10).catch(() => []),
    sidebarTeams(me.userId).catch(() => ({ teams: [], shared: { count: 0, unread: 0 } })),
  ]);

  // Activity: my pages and what was shared with me, newest first, one list.
  const rows: Row[] = [
    ...own.slice(0, 60).map((d) => ({ id: d.id, title: d.title ?? d.slug, at: d.produced_at ?? d.created_at,
                                      agent: d.agent_title, team: null })),
    ...shared.slice(0, 60).map((d) => ({ id: d.id, title: d.title ?? d.slug, at: d.shared_at,
                                         agent: d.owner_address, team: d.team_domain })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 40);
  const readers = pop[0]?.readers ?? 0;
  const canRank = readers >= POPULAR_FLOOR;
  const showPopular = tab === "popular" && canRank;

  return (
    <div className="home">
      <p className="hq-kicker">Home</p>
      <Find.Box initial="" />

      <section className="home-top">
        <div className="home-recent">
          <h2 className="home-h">Recently opened</h2>
          {recent.length === 0 ? (
            <p className="home-empty">Pages you open appear here.</p>
          ) : (
            <ol className="home-list">
              {recent.map((d) => (
                <li key={d.id}>
                  <a href={`/d/${d.id}`}>{d.title ?? "Untitled"}</a>
                  <span className="home-meta">{[d.team_domain, d.agent_title].filter(Boolean).join(" · ")}{" · "}<Stamp t={d.opened_at} /></span>
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="hq-you home-needs">
          <p className="k">{needs.length === 0 ? "Nothing to decide" : `Needs you · ${needs.length}`}</p>
          {needs.length === 0 ? (
            <p className="q">No page is waiting on you.</p>
          ) : (
            <ol className="home-asks">
              {needs.slice(0, 3).map((d) => (
                <li key={d.id}>
                  <a href={`/d/${d.id}`}>{d.asks}</a>
                  <span className="home-meta">{d.agent_title ?? d.title}</span>
                </li>
              ))}
              {needs.length > 3 && <li className="home-more"><Link href="/needs">All {needs.length} &rsaquo;</Link></li>}
            </ol>
          )}
        </div>
      </section>

      <section>
        <nav className="home-tabs">
          <Link href="/home" data-on={showPopular ? "0" : "1"}>Activity</Link>
          {canRank
            ? <Link href="/home?tab=popular" data-on={showPopular ? "1" : "0"}>Popular this week</Link>
            : <span className="home-tab-off" title={`Ranking starts at ${POPULAR_FLOOR} readers; ${readers} read this week`}>Popular this week</span>}
        </nav>
        {showPopular ? (
          <ol className="home-feed">
            {pop.map((d) => (
              <li key={d.id}>
                <a className="home-title" href={`/d/${d.id}`}>{d.title ?? "Untitled"}</a>
                <span className="home-meta">{[d.team_domain, d.agent_title].filter(Boolean).join(" · ")}{" · "}{d.opens} opens by {d.openers} {d.openers === 1 ? "person" : "people"}</span>
              </li>
            ))}
          </ol>
        ) : rows.length === 0 ? (
          <p className="home-empty">Nothing yet. Pages your agents write, and pages shared with you, land here.</p>
        ) : (
          <ol className="home-feed">
            {rows.map((r, i) => (
              <li key={r.id + r.at} className={i === 0 || dayKey(rows[i - 1].at) !== dayKey(r.at) ? "home-newday" : undefined}>
                {(i === 0 || dayKey(rows[i - 1].at) !== dayKey(r.at)) && <span className="home-day"><Day t={r.at} /></span>}
                <a className="home-title" href={`/d/${r.id}`}>{r.title}</a>
                <span className="home-meta">{[r.team, r.agent].filter(Boolean).join(" · ")}{" · "}<Stamp t={r.at} /></span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {side.teams.length > 0 && (
        <section>
          <h2 className="home-h">Teams</h2>
          <div className="home-cards">
            {side.teams.map((t) => (
              <Link key={t.id} className="home-card" href={`/t/${t.id}`}>
                <b>{t.name}</b>
                <span>{t.pages} {t.pages === 1 ? "page" : "pages"}{t.unread > 0 ? ` · ${t.unread} unread` : ""}{t.member ? "" : " · shared by you"}</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
