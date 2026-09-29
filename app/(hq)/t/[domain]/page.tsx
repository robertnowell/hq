import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { identify } from "@/lib/auth";
import { teamDocuments, myTeams, teamSearch } from "@/lib/sharing";
import { Find } from "../../../find";
import { isDomainShaped } from "@/lib/domain";
import { Stamp } from "../../../stamp";
import "./team.css";

export const dynamic = "force-dynamic";

const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * One team's page: everything shared to a domain, newest first.
 *
 * A team is a domain (ruled 27 Sep 2026). Whoever signs in with an address
 * at it is a member and sees every live share, including the ones made
 * before they joined; an author who shared here sees the same list. Turns
 * are not here: they are the agent's conversation and stay on the agent's
 * page. This page is pointers, as the hub was ruled to be: a title, the
 * page's own one-line summary, its labels, who wrote it, when.
 *
 * Flat and newest first, on purpose. Labels are stored now and organise
 * nothing yet; collections come later as rule-driven views over these rows.
 */
export default async function TeamPage(
  { params, searchParams }: { params: Promise<{ domain: string }>; searchParams: Promise<{ q?: string }> },
) {
  const h = await headers();
  const me = await identify(new Request("http://local", { headers: h }));
  if (!me) notFound();
  const { domain: raw } = await params;
  const { q } = await searchParams;
  const query = (q ?? "").trim();
  // A team is addressed by its id (ruled 28 Sep): a domain changes with a
  // rebrand, an id does not. The domain address still works and forwards,
  // so every link handed out before today keeps landing.
  const key = decodeURIComponent(raw).toLowerCase();
  const byId = ORG_ID.test(key);
  if (!byId && !isDomainShaped(key)) notFound();

  const teams = await myTeams(me.userId);
  const team = teams.find((t) => (byId ? t.org_id === key : t.domain === key));
  // Not a member and not an author: the same 404 as a team that does not
  // exist. Which companies use the hub is not something to confirm.
  if (!team) notFound();
  if (!byId) redirect(`/t/${team.org_id}${query ? `?q=${encodeURIComponent(query)}` : ""}`);
  const domain = team.domain;
  const docs = await teamDocuments(me.userId, domain, 200);

  const unread = docs.filter((d) => !d.read && d.owner_id !== me.userId).length;
  return (
    <>
      <p className="hq-kicker">Team</p>
      <h1 className="hq-h1">{team.name}</h1>
      <p className="hq-byline">
        @{team.domain} &middot; {docs.length} {docs.length === 1 ? "page" : "pages"}
        {unread > 0 && <> &middot; {unread} unread</>}
        {!team.member && <> &middot; you share here; you are not a member</>}
      </p>
      <Find.Box initial={query} />
      {query ? (
        <TeamHits userId={me.userId} domain={domain} q={query} />
      ) : docs.length === 0 ? (
        <p className="hq-sub">Nothing shared to this team yet.</p>
      ) : (
        <ol className="team-list">
          {docs.map((d) => (
            <li key={d.id} className="team-row" data-unread={!d.read && d.owner_id !== me.userId ? "1" : "0"}>
              <span className="team-lamp" aria-hidden="true" />
              <div className="team-body">
                <a className="team-title" href={`/d/${d.id}`}>{d.title ?? d.slug}</a>
                {d.summary && <p className="team-summary">{d.summary}</p>}
                <p className="team-meta">
                  {d.owner_address ?? "someone"}
                  {d.agent_title && <> &middot; {d.agent_title}</>}
                  {" · "}<Stamp t={d.shared_at} />
                  {d.labels.length > 0 && (
                    <span className="team-labels">{d.labels.map((l) => <span key={l}>{l}</span>)}</span>
                  )}
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/** Search inside one team: the same tsv, reached through the team's shares. */
async function TeamHits({ userId, domain, q }: { userId: string; domain: string; q: string }) {
  const hits = await teamSearch(userId, domain, q, 30);
  if (hits.length === 0) return <p className="hq-sub">Nothing in this team matches &ldquo;{q}&rdquo;.</p>;
  return (
    <ol className="team-list">
      {hits.map((d) => (
        <li key={d.id} className="team-row" data-unread="0">
          <span className="team-lamp" aria-hidden="true" />
          <div className="team-body">
            <a className="team-title" href={`/d/${d.id}`}>{d.title ?? d.slug}</a>
            <p className="team-summary" dangerouslySetInnerHTML={{ __html: markHits(d.snippet) }} />
            <p className="team-meta">{d.owner_address ?? "someone"}{d.agent_title && <> &middot; {d.agent_title}</>}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** ts_headline marks hits as <<word>>; everything else is escaped, then the marks become <mark>. */
function markHits(snippet: string): string {
  return snippet
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/&lt;&lt;/g, "<mark>").replace(/&gt;&gt;/g, "</mark>");
}
