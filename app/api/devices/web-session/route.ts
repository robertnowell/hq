import { clerkClient } from "@clerk/nextjs/server";
import { identify } from "@/lib/auth";
import { asUser } from "@/lib/db";
import { publicUrl, thumbprintFromProof } from "@/lib/gateway-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A connected Mac signs its own Hub window in.
 *
 * Ruled 30 Sep 2026 (Robert): the Mac app and the hub are one account, not
 * two. "There shouldn't be a potential mismatch... they are the same thing."
 * Before this, a Mac connected any way other than a fresh install opened
 * "open report" onto the hub's sign-in page, because the app's device token
 * and the window's web session were stored apart with nothing between them.
 * Now, when the window finds nobody signed in and the Mac is connected, the
 * app asks here for a one-time sign-in ticket and loads it.
 *
 * This turns a machine credential into a person's web session, which is
 * exactly what identifyPerson refuses to let a bare device token do (safety
 * review, 29 Sep). So a token is not enough: the request must also carry a
 * fresh DPoP proof from the key recorded for that device at pairing, the
 * same two credentials the Gateway token route demands before spending. A
 * copied token file without the Mac's Secure Enclave key gets nothing.
 *
 * The ticket lasts sixty seconds and Clerk accepts it once.
 */
export async function POST(req: Request) {
  const who = await identify(req);
  if (!who) return Response.json({ error: "auth_required" }, { status: 401 });
  if (!who.deviceId) return Response.json({ error: "device_required" }, { status: 403 });
  if (!who.deviceKeyJkt) {
    return Response.json(
      { error: "rebinding_required", detail: "This Mac was connected before key binding. Connect it again." },
      { status: 403 });
  }

  const presented = await thumbprintFromProof(
    req.headers.get("dpop"), "POST", publicUrl(new URL(req.url).pathname));
  if (!presented || presented !== who.deviceKeyJkt) {
    return Response.json({ error: "invalid_dpop_proof" }, {
      status: 401, headers: { "www-authenticate": 'DPoP error="invalid_dpop_proof"' },
    });
  }

  const externalId = await asUser(who.userId, async (c) => {
    const r = await c.query(`select external_id from users where id = $1`, [who.userId]);
    return (r.rows[0]?.external_id as string | undefined) ?? null;
  });
  if (!externalId) return Response.json({ error: "no_account" }, { status: 404 });

  // Where the window should land once signed in: a hub path only, never a
  // full URL, and no backslash (browsers read "/\\x" as "//x"), so this cannot
  // be turned into a redirect to somewhere else.
  const body = await req.json().catch(() => ({}));
  const next = typeof body?.next === "string" && /^\/(?![\/\\])[^\s\\]*$/.test(body.next) ? body.next : "/";

  try {
    const clerk = await clerkClient();
    const { token } = await clerk.signInTokens.createSignInToken({ userId: externalId, expiresInSeconds: 60 });
    const url = new URL("/sign-in", publicUrl("/"));
    url.searchParams.set("__clerk_ticket", token);
    url.searchParams.set("redirect_url", next);
    // `user` is the account's Clerk id, so the app can tell when its window is
    // signed in as someone else and follow (one account, never a mismatch).
    return Response.json({ url: url.toString(), expires_in: 60, user: externalId }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    console.error("web session ticket not minted", (error as Error).message);
    return Response.json({ error: "service_unavailable" }, { status: 503 });
  }
}
