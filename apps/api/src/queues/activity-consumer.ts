import {
  renderActivityRoutingMessages,
} from "@rally/agent-harness";
import { ConnectorError, connectorOriginUrl, connectorRetryAfterMs } from "@rally/connectors";
import {
  ACTIVITY_STREAM_NOT_DIGESTIBLE_METADATA_KEY,
  ActivityQueueMessageSchema,
  ActivityRoutingResultSchema,
  SlackIngressQueueMessageSchema,
  WorkspaceExternalEventDeliveryQueueMessageSchema,
  asAutomationId,
  asSubstreamId,
  asWorkspaceId,
  asWorkstreamId,
  asUserId,
  type WorkspaceId
} from "@rally/contracts";
import { z } from "zod";

import { WorkstreamRegionalEffectQueueMessageSchema } from "../durable-objects/workstream-regional-effect";
import { ProjectDefaultResourceQueueMessageSchema } from "../durable-objects/workspace-project-protocol";
import { automationAgentName, substreamAgentName, workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceConnectorEventClaimResultSchema,
  WorkspaceConnectorEventProcessQueueMessageSchema,
  WorkspaceConnectorEventQueueMessageSchema,
  type WorkspaceConnectorEvent,
} from "../durable-objects/workspace-connector-event-protocol";
import type { Env } from "../env";
import type { AuthContext } from "../env";
import { contentAudienceContainsWorkstream } from "../lib/audience-containment";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { SUGGESTED_CONTEXT_ENABLED } from "../lib/suggested-context";
import { uuidV7 } from "../lib/uuid-v7";
import {
  BASE_CONFIDENCE_FLOOR,
  DISMISSAL_RUN_LIMIT,
  OPERATIONAL_CONFIDENCE_FLOOR,
  dismissalRunCutoff,
  suggestionAdmission,
} from "../services/activity-routing-feedback";
import {
  createActivitySuggestion,
} from "../services/activity-suggestion-service";
import { SlackAgentService } from "../services/slack-agent-service";
import { runStructuredInference } from "../services/structured-inference";
import { enqueueActivityOpportunity } from "../services/work-opportunity-batching";
import { recordActivityEvent } from "../services/activity-event-service";
import { diagnosticErrorCode, logDebug, logInfo, logWarn } from "../observability/logger";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { restrictedActivityUserIds } from "../lib/activity-visibility";
import {
  enqueueWorkspaceConnectorEventProcess,
} from "../services/workspace-connector-event-ingress";
import {
  acknowledgeWorkstreamOutboxEffect,
  applyQueuedWorkspaceDirectoryEffect,
  applyWorkstreamRegionalEffect,
  isWorkspaceDirectoryEffect,
  loadWorkstreamRegionalEffect,
  processWorkstreamNotificationIntent,
} from "../services/workstream-regional-effect-service";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import { consumeWorkstreamBatchUpdate } from "../services/workstream-batch-update";
import { WorkstreamService } from "../services/workstream-service";

interface ActivityRow {
  id: string;
  workspace_id: string;
  workspace_region: "global" | "eu";
  connection_id: string;
  connector_type: string;
  connection_scope: "personal" | "workspace";
  connection_owner_user_id: string | null;
  provider: string;
  provider_event_id: string;
  event_type: string;
  resource_type: string | null;
  provider_resource_id: string | null;
  payload_ref: string | null;
  actor_json: string;
  subject_json: string;
  occurred_at: string;
  received_at: string;
  title: string;
  summary: string;
  text_snippet: string;
  visibility_json: string;
  target_user_ids_json: string;
  entity_keys_json: string;
  dedupe_key: string;
  raw_content_hash: string | null;
  metadata_json: string;
  external_people_json: string;
  processing_status: "pending" | "processing" | "processed" | "failed";
}



const routingJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidateWorkstreamId: { type: ["string", "null"], format: "uuid" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
    matchedEntities: { type: "array", items: { type: "string" } },
    suggest: { type: "boolean" }
  },
  required: ["candidateWorkstreamId", "confidence", "reason", "matchedEntities", "suggest"]
};

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return z.record(z.string(), z.unknown()).parse(parsed);
  } catch {
    return {};
  }
}

