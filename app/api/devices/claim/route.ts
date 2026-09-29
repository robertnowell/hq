import { randomBytes, createHash } from "crypto";
import { pool } from "@/lib/db";
import { codeHash, isDeviceKey, isWellFormedCode, thumbprintOf } from "@/lib/pairing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A Mac collects the pairing a person approved.
 *
 * THE ONLY UNAUTHENTICATED ROUTE IN THIS APP, and it has to be: a Mac that
 * has never been connected holds no credential, which is the entire problem
 * being solved. What stands in for one is the code, which the Mac invented
 * itself out of 32 random bytes and has sent to nobody else. Guessing it is
 * not a thing anyone can do.
 *
 * Everything else is the polling contract from RFC 8628 section 3.5, which
 * is worth copying rather than inventing: a client that is told to wait
 * waits, a client that is told to slow down adds five seconds, and a client
 * that is told the code is finished stops. An unknown code and a pending one
 * get the same answer, so nothing here is an oracle.
 *
 * The token is minted HERE and only its hash is handed to the database, so
 * the plaintext exists for one response and is never written down. That is
 * the same rule device_tokens states about itself, kept intact through a
 * flow that could easily have broken it by parking a token for collection.
 *
 * Collection is also where a Mac registers the public half of the key it
 * will prove possession with, because this is the first and only moment the
 * MACHINE is talking rather than the browser: the person approving in the
 * browser has no access to the Mac's enclave. A Mac that sends no key is
 * still paired and still mirrors; it simply cannot be granted spending
 * authority later, which is what `key_jkt` being null means.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  if (!isWellFormedCode(body?.code)) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // Minted before the lookup so the database is never asked to hold a live
  // secret: it receives a fingerprint and decides whether to keep it.
  const token = "hq_" + randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");

  // Derived from the key we were handed, never taken from the body: a
  // client-supplied thumbprint would be a client-supplied answer to the one
  // question the binding rests on.
  let jkt: string | null = null;
  if (body?.key !== undefined) {
    if (!isDeviceKey(body.key)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    jkt = await thumbprintOf(body.key);
  }

  const { rows } = await pool.query(
    `select status, device_id, device_name from hq_claim_device($1, $2, $3)`,
    [codeHash(body.code), tokenHash, jkt]);
  const status = rows[0]?.status ?? "pending";

  switch (status) {
    case "ok":
      return Response.json(
        { token, device_id: rows[0].device_id, device_name: rows[0].device_name },
        { status: 200 });
    case "slow_down":
      return Response.json({ error: "slow_down" }, { status: 429 });
    case "expired":
    case "claimed":
      // One answer for both: from the Mac's side there is nothing to wait
      // for and nothing it can do, and which of the two it is tells a
      // stranger something it does not need to know.
      return Response.json({ error: "expired_token" }, { status: 410 });
    default:
      return Response.json({ error: "authorization_pending" }, { status: 202 });
  }
}
