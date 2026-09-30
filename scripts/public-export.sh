#!/usr/bin/env bash
# Build the public tree of this repository and refuse to publish it if it
# carries a secret or a name that must stay private.
#
#   scripts/public-export.sh <out-dir> [ref]
#
# The public repository (robertnowell/hq) never receives this repository's
# history, branches or pull requests: those name clients and people, and a
# history cannot be unpublished. It receives one snapshot per main, built
# here: `git archive` of the ref, minus the paths below, then two checks.
# Exit 0 only when both pass; the workflow pushes nothing otherwise.
set -euo pipefail
out=${1:?out dir}; ref=${2:-HEAD}
root=$(git rev-parse --show-toplevel)
rm -rf "$out"; mkdir -p "$out"
git -C "$root" archive "$ref" | tar -x -C "$out"

# Private-only paths: the tracker (it names people), this check's own list,
# the design of record (market positioning and pricing), the workflow that
# publishes from here, local scratch.
rm -rf "$out/.beads" "$out/.private" "$out/.pw" "$out/docs/documents-layer.md"
# The template sync reads the private tranquility-base repository, and the
# names it scrubs are exactly the ones this check refuses.
rm -f "$out/scripts/sync-page-template.sh"
# The private workflows need secrets and this list; the public repository
# gets its own CI instead.
rm -rf "$out/.github"; mkdir -p "$out/.github/workflows"
cp "$root/.github/public/ci.yml" "$out/.github/workflows/ci.yml"

# 1. Secrets, by gitleaks, over the files as they will be published.
gitleaks dir "$out" --no-banner --redact --exit-code 1 >/dev/null 2>&1 || {
  echo "public-export: gitleaks found a secret; nothing published" >&2
  gitleaks dir "$out" --no-banner --redact 2>&1 | tail -20 >&2; exit 1; }

# 2. Names and infrastructure that must stay private.
deny="$root/.private/public-denylist.txt"
[ -f "$deny" ] || { echo "public-export: $deny is missing" >&2; exit 1; }
terms=$(grep -v '^#' "$deny" | grep -v '^\s*$' || true)
hits=$(printf '%s\n' "$terms" | grep -rniF -f - "$out" --exclude=package-lock.json --exclude=public-email-domains.ts || true)
if [ -n "$hits" ]; then
  echo "public-export: private names in the public tree; nothing published" >&2
  printf '%s\n' "$hits" | cut -c1-200 | head -40 >&2; exit 1
fi
echo "public-export: $(find "$out" -type f | wc -l | tr -d ' ') files, no secrets, no private names"
