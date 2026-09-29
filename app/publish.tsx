"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ShareCard } from "./share-card";

/**
 * The share control on a row in the hub, and the dialog behind it.
 *
 * A real modal here, because this surface is the app's own: same origin, same
 * session, so the card can do its work in place without taking anybody off
 * the page they are reading. The document view cannot do that (its sandbox
 * has an opaque origin) and opens the same card in a window instead.
 *
 * The button says what is true now, share or shared, rather than naming the
 * verb it is about to perform, so a row can be read without opening anything.
 */
export function Publish({ id, title, published, url, visibility = "private" }: {
  id: string; title: string; published: boolean; url: string | null;
  visibility?: "private" | "team" | "link";
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

  return (
    <>
      {(published || visibility === "link") && (
        <a className="live" href={`/d/${id}`} target="_blank" rel="noopener">shared</a>
      )}
      <button className="act" onClick={show}>
        {visibility === "team" ? "team" : published || visibility === "link" ? "link" : "share"}
      </button>
      {/* Close and Escape are the ways out. A click on the backdrop used to
          close it too, and a tall card in a short window meant a click meant
          to scroll or select threw the dialog away (Robert, 27 Sep). */}
      <dialog ref={ref} className="sc-modal" onClose={() => router.refresh()} onCancel={onCancel}>
        <ShareCard key={gen} id={id} title={title}                    initialVisibility={visibility} onDone={() => router.refresh()} onClose={close}
                   onDirtyChange={onDirty} leaveRequest={leaveRequest} />
      </dialog>
    </>
  );
}
