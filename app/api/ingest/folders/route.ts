import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The most folders and members one book may carry. */
const MAX_FOLDERS = 200;
const MAX_MEMBERS = 5_000;

/**
 * The panel's project folders, as the Mac keeps them (projects.json).
 *
 * The whole book, every time it changes, replacing the one before: folders
 * in the user's order with their names and collapsed flags, and members
 * keyed by the conversation's origin session id. Stored as the Mac sent it
 * after validation; the sidebar groups agents by it and edits nothing.
 */
export async function POST(req: Request) {
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const book = body?.book;
  const folders = Array.isArray(book?.folders) ? book.folders : null;
  const members = book?.members && typeof book.members === "object" ? book.members : null;
  if (!folders || !members) return Response.json({ error: "book.folders[] and book.members{} are required" }, { status: 400 });
  if (folders.length > MAX_FOLDERS || Object.keys(members).length > MAX_MEMBERS) {
    return Response.json({ error: "book too large" }, { status: 413 });
  }
  const clean = {
    folders: folders
      .filter((f: unknown): f is { id: string; name: string; collapsed?: boolean } =>
        !!f && typeof (f as { id?: unknown }).id === "string"
            && typeof (f as { name?: unknown }).name === "string")
      .map((f: { id: string; name: string; collapsed?: boolean }) =>
        ({ id: f.id.slice(0, 64), name: f.name.trim().slice(0, 80), collapsed: f.collapsed === true })),
    members: Object.fromEntries(Object.entries(members as Record<string, unknown>)
      .filter(([k, v]) => k.length >= 8 && k.length <= 64 && typeof v === "string")
      .map(([k, v]) => [k, (v as string).slice(0, 64)])),
  };
  await asUser(me.userId, (c) => c.query(
    `insert into agent_folders (user_id, book, updated_at) values ($1, $2::jsonb, now())
     on conflict (user_id) do update set book = excluded.book, updated_at = now()`,
    [me.userId, JSON.stringify(clean)]));
  return Response.json({ folders: clean.folders.length, members: Object.keys(clean.members).length });
}
