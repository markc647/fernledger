# Expand-then-contract database migrations

Every release's migrations are additive only: new tables, new nullable columns, new indexes. Dropping or renaming anything happens in a *later* release, once no released code still uses it. Self-hosters roll back by redeploying the previous release. That works only if the previous code can still run against the newer schema, and D1 restore points last only 7 days on the free plan, so they're no substitute.

## Consequences

- A rename takes two releases: add the new column and write to both, then stop using the old one and drop it later.
- CI applies every migration to sample databases taken from each earlier minor release and checks that every table, column and row survives. Running the previous release's own tests against the migrated schema is still to do: it needs a first release to run them from (docs/releasing.md).
- Large data backfills are chunked and resumable, to stay within D1 Free's 100k row writes per day (ADR 0004).
