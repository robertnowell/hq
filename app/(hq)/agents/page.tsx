import Link from "next/link";
import { headers } from "next/headers";
import { identify } from "@/lib/auth";
import { agents as loadAgents } from "@/lib/queries";
import { when } from "../../when";

export const dynamic = "force-dynamic";

/**
 * Every agent, by name.
 *
 * The sidebar is a stack -- ranked, capped, meant to be scanned. This is the
 * index: the place you go when you know which agent you want. Keeping them
 * separate is what lets the sidebar stay small enough to ship on every page.
 */
export default async function AgentsPage() {
  const h = await headers();
  const me = await identify(new Request("http://local", { headers: h }));
  if (!me) return null;
  const ags = await loadAgents(me.userId);
  return (
    <>
      <h1 className="hq-h1">Agents</h1>
      <p className="hq-sub">{ags.length} in all. Anything outstanding sorts first.</p>
      <ul className="made roster">
        {ags.map((a) => (
          <li key={a.id}>
            <span className="lamp" data-state={a.unread ? "unread" : "read"} />
            <Link className="page" href={`/a/${a.id}`}>
              {a.title ?? a.source_session_id.slice(0, 8)}
            </Link>
            <span className="when">
              {a.turns} {a.turns === 1 ? "turn" : "turns"}
              {a.docs > 0 && ` · ${a.docs} doc${a.docs === 1 ? "" : "s"}`}
              {" · "}{when(a.last_active_at)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
