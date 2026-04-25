# Postgres migrations

Each file applies once, in numeric order. The migrator records applied
versions in `<prefix>schema_version` and skips files whose version is
already present.

**Rules:**

- File names use the pattern `NNN_description.sql` where `NNN` is a
  zero-padded integer. `001` is reserved for the initial schema.
- Never edit a migration after it has been applied to a real database.
  If you need to change something, write a new migration that runs ALTER
  statements on top of the earlier one.
- Keep each migration idempotent on the SQL side where reasonable
  (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`). The
  migrator's per-version gate will keep re-runs from happening, but
  belt-and-braces means a partial failure in the middle of a transaction
  leaves nothing half-applied.
- Runtime prefix substitution: the migrator replaces every occurrence of
  `mx_` in the SQL text with the configured `MX_DB_PREFIX` before
  executing. If you want to reference a collection outside the prefixed
  namespace (rare), escape by inlining the name via `pg_catalog.` or a
  schema qualifier.
