/**
 * `avalon-migration-tracker` — the Worker behind
 * `migrations.internal.with-avalon.com`.
 *
 * It has three entry points and they are deliberately different in kind:
 *
 * - the **default fetch handler** serves the operator site, and every request
 *   to it is verified against Cloudflare Access;
 * - **`MigrationReportBridge`** takes migration reports from the API Workers. It
 *   is a Worker RPC entrypoint rather than an HTTP route so it has no public
 *   address: it is reachable over a service binding and by nothing else, which
 *   is a stronger statement than any shared secret on a public path would be;
 * - the **scheduled handler** runs the hourly inventory sweep.
 *
 * `docs/durable-object-migration-tracking.md` owns the design.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  DurableObjectMigrationReportSchema,
  type DurableObjectMigrationReport,
  type DurableObjectMigrationTracker,
} from "@avalon/contracts/durable-object-migrations";
import { app, registry } from "./app";
import type { Env } from "./env";
import { sweepInventory } from "./inventory";
import { logEvent } from "./logger";

export { MigrationRegistry } from "./registry";

/**
 * The ingress for `apps/api`.
 *
 * The report is parsed here even though the producer parsed it before sending.
 * The producer's parse protects the tracker from a malformed report; this one
 * protects the registry from a producer that was changed without this contract
 * being changed with it, and it is the boundary that enforces the opaque-name
 * rule for a region that is not this Worker's own.
 */
export class MigrationReportBridge
  extends WorkerEntrypoint<Env>
  implements DurableObjectMigrationTracker {
  async report(input: DurableObjectMigrationReport): Promise<void> {
    const parsed = DurableObjectMigrationReportSchema.safeParse(input);
    if (!parsed.success) {
      logEvent("warn", "migration_report_rejected", {
        message: "migration_report_rejected the report did not match the contract",
        issues: parsed.error.issues.map((issue) => issue.path.map(String).join(".") || "(root)"),
      });
      // Thrown rather than swallowed: the caller treats a rejection as a
      // delivery failure and retries on its next wake, and the reporter never
      // records an unaccepted report as delivered.
      throw new Error("migration_report_rejected");
    }

    const report = parsed.data;
    await registry(this.env).recordReport(report);
    logEvent(report.status === "failed" ? "error" : "info", "migration_report_recorded", {
      message: `migration_report_recorded ${report.component} ${report.status}`
        + ` v${report.schemaVersion}/v${report.latestVersion}`,
      object_id: report.objectId,
      object_name: report.objectName,
      class_name: report.className,
      component: report.component,
      region: report.region,
      app_env: report.appEnv,
      status: report.status,
      schema_version: report.schemaVersion,
      latest_version: report.latestVersion,
      applied_versions: report.appliedVersions,
      failure_message: report.failure?.message ?? null,
      worker_version_id: report.workerVersionId,
    });
  }
}

/**
 * Enumerate the account and fold the result into the registry.
 *
 * Exported so the suite can drive it, and so a future operator route can run it
 * on demand without duplicating the credential check.
 */
export async function runInventorySweep(env: Env, fetcher?: typeof fetch): Promise<void> {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const apiToken = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!accountId || !apiToken) {
    logEvent("warn", "migration_inventory_sweep_skipped", {
      message: "migration_inventory_sweep_skipped cloudflare credentials are not configured",
      reason: "credentials_missing",
    });
    return;
  }

  const sweep = await sweepInventory(
    { accountId, apiToken },
    fetcher ? { fetcher } : {},
  );
  await registry(env).recordSweep(sweep);

  // A truncated namespace is named rather than counted: a silent cap reads as
  // "the account was fully enumerated" when it was not.
  logEvent(sweep.status === "complete" ? "info" : "warn", "migration_inventory_sweep_completed", {
    message: `migration_inventory_sweep_completed ${sweep.status}`
      + ` namespaces=${sweep.namespaces.length}`
      + ` objects=${sweep.namespaces.reduce((total, ns) => total + (ns.objects?.length ?? 0), 0)}`,
    status: sweep.status,
    namespace_count: sweep.namespaces.length,
    truncated_namespaces: sweep.truncatedNamespaces,
    unlisted_namespaces: sweep.namespaces
      .filter((namespace) => namespace.objects === null)
      .map((namespace) => namespace.namespaceId),
    error_message: sweep.errorMessage,
    duration_ms: sweep.finishedAt - sweep.startedAt,
  });
}

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    controller.noRetry();
    await runInventorySweep(env);
  },
} satisfies ExportedHandler<Env>;
