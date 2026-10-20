import { ConversationViewJobSchema } from "../durable-objects/conversation-view-projection";
import { ConnectorDeliveryReferenceSchema, readConnectorDeliveryReference, sendConnectorEventDelivery } from "../services/connector-queue-payload";
import { SidekickRunProvisionQueueMessageSchema } from "../durable-objects/automation-do-protocol";
import { provisionSidekickRun } from "../services/sidekick-run-provisioning";
import { publishAccessRevocation } from "../services/access-revocation";
import type { Region } from "@rally/contracts/regions";
import { ConnectorMaintenanceQueueSchema, runConnectorMaintenance } from "../services/connector-maintenance-service";
import { ConnectorInstallationQueueSchema, runConnectorInstallation } from "../services/connector-installation-service";
import { SearchAuthorizationPushJobSchema } from '../services/search-authorization';
import { SearchDocumentJobSchema, publishSearchIndexingJobs, SearchEmbeddingBatchSchema, type SearchSourceReference } from '../services/search-indexing-jobs';
import { embedSearchDocuments } from '../services/search-embedding';
import { workspaceSearchIndex, searchChunkIdentity } from '../services/text-search';
import { ResourceSearchProjectionSchema } from '../durable-objects/resource-search-projection';
import { SearchConversationProjectionMessageSchema, SearchProjectionMessageSchema } from '../durable-objects/search-projection-outbox';
import { AuthorizationProjectionJobSchema } from '../durable-objects/authorization-projection';
import { ChannelColorSyncMessageSchema } from "../durable-objects/channel-color-sync";
import { ThreadBackfillMessageSchema, type ThreadBackfillJob } from "../durable-objects/thread-backfill";
import { backfillSuggestion } from "../services/suggestion-backfill-service";
import { MemorySweepMessageSchema, runMemorySweep } from "../services/memory-sweep-service";
import { MemoryDigestSyncMessageSchema } from "../durable-objects/memory-digest-sync";
import { refreshMemoryDigestCopies } from "../services/memory-digest-service";
import { summarizeExistingDescription } from "../services/workstream-naming-service";
import { createIdentityObjectPort } from "../runtime/identity-port";
import { projectAuthorization } from '../services/authorization-projection-service';
import { createSearchIndexingPipeline, indexSemanticBatch } from '../services/search-indexing-pipeline';
import { projectConversationDisplay } from '../services/search-conversation-display';
import { ConnectorError, connectorOriginUrl, connectorRetryAfterMs } from "@rally/connectors";
import {
  ACTIVITY_STREAM_NOT_DIGESTIBLE_METADATA_KEY,
  ActivityQueueMessageSchema,
  SlackIngressQueueMessageSchema,
  WorkspaceExternalEventDeliveryQueueMessageSchema,
  asSubstreamId,
  asWorkspaceId,
  asUserId,
  WorkspaceExternalEventMatchResultSchema,
  type WorkspaceId,
} from "@rally/contracts";
import { z } from "zod";

