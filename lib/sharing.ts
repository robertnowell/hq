import { pool, asUser } from "./db";
import { siteUrl, reviewBeforeLink, mintSlug, hasSite, documentAddress } from "./publishing";
import { shareableDomain, isDomainShaped } from "./domain";

/**
 * Sharing: private, team, link. Ruled 27 Sep 2026.
 *
 * A document has one visibility. `team` means at least one live share row
 * to an org (a domain); `link` means the existing public address
 * (public_slug + published_at, which the site feed also reads); `private`
 * means neither. Every transition is a click on the share card, the same
 * rule publishing has always had: nothing in the mirror or the ingest ever
 * changes visibility.
 *
 * The team functions are SECURITY DEFINER in db/018 and check ownership
 * themselves; this file adds the one guard the database cannot: a domain
 * that is a public email provider is not a team, and the refusal names it.
 */

export type Visibility = "private" | "team" | "link";

export type ShareState = {
  visibility: Visibility;
  /** Live team shares, by domain. */
  teams: string[];
  /** The link address when visibility is link: the hub's, for everybody. */
  url: string | null;
  /** On the connected site as well (publishing, not sharing). */
  site: boolean;
  siteUrl: string | null;
};

/** The card's view of one of my documents. */
export async function shareState(userId: string, id: string): Promise<ShareState | null> {
  const d = await asUser(userId, async (c) => {
    const r = await c.query(`select visibility, published_at, public_slug, site_published_at from documents where id = $1`, [id]);
    return r.rows[0] ?? null;
  });
  if (!d) return null;
  const teams = await teamsOf(userId, id);
  // One address in every state that admits anyone but the owner: /d/<id>.
  // /p/<slug> stays alive for links already sent, and is never handed out.
  const url = d.visibility === "private" ? null : documentAddress(id);
  const site = !!d.site_published_at && d.visibility === "link";
  return { visibility: d.visibility as Visibility, teams, url, site,
           siteUrl: site && d.public_slug ? siteUrl(d.public_slug) : null };
}

export type Reader = {
  address: string | null; domain: string | null;
  first_at: string; last_at: string; seconds: number;
};

/** The domains a document is currently shared to, for the owner. */
export async function teamsOf(userId: string, id: string): Promise<string[]> {
  const { rows } = await pool.query(
    `select domain from hq_shares_of($1, $2)`, [userId, id]);
  return rows.map((r) => r.domain as string);
}

export type ShareResult =
  | { ok: true; state: ShareState }
  | { ok: false; why: string }
  | { ok: false; confirm: true; risks: string[] };

/**
 * Share to a team. Creates the team if nobody has named it before.
 * Refuses a public provider before the database ever hears of it.
 */
export async function shareToTeam(userId: string, id: string, rawDomain: string): Promise<ShareResult> {
  const d = shareableDomain(rawDomain);
  if (!d.ok) return { ok: false, why: d.why };
  try {
    await pool.query(`select * from hq_share_to_domain($1, $2, $3)`, [userId, id, d.domain]);
  } catch (e) {
    const msg = (e as { code?: string }).code === "42501" ? "not your document" : "could not share";
    return { ok: false, why: msg };
  }
  const teams = await teamsOf(userId, id);
  return { ok: true, state: { visibility: "team", teams, url: null, site: false, siteUrl: null } };
}

/** Stop sharing to one team. When it was the last, the page is private. */
export async function unshareTeam(userId: string, id: string, domain: string): Promise<ShareResult> {
  await pool.query(`select hq_unshare_domain($1, $2, $3)`, [userId, id, domain.toLowerCase()]);
  const teams = await teamsOf(userId, id);
  if (teams.length === 0) await setPrivate(userId, id);
  return { ok: true, state: { visibility: teams.length ? "team" : "private", teams, url: null, site: false, siteUrl: null } };
}

