import { ConversationViewJobSchema } from "../durable-objects/conversation-view-projection";
import { ConnectorDeliveryReferenceSchema, readConnectorDeliveryReference, sendConnectorEventDelivery } from "../services/connector-queue-payload";
import { SidekickReviewQueueMessageSchema, SidekickRunProvisionQueueMessageSchema } from "../durable-objects/automation-do-protocol";
import { provisionSidekickRun } from "../services/sidekick-run-provisioning";
import { deliverSidekickReview } from "../services/sidekick-review";
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

import { projectAuthorization } from '../services/authorization-projection-service';
import { createSearchIndexingPipeline, indexSemanticBatch } from '../services/search-indexing-pipeline';
import { projectConversationDisplay } from '../services/search-conversation-display';

import {
  ActivityQueueMessageSchema,
  WorkspaceExternalEventDeliveryQueueMessageSchema,
  asSubstreamId,
  asWorkspaceId,
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
import { conversationObjectName, workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceConnectorEventClaimResultSchema,
  WorkspaceConnectorEventProcessQueueMessageSchema,
  WorkspaceConnectorEventQueueMessageSchema,
  type WorkspaceConnectorEvent,
} from "../durable-objects/workspace-connector-event-protocol";
import type { Env } from "../env";
import { runInteractiveMessage } from "./interactive-consumer";
import { InteractiveQueueMessageSchema } from "../services/interactive-queue";
import { runtimeDeferral } from "../lib/defer";
import { admitExternalEventWithSemanticGate } from "../services/semantic-trigger-admission";

import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { consumeGitHubDeliveryMessage, isGitHubDeliveryQueueMessage } from "../services/github-routing-service";

import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
import { isRetirementRefusal } from "../durable-objects/object-retirement";
import { MemorySweepMessageSchema, runMemorySweep } from "../services/memory-sweep-service";
import { MemoryDigestSyncMessageSchema } from "../durable-objects/memory-digest-sync";
import { refreshMemoryDigestCopies } from "../services/memory-digest-service";

import { restrictedActivityUserIds } from "../lib/activity-visibility";
import { admitConnectorEvent } from "../services/workspace-connector-event-ingress";
import {
  processWorkstreamNotificationIntent,
} from "../services/conversation-effect-service";
import { conversationParentStub } from "../services/conversation-parent-client";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import { hostedParentStub } from "../services/conversation-parent-client";

/**
 * The shape of a message whose handler is gone, kept only to recognize one.
 *
 * Projects, then the thread backfill and Channel colour sync (plan step C-2),
 * are retired and their protocol modules are gone; what survives is the
 * platform's retry window, during which a message published before the
 * cutover can still arrive. Matching on the discriminator and the field a log
 * line needs is the whole contract — there is nothing left to act on, so
 * parsing the rest would be describing a payload in order to throw it away.
 */
const RetiredQueueMessageSchema = z.union([
  z.object({
    type: z.enum(["project_default_resource", "thread_backfill", "channel_color_sync",
      "space_default", "space_bootstrap", "space_intent_resume"]),
    workspaceId: z.string(),
  }),
  // A Thread batch update names its type by `kind`.
  z.object({ kind: z.literal("workstream_batch_update"), workspaceId: z.string() })
    .transform(({ kind, workspaceId }) => ({ type: kind, workspaceId })),
]);

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
  // A Channel message's job published before Channels were retired: nothing to index.
  if (reference.type === 'channel_message_search_projection_v1') return { documents: [], retry: false };
  const stub = await durableObjectStubForWorkspace(env, env.SUBSTREAM_AGENTS, reference.workspaceId,
    conversationObjectName(reference.region, reference.workspaceId, reference.parentId, reference.substreamId));
  return stub.prepareSearchTurnDocument(reference, documentId, captureLinks);
}

/**
 * A resource's watermark, without extracting its text. Every input of its
 * search text bumps it (`resource-search-projection.ts`), so an equal
 * revision is equal text. A turn has no such read: a link capture can
 * change a page's text at the same revision, so a turn is re-read in full.
 */
