import { pool } from "@/lib/db";
import { sameSecret } from "@/lib/pairing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which Macs have been disconnected, since when.
 *
 * The Gateway spends money on a device's behalf and therefore has to stop the
 * moment that device is revoked, including on a replay of work it started
 * while it was still allowed. It cannot ask this question per request without
 * putting a network hop in front of every paid operation, so it mirrors this
 * feed and reads its own copy.
 *
 * Pulled rather than pushed, for now. A push would lower the latency, and a
 * push ALONE would be wrong: delivery is best-effort, and a missed one is
 * silent. The poll is what makes this correct, which is why it is the half
 * that exists first.
 *
 * It returns the complete set rather than a page. See 012-revocation-feed.sql
 * for the three ways the incremental version was wrong.
 *
 * The caller is a service. It is not a person with a Clerk session and not a
 * paired Mac with a device token, so neither of this app's identity
 * mechanisms describes it, and it authenticates with a shared secret instead.
 * Absent secret means the route refuses everything: a deployment that forgot
 * to configure it goes stale, which the Gateway treats as a reason to stop
 * vouching for anyone, rather than serving revocations to whoever asks.
 */
export async function GET(req: Request) {
  const expected = process.env.HQ_GATEWAY_SERVICE_TOKEN;
  const offered = req.headers.get("authorization")?.match(/^Service (\S+)$/)?.[1];
  if (!expected || !offered || !sameSecret(offered, expected)) {
    return Response.json({ error: "auth_required" }, { status: 401 });
  }

  // Every revoked device, every time. No cursor, no page, no limit.
  //
  // The first version took a `since` timestamp and paginated, and was wrong
  // three ways: more rows than the limit sharing a timestamp stalls the cursor
  // for ever, `now()` is transaction-start time so a late-committing row is
  // stepped over permanently, and a cursor shared between Gateway instances
  // lets one consume rows another never sees. A snapshot has no memory and so
  // has none of those failures. The set is a handful of rows and will be for
  // years.
  //
  // Through a security definer function, not the table: device_tokens has
  // forced row-level security and this read is deliberately cross-tenant, so
  // querying it directly returned an empty list under the app role and looked
  // like a successful refresh.
  const { rows } = await pool.query(
    `select device_id, revoked_at from hq_revoked_devices()`);

  return Response.json(
    {
      revoked: rows.map((r) => ({
        deviceId: r.device_id,
        revokedAt: new Date(r.revoked_at).toISOString(),
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
