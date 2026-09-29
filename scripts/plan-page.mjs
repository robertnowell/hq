#!/usr/bin/env node
// The plan, as a page, because a tracker only a terminal can read is a plan
// nobody outside the terminal has.
//
// Robert has asked twice where the issue tracker is: 11 Sep, "I can't even
// find the issue tracker for this, which is itself a problem", and again on
// 13 Sep, "I can't even see that in the hub right now". The tracker is Beads,
// its whole state is .beads/issues.jsonl in this repo, and `bd` reads it in a
// terminal. This writes the same thing as a page into the running agent's own
// directory, where the mirror picks it up like any other page and it appears
// in the hub within a minute.
//
//   node scripts/plan-page.mjs [--out <dir>]
//
// The agent directory is taken from HQ_AGENT_DIR, else the one this session
// was told to write to. Nothing here touches another agent's directory.
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const OUT = outFlag >= 0 ? args[outFlag + 1] : process.env.HQ_PLAN_OUT;
if (!OUT) {
  console.error("where to write it: --out <file>, or HQ_PLAN_OUT");
  process.exit(2);
}
// The session the page belongs to: HQ_PLAN_SESSION, else the agent
// directory the page is written into (agents/<session>/plan.html). Left
// blank, the page landed on whoever owns the directory, silently.
const SESSION = process.env.HQ_PLAN_SESSION
  ?? (process.argv.join(" ").match(/agents\/([0-9a-f-]{36})\//)?.[1] ?? "");

const bd = (...a) => JSON.parse(execFileSync("bd", [...a, "--json"], {
  cwd: new URL("..", import.meta.url).pathname, encoding: "utf8", maxBuffer: 32 << 20,
}));

const open = bd("list", "--status", "open");
const closed = bd("list", "--status", "closed");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// The WHY is the first sentence of the description, which is where this
// tracker puts it by convention. The rest is how, and the page is not the
// place for how.
const why = (d) => {
  const t = String(d ?? "").replace(/\s+/g, " ").trim();
  const m = t.match(/^WHY:\s*(.+?)(?:\s+HOW:|$)/) ?? [null, t];
  return (m[1] ?? "").slice(0, 240);
};
const P = (n) => `P${n}`;

const rows = (list) => list.map((i) => `
    <tr>
      <td class="id">${esc(i.id)}</td>
      <td class="p" data-p="${esc(P(i.priority))}">${esc(P(i.priority))}</td>
      <td>
        <span class="t">${esc(i.title)}</span>
        ${why(i.description) ? `<span class="w">${esc(why(i.description))}</span>` : ""}
      </td>
    </tr>`).join("");

const today = new Date().toISOString().slice(0, 10);
const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${SESSION ? `<meta name="intranet:session" content="${esc(SESSION)}">` : ""}
<meta name="intranet:summary" content="The Knowledge Base's own plan: what is open, what closed, and where the tracker actually lives.">
<meta name="intranet:tags" content="planning, hubs">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%231f4f8f' d='M2 2h12v2H2zm0 5h12v2H2zm0 5h8v2H2z'/%3E%3C/svg%3E">
<title>The plan, ${today}</title>
<style>
:root { --bg:#fcfbf8; --paper:#f4f2ec; --ink:#1f1e1c; --heading:#141312;
        --muted:#57534c; --faint:#6e6a63; --line:#ddd9cf; --accent:#1f4f8f;
        --amber:#a8762a; --green:#4a5a2b;
        --serif:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;
        --sans:ui-sans-serif,-apple-system,'Helvetica Neue',sans-serif;
        --mono:'Berkeley Mono',ui-monospace,SFMono-Regular,Menlo,monospace; }
@media (prefers-color-scheme: dark) {
  :root { --bg:#131310; --paper:#1c1b18; --ink:#eceae2; --heading:#f3f1e9;
          --muted:#a5a196; --faint:#77746c; --line:#33322d; } }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.6 var(--sans); }
.wrap { max-width:46rem; margin:0 auto; padding:3rem 1.25rem 5rem; }
.eyebrow { font:600 11px/1 var(--mono); letter-spacing:.16em; text-transform:uppercase;
           color:var(--faint); margin:0 0 1rem; }
h1 { font:400 2.1rem/1.15 var(--serif); color:var(--heading); margin:0 0 .7rem; }
.deck { font:400 1.1rem/1.5 var(--serif); color:var(--muted); margin:0 0 2rem; }
h2 { font:600 .72rem/1 var(--mono); letter-spacing:.15em; text-transform:uppercase;
     color:var(--faint); margin:2.6rem 0 .8rem; padding-bottom:.5rem;
     border-bottom:1px solid var(--line); }
p { margin:0 0 1rem; }
table { width:100%; border-collapse:collapse; margin:0 0 1.2rem; }
td { padding:.55rem .5rem; border-bottom:1px solid var(--line); vertical-align:top;
     font-size:.92rem; }
td.id { font:500 .78rem/1.6 var(--mono); color:var(--faint); white-space:nowrap; }
td.p { font:600 .72rem/1.6 var(--mono); white-space:nowrap; color:var(--faint); }
td.p[data-p="P0"], td.p[data-p="P1"] { color:var(--amber); }
.t { display:block; color:var(--heading); font-weight:600; }
.w { display:block; color:var(--muted); font-size:.85rem; margin-top:.15rem; }
.done td { opacity:.72; }
.done .t { font-weight:500; }
code { font:.88em var(--mono); background:var(--paper); border:1px solid var(--line);
       border-radius:5px; padding:.08em .35em; }
footer { margin-top:2.6rem; padding-top:1rem; border-top:1px solid var(--line);
         color:var(--faint); font-size:.85rem; }
</style>
</head>
<body>
<div class="wrap">
<p class="eyebrow">${today} · Tranquility Knowledge Base</p>
<h1>The plan</h1>
<p class="deck">Everything this hub is being built against, generated from the tracker
itself. ${open.length} open, ${closed.length} closed.</p>

<h2>Open</h2>
<table><tbody>${rows(open.sort((a, b) => a.priority - b.priority))}</tbody></table>

<h2>Closed</h2>
<table><tbody class="done">${rows(closed.sort((a, b) => a.priority - b.priority))}</tbody></table>

<h2>Where this actually lives</h2>
<p>The tracker is <strong>Beads</strong>. Its entire state is one file in the hub's own
repository, <code>.beads/issues.jsonl</code>, committed with the code it describes, so the
plan and the work move together and a branch carries its own version of both.</p>
<p>In a terminal: <code>bd list</code> for what is open, <code>bd show &lt;id&gt;</code> for
one item with its why, its dependencies and every comment. This page is
<code>node scripts/plan-page.mjs</code>, which reads the same tracker and writes what you
are reading, so it is never a second copy anybody has to remember to update.</p>
<p>The panel's own work is not here. It is tracked as pull requests in its repository,
which is a different answer to the same question and worth reconciling one day.</p>

<footer>Generated from the tracker at ${new Date().toISOString().replace("T", " ").slice(0, 16)}.</footer>
</div>
</body>
</html>
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, page);
console.log(`${open.length} open, ${closed.length} closed -> ${OUT}`);
