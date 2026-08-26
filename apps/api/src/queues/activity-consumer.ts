import {
  renderActivityRoutingMessages,
  renderSemanticTriggerMessages,
} from "@rally/agent-harness";
import { ConnectorError, connectorOriginUrl, connectorRetryAfterMs } from "@rally/connectors";
import {
  ACTIVITY_STREAM_NOT_DIGESTIBLE_METADATA_KEY,
  ActivityQueueMessageSchema,
  ActivityRoutingResultSchema,
  ExecutionPrincipalSchema,
  SlackIngressQueueMessageSchema,
  TriggerDefinitionSchema,
  WorkstreamWorkflowInputSchema,
  asWorkspaceId,
  asWorkstreamId,
  type Message as AvalonMessage,
  type WorkspaceId,
  type WorkstreamWorkflowInput
} from "@rally/contracts";
import { z } from "zod";

import { WorkstreamRegionalEffectQueueMessageSchema } from "../durable-objects/workstream-regional-effect";
import { workspaceDOName } from "../durable-objects/names";
import {
  WorkspaceConnectorEventQueueMessageSchema,
  type WorkspaceConnectorEvent,
} from "../durable-objects/workspace-connector-event-protocol";
import type { Env } from "../env";
import { contentAudienceContainsWorkstream } from "../lib/audience-containment";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { SUGGESTED_CONTEXT_ENABLED } from "../lib/suggested-context";
import { createMessageObjectPort } from "../runtime/message-port";
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
  publishSubstreamAgentEvent,
} from "../services/activity-suggestion-service";
import { WorkstreamEmailRoutingService } from "../services/workstream-email-routing-service";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
  workstreamExecutionEnvironment,
} from "../services/workstream-runtime-database";
import { SlackAgentService } from "../services/slack-agent-service";
import { automationModelOverride, scheduledWorkstreamModel } from "../services/agent-model-flags";
import { runStructuredInference } from "../services/structured-inference";
import { enqueueActivityOpportunity } from "../services/work-opportunity-batching";
import { recordActivityEvent } from "../services/activity-event-service";
import { startWorkstreamWorkflow } from "../services/integrations";
import {
  activityOriginLocator,
  attachWorkstreamOriginResource,
  describeWorkstreamOrigin,
} from "../services/workstream-origin-resource";
import { diagnosticErrorCode, logDebug, logInfo, logWarn } from "../observability/logger";
import { cloudflareWorkflowInstanceId } from "../lib/cloudflare-workflow-instance-id";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { activityContentAudience, restrictedActivityUserIds } from "../lib/activity-visibility";
import { readWorkstreamRuntimeAudience } from "../services/workstream-object-client";
import { recordWorkstreamCreatedTelemetry } from "../telemetry/workstream-creation";
import {
  acknowledgeWorkstreamOutboxEffect,
  applyQueuedWorkspaceDirectoryEffect,
  applyWorkstreamRegionalEffect,
  isWorkspaceDirectoryEffect,
  loadWorkstreamRegionalEffect,
  processWorkstreamNotificationIntent,
} from "../services/workstream-regional-effect-service";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";

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

interface SubscriptionRow {
  id: string;
  scope: "personal" | "workspace";
  owner_user_id: string | null;
  template_owner_user_id: string;
  execution_principal_json: string;
  connector_bindings_json: string;
  activity_trigger_bindings_json: string;
  model_override: string | null;
  trigger_definitions_json: string;
  template_name: string;
  template_description: string;
}

type TriggerDefinition = z.infer<typeof TriggerDefinitionSchema>;

const SemanticTriggerResultSchema = z.object({ matches: z.boolean(), confidence: z.number().min(0).max(1) });
const semanticTriggerJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    matches: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  },
  required: ["matches", "confidence"]
};
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

