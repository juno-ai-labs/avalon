import { app } from "./app";
import type { Env } from "./env";
import { consumeActivityQueue } from "./queues/activity-consumer";

export { WorkstreamRoom } from "./durable-objects/workstream-room";
export { WorkspaceScheduler } from "./durable-objects/workspace-scheduler";
export { WorkstreamLoopWorkflow } from "./workflows/workstream-loop";
export { ConnectorPollWorkflow } from "./workflows/connector-poll";
export { RegionalIdentityBridge } from "./regional-identity-bridge";
export { GitHubRegionalBridge } from "./github-regional-bridge";
export { InboundEmailRegionalBridge } from "./inbound-email-regional-bridge";
export { WorkstreamEmailRoutingBridge } from "./workstream-email-routing-bridge";

export default {
  fetch: app.fetch,
  queue: consumeActivityQueue,
} satisfies ExportedHandler<Env>;
