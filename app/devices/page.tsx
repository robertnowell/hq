import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { identifyPerson } from "@/lib/auth";
import { devices as loadDevices, revokeDevice } from "@/lib/devices";
import { stamp, when } from "../when";
import "./devices.css";

export const dynamic = "force-dynamic";

/**
 * The Macs connected to this hub, and the button that stops one.
 *
 * Until this page existed, a device key could be minted and never taken back:
 * signing out of the browser ended the browser's session and left the Mac
 * mirroring, because the two credentials are deliberately separate things.
 * The key is the machine's; the session is the person's. That is the right
 * design, and it is only safe if the person can end the machine's.
 *
 * Revoking stamps the row rather than deleting it. `hq_user_for_token`
 * refuses a stamped row, so one update ends every future request that key
 * could make, from that Mac or from anywhere it was copied to, and the list
 * keeps the history of what was connected and when it stopped.
 */

async function revoke(form: FormData) {
  "use server";
  const h = await headers();
  const me = await identifyPerson(new Request("http://local", { headers: h }));
  if (!me) redirect("/sign-in?redirect_url=%2Fdevices");
  const id = String(form.get("id") ?? "");
  // Row-level security decides whether this id is yours. A device id from
  // somebody else's account updates nothing, which is the same answer as an
  // id that does not exist.
  if (id) await revokeDevice(me.userId, id);
  redirect("/devices");
}

export default async function Devices() {
  const h = await headers();
  const me = await identifyPerson(new Request("http://local", { headers: h }));
  if (!me) {
    const here = h.get("x-hq-path") ?? "/devices";
    redirect(`/sign-in?redirect_url=${encodeURIComponent(here)}`);
  }
  const rows = await loadDevices(me.userId);
  const live = rows.filter((d) => !d.revoked_at).length;

  return (
    <main className="dv">
      <h1 className="dv-h1">Your Macs</h1>
      <p className="dv-sub">
        {live === 0
          ? "No Mac is connected to this hub yet."
          : `${live} connected. Each one sends its agents' pages and turns here.`}
      </p>

      {rows.length > 0 && (
        <ul className="dv-list">
          {rows.map((d) => (
            <li key={d.id} className="dv-row" data-off={d.revoked_at ? "" : undefined}>
              <span className="dv-lamp" aria-hidden="true" />
              <span className="dv-who">
                <span className="dv-name">{d.name}</span>
                <span className="dv-meta">
                  {d.revoked_at
                    ? `disconnected ${stamp(d.revoked_at)}`
                    : d.last_used_at
                      ? `last synced ${when(d.last_used_at)} ago · connected ${stamp(d.created_at)}`
                      : `connected ${stamp(d.created_at)}, nothing sent yet`}
                </span>
              </span>
              {!d.revoked_at && (
                <form action={revoke}>
                  <input type="hidden" name="id" value={d.id} />
                  <button type="submit" className="dv-revoke">Disconnect</button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="dv-add"><a href="/connect">Connect another Mac</a></p>
      <p className="dv-fine">
        Disconnecting takes effect at once and cannot be undone. That Mac stops
        sending, says so on its own setup screen, and can be connected again
        from there.
      </p>
    </main>
  );
}
