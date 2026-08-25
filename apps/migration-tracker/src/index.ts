/**
 * `avalon-migration-tracker` — the Worker behind
 * `migrations.internal.rallywith.ai`.
 *
 * It has three entry points and they are deliberately different in kind:
 *
 * - the **default fetch handler** serves the operator site, and every request
 *   to it is verified against Cloudflare Access;
 *
 * - the **queue handler** consumes migration reports from both regional report
 *   queues. A Queue rather than a service-binding RPC, per
 *   `docs/choosing-queues-or-rpc.md`: the whole fleet converges on one registry
 *   object, nothing waits on the outcome, and batching means a herd of
 *   reporters costs one registry write instead of one each. It also means the
 *   report path has no public address, and neither API Worker's deploy depends
 *   on this script existing;
 *
 * - the **scheduled handler** runs the hourly inventory sweep.
 *
 * `docs/durable-object-migration-tracking.md` owns the design.
 */
import {
  DurableObjectMigrationReportSchema,
  type DurableObjectMigrationReport,
} from "@rally/contracts/durable-object-migrations";
import { app, registry } from "./app";
import type { Env } from "./env";
import { sweepInventory } from "./inventory";
import { logEvent } from "./logger";

export { MigrationRegistry } from "./registry";

/**
 * Validate a batch and record what survives.
 *
 * A message that does not match the contract is acknowledged rather than
 * retried. It will never become valid, so retrying it to the dead-letter queue
 * would spend the batch's redelivery budget on a message nobody can fix, and —
 * because an unacknowledged failure redelivers the *whole* batch — would drag
 * every valid report alongside it. Acknowledging it drops it, loudly.
 *
 * Everything else is left unacknowledged, so a registry write that throws
 * redelivers exactly the reports that were not recorded.
 */
export async function consumeMigrationReports(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const accepted: DurableObjectMigrationReport[] = [];
  let rejected = 0;

  for (const message of batch.messages) {
    const parsed = DurableObjectMigrationReportSchema.safeParse(message.body);
    if (!parsed.success) {
      rejected += 1;
      message.ack();
      logEvent("warn", "migration_report_rejected", {
        message: "migration_report_rejected the report did not match the contract",
        queue: batch.queue,
        issues: parsed.error.issues.map((issue) => issue.path.map(String).join(".") || "(root)"),
      });
      continue;
    }
    accepted.push(parsed.data);
  }

  if (accepted.length > 0) await registry(env).recordReports(accepted);

  const failures = accepted.filter((report) => report.status === "failed");
  logEvent(failures.length > 0 ? "error" : "info", "migration_reports_recorded", {
    message: `migration_reports_recorded ${accepted.length} recorded`
      + `${failures.length > 0 ? `, ${failures.length} failed migrations` : ""}`
      + `${rejected > 0 ? `, ${rejected} rejected` : ""}`,
    queue: batch.queue,
    recorded_count: accepted.length,
    rejected_count: rejected,
    // Named rather than counted: a failed migration is the reason this Worker
    // exists, and it should be findable in the log without opening the site.
    failed_objects: failures.map((report) => ({
      object_id: report.objectId,
      object_name: report.objectName,
      component: report.component,
      region: report.region,
      schema_version: report.schemaVersion,
      failure_message: report.failure?.message ?? null,
    })),
  });
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
  queue: consumeMigrationReports,
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // No retry: `sweepInventory` already absorbs every Cloudflare API failure
    // into a recorded `failed` sweep, so the only thing left that can throw is a
    // registry write — and the next hourly sweep supersedes a lost one entirely,
    // since the sweep is a full re-enumeration rather than an increment.
    // Retrying would re-walk the whole account to produce a result an hour of
    // waiting produces anyway. A throw here is not swallowed: it surfaces as a
    // failed cron invocation, which is the signal worth having.
    controller.noRetry();
    await runInventorySweep(env);
  },
} satisfies ExportedHandler<Env, unknown>;
