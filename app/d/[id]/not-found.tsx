"use client";

import { usePathname } from "next/navigation";
import { SignOutButton, useUser } from "@clerk/nextjs";
import { Gate } from "../../gate";

/**
 * A document that is not shared with this person, or not there.
 *
 * One answer for both, deliberately: telling somebody which of the two it is
 * tells them which ids are real. The status is a real 404, because a page
 * that says "no such thing" with a 200 lies to every client that is not a
 * person (and the cross-tenant drill holds it to that).
 *
 * What changed 27 Sep is the answer's shape. "No such page ... it may belong
 * to somebody else" read, to a person holding a link, as a shrug (Robert:
 * "it belongs to somebody else, that's the whole point"). Now it is the
 * document door: the page's shape, and the one thing they can act on, which
 * is the address they are signed in as and that the link may have been sent
 * to a different one. The address comes from the browser's own session.
 */
export default function NotFound() {
  const path = usePathname() ?? "/";
  const { user, isLoaded } = useUser();
  const address = isLoaded ? user?.primaryEmailAddress?.emailAddress ?? null : null;
  const back = `/sign-in?redirect_url=${encodeURIComponent(path)}`;
  return (
    <Gate>
          <h1 className="gate-line">This document is not shared with you.</h1>
          <p className="gate-sub">
            {address && <>You are signed in as <b>{address}</b>. </>}
            If it was sent to a different address, sign in with that one. Otherwise ask the person who sent it to share it with you.
          </p>
          <SignOutButton redirectUrl={back}>
            <button type="button" className="gate-btn">Sign in with another address</button>
          </SignOutButton>
    </Gate>
  );
}
