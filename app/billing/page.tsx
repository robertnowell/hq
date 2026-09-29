import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { identifyPerson } from "@/lib/auth";
import {
  billingFor, fundsCheckout, gatewayBalance, microsToCents, money,
  saveRule, setAutopay,
} from "@/lib/billing";
import "./billing.css";

export const dynamic = "force-dynamic";

const when = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** The ledger stores movements, some of them negative; a page shows amounts.
 *  Without this a refund reads "$-5.00", which is nobody's idea of money. */
const abs = (micros: string) => (BigInt(micros) < 0n ? -BigInt(micros) : BigInt(micros));

/** What a row of the ledger is called on a page a person reads. */
function describe(e: { kind: string; product?: string; seconds?: string; grantKey?: string }) {
  if (e.kind === "bought") {
    return e.grantKey === "welcome-v1" ? "welcome credit" : "topped up";
  }
  // Money that went back: a refund reads differently from a purchase and
  // differently again from spending, so it says which it was.
  if (e.kind === "refunded") {
    return e.grantKey?.startsWith("stripe:dispute:") ? "payment disputed" : "refunded to your card";
  }
  switch (e.product) {
    case "summary": return "a summary";
    case "speech": return "spoken aloud";
    case "recovery": return "recovered a recording";
    case "voice": return "hands-free";
    case "transcription": return "listening";
    default: return "used";
  }
}

async function activityFor(userId: string) {
  try {
    const base = process.env.HQ_GATEWAY_BASE?.replace(/\/+$/, "");
    const r = await fetch(`${base}/v1/service/accounts/${userId}/activity`, {
      headers: { authorization: `Service ${process.env.HQ_GATEWAY_SERVICE_TOKEN}` },
      cache: "no-store",
    });
    if (!r.ok) return [];
    return (await r.json()).entries as any[];
  } catch { return []; }
}

