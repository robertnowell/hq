import { calculateJwkThumbprint, EmbeddedJWK, importJWK, jwtVerify, SignJWT,
  type JWK } from "jose";

/**
 * Minting the credential that spends.
 *
 * The hub is the only thing that knows who a person is; the Gateway is the
 * only thing that knows what they have left. This is the seam between them,
 * and the contract it implements is contracts/gateway/v1/TOKEN.md in the
 * native repo. Read that before changing anything here: the Gateway enforces
 * the audience and the fifteen-minute ceiling independently, so a change made
 * only on this side produces tokens the other side silently refuses.
 */

/** Frozen in Gateway.authorize. Not a setting. */
export const GATEWAY_AUDIENCE = "tranquility-gateway";
/** Also frozen there, as 900_000 ms. Stated in seconds because `exp` is. */
export const MAX_LIFETIME_SECONDS = 900;

/**
 * What a freshly paired Mac is allowed to do.
 *
 * Decided here, on the server, and never read from the request: a client flag
 * that could widen a scope is not a scope. The Gateway checks the specific
 * scope each route needs, so this list is a ceiling rather than a grant.
 */
// `voice:session` (VOICE.md), `speech:create` (SPEECH.md) and
// `transcription:session` (TRANSCRIPTION.md) ride with the rest since 21 Sep: a Mac that can spend on summaries can spend on
// hands-free, on the premium voice and on the live transcript, from the
// same grant, each metered separately by the Gateway.
export const DEFAULT_SCOPES = ["account:read", "summary:read", "summary:create", "voice:session",
  "speech:create", "transcription:session", "recovery:create"];

export const issuer = () =>
  process.env.HQ_GATEWAY_ISSUER ?? "https://hq.tranquilitybase.dev";

/**
 * The signing key, from the environment, and absent by default.
 *
 * There is deliberately no generated fallback. A key invented at boot would
 * make every instance sign with a different one, mint tokens nothing could
 * verify, and rotate silently on every deploy. Absent means this deployment
 * cannot mint, which is a refusal the mint route turns into a 503.
 */
export async function signingKey(): Promise<{ key: CryptoKey; kid: string; jwk: JWK } | null> {
  const raw = process.env.HQ_GATEWAY_SIGNING_JWK;
  if (!raw) return null;
  const jwk = JSON.parse(raw) as JWK;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d) {
    throw new Error("HQ_GATEWAY_SIGNING_JWK must be an EC P-256 private key");
  }
  const kid = jwk.kid ?? await calculateJwkThumbprint(publicHalf(jwk), "sha256");
  return { key: await importJWK(jwk, "ES256") as CryptoKey, kid, jwk };
}

/** Everything but `d`, which must never leave this process. */
function publicHalf(jwk: JWK): JWK {
  const { kty, crv, x, y, kid, alg, use } = jwk;
  return { kty, crv, x, y, ...(kid ? { kid } : {}), ...(alg ? { alg } : {}),
    ...(use ? { use } : {}) };
}

/**
 * What the Gateway fetches to check a signature.
 *
 * A set rather than a key, because rotation has to be possible without a
 * flag day: publish the new key alongside the old, let tokens signed by the
 * old one expire (fifteen minutes), then drop it.
 */
export async function publicJwks(): Promise<{ keys: JWK[] }> {
  const signing = await signingKey();
  if (!signing) return { keys: [] };
  // From the JWK we parsed, NOT by exporting the imported CryptoKey. An
  // imported private key is not extractable, so that round trip throws, and it
  // threw the first time the hub's mint and the Gateway's verifier were run
  // against each other. Dropping `d` from a value we already hold is also the
  // shorter way to say the same thing.
  return { keys: [{ ...publicHalf(signing.jwk), kid: signing.kid, alg: "ES256", use: "sig" }] };
}

/**
 * The proof a Mac presents when asking for a token.
 *
 * RFC 9449 binds an access token to the key that asked for it, which means
 * the ASKING has to be signed too. Without this step the mint would hand a
 * bound token to anyone holding the device token from the file, and the
 * binding would protect a window while leaving the door open.
 *
 * Returns the thumbprint of the key that signed, or null. The caller compares
 * it with the thumbprint that device registered when it paired.
 */
export async function thumbprintFromProof(
  proof: string | null, method: string, url: string, windowSeconds = 60,
  now: () => number = Date.now,
): Promise<string | null> {
  if (!proof) return null;
  try {
    const { payload, protectedHeader } = await jwtVerify(proof, EmbeddedJWK, {
      typ: "dpop+jwt", algorithms: ["ES256"], clockTolerance: 0,
    });
    const jwk = protectedHeader.jwk;
    if (!jwk || "d" in jwk || "k" in jwk) return null;
    const claims = payload as Record<string, unknown>;
    if (typeof claims.jti !== "string" || claims.jti.length < 16) return null;
    if (claims.htm !== method) return null;
    // Query and fragment are excluded from htu, per RFC 9449 section 4.2.
    if (claims.htu !== url) return null;
    if (typeof claims.iat !== "number") return null;
    const age = now() - claims.iat * 1000;
    if (Math.abs(age) > windowSeconds * 1000) return null;
    return calculateJwkThumbprint(jwk, "sha256");
  } catch {
    return null;
  }
}

/**
 * The public URL the Mac signed, which is not the one this process observes.
 *
 * RFC 9449 says nothing about reverse proxies, and every hosted deployment is
 * behind one: the Mac signs `https://hub/...` and the runtime sees whatever
 * the platform put in the Host header. Trusting that header would move the
 * binding into a value the caller controls, so the public origin is stated in
 * configuration and the path is taken from the request.
 */
export function publicUrl(path: string): string {
  const base = new URL(issuer());
  return new URL(path.split("?")[0].split("#")[0], base).toString();
}

export type Minted = { token: string; expiresIn: number };

export async function mint(args: {
  userId: string; deviceId: string; jkt: string;
  scopes?: string[]; promotionalEligible: boolean;
}): Promise<Minted | null> {
  const signing = await signingKey();
  if (!signing) return null;
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({
    device: args.deviceId,
    scope: (args.scopes ?? DEFAULT_SCOPES).join(" "),
    cnf: { jkt: args.jkt },
    promotional_eligible: args.promotionalEligible,
  })
    .setProtectedHeader({ alg: "ES256", typ: "at+jwt", kid: signing.kid })
    .setIssuer(issuer())
    .setAudience(GATEWAY_AUDIENCE)
    .setSubject(args.userId)
    .setIssuedAt(now)
    .setExpirationTime(now + MAX_LIFETIME_SECONDS)
    .sign(signing.key);
  return { token, expiresIn: MAX_LIFETIME_SECONDS };
}