/** Anyone with the link, signed in with any email. */
export async function shareByLink(userId: string, id: string, _confirmed = false): Promise<ShareResult> {
  // No review here. The one look before a page goes out belongs to
  // publishing (the open web, indexed); a link is a person you chose sending
  // a person you chose to an address behind an email code, and it applies on
  // the one Update (Robert, 27 Sep: "sharing with a link is unfettered").
  // It used to run: the review swapped Update for "Share anyway" on a page
  // naming a person, the card was closed, and the document stayed private,
  // which read as "it does not keep the state".
  // No slug. The link's address is /d/<id>; a slug is only for the site.
  // Minting one here is what made two accounts collide on "weekly-status"
  // (audit 28 Sep): the check ran under RLS and could not see the other.
  await pool.query(`select * from hq_set_visibility($1, $2, 'link', null)`, [userId, id]);
  const st = await shareState(userId, id);
  return { ok: true, state: st ?? { visibility: "link", teams: [], url: documentAddress(id), site: false, siteUrl: null } };
}

/** Back to only the owner. The safety valve: one press, no questions. */
export async function setPrivate(userId: string, id: string): Promise<ShareResult> {
  await pool.query(`select * from hq_set_visibility($1, $2, 'private', null)`, [userId, id]);
  return { ok: true, state: { visibility: "private", teams: [], url: null, site: false, siteUrl: null } };
}

/** Who read one of my documents. */
export async function readers(userId: string, id: string): Promise<Reader[]> {
  const { rows } = await pool.query(`select * from hq_readers($1, $2)`, [userId, id]);
  return rows as Reader[];
}

/** One open, owner or reader. Nothing if they may not read, or opened it in the last half hour. */
export async function recordOpen(userId: string, id: string): Promise<void> {
  await pool.query(`select hq_record_open($1, $2)`, [userId, id]);
}

export type OpenedDoc = {
  id: string; title: string | null; summary: string | null; opened_at: string;
  owner_id: string; agent_title: string | null; team_domain: string | null;
};

/** What this person opened, newest first, one row per document they may still read. */
export async function recentlyOpened(userId: string, limit = 5): Promise<OpenedDoc[]> {
  const { rows } = await pool.query(`select * from hq_recently_opened($1, $2)`, [userId, limit]);
  return rows as OpenedDoc[];
}

export type PopularDoc = {
  id: string; title: string | null; summary: string | null; opens: number; openers: number;
  owner_id: string; agent_title: string | null; team_domain: string | null;
  /** Distinct people behind the whole list; the page ranks only above a floor. */
  readers: number;
};

/** The most-opened documents this person may read over the last `days`. Never names who. */
export async function popular(userId: string, days = 7, limit = 5): Promise<PopularDoc[]> {
  const { rows } = await pool.query(`select * from hq_popular($1, $2, $3)`, [userId, days, limit]);
  return rows as PopularDoc[];
}

/** A read, from the reader's own session. Silently nothing if they may not read. */
export async function recordRead(userId: string, id: string, seconds: number): Promise<void> {
  const s = Math.max(0, Math.min(Math.floor(seconds || 0), 600));
  await pool.query(`select hq_record_read($1, $2, $3)`, [userId, id, s]);
}

/** The sidebar's teams with their five newest pages, and Shared with you's counts, in one call (db/029). */
export type SidebarTeams = {
  teams: { id: string; domain: string; name: string; member: boolean; pages: number; unread: number;
           docs: { id: string; title: string; at: string }[] }[];
  shared: { count: number; unread: number };
};
export async function sidebarTeams(userId: string): Promise<SidebarTeams> {
  const { rows } = await pool.query(`select hq_sidebar_teams($1) as s`, [userId]);
  return rows[0].s as SidebarTeams;
}

export type Team = {
  org_id: string; domain: string; name: string; member: boolean;
  pages: number; unread: number; newest: string | null;
};

export async function myTeams(userId: string): Promise<Team[]> {
  const { rows } = await pool.query(`select * from hq_my_teams($1)`, [userId]);
  return rows as Team[];
}

export type TeamDoc = {
  id: string; title: string | null; slug: string; summary: string | null; labels: string[];
  produced_at: string | null; shared_at: string; agent_title: string | null;
  source_session_id: string; owner_id: string; owner_address: string | null; read: boolean;
};

