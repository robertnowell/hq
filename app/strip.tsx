"use client";
import { Fragment, type CSSProperties } from "react";
import { STAGES, rowOrder, stripRows, type StripRow } from "@/lib/strip";
import type { ShippingSnapshot } from "@/lib/shipping";

/**
 * The work strip: one row per pull request or issue, seven fixed stages as
 * dots under a banded header, and a flag only where something needs the
 * reader. Read-only; nothing here drags. Ruled 28 Sep 2026 from the pipeline
 * research: the shipping table's twenty identical sentences and their uuids
 * were "mostly useless"; a reader who only looks needs position, one word,
 * and how long.
 */
function Dots({ row, stages }: { row: StripRow; stages: readonly string[] }) {
  if (row.stage === "Dropped" || row.stage === "Done") return <span className="strip-dots off">{stages.map(s => <i key={s} title={s} />)}</span>;
  const k = stages.indexOf(row.stage);
  return <span className="strip-dots">{stages.map((s, j) => {
    const cls = j < k ? "past" : j === k ? "now" + (row.flag ? " " + row.flag.tier : "") : "next";
    return <i key={s} className={cls} title={j === k ? `${s}${row.note ? " · " + row.note : ""}` : s} />;
  })}</span>;
}

function Row({ row, stages }: { row: StripRow; stages: readonly string[] }) {
  const done = ["Dev", "Released", "Prod", "Done"].includes(row.stage);
  const what = row.flag ? <span className={`strip-flag ${row.flag.tier}`}>{row.flag.text}</span> : <span className="strip-note">{row.note}</span>;
  return <div className={`strip-row${done ? " done" : ""}`}>
    <span className="strip-label">{row.url ? <a href={row.url} target="_blank" rel="noreferrer">{row.label}</a> : row.label}</span>
    <Dots row={row} stages={stages} />
    {what}
  </div>;
}

export function Strip({ snapshot, session, names, now }: { snapshot: ShippingSnapshot; session?: string; names: Map<string, string>; now: number }) {
  const rows = stripRows(snapshot, now);
  // A repository with no installed app and no release has nowhere past
  // Merged to go, so its strip stops there: four stages, not seven with
  // three that can never fill.
  const deploys = !!(snapshot.installed.dev || snapshot.installed.prod || snapshot.release);
  const stages: readonly string[] = deploys ? STAGES : STAGES.slice(0, 4);
  const sub: Record<string, string> = {
    Dev: snapshot.installed.dev ? `${snapshot.installed.dev.build}${snapshot.installed.dev.running ? "" : " off"}` : "none",
    Released: snapshot.release?.tag.split("-")[0]?.replace(/^v/, "") ?? "none",
    Prod: snapshot.installed.prod ? `${snapshot.installed.prod.build}${snapshot.installed.prod.running ? "" : " off"}` : "none",
  };
  const head = <div className="strip-head" style={{ "--n": stages.length } as CSSProperties}><span className="strip-k">Work</span><span className="strip-stages">{stages.map(s => <span key={s}>{s}<b>{sub[s] ?? ""}</b></span>)}</span><span className="strip-k">What now</span></div>;
  const style = { "--n": stages.length } as CSSProperties;
  if (session) {
    const mine = rows.filter(r => r.sessions.includes(session)).sort(rowOrder);
    if (!mine.length) return null;
    const prs = mine.filter(r => r.kind === "pr"), issues = mine.filter(r => r.kind === "issue");
    return <div className="strip" style={style}>{head}
      <div className="strip-group"><span className="strip-k">Pull requests · {prs.length}</span>{prs.map(r => <Row key={r.key} row={r} stages={stages} />)}</div>
      {issues.length > 0 && <div className="strip-group"><span className="strip-k">Issues its pull requests carry · {issues.length}</span>{issues.map(r => <Row key={r.key} row={r} stages={stages} />)}</div>}
    </div>;
  }
  // The whole project: agents with flagged work first, then by size; issues
  // nobody's pull request cites sit under the tracker itself.
  const groups = new Map<string, StripRow[]>();
  for (const r of rows) {
    const keys = r.sessions.length ? r.sessions : [r.kind === "issue" ? "tracker" : "none"];
    for (const k of keys) { if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(r); }
  }
  const flagged = (rs: StripRow[]) => rs.filter(r => r.flag && r.flag.tier !== "moving").length;
  const ordered = [...groups.entries()].sort(([ka, a], [kb, b]) => {
    const fa = flagged(a), fb = flagged(b);
    if ((fa > 0) !== (fb > 0)) return fa > 0 ? -1 : 1;
    if (fa !== fb) return fb - fa;
    const special = (k: string) => k === "tracker" ? 2 : k === "none" ? 1 : 0;
    if (special(ka) !== special(kb)) return special(ka) - special(kb);
    return b.length - a.length;
  });
  const title = (k: string) => k === "tracker" ? `${snapshot.repo.split("/")[1]} · issues without a pull request` : k === "none" ? "No agent linked" : names.get(k.slice(0, 8)) ?? `agent ${k.slice(0, 8)}`;
  const nb = rows.filter(r => r.flag?.tier === "blocked").length, na = rows.filter(r => r.flag?.tier === "attention").length;
  return <div className="strip" style={style}>
    <p className="strip-sum">{nb + na === 0 ? "Nothing needs you." : `${nb + na} need you: ${nb} blocked, ${na} waiting. Days are days since the row last changed.`}</p>
    {head}
    {ordered.map(([k, rs]) => <Fragment key={k}><div className="strip-group"><span className="strip-k">{k === "none" || k === "tracker" ? title(k) : <a href={`/open?session=${encodeURIComponent(k)}`}>{title(k)}</a>} · {rs.length}</span>{rs.sort(rowOrder).map(r => <Row key={r.key} row={r} stages={stages} />)}</div></Fragment>)}
    <div className="strip-legend"><span><i className="now" />where it is</span><span><i className="past" />passed</span><span><i className="attention" />needs you</span><span><i className="blocked" />blocked</span><span><i className="next" />ahead</span></div>
  </div>;
}
