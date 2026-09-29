import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { identify } from "@/lib/auth";
import { hasAgents } from "@/lib/queries";
import { hasLiveDevice } from "@/lib/devices";
import { myTeams, sharedWithMe } from "@/lib/sharing";
import { AgentInstructions } from "../agent-instructions";
import { Find } from "../find";
import { HomeView } from "./home/view";

export const dynamic = "force-dynamic";

/** The front door: the company's home, or the right first step when there is nothing yet. */
export default async function Home(
  { searchParams }: { searchParams: Promise<{ q?: string; tab?: string }> },
) {
  const { q, tab } = await searchParams;
  const h = await headers();
  const me = await identify(new Request("http://local", { headers: h }));
  if (!me) return null;

  const query = (q ?? "").trim();
  if (query) return <Find userId={me.userId} q={query} back="/" />;

  // The company's home (ruled 28 Sep, switched on 29 Sep, hq-app-cll.5):
  // anyone with agents or a team lands on what they opened, what asks
  // something of them, and the day's activity, instead of being redirected to
  // their top agent (10 Sep) or their first team (27 Sep). Both are one click
  // away in the sidebar. The Mac's Hub window loads this address, so the app
  // opens here too.
  const [mine, teams] = await Promise.all([
    hasAgents(me.userId).catch(() => false),
    myTeams(me.userId).catch(() => []),
  ]);
  if (mine || teams.length) return <HomeView userId={me.userId} tab={tab} />;
  // No agents, no team, but pages somebody sent them: those are their home
  // (Robert, 27 Sep: "if your hub is empty we don't want to send you to this
  // page if someone just shared a document with you").
  if ((await sharedWithMe(me.userId, 1).catch(() => [])).length) redirect("/documents");

  const connected = await hasLiveDevice(me.userId);
  // The empty hub, with one hook and one hierarchy (Robert, 27 Sep: four
  // actions with none was "ceding the responsibility of designing a user
  // interface"). What they get by using this in some capacity, then the one
  // action, then the other way in as a sentence. No search box over
  // nothing, no "nothing yet" under it.
  return (
    <>
      <p className="hq-kicker">Knowledge Base</p>
      <h1 className="hq-h1 hq-hook">Share documents with your team.</h1>
      <p className="hq-sub hq-hook-sub">
        Any coding agent can put a page here. Share it with everyone at your company, or
        with anyone by link. Readers sign in with an email and install nothing.
      </p>
      {connected && (
        <p className="hq-sub">Your Mac is connected. Start an agent in Tranquility Base and
          its pages and turns appear here as it works.</p>
      )}
      <AgentInstructions domain={me.domain} />
      {!connected && (
        <p className="hq-sub hq-hook-alt">Or <a href="/download">get the Mac app</a>, and every page your agents write arrives on its own.</p>
      )}
    </>
  );
}
