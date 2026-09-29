"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ShareCard } from "../../share-card";
import { SideToggle } from "../../side-toggle";

/**
 * The bar above a document, and the share dialog behind it.
 *
 * This is the app's own chrome now, in React, on the app's origin, with a
 * session: the document sits in a frame below it rather than the other way
 * round. That is what makes the dialog a dialog. The previous arrangement
 * injected this bar into the agent's html, which is served sandboxed with an
 * opaque origin, so the share control could only do its work by opening a
 * separate browser window.
 *
 * Two people see this bar. The OWNER gets Share and Discuss and a way back
 * to the agent. A READER (a teammate by domain, or anyone the link reached)
 * gets a way back to the team page, the author's name, and nothing else:
 * no analytics on the content, ever (ruled 27 Sep 2026). The reader's own
 * time on the page is counted quietly from here, because this bar has a
 * session and the frame below does not.
 */
export function DocChrome({ id, title, agentId, agentTitle, discuss, shareUrl, visibility = "private",
                            reader = null }: {
  id: string; title: string; agentId: string; agentTitle: string;
  discuss: string; shareUrl: string | null;
  visibility?: "private" | "team" | "link";
  /** Present when the person is not the owner. */
  reader?: { back: string; backLabel: string; author: string } | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const close = () => { ref.current?.close(); router.refresh(); };
  // Escape on a pending choice asks first. The dialog's own cancel is held
  // back and the card is told; a second Escape in a row leaves anyway,
  // which is the browser's rule and also the right one.
  const dirty = useRef(false);
  const onDirty = useCallback((d: boolean) => { dirty.current = d; }, []);
  const [leaveRequest, setLeaveRequest] = useState(0);
  // A fresh card every time it opens. The dialog stays mounted between
  // opens, so a choice made and then abandoned used to survive the close
  // and greet the next open as if it were the state (28 Sep: that is how a
  // private page looked link-shared). The key remounts it; the card then
  // reads the truth from the server again.
  const [gen, setGen] = useState(0);
  const show = () => { setGen((g) => g + 1); ref.current?.showModal(); };
  const onCancel = (e: React.SyntheticEvent<HTMLDialogElement>) => {
    if (dirty.current) { e.preventDefault(); setLeaveRequest((n) => n + 1); }
  };

  // The beacon. Once on open, then fifteen seconds at a time while the tab
  // is visible. The server adds it up; nothing is shown to the reader.
  useEffect(() => {
    if (!reader) return;
    const send = (seconds: number) => {
      const body = JSON.stringify({ document_id: id, seconds });
      try {
        if (!navigator.sendBeacon?.("/api/reads", new Blob([body], { type: "application/json" }))) {
          fetch("/api/reads", { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true }).catch(() => {});
        }
      } catch { /* a beacon that fails records nothing, and that is the honest result */ }
    };
    send(0);
    const t = setInterval(() => { if (document.visibilityState === "visible") send(15); }, 15_000);
    return () => clearInterval(t);
  }, [id, reader]);

  if (reader) {
    return (
      <div className="dc">
        <SideToggle />
        <a className="dc-back" href={reader.back}>&larr; {reader.backLabel}</a>
        <span className="dc-title">{title}</span>
        <span className="dc-by">by {reader.author}</span>
        {/* The loop. A reader is the next sharer; the words for that live
            on /start, the same ones the empty hub shows (hq-app-zn6.3). */}
        <a className="dc-btn" href="/start">Make your own</a>
      </div>
    );
  }

  return (
    <div className="dc">
      <SideToggle />
        <a className="dc-back" href={`/a/${agentId}`}>&larr; {agentTitle}</a>
      <span className="dc-title">{title}</span>
      <button className="dc-btn" onClick={show}>
        {visibility === "team" ? "Team" : visibility === "link" || shareUrl ? "Link" : "Share"}
      </button>
      <a className="dc-btn dc-go" href={discuss}>Discuss</a>
      {/* Close and Escape are the ways out. A click on the backdrop used to
          close it too, and a tall card in a short window meant a click meant
          to scroll or select threw the dialog away (Robert, 27 Sep). */}
      <dialog ref={ref} className="sc-modal" onClose={() => router.refresh()} onCancel={onCancel}>
        {/* Loaded only once the dialog has been opened. Mounted with the page,
            every row's card asked the server for its sharing state at once:
            53 requests on an agent with 53 pages, run one at a time, and a
            click to another agent waited behind all of them (29 Sep: "it
            still takes forever to switch tabs"). */}
        {gen > 0 && <ShareCard key={gen} id={id} title={title} initialVisibility={visibility}
                   onDone={() => router.refresh()} onClose={close}
                   onDirtyChange={onDirty} leaveRequest={leaveRequest} />}
      </dialog>
    </div>
  );
}
