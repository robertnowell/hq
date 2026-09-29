/**
 * Sibling links in an archive page, pointed at the hub.
 *
 * Lives here rather than beside the route that uses it because a Next route
 * module may export only Next's own fields: exporting this from
 * app/d/[id]/route.ts compiled clean under tsc and failed the production
 * build with "hubLinks is not a valid Route export field". A pure function
 * that wants a test belongs in lib anyway.
 *
 * An agent writes the archive as it sits on disk, so a reference to the page
 * next door is `href="other-report.html"` and a reference to another agent's
 * is the `file:///Users/.../Documents/agents/<session>/page.html` the local
 * hub uses. Both are correct on the Mac that wrote them and both are dead in
 * a browser: the relative one resolves under /d/, and a file: link from an
 * https page is refused by the browser without saying so.
 *
 * So they are rewritten here, at serve time, rather than asked of every
 * page-writing skill -- 40-odd pages already in the archive carry the old
 * shape and cannot be re-written, and the next agent to write one will not
 * have read the rule either. /open?session=&slug= is the address that does
 * not need to know the ids the hub minted on arrival.
 */
export function hubLinks(html: string, session: string): string {
  const open = (s: string, slug: string, hash: string) =>
    slug === "index"
      ? `/open?session=${encodeURIComponent(s)}${hash}`
      : `/open?session=${encodeURIComponent(s)}&slug=${encodeURIComponent(slug)}${hash}`;

  // The archive's own shape: file:///…/Documents/agents/<session>/<path>.html
  // The session in the path wins -- it may well be another agent's page.
  html = html.replace(
    /(["'])file:\/\/\/[^"']*?\/Documents\/agents\/([0-9a-fA-F-]{8,36})\/([^"'#?]+?)\.html(#[^"']*)?\1/g,
    (_m, q, s, path, hash) => q + open(s, fold(path), hash ?? "") + q,
  );

  // A sibling by bare filename, with any of the app's own routes and every
  // absolute form left alone.
  html = html.replace(
    // Any scheme at all is somebody else's address -- not just the handful
    // worth naming. `tranquilitybase://discuss/x.html` is a deep link, not a
    // sibling, and a list of known schemes would have rewritten the next one
    // nobody thought of.
    /(href=")(?![a-z][a-z0-9+.\-]*:|#|\/)([^"#?]+?)\.html(#[^"]*)?"/gi,
    (_m, head, path, hash) => head + open(session, fold(path), hash ?? "") + '"',
  );
  return html;
}

/** The mirror's slug rule, pinned: path under the agent directory, slashes folded. */
const fold = (path: string) =>
  path.replace(/^\.\//, "").replace(/\//g, "-");

/**
 * Where a link goes when it is followed from inside the frame.
 *
 * The document is an iframe with an opaque origin. A plain `<a href>` in it
 * navigates the FRAME, and most of the web refuses to be framed: github.com
 * answered "refused to connect" inside the hub (Robert, 16 Sep). Nothing in
 * the page is wrong; the frame is the wrong place for it to open.
 *
 * So one delegated click handler, injected at serve time like the sibling
 * rewrite above: a link to another site opens a new tab (the sandbox allows
 * popups that escape it), a link to the hub's own routes navigates the top
 * window (allowed on a user gesture), and everything else -- an in-page
 * anchor, a link with its own target, a modified click -- is left alone.
 */
export function linkTargets(html: string): string {
  const script = `<script>(function(){document.addEventListener("click",function(e){` +
    `if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;` +
    `var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a||a.target)return;` +
    `var u;try{u=new URL(a.getAttribute("href"),location.href)}catch(x){return}` +
    `if(u.protocol!=="http:"&&u.protocol!=="https:")return;` +
    `if(u.origin===location.origin&&(u.pathname===location.pathname||u.pathname==="/open"||u.pathname.indexOf("/d/")===0)){` +
    `if(u.pathname===location.pathname)return;a.target="_top";return}` +
    `a.target="_blank";a.rel="noopener"},true)})()</script>`;
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, script + "</body>") : html + script;
}
