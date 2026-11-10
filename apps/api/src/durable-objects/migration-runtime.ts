import type { Env } from "../env";
import { inDurableObjectPhase } from "../observability/tracing";

export interface MigrationContext {
  state: DurableObjectState;
  env: Env;
  /** The migration runner's component key for this class. */
  component: string;
  /** The class name as bound in the regional Wrangler file. */
  className: string;
  /** The highest version the running build ships for this component. */
  latestVersion: number;
}

export interface ForcedMigrationOutcome {
  objectId: string;
  objectName: string | null;
  component: string;
  className: string;
  /** The version the object is on now that its constructor's pass has finished. */
  schemaVersion: number;
  /** The highest version the running build ships, so a shortfall is visible. */
  latestVersion: number;
}

export async function applyMigrationPlan<T>(context: MigrationContext, apply: () => T): Promise<T> {
  return inDurableObjectPhase(context.env, "schema_migrate", {
    component: context.component,
    className: context.className,
    latestVersion: context.latestVersion,
  }, async () => apply());
}

export async function forcedMigrationOutcome(context: MigrationContext, objectName: string | null): Promise<ForcedMigrationOutcome> {
  const row = context.state.storage.sql.exec<{ version: number | null }>(
    "SELECT MAX(version) AS version FROM _sql_schema_migrations",
  ).toArray()[0];
  return {
    objectId: context.state.id.toString(), objectName,
    component: context.component, className: context.className,
    schemaVersion: row?.version ?? 0, latestVersion: context.latestVersion,
  };
}

export function latestMigrationVersion(migrations: readonly { version: number }[]): number {
  return migrations.at(-1)?.version ?? 0;
}
