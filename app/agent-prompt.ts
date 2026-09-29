/**
 * The prompt a person hands their own coding agent to put a page here. One
 * text, shown on the empty hub, on Shared with you, and on /start, so the
 * words never drift between doors. The company is filled in when the person
 * signed in with a work address.
 */
export const HUB = "https://hq.tranquilitybase.dev";

export function agentPrompt(domain: string | null): string {
  const to = domain ?? "link";
  const toLine = domain
    ? `--to ${domain} shares it with everyone who signs in at @${domain}; --to link shares it with anyone who has the link; no --to keeps it private.`
    : "--to link shares it with anyone who has the link; --to yourcompany.com shares it with everyone at that domain; no --to keeps it private.";
  return `Put this page on my Tranquility Base hub and share it with my team.

1. Install the hub client if \`hq\` is not on the PATH:
   mkdir -p ~/.local/bin && curl -fsSL ${HUB}/hq -o ~/.local/bin/hq && chmod +x ~/.local/bin/hq
   Add ~/.local/bin to the PATH if it is not there.
2. If \`hq status\` says this machine is not connected, run \`hq connect\`. It prints a six-character phrase and opens ${HUB}/connect; show me the phrase so I can approve this machine there, and wait for it to say Connected.
3. Push the page, one self-contained HTML file:
   hq push <file.html> --to ${to}
   ${toLine}
4. Tell me the address it prints.`;
}

/** The plugin, for Claude Code: two lines in the terminal, then the hooks and the MCP server do the rest. */
export const PLUGIN_INSTALL = `claude plugin marketplace add robertnowell/hq
claude plugin install hq@tranquility`;
