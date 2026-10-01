/**
 * Telling somebody outside this process that something happened.
 *
 * Two channels, one rule: NEITHER MAY EVER FAIL ITS CALLER. An alert that
 * cannot be sent is logged and the thing it was about carries on. The
 * alternative -- a reconciliation that fails because Slack was down, or a
 * payment that fails because an email bounced -- is being loud about the
 * wrong thing, and it is the same rule the native repo's `tb_slack_post`
 * already follows.
 */

/** The house channel, and the same bot token the deploy watchers post with. */
export async function slackCritical(text: string) {
  const token = process.env.SLACK_WRITE_TOKEN;
  const channel = process.env.SLACK_ALERT_CHANNEL;
  if (!token || !channel) { console.warn("slack not configured; not sent:", text.slice(0, 200)); return false; }
  try {
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await r.json().catch(() => ({ ok: false }));
    if (!body.ok) console.error("slack refused", JSON.stringify(body).slice(0, 200));
    return body.ok === true;
  } catch (error) {
    console.error("slack not sent", (error as Error).message);
    return false;
  }
}

/**
 * One transactional email.
 *
 * The from-address is a variable because today the only verified sender is on
 * Kopi's Postmark server, which is a borrow rather than a home: a billing
 * email for this product should eventually come from this product's domain.
 * Swapping it is then one environment variable rather than a code change.
 */
export async function sendEmail(to: string, subject: string, body: string) {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  const from = process.env.POSTMARK_FROM;
  if (!token || !from) { console.warn("email not configured; not sent to", to); return false; }
  try {
    const r = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { "X-Postmark-Server-Token": token, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ From: from, To: to, Subject: subject, TextBody: body, MessageStream: "outbound" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) console.error("postmark refused", r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (error) {
    console.error("email not sent", (error as Error).message);
    return false;
  }
}

/**
 * The address to reach a person on, asked for at the moment of sending.
 *
 * `lib/auth.ts` deliberately does not keep a copy -- "the email is not ours
 * to keep" -- so it is fetched from Clerk when there is actually something to
 * say, and not stored afterwards.
 */
export async function emailFor(userId: string): Promise<string | null> {
  const key = process.env.CLERK_SECRET_KEY;
  if (!key) return null;
  try {
    const { pool } = await import("./db");
    const { rows: [r] } = await pool.query(`select external_id from users where id = $1`, [userId]);
    if (!r?.external_id) return null;
    const res = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(r.external_id)}`, {
      headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const user = await res.json() as { primary_email_address_id?: string;
      email_addresses?: Array<{ id: string; email_address: string }> };
    const primary = user.email_addresses?.find(e => e.id === user.primary_email_address_id)
      ?? user.email_addresses?.[0];
    return primary?.email_address ?? null;
  } catch (error) {
    console.error("could not look up an address", (error as Error).message);
    return null;
  }
}
