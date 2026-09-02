import {
  IdSchema,
} from "@rally/contracts";
import { z } from "zod";

import {
  workspacePlacementAffinity,
} from "../lib/durable-object-namespace";
import { WorkspaceDoProjects } from "./workspace-do-projects";
import { logWarn } from "../observability/logger";
import {
  claimWorkspaceConnectorEvent,
  connectorEventFromRow,
  ingestWorkspaceConnectorEvent,
  settleWorkspaceConnectorEvent,
  workspaceConnectorEvent,
  type WorkspaceConnectorEventRow,
} from "./workspace-connector-event-storage";
import {
  latestWorkspaceActivityEventCursor,
  listWorkspaceActivityEvents,
  recordWorkspaceActivityEvent,
  workspaceActivityEventSource,
} from "./workspace-activity-event-storage";
import {
  releaseWorkspaceDraftAttachments,
  reserveWorkspaceDraftAttachments,
} from "./workspace-draft-attachment-storage";
import {
  WorkspaceReleaseDraftAttachmentsRequestSchema,
  WorkspaceReleaseDraftAttachmentsResultSchema,
  WorkspaceReserveDraftAttachmentsRequestSchema,
  type WorkspaceReleaseDraftAttachmentsRequest,
  type WorkspaceReleaseDraftAttachmentsResult,
  type WorkspaceReserveDraftAttachmentsRequest,
  type WorkspaceReserveDraftAttachmentsResult,
} from "./workspace-draft-attachment-protocol";
import {
  WorkspaceConnectorEventClaimRpcRequestSchema,
  WorkspaceConnectorEventClaimRequestSchema,
  WorkspaceConnectorEventIngestRequestSchema,
  WorkspaceConnectorEventRequestSchema,
  WorkspaceConnectorEventSettleRpcRequestSchema,
  type WorkspaceConnectorEvent,
  type WorkspaceConnectorEventClaimRequest,
  type WorkspaceConnectorEventClaimRpcRequest,
  type WorkspaceConnectorEventClaimRpcResult,
  type WorkspaceConnectorEventIngestRequest,
  type WorkspaceConnectorEventIngestResult,
  type WorkspaceConnectorEventRequest,
  type WorkspaceConnectorEventSettleRequest,
  type WorkspaceConnectorEventSettleRpcRequest,
} from "./workspace-connector-event-protocol";
import {
  WorkspaceActivityEventCursorRequestSchema,
  WorkspaceActivityEventInputSchema,
  WorkspaceActivityEventListRequestSchema,
  WorkspaceActivityEventSourceRequestSchema,
  type WorkspaceActivityEventCursorRequest,
  type WorkspaceActivityEventInput,
  type WorkspaceActivityEventListRequest,
  type WorkspaceActivityEventListResult,
  type WorkspaceActivityEventSourceRequest,
} from "./workspace-activity-event-protocol";
import {
  WorkspaceOpportunityBatchEventsRequestSchema,
  WorkspaceOpportunityClaimStartRequestSchema,
  WorkspaceOpportunityCompleteStartRequestSchema,
  WorkspaceOpportunityDismissResultSchema,
  WorkspaceOpportunityDismissRequestSchema,
  WorkspaceOpportunityEnqueueRequestSchema,
  WorkspaceOpportunityEnqueueResultSchema,
  WorkspaceOpportunityExistingRequestSchema,
  WorkspaceOpportunityGetRequestSchema,
  WorkspaceOpportunityImpressionsRequestSchema,
  WorkspaceOpportunityListRequestSchema,
  WorkspaceOpportunityListResultSchema,
  WorkspaceOpportunityOriginEventsRequestSchema,
  WorkspaceOpportunityOriginEventsResultSchema,
  WorkspaceOpportunityPersistRequestSchema,
  WorkspaceOpportunityPersistResultSchema,
  WorkspaceOpportunityRankingCandidatesRequestSchema,
  WorkspaceOpportunityRankingRoundRequestSchema,
  WorkspaceOpportunityRankingSettleRequestSchema,
  WorkspaceOpportunityRankingStateSchema,
  WorkspaceOpportunityReleaseStartRequestSchema,
  WorkspaceOpportunityStoreRankingRequestSchema,
  WorkspaceOpportunityTelemetryContextSchema,
  WorkspaceOpportunityTelemetryContextsSchema,
  WorkspaceOpportunityWindowRequestSchema,
  WorkspaceOpportunityWindowSchema,
  WorkspaceOpportunityWindowSettleRequestSchema,
  type WorkspaceOpportunityBatchEventsRequest,
  type WorkspaceOpportunityClaimStartRequest,
  type WorkspaceOpportunityCompleteStartRequest,
  type WorkspaceOpportunityDismissRequest,
  type WorkspaceOpportunityEnqueueRequest,
  type WorkspaceOpportunityExistingRequest,
  type WorkspaceOpportunityGetRequest,
  type WorkspaceOpportunityImpressionsRequest,
  type WorkspaceOpportunityListRequest,
  type WorkspaceOpportunityOriginEventsRequest,
  type WorkspaceOpportunityPersistRequest,
  type WorkspaceOpportunityRankingCandidatesRequest,
  type WorkspaceOpportunityRankingRoundRequest,
  type WorkspaceOpportunityRankingSettleRequest,
  type WorkspaceOpportunityStoreRankingRequest,
  type WorkspaceOpportunityWindowRequest,
  type WorkspaceOpportunityWindowSettleRequest,
} from "./workspace-opportunity-protocol";

