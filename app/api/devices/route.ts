import { randomBytes, createHash } from "crypto";
import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";
import { approveClaim } from "@/lib/claims";
import { isWellFormedCode } from "@/lib/pairing";

export const runtime = "nodejs";

/**
 * Mint a device token.
 *
 * Deliberately refuses a request that is itself authenticated by a device
 * token: a machine credential must not be able to mint more of itself, or
 * one stolen token becomes permanent and unlimited.
 */
export async function POST(req: Request) {
  if (req.headers.get("authorization")?.startsWith("Bearer ")) {
    return Response.json(
      { error: "a device token cannot mint device tokens" }, { status: 403 });
  }
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const name = (body?.name ?? "laptop").toString().slice(0, 60);

  // With a code, this is a person approving a Mac that is waiting.
  //
  // Nothing is minted here. The row only records that somebody signed in
  // said yes to this device name; the token is created when the Mac
  // collects it, so a live credential never sits in the database waiting to
  // be read. The Mac invented the code and has never sent it anywhere but
  // here, and the page showed a phrase derived from it so the person could
  // check that the Mac in front of them is the one asking.
  if (body?.code !== undefined) {
    if (!isWellFormedCode(body.code)) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    await approveClaim(me.userId, name, body.code);
    return new Response(null, { status: 204 });
  }

  const token = "hq_" + randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");

  const id = await asUser(me.userId, async (c) => {
    const r = await c.query(
      `insert into device_tokens (user_id, name, token_sha256)
       values ($1, $2, $3) returning id`,
      [me.userId, name, hash]);
    return r.rows[0].id;
  });

  // The only time this value exists anywhere. Not stored, not recoverable.
  return Response.json({ id, name, token }, { status: 201 });
}

export async function GET(req: Request) {
  const me = await identify(req);
  if (!me) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const rows = await asUser(me.userId, async (c) => {
    const r = await c.query(
      `select id, name, created_at, last_used_at, revoked_at
         from device_tokens order by created_at desc`);
    return r.rows;
  });
  return Response.json({ devices: rows });
}