export default async function Billing({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const h = await headers();
  const me = await identifyPerson(new Request("http://local", { headers: h }));
  if (!me) redirect(`/sign-in?redirect_url=${encodeURIComponent("/billing")}`);

  const b = await billingFor(me.userId);
  // The balance is the Gateway's; if it cannot be reached we say so rather
  // than showing a zero, because "unreachable" and "empty" are different
  // facts and only one of them means stop.
  let balance: bigint | null = null;
  try { balance = await gatewayBalance(me.userId); } catch { balance = null; }
  const activity = await activityFor(me.userId);
  const justBought = (await searchParams).bought === "1";

  async function addFunds(form: FormData) {
    "use server";
    const hh = await headers();
    const who = await identifyPerson(new Request("http://local", { headers: hh }));
    if (!who) return;
    const dollars = Math.max(5, Math.min(Number(form.get("dollars")) || 10, 500));
    const row = await billingFor(who.userId);
    const origin = hh.get("origin") ?? process.env.HQ_GATEWAY_ISSUER ?? "";
    const session = await fundsCheckout(row, dollars * 100, `${origin}/billing`);
    redirect(session.url!);
  }

  async function changeRule(form: FormData) {
    "use server";
    const hh = await headers();
    const who = await identifyPerson(new Request("http://local", { headers: hh }));
    if (!who) return;
    const below = BigInt(Math.max(0, Math.round((Number(form.get("below")) || 2) * 1_000_000)));
    const upto = BigInt(Math.max(1, Math.round((Number(form.get("upto")) || 12) * 1_000_000)));
    if (upto > below) await saveRule(who.userId, below, upto);
    revalidatePath("/billing");
  }

  async function toggle(form: FormData) {
    "use server";
    const hh = await headers();
    const who = await identifyPerson(new Request("http://local", { headers: hh }));
    if (!who) return;
    await setAutopay(who.userId, form.get("on") === "1");
    revalidatePath("/billing");
  }

  return (
    <main className="bl">
      <h1 className="bl-h1">Billing</h1>
      <p className="bl-sub">Your credit, your card, and what your agents have spent.</p>

      <div className="bl-cols">
        <section className="bl-card">
          <h2>Plan</h2>
          <p className="bl-plan">Pay as you go</p>
          <p>Only pay for what your agents use. No plan, no commitment, no monthly minimum.</p>

          <div className="bl-hr" />
          <p className="bl-lab">Current balance</p>
          <div className="bl-top">
            <div className="bl-amount">{balance === null ? "—" : money(balance)}</div>
            <form action={addFunds}>
              <input type="hidden" name="dollars" value="10" />
              <button type="submit" className="bl-btn">Add funds</button>
            </form>
          </div>

          {justBought && (
            <div className="bl-pill"><i />Thank you — your credit will appear here in a moment.</div>
          )}
          {balance === null && (
            <div className="bl-pill" data-warn><i />We could not reach your balance just now. Nothing is wrong with your credit.</div>
          )}
          {balance !== null && b.pausedAt && (
            <div className="bl-pill" data-warn><i />{b.pausedReason ?? "Your card was declined."} Nothing was charged.</div>
          )}
          {balance !== null && !b.pausedAt && b.autopay && b.card && (
            <div className="bl-pill"><i />Autopay is on. Your balance tops up on its own.</div>
          )}
          {balance !== null && !b.card && (
            <div className="bl-pill"><i />Welcome credit, no card needed.</div>
          )}

          <div className="bl-hr" />
          <p className="bl-lab">Recent activity</p>
          {activity.length === 0 ? (
            <p className="bl-fine" style={{ margin: 0 }}>Nothing yet. This fills in as your agents work.</p>
          ) : (
            <ul className="bl-led">
              {activity.map((e, i) => (
                <li key={i}>
                  <span>{when(e.at)} · <b className={e.kind === "bought" ? "up" : undefined}>
                    {e.kind === "bought" ? "+" : ""}{money(abs(e.micros))}</b> {describe(e)}</span>
                  <span>{e.seconds ? `${Math.round(Number(e.seconds) / 60)} min` : ""}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bl-card">
          <h2>Payment</h2>

          {b.card ? (
            <>
              <div className="bl-rule">
                {b.pausedAt ? (
                  <p>Autopay is <b>paused</b> until a card works. We tried once and will not try again on our own.</p>
                ) : b.autopay ? (
                  <p>When my balance falls below <b>{money(b.belowMicros)}</b>, top it up to <b>{money(b.uptoMicros)}</b>.</p>
                ) : (
                  <p>Autopay is <b>off</b>. Your credit will not be topped up, and your agents fall back to your own keys when it runs out.</p>
                )}
                <form action={changeRule} className="bl-form">
                  <span>Below</span>
                  <input className="bl-num" name="below" type="number" step="1" min="0"
                         defaultValue={microsToCents(b.belowMicros) / 100} />
                  <span>top up to</span>
                  <input className="bl-num" name="upto" type="number" step="1" min="1"
                         defaultValue={microsToCents(b.uptoMicros) / 100} />
                  <button type="submit" className="bl-btn" data-ghost>Save</button>
                </form>
                <div className="bl-acts">
                  <form action={toggle}>
                    <input type="hidden" name="on" value={b.autopay && !b.pausedAt ? "0" : "1"} />
                    <button type="submit" className="bl-btn" data-warn={b.autopay && !b.pausedAt ? "" : undefined}
                            {...(!(b.autopay && !b.pausedAt) ? {} : {})}>
                      {b.autopay && !b.pausedAt ? "Turn off autopay" : "Turn on autopay"}
                    </button>
                  </form>
                  <form action={addFunds}>
                    <input type="hidden" name="dollars" value="10" />
                    <button type="submit" className="bl-btn" data-ghost>Replace card</button>
                  </form>
                </div>
              </div>
              <div className="bl-meth">
                <span><b>{b.card.brand} ending {b.card.last4}</b>
                  <span>{b.pausedAt ? `declined · ${b.pausedReason ?? "the bank said no"}` : `expires ${b.card.exp}`}</span>
                </span>
              </div>
            </>
          ) : (
            <div className="bl-rule">
              <p>Add funds and we will keep you topped up, so your agents never stop mid-sentence.</p>
              <div className="bl-acts">
                <form action={addFunds}>
                  <input type="hidden" name="dollars" value="10" />
                  <button type="submit" className="bl-btn">Add $10</button>
                </form>
              </div>
            </div>
          )}

          <p className="bl-fine">
            Cards are held by Stripe, never by us. Paying once keeps the card for next time — that is
            what turns autopay on — and you can turn it off straight afterwards without losing the card
            or the credit.
          </p>
        </section>
      </div>
    </main>
  );
}
