import { app } from "./app";
import type { Env } from "./env";
import { consumeActivityQueue } from "./queues/activity-consumer";
import { reapStaleHarnessRuns } from "./runtime/harness-run-runtime";

const REAPER_BATCH_LIMIT = 100;
const REAPER_MAX_BATCHES = 5;

async function reapExpiredHarnessAttempts(env: Env): Promise<void> {
  for (let batch = 0; batch < REAPER_MAX_BATCHES; batch += 1) {
    const reaped = await reapStaleHarnessRuns(env.DB, { limit: REAPER_BATCH_LIMIT });
    if (reaped.length < REAPER_BATCH_LIMIT) return;
  }
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
    context.waitUntil(reapExpiredHarnessAttempts(env));
  },
} satisfies ExportedHandler<Env>;
