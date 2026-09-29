"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * The three filters, and where they live: the URL.
 *
 * A choice in either dropdown navigates at once; typing waits 220 ms, the
 * same debounce as the hub's search box, so a word is one request and not
 * one per keystroke. Any change drops the Older cursor, because a page of
 * "before this note" under a new filter is a page of nothing in particular.
 *
 * It is also a plain GET form, so it works before the script has loaded.
 */
export function NoteFilters({ source, agent, q, agents }: {
  source: string; agent: string; q: string; agents: string[];
}) {
  const router = useRouter();
  const [text, setText] = useState(q);
  const first = useRef(true);

  const go = (next: { source?: string; agent?: string; q?: string }) => {
    const v = { source, agent, q: text, ...next };
    const p = new URLSearchParams();
    if (v.source) p.set("source", v.source);
    if (v.agent) p.set("agent", v.agent);
    if (v.q.trim()) p.set("q", v.q.trim());
    router.replace(p.size ? `/notes?${p}` : "/notes", { scroll: false });
  };

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => go({ q: text }), 220);
    return () => clearTimeout(t);
    // Only the text is debounced; the dropdowns navigate themselves.
  }, [text]);

  // An agent the stream is filtered to stays choosable even if it is no
  // longer in the list, or the dropdown would silently show "Every agent".
  const names = agent && !agents.includes(agent) ? [agent, ...agents] : agents;

  return (
    <form className="nt-filters" action="/notes" method="get"
          onSubmit={(e) => { e.preventDefault(); go({}); }}>
      <select name="source" aria-label="Source" value={source}
              onChange={(e) => go({ source: e.target.value })}>
        <option value="">All</option>
        <option value="handsfree">Hands-free</option>
        <option value="dictation">Dictations</option>
      </select>
      <select name="agent" aria-label="Agent" value={agent}
              onChange={(e) => go({ agent: e.target.value })}>
        <option value="">Every agent</option>
        {names.map((n) => <option key={n} value={n}>{n}</option>)}
      </select>
      <input name="q" type="search" value={text} placeholder="Search what you said…"
             aria-label="Search what you said" onChange={(e) => setText(e.target.value)} />
    </form>
  );
}
