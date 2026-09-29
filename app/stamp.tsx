"use client";

import { useEffect, useState } from "react";

/**
 * An absolute time, in the reader's zone.
 *
 * Formatting on the server meant formatting in the server's zone, which on
 * a laptop was Pacific and on Vercel is UTC: "Sep 11, 1:04 AM" for a turn
 * that happened at six in the evening. So the server renders a placeholder
 * in Pacific, and the browser replaces it with its own zone on mount.
 */
const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };

export function Stamp({ t }: { t: string }) {
  const [s, setS] = useState(() => new Date(t).toLocaleString("en-US", { ...opts, timeZone: "America/Los_Angeles" }));
  useEffect(() => { setS(new Date(t).toLocaleString(undefined, opts)); }, [t]);
  return <span suppressHydrationWarning>{s}</span>;
}

/** The day alone, for a header over the turns of one day. Same zone trick as Stamp. */
const dayOpts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
export function Day({ t }: { t: string }) {
  const [s, setS] = useState(() => new Date(t).toLocaleDateString("en-US", { ...dayOpts, timeZone: "America/Los_Angeles" }));
  useEffect(() => { setS(new Date(t).toLocaleDateString(undefined, dayOpts)); }, [t]);
  return <span suppressHydrationWarning>{s}</span>;
}