function searchSourceRevision(env: Env, reference: SearchSourceReference): (() => Promise<number | null>) | undefined {
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
      const attempts = Math.max(1, message.attempts);
      message.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6)) });
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
          // Sidekick source-account authority stays on its own delivery path;
          // ordinary resource watches retain their existing event contract.
          event: {
            id: input.event.id, eventSequence: input.event.eventSequence, eventType: input.event.eventType,
            title: input.event.title, summary: input.event.summary, textSnippet: input.event.textSnippet,
            metadata: input.event.metadata, occurredAt: input.event.occurredAt,
            audienceKind: input.event.audienceKind, audienceUserIds: input.event.audienceUserIds,
          },
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
  const memorySweep = MemorySweepMessageSchema.safeParse(message.body);
  if (memorySweep.success) {
    const target = memorySweep.data;
    if (target.region !== env.AVALON_REGION) {
      message.ack();
      return;
    }
    // Acked whatever happens: the conversation's own claim and rest decide when it is tried again, and
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
        // Acked rather than retried: the row's own gate
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
  const retired = RetiredQueueMessageSchema.safeParse(message.body);
  if (retired.success) {
    // A tombstone, kept for the platform's retry window and no longer.
    //
    // What the message names can never be acted on again, so acknowledging is
    // the whole handler — a retry would reach the same answer on every
    // redelivery until the message dead-lettered, which is a non-empty
    // dead-letter queue saying something that is not a failure.
    logInfo(env, "retired_queue_message_terminal", {
      workspace_id: retired.data.workspaceId,
      message_type: retired.data.type,
      outcome: "skipped",
      reason: `${retired.data.type}_retired`,
    });
    message.ack();
    return;
  }
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
  const review = SidekickReviewQueueMessageSchema.safeParse(message.body);
  if (review.success) {
    // A Sidekick's scheduled self-review, handed off by its Organization's
    // alarm entry, which sends again on its own backoff until the wizard
    // reports the notice admitted; a failure here is retried by the Queue
    // and, past that, by the entry.
    if (review.data.region !== env.AVALON_REGION) {
      message.ack();
      return;
    }
    try {
      await deliverSidekickReview(env, review.data);
      message.ack();
    } catch (error) {
      logWarn(env, "sidekick_review_delivery_retry", {
        workspace_id: review.data.workspaceId,
        automation_id: review.data.automationId,
        review_id: review.data.reviewId,
        queue_attempts: message.attempts,
        code: diagnosticErrorCode(error, "sidekick_review_delivery_failed"),
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

  // Interactive work rides its own queue; any kind of it that still arrives
  // here, such as a job queued before its kind moved, runs the same handler.
  const interactive = InteractiveQueueMessageSchema.safeParse(message.body);
  if (interactive.success) {
    await runInteractiveMessage(message, interactive.data, env);
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
 * How long an effect whose notification intent another delivery is holding
 * waits before the Queue brings it back. Carried over unchanged from the
 * deleted `parent_effect` branch; why 30 was chosen was not recorded.
 */
const NOTIFICATION_HELD_RETRY_SECONDS = 30;

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
      // A retired parent answers with receipts alone, so it names no intent.
      const { notificationIntentIds = [] } = await parent.receiveChildEffects({
        substreamId: envelope.substreamId, envelopes: [envelope],
      }) as { notificationIntentIds?: string[] };
      if (envelope.effect.kind === "directory_common" && envelope.effect.attachmentReservationReleases?.length) {
        const workspace = await workspaceDirectory(env,envelope.workspaceId);
        await workspace.publishConversationAttachments(envelope);
      }
      // A mention or an add the parent recorded: deliver it now. The parent
      // names it again on a redelivery and the intent's own state makes a
      // second delivery a no-op, so a send that failed is retried this way.
      let notificationOutcome: "delivered" | "skipped" | null = null;
      for (const intentId of notificationIntentIds) {
        const outcome = await processWorkstreamNotificationIntent(env, envelope.workspaceId, intentId);
        if (outcome === "busy") {
          logInfo(env, "conversation_effect_deferred", {
            ...fields,
            substream_id: envelope.substreamId,
            notification_intent_id: intentId,
            reason: "notification_busy",
            retry_delay_seconds: NOTIFICATION_HELD_RETRY_SECONDS,
          });
          message.retry({ delaySeconds: NOTIFICATION_HELD_RETRY_SECONDS });
          return;
        }
        notificationOutcome = outcome;
      }
      logInfo(env, "conversation_effect_terminal", {
        ...fields,
        substream_id: envelope.substreamId,
        outcome: notificationOutcome ?? "applied",
        reason: notificationOutcome ? "notification_terminal" : "parent_accepted",
        ...(notificationIntentIds.length > 0 ? { notification_intent_id: notificationIntentIds.join(",") } : {}),
      });
      message.ack();
      return;
    }
    // A parent's effect from a retired Thread or Space retries to the
    // dead-letter queue under the kind's name, as a child's does when its
    // parent refuses it; the dead-letter queue is the signal.
    if (envelope.parentKind === "workstream" || envelope.parentKind === "space") {
      throw new Error(`conversation_parent_kind_retired:${envelope.parentKind}`);
    }
    if (envelope.effect.kind === "scope_grant_directory") {
      const workspace = await workspaceDirectory(env, envelope.workspaceId);
      await workspace.applyScopeGrantDirectory(envelope);
      // A Thread's owned Sidekicks once needed a revocation hop here; a Canvas
      // grant (target kind `workstream`) owns none, so the directory step is
      // the whole effect.
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
    // An activity row, a mention or an add as a `parent_effect`: only the
    // Thread host published these, from its `parent_outbox`. A hosted parent
    // records a mention where its conversation's effect lands
    // (`HostedConversation.applyChildEnvelope`), so a leftover under a current
    // parent kind is acknowledged and named rather than applied; a retired
    // kind's was refused above.
    logInfo(env, "conversation_effect_terminal", { ...fields, outcome: "ignored", reason: "parent_effect_producer_retired" });
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
  // deliveries is only the work still pending.
  const workspace = await workspaceDirectory(env, asWorkspaceId(activity.workspace_id));
  // Parsed on this side: the delivery carries the event's metadata, whose
  // open shape the RPC type system cannot name, so the stub's answer is
  // untyped until the contract reads it.
  const matched = WorkspaceExternalEventMatchResultSchema.parse(await workspace.matchExternalEventDestinations({
    workspaceId: activity.workspace_id,
    eventId: activity.id,
  }));
  await Promise.all(matched.deliveries.map((delivery) => sendConnectorEventDelivery(env, delivery)));
  logInfo(env, "connector_event_processing_completed", {
    workspace_id: activity.workspace_id,
    connection_id: activity.connection_id,
    connector_type: activity.connector_type,
    provider: activity.provider,
    connector_event_id: activity.id,
    deterministic_route_claimed: matched.matched,
    deterministic_delivery_count: matched.deliveries.length,
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
  restrictedActivityUserIds,
};
