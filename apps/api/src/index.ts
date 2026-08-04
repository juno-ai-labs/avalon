import { app } from "./app";
import type { Env } from "./env";
import { consumeActivityQueue } from "./queues/activity-consumer";
import { reapStaleHarnessRuns } from "./runtime/harness-run-runtime";

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
export { InboundEmailRegionalBridge } from "./inbound-email-regional-bridge";
export { WorkstreamEmailRoutingBridge } from "./workstream-email-routing-bridge";
export { LinearRegionalBridge } from "./linear-regional-bridge";
export { LinearRoutingBridge } from "./linear-routing-bridge";

export default {
  fetch: app.fetch,
  queue: consumeActivityQueue,
  scheduled: (_controller, env, context) => {
    context.waitUntil(Promise.all([reapExpiredHarnessAttempts(env), reapExpiredDraftAttachments(env)]));
  },
} satisfies ExportedHandler<Env>;
