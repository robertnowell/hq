import { sameSecret } from "@/lib/pairing";
import { pool } from "@/lib/db";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The hourly look at every Mac's agent-rules health, so a machine on old
 * rules, or with reports its agents wrote that never arrived, is heard about
 * within the hour. On 30 Sep 2026 that took six days and a person noticing.
 *
 * Its own Better Stack heartbeat (FLEET_HEARTBEAT_URL), like the welcome
 * credits check: a problem reports /fail with the Macs and what is wrong;
 * silence from the check itself opens an incident by the heartbeat's grace.
 */
async function tell(ok: boolean, why: string) {
  const url = process.env.FLEET_HEARTBEAT_URL;
  if (!url) return;
  try {
    await fetch(ok ? url : `${url}/fail`, {
      method: "POST", body: why.slice(0, 1000), signal: AbortSignal.timeout(5000),
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
    const { rows } = await pool.query(`select * from hq_fleet_problems()`);
    const { rows: [n] } = await pool.query(`select hq_fleet_reporting() as n`);
    const reporting = Number(n?.n ?? 0);
    if (rows.length) {
      const said = rows.map((r) => `${r.device} (${String(r.edition).split(".").pop()}): ${(r.problems as string[]).join("; ")}`)
        .join(" | ");
      console.error("fleet problems", said);
      await tell(false, `${rows.length} Mac(s) with agent-rules problems: ${said}`);
    } else {
      await tell(true, `${reporting} Mac(s) reported in 3h, no problems`);
    }
    return NextResponse.json({ reporting, problems: rows });
  } catch (error) {
    console.error("fleet check could not run", (error as Error).message);
    await tell(false, `could not run: ${(error as Error).message}`);
    return NextResponse.json({ error: "not_run" }, { status: 500 });
  }
}