function parseStrings(value: string): string[] {
  try {
    return z.array(z.string()).parse(JSON.parse(value));
  } catch {
    return [];
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesFilters(activity: ActivityRow, filters: Record<string, unknown>): boolean {
  const metadata = parseRecord(activity.metadata_json);
  const available: Record<string, unknown> = {
    provider: activity.provider,
    connectorType: activity.connector_type,
    eventType: activity.event_type,
    resourceType: activity.resource_type,
    providerResourceId: activity.provider_resource_id,
    ...metadata
  };
  return Object.entries(filters).every(([key, expected]) => deepEqual(available[key], expected));
}


/** Cloudflare Queue entrypoint for control effects and connector events. */
export async function consumeActivityQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  await Promise.all(batch.messages.map((message) => consumeOne(message, env)));
}

export const activityQueueConsumer = consumeActivityQueue;

/** Repairs the commit-before-queue-send window for every connector ingress. */
export async function recoverPendingActivityQueue(env: Env, limit = 100): Promise<number> {
  // Post-cutover the Queue payload is the handoff and WorkspaceDO owns retry
  // state. This scan exists only for an interrupted legacy D1 deployment.
  if (env.WORKSPACE_DOS) return 0;
  const staleBefore = new Date(Date.now() - 60_000).toISOString();
  const pending = await env.DB.prepare(
    `SELECT a.id, a.workspace_id, w.region, a.processing_status,
            CAST(COALESCE(json_extract(a.metadata_json, '$._connector_event_attempt'), -1) AS INTEGER) AS connector_event_attempt
     FROM activities a
     JOIN workspaces w ON w.id = a.workspace_id
     WHERE a.processing_status IN ('pending', 'failed') AND a.received_at <= ?
       AND (a.processing_status = 'pending'
         OR CAST(COALESCE(json_extract(a.metadata_json, '$._connector_event_attempt'), -1) AS INTEGER) < 5)
       AND w.region = ?
     ORDER BY a.received_at ASC, a.id ASC
     LIMIT ?`,
  ).bind(staleBefore, env.AVALON_REGION, Math.max(1, Math.min(limit, 100))).all<{
    id: string;
    workspace_id: string;
    region: "global" | "eu";
    processing_status: "pending" | "failed";
    connector_event_attempt: number;
  }>();
  if (pending.results.length === 0) return 0;
  await env.ACTIVITY_QUEUE.sendBatch(pending.results.map((activity) => ({
    body: ActivityQueueMessageSchema.parse({
      region: activity.region,
      workspaceId: activity.workspace_id,
      activityId: activity.id,
      attempt: activity.processing_status === "failed"
        ? Math.max(0, activity.connector_event_attempt + 1)
        : Math.max(0, activity.connector_event_attempt),
    }),
  })));
  return pending.results.length;
}

async function consumeOne(message: Message<unknown>, env: Env): Promise<void> {
  const externalDelivery = WorkspaceExternalEventDeliveryQueueMessageSchema.safeParse(message.body);
  if (externalDelivery.success) {
    const input = externalDelivery.data;
    if (input.region !== env.AVALON_REGION) {
      message.ack();
      return;
    }
    const workspace = await workspaceDirectory(env, input.workspaceId);
    const leaseId = uuidV7();
    try {
      const claim = await workspace.claimExternalEventDelivery({
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        workspaceEventId: input.workspaceEventId,
        deliveryId: input.deliveryId,
        payloadHash: input.payloadHash,
        leaseId,
      });
      if (claim.outcome === "delivered") {
        message.ack();
        return;
      }
      if (claim.outcome === "busy") {
        message.retry({ delaySeconds: Math.max(1, Math.ceil((claim.retryAt - Date.now()) / 1_000)) });
        return;
      }
      let delivered: boolean;
      let outcomeCode: string;
      if (claim.destination.kind === "automation") {
        const automation = await durableObjectStubForWorkspace(
          env,
          env.AUTOMATION_AGENTS,
          input.workspaceId,
          automationAgentName(
            input.region,
            input.workspaceId,
            asAutomationId(claim.destination.automationId),
          ),
        );
        const result = await automation.admitExternalEvent({
          schemaVersion: 1,
          automationId: claim.destination.automationId,
          workspaceId: input.workspaceId,
          authorityGeneration: claim.destination.authorityGeneration,
          workspaceEventId: input.workspaceEventId,
          eventSequence: claim.event.eventSequence,
          eventType: claim.event.eventType,
          occurredAt: claim.event.occurredAt,
          payloadHash: input.payloadHash,
        });
        delivered = result.admitted || result.outcomeCode === "automation_occurrence_replayed";
        outcomeCode = result.outcomeCode;
      } else {
        const substream = await durableObjectStubForWorkspace(
          env,
          env.SUBSTREAM_AGENTS,
          input.workspaceId,
          substreamAgentName(
            input.region,
            input.workspaceId,
            asWorkstreamId(claim.destination.workstreamId),
            asSubstreamId(claim.destination.substreamId),
          ),
        );
        const result = await substream.appendWatchedResourceEvent({
          schemaVersion: 1,
          workspaceId: input.workspaceId,
          workstreamId: claim.destination.workstreamId,
          substreamId: claim.destination.substreamId,
          resourceId: claim.destination.resourceId,
          authorityGeneration: claim.destination.authorityGeneration,
          deliveryId: input.deliveryId,
          event: claim.event,
        });
        delivered = result.outcome !== "refused";
        outcomeCode = result.code;
      }
      await workspace.settleExternalEventDelivery({
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        deliveryId: input.deliveryId,
        leaseId,
        outcome: delivered ? "delivered" : "not_delivered",
        outcomeCode,
      });
      message.ack();
    } catch (error) {
      logWarn(env, "external_event_delivery_failed", {
        workspace_id: input.workspaceId,
        connector_event_id: input.workspaceEventId,
        delivery_id: input.deliveryId,
        reason: diagnosticErrorCode(error, "external_event_delivery_failed"),
      });
      message.retry();
    }
    return;
  }
  const projectDefault = ProjectDefaultResourceQueueMessageSchema.safeParse(message.body);
  if (projectDefault.success) {
    const target = projectDefault.data;
    if (target.region !== env.AVALON_REGION) {
      message.ack();
      return;
    }
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      target.workspaceId,
      workspaceDOName(env.AVALON_REGION, target.workspaceId),
    );
    if (!await workspace.projectDefaultTargetCurrent(target)) {
      message.ack();
      return;
    }
    const actorIds = await workspace.projectDefaultTargetActors(target);
    if (actorIds.length === 0) {
      message.ack();
      return;
    }
    const member = await env.DB.prepare(
      `SELECT user_id, role FROM workspace_members
        WHERE workspace_id = ? AND status = 'active'
          AND user_id IN (${actorIds.map(() => "?").join(",")})
        ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END, user_id LIMIT 1`,
    ).bind(target.workspaceId, ...actorIds, target.requestedByUserId)
      .first<{ user_id: string; role: AuthContext["role"] }>();
    if (!member) {
      await workspace.failProjectDefaultTarget(target);
      message.ack();
      return;
    }
    const auth: AuthContext = {
      sessionId: `project-default:${target.projectId}:${target.defaultGeneration}`,
      userId: asUserId(member.user_id),
      workspaceId: target.workspaceId,
      region: env.AVALON_REGION,
      role: member.role,
      analyticsWorkspaceId: null,
      principal: "connector",
    };
    try {
      await new WorkstreamService(env, auth).attachResource(target.workstreamId, target.resourceId);
      await workspace.completeProjectDefaultTarget(target);
      message.ack();
    } catch {
      await workspace.recordProjectDefaultTargetFailure(target).catch(() => undefined);
      const attempts = Math.max(1, message.attempts);
      message.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6)) });
    }
    return;
  }
  if (await consumeWorkstreamBatchUpdate(message, env)) return;
  const regionalEffect = WorkstreamRegionalEffectQueueMessageSchema.safeParse(message.body);
  if (regionalEffect.success) {
    if (regionalEffect.data.region !== env.AVALON_REGION) {
      logInfo(env, "workstream_regional_effect_terminal", {
        workspace_id: regionalEffect.data.workspaceId,
        workstream_id: regionalEffect.data.workstreamId,
        message_id: regionalEffect.data.messageId,
        outcome: "skipped",
        reason: "region_mismatch",
        queue_attempts: message.attempts,
      });
      message.ack();
      return;
    }
    let effectKind: string | null = null;
    try {
      const envelope = await loadWorkstreamRegionalEffect(env, regionalEffect.data);
      if (!envelope) {
        // An already acknowledged DO outbox row no longer needs work, and the
        // replay receipt lives in WorkspaceDO beside the state it fenced —
        // there is nothing regional left to mark.
        logInfo(env, "workstream_regional_effect_terminal", {
          workspace_id: regionalEffect.data.workspaceId,
          workstream_id: regionalEffect.data.workstreamId,
          message_id: regionalEffect.data.messageId,
          outcome: "already_acknowledged",
          reason: "outbox_effect_missing",
          queue_attempts: message.attempts,
        });
        message.ack();
        return;
      }
      effectKind = envelope.effect.kind;
      if (isWorkspaceDirectoryEffect(envelope.effect)) {
        await applyQueuedWorkspaceDirectoryEffect(env, envelope);
        await acknowledgeWorkstreamOutboxEffect(env, envelope);
        logInfo(env, "workstream_regional_effect_terminal", {
          workspace_id: envelope.workspaceId,
          workstream_id: envelope.workstreamId,
          message_id: envelope.messageId,
          effect_kind: envelope.effect.kind,
          outcome: "applied",
          reason: "directory_effect_acknowledged",
          outbox_acknowledged: true,
          queue_attempts: message.attempts,
        });
        message.ack();
        return;
      }
      const applied = await applyWorkstreamRegionalEffect(env, envelope);
      let notificationOutcome: "delivered" | "skipped" | null = null;
      if (applied.notificationIntentId) {
        const outcome = await processWorkstreamNotificationIntent(
          env,
          regionalEffect.data.workspaceId,
          applied.notificationIntentId,
        );
        if (outcome === "busy") {
          logInfo(env, "workstream_regional_effect_deferred", {
            workspace_id: envelope.workspaceId,
            workstream_id: envelope.workstreamId,
            message_id: envelope.messageId,
            effect_kind: envelope.effect.kind,
            notification_intent_id: applied.notificationIntentId,
            reason: "notification_busy",
            queue_attempts: message.attempts,
            retry_delay_seconds: 30,
          });
          message.retry({ delaySeconds: 30 });
          return;
        }
        notificationOutcome = outcome;
      }
      await acknowledgeWorkstreamOutboxEffect(env, envelope);
      logInfo(env, "workstream_regional_effect_terminal", {
        workspace_id: envelope.workspaceId,
        workstream_id: envelope.workstreamId,
        message_id: envelope.messageId,
        effect_kind: envelope.effect.kind,
        outcome: notificationOutcome ?? "applied",
        reason: notificationOutcome ? "notification_terminal" : "effect_applied",
        notification_intent_id: applied.notificationIntentId,
        replayed: applied.replayed,
        outbox_acknowledged: true,
        queue_attempts: message.attempts,
      });
      message.ack();
    } catch (error) {
      logWarn(env, "workstream_regional_effect_processing_failed", {
        workspace_id: regionalEffect.data.workspaceId,
        workstream_id: regionalEffect.data.workstreamId,
        message_id: regionalEffect.data.messageId,
        effect_kind: effectKind,
        queue_attempts: message.attempts,
        reason: error instanceof Error ? error.message : "unknown",
      });
      const attempts = Math.max(1, message.attempts);
      message.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6)) });
    }
    return;
  }

  const slackIngress = SlackIngressQueueMessageSchema.safeParse(message.body);
  if (slackIngress.success) {
    if (slackIngress.data.region !== env.AVALON_REGION) {
      logInfo(env, "slack_ingress_queue_terminal", {
        workspace_id: slackIngress.data.workspaceId,
        job_id: slackIngress.data.jobId,
        outcome: "skipped",
        reason: "region_mismatch",
        queue_attempts: message.attempts,
      });
      message.ack();
      return;
    }
    try {
      await new SlackAgentService(env).processQueuedIngress(
        slackIngress.data.workspaceId,
        slackIngress.data.jobId,
      );
      logInfo(env, "slack_ingress_queue_terminal", {
        workspace_id: slackIngress.data.workspaceId,
        job_id: slackIngress.data.jobId,
        outcome: "processed",
        reason: "ingress_job_completed",
        queue_attempts: message.attempts,
      });
      message.ack();
    } catch (error) {
      logWarn(env, "slack_ingress_queue_processing_failed", {
        workspace_id: slackIngress.data.workspaceId,
        job_id: slackIngress.data.jobId,
        queue_attempts: message.attempts,
        reason: error instanceof Error ? error.message : "unknown",
      });
      const attempts = Math.max(1, message.attempts);
      const exponentialDelay = Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6));
      const providerDelay = Math.ceil((connectorRetryAfterMs(error) ?? 0) / 1_000);
      message.retry({ delaySeconds: Math.min(43_200, Math.max(exponentialDelay, providerDelay)) });
    }
    return;
  }

  // Processing retries intentionally carry no event body. WorkspaceDO became
  // authoritative at ingress, so claim returns the canonical event; copying it
  // here would retain content in retries/DLQ without eliminating this RPC.
  const connectorProcess = WorkspaceConnectorEventProcessQueueMessageSchema.safeParse(message.body);
  if (connectorProcess.success) {
    const input = connectorProcess.data;
    // `processingAttempt` is the legacy/redrive generation and remains bounded
    // by its own protocol. Queue delivery count is transport telemetry, not a
    // claim generation; WorkspaceDO returns a fresh lease for every acquisition.
    const processingAttempt = input.processingAttempt;
    if (input.region !== env.AVALON_REGION) {
      logInfo(env, "connector_event_process_terminal", {
        workspace_id: input.workspaceId,
        connector_event_id: input.eventId,
        processing_owner_id: input.processingOwnerId,
        processing_attempt: processingAttempt,
        outcome: "skipped",
        reason: "region_mismatch",
        queue_attempts: message.attempts,
      });
      message.ack();
      return;
    }
    try {
      const workspace = await workspaceDirectory(env, input.workspaceId);
      const claim = WorkspaceConnectorEventClaimResultSchema.parse(
        await workspace.claimConnectorEvent({
          workspaceId: input.workspaceId,
          eventId: input.eventId,
          processingOwnerId: input.processingOwnerId,
          attempt: processingAttempt,
          orchestrator: "queue",
        }),
      );
      logInfo(env, "connector_event_process_claim", {
        workspace_id: input.workspaceId,
        connector_event_id: input.eventId,
        processing_owner_id: input.processingOwnerId,
        processing_attempt: processingAttempt,
        queue_attempts: message.attempts,
        outcome: claim.outcome,
        processing_lease_id: claim.outcome === "claimed" ? claim.processingLeaseId : null,
        processing_lease_expires_at: claim.outcome === "claimed"
          ? claim.processingLeaseExpiresAt
          : claim.outcome === "busy"
            ? claim.retryAt
            : null,
      });
      if (claim.outcome === "processed") {
        logInfo(env, "connector_event_process_terminal", {
          workspace_id: input.workspaceId,
          connector_event_id: input.eventId,
          processing_owner_id: input.processingOwnerId,
          processing_attempt: processingAttempt,
          outcome: "already_processed",
          reason: "authoritative_event_already_settled",
          queue_attempts: message.attempts,
        });
        message.ack();
        return;
      }
      if (claim.outcome === "busy") {
        if (claim.retryAt === null) {
          logInfo(env, "connector_event_process_terminal", {
            workspace_id: input.workspaceId,
            connector_event_id: input.eventId,
            processing_owner_id: input.processingOwnerId,
            processing_attempt: processingAttempt,
            outcome: "skipped",
            reason: claim.reason,
            queue_attempts: message.attempts,
          });
          message.ack();
          return;
        }
        const retryDelaySeconds = Math.max(1, Math.ceil((claim.retryAt - Date.now()) / 1_000));
        logInfo(env, "connector_event_process_deferred", {
          workspace_id: input.workspaceId,
          connector_event_id: input.eventId,
          processing_owner_id: input.processingOwnerId,
          processing_attempt: processingAttempt,
          outcome: "busy",
          reason: claim.reason,
          queue_attempts: message.attempts,
          retry_at: claim.retryAt,
          retry_delay_seconds: retryDelaySeconds,
        });
        message.retry({ delaySeconds: retryDelaySeconds });
        return;
      }

      try {
        await processConnectorEvent(env, claim.event);
        const matched = await workspace.matchExternalEventDestinations({
          workspaceId: input.workspaceId,
          eventId: input.eventId,
        });
        await Promise.all(matched.deliveries.map((delivery) => env.ACTIVITY_QUEUE.send(delivery)));
      } catch (error) {
        const errorCode = diagnosticErrorCode(error, "connector_event_processing_failed");
        const reason = error instanceof Error
          ? error.message.slice(0, 1_000)
          : "connector_event_processing_failed";
        await workspace.settleConnectorEvent({
          workspaceId: input.workspaceId,
          eventId: input.eventId,
          processingOwnerId: input.processingOwnerId,
          processingLeaseId: claim.processingLeaseId,
          outcome: "failed",
          error: reason,
        });
        const attempts = Math.max(1, message.attempts);
        const retryDelaySeconds = Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6));
        logWarn(env, "connector_event_process_failed", {
          workspace_id: input.workspaceId,
          connector_type: claim.event.connectorType,
          connection_id: claim.event.activity.connectionId,
          connector_event_id: input.eventId,
          processing_owner_id: input.processingOwnerId,
          processing_lease_id: claim.processingLeaseId,
          processing_attempt: processingAttempt,
          outcome: "failed",
          reason: errorCode,
          error_name: error instanceof Error ? error.name : typeof error,
          queue_attempts: message.attempts,
          retry_delay_seconds: retryDelaySeconds,
        });
        message.retry({ delaySeconds: retryDelaySeconds });
        return;
      }

      await workspace.settleConnectorEvent({
        workspaceId: input.workspaceId,
        eventId: input.eventId,
        processingOwnerId: input.processingOwnerId,
        processingLeaseId: claim.processingLeaseId,
        outcome: "processed",
        error: null,
      });
      logInfo(env, "connector_event_process_terminal", {
        workspace_id: input.workspaceId,
        connector_type: claim.event.connectorType,
        connection_id: claim.event.activity.connectionId,
        connector_event_id: input.eventId,
        processing_owner_id: input.processingOwnerId,
        processing_lease_id: claim.processingLeaseId,
        processing_attempt: processingAttempt,
        outcome: "processed",
        reason: "authoritative_event_settled",
        queue_attempts: message.attempts,
      });
      message.ack();
    } catch (error) {
      const attempts = Math.max(1, message.attempts);
      const retryDelaySeconds = Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6));
      logWarn(env, "connector_event_process_delivery_failed", {
        workspace_id: input.workspaceId,
        connector_event_id: input.eventId,
        processing_owner_id: input.processingOwnerId,
        processing_attempt: processingAttempt,
        reason: diagnosticErrorCode(error, "connector_event_process_delivery_failed"),
        error_name: error instanceof Error ? error.name : typeof error,
        queue_attempts: message.attempts,
        retry_delay_seconds: retryDelaySeconds,
      });
      message.retry({ delaySeconds: retryDelaySeconds });
    }
    return;
  }

  const connectorIngress = WorkspaceConnectorEventQueueMessageSchema.safeParse(message.body);
  if (connectorIngress.success) {
    const input = connectorIngress.data;
    if (input.region !== env.AVALON_REGION) {
      logInfo(env, "connector_event_queue_terminal", {
        workspace_id: input.request.workspaceId,
        connector_type: input.request.event.connectorType,
        ingress_event_id: input.request.ingressEventId,
        outcome: "skipped",
        reason: "region_mismatch",
        queue_attempts: message.attempts,
      });
      message.ack();
      return;
    }
    try {
      const admission = await admitConnectorEvent(env, input.request, input.attempt);
      logInfo(env, "connector_event_queue_terminal", {
        workspace_id: input.request.workspaceId,
        connector_type: input.request.event.connectorType,
        ingress_event_id: input.request.ingressEventId,
        connector_event_id: admission.accepted.eventId,
        duplicate: admission.accepted.duplicate,
        prior_processing_status: admission.accepted.processingStatus,
        processing_attempt: admission.processingAttempt,
        processing_owner_id: admission.processingOwnerId,
        processing_outcome: admission.processingOutcome,
        outcome: "admitted",
        reason: "workspace_event_committed",
        queue_attempts: message.attempts,
      });
      message.ack();
    } catch (error) {
      logWarn(env, "connector_event_queue_admission_failed", {
        workspace_id: input.request.workspaceId,
        connector_type: input.request.event.connectorType,
        ingress_event_id: input.request.ingressEventId,
        requested_attempt: input.attempt,
        queue_attempts: message.attempts,
        reason: diagnosticErrorCode(error, "connector_event_admission_failed"),
        error_name: error instanceof Error ? error.name : typeof error,
      });
      const attempts = Math.max(1, message.attempts);
      message.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6)) });
    }
    return;
  }

  // The legacy ID-only handoff. A maintenance cutover drained it before opening
  // WorkspaceDO authority, and nothing has enqueued one since — but a message
  // that was already in flight then can still arrive, and it is acked rather
  // than left to redeliver forever. Reading the frozen D1 source row behind it
  // would reintroduce a second connector-event authority.
  const legacyActivity = ActivityQueueMessageSchema.safeParse(message.body);
  logInfo(env, "connector_event_queue_terminal", {
    workspace_id: legacyActivity.success ? legacyActivity.data.workspaceId : null,
    connector_event_id: legacyActivity.success ? legacyActivity.data.activityId : null,
    outcome: "skipped",
    reason: "legacy_message_after_cutover",
    queue_attempts: message.attempts,
  });
  message.ack();
}