import {
  ConversationEffectEnvelopeSchema,
  EffectQueueMessageSchema,
  ParentEffectEnvelopeSchema,
} from "@rally/contracts/conversation-effects";
import { codeShaped, zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import {
  SpaceBootstrapQueueMessageSchema,
  SpaceDefaultQueueMessageSchema,
  SpaceIntentResumeQueueMessageSchema,
} from "../durable-objects/workspace-space-protocol";
import { conversationObjectName, workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceConnectorEventClaimResultSchema,
  WorkspaceConnectorEventProcessQueueMessageSchema,
  WorkspaceConnectorEventQueueMessageSchema,
  type WorkspaceConnectorEvent,
} from "../durable-objects/workspace-connector-event-protocol";
import type { Env } from "../env";
import { runtimeDeferral } from "../lib/defer";
import { admitExternalEventWithSemanticGate } from "../services/semantic-trigger-admission";
import type { AuthContext } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { SlackAgentService } from "../services/slack-agent-service";
import { consumeGitHubDeliveryMessage, isGitHubDeliveryQueueMessage } from "../services/github-routing-service";
import { enqueueActivityOpportunity } from "../services/work-opportunity-batching";
import { recordActivityEvent } from "../services/activity-event-service";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
import { isRetirementRefusal } from "../durable-objects/object-retirement";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { restrictedActivityUserIds } from "../lib/activity-visibility";
import { admitConnectorEvent } from "../services/workspace-connector-event-ingress";
import {
  applyWorkstreamRegionalEffect,
  processWorkstreamNotificationIntent,
} from "../services/conversation-effect-service";
import { conversationParentStub } from "../services/conversation-parent-client";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import { consumeWorkstreamBatchUpdate } from "../services/workstream-batch-update";
import { SpaceBootstrapService, spaceBootstrapDriver } from "../services/space-bootstrap-service";
import { SpaceService } from "../services/space-service";
import { WorkstreamService } from "../services/workstream-service";
import { hostedParentStub } from "../services/conversation-parent-client";

/**
 * What each thread-backfill job does to one conversation, and the outcome it
 * logs. A job must be safe to run twice over the same conversation: a row
 * whose consumer failed part way is sent again whole.
 */
const THREAD_BACKFILL_HANDLERS: Record<ThreadBackfillJob, (env: Env, target: {
  workspaceId: string; workstreamId: string; substreamId: string;
}) => Promise<string>> = {
  description_summary: (env, target) => summarizeExistingDescription(env, target),
  suggestion_backfill: (env, target) => backfillSuggestion(env, target),
  conversation_view: async (env, target) => {
    const stub = await durableObjectStubForWorkspace(env, env.SUBSTREAM_AGENTS, target.workspaceId,
      conversationObjectName(env.AVALON_REGION, asWorkspaceId(target.workspaceId), target.workstreamId, asSubstreamId(target.substreamId)));
    return stub.backfillConversationView({ type: "conversation_view_v1", region: env.AVALON_REGION,
      workspaceId: target.workspaceId, parentId: target.workstreamId, substreamId: target.substreamId, turnId: "" });
  },
};

/**
 * The shape of a Project default delivery, kept only to recognize one.
 *
 * Projects are retired and their protocol module is gone; what survives is the
 * platform's retry window, during which a message published before the cutover
 * can still arrive. Matching on the discriminator and the two fields a log line
 * needs is the whole contract — there is nothing left to act on, so parsing the
 * rest would be describing a payload in order to throw it away.
 */
const RetiredProjectDefaultMessageSchema = z.object({
  type: z.literal("project_default_resource"),
  workspaceId: z.string(),
  workstreamId: z.string(),
});

interface ActivityRow {
  id: string;
  workspace_id: string;
  workspace_region: Region;
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
    || SearchProjectionMessageSchema.safeParse(message.body).success
    || SearchConversationProjectionMessageSchema.safeParse(message.body).success;
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
    region: Region;
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

async function discoverSearchDocuments(env: Env, reference: z.infer<typeof SearchProjectionMessageSchema>): Promise<string[]> {
  const stub = await durableObjectStubForWorkspace(env, env.SUBSTREAM_AGENTS, reference.workspaceId,
    conversationObjectName(reference.region, reference.workspaceId, reference.parentId, reference.substreamId));
  return z.array(z.string().min(1)).parse(await stub.searchTurnDocumentIds(reference));
}

async function loadSearchSource(env: Env, reference: SearchSourceReference, captureLinks: boolean, documentId: string) {
  if (reference.type === 'resource_search_projection_v1') {
    const stub = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, reference.workspaceId,
      workspaceDOName(reference.region, reference.workspaceId));
    return stub.prepareResourceSearchDocument(reference, documentId);
  }
  if (reference.type === 'channel_message_search_projection_v1') {
    // A Channel message is one document, so the id needs no selecting.
    const stub = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, reference.workspaceId,
      workspaceDOName(reference.region, reference.workspaceId));
    return stub.prepareChannelMessageSearch(reference);
  }
  const stub = await durableObjectStubForWorkspace(env, env.SUBSTREAM_AGENTS, reference.workspaceId,
    conversationObjectName(reference.region, reference.workspaceId, reference.parentId, reference.substreamId));
  return stub.prepareSearchTurnDocument(reference, documentId, captureLinks);
}

/**
 * A resource's or a Channel message's watermark, without extracting its
 * text. Every input of its search text bumps it (`resource-search-projection.ts`,
 * `channel-message-search-projection.ts`), so an equal revision is equal text. A turn has no such read: a link capture can
 * change a page's text at the same revision, so a turn is re-read in full.
 */
function searchSourceRevision(env: Env, reference: SearchSourceReference): (() => Promise<number | null>) | undefined {
  if (reference.type === 'channel_message_search_projection_v1') {
    return async () => {
      const stub = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, reference.workspaceId,
        workspaceDOName(reference.region, reference.workspaceId));
      return stub.channelMessageSearchRevision({ workspaceId: reference.workspaceId, messageId: reference.messageId });
    };
  }
  if (reference.type !== 'resource_search_projection_v1') return undefined;
  return async () => {
    const stub = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, reference.workspaceId,
      workspaceDOName(reference.region, reference.workspaceId));
    return stub.resourceSearchRevision({ workspaceId: reference.workspaceId, resourceId: reference.resourceId });
  };
}

