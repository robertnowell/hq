import { agentPrompt, PLUGIN_INSTALL } from "../agent-prompt";
import { CopyBlock } from "./copy-block";
import "./start.css";

/**
 * /start: how to make your own.
 *
 * The one page a reader reaches from "Make your own" on a shared document,
 * and the page the plugin's install instructions point back to. No sign-in
 * to read it: the person may have none yet. Two ways in, in order: the
 * plugin for Claude Code (two lines, then pages push themselves), and the
 * prompt for any other agent (the same words the empty hub shows).
 */
export const dynamic = "force-dynamic";

export default function Start() {
  return (
    <main className="st">
      <p className="hq-kicker">Tranquility Knowledge Base</p>
      <h1 className="st-h1">Share documents with your team.</h1>
      <p className="st-lede">
        Any coding agent can put a page here. Share it with everyone at your company, or with
        anyone by link. Readers sign in with an email and install nothing.
      </p>

      <section className="st-way">
        <h2>In Claude Code: add the plugin.</h2>
        <p>Two lines. After that, every HTML report an agent writes is pushed here on its own, and the agent can share, search and read pages through the hub's tools.</p>
        <CopyBlock text={PLUGIN_INSTALL} />
        <p className="st-note">The first push asks you to approve this machine: the terminal shows a short phrase, the hub shows the same one, and you press Connect.</p>
      </section>

      <section className="st-way">
        <h2>In any other agent: paste this.</h2>
        <p>Codex, Cursor, OpenCode, a shell: the same four steps, as a prompt.</p>
        <CopyBlock text={agentPrompt(null)} />
      </section>

      <p className="st-foot"><a href="/sign-in">Sign in</a> · <a href="/download">Get the Mac app</a>, which sends every page your agents write.</p>
    </main>
  );
}
