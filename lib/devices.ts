import { asUser, pool } from "./db";

export type Device = {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

/**
 * Every Mac this account has connected, newest first.
 *
 * Revoked rows are kept and shown rather than deleted. A credential that once
 * existed is part of the account's history: "I revoked that laptop in March"
 * is a thing a person needs to be able to see, and a list that silently
 * shortens cannot tell them.
 */
export async function devices(userId: string): Promise<Device[]> {
  return asUser(userId, async (c) => {
    const r = await c.query(
      `select id, name, created_at, last_used_at, revoked_at
         from device_tokens
        order by revoked_at is not null, created_at desc`);
    return r.rows as Device[];
  });
}

/**
 * Stop a Mac.
 *
 * The row is stamped, never deleted: `hq_user_for_token` already refuses a
 * token whose `revoked_at` is set, so one UPDATE ends every future request
 * that credential could make, on that machine and anywhere it was copied to.
 *
 * Runs inside the tenant scope, so the id is checked by row-level security
 * rather than by a WHERE clause somebody could forget: passing another
 * account's device id updates nothing and returns 0.
 *
 * Revoking twice is not an error, it is the same answer: already stopped.
 */
export async function revokeDevice(userId: string, id: string): Promise<boolean> {
  return asUser(userId, async (c) => {
    const r = await c.query(
      `update device_tokens set revoked_at = now()
        where id = $1 and revoked_at is null`, [id]);
    return (r.rowCount ?? 0) > 0;
  });
}

/**
 * Is any Mac connected right now?
 *
 * The empty hub asks exactly this, because "nothing here yet" has two causes
 * with two different next actions: connect a Mac, or start an agent on the
 * one you already connected. Telling somebody to connect a Mac they connected
 * this morning is how a first run stops being believable.
 */
export async function hasLiveDevice(userId: string): Promise<boolean> {
  return asUser(userId, async (c) => {
    const r = await c.query(
      `select 1 from device_tokens where revoked_at is null limit 1`);
    return r.rows.length > 0;
  });
}

/**
 * Has this machine already been given the welcome credit?
 *
 * Claims it in the same call, so two sign-ups racing on one Mac cannot both
 * be told yes. Answers true again for the user who already holds it, because
 * the mint runs every fifteen minutes for the same person and has to keep
 * saying the same thing.
 *
 * Failing CLOSED is deliberate. If this cannot be decided -- the database is
 * unreachable, the function is missing after a partial deploy -- the answer
 * is "not eligible", which costs a real new person ten dollars of credit they
 * can ask for, and costs us nothing. The other direction gives money away
 * during an outage, which is exactly when nobody is watching.
 */
export async function claimWelcome(userId: string, jkt: string | null): Promise<boolean> {
  if (!jkt) return false;
  try {
    const { rows: [r] } = await pool.query(`select hq_claim_welcome($1, $2) as ok`, [userId, jkt]);
    return r?.ok === true;
  } catch (error) {
    console.error("welcome eligibility could not be decided", (error as Error).message);
    return false;
  }
}

/** What has been given away lately, for whoever has to notice a bad day. */
export async function welcomeRate() {
  const { rows: [r] } = await pool.query(`select * from hq_welcome_rate()`);
  return { lastDay: Number(r.last_day), lastHour: Number(r.last_hour), total: Number(r.total), refusedLastDay: Number(r.refused_last_day ?? 0) };
}