async function admitConnectorEvent(
  env: Env,
  request: Parameters<Awaited<ReturnType<typeof workspaceDirectory>>["ingestConnectorEvent"]>[0],
  requestedAttempt: number,
) {
  const workspace = await workspaceDirectory(env, request.workspaceId);
  const accepted = await workspace.ingestConnectorEvent(request);
  const processingAttempt = accepted.processingStatus === "processing"
    ? accepted.processingAttempt
    : accepted.processingStatus === "failed"
      ? Math.max(requestedAttempt, accepted.processingAttempt + 1)
      : Math.max(0, requestedAttempt);
  const recordedAttempt = Math.min(processingAttempt, 5);
  let processingOwnerId: string | null = null;
  let processingOutcome: "enqueued" | "active_processing" | "already_processed" | "attempts_exhausted";
  if (
    (accepted.processingStatus === "pending" || accepted.processingStatus === "failed")
    && processingAttempt <= 5
  ) {
    processingOwnerId = uuidV7();
    await enqueueWorkspaceConnectorEventProcess(env, {
      region: env.AVALON_REGION,
      workspaceId: request.workspaceId,
      eventId: accepted.eventId,
      processingOwnerId,
      processingAttempt: recordedAttempt,
    });
    processingOutcome = "enqueued";
  } else if (accepted.processingStatus === "processing") {
    processingOutcome = "active_processing";
  } else {
    processingOutcome = accepted.processingStatus === "processed"
      ? "already_processed"
      : "attempts_exhausted";
  }
  return { accepted, processingAttempt, recordedAttempt, processingOwnerId, processingOutcome };
}

