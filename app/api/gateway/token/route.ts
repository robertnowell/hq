import { claimWelcome } from "@/lib/devices";
import { identify } from "@/lib/auth";
import { mint, publicUrl, thumbprintFromProof } from "@/lib/gateway-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A paired Mac exchanges what it has for authority to spend.
 *
 * This is the whole of "one sign-in". The person signed in once, in a
 * browser, and approved this machine; everything after that happens here,
 * silently, with no second login, no token field and no authorization code to
 * paste. AUTHORIZATION.md in the native repo is the requirement; TOKEN.md is
 * the wire format.
 *
 * Two credentials are required and neither is sufficient:
 *
 *  1. The device token from the keychain, which says WHICH Mac this is.
 *  2. A DPoP proof signed by that Mac's Secure Enclave key, which says the
 *     Mac is really here rather than that its token was copied.
 *
 * The second is the point. A device token is a long-lived secret in a file,
 * and a file can be read; requiring a signature from a key that cannot leave
 * the machine is what makes the file worth nothing on its own. That is also
 * why the proof is checked against the thumbprint recorded AT PAIRING rather
 * than against whatever key turns up: a caller holding a stolen token could
 * otherwise present a key of their own and be bound to it happily.
 */
export async function POST(req: Request) {
  const who = await identify(req);
  if (!who) return Response.json({ error: "auth_required" }, { status: 401 });

  // A person in a browser is not a machine. Spending authority belongs to a
  // paired device, which is the only thing revocation can take away.
  if (!who.deviceId) {
    return Response.json({ error: "device_required" }, { status: 403 });
  }

  // Paired before key binding existed. Nothing can be issued: there is no key
  // to bind to, and inventing one now would bind to whoever is asking. The
  // answer is to pair again, and the app says so rather than retrying.
  if (!who.deviceKeyJkt) {
    return Response.json(
      { error: "rebinding_required",
        detail: "This Mac was connected before key binding. Connect it again." },
      { status: 403 },
    );
  }

  const proof = req.headers.get("dpop");
  const url = publicUrl(new URL(req.url).pathname);
  const presentedJkt = await thumbprintFromProof(proof, "POST", url);
  if (!presentedJkt) {
    return Response.json({ error: "invalid_dpop_proof" }, {
      status: 401, headers: { "www-authenticate": 'DPoP error="invalid_dpop_proof"' },
    });
  }
  // Not a timing-sensitive comparison: both sides are public thumbprints, and
  // learning that a guess was wrong tells an attacker nothing they could not
  // compute from a public key they already hold.
  if (presentedJkt !== who.deviceKeyJkt) {
    return Response.json({ error: "invalid_dpop_proof" }, {
      status: 401, headers: { "www-authenticate": 'DPoP error="invalid_dpop_proof"' },
    });
  }

  const minted = await mint({
    userId: who.userId,
    deviceId: who.deviceId,
    jkt: who.deviceKeyJkt,
    // The hub decides eligibility because eligibility is an identity and abuse
    // question, and the ledger cannot see those. It is not a licence to grant
    // twice: the Gateway enforces one grant per account by key, so the worst a
    // stale eligible token can do is ask for something already spent.
    //
    // The control is the MACHINE, not the account. A grant only ever reaches
    // an account through a token, and a token is only minted for a paired Mac
    // holding a non-exportable key -- so free money already costs an attacker
    // a real machine, and keying on that key makes a second account on the
    // same Mac cost a second Mac. A reinstall gets its own credit; that is
    // the accepted price of not fingerprinting somebody's computer.
    //
    // Not being eligible blocks nothing. The account pairs, mints and spends
    // exactly as before -- it just spends its own money.
    promotionalEligible: await claimWelcome(who.userId, who.deviceKeyJkt),
  });
  if (!minted) {
    // No signing key configured. The deployment cannot mint, which is a
    // service problem and explicitly not an authentication one: the app must
    // not read this as "signed out" and send the person back to a browser.
    return Response.json({ error: "service_unavailable" }, { status: 503 });
  }

  return Response.json(
    { access_token: minted.token, token_type: "DPoP", expires_in: minted.expiresIn },
    { headers: { "cache-control": "no-store" } },
  );
}
