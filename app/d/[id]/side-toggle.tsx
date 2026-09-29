"use client";

import { useEffect, useState } from "react";

/**
 * Collapse or show the sidebar while reading a document. The sidebar stays
 * by default, so the reader keeps their bearings (Robert, 29 Sep: "the
 * sidebar should be persistent... collapsible, sure"); collapsing is
 * remembered on this device and applies to document pages only.
 */
const KEY = "hq.doc.side";

export function SideToggle() {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    let v = false;
    try { v = localStorage.getItem(KEY) === "collapsed"; } catch {}
    setCollapsed(v);
  }, []);
  useEffect(() => {
    document.documentElement.dataset.docSide = collapsed ? "collapsed" : "open";
    try { localStorage.setItem(KEY, collapsed ? "collapsed" : "open"); } catch {}
  }, [collapsed]);
  return (
    <button type="button" className="dc-side" onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Show the sidebar" : "Hide the sidebar"}
            title={collapsed ? "Show the sidebar" : "Hide the sidebar"}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.3" />
        {collapsed ? null : <rect x="2.2" y="3.2" width="3.2" height="9.6" rx=".8" fill="currentColor" opacity=".35" />}
      </svg>
    </button>
  );
}