/** The Queue consumer's idempotent product processing step; legacy Workflow also drains through it. */
export async function processConnectorEvent(
  env: Env,
  event: WorkspaceConnectorEvent
): Promise<void> {
  const activity = activityRowFromWorkspaceEvent(event);
  env = withWorkspaceRuntimeDatabase(env, activity.workspace_id);
  // WorkspaceDO's typed registration index is the only automation/watch
  // fan-out. The old D1 scans were a second matcher with stale authority.
  // Contextual routing is therefore all this step still decides, and the
  // opportunity is enqueued whenever it declines.
  const routedContextually = SUGGESTED_CONTEXT_ENABLED
    ? await routeContextually(env, activity)
    : false;
  if (!routedContextually) {
    await enqueueActivityOpportunity(env, activity.id, asWorkspaceId(activity.workspace_id));
  }
  await projectActivityEvent(env, activity);
  logInfo(env, "connector_event_processing_completed", {
    workspace_id: activity.workspace_id,
    connection_id: activity.connection_id,
    connector_type: activity.connector_type,
    provider: activity.provider,
    connector_event_id: activity.id,
    routed_contextually: routedContextually,
    opportunity_enqueued: !routedContextually,
    outcome: "processed",
  });
}

function activityRowFromWorkspaceEvent(event: WorkspaceConnectorEvent): ActivityRow {
  const activity = event.activity;
  return {
    id: activity.id,
    workspace_id: activity.workspaceId,
    workspace_region: activity.region,
    connection_id: activity.connectionId,
    connector_type: event.connectorType,
    connection_scope: activity.connectionScope,
    connection_owner_user_id: activity.connectionOwnerUserId,
    provider: activity.provider,
    provider_event_id: activity.providerEventId,
    event_type: activity.eventType,
    resource_type: activity.resourceType,
    provider_resource_id: activity.providerResourceId,
    payload_ref: activity.payloadRef,
    actor_json: JSON.stringify(activity.actor),
    subject_json: JSON.stringify(activity.subject),
    occurred_at: activity.occurredAt,
    received_at: activity.receivedAt,
    title: activity.title,
    summary: activity.summary,
    text_snippet: activity.textSnippet,
    visibility_json: JSON.stringify(activity.visibility),
    target_user_ids_json: JSON.stringify(activity.targetUserIds),
    entity_keys_json: JSON.stringify(activity.entityKeys),
    dedupe_key: activity.dedupeKey,
    raw_content_hash: activity.rawContentHash,
    metadata_json: JSON.stringify(activity.metadata),
    external_people_json: JSON.stringify(activity.externalPeople ?? []),
    processing_status: "processing",
  };
}

