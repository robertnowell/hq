"use client";

import { useEffect, useReducer, useState } from "react";
import { useRouter } from "next/navigation";
import { SignIn, useAuth, useClerk } from "@clerk/nextjs";
import { gateCard } from "./gate-card";

/**
 * The sign-in card at a document's door, which resumes and which returns.
 *
 * RESUMES. A reader on a phone enters their email, leaves for their inbox,
 * and comes back by tapping the link again (29 Sep, four times over). The
 * attempt waiting for its code lives in Clerk's client, but the card starts
 * at the email field on a bare address; asked again, Clerk sends a second
 * code and the first, the one they fetched, is dead. So before the card is
 * drawn, a waiting attempt sends it to its own code step. Nothing is stored
 * by us: the attempt is Clerk's, and an expired one simply is not waiting.
 *
 * RETURNS. The document is the only place worth going, for a returning
 * reader (sign-in) and a new one (sign-up) alike. Only the sign-in
 * destination was set, so a first-time reader finished on "/" (29 Sep).
 * scripts/reader-door-test.mjs walks all of it in a phone-sized browser.
 */
export function DocumentSignIn({ back, routing }: { back: string; routing: "hash" | "path" }) {
  const clerk = useClerk();
  const router = useRouter();
  const [ready, setReady] = useState(false);
  // On /d/<id> the destination is the address already showing, so Clerk's
  // redirect is a push to the same place and the server never draws the
  // document (the drill's straight-through reader, 29 Sep). Signed in, ask.
  const { isSignedIn } = useAuth();
  useEffect(() => { if (isSignedIn && location.pathname === back) router.refresh(); }, [isSignedIn, back, router]);
  useEffect(() => {
    if (!clerk.loaded || ready) return;
    const step = waitingStep(clerk.client);
    const here = routing === "hash" ? location.hash.replace(/^#\/?/, "") : location.pathname.replace(/^\/sign-in\/?/, "");
    if (step && !here) {
      if (routing === "hash") location.hash = `/${step}`;
      else { router.replace(`/sign-in/${step}${location.search}`); return; }
    }
    setReady(true);
  }, [clerk.loaded, clerk.client, ready, routing, router]);
  if (!ready) return null;
  const to = { forceRedirectUrl: back, signUpForceRedirectUrl: back, appearance: gateCard };
  return routing === "hash"
    ? <SignIn withSignUp routing="hash" {...to} />
    : <SignIn withSignUp routing="path" path="/sign-in" {...to} />;
}

type Client = ReturnType<typeof useClerk>["client"];

/** Clerk's client, re-read whenever Clerk says anything changed. */
export function useClient(): Client {
  const clerk = useClerk();
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => clerk.addListener(() => tick()), [clerk]);
  return clerk.client;
}

/** The code step of an attempt that is waiting for its code, or null. */
export function waitingStep(client: Client): string | null {
  const up = client?.signUp, inn = client?.signIn;
  if (up?.status === "missing_requirements" && up.emailAddress && up.unverifiedFields.includes("email_address")) {
    return "create/verify-email-address";
  }
  if (inn?.status === "needs_first_factor" && inn.identifier && inn.firstFactorVerification?.status === "unverified") {
    return "factor-one";
  }
  return null;
}

/** The address the waiting code went to, from either attempt. */
export function waitingAddress(client: Client): string | null {
  const step = waitingStep(client);
  if (step === "create/verify-email-address") return client?.signUp?.emailAddress ?? null;
  return step ? client?.signIn?.identifier ?? null : null;
}

/**
 * "Use a different email". The waiting attempt has to go, or the door would
 * resume it, and a half-finished sign-up left beside a new address makes
 * Clerk ask for Continue twice (seen in the drill, 29 Sep). The person at
 * this door is signed out, so Clerk's client holds nothing but the attempts:
 * it is discarded whole, and the page starts again at the email field.
 */
export async function startOver(client: Client) {
  await client?.destroy().catch(() => {});
  location.replace(location.pathname.startsWith("/sign-in") ? `/sign-in${location.search}` : location.pathname + location.search);
}
