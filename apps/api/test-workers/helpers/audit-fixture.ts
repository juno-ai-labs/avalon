/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";

import auditMigration from "../../../../packages/db/audit-migrations/0001_initial.sql?raw";

/**
 * Install the canonical audit schema without assuming `reset()` cleared the
 * separate AUDIT_DB binding. Workerd files share that binding while Vitest
 * runs them concurrently, so every fixture must converge on one schema rather
 * than racing to create a private approximation of it.
 */
export async function ensureAuditSchema(): Promise<void> {
  await env.AUDIT_DB.batch(auditMigration.split(";").filter((sql) => sql.trim()).map((sql) => (
    env.AUDIT_DB.prepare(sql.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
      .replace("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS "))
  )));
}
