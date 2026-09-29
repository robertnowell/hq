import { createHash, timingSafeEqual } from "crypto";

/**
 * The pairing code, and the phrase a person checks.
 *
 * A Mac with no credential cannot be told anything, so it invents a secret
 * of its own: 32 random bytes it keeps in memory and shows to nobody. What
 * it DOES show is a short phrase derived from that secret, and the same
 * phrase appears on the page that asks whether to connect it.
 *
 * That phrase is the whole defence against a mailed link. Without it,
 * somebody could send a signed-in person a connect address carrying their
 * own code and a plausible Mac name, and one click would pair the sender's
 * machine to the reader's account. RFC 8628 section 5.4 names this exactly:
 * once the code travels in the URL and nobody types it, the flow has to
 * confirm the device is in the user's possession instead, and the way it
 * suggests is showing the code in both places.
 *
 * Derived, never transmitted: the phrase is a function of the code, so the
 * page can compute it without the panel sending it, and a page that was
 * handed a different code shows a different phrase.
 */
export function phraseFor(code: string): string {
  const hex = createHash("sha256").update(code).digest("hex").slice(0, 6).toUpperCase();
  return `${hex.slice(0, 3)}-${hex.slice(3)}`;
}

/** The fingerprint the database stores. The code itself is never written down. */
export function codeHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/**
 * 32 bytes, base64url, as the panel mints it. Checked for shape before it is
 * hashed so a malformed body is a 400 rather than a lookup that cannot match.
 */
export function isWellFormedCode(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
}

/** Equal-length constant-time compare, for anywhere a secret is compared directly. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The public half of the key a Mac will prove possession with.
 *
 * Checked narrowly on purpose. This value arrives on the one unauthenticated
 * route in the app, from a caller holding nothing but a pairing code, and it
 * is about to be written next to a live credential. So it must be an EC
 * P-256 public key and nothing else: no other curve, no RSA (whose key sizes
 * are a denial-of-service parameter), no symmetric key, and above all no
 * private key, which would be someone handing us a secret we must not hold.
 *
 * P-256 is not a preference. It is the only curve an Apple Secure Enclave
 * will generate, and the enclave is the entire point: a key that cannot be
 * copied off the machine, by anyone, including someone who can read every
 * file on it.
 */
export type DeviceKey = { kty: "EC"; crv: "P-256"; x: string; y: string };

export function isDeviceKey(v: unknown): v is DeviceKey {
  if (!v || typeof v !== "object") return false;
  const k = v as Record<string, unknown>;
  if (k.kty !== "EC" || k.crv !== "P-256") return false;
  // A private key has `d`. Refuse rather than strip: a caller that sent one
  // has made a mistake worth failing on, and quietly accepting it would mean
  // the value we logged as a public key was not one.
  if ("d" in k || "k" in k) return false;
  const b64url = /^[A-Za-z0-9_-]{43}$/;   // 32 bytes, which P-256 coordinates are
  return typeof k.x === "string" && b64url.test(k.x)
    && typeof k.y === "string" && b64url.test(k.y);
}

/**
 * The RFC 7638 thumbprint, computed here rather than accepted from the wire.
 *
 * A client-supplied thumbprint would be a client-supplied answer to the
 * question "which key is this", which is the question the whole binding
 * rests on. Deriving it from the key we were actually given is the only
 * version that means anything.
 */
export async function thumbprintOf(key: DeviceKey): Promise<string> {
  const { calculateJwkThumbprint } = await import("jose");
  return calculateJwkThumbprint(key, "sha256");
}
