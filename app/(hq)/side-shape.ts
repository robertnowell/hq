import type { AgentRow } from "@/lib/queries";

/**
 * How many agents the sidebar prints, and what a row needs.
 *
 * These live in a plain module rather than beside the component, and that is
 * load bearing. Next replaces EVERY export of a "use client" file with a
 * client reference, so a plain constant imported from one arrives on the
 * server as an opaque object -- `slice(0, SHOWN)` became `slice(0, 0)` and
 * the sidebar rendered zero agents under a "469 more…" link. No error, no
 * warning; a number silently stopped being a number at the boundary.
 */
export const SHOWN = Infinity; // kept for the note above; the sidebar prints every agent now

/** Only what a row prints. Everything else stays on the server. */
export type SideRow = Pick<AgentRow,
  "id" | "title" | "source_session_id" | "last_active_at" | "turns" | "unread" | "needs">;

/** A team in the sidebar: the domain, the counts, its five newest pages. */
export type SideTeam = {
  id: string; domain: string; name: string; member: boolean; unread: number; pages: number;
  docs: { id: string; title: string; at: string }[];
};

/** Pages shared with this person by others: the count the sidebar prints. */
export type SideShared = { count: number; unread: number };
