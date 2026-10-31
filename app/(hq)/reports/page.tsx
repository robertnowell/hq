import { headers } from "next/headers";
import { identify } from "@/lib/auth";
import { documents } from "@/lib/queries";
import { Index } from "../../hub";

export const dynamic = "force-dynamic";

/**
 * All reports: every page any agent wrote, newest first.
 *
 * The sidebar files pages under the agent that wrote them, which is the
 * right home when you know who wrote it and the wrong one when you only know
 * roughly when (ruled 31 Oct 2026: "all reports created in order", at the
 * top of the sidebar beside Notes).
 */
export default async function AllReports() {
  const h = await headers();
  const me = await identify(new Request("http://local", { headers: h }));
  if (!me) return null;
  const docs = await documents(me.userId, undefined, 1000);
  return (
    <>
      <p className="hq-kicker">Documents</p>
      <h1 className="hq-h1">All reports</h1>
      {docs.length === 0
        ? <p className="hq-sub">No agent has written a report yet.</p>
        : <Index docs={docs} showAgent />}
    </>
  );
}
