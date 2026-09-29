/**
 * GET /hq: the command-line client, from its one home.
 *
 * The client and the Claude Code plugin are published with the hub in the
 * public repository robertnowell/hq since 29 Sep 2026 (audit: hq-app is private, so the plugin's install line failed
 * for everyone else, and the client existed in three copies that had already
 * drifted). The hub keeps this address, which every install prompt uses, and
 * forwards it to the client pinned to a release tag, so a change to the
 * public main cannot reach people until it is tagged here.
 */
export const dynamic = "force-static";

const CLIENT_TAG = "plugin-v1.2.0";
const CLIENT = `https://raw.githubusercontent.com/robertnowell/hq/${CLIENT_TAG}/plugin/bin/hq`;

export function GET() {
  return Response.redirect(CLIENT, 302);
}
