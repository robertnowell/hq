#!/usr/bin/env bash
# After a tool that can write a file: push every HTML page under the pages
# root that changed since the last push, and hand the agent the addresses.
#
# Claude Code writes pages with Write or Edit and says which file. Codex
# writes them with a shell command (a heredoc through `exec`) and says
# nothing about files, so matching on the tool's file_path found nothing
# there (29 Sep 2026). Looking at the folder instead works for any agent and
# any way of writing: a page is new or changed if it is newer than the
# marker this hook touches after each push. Exit 0 always.
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
root="${HQ_PAGES_ROOT:-$HOME/.hq/pages}"
[ -d "$root" ] || { cat >/dev/null; exit 0; }
input="$(cat)"
read_field() { printf '%s' "$input" | python3 -c 'import sys,json
try:
    j=json.load(sys.stdin); v=j
    for k in sys.argv[1].split("."): v=v.get(k,{}) if isinstance(v,dict) else {}
    print(v if isinstance(v,str) else "")
except Exception: print("")' "$1"; }
# The page files under the session that wrote it, so two sessions'
# weekly-status.html never become one document (audit, 28 Sep).
session="$(read_field session_id)"
event="$(read_field hook_event_name)"; event="${event:-PostToolUse}"

marker="$root/.hq-pushed"
[ -f "$marker" ] || { touch -t 197001010000 "$marker"; }
stamp="$root/.hq-pushing.$$"; touch "$stamp"
changed=$(find "$root" -maxdepth 1 -type f -name '*.html' -newer "$marker" ! -newer "$stamp" 2>/dev/null)
if [ -z "$changed" ]; then rm -f "$stamp"; exit 0; fi

msgs=""; ok=1
while IFS= read -r file; do
  [ -n "$file" ] || continue
  out="$("$here/bin/hq" push "$file" ${session:+--session "agent-$session"} 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then
    addr="$(printf '%s\n' "$out" | grep -m1 -E '^https?://')"
    msgs="$msgs The page $(basename "$file") is in the hub at $addr (private until shared)."
  else
    ok=0
    msgs="$msgs The page $(basename "$file") was written but could not be pushed to the hub: $out."
  fi
done <<EOF
$changed
EOF
# Only move the marker when every push landed, so a failure is retried.
[ $ok = 1 ] && mv -f "$stamp" "$marker" || rm -f "$stamp"
msgs="$msgs Give the person the address. The page stays private: share it only if they ask, and only with whom they name (their company's domain, or \"link\" for anyone with the address), by calling hq_share with document_id = the last path segment of the address. If a push says the machine is not connected, call hq_connect and ask the person to approve this machine."
python3 - "$msgs" "$event" <<'PY'
import json, sys
print(json.dumps({"hookSpecificOutput": {"hookEventName": sys.argv[2], "additionalContext": sys.argv[1].strip()}}))
PY
exit 0
