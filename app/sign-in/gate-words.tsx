"use client";

import { useEffect, useState } from "react";
import { useSignIn } from "@clerk/nextjs";

/**
 * The document door's one line and its sub-line, per step.
 *
 * On the code step the sign-in attempt lives in the browser (Clerk's), so
 * the address the code went to is read from there and said back: "we sent
 * a code to name@example.com". The server does not know it and should not.
 */
export function GateWords({ step: fromPath }: { step: string | undefined }) {
  const { signIn } = useSignIn();
  // On the document's own address the sign-in routes by hash (#/factor-one),
  // so the step is read from there and followed as it changes.
  const [fromHash, setFromHash] = useState<string | undefined>(undefined);
  useEffect(() => {
    const read = () => setFromHash(window.location.hash.replace(/^#\/?/, "").split(/[/?]/)[0] || undefined);
    read(); window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const step = fromPath ?? fromHash;
  const to = signIn?.identifier ?? null;
  // The code words need a code step AND an attempt in progress: at the
  // /factor-one address with no attempt, Clerk draws the email field again.
  const code = !!to && (step === "factor-one" || step === "factor-two" || !!step?.endsWith("verify"));
  if (!code) {
    return (<>
      <h1 className="gate-line">This document has been shared with you.</h1>
      <p className="gate-sub">Enter your email to see it.</p>
    </>);
  }
  return (<>
    <h1 className="gate-line">Check your email.</h1>
    <p className="gate-sub">We sent a code to <b>{to}</b>. Enter it to see the document.</p>
  </>);
}
