#!/usr/bin/env bash
# After a Write or Edit: if the file is an HTML page under the pages root,
# push it to the hub and hand the agent its address. Anything else is not
# ours and we say nothing. Exit 0 always.
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
root="${HQ_PAGES_ROOT:-$HOME/.hq/pages}"
input="$(cat)"
read_field() { printf '%s' "$input" | python3 -c 'import sys,json
try:
    j=json.load(sys.stdin); v=j
    for k in sys.argv[1].split("."): v=v.get(k,{}) if isinstance(v,dict) else {}
    print(v if isinstance(v,str) else "")
except Exception: print("")' "$1"; }
file="$(read_field tool_input.file_path)"
# The page files under the Claude session that wrote it, so two sessions'
# weekly-status.html never become one document (audit, 28 Sep).
session="$(read_field session_id)"
case "$file" in
  "$root"/*.html) ;;
  *) exit 0 ;;
esac
[ -f "$file" ] || exit 0
out="$("$here/bin/hq" push "$file" ${session:+--session "claude-$session"} 2>&1)"; rc=$?
if [ $rc -eq 0 ]; then
  addr="$(printf '%s\n' "$out" | grep -m1 -E '^https?://')"
  msg="The page $(basename "$file") is in the hub at $addr (private to the person until shared). To share it, call hq_share with document_id = the last path segment of that address and to = a company domain or \"link\"."
else
  msg="The page $(basename "$file") was written but could not be pushed to the hub: $out. If it says the machine is not connected, call hq_connect and ask the person to approve this machine."
fi
python3 - "$msg" <<'PY'
import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": sys.argv[1]}}))
PY
exit 0
