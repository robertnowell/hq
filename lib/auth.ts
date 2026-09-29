import { createHash } from "crypto";
import { auth, currentUser } from "@clerk/nextjs/server";
import { domainOf } from "./domain";
import { pool, assertTenantIsolationPossible } from "./db";

/**
 * Who is asking.
 *
 * Identity resolution deliberately does NOT run inside asUser(): looking up
 * your own user row from inside your own tenant scope is circular, because
 * the RLS policy on `users` needs the id you are trying to find. The auth
 * provider tells us the external id, we map it to our own uuid here, and only
 * then does any tenant-scoped query run.
 *
 * Clerk supplies the external id; this maps it to our own uuid. Everything
 * downstream deals in our uuid, so replacing the provider later touches this
 * one function -- which is the whole reason the indirection exists.
 *
 * The email is not ours to keep. `external_id` is the tenancy key; the
 * address is a convenience for display, read from Clerk when there is a
 * browser session and absent when a machine is asking. Storing a copy in
 * `users` gave it a second home that drifted, so the column is gone.
 *
 * `deviceId` is the `device_tokens` row this request arrived on, and null when
 * a person is asking from a browser.
 *
 * It is not decoration. The Gateway's principal is a user AND a device: a
 * scoped credential is minted for a paired Mac, and revoking that Mac has to
 * stop it spending, which cannot be expressed by a user id alone. There is no
 * separate `device_id` column to reach for -- the token row IS the device, and
 * `hq_user_for_token` has always returned its id as `token_id`. This file used
 * to select it and throw it away, which is why the authorization contract
 * records "lib/auth.ts currently drops the device ID" as a thing to fix before
 * anything can be charged to it.
 *
 * Null is therefore load-bearing rather than a missing value: a browser
 * session is a person, not a paired machine, and nothing that spends money may
 * be authorized from one.
 *
 * `deviceKeyJkt` is the thumbprint of the non-exportable key that device
 * registered when it paired, and is null for a device paired before key
 * binding existed. Such a device mirrors happily and can never be issued a
 * bound token, because there is nothing to bind one to.
 */
export type Identity = {
  userId: string;
  email: string | null;
  /** The team this person belongs to, by the domain of their verified
      address; null for a public provider or a machine. Ruled 27 Sep 2026. */
  domain: string | null;
  deviceId: string | null;
  deviceKeyJkt: string | null;
};

async function currentExternalId(
  _req: Request,
): Promise<{ ext: string; email: string | null } | null> {
  // Clerk is the source of external identity. auth() is async on Next 15.
  // auth() verifies the session locally. currentUser() used to follow it
  // with a round trip to Clerk's API on EVERY request, to fetch an email
  // nothing displayed; that was a fifth of the time to switch agents.
  const { userId } = await auth();
  if (userId) return { ext: userId, email: null };

  // Dev escape hatch, and only in development. In production an unsigned
  // request is unauthenticated, full stop -- a header must never be able to
  // assert an identity, or the header IS the authentication.
  if (process.env.NODE_ENV !== "production" && process.env.HQ_DEV_USER) {
    return { ext: process.env.HQ_DEV_USER, email: null };
  }
  return null;
}

/**
 * A machine credential, exchanged for a user.
 *
 * Checked BEFORE the browser session, because a request carrying a device
 * token is a machine acting on its own behalf and should not accidentally
 * inherit whatever human happens to be signed in on the same host.
 *
 * The token is compared by hash. The plaintext exists once, at mint time, in
 * the response body -- never in the database, never in a log.
 */
type TokenResult = { kind: "none" } | { kind: "bad" } | { kind: "ok"; id: Identity };

async function identifyByToken(req: Request): Promise<TokenResult> {
  const h = req.headers.get("authorization");
  if (!h?.startsWith("Bearer ")) return { kind: "none" };
  const hash = createHash("sha256").update(h.slice(7).trim()).digest("hex");
  const { rows } = await pool.query(
    `select user_id, token_id, key_jkt from hq_user_for_token($1)`, [hash],
  );
  // Presenting a credential that does not work is NOT the same as presenting
  // none. Returning "no identity" here would let the request fall through to
  // the next mechanism, and a revoked token would quietly start working again
  // as whoever happened to be signed in. It did exactly that: a garbage token
  // returned 201 because the dev fallback caught it.
  if (!rows[0]) return { kind: "bad" };
  // A machine speaks for a person; the person's team is on their row.
  const who = await pool.query(
    `select domain from hq_domain_of($1)`, [rows[0].user_id]);
  return {
    kind: "ok",
    id: {
      userId: rows[0].user_id, email: null,
      domain: who.rows[0]?.domain ?? null,
      deviceId: rows[0].token_id, deviceKeyJkt: rows[0].key_jkt ?? null,
    },
  };
}