function visibleToPersonalOwner(activity: ActivityRow, ownerUserId: string): boolean {
  const restrictedUserIds = restrictedActivityUserIds(activity);
  return restrictedUserIds == null || restrictedUserIds.includes(ownerUserId);
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
        workflow_attempt: admission.workflowAttempt,
        workflow_instance_id: admission.workflowInstanceId,
        workflow_outcome: admission.workflowOutcome,
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
  const workflowAttempt = accepted.processingStatus === "processing"
    ? accepted.processingAttempt
    : accepted.processingStatus === "failed"
      ? Math.max(requestedAttempt, accepted.processingAttempt + 1)
      : Math.max(0, requestedAttempt);
  const recordedAttempt = Math.min(workflowAttempt, 5);
  // Provider/internal IDs are hash input only. The external Workflow ID is
  // fixed-alphabet and fixed-length by construction; see the helper's contract.
  const workflowInstanceId = await cloudflareWorkflowInstanceId(
    "connector-event",
    accepted.eventId,
    recordedAttempt,
  );
  let workflowOutcome: "created" | "duplicate" | "already_processed" | "attempts_exhausted";
  if (accepted.processingStatus !== "processed" && workflowAttempt <= 5) {
    try {
      await env.CONNECTOR_EVENT_WORKFLOW.create({
        id: workflowInstanceId,
        params: {
          region: env.AVALON_REGION,
          workspaceId: request.workspaceId,
          eventId: accepted.eventId,
          workflowInstanceId,
          attempt: workflowAttempt,
        },
      });
      workflowOutcome = "created";
    } catch (error) {
      if (!(error instanceof Error) || !/(already exists|duplicate|conflict)/iu.test(error.message)) {
        throw error;
      }
      workflowOutcome = "duplicate";
    }
  } else {
    workflowOutcome = accepted.processingStatus === "processed"
      ? "already_processed"
      : "attempts_exhausted";
  }
  return { accepted, workflowAttempt, recordedAttempt, workflowInstanceId, workflowOutcome };
}

