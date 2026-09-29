"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { setShare, shareInfo, teamLookup } from "./actions";
import type { ShareState, TeamProfile } from "@/lib/sharing";

/**
 * Sharing one page. A radio, one address, one Update (Robert, 27 Sep).
 *
 *   Private            only you.
 *   Team               your company, named and marked from its own website;
 *                      anyone who signs in at that domain, now or later.
 *                      Another company is one click away and is called that.
 *   Anyone with link   anyone who enters an email and gets a code.
 *   Publish to site    the connected website too, for search engines. Only
 *                      an account with a site sees this.
 *
 * THE ADDRESS DOES NOT MOVE. A document has one URL on the hub, /d/<id>,
 * and the radio decides who that URL admits (db/018 hq_can_read): the
 * owner, the team, or anyone signed in. So the same box shows the same
 * address in every state, with Copy, and the state is the only thing that
 * changes. The older /p/<slug> address keeps working for links already sent.
 *
 * Link is not publish. Who read it is not shown here: this is where the
 * document goes, and the reader list has not been designed yet (27 Sep).
 * Nothing is optimistic; a refused change stays open and says why.
 */
type Choice = "private" | "team" | "link" | "site";

export function ShareCard({ id, title, initialVisibility = "private", onDone, onClose, onDirtyChange, leaveRequest = 0 }: {
  id: string;
  title: string;
  initialVisibility?: "private" | "team" | "link";
  onDone?: () => void;
  /** Present when the card sits in a dialog; a window closes itself. */
  onClose?: () => void;
  /** The host learns when a choice is pending, so Escape can ask first. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Bumped by the host when Escape was pressed on a pending choice. */
  leaveRequest?: number;
}) {
  const [state, setState] = useState<ShareState>({
    visibility: initialVisibility, teams: [], url: null, site: false, siteUrl: null,
  });
  const [myTeam, setMyTeam] = useState<TeamProfile | null>(null);
  const [siteBase, setSiteBase] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>(initialVisibility);
  const [other, setOther] = useState<TeamProfile | null>(null);   // "another company", once looked up
  const [otherMode, setOtherMode] = useState(false);
  const [typed, setTyped] = useState("");
  const [risks, setRisks] = useState<string[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [pending, start] = useTransition();

  // The one address. Filled on the client, where the origin is known.
  useEffect(() => { setOrigin(window.location.origin); }, []);
  const hubAddress = `${origin}/d/${id}`;

  useEffect(() => {
    let live = true;
    shareInfo(id).then(async (r) => {
      if (!live || !r) return;
      setState(r.state); setMyTeam(r.myTeam); setSiteBase(r.site);
      setChoice(r.state.site ? "site" : r.state.visibility);
      const shared = r.state.teams[0] ?? null;
      if (shared && shared !== r.myTeam?.domain) {
        setOtherMode(true); setTyped(shared);
        const p = await teamLookup(shared); if (live) setOther(p);
      }
    }).catch(() => {});
    return () => { live = false; };
  }, [id]);

  const team: TeamProfile | null = otherMode ? other : myTeam;
  const teamDomain = otherMode ? (other?.domain ?? typed.trim().toLowerCase()) : (myTeam?.domain ?? "");
  const current: Choice = state.site ? "site" : state.visibility;
  // Published to the site, the address worth sending is the public one
  // (Robert, 29 Sep: "it still gave the hq url instead of robertnowell.dev").
  const onSite = current === "site" && !!state.siteUrl;
  const address = onSite ? state.siteUrl! : hubAddress;
  const dirty = choice !== current || (choice === "team" && teamDomain !== (state.teams[0] ?? ""));

  // A CHOICE THAT WAS NOT APPLIED IS NOT A STATE, and leaving with one
  // pending must not be silent (Robert, 28 Sep: the creator did not
  // understand the current state; a page stayed private with the link
  // option selected). Discard and Escape both come through here: with a
  // pending choice the card asks, with none it just goes.
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  // Only a NEW request counts. A fresh card mounts with the host's last
  // count already at 1, and acting on it closed the dialog on the very
  // next open (caught by the drill, 28 Sep).
  const seenLeave = useRef(leaveRequest);
  useEffect(() => {
    if (leaveRequest === seenLeave.current) return;
    seenLeave.current = leaveRequest;
    if (dirty) setLeaving(true); else onClose?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leaveRequest]);
  useEffect(() => { if (!dirty) setLeaving(false); }, [dirty]);
  const leave = () => { if (dirty) setLeaving(true); else onClose?.(); };

  const lookup = () => start(async () => {
    const d = typed.trim().toLowerCase();
    if (!d) return;
    const p = await teamLookup(d);
    setOther(p ?? { domain: d, name: d, logo: null });
  });

  const apply = (confirmed = false) => start(async () => {
    setFailed(null);
    try {
      const r = await setShare(id, { kind: "apply", visibility: choice, domain: choice === "team" ? teamDomain : null, confirmed });
      if (r.ok) { setRisks(null); setState(r.state); setChoice(r.state.site ? "site" : r.state.visibility); onDone?.(); return; }
      if ("confirm" in r) { setRisks(r.risks); return; }
      setRisks(null); setFailed(r.why);
    } catch (e) {
      // A tab older than the hub: after a deploy the action id it holds no
      // longer exists, and Next reports exactly that. Say what to do.
      const msg = e instanceof Error ? e.message : String(e);
      setFailed(/server action/i.test(msg)
        ? "This page is older than the hub. Reload it and press Update again."
        : "The hub did not answer. Nothing was changed.");
    }
  });

  const copy = async () => {
    try { await navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch { setFailed("Could not reach the clipboard. Select the address and copy it."); }
  };

  return (
    <div className="sc">
      <p className="sc-kicker">Share</p>
      <h2 className="sc-title">{title}</h2>

      <div className="sc-radio" role="radiogroup" aria-label="Who can read this">
        <label className="sc-opt" data-on={choice === "private" ? "" : undefined}>
          <input type="radio" name="vis" checked={choice === "private"} onChange={() => setChoice("private")} disabled={pending} />
          <span className="sc-opt-body"><b>Private</b><small>Only you.</small></span>
        </label>

        <label className="sc-opt" data-on={choice === "team" ? "" : undefined}>
          <input type="radio" name="vis" checked={choice === "team"} onChange={() => setChoice("team")} disabled={pending || (!myTeam && !otherMode)} />
          <span className="sc-opt-body">
            {team ? (
              <b className="sc-team">
                {team.logo && <img className="sc-mark" src={team.logo} alt="" width={20} height={20} />}
                <span>{team.name}</span><span className="sc-dom">{team.domain}</span>
              </b>
            ) : otherMode ? (
              <b className="sc-team"><span>Another company</span></b>
            ) : (
              <b className="sc-team"><span>Your company</span></b>
            )}
            <small>
              {team ? `Anyone who signs in with an @${team.domain} address, now or later.`
                    : otherMode ? "Name its domain and it is looked up."
                    : "Sign in with a work address and your company appears here."}
            </small>
            {choice === "team" && otherMode && (
              <span className="sc-other">
                <input value={typed} onChange={(e) => { setTyped(e.target.value); setOther(null); }} placeholder="company.com"
                       spellCheck={false} aria-label="company domain" disabled={pending}
                       onBlur={lookup} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); lookup(); } }} />
                {myTeam && <button type="button" className="sc-again" onClick={() => { setOtherMode(false); setOther(null); setTyped(""); }}>back to {myTeam.name}</button>}
              </span>
            )}
            {choice === "team" && !otherMode && (
              <span className="sc-other"><button type="button" className="sc-again" onClick={() => { setOtherMode(true); setChoice("team"); }}>another company…</button></span>
            )}
          </span>
        </label>

        <label className="sc-opt" data-on={choice === "link" ? "" : undefined}>
          <input type="radio" name="vis" checked={choice === "link"} onChange={() => setChoice("link")} disabled={pending} />
          <span className="sc-opt-body">
            <b>Anyone with the link</b>
            <small>They enter an email and get a code. Not indexed.</small>
          </span>
        </label>

        {siteBase ? (
          <label className="sc-opt" data-on={choice === "site" ? "" : undefined}>
            <input type="radio" name="vis" checked={choice === "site"} onChange={() => setChoice("site")} disabled={pending} />
            <span className="sc-opt-body">
              <b>Publish to {siteBase.replace(/^https?:\/\//, "")}</b>
              <small>On your website, indexed by search engines.{current === "site" && state.siteUrl ? " Live." : ""}</small>
            </span>
          </label>
        ) : (
          /* No site connected: not a choice yet, a pointer to connecting one
             (Robert, 29 Sep: "a pointer to connect your blog CMS which goes
             to an integrations flow"). */
          <a className="sc-opt sc-connect" href="/integrations" target="_blank" rel="noopener">
            <span className="sc-connect-plus" aria-hidden="true">+</span>
            <span className="sc-opt-body"><b>Publish to your website</b><small>Connect your blog or CMS.</small></span>
          </a>
        )}
      </div>

      {risks && (
        <div className="sc-ask">
          <p>Before it goes out, one look at it:</p>
          <ul>{risks.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      )}

      {/* The address, in every APPLIED state. While a choice is pending the
          address and the radio disagree about who it admits, so the box
          goes and one line says why (Robert, 28 Sep). */}
      <div className="sc-addr">
        <span className="sc-addr-label">{onSite ? "Public URL" : "Shareable URL"}</span>
        {dirty ? (
          <p className="sc-addr-wait">Shown once you press Update.</p>
        ) : (
          <div className="sc-addr-row">
            <a className="sc-addr-url" href={address} target="_blank" rel="noopener">{onSite || origin ? address : `/d/${id}`}</a>
            <button type="button" className="sc-btn sc-copy" onClick={copy} disabled={pending || (!origin && !onSite)}>{copied ? "Copied" : "Copy"}</button>
          </div>
        )}
      </div>

      {failed && <p className="sc-failed" role="alert">{failed}</p>}

      {leaving && !risks ? (
        <div className="sc-leave" role="alertdialog" aria-label="Unsaved change">
          <p>You changed who can read this but did not press Update.</p>
          <p className="sc-foot">
            <button type="button" className="sc-btn" onClick={() => onClose?.()} disabled={pending}>Leave without updating</button>
            <button type="button" className="sc-btn sc-go" disabled={pending || (choice === "team" && !teamDomain)} onClick={() => apply(false)}>
              {pending ? "Working…" : "Update"}
            </button>
          </p>
        </div>
      ) : (
        <p className="sc-foot">
          {risks && <button type="button" className="sc-btn" onClick={() => setRisks(null)} disabled={pending}>Not now</button>}
          {onClose && !risks && <button type="button" className="sc-btn" onClick={leave} disabled={pending}>{dirty ? "Discard" : "Close"}</button>}
          <button type="button" className="sc-btn sc-go" disabled={pending || (!dirty && !risks) || (choice === "team" && !teamDomain)}
                  onClick={() => apply(risks !== null)}>
            {pending ? "Working…" : risks ? "Share anyway" : "Update"}
          </button>
        </p>
      )}
    </div>
  );
}
