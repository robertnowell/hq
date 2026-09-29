import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";

export const runtime = "nodejs";

/**
 * The drainer reporting on itself.
 *
 * A hook that stops firing produces no error, so what gets monitored is the
 * absence of this call. And a run that could not send something is a
 * different fact from a run that had nothing to send; the note carries it,
 * and the sidebar prints it, so a failure is never a quiet stop.
 */
export async function POST(req: Request) {
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const device = String(body?.device ?? "unknown").slice(0, 60);
  const note = body?.note == null ? null : String(body.note).slice(0, 200);
  await asUser(me.userId, (c) => c.query(
    `insert into ingest_heartbeat (user_id, device_name, last_seen_at, note)
     values ($1, $2, now(), $3)
     on conflict (user_id, device_name) do update
       set last_seen_at = now(), note = excluded.note`,
    [me.userId, device, note]));
  return Response.json({ ok: true });
}
