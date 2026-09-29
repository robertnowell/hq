import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { identify } from "@/lib/auth";
import { agents as loadAgents } from "@/lib/queries";
import { hasLiveDevice } from "@/lib/devices";
import { myTeams, sharedWithMe } from "@/lib/sharing";
import { AgentInstructions } from "../agent-instructions";
import { Find } from "../find";

export const dynamic = "force-dynamic";

/** Everything: one stream of turns across every agent, newest first. */
export default async function Home(
  { searchParams }: { searchParams: Promise<{ q?: string }> },
) {
  const { q } = await searchParams;
  const h = await headers();
  const me = await identify(new Request("http://local", { headers: h }));
  if (!me) return null;

  const query = (q ?? "").trim();
  if (query) return <Find userId={me.userId} q={query} back="/" />;

  // No "Everything". The sidebar is the stack; the home is its top. Robert,
  // 10 Sep: "I don't know what the Everything tab is for. Can we not have
  // that?" What needs you most is the first thing you see.
  const top = (await loadAgents(me.userId))[0];
  if (top) redirect(`/a/${top.id}`);
  // No agents, but a team: a reader. Their home is the team page, which is
  // what they came for (ruled 27 Sep: the sidebar is shaped by what a person
  // has, and so is the front page).
  const team = (await myTeams(me.userId).catch(() => []))[0];
  if (team) redirect(`/t/${encodeURIComponent(team.domain)}`);
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
