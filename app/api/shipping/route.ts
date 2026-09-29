import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";
import { getShipping, putShipping } from "@/lib/blobs";
import { parseShipping } from "@/lib/shipping";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const devices = await asUser(me.userId, async c => (await c.query(
    "select id from device_tokens where user_id=$1 and revoked_at is null", [me.userId])).rows);
  const snapshots = await getShipping(me.userId, devices.map(d => d.id));
  return Response.json({ snapshots }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST(req: Request) {
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });
  if (!me.deviceId) return Response.json({ error: "paired device required" }, { status: 403 });
  const raw = await req.text();
  if (Buffer.byteLength(raw) > 200_000) return Response.json({ error: "snapshot too large" }, { status: 413 });
  let snapshot;
  try { snapshot = parseShipping(JSON.parse(raw)); }
  catch { return Response.json({ error: "invalid snapshot" }, { status: 400 }); }
  const name = await asUser(me.userId, async c => (await c.query(
    "select name from device_tokens where user_id=$1 and id=$2 and revoked_at is null", [me.userId, me.deviceId])).rows[0]?.name);
  if (!name) return Response.json({ error: "device unavailable" }, { status: 403 });
  snapshot.deviceName = name;
  const saved = await putShipping(me.userId, me.deviceId, snapshot);
  return Response.json({ ok: saved }, { status: saved ? 200 : 409 });
}
