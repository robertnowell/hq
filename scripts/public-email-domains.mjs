#!/usr/bin/env node
// Regenerate lib/public-email-domains.ts from the community list.
//
//   node scripts/public-email-domains.mjs
//
// Nobody publishes a canonical list of public email providers; this is the
// widely used gist (ammarshah/f5c2624d, ~6,100 domains) plus a handful the
// gist lacks. The output is a TypeScript module so it ships inside the bundle
// and needs no file read at request time.
import { writeFileSync } from "fs";
const SRC = "https://gist.githubusercontent.com/ammarshah/f5c2624d767f91a7cbdc4e54db8dd0bf/raw/660fd949eba09c0b86574d9d3aa0f2137161fc7c/all_email_provider_domains.txt";
const EXTRA = "proton.me pm.me hey.com duck.com mail.com posteo.de tutanota.com tuta.com tuta.io skiff.com onmail.com yandex.ru icloud.com me.com mac.com googlemail.com live.com msn.com hotmail.co.uk outlook.co.uk btinternet.com comcast.net att.net verizon.net sbcglobal.net cox.net zoho.com zohomail.com fastmail.fm".split(" ");
const text = await (await fetch(SRC)).text();
const doms = new Set(EXTRA);
for (const l of text.split("\n")) { const d = l.trim().toLowerCase(); if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) doms.add(d); }
const out = [...doms].sort();
const body = `// Public email providers: an address here belongs to a person, not an organisation.
// Vendored ${new Date().toISOString().slice(0, 10)} from the community list (gist ammarshah/f5c2624d, ${out.length - EXTRA.length} domains)
// plus ${EXTRA.length} additions (proton.me, hey.com, duck.com, tuta.com and the like).
// Nobody publishes a canonical list; Clerk refuses these for verified domains too.
// Regenerate: node scripts/public-email-domains.mjs
const LIST = \`
${out.join("\n")}
\`;
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set(LIST.split("\\n").map((s) => s.trim()).filter(Boolean));
`;
writeFileSync(new URL("../lib/public-email-domains.ts", import.meta.url), body);
console.log(`${out.length} domains written`);
