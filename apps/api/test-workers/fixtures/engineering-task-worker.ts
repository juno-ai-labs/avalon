// The pool discovers loopback entrypoints from named exports; export * does
// not expose ArtifactAssetLoopback (or the regional bridges) to ctx.exports.
export {
  default,
  AshbyRegionalBridge, AshbyRoutingBridge, AgentLoopDO, MigrationProbeDO,
  WorkspaceDO, CrashSymbolicatorContainer, ArtifactHostDO, ArtifactAssetLoopback,
  ConnectorPollWorkflow, ConnectorEventWorkflow, RegionalIdentityBridge,
  GitHubRegionalBridge, GitHubRoutingBridge, LinearRegionalBridge, LinearRoutingBridge,
  NotionRegionalBridge, NotionRoutingBridge, SlackRegionalBridge, SlackRoutingBridge,
  TelemetryRegionalBridge, TelemetryControlBridge, EngineeringInspectionBridge,
  AuthorizationControl,
} from "../../src/index";

import { createExecutionContext } from "cloudflare:test";

import { EngineeringTaskDO } from "../../../engineering-mcp/src/task-do";
import { EngineeringInspectionBridge } from "../../src/engineering-inspection-bridge";
import type { Env } from "../../src/env";

// The task runs the real regional bridge and real product authorities. Only
// Basin's external HTTP API is doubled at fetch in the test.
export class EngineeringTaskTestDO extends EngineeringTaskDO {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, {
      GLOBAL_INSPECTION: new EngineeringInspectionBridge(createExecutionContext(), env),
      CLOUDFLARE_ACCOUNT_ID: "task-test-account",
      BASIN_SQL_API_TOKEN: "test-not-a-credential",
    });
  }
}
