import Link from "next/link";
import { headers } from "next/headers";
import { identify } from "@/lib/auth";
import { needsYou } from "@/lib/queries";
import { Stamp } from "../../stamp";
import { Clear } from "../../clear";
import "../t/[domain]/team.css";

export const dynamic = "force-dynamic";

/**
 * Needs you: every page of yours that asks something, until you clear it.
 *
 * One definition (ruled 28 Sep 2026): a page asks when its own dark block
 * says what it needs, and it stops asking when a person presses Clear.
 * Opening it is not answering it. The count in the sidebar and the block on
 * the home are these rows.
 */
export default async function NeedsPage() {
  const h = await headers();
  const me = await identify(new Request("http://local", { headers: h }));
  if (!me) return null;
  const rows = await needsYou(me.userId, 200);
  return (
    <>
      <p className="hq-kicker">Needs you</p>
      <h1 className="hq-h1">{rows.length === 0 ? "Nothing is waiting on you." : `${rows.length} ${rows.length === 1 ? "page asks" : "pages ask"} something of you.`}</h1>
      {rows.length > 0 && (
        <ol className="team-list">
          {rows.map((d) => (
            <li key={d.id} className="team-row" data-unread={d.opened ? "0" : "1"}>
              <span className="team-lamp" aria-hidden="true" />
              <div className="team-body">
                <a className="team-title" href={`/d/${d.id}`}>{d.title ?? d.slug}</a>
                <p className="team-summary">{d.asks}</p>
                <p className="team-meta">
                  <Link href={`/a/${d.agent_id}`}>{d.agent_title ?? "an agent"}</Link>
                  {" · "}<Stamp t={d.at} />
                  {" · "}<Clear id={d.id} cleared={false} />
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
