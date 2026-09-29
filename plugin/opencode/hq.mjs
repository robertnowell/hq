// The Tranquility Knowledge Base for OpenCode: the same two hooks the Claude
// Code and Codex plugin runs, behind OpenCode's plugin interface.
//
//   once per session  the session-start hook's instruction (write pages to the
//                     pages root; they reach the hub) joins the system prompt
//   after each tool   the push hook runs; any page under the pages root that
//                     changed is pushed, and its address is appended to the
//                     tool's output so the agent can give it to the person
//
// Nothing is reimplemented here. Both hooks and bin/hq are the files beside
// this one, so the three harnesses cannot drift apart.
//
// Install (the hub's own tools come from the MCP server; see the README):
//   git clone https://github.com/robertnowell/hq ~/.hq/src
//   opencode.json: { "plugin": ["file://<home>/.hq/src/plugin/opencode/hq.mjs"] }
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Tools that can write a file. OpenCode's own names, lower case.
const WRITES = new Set(["write", "edit", "multiedit", "patch", "apply_patch", "bash"]);

// Run one hook with its JSON on stdin; return the context it asks to add, or "".
// A hook that fails or hangs costs nothing: it resolves "" either way.
function hook(script, input) {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(join(ROOT, "hooks", script), [], { stdio: ["pipe", "pipe", "ignore"] });
    const timer = setTimeout(() => child.kill(), 90_000);
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => { clearTimeout(timer); resolve(""); });
    child.on("close", () => {
      clearTimeout(timer);
      try { resolve(JSON.parse(out).hookSpecificOutput?.additionalContext || ""); }
      catch { resolve(""); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

// The pages root, as the hooks resolve it. OpenCode refuses (headless) or asks
// (interactive) before touching any folder outside the project, and the pages
// root always is one. This plugin allows that one folder and nothing else,
// and leaves a person's own "deny" alone. (OpenCode 1.18 does not consult the
// permission.ask hook, so the rule goes into the config instead.)
const PAGES = process.env.HQ_PAGES_ROOT || join(homedir(), ".hq", "pages");

function allowPages(config) {
  const p = config.permission;
  if (typeof p === "string") return;              // "allow" or "deny" for everything: theirs
  const perm = (config.permission = p ?? {});
  const ext = perm.external_directory;
  if (ext === "allow" || ext === "deny") return;
  perm.external_directory = { ...(typeof ext === "object" ? ext : { "*": ext ?? "ask" }), [`${PAGES}/*`]: "allow" };
}

export const HqPlugin = async () => {
  const intro = await hook("session-start.sh", { hook_event_name: "SessionStart" });
  return {
    config: async (config) => { allowPages(config); },
    "experimental.chat.system.transform": async (_input, output) => {
      if (intro) output.system.push(intro);
    },
    "tool.execute.after": async (input, output) => {
      if (!WRITES.has(String(input.tool).toLowerCase())) return;
      const said = await hook("push-page.sh", { session_id: input.sessionID, hook_event_name: "PostToolUse" });
      if (said) output.output = `${output.output ?? ""}\n\n${said}`;
    },
  };
};
