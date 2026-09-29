/**
 * What the page says about itself: intranet:tags and intranet:summary.
 *
 * Read from the head only, with a plain attribute scan rather than a parser:
 * the meta tags are written by a template and the worst case of a malformed
 * one is an empty label, not a wrong one. Tags are lower-cased kebab words,
 * at most eight; a summary is one sentence, cut at 500 characters.
 */
export function headMeta(html: string): { labels: string[]; summary: string | null } {
  const head = html.slice(0, Math.min(html.length, 20_000));
  const meta = (name: string): string | null => {
    const re = new RegExp(`<meta\\s+[^>]*name=["']${name}["'][^>]*>`, "i");
    const m = head.match(re);
    if (!m) return null;
    const c = m[0].match(/content=["']([^"']*)["']/i);
    return c ? c[1].trim() : null;
  };
  const labels = (meta("intranet:tags") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((s) => s.length >= 2 && s.length <= 40)
    .filter((s, i, a) => a.indexOf(s) === i)
    .slice(0, 8);
  const raw = meta("intranet:summary");
  const summary = raw ? decodeEntities(raw).slice(0, 500) : null;
  return { labels, summary };
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