export async function teamDocuments(userId: string, domain: string, limit = 50): Promise<TeamDoc[]> {
  const { rows } = await pool.query(
    `select * from hq_team_documents($1, $2, $3)`, [userId, domain.toLowerCase(), limit]);
  return rows as TeamDoc[];
}

export type ReaderDoc = {
  id: string; title: string | null; slug: string; storage_key: string | null;
  visibility: Visibility; owner_id: string; owner_address: string | null;
  agent_title: string | null; source_session_id: string; team_domain: string | null;
};

/** A document for someone who is not its owner, or null. */
export async function documentForReader(userId: string, id: string): Promise<ReaderDoc | null> {
  const { rows } = await pool.query(`select * from hq_document_for_reader($1, $2)`, [userId, id]);
  return (rows[0] as ReaderDoc) ?? null;
}

export type TeamHit = TeamDoc & { rank: number; snippet: string };

/** Search one team's shared pages. Same tsv and ranking as the owner's search. */
export async function teamSearch(userId: string, domain: string, q: string, limit = 30): Promise<TeamHit[]> {
  const { rows } = await pool.query(
    `select * from hq_team_search($1, $2, $3, $4)`, [userId, domain.toLowerCase(), q, limit]);
  return rows as TeamHit[];
}

/**
 * One transition from the card: the chosen destination, applied.
 *
 * Four destinations, two of them the same visibility: "link" is the hub's
 * address behind a sign-in; "site" is the link AND the connected website,
 * which exists for search engines. Link is not publish (27 Sep).
 */
export async function applyShare(
  userId: string, id: string, choice: Visibility | "site", domain: string | null, confirmed = false,
): Promise<ShareResult> {
  if (choice === "private") return setPrivate(userId, id);
  if (choice === "link") {
    const r = await shareByLink(userId, id, confirmed);
    if (!r.ok) return r;
    await pool.query(`select * from hq_set_site_publication($1, $2, false, null)`, [userId, id]);
    const st = await shareState(userId, id);
    return { ok: true, state: st ?? r.state };
  }
  if (choice === "site") {
    if (!hasSite(userId)) return { ok: false, why: "This account has no site connected." };
    const gate = await reviewBeforeLink(userId, id, confirmed);
    if (gate) return gate;
    const slug = await mintSlug(userId, id);
    if (!slug) return { ok: false, why: "could not find a free address for this title" };
    await pool.query(`select * from hq_set_site_publication($1, $2, true, $3)`, [userId, id, slug]);
    const st = await shareState(userId, id);
    return { ok: true, state: st! };
  }
  if (!domain) return { ok: false, why: "Which team? Sign in with a work address, or name a domain." };
  const r = await shareToTeam(userId, id, domain);
  if (!r.ok) return r;
  const d = domain.trim().toLowerCase();
  for (const other of r.state.teams.filter((t) => t !== d)) {
    await pool.query(`select hq_unshare_domain($1, $2, $3)`, [userId, id, other]);
  }
  const teams = await teamsOf(userId, id);
  return { ok: true, state: { visibility: "team", teams, url: null, site: false, siteUrl: null } };
}

export type TeamProfile = { domain: string; name: string; logo: string | null };

/**
 * A team, as its own website describes it: og:site_name, else the title
 * before its first separator, and the icon it declares. Looked up once per
 * org and kept; a name typed by a person later wins over this.
 */
