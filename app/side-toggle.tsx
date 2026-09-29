"use client";

import { useEffect, useState } from "react";

/**
 * Collapse or show the sidebar, anywhere in the hub. It stays by default so
 * the reader keeps their bearings (Robert, 29 Sep: "the sidebar should be
 * persistent... collapsible, sure"), and "should be on hub view too": one
 * setting, remembered on this device, for every page. `floating` is the
 * copy drawn at the top of hub pages; a document draws it in its own bar.
 */
const KEY = "hq.side";

export function SideToggle({ floating = false }: { floating?: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  // One setting on <html>; every copy of the button reads it and follows it.
  useEffect(() => {
    const root = document.documentElement;
    if (!root.dataset.side) {
      let v = false;
      try { v = (localStorage.getItem(KEY) ?? localStorage.getItem("hq.doc.side")) === "collapsed"; } catch {}
      root.dataset.side = v ? "collapsed" : "open";
    }
    const sync = () => setCollapsed(root.dataset.side === "collapsed");
    sync();
    const watch = new MutationObserver(sync);
    watch.observe(root, { attributes: true, attributeFilter: ["data-side"] });
    return () => watch.disconnect();
  }, []);
  const flip = () => {
    const next = document.documentElement.dataset.side === "collapsed" ? "open" : "collapsed";
    document.documentElement.dataset.side = next;
    try { localStorage.setItem(KEY, next); } catch {}
  };
  return (
    <button type="button" className={floating ? "dc-side hq-side-float" : "dc-side"} onClick={flip}
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
