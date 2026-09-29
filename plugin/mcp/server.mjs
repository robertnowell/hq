#!/usr/bin/env node
// The hub's tools for an agent, as an MCP server over stdio.
//
// Every tool calls ../bin/hq, the one client: the same token lookup, the
// same pairing phrase, the same push and share the hook and a person's
// terminal use. Nothing here talks to the hub on its own, so the three can
// never drift apart again (audit, 28 Sep 2026: they had, the same day).
//
//   hq_status   is this machine connected, and to where
//   hq_connect  begin pairing: returns the phrase and the address to approve at
//   hq_push     put one HTML file in the hub; returns its address and id
//   hq_share    who can read a page: a company domain, "link", or "private"
//   hq_find     search every page and turn in the account
//   hq_page     one page, as text
//   hq_ask      what every agent in the account is working on
import { execFile, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HQ = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "hq");
const VERSION = "1.3.0";

const hq = (args, timeout = 90_000) => new Promise((resolve, reject) => {
  execFile(HQ, args, { timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
    if (err) reject(new Error((stderr || stdout || err.message).trim()));
    else resolve(stdout.trim());
  });
});
const json = (s) => { try { return JSON.parse(s); } catch { return s; } };

// Pairing runs `hq connect --json` in the background: its first line is the
// phrase and the address, and it keeps polling until the person approves.
let pairing = null;
function connect() {
  return new Promise((resolve) => {
    if (pairing?.first) return resolve({ ...pairing.first, note: "Already asking. Approve it at the address, then call hq_status." });
    const child = spawn(HQ, ["connect", "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    pairing = { child, first: null };
    const rl = createInterface({ input: child.stdout });
    rl.once("line", (line) => {
      const first = json(line);
      pairing.first = first;
      resolve({ connected: false, ...first,
        note: `Show the person the phrase ${first.phrase} and ask them to open ${first.approve_at} (it may already be open) and press Connect if the hub shows the same phrase. Then call hq_status.` });
    });
    child.on("exit", () => { pairing = null; });
    child.on("error", (e) => { pairing = null; resolve({ connected: false, error: e.message }); });
  });
}

const tools = [
  { name: "hq_status", description: "Is this machine connected to the Knowledge Base, and to which hub.",
    inputSchema: { type: "object", properties: {} },
    run: async () => {
      const out = await hq(["status"]).catch((e) => e.message);
      return { connected: out.startsWith("connected"), status: out, pending_pairing: pairing?.first ?? null };
    } },
  { name: "hq_connect", description: "Begin connecting this machine to the Knowledge Base. Returns a phrase like ABC-123 and the address where the person approves it; show them both. Then call hq_status until connected.",
    inputSchema: { type: "object", properties: {} }, run: connect },
  { name: "hq_push", description: "Put one self-contained HTML file in the Knowledge Base. Returns its address and document id. Optionally share it at once with `to`: a company domain, \"link\", or \"private\".",
    inputSchema: { type: "object", properties: { file: { type: "string", description: "Absolute path to the .html file" }, title: { type: "string" }, slug: { type: "string" }, to: { type: "string", description: "company.com, \"link\", or \"private\"" } }, required: ["file"] },
    run: async ({ file, title, slug, to }) => json(await hq(["push", file, ...(to ? ["--to", to] : []), ...(title ? ["--title", title] : []), ...(slug ? ["--slug", slug] : []), "--json"])) },
  { name: "hq_share", description: "Decide who can read a page: everyone who signs in at a company domain, anyone with the link, or only the owner. Returns the address to send.",
    inputSchema: { type: "object", properties: { document_id: { type: "string" }, to: { type: "string", description: "company.com, \"link\", or \"private\"" } }, required: ["document_id", "to"] },
    run: async ({ document_id, to }) => json(await hq(["share", document_id, to, "--json"])) },
  { name: "hq_find", description: "Search every page and turn in this account.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer" } }, required: ["query"] },
    run: async ({ query, limit = 10 }) => json(await hq(["find", query, String(limit)])) },
  { name: "hq_page", description: "One page from the hub, as text, by its agent's session id and slug.",
    inputSchema: { type: "object", properties: { session: { type: "string" }, slug: { type: "string" } }, required: ["session", "slug"] },
    run: async ({ session, slug }) => json(await hq(["page", session, slug])) },
  { name: "hq_ask", description: "What every agent in this account is working on, and what each last said.",
    inputSchema: { type: "object", properties: { active: { type: "string", description: "window such as 7d" }, limit: { type: "integer" } } },
    run: async ({ active = "7d", limit = 10 } = {}) => json(await hq(["ask", active, String(limit)])) },
];

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
createInterface({ input: process.stdin }).on("line", async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === "initialize") return send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "hq", version: VERSION } } });
  if (method?.startsWith("notifications/")) return;
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: tools.map(({ run, ...t }) => t) } });
  if (method === "tools/call") {
    const t = tools.find((x) => x.name === params?.name);
    if (!t) return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such tool: ${params?.name}` } });
    try {
      const out = await t.run(params?.arguments ?? {});
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }], isError: false } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true } });
    }
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
});
