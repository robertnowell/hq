export function when(t: string | null) {
  if (!t) return "";
  const s = (Date.now() - new Date(t).getTime()) / 1000;
  if (s < 90) return "now";
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  if (s < 2592000) return `${Math.round(s / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The long form, for a turn's own dateline. */
export function stamp(t: string) {
  return new Date(t).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}
