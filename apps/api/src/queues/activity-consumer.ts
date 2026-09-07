import { SearchDocumentJobSchema, publishSearchIndexingJobs, SearchEmbeddingBatchSchema, type SearchSourceReference } from '../services/search-indexing-jobs';
import { embedSearchDocuments } from '../services/search-embedding';
import { workspaceSearchIndex, searchChunkIdentity } from '../services/text-search';
import { ResourceSearchProjectionSchema } from '../durable-objects/resource-search-projection';
import { SearchProjectionMessageSchema } from '../durable-objects/search-projection-outbox';
import { createSearchIndexingPipeline, indexSemanticBatch } from '../services/search-indexing-pipeline';
import { ConnectorError, connectorOriginUrl, connectorRetryAfterMs } from "@rally/connectors";
import {
  ACTIVITY_STREAM_NOT_DIGESTIBLE_METADATA_KEY,
  ActivityQueueMessageSchema,
  SlackIngressQueueMessageSchema,
  WorkspaceExternalEventDeliveryQueueMessageSchema,
  asAutomationId,
  asSubstreamId,
  asWorkspaceId,
  asUserId,
  WorkspaceExternalEventMatchResultSchema,
  type WorkspaceId
} from "@rally/contracts";
import { z } from "zod";

import { EffectQueueMessageSchema } from "@rally/contracts/conversation-effects";
import { ProjectDefaultResourceQueueMessageSchema } from "../durable-objects/workspace-project-protocol";
import { automationDOName, conversationObjectName, workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceConnectorEventClaimResultSchema,
  WorkspaceConnectorEventProcessQueueMessageSchema,
  WorkspaceConnectorEventQueueMessageSchema,
  type WorkspaceConnectorEvent,
} from "../durable-objects/workspace-connector-event-protocol";
import type { Env } from "../env";
import type { AuthContext } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { SlackAgentService } from "../services/slack-agent-service";
import { enqueueActivityOpportunity } from "../services/work-opportunity-batching";
import { recordActivityEvent } from "../services/activity-event-service";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { restrictedActivityUserIds } from "../lib/activity-visibility";
import {
  MAX_CONNECTOR_EVENT_QUEUE_BYTES,
  enqueueWorkspaceConnectorEventProcess,
} from "../services/workspace-connector-event-ingress";
import {
  applyQueuedWorkspaceDirectoryEffect,
  applyWorkstreamRegionalEffect,
  processWorkstreamNotificationIntent,
} from "../services/conversation-effect-service";
import { conversationParentStub } from "../services/conversation-parent-client";
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


const SearchChildJobTypeSchema = z.object({ type: z.literal('search_embedding_batch_v1') });

/** Cloudflare Queue entrypoint for control effects and connector events. */
export async function consumeActivityQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  const indexSearch = createSearchIndexingPipeline(env);
  const isSearch = (message: Message<unknown>) =>
    SearchChildJobTypeSchema.safeParse(message.body).success
    || ResourceSearchProjectionSchema.safeParse(message.body).success
    || SearchProjectionMessageSchema.safeParse(message.body).success;
  // Search shares a tokenizer and processes one document source at a time.
  // Unrelated control effects do not wait behind embedding provider calls.
  await Promise.all([
    Promise.all(batch.messages.filter((message) => !isSearch(message))
      .map((message) => consumeOne(message, env, indexSearch))),
    (async () => {
      for (const message of batch.messages.filter(isSearch)) {
        try { await consumeOne(message, env, indexSearch); }
        catch (error) {
          logWarn(env, 'search_indexing_retry', { region: env.AVALON_REGION, queue_attempts: message.attempts,
            error_code: diagnosticErrorCode(error, 'search_indexing_failed') });
          message.retry();
        }
      }
    })(),
  ]);
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

async function loadSearchSource(env: Env, reference: SearchSourceReference, captureLinks = true, documentId?: string) {
  if (reference.type === 'resource_search_projection_v1') {
    const stub = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, reference.workspaceId,
      workspaceDOName(reference.region, reference.workspaceId));
    return documentId === undefined ? stub.prepareResourceSearch(reference) : stub.prepareResourceSearchDocument(reference, documentId);
  }
  const stub = await durableObjectStubForWorkspace(env, env.SUBSTREAM_AGENTS, reference.workspaceId,
    conversationObjectName(reference.region, reference.workspaceId, reference.parentId, reference.substreamId));
  return documentId === undefined ? stub.prepareSearchTurn(reference, captureLinks)
    : stub.prepareSearchTurnDocument(reference, documentId, captureLinks);
}

