export { ArtifactSidekickForwarder } from "../../src/artifacts/sidekick-forwarder";
// The pool discovers loopback entrypoints from named exports; export * does
// not expose ArtifactAssetLoopback (or the regional bridges) to ctx.exports.
export {
  default,
  AshbyRegionalBridge, AshbyRoutingBridge, AgentLoopDO, MigrationProbeDO,
  BillingCoordinatorDO, WorkspaceDO, CrashSymbolicatorContainer, ArtifactHostDO, ArtifactAssetLoopback, ArtifactSidekickLoopback, ArtifactSidekickDispatcher,
  ConnectorPollWorkflow, ConnectorEventWorkflow, RegionalIdentityBridge,
  GitHubRegionalBridge, GitHubRoutingBridge, LinearRegionalBridge, LinearRoutingBridge,
  NotionRegionalBridge, NotionRoutingBridge, SlackRegionalBridge, SlackRoutingBridge,
  TelemetryRegionalBridge, TelemetryControlBridge, EngineeringInspectionBridge,
  AuthorizationControl,
} from "../../src/index";

// A new production export must also appear above, or typecheck fails.
import type * as Api from "../../src/index";
import type * as TestWorker from "./engineering-task-worker";
export type ApiExportsPreserved = Pick<
  typeof TestWorker, keyof typeof Api
>;

import { createExecutionContext } from "cloudflare:test";

import { EngineeringTaskDO } from "../../../engineering-mcp/src/task-do";
import { EngineeringInspectionBridge } from "../../src/engineering-inspection-bridge";
import type { Env } from "../../src/env";

// The task runs the real regional bridge and real product authorities. Only
// Basin's external HTTP API is doubled at fetch in the test.
export class EngineeringTaskTestDO extends EngineeringTaskDO {
  // cloudflare:test's native alarm helper cannot supply retry metadata.
  // Deliver that platform boundary through RPC while retaining the real DO,
  // storage and retirement service; this hook exists only in the test worker.
  async deliverAlarmRetry(retryCount: number) {
    await this.ctx.storage.deleteAlarm();
    try {
      await this.alarm({ retryCount, isRetry: true, scheduledTime: Date.now() });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  constructor(ctx: DurableObjectState, env: Env & { ENGINEERING_TASKS: DurableObjectNamespace<EngineeringTaskDO> }) {
    super(ctx, {
      ENGINEERING_TASKS: env.ENGINEERING_TASKS,
      GLOBAL_INSPECTION: new EngineeringInspectionBridge(createExecutionContext(), env),
      CLOUDFLARE_ACCOUNT_ID: "task-test-account",
      BASIN_SQL_API_TOKEN: "test-not-a-credential",
    });
  }
}