async function consumeOne(message: Message<unknown>, env: Env,
  indexSearch: ReturnType<typeof createSearchIndexingPipeline>): Promise<void> {
  const viewJob = ConversationViewJobSchema.safeParse(message.body);
  if (viewJob.success) {
    const job = viewJob.data;
    if (job.region !== env.AVALON_REGION) { message.ack(); return; }
    try {
      const source = await durableObjectStubForWorkspace(env, env.SUBSTREAM_AGENTS, job.workspaceId,
        conversationObjectName(job.region, job.workspaceId, job.parentId, job.substreamId));
      const projection = await source.conversationViewProjection(job);
      if (projection) {
        const workspace = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, job.workspaceId,
          workspaceDOName(job.region, job.workspaceId));
        await workspace.applyConversationView(projection);
        if (job.dispatchRevision !== undefined) await source.completeConversationView({
          ...job, projectedRevision: projection.revision, generation: projection.generation,
        });
      }
      message.ack();
    } catch (error) {
      if (isRetirementRefusal(error)) { message.ack(); return; }
      logWarn(env, "conversation_view_delivery_failed", { workspace_id: job.workspaceId,
        reason: diagnosticErrorCode(error, "conversation_view_delivery_failed") });
      message.retry();
    }
    return;
  }
  const deliveryReference = ConnectorDeliveryReferenceSchema.safeParse(message.body);
  if (deliveryReference.success) {
    if (deliveryReference.data.delivery.region !== env.AVALON_REGION) { message.ack(); return; }
    let body;
    try {
      body = await readConnectorDeliveryReference(env, deliveryReference.data);
    } catch (error) {
      if (isRetirementRefusal(error)) { message.ack(); return; }
      logWarn(env, "connector_delivery_context_failed", { workspace_id: deliveryReference.data.delivery.workspaceId,
        error_code: diagnosticErrorCode(error, "connector_delivery_context_failed"), queue_attempts: message.attempts });
      message.retry();
      return;
    }
    // Normal processing retains exactly the inline message's ack/retry/error policy.
    await consumeOne({ id: message.id, timestamp: message.timestamp, attempts: message.attempts, body,
      ack: () => message.ack(), retry: (options) => message.retry(options) }, env, indexSearch);
    return;
  }
  if (isGitHubDeliveryQueueMessage(message.body)) {
    // A GitHub delivery the Global receiver verified and answered; routing it
    // to its regions happens here, off GitHub's ten-second clock.
    await consumeGitHubDeliveryMessage(message, env);
    return;
  }
  const searchAuthorizationJob = SearchAuthorizationPushJobSchema.safeParse(message.body);
  if (searchAuthorizationJob.success) {
    // Search no longer reads this store (phase 3 of
    // docs/PRDs/2026-09-26_search-audience-filtering); a push still in the
    // Queue from before the deploy is dropped rather than written.
    message.ack();
    return;
  }
  const authorizationJob = AuthorizationProjectionJobSchema.safeParse(message.body);
  if (authorizationJob.success) {
    try { await projectAuthorization(env, authorizationJob.data); message.ack(); }
    catch (error) {
      logWarn(env, 'authorization_projection_retry', { region: env.AVALON_REGION,
        error_code: diagnosticErrorCode(error, 'authorization_projection_failed') });
      message.retry();
    }
    return;
  }
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
      () => loadSearchSource(env, job.reference, false, job.document.id), (texts) => embedSearchDocuments(env, job.reference.workspaceId, texts),
      searchSourceRevision(env, job.reference));
    if (outcome === 'stale') logWarn(env, 'search_embedding_stale', { region: env.AVALON_REGION,
      workspace_id: job.reference.workspaceId, source: job.document.source, source_id: job.document.sourceId, revision: job.document.revision });
    message.ack();
    return;
  }
  const conversation = SearchConversationProjectionMessageSchema.safeParse(message.body);
  if (conversation.success) {
    const job = conversation.data;
    if (job.region !== env.AVALON_REGION) throw new Error('search_projection_region_mismatch');
    // The job carries no title: the object is read now, so a delayed or
    // redelivered message can only ever write the conversation's current display.
    const stub = await durableObjectStubForWorkspace(env, env.SUBSTREAM_AGENTS, job.workspaceId,
      conversationObjectName(job.region, job.workspaceId, job.parentId, job.substreamId));
    const index = await workspaceSearchIndex(env, job.workspaceId);
    // A display that changed under the patch throws, and the retry patches the current one.
    await projectConversationDisplay(() => stub.searchConversationDisplay(job),
      (display) => index.patchConversationDisplay({ scopeId: job.parentId, substreamId: job.substreamId }, display));
    message.ack();
    return;
  }
  const reference = ResourceSearchProjectionSchema.safeParse(message.body);
  if (reference.success) {
    const resource = reference.data;
    if (resource.region !== env.AVALON_REGION) throw new Error('search_projection_region_mismatch');
    // A resource has three documents and at most one is live, so it is indexed
    // in this delivery from one read of all three rather than fanned out to a
    // job per document: each document job read the WorkspaceDO twice, and at a
    // workspace's size those reads were what overloaded it (docs/text-search.md).
    const stub = await durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, resource.workspaceId,
      workspaceDOName(resource.region, resource.workspaceId));
    await indexSearch(resource, () => stub.prepareResourceSearch(resource));
    message.ack();
    return;
  }
  const source = SearchProjectionMessageSchema.safeParse(message.body);
  if (source.success) {
    if (source.data.region !== env.AVALON_REGION) throw new Error('search_projection_region_mismatch');
    // Source deliveries discover documents only. Capturing, tokenizing and
    // indexing each page happens in its own independently retriable delivery.
    const documentIds = await discoverSearchDocuments(env, source.data);
    await publishSearchIndexingJobs(env.ACTIVITY_QUEUE, documentIds.map((documentId) => ({
      type: 'search_embedding_batch_v1', phase: 'document', reference: source.data, documentId,
    })));
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
        const workspace = await hostedParentStub(env, input.workspaceId);
        // A `semantic_activity` trigger's written condition is tested here,
        // between the object's plan and its admission: it is the only trigger
        // type whose gate is a sentence, and the classifier that judges it
        // belongs in a Worker rather than inside the object.
        const result = await admitExternalEventWithSemanticGate(env, {
          sidekick: { admitExternalEvent: (admission) => workspace.sidekickAdmitExternalEvent(admission) },
          workspaceId: input.workspaceId,
          defer: runtimeDeferral,
          admission: {
            workspaceId: input.workspaceId,
            automationId: input.destination.automationId,
            registrationId: input.registrationId,
            event: input.event,
            payloadHash: input.payloadHash,
          },
        });
        logInfo(env, "external_event_delivery_terminal", {
          workspace_id: input.workspaceId,
          connector_event_id: input.event.id,
          registration_id: input.registrationId,
          destination_kind: "automation",
          automation_id: input.destination.automationId,
          outcome: result.admitted ? "admitted" : "refused",
          reason: result.outcomeCode,
          semantic_gate_code: result.gate?.code,
          semantic_gate_confidence: result.gate?.confidence,
          semantic_gate_model: result.gate?.model,
          semantic_gate_failure_kind: result.gate?.failureKind,
          semantic_condition_count: result.gate?.conditionCount,
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
      // A registration in a retired workspace stays in D1, so deliveries keep
      // arriving, and the object refuses each one the same way every time.
      // Terminal: the event has nowhere to land and never will.
      if (isRetirementRefusal(error)) {
        logInfo(env, "external_event_delivery_terminal", {
          workspace_id: input.workspaceId,
          connector_event_id: input.event.id,
          registration_id: input.registrationId,
          destination_kind: input.destination.kind,
          outcome: "refused",
          reason: "workspace_retired",
        });
        message.ack();
        return;
      }
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
  const projectDefault = RetiredProjectDefaultMessageSchema.safeParse(message.body);
  if (projectDefault.success) {
    // A tombstone, kept for the platform's retry window and no longer.
    //
    // Projects are retired: the migration that retires them invalidates every
    // pending target and drops the tables underneath it, so a target this
    // message names can never be current again. Acknowledging is therefore the
    // whole handler — a retry would reach the same answer on every redelivery
    // until the message dead-lettered, which is a non-empty dead-letter queue
    // saying something that is not a failure.
    logInfo(env, "project_default_delivery_terminal", {
      workspace_id: projectDefault.data.workspaceId,
      workstream_id: projectDefault.data.workstreamId,
      outcome: "skipped",
      reason: "projects_retired",
    });
    message.ack();
    return;
  }
  const spaceDefault = SpaceDefaultQueueMessageSchema.safeParse(message.body);
  if (spaceDefault.success) {
    const target = spaceDefault.data;
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
    let current: boolean;
    try {
      current = await workspace.spaceDefaultTargetCurrent(target);
    } catch (error) {
      // A retired Organization's default target is never current again.
      if (!isRetirementRefusal(error)) throw error;
      message.ack();
      return;
    }
    if (!current) {
      message.ack();
      return;
    }
    // The delivery runs as the person whose action staged it: whoever put the
    // Channel in the Space, or added the default. A Space's own roster has no
    // say over its Channels, so it is never the actor.
    const member = await env.DB.prepare(
      `SELECT user_id, role FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND status = 'active' AND access_class = 'member'`,
    ).bind(target.workspaceId, target.requestedByUserId)
      .first<{ user_id: string; role: AuthContext["role"] }>();
    if (!member) {
      await workspace.failSpaceDefaultTarget(target);
      message.ack();
      return;
    }
    const auth: AuthContext = {
      sessionId: `space-default:${target.spaceId}:${target.kind}:${target.defaultGeneration}`,
      userId: asUserId(member.user_id),
      workspaceId: target.workspaceId,
      region: env.AVALON_REGION,
      role: member.role,
      analyticsWorkspaceId: null,
      principal: "connector",
    };
    try {
      // One handler, two consumers. The staging, the fence, the currency
      // recheck and the receipt are identical; what a resource and a Sidekick
      // differ in is the canonical operation that applies them.
      const workstreams = new WorkstreamService(env, auth);
      if (target.kind === "resource") await workstreams.attachResource(target.workstreamId, target.targetId);
      else await workstreams.setSidekickRecommendation(target.workstreamId, target.targetId, true);
      await workspace.completeSpaceDefaultTarget(target);
      message.ack();
    } catch (error) {
      // The reason, not the fact. `last_error_code` is the only durable record
      // of why a default has not reached a Channel, and the fixed
      // `space_default_apply_failed` it used to carry said only that it had
      // not — which the row's existence already said.
      const errorCode = diagnosticErrorCode(error, "space_default_apply_failed");
      await workspace.recordSpaceDefaultTargetFailure({ ...target, errorCode }).catch(() => undefined);
      logWarn(env, "space_default_delivery_failed", {
        workspace_id: target.workspaceId,
        space_id: target.spaceId,
        workstream_id: target.workstreamId,
        kind: target.kind,
        reason: errorCode,
      });
      const attempts = Math.max(1, message.attempts);
      message.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6)) });
    }
    return;
  }
  const backfill = ThreadBackfillMessageSchema.safeParse(message.body);
  if (backfill.success) {
    const target = backfill.data;
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
    try {
      const work = await workspace.threadBackfillWork(target);
      if (work) {
        // Main and each open Breakout, in turn. A failure part way leaves the
        // row in place and the alarm sends it again; every job is written to
        // do nothing the second time over a conversation it already did.
        for (const substreamId of work.substreamIds) {
          const outcome = await THREAD_BACKFILL_HANDLERS[target.job](env, {
            workspaceId: target.workspaceId, workstreamId: target.workstreamId, substreamId,
          });
          logInfo(env, "thread_backfill_conversation", {
            job: target.job,
            workspace_id: target.workspaceId,
            workstream_id: target.workstreamId,
            substream_id: substreamId,
            outcome,
          });
          if (target.job === "conversation_view" && outcome === "queued") {
            // Keep this parent claimed until its source has confirmed writes.
            // Do not wake all its children and immediately admit another batch.
            message.retry();
            return;
          }
        }
        await workspace.completeThreadBackfill(target);
      }
    } catch (error) {
      // A retired Organization's thread is never written again.
      if (!isRetirementRefusal(error)) {
        // Acked rather than retried, as colour sync does: the row's own gate
        // sends it again, and released so it holds no successor back.
        logWarn(env, "thread_backfill_failed", {
          job: target.job,
          workspace_id: target.workspaceId,
          workstream_id: target.workstreamId,
          reason: diagnosticErrorCode(error, "thread_backfill_failed"),
        });
        await workspace.releaseThreadBackfill(target).catch(() => undefined);
      }
    }
    message.ack();
    return;
  }
  const memorySweep = MemorySweepMessageSchema.safeParse(message.body);
  if (memorySweep.success) {
    const target = memorySweep.data;
    if (target.region !== env.AVALON_REGION) {
      message.ack();
      return;
    }
    // Acked whatever happens, as colour sync and the backfill are: the
    // conversation's own claim and rest decide when it is tried again, and
    // `runMemorySweep` has already released the claim before it throws.
    try {
      await runMemorySweep(env, target);
    } catch (error) {
      if (!isRetirementRefusal(error)) {
        logWarn(env, "memory_sweep_delivery_failed", {
          workspace_id: target.workspaceId,
          workstream_id: target.parentId,
          substream_id: target.substreamId,
          attempt: target.attempt,
          reason: diagnosticErrorCode(error, "memory_sweep_delivery_failed"),
        });
      }
    }
    message.ack();
    return;
  }
  const colorSync = ChannelColorSyncMessageSchema.safeParse(message.body);
  if (colorSync.success) {
    const target = colorSync.data;
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
    try {
      const work = await workspace.channelColorWork(target);
      if (work) {
        // Main and each open Breakout, in turn. A failure part way leaves the
        // row in place, and the alarm sends it again; `recolor` writes nothing
        // where the colour already matches, and refuses this revision wherever
        // a newer one has already landed.
        for (const substreamId of work.substreamIds) {
          await createIdentityObjectPort(env, target.workspaceId, target.workstreamId, undefined, substreamId)
            .recolor({ color: work.color, revision: target.revision, now: Date.now() });
        }
        await workspace.completeChannelColorSync(target);
      }
    } catch (error) {
      // A retired Organization's thread is never written again.
      if (!isRetirementRefusal(error)) {
        // Acked rather than retried: the row's own gate sends it again, and a
        // Queue retry beside it would be a second copy of the same attempt.
        // Released so it does not hold the rest of its batch's successors back.
        logWarn(env, "channel_color_sync_failed", {
          workspace_id: target.workspaceId,
          workstream_id: target.workstreamId,
          reason: diagnosticErrorCode(error, "channel_color_sync_failed"),
        });
        await workspace.releaseChannelColorSync(target).catch(() => undefined);
      }
    }
    message.ack();
    return;
  }
  const digestSync = MemoryDigestSyncMessageSchema.safeParse(message.body);
  if (digestSync.success) {
    const target = digestSync.data;
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
    try {
      const work = await workspace.memoryDigestSyncWork(target);
      if (work) {
        // Every copy the conversation holds, re-read as its own principal.
        // A copy that failed keeps the row: released, so the alarm sends it
        // again at its gate, rather than completed over a stale copy. Each
        // failure was logged with its reason by the refresh.
        const refreshed = await refreshMemoryDigestCopies(env, { workspaceId: target.workspaceId, ...work });
        if (refreshed.failed > 0) await workspace.releaseMemoryDigestSync(target);
        else await workspace.completeMemoryDigestSync(target);
      }
    } catch (error) {
      // A retired Organization's conversation is never read again.
      if (!isRetirementRefusal(error)) {
        // Acked rather than retried, as colour sync is: the row's own gate
        // sends it again, and releasing it lets the rest of its batch go.
        logWarn(env, "memory_digest_sync_failed", {
          workspace_id: target.workspaceId,
          revision: target.revision,
          reason: diagnosticErrorCode(error, "memory_digest_sync_failed"),
        });
        await workspace.releaseMemoryDigestSync(target).catch(() => undefined);
      }
    }
    message.ack();
    return;
  }
  const bootstrap = SpaceBootstrapQueueMessageSchema.safeParse(message.body);
  if (bootstrap.success) {
    const work = bootstrap.data;
    if (work.region !== env.AVALON_REGION) {
      message.ack();
      return;
    }
    // Nobody is signed in. The cutover's actor is resolved from current
    // membership rather than carried on the message, because the message may
    // be redelivered days later and the person it named may have left.
    const driver = await spaceBootstrapDriver(env, work.workspaceId, env.AVALON_REGION);
    if (!driver) {
      // An Organization with no active member has nobody the disclosure could
      // be attributed to, and nobody to render the hierarchy for either.
      logInfo(env, "space_bootstrap_skipped", {
        workspace_id: work.workspaceId,
        outcome: "skipped",
        reason: "no_active_member",
      });
      message.ack();
      return;
    }
    try {
      const cutover = new SpaceBootstrapService(env, driver);
      if (work.kind === "general") await cutover.runGeneral();
      else if (work.kind === "preflight") await cutover.runPreflight(work.cursor);
      else if (work.kind === "memberships") await cutover.runMemberships(work.cursor);
      else await cutover.runFinalize();
      message.ack();
    } catch (error) {
      if (isRetirementRefusal(error)) {
        message.ack();
        return;
      }
      // Said out loud, for the reason a resume says its own: the alarm
      // republishes this on its retry gate as well, so a silent catch turns a
      // half-migrated Organization into a dead-letter message with no reason
      // on it.
      logWarn(env, "space_bootstrap_failed", {
        workspace_id: work.workspaceId,
        kind: work.kind,
        attempts: message.attempts,
        reason: diagnosticErrorCode(error, "space_bootstrap_failed"),
      });
      const attempts = Math.max(1, message.attempts);
      message.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6)) });
    }
    return;
  }
  const spaceResume = SpaceIntentResumeQueueMessageSchema.safeParse(message.body);
  if (spaceResume.success) {
    const intent = spaceResume.data;
    if (intent.region !== env.AVALON_REGION) {
      message.ack();
      return;
    }
    const workspace = await durableObjectStubForWorkspace(
      env,
      env.WORKSPACE_DOS,
      intent.workspaceId,
      workspaceDOName(env.AVALON_REGION, intent.workspaceId),
    );
    // The person who staged it, if they are still here. A Space operation is
    // applied through the Channel's canonical operations, and those authorize
    // an actor — so a resume needs one, and the requester is the only actor the
    // original authorization covered.
    const member = await env.DB.prepare(
      `SELECT user_id, role FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND status = 'active' AND access_class = 'member'`,
    ).bind(intent.workspaceId, intent.requestedByUserId)
      .first<{ user_id: string; role: AuthContext["role"] }>();
    if (!member) {
      try {
        await workspace.recordSpaceIntentFailure({
          workspaceId: intent.workspaceId,
          userId: intent.requestedByUserId,
          operationId: intent.operationId,
          errorCode: "space_intent_requester_inactive",
        });
      } catch (error) {
        if (!isRetirementRefusal(error)) throw error;
      }
      message.ack();
      return;
    }
    const auth: AuthContext = {
      sessionId: `space-intent:${intent.operationId}`,
      userId: asUserId(member.user_id),
      workspaceId: intent.workspaceId,
      region: env.AVALON_REGION,
      role: member.role,
      analyticsWorkspaceId: null,
      principal: "connector",
    };
    try {
      // WorkspaceDO resumes the intent from its row, whatever its kind.
      const resumed = await new SpaceService(env, auth).resumeIntent(intent.operationId);
      // An intent that settled without doing its work is the one outcome
      // nothing else would say out loud: the row reads `settled`, the queue is
      // clear, and the operation the person asked for never reached its member
      // Channels. Named here rather than inside the service because this is
      // where the failing resume is already logged, and a reader comparing the
      // two lines should not have to know which layer wrote which.
      if (resumed.outcome === "abandoned") {
        logWarn(env, "space_intent_resume_abandoned", {
          workspace_id: intent.workspaceId,
          space_id: intent.spaceId,
          operation_id: intent.operationId,
          kind: intent.kind,
          reason: resumed.reason,
        });
      }
      message.ack();
    } catch (error) {
      if (isRetirementRefusal(error)) {
        message.ack();
        return;
      }
      // Said out loud, and written down. A resume that keeps failing is
      // retried by the alarm and here as well, so a silent catch makes a
      // half-finished operation a thing that shows up only as a dead-letter
      // message with no reason on it — which is the diagnosis this costs on the
      // way in. The code goes on the intent as well as into the log, the way a
      // default target's does: the row outlives the log line, and whoever finds
      // it unsettled otherwise has the fact without the reason.
      const reason = diagnosticErrorCode(error, "space_intent_resume_failed");
      await workspace.recordSpaceIntentFailure({
        workspaceId: intent.workspaceId,
        userId: intent.requestedByUserId,
        operationId: intent.operationId,
        errorCode: reason,
      }).catch(() => undefined);
      logWarn(env, "space_intent_resume_failed", {
        workspace_id: intent.workspaceId,
        space_id: intent.spaceId,
        operation_id: intent.operationId,
        kind: intent.kind,
        attempts: message.attempts,
        reason,
      });
      const attempts = Math.max(1, message.attempts);
      message.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6)) });
    }
    return;
  }
  if (await consumeWorkstreamBatchUpdate(message, env)) return;
  const runProvision = SidekickRunProvisionQueueMessageSchema.safeParse(message.body);
  if (runProvision.success) {
    // A Sidekick's run, handed off by its Organization's alarm entry. The entry
    // sends again on its own backoff until the run reports running, so a
    // failure here is retried by the Queue and, past that, by the entry.
    if (runProvision.data.region !== env.AVALON_REGION) {
      message.ack();
      return;
    }
    try {
      await provisionSidekickRun(env, runProvision.data);
      message.ack();
    } catch (error) {
      logWarn(env, "sidekick_run_provision_retry", {
        workspace_id: runProvision.data.workspaceId,
        automation_id: runProvision.data.automationId,
        run_id: runProvision.data.runId,
        queue_attempts: message.attempts,
        code: diagnosticErrorCode(error, "sidekick_run_provision_failed"),
      });
      message.retry();
    }
    return;
  }
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
          errorCode,
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
      if (isRetirementRefusal(error)) {
        logInfo(env, "connector_event_process_terminal", {
          workspace_id: input.workspaceId,
          connector_event_id: input.eventId,
          processing_owner_id: input.processingOwnerId,
          processing_attempt: processingAttempt,
          outcome: "skipped",
          reason: "workspace_retired",
          queue_attempts: message.attempts,
        });
        message.ack();
        return;
      }
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

  const maintenance = ConnectorMaintenanceQueueSchema.safeParse(message.body);
  if (maintenance.success) {
    if (maintenance.data.region !== env.AVALON_REGION) throw new Error('connector_maintenance_region_mismatch');
    await runConnectorMaintenance(env, maintenance.data.operationId, new AbortController().signal);
    message.ack(); return;
  }
  const installation = ConnectorInstallationQueueSchema.safeParse(message.body);
  if (installation.success) {
    if (installation.data.region !== env.AVALON_REGION) throw new Error("connector_installation_region_mismatch");
    try {
      await runConnectorInstallation(env, installation.data.workspaceId, installation.data.connectionId, new AbortController().signal);
    } catch (error) { if (!isRetirementRefusal(error)) throw error; }
    message.ack(); return;
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
        restored_event_id: admission.accepted.restoredEventId ?? null,
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
      // A retired workspace refuses every ingest the same way. Same rule.
      if (reason === "connector_event_identity_reused_with_different_content" || isRetirementRefusal(error)) {
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
  const unreadableEffect = legacyActivity.success ? null : effectRejection(message.body, effect.error);
  if (unreadableEffect !== null) {
    // An effect this consumer's contract refuses — a writer that shipped
    // ahead of its reader, most likely. Acked as before, but named: the
    // parent never hears it, and the log is the only place that says why.
    logWarn(env, "effect_queue_message_invalid", {
      workspace_id: unreadableEffect.workspaceId,
      message_id: unreadableEffect.messageId,
      outcome: "skipped",
      code: unreadableEffect.code,
      queue_attempts: message.attempts,
    });
    message.ack();
    return;
  }
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
 * The named rejection of a body that says it is an effect envelope, or `null`
 * for anything else. Only our own objects write effects to this Queue, so the
 * unknown key names are the whole diagnosis of a version skew and may be
 * named (docs/naming-a-schema-failure.md).
 */
function effectRejection(
  body: unknown,
  error: z.ZodError,
): { code: string; workspaceId: string | null; messageId: string | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const envelope = body as Record<string, unknown>;
  const schema = envelope.kind === "conversation_effect" ? ConversationEffectEnvelopeSchema
    : envelope.kind === "parent_effect" ? ParentEffectEnvelopeSchema
      : null;
  if (schema === null) return null;
  const rejected = schema.safeParse(body);
  const text = (value: unknown) => typeof value === "string" ? codeShaped(value) : null;
  return {
    code: zodDiagnosticCode(rejected.success ? error : rejected.error, "effect_queue_message", { namesUnknownKeys: true })
      ?? "effect_queue_message_invalid",
    workspaceId: text(envelope.workspaceId),
    messageId: text(envelope.messageId),
  };
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
      if (envelope.effect.kind === "directory_common" && envelope.effect.attachmentReservationReleases?.length) {
        const workspace = await workspaceDirectory(env,envelope.workspaceId);
        await workspace.publishConversationAttachments(envelope);
      }
      logInfo(env, "conversation_effect_terminal", {
        ...fields,
        substream_id: envelope.substreamId,
        outcome: "applied",
        reason: "parent_accepted",
      });
      message.ack();
      return;
    }
    if (envelope.effect.kind === "scope_grant_directory") {
      const workspace = await workspaceDirectory(env, envelope.workspaceId);
      await workspace.applyScopeGrantDirectory(envelope);
      const { grant } = envelope.effect;
      if (!grant.active && grant.target.kind === "workstream") {
        // Owned Sidekick conversations are siblings, outside the workstream's
        // participant projection. Keep this durable effect retryable until the
        // existing revocation queue accepts their fan-out.
        const published = await publishAccessRevocation(env, {
          reason: "workstream_participant_removed", workspaceId: envelope.workspaceId,
          userId: grant.userId, sessionId: null,
          ...(grant.membershipIncarnation ? { membershipIncarnation: grant.membershipIncarnation } : {}),
          target: { scope: "workstream_automations", workstreamId: grant.target.parentId },
        });
        if (!published) throw new Error("scope_grant_sidekick_revocation_publish_failed");
      }
      message.ack();
      return;
    }
    if (envelope.effect.kind === "directory_automation") {
      // Only the deleted SidekickDO published this; a Sidekick's directory
      // row is now written where the Sidekick lives, so a late copy is dropped.
      logInfo(env, "conversation_effect_terminal", { ...fields, outcome: "ignored", reason: "sidekick_directory_producer_deleted" });
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
  await Promise.all(matched.deliveries.map((delivery) => sendConnectorEventDelivery(env, delivery)));
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
