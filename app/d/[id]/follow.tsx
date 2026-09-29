"use client";

import { useEffect, useState } from "react";

const POLL_MS = 10_000;
/** Under this many characters of text a document is a template, not a page. */
const STUB_CHARS = 600;

/**
 * The frame follows its bytes.
 *
 * An update in place raises no event, so this asks the version route every
 * ten seconds while the tab is visible. When the bytes change and what the
 * reader had was a stub (the empty template that reached the hub before its
 * fill), the frame simply fetches again: there was nothing to lose their
 * place in. When the reader had a real page, a rewrite is offered, not
 * forced: a pill that reloads on a click, so a footer stamped in mid-read
 * never yanks the scroll.
 */
export function Follow({ id, hash, chars }: { id: string; hash: string; chars: number }) {
  const [seen, setSeen] = useState({ hash, chars });
  const [offered, setOffered] = useState(false);

  const reload = () => {
    const f = document.querySelector<HTMLIFrameElement>(".doc-frame");
    // Sandboxed with an opaque origin, so its window is not ours to reload;
    // re-setting the source is the one instruction that crosses.
    if (f) f.src = f.src;
    setOffered(false);
  };

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const r = await fetch(`/d/${id}/version`, { cache: "no-store" });
        if (!r.ok || !alive) return;
        const j: { hash: string; chars: number } = await r.json();
        if (j.hash === seen.hash) return;
        const wasStub = seen.chars < STUB_CHARS;
        setSeen(j);
        if (wasStub) reload(); else setOffered(true);
      } catch {
        // A failed poll is the next poll's problem; the page stays as it is.
      }
    };
    const t = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [id, seen]);

  if (!offered) return null;
  return (
    <button className="dc-updated" onClick={reload} type="button">
      This page was rewritten · show the new version
    </button>
  );
}
