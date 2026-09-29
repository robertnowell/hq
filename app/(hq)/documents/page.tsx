import { headers } from "next/headers";
import { identify } from "@/lib/auth";
import { sharedWithMe } from "@/lib/sharing";
import { Stamp } from "../../stamp";
import { AgentInstructions } from "../../agent-instructions";
import "../t/[domain]/team.css";

export const dynamic = "force-dynamic";

/**
 * Shared with you.
 *
 * The one list a person who owns nothing here needs: their team's pages and
 * the pages they were sent by link, newest first. It is the way back from a
 * shared document when there is no team page to go back to, and the home
 * of a person whose hub is otherwise empty (ruled 27 Sep 2026).
 */
export default async function SharedWithMe() {
  const h = await headers();
  const me = await identify(new Request("http://local", { headers: h }));
  if (!me) return null;
  const docs = await sharedWithMe(me.userId, 200);
  return (
    <>
      <p className="hq-kicker">Documents</p>
      <h1 className="hq-h1">Shared with you</h1>
      {docs.length === 0 ? (
        <p className="hq-sub">Nothing has been shared with you yet.</p>
      ) : (
        <ol className="team-list">
          {docs.map((d) => (
            <li key={d.id} className="team-row" data-unread={d.read ? "0" : "1"}>
              <span className="team-lamp" aria-hidden="true" />
              <div className="team-body">
                <a className="team-title" href={`/d/${d.id}`}>{d.title ?? d.slug}</a>
                {d.summary && <p className="team-summary">{d.summary}</p>}
                <p className="team-meta">
                  {d.owner_address ?? "someone"}
                  {" · "}{d.team_domain ? <a href={`/t/${encodeURIComponent(d.team_domain)}`}>{d.team_domain}</a> : "by link"}
                  {" · "}<Stamp t={d.shared_at} />
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
      <div className="hq-hook-foot">
        <h2 className="hq-h1 hq-hook">Share documents with your team.</h2>
        <p className="hq-sub hq-hook-sub">Any coding agent can put a page here, and you share it the same way these reached you.</p>
        <AgentInstructions domain={me.domain} primary={docs.length === 0} />
      </div>
    </>
  );
}