async function consumeOne(message: Message<unknown>, env: Env,
  indexSearch: ReturnType<typeof createSearchIndexingPipeline>): Promise<void> {
  const documentJob = SearchDocumentJobSchema.safeParse(message.body);
  if (documentJob.success) {
    const job = documentJob.data;
    if (job.reference.region !== env.AVALON_REGION) throw new Error('search_projection_region_mismatch');
    await indexSearch(job.reference, (captureLinks = true) => loadSearchSource(env, job.reference, captureLinks, job.documentId));
    message.ack();
    return;
  }
  const embeddingBatch = SearchEmbeddingBatchSchema.safeParse(message.body);
  const childType = SearchChildJobTypeSchema.safeParse(message.body);
  if (!embeddingBatch.success && childType.success) {
    throw new Error(z.object({ phase: z.literal('document') }).safeParse(message.body).success
      ? 'invalid_search_document_job' : 'invalid_search_embedding_batch');
  }
  if (embeddingBatch.success) {
    const job = embeddingBatch.data;
    if (job.reference.region !== env.AVALON_REGION) throw new Error('search_projection_region_mismatch');
    if (job.chunkPolicy !== searchChunkIdentity()) {
      // A policy change requires one canonical-source backfill for the new
      // namespace. N obsolete children must not schedule N duplicate replans.
      message.ack();
      return;
    }
    const outcome = await indexSemanticBatch(await workspaceSearchIndex(env, job.reference.workspaceId), job,
      () => loadSearchSource(env, job.reference, false, job.document.id), (texts) => embedSearchDocuments(env, job.reference.workspaceId, texts));
    if (outcome === 'stale') logWarn(env, 'search_embedding_stale', { region: env.AVALON_REGION,
      workspace_id: job.reference.workspaceId, source: job.document.source, source_id: job.document.sourceId, revision: job.document.revision });
    message.ack();
    return;
  }
  const reference = ResourceSearchProjectionSchema.safeParse(message.body);
  const source = reference.success ? reference : SearchProjectionMessageSchema.safeParse(message.body);
  if (source.success) {
    if (source.data.region !== env.AVALON_REGION) throw new Error('search_projection_region_mismatch');
    // Source deliveries discover documents only. Capturing, tokenizing and
    // indexing each page happens in its own independently retriable delivery.
    const input = await loadSearchSource(env, source.data, false);
    await publishSearchIndexingJobs(env.ACTIVITY_QUEUE, input.documents.map((document) => ({
      type: 'search_embedding_batch_v1', phase: 'document', reference: source.data, documentId: document.id,
    })));
    if (input.retry) throw new Error('search_source_retry_required');
    message.ack();
    return;
  }
  const externalDelivery = WorkspaceExternalEventDeliveryQueueMessageSchema.safeParse(message.body);
  if (externalDelivery.success) {
    const input = externalDelivery.data;
    if (input.region !== env.AVALON_REGION) {
      message.ack();
      return;
    }
    // The message is the delivery: registration, destination and event travel
    // together, and the object it lands on is idempotent on the event and the
    // registration, so a redelivery finds its own receipt and does nothing.
    try {
      if (input.destination.kind === "automation") {
        const automation = await durableObjectStubForWorkspace(
          env,
          env.AUTOMATION_DOS,
          input.workspaceId,
          automationDOName(input.region, input.workspaceId, asAutomationId(input.destination.automationId)),
        );
        const result = await automation.admitExternalEvent({
          workspaceId: input.workspaceId,
          automationId: input.destination.automationId,
          registrationId: input.registrationId,
          event: input.event,
          payloadHash: input.payloadHash,
        });
        logInfo(env, "external_event_delivery_terminal", {
          workspace_id: input.workspaceId,
          connector_event_id: input.event.id,
          registration_id: input.registrationId,
          destination_kind: "automation",
          automation_id: input.destination.automationId,
          outcome: result.admitted ? "admitted" : "refused",
          reason: result.outcomeCode,
        });
      } else {
        const substream = await durableObjectStubForWorkspace(
          env,
          env.SUBSTREAM_AGENTS,
          input.workspaceId,
          conversationObjectName(
            input.region,
            input.workspaceId,
            input.destination.workstreamId,
            input.destination.substreamId === "0" ? "0" : asSubstreamId(input.destination.substreamId),
          ),
        );
        const result = await substream.appendWatchedResourceEvent({
          schemaVersion: 1,
          workspaceId: input.workspaceId,
          workstreamId: input.destination.workstreamId,
          substreamId: input.destination.substreamId,
          resourceId: input.destination.resourceId,
          registrationId: input.registrationId,
          event: input.event,
        });
        logInfo(env, "external_event_delivery_terminal", {
          workspace_id: input.workspaceId,
          connector_event_id: input.event.id,
          registration_id: input.registrationId,
          destination_kind: "workstream_resource_update",
          workstream_id: input.destination.workstreamId,
          outcome: result.outcome,
          reason: result.code,
        });
      }
      message.ack();
    } catch (error) {
      logWarn(env, "external_event_delivery_failed", {
        workspace_id: input.workspaceId,
        connector_event_id: input.event.id,
        registration_id: input.registrationId,
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
  const effect = EffectQueueMessageSchema.safeParse(message.body);
  if (effect.success) {
    await consumeEffect(message, effect.data, env);
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
      const reason = diagnosticErrorCode(error, "connector_event_admission_failed");
      logWarn(env, "connector_event_queue_admission_failed", {
        workspace_id: input.request.workspaceId,
        connector_type: input.request.event.connectorType,
        ingress_event_id: input.request.ingressEventId,
        requested_attempt: input.attempt,
        queue_attempts: message.attempts,
        reason,
        error_name: error instanceof Error ? error.name : typeof error,
      });
      // An event that reuses an identity with different content is refused
      // the same way on every delivery; retrying it only repeats the refusal
      // with backoff until the Queue gives up. It is terminal here.
      if (reason === "connector_event_identity_reused_with_different_content") {
        message.ack();
        return;
      }
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

/**
 * One effect message, at-least-once and unordered.
 *
 * A child's effect goes to its parent, a parent's to the workspace. Both
 * receivers keep receipts keyed by message id and payload hash, so a
 * redelivery is answered without being applied twice. The message is the
 * envelope: nothing is loaded back from the sender and nothing is
 * acknowledged to it, because the sender deleted its outbox row when the
 * Queue accepted the message.
 */
async function consumeEffect(
  message: Message<unknown>,
  envelope: z.infer<typeof EffectQueueMessageSchema>,
  env: Env,
): Promise<void> {
  const fields = {
    workspace_id: envelope.workspaceId,
    parent_kind: envelope.parentKind,
    workstream_id: envelope.parentId,
    message_id: envelope.messageId,
    effect_kind: envelope.effect.kind,
    queue_attempts: message.attempts,
  };
  if (envelope.region !== env.AVALON_REGION) {
    logInfo(env, "conversation_effect_terminal", { ...fields, outcome: "skipped", reason: "region_mismatch" });
    message.ack();
    return;
  }
  try {
    if (envelope.kind === "conversation_effect") {
      const parent = await conversationParentStub(env, envelope);
      await parent.receiveChildEffects({ substreamId: envelope.substreamId, envelopes: [envelope] });
      logInfo(env, "conversation_effect_terminal", {
        ...fields,
        substream_id: envelope.substreamId,
        outcome: "applied",
        reason: "parent_accepted",
      });
      message.ack();
      return;
    }
    if (envelope.effect.kind === "directory_common" || envelope.effect.kind === "directory_user") {
      await applyQueuedWorkspaceDirectoryEffect(env, envelope);
      logInfo(env, "conversation_effect_terminal", { ...fields, outcome: "applied", reason: "directory_effect_applied" });
      message.ack();
      return;
    }
    if (envelope.effect.kind === "directory_automation") {
      const workspace = await workspaceDirectory(env, envelope.workspaceId);
      await workspace.applyAutomationDirectory({ workspaceId: envelope.workspaceId, envelope });
      logInfo(env, "conversation_effect_terminal", { ...fields, outcome: "applied", reason: "automation_directory_applied" });
      message.ack();
      return;
    }
    const applied = await applyWorkstreamRegionalEffect(env, envelope);
    let notificationOutcome: "delivered" | "skipped" | null = null;
    if (applied.notificationIntentId) {
      const outcome = await processWorkstreamNotificationIntent(
        env,
        envelope.workspaceId,
        applied.notificationIntentId,
      );
      if (outcome === "busy") {
        logInfo(env, "conversation_effect_deferred", {
          ...fields,
          notification_intent_id: applied.notificationIntentId,
          reason: "notification_busy",
          retry_delay_seconds: 30,
        });
        message.retry({ delaySeconds: 30 });
        return;
      }
      notificationOutcome = outcome;
    }
    logInfo(env, "conversation_effect_terminal", {
      ...fields,
      outcome: notificationOutcome ?? "applied",
      reason: notificationOutcome ? "notification_terminal" : "effect_applied",
      notification_intent_id: applied.notificationIntentId,
      replayed: applied.replayed,
    });
    message.ack();
  } catch (error) {
    logWarn(env, "conversation_effect_processing_failed", {
      ...fields,
      reason: error instanceof Error ? error.message : "unknown",
    });
    const attempts = Math.max(1, message.attempts);
    message.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6)) });
  }
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
  // Match first and ask WorkspaceDO for its durable claim witness. The list of
  // deliveries is only the work still pending; a retry after those deliveries
  // settle must still know the activity was claimed and keep it out of
  // Suggested Work.
  const workspace = await workspaceDirectory(env, asWorkspaceId(activity.workspace_id));
  // Parsed on this side: the delivery carries the event's metadata, whose
  // open shape the RPC type system cannot name, so the stub's answer is
  // untyped until the contract reads it.
  const matched = WorkspaceExternalEventMatchResultSchema.parse(await workspace.matchExternalEventDestinations({
    workspaceId: activity.workspace_id,
    eventId: activity.id,
  }));
  const opportunity = matched.matched
    ? "claimed"
    : await enqueueActivityOpportunity(env, activity.id, asWorkspaceId(activity.workspace_id));
  await projectActivityEvent(env, activity);
  await Promise.all(matched.deliveries.map((delivery) => env.ACTIVITY_QUEUE.send(deliveryWithinQueueBound(env, delivery))));
  logInfo(env, "connector_event_processing_completed", {
    workspace_id: activity.workspace_id,
    connection_id: activity.connection_id,
    connector_type: activity.connector_type,
    provider: activity.provider,
    connector_event_id: activity.id,
    deterministic_route_claimed: matched.matched,
    deterministic_delivery_count: matched.deliveries.length,
    // What Suggested Work did with it, not merely whether it was offered: an
    // event whose type is excluded from candidacy is offered and declined.
    opportunity_enqueued: opportunity === "enqueued",
    opportunity_outcome: opportunity,
    outcome: "processed",
  });
}

/**
 * A delivery carries the event's snippet and metadata for the run to read. The
 * event itself fit the Queue's message bound on ingress, but a delivery adds
 * the destination and registration on top, so one near the bound is sent
 * without the content rather than not at all: the run still fires, and reads
 * from its opening that the content was too large to carry.
 */
function deliveryWithinQueueBound<T extends { event: { textSnippet: string; metadata: Record<string, unknown> } }>(
  env: Env,
  delivery: T,
): T {
  const bytes = new TextEncoder().encode(JSON.stringify(delivery)).byteLength;
  if (bytes <= MAX_CONNECTOR_EVENT_QUEUE_BYTES) return delivery;
  logWarn(env, "external_event_delivery_content_trimmed", {
    workspace_id: (delivery as { workspaceId?: string }).workspaceId ?? null,
    connector_event_id: (delivery.event as { id?: string }).id ?? null,
    payload_bytes: bytes,
  });
  return {
    ...delivery,
    event: { ...delivery.event, textSnippet: "", metadata: { contentTrimmed: true } },
  };
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
 * This answers the digest question only. Suggested Work reads the same activity
 * independently and must not inherit this notification choice.
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
};
