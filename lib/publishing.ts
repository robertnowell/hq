import { pool, asUser } from "./db";
import { getDocument } from "./blobs";
import { reviewForPublishing } from "./review";

/**
 * Publishing: a private archive with a door that one person can open, one
 * page at a time.
 *
 * ANYONE MAY SHARE; ONE ACCOUNT HAS A DOMAIN.
 *
 * Those were the same thing until 13 Sep, and conflating them is why the
 * control could only exist for one person. They are now two:
 *
 * 1. SHARING is for everybody. A shared page gets an address on this hub that
 *    anyone holding it can read, the way a secret gist works. It is never
 *    indexed and never listed: the hub's robots file disallows everything and
 *    the page says noindex itself.
 * 2. A CONNECTED DOMAIN belongs to an account. The one account that has one
 *    (`HQ_SITE_OWNER_USER_ID`, still read from the old name for now) also has
 *    its shared pages fed to that site, which is where indexing happens and
 *    where the canonical points. Nobody else's pages reach it, because the
 *    feed is filtered by that account.
 * 3. A PERSON CLICKS. Nothing in the mirror, the ingest or a cron writes
 *    `published_at`; the only call sites are the two actions below.
 * 3. THE PAGE IS READ FIRST, once, quickly, and if the model thinks something
 *    in it is private the person is asked before anything is written. It does
 *    not refuse, and a check that could not run does not stop a publish: an
 *    occasional double check that becomes a gate is a gate. See
 *    `lib/review.ts` for what it asks and how it has been narrowed.
 *
 * Unpublishing clears `published_at` and KEEPS `public_slug`. Re-publishing
 * the same document then returns to the same address rather than minting a
 * second one, which is what makes a link somebody already has keep working
 * after a page is pulled and put back.
 */

/**
 * The one account with a site connected to this hub, or null.
 *
 * A column on a row this app does not have yet: connecting a domain is its
 * own piece of work (a form, DNS records, a verification) and until it exists
 * the one connected site is named by configuration. Everything downstream
 * already asks the question the right way round, "does this person have a
 * site", so that piece is a swap rather than a rewrite.
 */
export function siteOwnerUserId(): string | null {
  const v = (process.env.HQ_SITE_OWNER_USER_ID ?? process.env.HQ_PUBLISHER_USER_ID ?? "").trim();
  return /^[0-9a-f-]{36}$/i.test(v) ? v : null;
}

export function hasSite(userId: string): boolean {
  const p = siteOwnerUserId();
  return p !== null && p === userId;
}

/** Where a link-shared page is read: the hub, for everybody. Link is not
 *  publish (27 Sep): the site is a separate destination, see siteUrl. */
export function shareBase(_userId: string): string {
  return HUB_BASE;
}

/** The connected site's address for a published page. */
/** A document's one address on the hub, whoever may read it. */
export function documentAddress(id: string): string {
  return `${HUB_ORIGIN}/d/${id}`;
}
export const HUB_ORIGIN = (process.env.HQ_HUB_ORIGIN ?? "https://hq.tranquilitybase.dev").replace(/\/+$/, "");

export function siteUrl(slug: string): string {
  return `${SITE_BASE}/${slug}`;
}

/** The connected site's notes address. */
export const SITE_BASE = (process.env.HQ_PUBLIC_BASE ?? "https://robertnowell.dev/notes")
  .replace(/\/+$/, "");

/** This hub's own public address for a shared page. Unlisted, never indexed. */
export const HUB_BASE = (process.env.HQ_HUB_BASE ?? "https://hq.tranquilitybase.dev/p")
  .replace(/\/+$/, "");

/** Kept for callers not yet moved off it. */
export const PUBLIC_BASE = SITE_BASE;

export type PublishResult =
  | { ok: true; slug: string; url: string }
  | { ok: false; why: string }
  /** Not a refusal: the read noticed something, and the person decides. */
  | { ok: false; confirm: true; risks: string[] };

/** Slug shape for a public address: lowercase, hyphens, nothing surprising. */
function cleanSlug(raw: string): string {
  const s = raw.toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return s.length >= 3 ? s : "";
}

/**
 * Publish one document.
 *
 * The address is minted inside the same tenant scope that proves the document
 * is yours, and the unique index decides collisions: a taken slug is tried
 * again with a suffix rather than stolen. Publishing something already
 * published is not an error, it returns the address it already has.
 */
