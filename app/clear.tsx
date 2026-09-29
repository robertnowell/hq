"use client";

import { useTransition } from "react";
import { setCleared } from "./actions";

/**
 * The only thing that clears a document is a person pressing this.
 *
 * "Waiting on you" is never resolved by the system -- not by opening the
 * document, not by time passing. That is the whole distinction between read
 * and done, and it only holds if nothing else can write the event.
 */
export function Clear({ id, cleared }: { id: string; cleared: boolean }) {
  const [pending, start] = useTransition();
  return (
    <button className="act" disabled={pending}
            onClick={() => start(() => { setCleared(id, !cleared); })}>
      {cleared ? "restore" : "clear"}
    </button>
  );
}
