import { app } from "./app";
import { assertEnvContract, EnvContractError, type Env } from "./env";
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
export { SlackRegionalBridge } from "./slack-regional-bridge";
export { SlackRoutingBridge } from "./slack-routing-bridge";

/**
 * The environment is asserted here rather than inside `app`, so the check runs
 * once per isolate against the real bindings while route tests can still build
 * the partial `Env` they need. A misconfigured deployment fails on its first
 * request with the offending keys named, instead of on whichever request first
 * happened to read the missing one.
 */
function withEnvContract<TArgs extends [unknown, Env, ...unknown[]], TResult>(
  handler: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
  return (...args: TArgs) => {
    assertEnvContract(args[1]);
    return handler(...args);
  };
}

export default {
  fetch: (request, env, context) => {
    try {
      assertEnvContract(env);
    } catch (error) {
      if (!(error instanceof EnvContractError)) throw error;
      logStructuredEvent(env, "error", "env_contract_failed", { keys: error.keys });
      return Response.json(
        { error: { code: "service_misconfigured", message: "The service is misconfigured", requestId: null } },
        { status: 503 },
      );
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
