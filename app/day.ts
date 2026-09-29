/**
 * The grouping key for a day header, computed where the turn list is built.
 *
 * This is a plain module on purpose: stamp.tsx is a client module, and a
 * function exported from one cannot be CALLED on the server, only rendered.
 * Every agent page threw "Attempted to call dayKey() from the server" for
 * twenty minutes on 28 Sep 2026 because this lived there. Pacific, to match
 * the placeholder the Day component renders before the browser corrects it.
 */
export function dayKey(t: string): string {
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Los_Angeles" });
}
