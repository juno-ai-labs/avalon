import { isDurableObjectMigrationCommandQueue } from "@rally/contracts/durable-object-migrations";
import { app } from "./app";
import { assertEnvContract, EnvContractError, type Env } from "./env";
import { misconfiguredResponse } from "./lib/misconfigured-response";
import { logStructuredEvent } from "./observability/logger";
import { consumeAccessRevocationQueue } from "./queues/access-revocation-consumer";
import { consumeAnalyticsLakehouseQueue } from "./queues/analytics-lakehouse-consumer";
import {
  consumeInferenceLakehouseQueue,
  isInferenceLakehouseQueue,
} from "./queues/inference-lakehouse-consumer";
import { consumeMigrationCommandQueue } from "./queues/migration-command-consumer";
import {
  consumeProductFeatureFlagQueue,
  isProductFeatureFlagQueue,
} from "./queues/product-feature-flag-consumer";
import { isAccessRevocationQueue, reapExpiredSessions } from "./services/access-revocation";
import { consumeActivityQueue, recoverPendingActivityQueue } from "./queues/activity-consumer";
import {
  isAnalyticsLakehouseQueue,
  recoverUndeliveredAnalyticsLakehouseEvents,
} from "./services/analytics-lakehouse";
import { reconcileDigestDefaults } from "./services/digest-service";
import { processTelemetryOutbox } from "./telemetry/delivery";
import { processPendingCrashReports } from "./telemetry/crash-processing";
import {
  processCrashOutbox,
  purgeIneligibleCrashReports,
  reapExpiredOrphanedCrashObjects,
  reapExpiredCrashReports,
} from "./telemetry/crash-delivery";
import { readTelemetryOperationalSnapshot } from "./telemetry/operations";
import {
  acceptsNewWorkstreamWork,
  readWorkstreamAuthorityControl,
  workstreamMaintenanceResponse,
} from "./services/workstream-authority";

async function processCrashTelemetry(env: Env): Promise<void> {
  await reapExpiredCrashReports(env);
  await reapExpiredOrphanedCrashObjects(env);
  await purgeIneligibleCrashReports(env);
  await processPendingCrashReports(env);
  await processCrashOutbox(env);
}

async function processTelemetry(env: Env): Promise<void> {
  await Promise.all([
    processTelemetryOutbox(env),
    processCrashTelemetry(env),
    recoverUndeliveredAnalyticsLakehouseEvents(env),
  ]);
  const snapshot = await readTelemetryOperationalSnapshot(env);
  const unhealthy = snapshot.openCircuits > 0
    || snapshot.acceptedTerminal > 0
    || snapshot.crashTerminal > 0
    || snapshot.profileTerminal > 0;
  logStructuredEvent(env, unhealthy ? "warn" : "info", "telemetry_operations_snapshot", {
    accepted_pending: snapshot.acceptedPending,
    accepted_terminal: snapshot.acceptedTerminal,
    crash_pending: snapshot.crashPending,
    crash_terminal: snapshot.crashTerminal,
    profile_pending: snapshot.profilePending,
    profile_terminal: snapshot.profileTerminal,
    rejection_count: snapshot.rejectionCount,
    open_circuits: snapshot.openCircuits,
    oldest_accepted_age_seconds: snapshot.oldestAcceptedAgeSeconds,
    oldest_crash_age_seconds: snapshot.oldestCrashAgeSeconds,
    oldest_profile_age_seconds: snapshot.oldestProfileAgeSeconds,
  });
}

export { SubstreamAgent } from "./durable-objects/substream-agent";
export { BlockDashboardAgent } from "./durable-objects/block-dashboard-agent";
export { WorkstreamDO } from "./durable-objects/workstream-do";
export { WorkspaceDO } from "./durable-objects/workspace-do";
export { CrashSymbolicatorContainer } from "./crash-symbolicator-container";
export { SlackReactionTicker } from "./durable-objects/slack-reaction-ticker";
export { ConnectorPollWorkflow } from "./workflows/connector-poll";
export { ConnectorEventWorkflow } from "./workflows/connector-event";
export { WorkOpportunityWorkflow } from "./workflows/work-opportunity";
export { RegionalIdentityBridge } from "./regional-identity-bridge";
export { GitHubRegionalBridge } from "./github-regional-bridge";
export { GitHubRoutingBridge } from "./github-routing-bridge";
export { InboundEmailRegionalBridge } from "./inbound-email-regional-bridge";
export { WorkstreamEmailRoutingBridge } from "./workstream-email-routing-bridge";
export { LinearRegionalBridge } from "./linear-regional-bridge";
export { LinearRoutingBridge } from "./linear-routing-bridge";
export { NotionRegionalBridge } from "./notion-regional-bridge";
export { NotionRoutingBridge } from "./notion-routing-bridge";
export { SlackRegionalBridge } from "./slack-regional-bridge";
export { SlackRoutingBridge } from "./slack-routing-bridge";
export { TelemetryRegionalBridge } from "./telemetry-regional-bridge";
export { TelemetryControlBridge } from "./telemetry-control-bridge";

