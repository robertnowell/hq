import { Pool, PoolClient } from "pg";

// One pool per process. Next.js hot-reloads modules in dev, so it hangs off
// globalThis or every save leaks a pool until the connection limit is hit.
const g = globalThis as unknown as { hqPool?: Pool };
export const pool =
  g.hqPool ??
  (g.hqPool = new Pool({
    connectionString: process.env.HQ_APP_DATABASE_URL,
    // SMALL, AND IT HAS TO BE. This runs on serverless functions: every warm
    // instance holds its own pool, so the real connection count is this
    // number times however many instances the platform has decided to keep.
    // Five looked modest and was not. On 13 Sep the database ran out of
    // connection slots for every role, including the owner, and the drills
    // could not even open one. A request here does one short query and hands
    // the client back, so two is plenty and the queue costs milliseconds.
    max: 2,
    // An idle socket on a function that will never be called again is a
    // connection nobody can use and nobody will close.
    idleTimeoutMillis: 10_000,
    // Better to fail a request in ten seconds than to hold the event loop
    // waiting for a slot that is not coming.
    connectionTimeoutMillis: 10_000,
  }));

/**
 * Run a query as one specific user, with the tenant context set.
 *
 * Everything that touches user data goes through here. Three things are load
 * bearing and none of them are obvious:
 *
 * 1. It is a TRANSACTION. `set_config(..., true)` is the function form of
 *    SET LOCAL, which is scoped to the transaction. Plain SET would persist on
 *    the pooled connection after we hand it back, so the next request on that
 *    socket could inherit this user's context. PgBouncer's own compatibility
 *    table lists SET/RESET as "Never" compatible with transaction pooling.
 *
 * 2. The connection is released in a finally. A leaked client keeps the
 *    tenant context set on it forever, which is the same bug with a longer
 *    fuse.
 *
 * 3. userId comes from the verified session, never from a request parameter.
 *    This function trusts its argument completely, so its callers must not.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function asUser<T>(
  userId: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  await assertTenantIsolationPossible();
  // Checked, not trusted. The id comes from a verified session today, but
  // this is the one place a string is spliced into SQL, so it earns a
  // predicate rather than a comment -- and a bad id fails here rather than
  // reaching the database.
  if (!UUID.test(userId)) throw new Error("asUser: not a user id");
  const c = await pool.connect();
  try {
    // One round trip, not two.
    //
    // The database is in us-east-1 and a laptop is not, so each statement
    // costs a fat fraction of a second before Postgres has read a byte.
    // BEGIN and the context-set are always issued together and never
    // separately, so sending them separately bought nothing and cost a
    // whole round trip on every query on every page.
    //
    // This uses the simple protocol, which cannot carry parameters -- hence
    // the UUID check above. quote_literal would be the belt to that braces
    // but the value has already been proven to be 36 hex characters and
    // dashes, which no amount of quoting could make dangerous.
    await c.query(`begin; select set_config('hq.user_id', '${userId}', true)`);
    const out = await fn(c);
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Refuse to serve if the database role can bypass RLS.
 *
 * This is not paranoia, it is a bug I already shipped once. Neon's default
 * role `neondb_owner` has rolbypassrls = true, and BYPASSRLS overrides even
 * FORCE ROW LEVEL SECURITY. With the schema perfectly correct and every
 * policy in place, the app connected with the owner's connection string and
 * cheerfully listed three users' documents on one page.
 *
 * Nothing about that failure was visible: no error, no warning, just more
 * rows than there should have been. So the check runs once at startup and
 * makes it loud, because the alternative is that it stays quiet.
 */
let guardChecked = false;
export async function assertTenantIsolationPossible() {
  if (guardChecked) return;
  const { rows } = await pool.query(
    `select current_user as who, rolsuper, rolbypassrls
       from pg_roles where rolname = current_user`,
  );
  const r = rows[0];
  if (r.rolsuper || r.rolbypassrls) {
    throw new Error(
      `REFUSING TO START: connected as "${r.who}", which bypasses row-level ` +
      `security (superuser=${r.rolsuper}, bypassrls=${r.rolbypassrls}). ` +
      `Every RLS policy is inert for this role. Use the hq_app connection ` +
      `string (HQ_APP_DATABASE_URL), not the owner's.`,
    );
  }
  guardChecked = true;
}
