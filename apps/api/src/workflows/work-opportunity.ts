import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { WorkspaceOpportunityWorkflowInputSchema, type WorkspaceOpportunityWorkflowInput } from "../durable-objects/workspace-opportunity-protocol";
import type { Env } from "../env";
import {
  processClaimedOpportunityRanking,
  processClaimedOpportunityWindow,
} from "../services/work-opportunity-service";

/**
 * Durable compute for WorkspaceDO-owned opportunity admission and ranking.
 *
 * WorkspaceDO SQLite owns every input, lease, result, provenance edge, and
 * resolved user state. Workflow owns only the retryable model computation; its
 * payload is a fenced pointer back to the authoritative workspace object.
 */
export class WorkOpportunityWorkflow extends WorkflowEntrypoint<Env, WorkspaceOpportunityWorkflowInput> {
  override async run(
    event: Readonly<WorkflowEvent<WorkspaceOpportunityWorkflowInput>>,
    step: WorkflowStep,
  ): Promise<{ outcome: "processed" }> {
    const input = WorkspaceOpportunityWorkflowInputSchema.parse(event.payload);
    if (input.region !== this.env.AVALON_REGION) throw new Error("workflow_region_mismatch");
    if (input.kind === "admission") {
      await step.do(
        "process-workspace-opportunity-window",
        {
          retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
          timeout: "15 minutes",
        },
        async () => processClaimedOpportunityWindow(this.env, input),
      );
    } else {
      // The ranking function records failure and releases its lease before it
      // throws. Retrying this same fenced pointer would compute outside a live
      // claim, so the WorkspaceDO alarm owns the later retry instead.
      await step.do(
        "rank-workspace-opportunities",
        { retries: { limit: 0, delay: "1 second" }, timeout: "15 minutes" },
        async () => processClaimedOpportunityRanking(this.env, input),
      );
    }
    return { outcome: "processed" };
  }
}
