import { asUser } from "./db";
import { codeHash } from "./pairing";

/**
 * A person, signed in, says yes to one waiting Mac.
 *
 * Nothing is minted here and nothing is returned. The row records only that
 * this account approved this device name for the machine holding the code;
 * the token is created later, once, inside the claim route when the Mac
 * comes to collect it. A live credential therefore never sits in the
 * database waiting to be read.
 *
 * `on conflict do nothing` makes a double-submit harmless: the second press
 * of Connect, or a reload of the page that posts it, changes nothing rather
 * than resetting the clock or re-approving a code that was already spent.
 *
 * Both callers of the pairing flow go through here -- the /connect page's
 * action and POST /api/devices with a code -- so there is one place where
 * an approval is written and one place to read to know what it does.
 */
export async function approveClaim(userId: string, name: string, code: string): Promise<void> {
  await asUser(userId, async (c) => {
    await c.query(
      `insert into device_claims (code_sha256, user_id, device_name, expires_at)
       values ($1, $2, $3, now() + interval '10 minutes')
       on conflict (code_sha256) do nothing`,
      [codeHash(code), userId, name]);
  });
}