/**
 * Projects a processed connector activity into the first-party activity log.
 *
 * It happens here, after routing, rather than at ingest: an activity is only
 * something a person should hear about once it has survived verification and
 * routing, and `activities` rows are rewritten during processing. The
 * connection's own scope is the audience — a personal connection speaks only to
 * its owner, a workspace-wide one to the whole workspace — which is the same
 * rule the rest of the product already applies to connector data.
 */
async function projectActivityEvent(env: Env, activity: ActivityRow): Promise<void> {
  // The same rule the rest of the consumer applies, rather than a second one:
  // null means the whole workspace may see it, an empty list means nobody may,
  // and a populated list names exactly who may. A Slack private channel or DM
  // arrives on a workspace-wide connection but is restricted to the people in
  // it, so `connection_scope` alone is not the audience.
  const restrictedUserIds = restrictedActivityUserIds(activity);
  if (restrictedUserIds?.length === 0) return;

  const digestible = activityIsDigestible(env, activity);
  const shared = {
    digestible,
    workspaceId: asWorkspaceId(activity.workspace_id),
    eventType: `connector.${activity.provider}.${activity.event_type}`,
    subjectType: activity.resource_type ?? "connector_activity",
    subjectId: activity.provider_resource_id ?? activity.id,
    actorType: "external" as const,
    actorLabel: connectorActorLabel(activity),
    title: activity.title,
    body: activity.summary || activity.text_snippet,
    canonicalUrl: connectorOriginUrl(parseRecord(activity.metadata_json)),
    occurredAt: activity.occurred_at,
    sourceKind: "activity",
    sourceId: activity.id,
    metadata: { provider: activity.provider, connectorType: activity.connector_type },
  };

  if (!restrictedUserIds) {
    await recordActivityEvent(env, {
      ...shared,
      audience: { kind: "workspace" },
      dedupeKey: `activity:${activity.id}`,
      // The provider already told us who it concerns; `target_user_ids_json`
      // holds the Avalon users it resolved to.
      targets: parseStrings(activity.target_user_ids_json).map((userId) => ({ userId, relation: "involved" })),
    });
    return;
  }

  // A restricted activity becomes one event per permitted reader. `audience`
  // names a single user by design — a set-valued audience would need a join
  // table to answer the one question this table exists to answer quickly — and
  // these lists are small, because they come from a mention or a private
  // conversation's membership.
  for (const userId of restrictedUserIds) {
    await recordActivityEvent(env, {
      ...shared,
      audience: { kind: "user", userId },
      dedupeKey: `activity:${activity.id}:${userId}`,
      targets: [{ userId, relation: "involved" }],
    });
  }
}

