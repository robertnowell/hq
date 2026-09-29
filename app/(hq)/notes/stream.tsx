"use client";

import { useEffect, useState } from "react";
import type { Chunk } from "@/lib/notes";

/**
 * The stream, in the reader's own days.
 *
 * Which day a note belongs to is a fact about a time zone, and the server's
 * is UTC: an evening's dictation would sit under tomorrow's heading. So this
 * renders in Pacific on the server, as `Stamp` does, and regroups in the
 * browser's zone once mounted. The chunks themselves are zone-free and come
 * from the server whole.
 */
const PACIFIC = "America/Los_Angeles";

/** Dictations that never reached their agent say so; the words still count. */
const UNSENT = new Set(["discarded", "dispatch_failed", "ambiguous_after_crash"]);

export function NotesStream({ chunks }: { chunks: Chunk[] }) {
  const [zone, setZone] = useState<string | undefined>(PACIFIC);
  useEffect(() => { setZone(undefined); }, []);

  const dayOf = (t: string) => new Date(t).toLocaleDateString("en-CA", { timeZone: zone });
  const days: { day: string; label: string; chunks: Chunk[] }[] = [];
  for (const c of chunks) {
    const day = dayOf(c.at);
    let d = days[days.length - 1];
    if (!d || d.day !== day) {
      d = { day, label: new Date(c.at).toLocaleDateString("en-US",
        { weekday: "long", month: "short", day: "numeric", year: "numeric", timeZone: zone }),
        chunks: [] };
      days.push(d);
    }
    d.chunks.push(c);
  }
  const time = (t: string) => new Date(t).toLocaleTimeString("en-US",
    { hour: "numeric", minute: "2-digit", timeZone: zone });

  return (
    <div className="nt-stream" suppressHydrationWarning>
      {days.map((d) => (
        <section key={d.day} className="nt-day">
          <h2 suppressHydrationWarning>{d.label}</h2>
          {d.chunks.map((c) => (
            <article key={c.key} className="nt-chunk" data-source={c.source}>
              <header>
                <span className="when" suppressHydrationWarning>{time(c.at)}</span>
                <span className="who">{label(c)}</span>
                <Copy text={c.lines.map((l) => l.text).join("\n")} label="Copy" className="nt-copy" />
              </header>
              {c.lines.map((l) => (
                <p key={l.key} className="nt-line">
                  {/* The tag rides inline at the end of the words: as its own flex
                      item it floated mid-row on a phone, between the text and
                      the hidden copy control. Copy still copies the words only. */}
                  <span className="said">
                    {l.text}
                    {c.source === "dictation" && l.kind && UNSENT.has(l.kind) && (
                      <> <span className="nt-tag">not sent</span></>
                    )}
                  </span>
                  {/* One line: the chunk's Copy already copies exactly this, and
                      two buttons for the same words read as a mistake. */}
                  {c.lines.length > 1 && <Copy text={l.text} label="copy" className="nt-copy-line" />}
                </p>
              ))}
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}

function label(c: Chunk) {
  if (c.source === "handsfree") return "Hands-free";
  return c.agent_name ? `Dictated to ${c.agent_name}` : "Dictated";
}

/**
 * Copy exactly what is stored, and say so for a moment.
 *
 * The clipboard API needs a secure context, which the hub always is; the
 * textarea fallback is for a browser that refuses anyway, so the button
 * never silently does nothing.
 */
function Copy({ text, label, className }: { text: string; label: string; className: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } finally { ta.remove(); }
    }
    setDone(true);
  };
  return (
    <button type="button" className={className} data-done={done ? "1" : "0"} onClick={copy}
            aria-label={label === "Copy" ? "Copy these lines" : "Copy this line"}>
      {done ? "Copied" : label}
    </button>
  );
}