/** The connector-event Workflow's idempotent product processing step. */
export async function processConnectorEvent(
  env: Env,
  event: WorkspaceConnectorEvent
): Promise<void> {
  const activity = activityRowFromWorkspaceEvent(event);
  env = withWorkspaceRuntimeDatabase(env, activity.workspace_id);
  const directWorkstreamIds = await routeDirectWatches(env, activity);
  const automationWorkstreamIds = await runMatchingAutomations(env, activity);
  for (const workstreamId of automationWorkstreamIds) directWorkstreamIds.add(workstreamId);
  const routedContextually = SUGGESTED_CONTEXT_ENABLED
    ? await routeContextually(env, activity, directWorkstreamIds)
    : false;
  if (directWorkstreamIds.size === 0 && !routedContextually) {
    await enqueueActivityOpportunity(env, activity.id, asWorkspaceId(activity.workspace_id));
  }
  await projectActivityEvent(env, activity);
  logInfo(env, "connector_event_processing_completed", {
    workspace_id: activity.workspace_id,
    connection_id: activity.connection_id,
    connector_type: activity.connector_type,
    provider: activity.provider,
    connector_event_id: activity.id,
    direct_workstream_count: directWorkstreamIds.size,
    routed_contextually: routedContextually,
    opportunity_enqueued: directWorkstreamIds.size === 0 && !routedContextually,
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

async function routeDirectWatches(env: Env, activity: ActivityRow): Promise<Set<string>> {
  const entityKeys = parseStrings(activity.entity_keys_json);
  if (!activity.provider_resource_id && entityKeys.length === 0) return new Set();

  const resources = await env.DB.prepare(
    `SELECT id FROM resources
      WHERE workspace_id = ?1 AND connection_id = ?2 AND provider = ?3
        AND (provider_resource_id = ?4 OR EXISTS (
          SELECT 1 FROM json_each(?5) WHERE json_each.value = provider_resource_id
        ))`,
  ).bind(
    activity.workspace_id,
    activity.connection_id,
    activity.provider,
    activity.provider_resource_id,
    JSON.stringify(entityKeys),
  ).all<{ id: string }>();
  const workspace = await workspaceDirectory(env, asWorkspaceId(activity.workspace_id));
  const resolvedWorkstreamIds = new Set<string>();
  for (const resource of resources.results ?? []) {
    const resolved = await workspace.workstreamsForResource({
      workspaceId: activity.workspace_id,
      resourceId: resource.id,
      watchedOnly: true,
    });
    for (const workstreamId of resolved.workstreamIds) resolvedWorkstreamIds.add(workstreamId);
  }
  const directWorkstreamIds = [...resolvedWorkstreamIds];

  const routed = new Set<string>();
  const sourceAudience = activityContentAudience(activity);
  if (!sourceAudience) return routed;
  for (const workstreamId of directWorkstreamIds) {
    // The work stream is the authority for scope and participation. WorkspaceDO
    // is only a regional projection and may still name a member whose removal
    // has committed but whose directory effect has not arrived yet.
    const targetAudience = await readWorkstreamRuntimeAudience(
      env,
      activity.workspace_id,
      workstreamId,
    );
    if (!contentAudienceContainsWorkstream(sourceAudience, targetAudience)) continue;
    if (await injectActivityMessage(env, activity, workstreamId)) {
      routed.add(workstreamId);
    }
  }
  return routed;
}

async function injectActivityMessage(
  env: Env,
  activity: ActivityRow,
  workstreamId: string
): Promise<boolean> {
  const clientMessageId = `activity:${activity.id}`;
  const structuredContent = {
    kind: "connected_activity",
    activityId: activity.id,
    provider: activity.provider,
    eventType: activity.event_type
  };
  const text = [activity.title, activity.summary].filter(Boolean).join(" — ");
  const now = Date.now();
  const messages = createMessageObjectPort(env, activity.workspace_id, workstreamId);
  // Four routed statements: a replay check, a sequence claim with `RETURNING`,
  // an `INSERT OR IGNORE` whose changes count re-answered the replay question,
  // and a second counter update. The insert's trigger moved one set of counters
  // and those two statements moved the other, and only the router sending them
  // together made that one fact. It is one operation now, and the replay is
  // its answer rather than something to ask twice.
  const appended = await messages.appendMessage({
    messageId: uuidV7(),
    clientMessageId,
    authorType: "system",
    authorUserId: null,
    externalActorJson: null,
    messageType: "system",
    text,
    structuredContentJson: JSON.stringify(structuredContent),
    producedByRunId: null,
    now,
  });
  // A redelivery is routed — the activity did reach this work stream — but it
  // publishes nothing, because the row it names is already on every client.
  if (appended.outcome === "replayed") return true;

  const canonicalMessage: AvalonMessage = {
    id: appended.messageId,
    clientMessageId,
    workspaceId: activity.workspace_id,
    workstreamId,
    author: { type: "system" },
    messageType: "system",
    textContent: text,
    structuredContent,
    mentions: [],
    attachments: [],
    sequenceNumber: appended.sequenceNumber,
    createdAt: new Date(now).toISOString(),
    editedAt: null
  };
  await publishSubstreamAgentEvent(env, activity.workspace_region, asWorkspaceId(activity.workspace_id), asWorkstreamId(workstreamId), {
    type: "message_created",
    message: canonicalMessage
  });
  return true;
}

async function runMatchingAutomations(env: Env, activity: ActivityRow): Promise<Set<string>> {
  const subscriptions = await env.DB.prepare(
    `SELECT s.id, s.scope, s.owner_user_id, s.execution_principal_json,
            s.connector_bindings_json, s.activity_trigger_bindings_json, s.model_override,
            tv.trigger_definitions_json, t.owner_user_id AS template_owner_user_id,
            t.name AS template_name,
            t.description AS template_description
       FROM automation_subscriptions s
       JOIN automation_template_versions tv ON tv.id = s.template_version_id
       JOIN automation_templates t ON t.id = s.template_id
      WHERE s.workspace_id = ?1 AND s.status = 'active' AND s.lifecycle_state = 'visible'`
  )
    .bind(activity.workspace_id)
    .all<SubscriptionRow>();

  const resourceIds = await matchingResourceIds(env, activity);
  const createdWorkstreamIds = new Set<string>();
  for (const subscription of subscriptions.results) {
    if (
      subscription.scope === "personal" &&
      (!subscription.owner_user_id || !visibleToPersonalOwner(activity, subscription.owner_user_id))
    ) {
      continue;
    }
    if (activity.connection_scope === "personal" && subscription.scope === "workspace") continue;
    if (
      subscription.scope === "workspace"
      && parseRecord(activity.visibility_json).workspaceAutomationAllowed === false
    ) {
      continue;
    }

    let triggerDefinitions: unknown;
    try {
      triggerDefinitions = JSON.parse(subscription.trigger_definitions_json) as unknown;
    } catch {
      continue;
    }
    const parsedTriggers = z.array(TriggerDefinitionSchema).safeParse(triggerDefinitions);
    if (!parsedTriggers.success) continue;
    const connectorBindings = parseRecord(subscription.connector_bindings_json);
    const activityTriggerBindings = parseRecord(subscription.activity_trigger_bindings_json);

    let matched = false;
    for (const trigger of parsedTriggers.data) {
      if (await triggerMatches(env, activity, trigger, resourceIds, connectorBindings, activityTriggerBindings)) {
        matched = true;
        break;
      }
    }
    if (matched) {
      const workstreamId = await startActivityAutomation(env, activity, subscription);
      if (workstreamId) createdWorkstreamIds.add(workstreamId);
    }
  }
  return createdWorkstreamIds;
}

async function matchingResourceIds(env: Env, activity: ActivityRow): Promise<Set<string>> {
  const entityKeys = parseStrings(activity.entity_keys_json);
  if (!activity.provider_resource_id && entityKeys.length === 0) return new Set();
  const resources = await env.DB.prepare(
    `SELECT id FROM resources
      WHERE workspace_id = ?1 AND connection_id = ?2 AND provider = ?3
        AND (
          provider_resource_id = ?4
          OR EXISTS (
            SELECT 1 FROM json_each(?5)
            WHERE json_each.value = resources.provider_resource_id
          )
        )`
  )
    .bind(activity.workspace_id, activity.connection_id, activity.provider, activity.provider_resource_id, JSON.stringify(entityKeys))
    .all<{ id: string }>();
  return new Set(resources.results.map((resource) => resource.id));
}

async function triggerMatches(
  env: Env,
  activity: ActivityRow,
  trigger: TriggerDefinition,
  resourceIds: Set<string>,
  connectorBindings: Record<string, unknown>,
  activityTriggerBindings: Record<string, unknown>,
): Promise<boolean> {
  if (trigger.type === "connector_activity" || trigger.type === "webhook" || trigger.type === "semantic_activity") {
    if (trigger.sourceBindingKey) {
      const sourcePluginId = activityTriggerBindings[trigger.sourceBindingKey];
      if (typeof sourcePluginId !== "string" || connectorBindings[sourcePluginId] !== activity.connection_id) {
        return false;
      }
    } else if (!Object.values(connectorBindings).includes(activity.connection_id)) {
      return false;
    }
  }
  if (trigger.type === "connector_activity") {
    return (
      (trigger.connectorType === activity.connector_type || trigger.connectorType === activity.provider) &&
      trigger.eventTypes.includes(activity.event_type) &&
      matchesFilters(activity, trigger.deterministicFilters)
    );
  }
  if (trigger.type === "webhook") {
    return activity.connector_type === "generic_webhook" && trigger.eventTypes.includes(activity.event_type);
  }
  if (trigger.type === "resource_watch") return resourceIds.has(trigger.resourceId);
  if (trigger.type !== "semantic_activity") return false;
  if (trigger.connectorType && trigger.connectorType !== activity.connector_type && trigger.connectorType !== activity.provider) {
    return false;
  }
  if (!matchesFilters(activity, trigger.deterministicPrefilter)) return false;
  if (!env.OPENROUTER_API_KEY) return false;

  const { result } = await runStructuredInference(env, {
    role: "activity_structured",
    context: { workspaceId: activity.workspace_id },
    messages: renderSemanticTriggerMessages({
      condition: trigger.condition,
      activity: {
        provider: activity.provider,
        eventType: activity.event_type,
        title: activity.title,
        summary: activity.summary,
        textSnippet: activity.text_snippet.slice(0, 2_000),
      },
    }),
    schemaName: "semantic_activity_trigger",
    jsonSchema: semanticTriggerJsonSchema,
    parse: (value) => SemanticTriggerResultSchema.parse(value)
  });
  return result.matches && result.confidence >= 0.8;
}

async function startActivityAutomation(
  env: Env,
  activity: ActivityRow,
  subscription: SubscriptionRow
): Promise<string | null> {
  const emailRouting = new WorkstreamEmailRoutingService(env);
  const audienceUserId = subscription.owner_user_id ?? subscription.template_owner_user_id;
  let run = await env.DB.prepare(
    `SELECT id, workstream_id, workflow_instance_id, status
       FROM automation_runs
      WHERE automation_subscription_id = ?1 AND trigger_activity_id = ?2
      LIMIT 1`
  )
    .bind(subscription.id, activity.id)
    .first<{ id: string; workstream_id: string; workflow_instance_id: string | null; status: string }>();

  let harnessRunId: string;
  const now = new Date().toISOString();
  const principal = ExecutionPrincipalSchema.parse(JSON.parse(subscription.execution_principal_json));

  if (!run) {
    const workstreamId = uuidV7();
    const runId = uuidV7();
    harnessRunId = uuidV7();
    const emailRoute = await emailRouting.reserve({
      region: activity.workspace_region,
      workspaceId: activity.workspace_id,
      workstreamId,
    });
    // The automation's pin follows the work streams its runs create. The work
    // stream is provisioned below, alongside its harness run, so the pin cannot
    // be read back from the row yet — it is the value being written beside it.
    const modelOverride = automationModelOverride(env, subscription.model_override, {
      workspaceId: activity.workspace_id,
      automationSubscriptionId: subscription.id,
    });
    const model = modelOverride ?? await scheduledWorkstreamModel(env, {
      workspaceId: activity.workspace_id,
      workstreamId,
    });
    const executionEnv = await bootstrapWorkstreamRuntimeEnvironment(
      env,
      activity.workspace_id,
      workstreamId,
    );
    const runStatement = env.DB.prepare(
      `INSERT INTO automation_runs (
         id, workspace_id, automation_subscription_id, workstream_id, trigger_type,
         trigger_activity_id, planned_for, started_at, completed_at, status,
         result_summary, workflow_instance_id, created_at
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, NULL, 'running', NULL, NULL, ?7)`,
    ).bind(runId, activity.workspace_id, subscription.id, workstreamId, activity.event_type, activity.id, now);
    // The regional row is a control-plane run record; the work stream and
    // harness run below belong to the newly bootstrapped object.
    const inserted = await runStatement.run();
    const controlRunInserted = (inserted.meta.changes ?? 0) > 0;
    try {
      await provisionWorkstreamObject(env, {
        workspaceId: asWorkspaceId(activity.workspace_id),
        workstreamId: asWorkstreamId(workstreamId),
        title: `${subscription.template_name}: ${activity.title}`.slice(0, 180),
        objective: subscription.template_description,
        scope: subscription.scope,
        originType: "automation",
        createdByUserId: audienceUserId,
        participantUserIds: [audienceUserId],
        harnessStatus: "scheduled",
        emailAddress: emailRoute.emailAddress,
        emailRouteStatus: "reserved",
        systemKind: null,
        automationSubscriptionId: subscription.id,
        // The routed batch wrote this as a fifth statement, a bare `UPDATE`
        // after the insert that had just written the same row. It is one field
        // of what the work stream is, so it is provisioned with the rest.
        automationRunId: runId,
        plannedFor: null,
        modelOverride: modelOverride,
        now: Date.parse(now),
      });
      await createHarnessRunObjectPort(
        executionEnv,
        activity.workspace_id,
        workstreamId,
      ).admitRun({
        runId: harnessRunId,
        origin: "automation_activity",
        executionPrincipalJson: JSON.stringify(principal),
        status: "admitted",
        startedAt: Date.parse(now),
        model,
        triggerPartId: null,
        parentRunId: null,
        supersedeActive: false,
        expectedLatestRunId: null,
        now: Date.parse(now),
      });
    } catch (error) {
      if (controlRunInserted) {
        try {
          const deleted = await env.DB.prepare(
            `DELETE FROM automation_runs
              WHERE id = ? AND workspace_id = ? AND workflow_instance_id IS NULL
              RETURNING id`,
          ).bind(runId, activity.workspace_id).first<{ id: string }>();
          if (deleted?.id !== runId) {
            throw new Error("activity_automation_run_compensation_not_applied", { cause: error });
          }
        } catch (compensationError) {
          throw new AggregateError(
            [error, compensationError],
            "activity_automation_run_compensation_failed",
            { cause: compensationError },
          );
        }
      }
      throw error;
    }
    await recordWorkstreamCreatedTelemetry(env, {
      workspaceId: asWorkspaceId(activity.workspace_id),
      workstreamId,
      creationSource: "automation_activity",
      connectorTypes: [activity.connector_type],
      principal: principal.type === "user"
        ? { type: "user", userId: principal.userId }
        : { type: "workspace" },
    });
    run = { id: runId, workstream_id: workstreamId, workflow_instance_id: null, status: "running" };
  } else {
    const executionEnv = await workstreamExecutionEnvironment(
      env,
      activity.workspace_id,
      run.workstream_id,
    );
    const harness = await createHarnessRunObjectPort(
      executionEnv,
      activity.workspace_id,
      run.workstream_id,
    ).latestRootRun();
    if (!harness) throw new Error("activity_harness_run_missing");
    harnessRunId = harness.run_id;
  }

  await emailRouting.ensureWorkstreamAddress({
    region: activity.workspace_region,
    workspaceId: activity.workspace_id,
    workstreamId: run.workstream_id,
  });

  // The activity is the whole reason this work stream exists, so the object
  // behind it is attached before the Workflow starts — the run's first context
  // read then already names the issue, page, or thread it is about. Ownerless on
  // purpose: an automation fired, nobody attached anything.
  //
  // On both run paths, not only the one that just created the work stream. A
  // queue invocation killed after the batch commits but before this write leaves
  // the run durable and the origin missing; the redelivery then takes the
  // existing-run branch and would launch the Workflow permanently without it.
  // Both writes behind this are `ON CONFLICT DO NOTHING`, so repeating it costs
  // one lookup and fixes that.
  const originResource = await describeWorkstreamOrigin(env, {
    connectorType: activity.connector_type,
    connectionId: activity.connection_id,
    provider: activity.provider,
    locator: activityOriginLocator(activity),
  });
  if (originResource) {
    await attachWorkstreamOriginResource(env, {
      workspaceId: activity.workspace_id,
      workstreamId: run.workstream_id,
      attachedByUserId: null,
      descriptor: originResource,
    });
  }

  if (["completed", "failed", "needs_input"].includes(run.status)) return run.workstream_id;
  const workflowInput: WorkstreamWorkflowInput = WorkstreamWorkflowInputSchema.parse({
    region: activity.workspace_region,
    workspaceId: activity.workspace_id,
    workstreamId: run.workstream_id,
    harnessRunId,
    triggerMessageId: null,
    automationSubscriptionId: subscription.id,
    activityId: activity.id,
    executionPrincipal: principal,
    reason: `Connected activity matched ${subscription.template_name}`
  });

  const workflowId = await startWorkstreamWorkflow(env, workflowInput);

  const executionEnv = await workstreamExecutionEnvironment(
    env,
    activity.workspace_id,
    run.workstream_id,
  );
  const reconcileWorkflowId = () => Promise.all([
    env.DB.prepare(
      `UPDATE automation_runs SET workflow_instance_id = ?1 WHERE id = ?2 AND workspace_id = ?3`,
    ).bind(workflowId, run.id, activity.workspace_id).run(),
    createHarnessRunObjectPort(executionEnv, activity.workspace_id, run.workstream_id)
      .bindWorkflowInstance({
        runId: harnessRunId,
        workflowInstanceId: workflowId,
        now: Date.now(),
      }),
  ]);
  try {
    await reconcileWorkflowId();
  } catch {
    await reconcileWorkflowId();
  }
  return run.workstream_id;
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
  excludedWorkstreamIds: Set<string>
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
  const candidates = await (await workspaceDirectory(env, asWorkspaceId(activity.workspace_id)))
    .routingCandidates({
      workspaceId: activity.workspace_id,
      audience: sourceAudience,
      excludedWorkstreamIds: [...excludedWorkstreamIds],
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
  routeDirectWatches,
  routeContextually,
  runMatchingAutomations,
  contentAudienceContainsWorkstream,
  triggerMatches,
};
