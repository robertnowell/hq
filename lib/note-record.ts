/**
 * A published document, as a record the personal site can render.
 *
 * The site at robertnowell.dev does not link to pages, it RENDERS them: each
 * note is a JSON record with its own stylesheet and body, drawn inside the
 * site's chrome with its topic index, its tags, its canonical and its
 * sitemap. That design predates this app (the laptop's publisher wrote the
 * same records from disk), and it is the reason the hub serves a feed rather
 * than asking the site to proxy a page: proxying gets you a correct page with
 * no site around it.
 *
 * So this is the same transformation the laptop's publisher performs, in the
 * one place that now owns it. The shapes must agree field for field, because
 * the site reads both.
 */

export type NoteRecord = {
  slug: string; title: string; summary: string; question: string;
  date: string; updated: string; brand: string; type: string;
  tags: string[]; css: string; body: string;
  /** Set when the page runs its own code (audio, picks, toggles): the address
   *  of the whole page, served sandboxed, which the site frames in place of
   *  `body`. `body` still carries the text, for search and for the cards. */
  frame?: string;
};

/** A page's own scripts, not counting JSON-LD, which is data. */
export function runsCode(html: string): boolean {
  return /<script\b(?![^>]*type=["']application\/(?:ld\+)?json["'])[^>]*>/i.test(html);
}

/**
 * What the site may show of a page: the stamped footer goes, because it
 * carries the absolute path of the file on the author's laptop.
 */
export function forTheSite(html: string): string {
  let raw = html.replace(/<footer[^>]*data-tb-agent=[\s\S]*?<\/footer>/gi, "");
  raw = raw.replace(/<footer\b(?:(?!<\/footer>)[\s\S])*?tranquilitybase:\/\/(?:(?!<\/footer>)[\s\S])*?<\/footer>/gi, "");
  return raw;
}

/**
 * Re-root a self-contained page's stylesheet so it cannot escape its box.
 *
 * Archive pages are written to stand alone: each declares `:root` custom
 * properties and styles `body` directly. Dropped into a site verbatim, those
 * two repaint the host. Rewriting them to the container keeps every rule the
 * page relies on, including its dark-mode block, and confines all of it.
 */
export function scopeCss(css: string, sel = "#note"): string {
  return css
    .replace(/(?<![\w-]):root\b/g, sel)
    .replace(/(^|[,{}\s])body\b/gm, `$1${sel}`);
}

const meta = (html: string, name: string): string => {
  const m = html.match(
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]*content=["']([^"']*)["']`, "i"))
    ?? html.match(
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*name=["']${name}["']`, "i"));
  return m ? m[1].trim() : "";
};

/** The record for one published page. */
export function noteRecord(
  html: string,
  d: { slug: string; title: string | null; published_at: string; produced_at: string | null },
  frameBase?: string,
): NoteRecord {
  const raw = forTheSite(html);

  const css = [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)]
    .map((m) => scopeCss(m[1])).join("\n");

  const bodyMatch = raw.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  let body = bodyMatch ? bodyMatch[1] : raw;
  // No scripts on somebody else's domain. The page keeps its text, its
  // layout and its styles; what it loses is the ability to run code inside
  // an origin that is not the archive's. A page that NEEDS its code (3 Oct
  // 2026: a blind test whose Listen buttons went dead on the site) is framed
  // instead, from the hub, in a null origin: its code runs, and still not on
  // the site's origin or the hub's.
  const interactive = runsCode(body);
  body = body.replace(/<script\b[\s\S]*?<\/script>/gi, "");

  const day = (t: string | null) => (t ? new Date(t).toISOString().slice(0, 10) : "");
  const tags = meta(raw, "intranet:tags")
    .split(",").map((t) => t.trim()).filter(Boolean);

  return {
    slug: d.slug,
    title: d.title ?? d.slug,
    summary: meta(raw, "intranet:summary"),
    question: "",
    date: day(d.produced_at ?? d.published_at),
    updated: day(d.published_at),
    brand: "",
    type: "",
    tags,
    css,
    body,
    ...(interactive && frameBase ? { frame: `${frameBase.replace(/\/+$/, "")}/${d.slug}` } : {}),
  };
}
