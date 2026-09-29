"use client";

import { useEffect, useState } from "react";
import { useClerk } from "@clerk/nextjs";
import { startOver, waitingAddress } from "./document-sign-in";

/**
 * The document door's one line and its sub-line, per step.
 *
 * On the code step the sign-in attempt lives in the browser (Clerk's), so
 * the address the code went to is read from there and said back: "we sent
 * a code to name@example.com". The server does not know it and should not.
 */
/**
 * `team`, when the page is shared to a company: the door names it and the
 * address it wants, so a person at the wrong address knows before the code
 * (hq-app-9d9.12).
 */
export function GateWords({ step: fromPath, team = null }: {
  step: string | undefined; team?: { name: string; domain: string } | null;
}) {
  const { client } = useClerk();
  // On the document's own address the sign-in routes by hash (#/factor-one),
  // so the step is read from there and followed as it changes.
  const [fromHash, setFromHash] = useState<string | undefined>(undefined);
  useEffect(() => {
    const read = () => setFromHash(window.location.hash.replace(/^#\/?/, "").split("?")[0] || undefined);
    read(); window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const step = fromPath ?? fromHash;
  // A returning reader's code is a sign-in's; a new reader's is a sign-up's
  // (#/create/verify-email-address), which the words missed until 29 Sep.
  const to = waitingAddress(client);
  // The code words need a code step AND an attempt in progress: at the
  // /factor-one address with no attempt, Clerk draws the email field again.
  const code = !!to && (step === "factor-one" || step === "factor-two" || !!step?.match(/verify/));
  if (!code) {
    return (<>
      <h1 className="gate-line">{team ? `This document has been shared with ${team.name}.` : "This document has been shared with you."}</h1>
      <p className="gate-sub">{team ? <>Enter your <b>{`@${team.domain}`}</b> email to see it.</> : "Enter your email to see it."}</p>
    </>);
  }
  return (<>
    <h1 className="gate-line">Check your email.</h1>
    <p className="gate-sub">We sent a code to <b>{to}</b>. Enter it to see the document.{" "}
      <button type="button" className="gate-other" onClick={() => startOver(client)}>Use a different email</button></p>
  </>);
}
