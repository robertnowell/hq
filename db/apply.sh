#!/usr/bin/env bash
# Apply the schema and every numbered migration, once each, as the owner.
#
#   db/apply.sh "$OWNER_URL"            apply what is missing
#   db/apply.sh "$OWNER_URL" --status   show what is on this database
#
# schema_migrations records each file applied, so "is 018 on production yet"
# has an answer and a re-run is a no-op. Order: schema.sql, then 0NN files by
# number, then 000-grants.sql LAST, because it grants on tables the later
# files create. The hq_app role must exist before the grants (see README).
set -euo pipefail
url="${1:?owner database url}"; shift || true
here="$(cd "$(dirname "$0")" && pwd)"
psql "$url" -q -v ON_ERROR_STOP=1 -c "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())"
applied() { psql "$url" -At -c "select 1 from schema_migrations where name = '$1'" | grep -q 1; }
if [ "${1:-}" = "--status" ]; then psql "$url" -At -c "select name, applied_at from schema_migrations order by applied_at"; exit 0; fi
run() {
  local f="$1" name; name="$(basename "$f")"
  if applied "$name"; then echo "  = $name"; return; fi
  echo "  + $name"
  psql "$url" -q -v ON_ERROR_STOP=1 -f "$f"
  psql "$url" -q -c "insert into schema_migrations (name) values ('$name') on conflict do nothing"
}
run "$here/schema.sql"
for f in $(ls "$here"/0[0-9][0-9]-*.sql | grep -v "/000-" | sort); do run "$f"; done
run "$here/000-grants.sql"
echo "done"
