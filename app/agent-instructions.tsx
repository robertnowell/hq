"use client";

import { useRef, useState } from "react";
import { agentPrompt } from "./agent-prompt";

/**
 * "Copy instructions for agent": the hook on an empty hub (Robert, 27 Sep).
 *
 * A person who has just read a shared page, or signed up cold, owns nothing
 * here. The thing they can do next is hand their own coding agent one
 * prompt, and the prompt is the whole install: the client, the connect
 * step they approve with one press, the push. The words are for an agent
 * to execute and a person to skim, so they are numbered and literal. The
 * company is filled in when the person signed in with a work address.
 */
export function AgentInstructions({ domain, primary = true }: { domain: string | null; primary?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [copied, setCopied] = useState(false);
  const text = agentPrompt(domain);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch {}
  };
  return (
    <>
      <p className="hq-cta">
        <button className={primary ? "hq-go" : "hq-btn"} onClick={() => ref.current?.showModal()}>Copy instructions for agent</button>
      </p>
      <dialog ref={ref} className="sc-modal hq-instr">
        <p className="sc-kicker">For your agent</p>
        <h2 className="sc-title">Paste this into Claude Code, Codex, Cursor, or whatever writes your pages.</h2>
        <pre>{text}</pre>
        <p className="sc-foot">
          <button type="button" className="sc-btn" onClick={() => ref.current?.close()}>Close</button>
          <button type="button" className="sc-btn sc-go" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </p>
      </dialog>
    </>
  );
}
