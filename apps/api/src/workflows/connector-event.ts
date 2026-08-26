import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { workspaceDOName } from "../durable-objects/names";
import {
  ConnectorEventWorkflowInputSchema,
  WorkspaceConnectorEventClaimResultSchema,
  type ConnectorEventWorkflowInput,
} from "../durable-objects/workspace-connector-event-protocol";
import type { Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { diagnosticErrorCode, logStructuredEvent } from "../observability/logger";
import { processConnectorEvent } from "../queues/activity-consumer";
import { enqueueWorkspaceConnectorEvent } from "../services/workspace-connector-event-ingress";

/**
 * Drain-only compatibility for WorkspaceDO-owned connector events whose
 * Workflow instance was created before Queue-native processing shipped.
 * New connector ingress never creates this Workflow.
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
        processingOwnerId: input.workflowInstanceId,
        attempt: input.attempt,
        orchestrator: "workflow",
      })));
    logStructuredEvent(this.env, "info", "connector_event_workflow_claimed", {
      workspace_id: input.workspaceId,
      connector_event_id: input.eventId,
      workflow_instance_id: input.workflowInstanceId,
      workflow_attempt: input.attempt,
      outcome: claim.outcome,
    });
    if (claim.outcome === "processed") {
      logStructuredEvent(this.env, "info", "connector_event_workflow_terminal", {
        workspace_id: input.workspaceId,
        connector_event_id: input.eventId,
        workflow_instance_id: input.workflowInstanceId,
        workflow_attempt: input.attempt,
        outcome: "already_processed",
        reason: "authoritative_event_already_settled",
      });
      return { outcome: "already_processed" };
    }
    if (claim.outcome === "busy") {
      logStructuredEvent(this.env, "warn", "connector_event_workflow_deferred", {
        workspace_id: input.workspaceId,
        connector_event_id: input.eventId,
        workflow_instance_id: input.workflowInstanceId,
        workflow_attempt: input.attempt,
        outcome: "busy",
        reason: claim.reason,
      });
      throw new Error("connector_event_claim_busy");
    }

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
      const errorCode = diagnosticErrorCode(error, "connector_event_processing_failed");
      const errorName = error instanceof Error ? error.name : typeof error;
      await step.do("record-workspace-connector-event-failure", async () => {
        await workspace.settleConnectorEvent({
          workspaceId: input.workspaceId,
          eventId: input.eventId,
          processingOwnerId: input.workflowInstanceId,
          outcome: "failed",
          error: reason,
        });
      });
      logStructuredEvent(this.env, "error", "connector_event_workflow_failed", {
        workspace_id: input.workspaceId,
        connector_event_id: input.eventId,
        workflow_instance_id: input.workflowInstanceId,
        reason: errorCode,
        error_name: errorName,
      });
      if (input.attempt < 5) {
        await step.do("enqueue-connector-event-redrive", async () => {
          await enqueueWorkspaceConnectorEvent(this.env, {
            connectorType: claim.event.connectorType,
            activity: claim.event.activity,
            attempt: input.attempt + 1,
          });
        });
        logStructuredEvent(this.env, "warn", "connector_event_workflow_redriven", {
          workspace_id: input.workspaceId,
          connector_type: claim.event.connectorType,
          connector_event_id: input.eventId,
          workflow_instance_id: input.workflowInstanceId,
          workflow_attempt: input.attempt,
          next_attempt: input.attempt + 1,
          reason: errorCode,
          error_name: errorName,
        });
      } else {
        logStructuredEvent(this.env, "error", "connector_event_workflow_terminal", {
          workspace_id: input.workspaceId,
          connector_type: claim.event.connectorType,
          connector_event_id: input.eventId,
          workflow_instance_id: input.workflowInstanceId,
          workflow_attempt: input.attempt,
          outcome: "failed",
          reason: "redrive_attempts_exhausted",
          error_code: errorCode,
          error_name: errorName,
        });
      }
      throw error;
    }
    await step.do("settle-workspace-connector-event", async () => {
      await workspace.settleConnectorEvent({
        workspaceId: input.workspaceId,
        eventId: input.eventId,
        processingOwnerId: input.workflowInstanceId,
        outcome: "processed",
        error: null,
      });
    });
    logStructuredEvent(this.env, "info", "connector_event_workflow_terminal", {
      workspace_id: input.workspaceId,
      connector_type: claim.event.connectorType,
      connection_id: claim.event.activity.connectionId,
      connector_event_id: input.eventId,
      workflow_instance_id: input.workflowInstanceId,
      workflow_attempt: input.attempt,
      outcome: "processed",
      reason: "authoritative_event_settled",
    });
    return { outcome: "processed" };
  }
}
