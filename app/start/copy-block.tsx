"use client";

import { useState } from "react";

/** A block of text and one Copy button. */
export function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch {}
  };
  return (
    <div className="st-block">
      <pre>{text}</pre>
      <button type="button" className="hq-btn" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
    </div>
  );
}
