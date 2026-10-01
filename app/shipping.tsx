"use client";
import { useEffect, useState } from "react";
import { type ShippingSnapshot } from "@/lib/shipping";
import { Strip } from "./strip";
import "./shipping.css";

export function Shipping({ session }: { session?: string }) {
  const [snapshots, setSnapshots] = useState<ShippingSnapshot[]>([]);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [names, setNames] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    // Agent names for the strip's group headings, once; the strip falls back
    // to the short session id when a session has no agent row.
    fetch("/api/agents?active=60d&limit=300", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(d => {
      if (!d?.agents) return;
      setNames(new Map(d.agents.map((a: { session: string; agent: string }) => [String(a.session).slice(0, 8), String(a.agent)])));
    }).catch(() => {});
  }, []);
  useEffect(() => {
    let active = true;
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await fetch("/api/shipping", { cache: "no-store", signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error("unavailable");
        const data = await r.json();
        if (active) { setSnapshots(data.snapshots); setFailed(false); }
      } catch { if (active) setFailed(true); }
      finally { busy = false; if (active) { setLoaded(true); setNow(Date.now()); } }
    };
    void refresh();
    const timer = setInterval(() => { setNow(Date.now()); void refresh(); }, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const shown = session ? snapshots.filter(s => s.prs.some(p => p.sessions.includes(session))) : snapshots;
  if (session && loaded && !failed && !shown.length) return null;
  return <section className="shipping" aria-label="Shipping status">
    <div className="shipping-heading"><h2>Shipping</h2>{session && <a href="/shipping">All project work</a>}</div>
    {failed && <p className="shipping-warn" role="status">Status unavailable. Previous observations below may be out of date.</p>}
    {!loaded && <p>Checking shipping status…</p>}
    {loaded && !failed && !shown.length && <p>No shipping observations received from a connected Mac yet.</p>}
    {shown.map((s, i) => {
      const stale = failed || now - Date.parse(s.checkedAt) > 180_000 || !!s.sourceError;
      const prs = session ? s.prs.filter(p => p.sessions.includes(session)) : s.prs;
      const runtime = s.runtime;
      // A repository that ships no app has no app to report on, and no
      // delivery: "No app on this Mac" and "delivery unavailable" on a
      // project that never had one read as a fault (29 Sep).
      const ships = !!(runtime || s.installed.dev || s.installed.prod || s.release);
      return <article className="shipping-project" key={`${s.repo}-${s.deviceName}-${i}`}>
        <h3>{s.repo.split("/")[1]} <span>· {s.deviceName}</span></h3>
        <p className={stale ? "shipping-warn" : "shipping-time"}>
          {stale ? "Out of date · " : "Checked "}{new Date(s.checkedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          {s.sourceError ? ` · ${s.sourceError}` : ""}
        </p>
        {/* One line of facts in place of the old paragraphs: the strip's header
            already says Dev, Released and Prod, so this carries only what the
            strip cannot, and the warnings that need a sentence. */}
        <p className="shipping-facts">
          {!ships ? null : runtime ? <>{runtime.channel === "development" ? "Dev" : runtime.channel === "production" ? "Prod" : "App"} {runtime.build} running{runtime.relation === "behind" ? `, ${runtime.behind ?? "some"} merged ${runtime.behind === 1 ? "change" : "changes"} behind main` : runtime.relation === "current" ? ", at main" : ""}</> : s.installed.dev || s.installed.prod ? "No app running" : "No app on this Mac"}
          {s.mainSha && <>{ships ? " · " : ""}main <code>{s.mainSha.slice(0, 8)}</code></>}
          {s.release && <> · latest <a href={`https://github.com/${s.repo}/releases/tag/${encodeURIComponent(s.release.tag)}`} target="_blank" rel="noreferrer">{s.release.tag.split("-")[0]}</a></>}
          {s.cloud && <> · {s.cloud.name.toLowerCase()} <code>{s.cloud.build}</code>{s.cloud.behind === 0 ? ", at main" : s.cloud.behind ? `, ${s.cloud.behind} bot ${s.cloud.behind === 1 ? "change" : "changes"} behind main` : ""} <span title={new Date(s.cloud.servedAt).toLocaleString()}>(last session {new Date(s.cloud.servedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })})</span></>}
          {ships && s.delivery && <> · delivery {s.delivery.phase === "idle" ? "idle" : s.delivery.phase.replaceAll("_", " ")}{s.delivery.reason ? `: ${s.delivery.reason}` : ""}</>}
        </p>
        {s.preview && Date.parse(s.preview.expiresAt) > now && <p className="shipping-warn">Preview held by {s.preview.owner} until {new Date(s.preview.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Main activation waits for handoff.</p>}
        {s.captureActive && <p className="shipping-warn">{stale ? "Last observed: voice" : "Voice"} input is still in progress. App replacement waits for it to finish.</p>}
        {ships && s.delivery && ["failed", "unavailable", "attention"].includes(s.delivery.phase) && <p className="shipping-warn">Automatic delivery {s.delivery.phase === "failed" ? "failed; the source is held for inspection" : s.delivery.phase === "attention" ? "needs attention at merge admission" : "is unavailable"}{s.delivery.targetSha ? ` · ${s.delivery.targetSha.slice(0, 8)}` : ""}.</p>}
        {stale && prs.length > 0 && <p className="shipping-warn">Last observed; the strip below may be out of date.</p>}
        <Strip snapshot={s} session={session} names={names} now={now} />
        {!prs.length && !s.issues.length && <p>No work in this observation.</p>}
        {!session && <p className="shipping-time">Open pull requests, the 20 most recently merged, and the beads tracker beside the checkout. Agents come from recorded PR receipts; an issue joins its agent through the pull request it cites. Dev and Prod are the installed bundles, read from disk.</p>}
      </article>;
    })}
  </section>;
}