/**
 * `WorkspaceDO`'s product surface: the connector-event ledger, the activity log,
 * work opportunities and their ranking, and draft attachment reservations.
 *
 * One link of the `WorkspaceDO` chain; `workspace-do-core.ts` explains it.
 */
export abstract class WorkspaceDoProduct extends WorkspaceDoProjects {

  /**
   * Accept one workspace-scoped connector event from the regional Queue.
   *
   * The ingress identifier names a delivery attempt. Provider identity and the
   * connector dedupe key choose the canonical event, so an at-least-once Queue
   * delivery or a provider replay cannot create a second durable record.
   */
  async ingestConnectorEvent(
    input: WorkspaceConnectorEventIngestRequest,
  ): Promise<WorkspaceConnectorEventIngestResult> {
    await this.initialized;
    const request = WorkspaceConnectorEventIngestRequestSchema.parse(input);
    if (!this.workspaceId()) {
      this.ensureIdentity(
        request.workspaceId,
        await workspacePlacementAffinity(this.env, request.workspaceId),
      );
    }
    this.assertWorkspace(request.workspaceId);
    return ingestWorkspaceConnectorEvent(this.env, this.state.storage, request);
  }

  async connectorEvent(input: WorkspaceConnectorEventRequest): Promise<WorkspaceConnectorEvent | null> {
    await this.initialized;
    const request = WorkspaceConnectorEventRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceConnectorEvent(this.env, this.state.storage, request);
  }

  async claimConnectorEvent(
    input: WorkspaceConnectorEventClaimRpcRequest,
  ): Promise<WorkspaceConnectorEventClaimRpcResult> {
    await this.initialized;
    const rpcRequest = WorkspaceConnectorEventClaimRpcRequestSchema.parse(input);
    const legacyWorkflowContract = "workflowInstanceId" in rpcRequest;
    const request: WorkspaceConnectorEventClaimRequest = legacyWorkflowContract
      ? {
          workspaceId: rpcRequest.workspaceId,
          eventId: rpcRequest.eventId,
          processingOwnerId: rpcRequest.workflowInstanceId,
          attempt: rpcRequest.attempt,
          orchestrator: "workflow",
        }
      : WorkspaceConnectorEventClaimRequestSchema.parse(rpcRequest);
    this.assertWorkspace(request.workspaceId);
    return claimWorkspaceConnectorEvent(
      this.env,
      this.state.storage,
      request,
      legacyWorkflowContract,
    );
  }

  async settleConnectorEvent(input: WorkspaceConnectorEventSettleRpcRequest): Promise<void> {
    await this.initialized;
    const rpcRequest = WorkspaceConnectorEventSettleRpcRequestSchema.parse(input);
    const legacyWorkflowContract = "workflowInstanceId" in rpcRequest;
    const request: WorkspaceConnectorEventSettleRequest = legacyWorkflowContract
      ? {
          workspaceId: rpcRequest.workspaceId,
          eventId: rpcRequest.eventId,
          processingOwnerId: rpcRequest.workflowInstanceId,
          outcome: rpcRequest.outcome,
          error: rpcRequest.error,
        }
      : rpcRequest;
    this.assertWorkspace(request.workspaceId);
    settleWorkspaceConnectorEvent(this.env, this.state.storage, request, legacyWorkflowContract);
  }

  /** Append one first-party activity-log event and all of its target edges atomically. */
  async recordActivityEvent(input: WorkspaceActivityEventInput): Promise<string> {
    await this.initialized;
    const request = WorkspaceActivityEventInputSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const eventId = recordWorkspaceActivityEvent(this.state.storage, request);
    await this.refreshProductAlarm();
    return eventId;
  }

