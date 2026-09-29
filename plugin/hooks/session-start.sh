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
ctx="Tranquility Knowledge Base plugin. When a task ends in a report, a finding, a comparison, a plan, or anything a person will read rather than run, write it as ONE self-contained HTML page with the share-as-page skill (hq:share-as-page) into $root/<slug>.html. A page written there is pushed to the hub automatically and its address is returned to you; give the person that address. To share it with everyone at their company or with anyone by link, call hq_share with the document id. To find or read pages already in the hub, or to see what other agents are doing, call hq_find, hq_page and hq_ask. $conn"
python3 - "$ctx" <<'PY'
import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": sys.argv[1]}}))
PY
exit 0
