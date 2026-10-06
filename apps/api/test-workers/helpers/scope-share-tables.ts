/**
 * The D1 tables creating a scoped share touches, for the runtime suite's
 * schemaless D1: the lookup row `packages/db/migrations/0119_scope_share_recipients.sql`
 * declares, and the verified-address table the share reads to claim for a
 * recipient who already has an account.
 *
 * A suite that creates a share without them fails inside the creation path
 * rather than at the behaviour it is testing. One copy, because a declaration
 * this shared drifts from the migration one file at a time. `IF NOT EXISTS`
 * so a suite that declares a fuller `user_verified_emails` of its own keeps it.
 */
export const SCOPE_SHARE_TABLES = [
  `CREATE TABLE IF NOT EXISTS scope_share_recipients (
    email TEXT NOT NULL COLLATE NOCASE, workspace_id TEXT NOT NULL, parent_id TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (email, workspace_id, parent_id))`,
  "CREATE TABLE IF NOT EXISTS user_verified_emails (email TEXT PRIMARY KEY COLLATE NOCASE, user_id TEXT)",
];