  /** Read one active member's visibility-filtered, insertion-ordered activity window. */
  async listActivityEvents(
    input: WorkspaceActivityEventListRequest,
  ): Promise<WorkspaceActivityEventListResult> {
    await this.initialized;
    const request = WorkspaceActivityEventListRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const member = await this.env.DB.prepare(
      `SELECT 1 FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
    ).bind(request.workspaceId, request.userId).first();
    if (!member) return { items: [] };
    return listWorkspaceActivityEvents(this.state.storage, request);
  }

  async latestActivityEventCursor(input: WorkspaceActivityEventCursorRequest): Promise<number> {
    await this.initialized;
    const request = WorkspaceActivityEventCursorRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return latestWorkspaceActivityEventCursor(this.state.storage);
  }

  async activityEventSource(input: WorkspaceActivityEventSourceRequest) {
    await this.initialized;
    const request = WorkspaceActivityEventSourceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceActivityEventSource(this.state.storage, request);
  }

  async enqueueOpportunitySource(input: WorkspaceOpportunityEnqueueRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityEnqueueRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = WorkspaceOpportunityEnqueueResultSchema.parse(
      this.productStorage().enqueueOpportunitySource(request),
    );
    await this.refreshProductAlarm();
    return result;
  }

  async opportunityWindow(input: WorkspaceOpportunityWindowRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityWindowRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return WorkspaceOpportunityWindowSchema.parse(this.productStorage().opportunityWindow(request));
  }

  async mutateOpportunityBatchEvents(input: WorkspaceOpportunityBatchEventsRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceOpportunityBatchEventsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    this.productStorage().mutateOpportunityBatchEvents(request);
  }

  async settleOpportunityWindow(input: WorkspaceOpportunityWindowSettleRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceOpportunityWindowSettleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    this.productStorage().settleOpportunityWindow(request);
    await this.refreshProductAlarm();
  }

  async existingOpportunities(input: WorkspaceOpportunityExistingRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityExistingRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.productStorage().existingOpportunities(request);
  }

  async persistOpportunity(input: WorkspaceOpportunityPersistRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityPersistRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = WorkspaceOpportunityPersistResultSchema.parse(
      this.productStorage().persistOpportunity(request),
    );
    await this.refreshProductAlarm();
    return result;
  }

  async markOpportunityRankingDue(
    workspaceId: string,
    userIds: string[],
    delayMs: number,
    clearFingerprint = false,
  ): Promise<void> {
    await this.initialized;
    this.assertWorkspace(IdSchema.parse(workspaceId));
    const ids = z.array(IdSchema).max(10_000).parse([...new Set(userIds)]);
    const delay = z.number().int().min(0).max(24 * 60 * 60_000).parse(delayMs);
    const now = Date.now();
    for (const userId of ids) {
      this.productStorage().markRankingDue(userId, now + delay, now, clearFingerprint);
    }
    await this.refreshProductAlarm();
  }

  async markWorkspaceOpportunityRankingDue(workspaceId: string, delayMs: number): Promise<void> {
    await this.initialized;
    this.assertWorkspace(IdSchema.parse(workspaceId));
    const members = await this.env.DB.prepare(
      `SELECT user_id FROM workspace_members WHERE workspace_id = ? AND status = 'active'`,
    ).bind(workspaceId).all<{ user_id: string }>();
    await this.markOpportunityRankingDue(
      workspaceId,
      members.results.map((row) => row.user_id),
      delayMs,
    );
  }

  async opportunityRankingCandidates(input: WorkspaceOpportunityRankingCandidatesRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityRankingCandidatesRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.productStorage().rankingCandidates(request);
  }

  async opportunityRankingState(workspaceId: string, userId: string) {
    await this.initialized;
    this.assertWorkspace(IdSchema.parse(workspaceId));
    return WorkspaceOpportunityRankingStateSchema.parse(
      this.productStorage().rankingState(IdSchema.parse(userId)),
    );
  }

  async recordOpportunityRankingRound(input: WorkspaceOpportunityRankingRoundRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceOpportunityRankingRoundRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    this.productStorage().recordRankingRound(request);
  }

  async storeOpportunityRanking(input: WorkspaceOpportunityStoreRankingRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceOpportunityStoreRankingRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    this.productStorage().storeRanking(request);
  }

  async settleOpportunityRanking(input: WorkspaceOpportunityRankingSettleRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceOpportunityRankingSettleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    this.productStorage().settleRanking(request);
    await this.refreshProductAlarm();
  }

  async listOpportunities(input: WorkspaceOpportunityListRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityListRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = WorkspaceOpportunityListResultSchema.parse(
      this.productStorage().listOpportunities(request),
    );
    await this.refreshProductAlarm();
    return result;
  }

  async recordOpportunityImpressions(input: WorkspaceOpportunityImpressionsRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityImpressionsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = this.productStorage().recordImpressions(request);
    const contexts = WorkspaceOpportunityTelemetryContextsSchema.safeParse(result.telemetryContexts);
    if (result.telemetryContextReadFailed || !contexts.success) {
      logWarn(this.env, "workspace_opportunity_telemetry_context_failed", {
        workspace_id: request.workspaceId,
        operation: "impression",
      });
    }
    await this.refreshProductAlarm();
    return contexts.success ? contexts.data : [];
  }

  async dismissOpportunity(input: WorkspaceOpportunityDismissRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityDismissRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = this.productStorage().dismissOpportunity(request);
    const parsed = WorkspaceOpportunityDismissResultSchema.safeParse({
      dismissed: result.dismissed,
      telemetryContext: result.telemetryContext,
    });
    if (result.telemetryContextReadFailed || !parsed.success) {
      logWarn(this.env, "workspace_opportunity_telemetry_context_failed", {
        workspace_id: request.workspaceId,
        operation: "dismiss",
      });
    }
    await this.refreshProductAlarm();
    return parsed.success
      ? parsed.data
      : { dismissed: result.dismissed, telemetryContext: null };
  }

  async getOpportunity(input: WorkspaceOpportunityGetRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityGetRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.productStorage().getOpportunity(request);
  }

  async opportunityOriginEvents(
    input: WorkspaceOpportunityOriginEventsRequest,
  ): Promise<WorkspaceConnectorEvent[]> {
    await this.initialized;
    const request = WorkspaceOpportunityOriginEventsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const sourceIds = this.productStorage().opportunityActivitySourceIds(request);
    const events = sourceIds.flatMap((eventId) => {
      const row = this.state.storage.sql.exec<WorkspaceConnectorEventRow>(
        `SELECT * FROM workspace_connector_events WHERE event_id = ?`,
        eventId,
      ).toArray()[0];
      return row
        ? [connectorEventFromRow(row, request.workspaceId, this.env.AVALON_REGION)]
        : [];
    });
    return WorkspaceOpportunityOriginEventsResultSchema.parse(events);
  }

  async claimOpportunityStart(input: WorkspaceOpportunityClaimStartRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityClaimStartRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = this.productStorage().claimOpportunityStart(request);
    const context = WorkspaceOpportunityTelemetryContextSchema.nullable().safeParse(result.telemetryContext);
    if (result.telemetryContextReadFailed || !context.success) {
      logWarn(this.env, "workspace_opportunity_telemetry_context_failed", {
        workspace_id: request.workspaceId,
        operation: "start",
      });
    }
    return {
      outcome: result.outcome,
      opportunity: result.opportunity,
      telemetryContext: context.success ? context.data : null,
    };
  }

  async releaseOpportunityStart(input: WorkspaceOpportunityClaimStartRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceOpportunityReleaseStartRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    this.productStorage().releaseOpportunityStart(request);
  }

  async completeOpportunityStart(input: WorkspaceOpportunityCompleteStartRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceOpportunityCompleteStartRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    this.productStorage().completeOpportunityStart(request);
    await this.refreshProductAlarm();
  }

  /**
   * Freeze upload drafts for one pending work-stream input.
   *
   * The returned descriptors and the reservation commit are one WorkspaceDO
   * transaction. Product therefore never prepares bytes from a row that a
   * concurrent explicit delete or TTL pass can remove after admission.
   */
  async reserveDraftAttachments(
    input: WorkspaceReserveDraftAttachmentsRequest,
  ): Promise<WorkspaceReserveDraftAttachmentsResult> {
    await this.initialized;
    const request = WorkspaceReserveDraftAttachmentsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = reserveWorkspaceDraftAttachments(this.state.storage, request);
    if (request.resourceIds.length > 0) {
      await this.refreshSchedule(request.workspaceId);
    }
    return result;
  }

  /** Idempotently release one failed or discarded Product preparation. */
  async releaseDraftAttachments(
    input: WorkspaceReleaseDraftAttachmentsRequest,
  ): Promise<WorkspaceReleaseDraftAttachmentsResult> {
    await this.initialized;
    const request = WorkspaceReleaseDraftAttachmentsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const released = releaseWorkspaceDraftAttachments(this.state.storage, request);
    // Always reconcile on replay: the preceding attempt may have committed the
    // delete and then lost the response while refreshing the single alarm.
    await this.refreshSchedule(request.workspaceId);
    return WorkspaceReleaseDraftAttachmentsResultSchema.parse({ released });
  }
}
