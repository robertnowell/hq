"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Search lives in the URL, not in component state.
 *
 * So a search is a place: it survives a refresh, the back button leaves it,
 * and the link is shareable. That is the same reason documents are at real
 * URLs rather than being swapped into a pane.
 *
 * The typing is debounced because the stated bar is that search must never
 * stutter. Navigating on every keystroke would round-trip the server 12
 * times for "microphone".
 */
export function SearchBox({ initial }: { initial: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const [v, setV] = useState(initial);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => {
      const p = new URLSearchParams(params.toString());
      if (v.trim()) p.set("q", v.trim()); else p.delete("q");
      router.replace(p.toString() ? `?${p}` : "?", { scroll: false });
    }, 220);
    return () => clearTimeout(t);
  }, [v]);

  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      placeholder="Search everything…"
      aria-label="Search document text"
      style={{
        width: "100%", padding: ".5rem .7rem", marginBottom: "var(--s3)",
        border: "1px solid var(--line)", borderRadius: 6,
        background: "var(--bg)", color: "var(--ink)", font: "inherit",
      }}
    />
  );
}
