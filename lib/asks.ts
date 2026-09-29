/**
 * What a page asks of its reader, from its own "Needs you" block.
 *
 * Ruled 28 Sep 2026 (team hub epic, hq-app-cll.8): "needs you" had two
 * definitions -- read-but-not-cleared on the sidebar count, the newest turn's
 * question on the agent page -- and the amber lamp that showed the first was
 * removed because nobody could say what it meant. It is now one fact about a
 * document, stored at ingest: the sentence in the page's dark block, or null
 * when the page says it needs nothing.
 *
 * Every report template since 25 Sep writes the block the same way:
 *   <div class="you"><div class="k">Needs you · two decisions</div>
 *   <p>The decision, as one sentence.</p>
 * A kicker that says "nothing" is a page that asks nothing. A page without
 * the block (older pages, pages from other tools) asks nothing either.
 */
export function pageAsks(html: string): string | null {
  const block = html.match(/<div\s+class=["']you["'][^>]*>([\s\S]{0,4000}?)<\/div>\s*(?:<p[^>]*>([\s\S]{0,2000}?)<\/p>)?/i);
  if (!block) return null;
  const kicker = text(block[1]);
  if (!/needs you/i.test(kicker)) return null;
  if (/nothing/i.test(kicker)) return null;
  const sentence = text(block[2] ?? "");
  return sentence ? sentence.slice(0, 300) : kicker.replace(/^.*?needs you\s*[·:-]?\s*/i, "").slice(0, 300) || null;
}

function text(s: string): string {
  return s.replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&middot;/g, "·").replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\s+/g, " ").trim();
}
