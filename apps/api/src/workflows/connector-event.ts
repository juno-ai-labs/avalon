import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { workspaceDOName } from "../durable-objects/names";
import {
  ConnectorEventWorkflowInputSchema,
  WorkspaceConnectorEventClaimResultSchema,
  type ConnectorEventWorkflowInput,
} from "../durable-objects/workspace-connector-event-protocol";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { logStructuredEvent } from "../observability/logger";
import { processConnectorEvent } from "../queues/activity-consumer";

/**
 * Durable product processing for one WorkspaceDO-owned connector event.
 *
 * Queue delivery ends after the event is accepted and this deterministic
 * instance exists. Routing, automation matching, digest projection, and
 * suggested-work admission then run here with Workflow retries and history.
 */
export class ConnectorEventWorkflow extends WorkflowEntrypoint<Env, ConnectorEventWorkflowInput> {
  override async run(
    event: Readonly<WorkflowEvent<ConnectorEventWorkflowInput>>,
    step: WorkflowStep,
  ): Promise<{ outcome: "processed" | "already_processed" }> {
    const input = ConnectorEventWorkflowInputSchema.parse(event.payload);
    if (input.region !== this.env.AVALON_REGION) throw new Error("workflow_region_mismatch");
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      input.workspaceId,
      workspaceDOName(input.region, input.workspaceId),
    );
    const claim = await step.do("claim-workspace-connector-event", async () =>
      WorkspaceConnectorEventClaimResultSchema.parse(await workspace.claimConnectorEvent({
        workspaceId: input.workspaceId,
        eventId: input.eventId,
        workflowInstanceId: input.workflowInstanceId,
        attempt: input.attempt,
      })));
    if (claim.outcome === "processed") return { outcome: "already_processed" };
    if (claim.outcome === "busy") throw new Error("connector_event_claim_busy");

    try {
      await step.do(
        "process-workspace-connector-event",
        {
          retries: { limit: 5, delay: "5 seconds", backoff: "exponential" },
          timeout: "15 minutes",
        },
        async () => processConnectorEvent(this.env, claim.event),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 1_000) : "connector_event_processing_failed";
      await step.do("record-workspace-connector-event-failure", async () => {
        await workspace.settleConnectorEvent({
          workspaceId: input.workspaceId,
          eventId: input.eventId,
          workflowInstanceId: input.workflowInstanceId,
          outcome: "failed",
          error: reason,
        });
        await this.env.DB.prepare(
          `UPDATE activities
              SET processing_status = 'failed',
                  metadata_json = json_set(COALESCE(metadata_json, '{}'), '$._processing_error', ?)
            WHERE id = ? AND workspace_id = ?`,
        ).bind(reason, input.eventId, input.workspaceId).run();
      });
      logStructuredEvent(this.env, "error", "connector_event_workflow_failed", {
        workspace_id: input.workspaceId,
        connector_event_id: input.eventId,
        workflow_instance_id: input.workflowInstanceId,
        reason,
      });
      if (input.attempt < 5) {
        await step.do("enqueue-connector-event-redrive", async () => {
          await this.env.ACTIVITY_QUEUE.send({
            region: input.region,
            workspaceId: input.workspaceId,
            activityId: input.eventId,
            attempt: input.attempt + 1,
          });
        });
      }
      throw error;
    }
    await step.do("settle-workspace-connector-event", async () => {
      await workspace.settleConnectorEvent({
        workspaceId: input.workspaceId,
        eventId: input.eventId,
        workflowInstanceId: input.workflowInstanceId,
        outcome: "processed",
        error: null,
      });
    });
    await step.do("settle-connector-event-d1-handoff", async () => {
      await this.env.DB.prepare(
        `UPDATE activities
            SET processing_status = 'processed',
                metadata_json = json_remove(COALESCE(metadata_json, '{}'), '$._processing_error')
          WHERE id = ? AND workspace_id = ?`,
      ).bind(input.eventId, input.workspaceId).run();
    });
    return { outcome: "processed" };
  }
}
