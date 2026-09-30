import { sameSecret } from "@/lib/pairing";
import { welcomeRate } from "@/lib/devices";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The hourly look at welcome credits, so a bad day is noticed.
 *
 * Every newly paired Mac gets a welcome credit, and until the Mac can prove
 * it is real (App Attest, macOS 27: hq-app-cll.18) nothing stops a script
 * from pairing invented devices and collecting one each. The daily cap in
 * hq_claim_welcome (db/024) bounds the loss; this is what makes somebody
 * hear about it. Before it, welcomeRate() had no caller at all.
 *
 * It reports to its own Better Stack heartbeat, not the reconciliation one:
 * "free credits are being farmed" and "the ledger disagrees with Stripe" are
 * different pages for different reasons, and one must not hide the other.
 * Silence is still a signal: a heartbeat that stops arriving opens an
 * incident by itself.
 *
 * Alarms when a day's grants reach WELCOME_ALERT_AT (default 5; the busiest
 * real day so far was 4, on 28 Sep 2026) or when the cap has refused anyone,
 * which by definition means ten were already given that day.
 */
const ALERT_AT = Number(process.env.WELCOME_ALERT_AT) > 0 ? Number(process.env.WELCOME_ALERT_AT) : 5;

async function tell(ok: boolean, why: string) {
  const url = process.env.WELCOME_HEARTBEAT_URL;
  if (!url) return;                      // not configured is not an error here
  try {
    await fetch(ok ? url : `${url}/fail`, {
      method: "POST", body: why.slice(0, 512),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.error("heartbeat not sent", (error as Error).message);
  }
}

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const offered = req.headers.get("authorization");
  if (!secret || !sameSecret(offered ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "auth_required" }, { status: 401 });
  }
  try {
    const rate = await welcomeRate();
    const said = `${rate.lastDay} welcome credit(s) in 24h, ${rate.lastHour} in the last hour, ${rate.refusedLastDay} refused at the cap, ${rate.total} ever`;
    const alarm = rate.refusedLastDay > 0 || rate.lastDay >= ALERT_AT;
    if (alarm) console.error("welcome credits look unusual", said);
    await tell(!alarm, alarm ? `unusual: ${said} (alert at ${ALERT_AT}/day)` : said);
    return NextResponse.json({ ...rate, alertAt: ALERT_AT, alarm });
  } catch (error) {
    // Could not look is not the same as looked and liked it.
    console.error("welcome check could not run", (error as Error).message);
    await tell(false, `could not run: ${(error as Error).message}`);
    return NextResponse.json({ error: "not_run" }, { status: 500 });
  }
}
