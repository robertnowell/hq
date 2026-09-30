#!/usr/bin/env bash
# Tells the agent, once per session, that pages go to the hub and how.
# Exit 0 always: a hook that fails must never cost the person their session.
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
# On a machine that runs Tranquility Base, its own session context already
# says where pages go (~/Documents/agents/<session>/) and mirrors them; two
# instructions and two skills named share-as-page would only compete.
if command -v hq-page >/dev/null 2>&1 || [ -d "/Applications/Tranquility Base.app" ]; then exit 0; fi
root="${HQ_PAGES_ROOT:-$HOME/.hq/pages}"
status="$("$here/bin/hq" status 2>/dev/null || true)"
case "$status" in
  connected*) conn="This machine is connected to the hub ($status)." ;;
  *)          conn="This machine is NOT connected to the hub yet. The first time a page should be shared, call the hq_connect tool (or run \`hq connect\`), show the person the phrase it returns, and ask them to approve this machine at the address it gives." ;;
esac
ctx="Tranquility Knowledge Base plugin. When a task ends in a report, a finding, a comparison, a plan, or anything a person will read rather than run or will pass on to someone else (even when it is short), write it as ONE self-contained HTML page into $root/<slug>.html, with the share-as-page skill (hq:share-as-page) where your harness has it. In the page's head put a one-sentence <meta name=\"intranet:summary\"> and two to four lowercase kebab-case topic tags in <meta name=\"intranet:tags\">. Do not write a page for a quick answer to the person's own question or for a code change: answer those in chat. A page written there is pushed to the hub automatically and its address is returned to you; give the person that address. Pages stay private. Share one only when the person asks, and only with whom they name, by calling hq_share with the document id (to = their company's domain, or link). To find or read pages already in the hub, or to see what other agents are doing, call hq_find, hq_page and hq_ask. $conn"
python3 - "$ctx" <<'PY'
import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": sys.argv[1]}}))
PY
exit 0