/**
 * The one look before a page goes out by link. Null means go ahead.
 * Exported for lib/sharing, which is the writer now.
 */
export type PublishRefusal = Exclude<PublishResult, { ok: true }>;

export async function reviewBeforeLink(userId: string, id: string, confirmed: boolean): Promise<PublishRefusal | null> {
  if (confirmed) return null;
  const seen = await asUser(userId, async (c) => {
    const r = await c.query(
      `select title, storage_key, published_at from documents where id = $1`, [id]);
    return r.rows[0] ?? null;
  });
  if (!seen) return { ok: false, why: "no such document" };
  // Already public: re-pressing the button is not a new decision.
  if (!seen.published_at && seen.storage_key) {
    const html = await getDocument(seen.storage_key);
    if (html) {
      const review = await reviewForPublishing(seen.title ?? "", html);
      // A check that did not run lets the publish through. It is a second
      // pair of eyes, not a permission system.
      if (review.risky) return { ok: false, confirm: true, risks: review.risks };
    }
  }
  return null;
}

/**
 * A public address for one of my documents: the one it already has, or a
 * fresh one from its slug or title. The unique index decides collisions; a
 * taken address is tried with a suffix rather than stolen. Null when none
 * could be found.
 */
export async function mintSlug(userId: string, id: string): Promise<string | null> {
  return asUser(userId, async (c) => {
    const r = await c.query(
      `select slug, title, public_slug from documents where id = $1`, [id]);
    const doc = r.rows[0];
    if (!doc) return null;
    if (doc.public_slug) return doc.public_slug as string;
    const base = cleanSlug(doc.slug ?? "") || cleanSlug(doc.title ?? "") || "page";
    for (let n = 1; n <= 10; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      // Across every account: under RLS this query could only see the
      // caller's own rows, and the unique index is global (audit 28 Sep).
      const taken = await c.query(`select hq_slug_taken($1) as t`, [candidate]);
      if (!taken.rows[0].t) return candidate;
    }
    return null;
  });
}

/**
 * Publish one document by link. Kept for the drills and the feed; the writer
 * is hq_set_visibility, the same one the share card uses, so visibility and
 * published_at cannot disagree (seam 1, 27 Sep).
 */
export async function publish(userId: string, id: string, confirmed = false): Promise<PublishResult> {
  const gate = await reviewBeforeLink(userId, id, confirmed);
  if (gate) return gate;
  const slug = await mintSlug(userId, id);
  if (!slug) return { ok: false, why: "could not find a free address for this title" };
  try {
    const { rows } = await pool.query(
      `select * from hq_set_visibility($1, $2, 'link', $3)`, [userId, id, slug]);
    return { ok: true, slug: rows[0].public_slug, url: `${shareBase(userId)}/${rows[0].public_slug}` };
  } catch {
    return { ok: false, why: "that address was just taken; try again" };
  }
}

/** Take it down. The address is kept so putting it back restores the link. */
export async function unpublish(userId: string, id: string): Promise<void> {
  await pool.query(`select * from hq_set_visibility($1, $2, 'private', null)`, [userId, id]);
}

export type PublicDoc = {
  id: string; user_id: string; title: string | null; storage_key: string | null;
  published_at: string; produced_at: string | null; site_published_at: string | null;
};

/**
 * A published document, read with no tenant context at all.
 *
 * This is the only read in the app that is not inside `asUser`, and it is
 * safe for one reason: the function it calls can see nothing but rows
 * somebody published. Row-level security is not bypassed here so much as
 * answered, once, in the database, where the rule is written down.
 */
export async function publicDocument(slug: string): Promise<PublicDoc | null> {
  const { rows } = await pool.query(`select * from hq_published($1)`, [slug]);
  return (rows[0] as PublicDoc) ?? null;
}

export type PublicRow = {
  public_slug: string; user_id: string; title: string | null; storage_key: string | null;
  published_at: string; produced_at: string | null;
};

/**
 * Every shared page, or only the connected site's.
 *
 * The feed the personal site renders must carry that account's pages and
 * nobody else's: sharing is for everybody, and somebody else's link ending up
 * on a stranger's website is the failure this whole split exists to prevent.
 */
export async function publicIndex(opts: { ownedBy?: string | null } = {}): Promise<PublicRow[]> {
  const { rows } = await pool.query(`select * from hq_published_all()`);
  const owner = opts.ownedBy;
  return owner ? rows.filter((r: PublicRow) => r.user_id === owner) : rows;
}
