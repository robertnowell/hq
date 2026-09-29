# Database

Postgres, one schema, row-level security forced on every tenant table. The
app connects as `hq_app`, which owns nothing and holds only the grants in
`000-grants.sql`; every cross-tenant read goes through a SECURITY DEFINER
function that exposes one narrow answer.

Apply, as the owner:

```
psql "$OWNER_URL" -c "create role hq_app login password '...'"
db/apply.sh "$OWNER_URL"            # schema.sql, then 0NN files in order, then 000-grants.sql, each once
db/apply.sh "$OWNER_URL" --status   # what is on this database
```

`schema.sql` is the 7 Sep base; the numbered files are the history since,
each safe to re-run. `018-sharing.sql` adds teams by domain, shares, reads,
and the document's visibility, labels and summary.

Rehearse a migration on a Neon branch of production before applying it:
create the branch, swap its endpoint host into the owner URL, apply, run the
drills against a dev server pointed at the branch's `hq_app` URL.
