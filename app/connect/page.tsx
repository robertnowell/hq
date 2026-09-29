import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { identifyPerson } from "@/lib/auth";
import { approveClaim } from "@/lib/claims";
import { isWellFormedCode, phraseFor } from "@/lib/pairing";
import "./connect.css";

export const dynamic = "force-dynamic";

/**
 * Connect your Mac.
 *
 * The Mac starts this. It invents a 32-byte code, keeps it in memory, opens
 * this page with the code and its own name in the address, and then polls
 * for the token. Nothing here is typed and nothing secret is displayed.
 *
 * The one thing this page must do, beyond signing you in, is prove that the
 * Mac asking is the Mac in front of you. It cannot do that by trusting the
 * address: any page on the web can open this one with any code and any
 * plausible machine name, and a signed-in reader clicking Connect would pair
 * the sender's computer to their account. So the page shows a phrase derived
 * from the code -- the panel shows the same phrase, computed from the code it
 * invented -- and asks you to compare them. RFC 8628 section 5.4 requires
 * exactly this compensation whenever the code travels in the link instead of
 * being typed by a person.
 *
 * Approving mints nothing. It writes one row saying this account said yes to
 * this device name, with ten minutes to live; the token is created when the
 * Mac collects it, once.
 */

/** A machine name from the address bar. Displayed, so it is bounded and flat. */
function deviceName(v: string | undefined): string {
  const clean = (v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 60);
  return clean.length ? clean : "This Mac";
}

async function approve(form: FormData) {
  "use server";
  const h = await headers();
  const me = await identifyPerson(new Request("http://local", { headers: h }));
  if (!me) redirect("/sign-in?redirect_url=%2Fconnect");
  const code = String(form.get("code") ?? "");
  const name = deviceName(String(form.get("device") ?? ""));
  // A malformed code cannot match anything, so approving it would leave a
  // dead row and tell the person it worked. Send them back to the empty page.
  if (!isWellFormedCode(code)) redirect("/connect");
  await approveClaim(me.userId, name, code);
  // The code leaves the address bar on the way out: it is spent, and a
  // reloaded or shared URL should not re-present an approval screen.
  redirect(`/connect?connected=${encodeURIComponent(name)}`);
}

export default async function Connect(
  { searchParams }: { searchParams: Promise<{ code?: string; device?: string; connected?: string }> },
) {
  const h = await headers();
  const me = await identifyPerson(new Request("http://local", { headers: h }));
  if (!me) {
    // Straight to the front door and straight back, code and all. The
    // middleware already put the full path and query on a header.
    const here = h.get("x-hq-path") ?? "/connect";
    redirect(`/sign-in?redirect_url=${encodeURIComponent(here)}`);
  }
  const { code, device, connected } = await searchParams;

  if (connected !== undefined) {
    const name = deviceName(connected);
    return (
      <Frame>
        <h1 className="cn-line">Connected.</h1>
        <p className="cn-say">
          Tranquility Base on {name} is collecting its key now. Everything your
          agents write from that Mac will appear here.
        </p>
        <a className="cn-go" href="/">Open your Knowledge Base</a>
      </Frame>
    );
  }

  if (isWellFormedCode(code)) {
    const name = deviceName(device);
    return (
      <Frame>
        <h1 className="cn-line">Connect {name} to your Knowledge Base?</h1>
        <p className="cn-say">Your Mac is showing a phrase. It should be this one.</p>
        <p className="cn-phrase" aria-label="confirmation phrase">{phraseFor(code)}</p>
        <p className="cn-warn">Only continue if the Mac in front of you is showing this phrase.</p>
        <form action={approve} className="cn-act">
          <input type="hidden" name="code" value={code} />
          <input type="hidden" name="device" value={name} />
          <button type="submit" className="cn-primary">Connect</button>
        </form>
        <a className="cn-quiet" href="/">Not now</a>
      </Frame>
    );
  }

  // No code: nobody asked to connect anything. Ruled 27 Sep: the only browser
  // action is approving a machine that asked, and a signed-in person with
  // nothing asking has nothing to do here. The machine starts it, whether it
  // is the app or `hq connect` on a command line; both invent a code and
  // open this page with it.
  return (
    <Frame>
      <h1 className="cn-line">You are signed in.</h1>
      <p className="cn-say">
        Connecting starts from the machine: open Tranquility Base, or run <code>hq connect</code>,
        and this page asks you to approve it.
      </p>
      <a className="cn-go" href="/">Open your Knowledge Base</a>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="cn">
      <section className="cn-box">
        <svg className="cn-mark" viewBox="0 0 16 16" aria-hidden="true">
          <path fillRule="evenodd" d="M8 1.3a4.9 4.9 0 1 0 0 9.8 4.9 4.9 0 0 0 0-9.8zm0 1.6a3.3 3.3 0 1 1 0 6.6 3.3 3.3 0 0 1 0-6.6zM1.5 12.8h13v1.6h-13z"/>
        </svg>
        {children}
      </section>
    </main>
  );
}