/**
 * The environment is asserted here rather than inside `app`, so the check runs
 * once per isolate against the real bindings while route tests can still build
 * the partial `Env` they need. A misconfigured deployment fails on its first
 * request with the offending keys named, instead of on whichever request first
 * happened to read the missing one.
 *
 * Every entrypoint logs the same event before it fails. The key list is the
 * whole point of the check, and a queue or cron invocation that threw without
 * one would be exactly the anonymous failure this replaces.
 */
function assertEnvContractOrLog(env: Env): EnvContractError | null {
  try {
    assertEnvContract(env);
    return null;
  } catch (error) {
    if (!(error instanceof EnvContractError)) throw error;
    logStructuredEvent(env, "error", "env_contract_failed", { keys: error.keys });
    return error;
  }
}

/**
 * A non-HTTP entrypoint has no response to carry the failure, so it rethrows
 * after logging: the platform's own retry and dead-letter handling is the right
 * place for a batch that cannot run, and swallowing it would drop the work
 * silently.
 */
function withEnvContract<TArgs extends [unknown, Env, ...unknown[]], TResult>(
  handler: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return (...args: TArgs) => {
    const failure = assertEnvContractOrLog(args[1]);
    if (failure) throw failure;
    return handler(...args);
  };
}

export default {
  fetch: async (request, env, context) => {
    // `/health` is exempt. It is the endpoint whose job is to report which
    // pieces of configuration are present, and it already models every one of
    // them as configured/not configured. Letting the 503 swallow it would make
    // the one probe that can report the fault the one that cannot answer.
    //
    // Exempt from refusing, not from reporting: the probe asserts the contract
    // itself and fails on it, so a Worker that cannot serve a request cannot
    // answer healthy. Neither response carries the key names in a deployed
    // environment — they are an inventory of the secrets this Worker is running
    // without, and neither endpoint authenticates — so both leave them to the
    // `env_contract_failed` log, which the probe writes on its own path.
    if (new URL(request.url).pathname !== "/health" && assertEnvContractOrLog(env)) {
      return misconfiguredResponse(request, env);
    }
    const url = new URL(request.url);
    if (url.pathname !== "/health") {
      const authority = await readWorkstreamAuthorityControl(env);
      if (!acceptsNewWorkstreamWork(authority)) return workstreamMaintenanceResponse(authority);
    }
    return app.fetch(request, env, context);
  },
  queue: withEnvContract(async (batch, env) => {
    // Revocations dispatch before the maintenance gate, not after. They are a
    // separate queue resource so they never wait behind an activity backlog,
    // and they are the only path from a retraction to an open socket — so
    // refusing them during maintenance would retry every one of them into the
    // dead-letter queue while the sockets they name stayed open. Closing a
    // socket is not new work-stream work: it reads an object's own storage and
    // hangs up. See docs/access-revocation.md.
    if (isAccessRevocationQueue(batch.queue)) {
      return consumeAccessRevocationQueue(batch, env);
    }
    // Inference archival is an analytical projection of work that already
    // happened. It drains during product maintenance so a cutover cannot turn
    // accepted records into a regional dead-letter backlog.
    if (isInferenceLakehouseQueue(batch.queue)) {
      return consumeInferenceLakehouseQueue(batch, env);
    }
    // Flag changes describe configuration already committed in Flagship. They
    // must still reach open sockets while product mutations are paused.
    if (isProductFeatureFlagQueue(batch.queue)) {
      return consumeProductFeatureFlagQueue(batch, env);
    }
    // Accepted analytics is also a projection, so it drains through product
    // maintenance rather than converting an operational cutover into a DLQ.
    if (isAnalyticsLakehouseQueue(batch.queue)) {
      return consumeAnalyticsLakehouseQueue(batch, env);
    }
    // Forced migrations dispatch before the gate too, and for a closely related
    // reason: a migration pass is schema work, not new work-stream work — it
    // wakes an object, applies whatever its ledger is missing, and says where it
    // landed. Refusing it during maintenance would retry an operator's whole
    // fan-out into the dead-letter queue while the site they started it from
    // showed nothing happening. See docs/durable-object-migration-tracking.md.
    if (isDurableObjectMigrationCommandQueue(batch.queue)) {
      return consumeMigrationCommandQueue(batch, env);
    }
    const authority = await readWorkstreamAuthorityControl(env);
    if (!acceptsNewWorkstreamWork(authority)) {
      throw new Error(`workstream_maintenance:${authority.phase}:${authority.generation}`);
    }
    return consumeActivityQueue(batch, env);
  }),
  scheduled: withEnvContract((_controller, env, context) => {
    context.waitUntil((async () => {
      await Promise.all([
        recoverPendingActivityQueue(env),
        reconcileDigestDefaults(env),
        reapExpiredSessions(env),
        processTelemetry(env),
      ]);
    })());
  }),
} satisfies ExportedHandler<Env>;