/**
 * Whether this connector activity may be read back to a person in a digest.
 *
 * This answers the digest question only. Contextual routing reads the same
 * declaration through `declaredConfidenceFloor`, which treats it as a prior
 * rather than a verdict and reaches a different answer on purpose; do not merge
 * the two.
 *
 * The connector's manifest is the authority, keyed on the event type — the one
 * thing an activity durably carries all the way from the provider to the log.
 * A polling stream may additionally withhold its own output, and says so
 * through the metadata the poll host stamps; a stream can only ever subtract,
 * so the two declarations cannot contradict each other into a digest.
 *
 * Everything unknown is withheld. An unregistered connector in this region, a
 * manifest that has dropped an event type it used to emit, an activity from a
 * connector that predates the declaration — none of those are somebody
 * confirming that a person wants this in their inbox, and the cost of being
 * wrong runs one way only: a withheld event is still logged, still routes, and
 * still triggers automations.
 */
function activityIsDigestible(env: Env, activity: ActivityRow): boolean {
  if (parseRecord(activity.metadata_json)[ACTIVITY_STREAM_NOT_DIGESTIBLE_METADATA_KEY] === true) {
    return false;
  }
  try {
    return connectorRegistryForEnv(env)
      .get(activity.connector_type)
      .manifest.digestibleActivityTypes
      .includes(activity.event_type);
  } catch (error) {
    // Two very different things reach here, and only one of them is ordinary.
    //
    // `unsupported_capability` is a connector this region does not register —
    // expected, and withholding is the whole point of failing closed. Anything
    // else means the registry could not be built at all: one malformed
    // credential fails every adapter, which would withhold *every* connector's
    // activity region-wide, settle every digest as empty, and advance every
    // cursor over the discarded windows. That is indistinguishable from a quiet
    // week unless it says so, so it is logged rather than swallowed.
    if (!(error instanceof ConnectorError) || error.code !== "unsupported_capability") {
      logWarn(env, "connector_registry_unavailable_for_digestibility", {
        workspace_id: activity.workspace_id,
        connector_type: activity.connector_type,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
    return false;
  }
}

function connectorActorLabel(activity: ActivityRow): string {
  const displayName = parseRecord(activity.actor_json).displayName;
  if (typeof displayName === "string" && displayName.length > 0) return displayName;
  return activity.provider;
}

/**
 * Where an event type's confidence bar starts, before this workspace has said
 * anything about it.
 *
 * The manifest's digestibility partition is the only standing judgement about
 * an event type that exists, so it is worth reading — but it answers a
 * different question ("should somebody be told this on a schedule"), and it is
 * read here as a prior rather than a veto. An empty `digestible` list is the
 * absence of a judgement rather than a negative one: the generic webhook
 * classifies nothing as news because Avalon cannot parse what a caller posts,
 * which says nothing at all about whether that payload belongs in a work
 * stream. A connector that drew no line gets no prior.
 *
 * A registry that cannot answer leaves the bar at the base. Withholding is
 * right when the question is "may this reach somebody's inbox" and wrong here,
 * where the cost of a missing answer would be one misconfigured credential
 * silently disabling contextual routing for a whole region.
 */
function declaredConfidenceFloor(env: Env, activity: ActivityRow): number {
  try {
    const digestible = connectorRegistryForEnv(env)
      .get(activity.connector_type)
      .manifest
      .digestibleActivityTypes;
    if (digestible.length === 0) return BASE_CONFIDENCE_FLOOR;
    return digestible.includes(activity.event_type)
      ? BASE_CONFIDENCE_FLOOR
      : OPERATIONAL_CONFIDENCE_FLOOR;
  } catch {
    // `activityIsDigestible` logs the same failure for the same activity a few
    // steps later, on the projection path; a second line would only double it.
    return BASE_CONFIDENCE_FLOOR;
  }
}

/**
 * The speculative half of routing: no watch and no automation asked for this
 * activity, so a model is asked whether one of the work streams a person is
 * already using is about it, and a card offering the attachment is written if
 * it says yes.
 *
 * Nothing here is asked for, which is why every gate below withholds rather
 * than admits. `docs/contextual-routing.md` owns the whole of it.
 */
async function routeContextually(
  env: Env,
  activity: ActivityRow,
): Promise<boolean> {
  if (!env.OPENROUTER_API_KEY) return false;

  const admission = await suggestionAdmission(env, {
    workspaceId: asWorkspaceId(activity.workspace_id),
    provider: activity.provider,
    eventType: activity.event_type,
    declaredFloor: declaredConfidenceFloor(env, activity),
  });
  // Asked before the candidates are selected and before the model is called: an
  // event type this workspace has only ever dismissed cannot produce a card at
  // any confidence, so buying an inference to discover that is pure waste.
  if (admission.suppressed) {
    // Suppression is invisible from the outside — the absence of a card looks
    // exactly like a model that declined. Logged at debug rather than info
    // because it fires once per ingested activity: a suppressed high-volume
    // type would otherwise write thousands of identical lines a day at the
    // production log level. `docs/contextual-routing.md` has the query that
    // answers the same question from the rows.
    logDebug(env, "contextual_routing_event_type_suppressed", {
      workspace_id: activity.workspace_id,
      provider: activity.provider,
      event_type: activity.event_type,
      dismissed: admission.dismissed,
      dismissers: admission.dismissers,
    });
    return false;
  }
  const restrictedUserIds = restrictedActivityUserIds(activity);
  if (restrictedUserIds?.length === 0) return false;
  const sourceAudience = restrictedUserIds === null
    ? { scope: "workspace" as const }
    : { scope: "users" as const, userIds: restrictedUserIds };
  // The dismissal run and the already-routed exclusion the D1 arm expressed as
  // subqueries are the object's now; the shape it returns is mapped to the
  // candidate rows the prompt renderer takes.
  //
  // Nothing to exclude from here any more. The exclusion used to be the
  // work streams this same invocation had just routed the activity into
  // directly, from the consumer's own D1 watch scan — and that fan-out is
  // WorkspaceDO's typed registration index now, so the object is the only
  // side that knows what it already routed. An empty list is stated rather
  // than dropped so the call still says which side owns the question.
  const candidates = await (await workspaceDirectory(env, asWorkspaceId(activity.workspace_id)))
    .routingCandidates({
      workspaceId: activity.workspace_id,
      audience: sourceAudience,
      excludedWorkstreamIds: [],
      feedbackSince: dismissalRunCutoff(),
      dismissalLimit: DISMISSAL_RUN_LIMIT,
      limit: 12,
    }).then((result) => ({ results: result.items.map((item) => ({
      id: item.workstreamId,
      title: item.title,
      objective: item.description,
      last_activity_at: item.lastActivityAt,
    })) }));
  const eligible = candidates.results;
  if (eligible.length === 0) return false;

  const { result } = await runStructuredInference(env, {
    role: "activity_structured",
    context: { workspaceId: activity.workspace_id },
    messages: renderActivityRoutingMessages({
      activity: {
        provider: activity.provider,
        eventType: activity.event_type,
        title: activity.title,
        summary: activity.summary,
        textSnippet: activity.text_snippet.slice(0, 2_000),
        entityKeys: parseStrings(activity.entity_keys_json),
      },
      candidates: eligible.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        objective: candidate.objective.slice(0, 1_000),
        lastActivityAt: candidate.last_activity_at,
      })),
    }),
    schemaName: "activity_workstream_route",
    jsonSchema: routingJsonSchema,
    parse: (value) => ActivityRoutingResultSchema.parse(value)
  });

  // The floor is the event type's own record in this workspace rather than a
  // constant. `confidence` is the model grading its own answer, so it is not
  // evidence about a type whose past high-confidence matches were all dismissed
  // — raising the bar under it is the only thing that reaches that case.
  if (!result.suggest || result.confidence < admission.confidenceFloor || !result.candidateWorkstreamId) return false;
  if (!eligible.some((candidate) => candidate.id === result.candidateWorkstreamId)) return false;
  await createActivitySuggestion(env, {
    region: activity.workspace_region,
    workspaceId: asWorkspaceId(activity.workspace_id),
    activityId: activity.id,
    activityTitle: activity.title,
    activitySummary: activity.summary,
    workstreamId: asWorkstreamId(result.candidateWorkstreamId),
    confidence: result.confidence,
    reason: result.reason,
    matchedEntities: result.matchedEntities,
    source: "contextual_routing",
    sourceAudience,
  });
  return true;
}

function workspaceDirectory(env: Env, workspaceId: WorkspaceId) {
  return durableObjectStubForWorkspace(
    env,
    env.WORKSPACE_DOS,
    workspaceId,
    workspaceDOName(env.AVALON_REGION, workspaceId),
  );
}

export const __testing = {
  matchesFilters,
  projectActivityEvent,
  restrictedActivityUserIds,
  routeContextually,
  contentAudienceContainsWorkstream,
};
