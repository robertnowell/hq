"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { identifyPerson } from "@/lib/auth";
import { shareableDomain } from "@/lib/domain";
import { asUser } from "@/lib/db";

/**
 * Clear a document, or put it back.
 *
 * This is the only code path in the system that writes a `cleared` event, and
 * it is only reachable from a click. That is the whole enforcement mechanism
 * for "the system never turns off a lamp" -- not a comment, not a convention,
 * a single call site you can grep for.
 *
 * Un-clearing is allowed because a human doing it is still a human doing it.
 * What is forbidden is the system deciding on your behalf.
 */
export async function setCleared(documentId: string, cleared: boolean) {
  const h = await headers();
  const me = await identifyPerson(new Request("http://local", { headers: h }));
  if (!me) throw new Error("unauthenticated");

  await asUser(me.userId, async (c) => {
    if (cleared) {
      await c.query(
        `insert into document_events (user_id, document_id, kind)
         values ($1, $2, 'cleared')`,
        [me.userId, documentId],
      );
    } else {
      // Deleting the events is right rather than writing an 'uncleared' event:
      // the log records what happened to the document, and un-clearing means
      // the clearing is retracted, not that a new thing happened to it.
      await c.query(
        `delete from document_events
          where user_id = $1 and document_id = $2 and kind = 'cleared'`,
        [me.userId, documentId],
      );
    }
  });
  revalidatePath("/", "layout");
}

// ------------------------------------------------------------ sharing v1
//
// Private, team, link. Ruled 27 Sep 2026; the model is in db/018 and the
// rules in lib/sharing.ts. Every transition is one of these clicks.

import {
  shareState as loadShareState, shareToTeam, unshareTeam, shareByLink, setPrivate, applyShare,
  readers as loadReaders, teamProfile, type ShareResult, type ShareState, type Reader, type TeamProfile,
} from "@/lib/sharing";
import { hasSite, SITE_BASE } from "@/lib/publishing";

export async function shareInfo(documentId: string):
  Promise<{ state: ShareState; readers: Reader[]; myTeam: TeamProfile | null; site: string | null } | null> {
  const h = await headers();
  const me = await identifyPerson(new Request("http://local", { headers: h }));
  if (!me) return null;
  const state = await loadShareState(me.userId, documentId);
  if (!state) return null;
  const rs = await loadReaders(me.userId, documentId);
  const myTeam = me.domain ? await teamProfile(me.domain).catch(() => null) : null;
  return { state, readers: rs, myTeam, site: hasSite(me.userId) ? SITE_BASE : null };
}

/** A team named by domain, profiled from its site, for the card's "another team". */
export async function teamLookup(domain: string): Promise<TeamProfile | null> {
  const h = await headers();
  const me = await identifyPerson(new Request("http://local", { headers: h }));
  if (!me) return null;
  const d = shareableDomain(domain);
  if (!d.ok) return null;
  return teamProfile(d.domain).catch(() => null);
}

export type ShareOp =
  | { kind: "apply"; visibility: "private" | "team" | "link" | "site"; domain?: string | null; confirmed?: boolean }
  | { kind: "private" }
  | { kind: "team"; domain: string }
  | { kind: "unteam"; domain: string }
  | { kind: "link"; confirmed?: boolean };

export async function setShare(documentId: string, op: ShareOp): Promise<ShareResult> {
  const h = await headers();
  const me = await identifyPerson(new Request("http://local", { headers: h }));
  if (!me) return { ok: false, why: "not signed in" };
  let r: ShareResult;
  switch (op.kind) {
    case "apply":   r = await applyShare(me.userId, documentId, op.visibility, op.domain ?? null, op.confirmed ?? false); break;
    case "private": r = await setPrivate(me.userId, documentId); break;
    case "team":    r = await shareToTeam(me.userId, documentId, op.domain); break;
    case "unteam":  r = await unshareTeam(me.userId, documentId, op.domain); break;
    case "link":    r = await shareByLink(me.userId, documentId, op.confirmed ?? false); break;
  }
  if (r.ok) revalidatePath("/", "layout");
  return r;
}