/**
 * A person, never a machine: the browser session only.
 *
 * Every server action and every page that changes something about the
 * account (approving a machine, revoking one, billing, sharing) resolves
 * through here. A device token is a machine's credential for pushing and
 * reading; it must not approve another machine, revoke devices or change
 * billing (safety review, 29 Sep 2026: server actions accepted the
 * Authorization header, so a copied token could do all three). A request
 * that carries a token is refused outright rather than falling through to a
 * session, so the token cannot borrow whoever is signed in either.
 */
export async function identifyPerson(req: Request): Promise<Identity | null> {
  await assertTenantIsolationPossible();
  if (req.headers.get("authorization")) return null;
  return identifySession(req);
}

export async function identify(req: Request): Promise<Identity | null> {
  await assertTenantIsolationPossible();
  const byToken = await identifyByToken(req);
  if (byToken.kind === "ok") return byToken.id;
  if (byToken.kind === "bad") return null;   // fail closed, never fall through
  return identifySession(req);
}

async function identifySession(req: Request): Promise<Identity | null> {

  const who = await currentExternalId(req);
  if (!who) return null;
  // Goes through a SECURITY DEFINER function rather than a direct insert.
  // The app role cannot write `users` directly -- the RLS policy needs a
  // tenant context that does not exist until this call returns it.
  const { rows } = await pool.query(
    `select id, domain, domain_checked_at from hq_identity($1)`,
    [who.ext],
  );
  let domain: string | null = rows[0].domain ?? null;
  // The address is read from the identity provider ONCE, the first time this
  // person is seen, and never again on the request path: it cost a round trip
  // per request when it ran every time (a fifth of the time to switch agents).
  // What it buys is the team: the domain of the verified address is the one
  // fact the sharing model rests on, and it is recorded here, at the door.
  // Read at first sight, and again once a day (safety review, 29 Sep: a
  // domain read once meant someone who left a company kept its team, and
  // someone who switched to a work address never joined theirs). A failed
  // refresh keeps what was known; a failed first read records nothing.
  const checked = rows[0].domain_checked_at ? new Date(rows[0].domain_checked_at).getTime() : 0;
  if (!checked || Date.now() - checked > 24 * 3600_000) {
    try {
      const address = await verifiedAddress(who.ext);
      domain = domainOf(address);
      await pool.query(`select hq_set_identity($1, $2, $3)`, [rows[0].id, address, domain]);
    } catch (e) {
      if (!checked) throw e;
    }
  }
  // No device: this is a person in a browser, not a paired Mac. See Identity.
  return { userId: rows[0].id, email: who.email, domain, deviceId: null, deviceKeyJkt: null };
}

/**
 * The person's primary address, only if the provider has verified it.
 *
 * An unverified address is not evidence of anything and names no team. In
 * development, with no provider session, HQ_DEV_EMAIL stands in.
 */
async function verifiedAddress(ext: string): Promise<string | null> {
  if (process.env.NODE_ENV !== "production" && process.env.HQ_DEV_USER === ext) {
    return process.env.HQ_DEV_EMAIL ?? null;
  }
  try {
    const u = await currentUser();
    // No user from the provider is "could not read", not "has no address".
    if (!u || u.id !== ext) throw new Error("identity provider returned no user");
    const primary = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId)
      ?? u.emailAddresses[0];
    if (!primary) return null;
    if (primary.verification?.status !== "verified") return null;
    return primary.emailAddress.toLowerCase();
  } catch {
    // The provider was unreachable. Recording "checked" with no address would
    // deny this person their team for ever; leaving it unchecked costs one
    // more lookup next time.
    throw new Error("identity provider unreachable");
  }
}
