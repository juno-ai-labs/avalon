/**
 * The columns `packages/db/migrations/0114_link_payloads.sql` declares, for the
 * runtime suite's schemaless D1.
 *
 * Every test that creates a scoped invitation mints a link token, and the token
 * is a row: a suite that creates one without this table fails inside the
 * creation path rather than at the behaviour it is testing. One copy, because a
 * declaration this shared drifts from the migration one file at a time.
 */
export const LINK_PAYLOADS_TABLE = `CREATE TABLE link_payloads (
  token_hash TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT NOT NULL,
  created_at TEXT NOT NULL, expires_at TEXT)`;
