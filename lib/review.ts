/**
 * One quick read before a page goes public. An occasional double check.
 *
 * This has been narrowed twice by the person it is for, and both times in the
 * same direction. First it was a list of client names kept in the app, which
 * refused to publish anything that matched: a config list that goes stale in
 * a drawer, blocking on a guess. Then it was that list's replacement plus a
 * pattern sweep for keys, emails, paths and phone numbers, which Robert cut on
 * 13 Sep: "I really don't want to do a deterministic pattern pass. Just do a
 * quick LLM pass. Be like, hey, are there any risks of publishing this."
 *
 * So: one call, a fast model, one question. It answers yes or no, and when it
 * says yes it says why in a sentence or two. The person decides. Nothing here
 * refuses, nothing here blocks, and a page that comes back clean publishes on
 * the press that asked.
 *
 * It is deliberately lenient. The cost of a flag on an ordinary page is a
 * second press and a moment of doubt about whether the check is worth having;
 * the cost of missing something is one page. Tuning lives in PROMPT, which is
 * the only thing to change when it cries wolf.
 */

export type Review = {
  /** Whether the model thinks this is worth a second look. */
  risky: boolean;
  /** Why, in the model's own words. Empty when it is not risky. */
  risks: string[];
  /** Whether the check actually ran. */
  read: boolean;
  /** Why it did not, when it did not. */
  note?: string;
};

/** Fast, cheap, and good enough to notice a password in a paragraph. */
const MODEL = "claude-haiku-4-5-20251001";

const PROMPT = `You are the last look at a page before its author publishes it on their personal website, in public.

They are a founder and engineer who publishes research notes, technical writing and working notes. Publishing is the normal case and you should expect to say no.

Answer this: is there anything in this page that is private and should not be on the open web?

Say yes only for things like: credentials or keys; somebody's personal contact details; a client or employer's confidential business, named and identifiable; private financial numbers; plans, deals or dates that are clearly unannounced.

Say no for everything else, including: the author's own opinions and mistakes, their own products and projects, open source, published research, technical detail, code, architecture, benchmarks, and writing about companies from public information.

Reply with JSON only:
{"risky": false, "risks": []}
or
{"risky": true, "risks": ["one plain sentence naming what you saw, quoting at most a few words"]}

At most three risks. If you are hesitating, the answer is no.`;

/** The page as a reader sees it: no markup, no style, no script. */
export function readableText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Ask once, quickly. Never refuses, never blocks, and never pretends: a check
 * that could not run says so instead of coming back clean.
 */
export async function reviewForPublishing(title: string, html: string): Promise<Review> {
  const key = process.env.HQ_ANTHROPIC_API_KEY?.trim();
  if (!key) return { risky: false, risks: [], read: false, note: "no model key is configured" };
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: PROMPT,
        messages: [{
          role: "user",
          content: `Title: ${title}\n\n${readableText(html).slice(0, 24000)}`,
        }],
      }),
      // A slow check must not hold up a click. Twelve seconds is well past
      // this model's answer and well short of a person wondering.
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return { risky: false, risks: [], read: false, note: `the check answered HTTP ${r.status}` };
    const j = await r.json();
    const out = (j?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) return { risky: false, risks: [], read: true };
    const parsed = JSON.parse(m[0]) as { risky?: boolean; risks?: unknown[] };
    const risks = (parsed.risks ?? [])
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .slice(0, 3)
      .map((s) => s.slice(0, 240));
    // "risky with nothing to say" is not an answer a person can act on.
    return { risky: !!parsed.risky && risks.length > 0, risks, read: true };
  } catch (e) {
    return { risky: false, risks: [], read: false, note: `the check could not run (${(e as Error).message})` };
  }
}
