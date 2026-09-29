import { sameSecret } from "@/lib/pairing";
import { NextResponse } from "next/server";
import { lookedAtNothing, reconcile, recordReconciliation } from "@/lib/reconcile";

/**
 * Tell the outside world this ran, and whether it liked what it saw.
 *
 * A row in a table is a record; it is not a thing that notices. This is the
 * part that notices. Silence IS the signal: the heartbeat expects a ping every
 * hour and raises an incident when one does not arrive, so a cron that stops
 * -- the failure that is otherwise completely invisible -- alerts by itself
 * without anything having to detect it.
 *
 * A bad run reports failure explicitly rather than just staying quiet, so a
 * disagreement about money does not wait out the grace window before anybody
 * hears about it.
 */
async function tell(ok: boolean, why: string) {
  const url = process.env.RECONCILE_HEARTBEAT_URL;
  if (!url) return;                      // not configured is not an error here
  try {
    await fetch(ok ? url : `${url}/fail`, {
      method: "POST", body: why.slice(0, 512),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    // Never let the watcher break the thing it watches.
    console.error("heartbeat not sent", (error as Error).message);
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * The hourly check that the two records of the money still agree.
 *
 * Hourly rather than every fifteen minutes, because this is a safety net and
 * not a control loop: nothing it finds needs acting on within the hour, and
 * every run costs a walk through Stripe's API. The autopay check is the one
 * that has to be prompt.
 *
 * It records every run, including the quiet ones. A row saying "eleven
 * compared, eleven agreed" is evidence; a GAP in these rows means the check
 * stopped, which is its own kind of bad news and is invisible if only the
 * unhappy runs are written down.
 *
 * It does not fix anything. Finding that a payment was never credited is the
 * beginning of a conversation with a person, not an instruction to credit.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const offered = req.headers.get("authorization");
  if (!secret || !sameSecret(offered ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "auth_required" }, { status: 401 });
  }

  try {
    // The window is settable so the "looked at nothing" guard can be FIRED on
    // purpose rather than trusted: a short enough window over a quiet period
    // compares nothing, and must come back 500. A guard nobody has ever seen
    // trip is a guard nobody knows works. The scheduler passes nothing and
    // gets thirty days.
    // A MISSING parameter is not a zero. `Number(null)` is 0, which is a
    // perfectly good integer inside any range that starts at zero -- so the
    // scheduler, which passes nothing, was handed a zero time budget and
    // every real run failed as "nothing compared". Absent is read as absent.
    const asked = new URL(req.url).searchParams;
    const number = (name: string, fallback: number, low: number, high: number) => {
      const raw = asked.get(name);
      if (raw === null) return fallback;
      const n = Number(raw);
      return Number.isInteger(n) && n >= low && n <= high ? n : fallback;
    };
    const days = number("days", 30, 1, 365);
    // The time box is settable for the same reason. A run that is cut off
    // before it compares anything has also looked at nothing, and must fail
    // the same way -- which is what makes the guard exercisable without
    // waiting for a quiet month.
    const result = await reconcile(days, number("budgetMs", 45_000, 0, 45_000));

    // The Gateway's own hour's work, on the same clock. It has no scheduler
    // of its own and does not need one: a second thing that must be watched
    // is a second thing that can silently stop, and this one is already
    // watched. It sweeps money nobody is coming back for and audits the
    // ledger's arithmetic; a failure here is reported but does not discard
    // the reconciliation that already succeeded.
    let gateway: unknown = null;
    try {
      const base = process.env.HQ_GATEWAY_BASE?.replace(/\/+$/, "");
      const g = await fetch(`${base}/v1/service/sweep`, {
        method: "POST", cache: "no-store",
        headers: { authorization: `Service ${process.env.HQ_GATEWAY_SERVICE_TOKEN}` },
      });
      gateway = g.ok ? await g.json() : { error: `sweep ${g.status}` };
      const audit = (gateway as { audit?: { ok?: boolean } })?.audit;
      if (audit && audit.ok === false) {
        console.error("ledger invariants failed", JSON.stringify(gateway));
        await tell(false, `ledger invariants failed: ${JSON.stringify(audit)}`.slice(0, 400));
      }
    } catch (error) {
      gateway = { error: (error as Error).message };
      console.error("gateway sweep", (error as Error).message);
    }
    // Recorded either way -- a run that looked at nothing is a fact worth
    // keeping -- but it is NOT reported as a pass. The first one was, and a
    // green tick over an empty room is the most dangerous output this service
    // can produce.
    await recordReconciliation(result);
    if (lookedAtNothing(result)) {
      await tell(false, `looked at nothing: ${result.accounts} account(s), ${result.compared} compared`);
      console.error("reconciliation looked at nothing", JSON.stringify({ accounts: result.accounts, compared: result.compared }));
      return NextResponse.json({ error: "nothing_compared", accounts: result.accounts, compared: result.compared }, { status: 500 });
    }
    if (result.findings.length) {
      // Loud, with the identifiers, because this is the one outcome somebody
      // has to read. The row in the table is the durable copy.
      console.error("reconciliation disagreed", JSON.stringify(result.findings));
      await tell(false, result.findings.map(f => `${f.key}: ${f.said}`).join("; "));
    } else {
      await tell(true, `${result.compared} compared, all agreed`);
    }
    return NextResponse.json({
      accounts: result.accounts, compared: result.compared, agreed: result.agreed,
      findings: result.findings.length, tookMs: result.tookMs, gateway,
    });
  } catch (error) {
    // A check that could not run is NOT a check that passed, and must not be
    // recorded as one. The missing row is the signal.
    console.error("reconciliation could not run", (error as Error).message);
    await tell(false, `could not run: ${(error as Error).message}`);
    return NextResponse.json({ error: "not_run" }, { status: 500 });
  }
}
