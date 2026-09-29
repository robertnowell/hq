"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { SideRow, SideTeam, SideShared } from "./side-shape";
import { when } from "../when";

/**
 * The sidebar renders ONCE.
 *
 * It used to be part of the page, built from plain <a href> links, so every
 * click on an agent was a whole-document navigation: middleware, re-auth,
 * the lateral-join agent query again, and the JS bundle again -- three to
 * four seconds for a list that had not changed. Living in the layout it is
 * outside the segment that changes, so Next reuses it; <Link> makes the click
 * a client-side transition and prefetches the target on hover.
 *
 * Which agent is current is a fact about the URL, so it is read from the URL
 * rather than passed down from a server render.
 */
export type Mirror = { device: string; at: string; note: string | null };

export function Side({ agents, rest, unread, mirror = [], teams = [], shared = null }: {
  agents: SideRow[]; rest: number; unread: number; mirror?: Mirror[]; teams?: SideTeam[];
  shared?: SideShared | null;
}) {
  const path = usePathname();
  const current = path?.startsWith("/a/") ? path.slice(3) : null;
  const currentTeam = path?.startsWith("/t/") ? decodeURIComponent(path.slice(3)) : null;
  const shown = agents;
  const list = useRef<HTMLElement>(null);
  const tops = useRef<Map<string, number>>(new Map());

  // A returning agent moves to the top, and you see it move.
  //
  // The list is re-rendered by the server after each poll (router.refresh),
  // so this component cannot know which row changed; it can know where every
  // row WAS. Before paint, each row that now sits somewhere else is put back
  // at its old offset and released, so the browser draws the slide rather
  // than the jump. A row that climbed also glows for a moment: that is the
  // toast's counterpart in the place you will look next.
  useLayoutEffect(() => {
    const root = list.current;
    if (!root) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-agent]"));
    const before = tops.current;
    const after = new Map<string, number>();
    for (const el of rows) {
      const id = el.dataset.agent!;
      const top = el.offsetTop;
      after.set(id, top);
      const was = before.get(id);
      if (was === undefined || was === top) continue;
      const delta = was - top;
      el.animate(
        [{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }],
        { duration: 420, easing: "cubic-bezier(.2,.7,.2,1)" },
      );
      if (delta > 0) {
        el.classList.add("hq-moved");
        el.addEventListener("animationend", () => el.classList.remove("hq-moved"), { once: true });
      }
    }
    tops.current = after;
  }, [agents]);

  // The installed app's icon carries the unread count. No permission, no
  // sound, no focus: a number on the Dock is the quietest signal there is.
  useEffect(() => {
    const n = navigator as Navigator & {
      setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void>;
    };
    if (unread > 0) n.setAppBadge?.(unread).catch(() => {});
    else n.clearAppBadge?.().catch(() => {});
  }, [unread]);

  return (
    <aside className="hq-side" ref={list}>
      {/* Notes first: what you said is the one list here that is not an
          agent's, and it is the one you reach for without knowing which
          agent it went to. */}
      <Link className="hq-agent" href="/notes" data-current={path === "/notes" ? "1" : "0"}>
        <span className="t">Notes</span><span className="m">Everything you have said</span>
      </Link>
      <Link className="hq-agent" href="/shipping"><span className="t">Shipping status</span><span className="m">Running, merged, and waiting</span></Link>
      {/* Shared with you: only when somebody has. The way back from a page
          that reached you by link, and the home of a hub that is otherwise
          empty (27 Sep). */}
      {shared && shared.count > 0 && (
        <Link className="hq-agent" href="/documents" data-current={path === "/documents" ? "1" : "0"}>
          <span className="t">Shared with you</span>
          <span className="m">{shared.count} {shared.count === 1 ? "page" : "pages"}
            {shared.unread > 0 && <span className="hq-count" title={`${shared.unread} unread`}>{shared.unread}</span>}
          </span>
        </Link>
      )}
      {/* Teams first, and only when there are any. A team is a domain; its
          row expands to the five newest pages shared to it (ruled 27 Sep). */}
      {teams.length > 0 && <h2>Teams &middot; {teams.length}</h2>}
      {teams.map((t) => (
        <details key={t.domain} className="hq-team" open={currentTeam === t.domain}>
          <summary>
            <Link className="hq-agent" href={`/t/${encodeURIComponent(t.domain)}`}
                  data-current={currentTeam === t.domain ? "1" : "0"}>
              <span className="t">{t.name}</span>
              <span className="m">
                {t.pages} {t.pages === 1 ? "page" : "pages"}{!t.member && " · shared by you"}
                {t.unread > 0 && <span className="hq-count" title={`${t.unread} unread`}>{t.unread}</span>}
              </span>
            </Link>
          </summary>
          {t.docs.map((doc) => (
            <Link key={doc.id} className="hq-teamdoc" href={`/d/${doc.id}`}>
              <span className="t">{doc.title}</span><span className="m">{when(doc.at)}</span>
            </Link>
          ))}
        </details>
      ))}
      {agents.length > 0 && <h2>Agents &middot; {agents.length}</h2>}
      {shown.map((a) => (
        <Link key={a.id} className="hq-agent" href={`/a/${a.id}`} data-agent={a.id}
              data-current={current === a.id ? "1" : "0"}>
          <span className="t">{a.title ?? a.source_session_id.slice(0, 8)}</span>
          <span className="m">
            {a.turns} {a.turns === 1 ? "turn" : "turns"} &middot; {when(a.last_active_at)}
            {a.unread > 0 && (
              <span className="hq-count" title={`${a.unread} unread`}>{a.unread}</span>
            )}
          </span>
        </Link>
      ))}
      {rest > 0 && (
        <Link className="hq-agent hq-more" href="/agents">
          <span className="t">{rest} more…</span>
          <span className="m">every agent, by name</span>
        </Link>
      )}
      {/* The dead-man's switch, printed. A drain that failed says so; a
          drain that has not happened is a time, not a guess. */}
      <div className="hq-mirror">
        {mirror.length === 0
          ? <a data-state="never" href="/connect">Connect your Mac</a>
          : mirror.map((m) => {
              const bad = !!m.note && !m.note.startsWith("ok");
              return (
                <span key={m.device} data-state={bad ? "failed" : "ok"} title={m.note ?? ""}>
                  {m.device} synced {when(m.at)}{bad ? ` · ${m.note}` : ""}
                </span>
              );
            })}
      </div>
    </aside>
  );
}
