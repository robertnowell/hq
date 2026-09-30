"use client";

import { useEffect, useState } from "react";
import { startOver, useClient, waitingAddress } from "./document-sign-in";

/**
 * The document door's one line and its sub-line, per step.
 *
 * On the code step the sign-in attempt lives in the browser (Clerk's), so
 * whether there is one is read from there. The server does not know it.
 */
/**
 * `team`, when the page is shared to a company: the door names it and the
 * address it wants, so a person at the wrong address knows before the code
 * (hq-app-9d9.12).
 */
export function GateWords({ step: fromPath, team = null }: {
  step: string | undefined; team?: { name: string; domain: string } | null;
}) {
  const { code } = useDoorStep(fromPath);
  // The code step says only what to do (Robert, 29 Sep: "Enter the code
  // sent to your email. No subtitle.").
  if (code) return <h1 className="gate-line gate-line--alone">Enter the code sent to your email.</h1>;
  return (<>
    <h1 className="gate-line">{team ? `This document has been shared with ${team.name}.` : "This document has been shared with you."}</h1>
    <p className="gate-sub">{team ? <>Enter your <b>{`@${team.domain}`}</b> email to see it.</> : "Enter your email to see it."}</p>
  </>);
}

/** Under the card on the code step: the way back to the email field. */
export function GateAfter({ step: fromPath }: { step: string | undefined }) {
  const { code, client } = useDoorStep(fromPath);
  if (!code) return null;
  return <p className="gate-after"><button type="button" className="gate-other" onClick={() => startOver(client)}>Use a different email</button></p>;
}

/**
 * Which step the card is on, followed as it changes. The attempt is read
 * through a listener: useClerk().client alone is read once, so the words
 * stayed on "Enter your email" while the card showed the code boxes (a
 * phone, 29 Sep; the drill had only checked after a fresh load).
 */
function useDoorStep(fromPath: string | undefined) {
  const client = useClient();
  // On the document's own address the sign-in routes by hash
  // (#/factor-one, #/create/verify-email-address).
  const [fromHash, setFromHash] = useState<string | undefined>(undefined);
  useEffect(() => {
    const read = () => setFromHash(window.location.hash.replace(/^#\/?/, "").split("?")[0] || undefined);
    read(); window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const step = fromPath ?? fromHash;
  // The code words need a code step AND an attempt in progress: at the
  // /factor-one address with no attempt, Clerk draws the email field again.
  const code = !!waitingAddress(client) && (step === "factor-one" || step === "factor-two" || !!step?.match(/verify/));
  return { code, client };
}
