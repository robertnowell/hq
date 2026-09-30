---
name: share-as-page
description: Turn a finding, report, comparison, plan or recommendation into one self-contained HTML page in the Knowledge Base, where it can be shared with the person's company or by link. Use it whenever the deliverable is something a person will read rather than run.
---

# share-as-page

A page, not a wall of terminal text. One file, self-contained (inline CSS, no
external assets), written to the pages root, where the plugin's hook pushes
it to the hub and hands you its address.

## Where

`${HQ_PAGES_ROOT:-$HOME/.hq/pages}/<slug>.html`. The slug is two to five
lowercase words joined by hyphens that name the subject, never the date and
never "report". Create the directory if it is missing.

## The shape

Copy `${CLAUDE_PLUGIN_ROOT}/skills/share-as-page/templates/brief.html` and
fill it. Keep its `<style>` exactly as it is: the type, sizes, colours and
spacing are the house design, and a page that restyles them no longer looks
like the others in the hub. Fill the placeholders, delete the artifact kinds
you do not use, and remove every placeholder comment. Three levels, far apart:

1. **The message.** A headline of three to six words that IS the conclusion
   ("Two chips moved."); the template sets it at seven times body size. The
   `<title>` says the same. Then a lede whose first sentence, in bold, is the
   one-sentence claim with a verb, and the dark block: what needs the
   reader, or that nothing does. If there is a decision, its options go
   there, the recommendation first. The kicker is two items: subject and date.
2. **The claims.** One row per claim, a full sentence with a verb, with a
   status dot and one figure. Reading only the rows gives the argument.
3. **The evidence.** Under each claim, open: the artifact itself. A claim
   about a screen carries a screenshot of it; about data, the rows; about
   code, the diff hunk; about what someone said, the quote with speaker and
   date. Prose about the evidence is not evidence.

Rules: no paragraph over 80 words; every number has a source; nothing
external is loaded (images inline as data URIs). Put a one-sentence summary
in `<meta name="intranet:summary">` and two to four lowercase kebab-case
tags in `<meta name="intranet:tags">`: the hub files and finds pages by them.

## After writing

The PostToolUse hook pushes the file and tells you the address. Tell the
person the address. The page is private. Share it only if they ask, and
only with whom they name: call `hq_share` with the document id (the last segment of the address) and `to`: their company
domain, `link`, or `private`. If the hook says the machine is not
connected, call `hq_connect`, show the person the phrase, and wait for
them to approve.
