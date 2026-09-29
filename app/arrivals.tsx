"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Arrived = { id: string; title: string | null; slug: string; agent_title: string | null };
type Returned = {
  id: string; agent_id: string; headline: string | null; topic: string;
  question: string | null; agent_title: string | null;
};
type Toast = {
  key: string; href: string; who: string; what: string; asks: boolean; at: number;
};

const POLL_MS = 10_000;
const LINGER_MS = 14_000;

/**
 * Announce, never navigate.
 *
 * A new document or a returning agent raises a toast and nothing else. It
 * does not move the reader, does not steal focus, does not raise the window,
 * and does not reorder what is on screen while a person is reading it. The
 * only thing that moves you is you clicking.
 *
 * The sidebar does update: `router.refresh()` re-renders the server
 * components in place -- counts, ordering, the agent's last-moved time --
 * without changing the route or losing scroll, and the sidebar animates the
 * returning agent to the top. That is the difference between a page that is
 * live and a page that yanks.
 *
 * Toasts stack in the corner, newest on top, and leave on their own. They
 * are a notice, not a queue: the sidebar is the record.
 */
export function Arrivals({ startedAt }: { startedAt: string }) {
  const router = useRouter();
  const [since, setSince] = useState(startedAt);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      // A hidden tab keeps polling so the sidebar is right when you come
      // back, but it raises no toast: nobody is there to see it, and a
      // pile of stale notices on return is noise.
      try {
        const r = await fetch(`/api/since?since=${encodeURIComponent(since)}`, {
          cache: "no-store",
        });
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        if (!alive) return;
        setFailed(false);
        const turns: Returned[] = j.turns ?? [];
        const docs: Arrived[] = j.arrived ?? [];
        if (turns.length || docs.length) {
          router.refresh();
          if (document.visibilityState === "visible") {
            const now = Date.now();
            const fresh: Toast[] = [
              ...turns.map((t) => ({
                key: `t:${t.id}`, href: `/a/${t.agent_id}`,
                who: t.agent_title ?? "An agent",
                what: t.headline ?? t.topic ?? "returned",
                asks: !!t.question, at: now,
              })),
              ...docs.map((d) => ({
                key: `d:${d.id}`, href: `/d/${d.id}`,
                who: d.agent_title ?? "An agent",
                what: `new page: ${d.title ?? d.slug}`, asks: false, at: now,
              })),
            ];
            setToasts((prev) => [...fresh, ...prev].slice(0, 5));
          }
        }
        setSince(j.now);
      } catch {
        // A failed poll is visible. The alternative is a channel that has
        // quietly stopped and looks identical to one with nothing to say.
        if (alive) setFailed(true);
      }
    };
    const id = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [since, router]);

  // Each toast leaves on its own clock.
  useEffect(() => {
    if (!toasts.length) return;
    const oldest = toasts[toasts.length - 1];
    const wait = Math.max(0, oldest.at + LINGER_MS - Date.now());
    const id = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.at + LINGER_MS > Date.now()));
    }, wait + 20);
    return () => clearTimeout(id);
  }, [toasts]);

  const drop = (key: string) => setToasts((prev) => prev.filter((t) => t.key !== key));

  return (
    <div className="hq-toasts" aria-live="polite">
      {failed && (
        <div className="hq-toast" data-kind="failed">
          <span className="w">Not receiving updates.</span>
          <span className="s">The page is still readable; new pages will not appear.</span>
        </div>
      )}
      {toasts.map((t) => (
        <div key={t.key} className="hq-toast" data-kind={t.asks ? "asks" : "news"}>
          <a href={t.href} onClick={() => drop(t.key)}>
            <span className="w">{t.who}{t.asks ? " · asks you" : ""}</span>
            <span className="s">{t.what}</span>
          </a>
          <button onClick={() => drop(t.key)} aria-label="dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