export async function teamProfile(domain: string): Promise<TeamProfile> {
  const d = domain.trim().toLowerCase();
  const { rows } = await pool.query(`select * from hq_org_profile($1)`, [d]);
  const o = rows[0];
  if (o?.org_profiled_at) return { domain: d, name: o.org_name && o.org_name !== d ? o.org_name : teamName(d), logo: o.org_logo_url ?? null };
  const found = await lookupSite(d);
  const name = found.name ?? teamName(d);
  const logo = found.logo ?? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64`;
  await pool.query(`select hq_set_org_profile($1, $2, $3)`, [d, name, logo]).catch(() => {});
  return { domain: d, name, logo };
}

/**
 * Is this hostname a public address on the internet? The lookup fetches a
 * company's own homepage from this server, so it must never reach a private
 * network, a cloud metadata address or localhost, however the name or a
 * redirect is dressed up (safety review, 29 Sep).
 */
async function publicHost(host: string): Promise<boolean> {
  if (!isDomainShaped(host)) return false;
  const { lookup } = await import("node:dns/promises");
  const addrs = await lookup(host, { all: true }).catch(() => []);
  if (addrs.length === 0) return false;
  return addrs.every(({ address: a }) => {
    if (a.includes(":")) {
      const x = a.toLowerCase();
      return !(x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80") || x.startsWith("::ffff:") || x === "::");
    }
    const [p, q] = a.split(".").map(Number);
    return !(p === 10 || p === 127 || p === 0 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31)
      || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || p >= 224);
  });
}

async function lookupSite(d: string): Promise<{ name: string | null; logo: string | null }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5000);
  try {
    // Redirects are followed by hand, at most three, each hop checked.
    let url = new URL(`https://${d}/`), r: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      if (url.protocol !== "https:" || !(await publicHost(url.hostname))) return { name: null, logo: null };
      r = await fetch(url, { signal: ctrl.signal, redirect: "manual",
        headers: { "user-agent": "Mozilla/5.0 (hub profile lookup)" } });
      const next = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
      if (!next) break;
      url = new URL(next, url);
      r = null;
    }
    if (!r || !r.ok) return { name: null, logo: null };
    // At most 200 kB read, whatever the page sends.
    const reader = r.body?.getReader();
    let html = "", got = 0;
    while (reader && got < 200_000) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.length; html += new TextDecoder().decode(value);
    }
    reader?.cancel().catch(() => {});
    const pick = (re: RegExp) => { const m = html.match(re); return m ? decode(m[1]).trim() : null; };
    const siteName = pick(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)
      ?? pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
    const title = pick(/<title[^>]*>([^<]{1,200})<\/title>/i);
    const name = siteName ?? (title ? title.split(/\s+[|–—\-:·]\s+/)[0].trim() : null);
    const iconHref = pick(/<link[^>]+rel=["'][^"']*icon[^"']*["'][^>]+href=["']([^"']+)["']/i)
      ?? pick(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'][^"']*icon[^"']*["']/i);
    const logoUrl = iconHref ? new URL(iconHref, url) : null;
    const logo = logoUrl && logoUrl.protocol === "https:" ? logoUrl.toString() : null;
    return { name: name && name.length <= 80 ? name : null, logo };
  } catch {
    return { name: null, logo: null };
  } finally {
    clearTimeout(t);
  }
}

function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

/** A team's display name: its recorded name, else the domain's first label, capitalised. */
export function teamName(domain: string, recorded?: string | null): string {
  if (recorded && recorded !== domain) return recorded;
  const label = domain.split(".")[0] ?? domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export type SharedWithMe = {
  id: string; title: string | null; slug: string; summary: string | null;
  shared_at: string; owner_address: string | null; team_domain: string | null; read: boolean;
};

/** What has been shared with this person: their team's pages, and the links they opened (db/020). */
export async function sharedWithMe(userId: string, limit = 100): Promise<SharedWithMe[]> {
  const { rows } = await pool.query(`select * from hq_shared_with_me($1, $2)`, [userId, limit]);
  return rows;
}

export type DocumentPreview = {
  doc_title: string | null; doc_summary: string | null; doc_visibility: Visibility;
  org_name: string | null; org_logo_url: string | null; org_domain: string | null;
};

/** What a link unfurler may know about a document (db/021). Null for private or missing. */
export async function documentPreview(id: string, userId: string | null): Promise<DocumentPreview | null> {
  const { rows } = await pool.query(`select * from hq_document_preview($1, $2)`, [id, userId]);
  return rows[0] ?? null;
}
