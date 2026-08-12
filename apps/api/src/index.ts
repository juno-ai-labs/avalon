import { app } from "./app";
import { assertEnvContract, EnvContractError, type Env } from "./env";
import { misconfiguredResponse } from "./lib/misconfigured-response";
import { logStructuredEvent } from "./observability/logger";
import { consumeActivityQueue, recoverPendingActivityQueue } from "./queues/activity-consumer";
import { reapExpiredActivityEvents } from "./services/activity-event-service";
import { reapStaleHarnessRuns } from "./runtime/harness-run-runtime";
import { reconcileDigestDefaults } from "./services/digest-service";
import { processMemoryIndexOutbox } from "./services/memory-service";
import { reapDeletedNoteObjects } from "./services/note-resource-cleanup";
import { processPendingNotePrivacyNotifications } from "./services/note-privacy-notification-service";
import { SlackAgentService } from "./services/slack-agent-service";
import { refreshSlackWorkstreamUnfurls } from "./services/slack-unfurl-refresh";
import { processDueOpportunityWindows, processDueSuggestedWork } from "./services/work-opportunity-service";

const REAPER_BATCH_LIMIT = 100;
const REAPER_MAX_BATCHES = 5;
const DRAFT_ATTACHMENT_TTL_HOURS = 24;

async function reapExpiredHarnessAttempts(env: Env): Promise<void> {
  for (let batch = 0; batch < REAPER_MAX_BATCHES; batch += 1) {
    const reaped = await reapStaleHarnessRuns(env.DB, { limit: REAPER_BATCH_LIMIT });
    if (reaped.length < REAPER_BATCH_LIMIT) return;
  }
}

async function reapExpiredDraftAttachments(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - DRAFT_ATTACHMENT_TTL_HOURS * 60 * 60 * 1_000).toISOString();
  const stale = await env.DB.prepare(
    `SELECT id, content_ref, model_content_ref FROM resources
     WHERE provider = 'avalon_upload' AND attachment_status = 'draft' AND created_at < ?
       AND NOT EXISTS (SELECT 1 FROM message_attachments WHERE resource_id = resources.id)
       AND NOT EXISTS (SELECT 1 FROM workstream_resources WHERE resource_id = resources.id)
     LIMIT 100`,
  ).bind(cutoff).all<{ id: string; content_ref: string | null; model_content_ref: string | null }>();
  if (stale.results.length === 0) return;
  await env.DB.batch(stale.results.map((resource) => env.DB.prepare(
    `DELETE FROM resources WHERE id = ? AND provider = 'avalon_upload' AND attachment_status = 'draft'`,
  ).bind(resource.id)));
  await Promise.all(stale.results.flatMap((resource) => [
    ...(resource.content_ref ? [env.PAYLOADS.delete(resource.content_ref)] : []),
    ...(resource.model_content_ref ? [env.PAYLOADS.delete(resource.model_content_ref)] : []),
  ]));
}

export { WorkstreamRoom } from "./durable-objects/workstream-room";
export { WorkspaceScheduler } from "./durable-objects/workspace-scheduler";
export { WorkstreamLoopWorkflow } from "./workflows/workstream-loop";
export { ConnectorPollWorkflow } from "./workflows/connector-poll";
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
  fetch: (request, env, context) => {
    // `/health` is exempt. It is the endpoint whose job is to report which
    // pieces of configuration are present, and it already models every one of
    // them as configured/not configured. Letting the 503 swallow it would make
    // the one probe that can name the missing key the one that cannot answer —
    // and the 503 body deliberately carries no key names, since they are
    // secrets, so the probe is the only place an operator can see them.
    if (new URL(request.url).pathname !== "/health" && assertEnvContractOrLog(env)) {
      return misconfiguredResponse(request, env);
    }
    return app.fetch(request, env, context);
  },
  queue: withEnvContract(consumeActivityQueue),
  scheduled: withEnvContract((_controller, env, context) => {
    context.waitUntil(Promise.all([
      reapExpiredHarnessAttempts(env),
      reapExpiredDraftAttachments(env),
      reapDeletedNoteObjects(env),
      processPendingNotePrivacyNotifications(env),
      processMemoryIndexOutbox(env),
      new SlackAgentService(env).maintainIngress(),
      refreshSlackWorkstreamUnfurls(env),
      processDueOpportunityWindows(env),
      processDueSuggestedWork(env),
      recoverPendingActivityQueue(env),
      reapExpiredActivityEvents(env),
      reconcileDigestDefaults(env),
    ]));
  }),
} satisfies ExportedHandler<Env>;
