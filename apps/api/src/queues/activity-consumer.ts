import {
  OpenRouterClient,
  renderActivityRoutingMessages,
  renderSemanticTriggerMessages,
} from "@avalon/agent-harness";
import { connectorRetryAfterMs } from "@avalon/connectors";
import {
  ActivityQueueMessageSchema,
  ActivityRoutingResultSchema,
  ExecutionPrincipalSchema,
  SlackIngressQueueMessageSchema,
  TriggerDefinitionSchema,
  WorkstreamWorkflowInputSchema,
  type ActivityQueueMessage,
  type Message as AvalonMessage,
  type WorkstreamWorkflowInput
} from "@avalon/contracts";
import { z } from "zod";

import type { Env } from "../env";
import { createActivitySuggestion, publishWorkstreamRoomEvent } from "../services/activity-suggestion-service";
import { WorkstreamEmailRoutingService } from "../services/workstream-email-routing-service";
import { SlackAgentService } from "../services/slack-agent-service";
import { resolveAgentModelRouting, scheduledWorkstreamModel } from "../services/agent-model-flags";
import { enqueueActivityOpportunity } from "../services/work-opportunity-batching";

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
  occurred_at: string;
  received_at: string;
  title: string;
  summary: string;
  text_snippet: string;
  visibility_json: string;
  target_user_ids_json: string;
  entity_keys_json: string;
  metadata_json: string;
  processing_status: "pending" | "processing" | "processed" | "failed";
}

interface SubscriptionRow {
  id: string;
  scope: "personal" | "workspace";
  owner_user_id: string | null;
  execution_principal_json: string;
  connector_bindings_json: string;
  activity_trigger_bindings_json: string;
  trigger_definitions_json: string;
  template_name: string;
  template_description: string;
}

interface WorkstreamCandidate {
  id: string;
  title: string;
  objective: string;
  last_activity_at: string;
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

function workflowAlreadyExists(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /(already exists|duplicate|conflict)/i.test(error.message);
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
  if (activity.connection_scope === "personal") {
    return activity.connection_owner_user_id === ownerUserId;
  }
  const explicitTargets = parseStrings(activity.target_user_ids_json);
  const visibility = parseRecord(activity.visibility_json);
  const restricted = z.array(z.string()).safeParse(explicitTargets.length > 0
    ? explicitTargets
    : visibility.targetUserIds ?? visibility.allowedUserIds);
  return !restricted.success || restricted.data.length === 0 || restricted.data.includes(ownerUserId);
}

/** Cloudflare Queue entrypoint: only opaque activity identifiers arrive here. */
export async function consumeActivityQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  await Promise.all(batch.messages.map((message) => consumeOne(message, env)));
}

export const activityQueueConsumer = consumeActivityQueue;

/** Repairs the commit-before-queue-send window for every connector ingress. */
export async function recoverPendingActivityQueue(env: Env, limit = 100): Promise<number> {
  const staleBefore = new Date(Date.now() - 60_000).toISOString();
  const pending = await env.DB.prepare(
    `SELECT a.id, a.workspace_id, w.region
     FROM activities a
     JOIN workspaces w ON w.id = a.workspace_id
     WHERE a.processing_status = 'pending' AND a.received_at <= ?
       AND w.region = ?
     ORDER BY a.received_at ASC, a.id ASC
     LIMIT ?`,
  ).bind(staleBefore, env.AVALON_REGION, Math.max(1, Math.min(limit, 100))).all<{
    id: string;
    workspace_id: string;
    region: "global" | "eu";
  }>();
  if (pending.results.length === 0) return 0;
  await env.ACTIVITY_QUEUE.sendBatch(pending.results.map((activity) => ({
    body: ActivityQueueMessageSchema.parse({
      region: activity.region,
      workspaceId: activity.workspace_id,
      activityId: activity.id,
      attempt: 0,
    }),
  })));
  return pending.results.length;
}

async function consumeOne(message: Message<unknown>, env: Env): Promise<void> {
  const slackIngress = SlackIngressQueueMessageSchema.safeParse(message.body);
  if (slackIngress.success) {
    if (slackIngress.data.region !== env.AVALON_REGION) {
      message.ack();
      return;
    }
    try {
      await new SlackAgentService(env).processQueuedIngress(slackIngress.data.jobId);
      message.ack();
    } catch (error) {
      console.warn("Slack ingress queue processing failed", {
        job_id: slackIngress.data.jobId,
        reason: error instanceof Error ? error.message : "unknown",
      });
      const attempts = Math.max(1, message.attempts);
      const exponentialDelay = Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6));
      const providerDelay = Math.ceil((connectorRetryAfterMs(error) ?? 0) / 1_000);
      message.retry({ delaySeconds: Math.min(43_200, Math.max(exponentialDelay, providerDelay)) });
    }
    return;
  }

  const parsed = ActivityQueueMessageSchema.safeParse(message.body);
  if (!parsed.success) {
    message.ack();
    return;
  }

  const input = parsed.data;
  if (input.region !== env.AVALON_REGION) {
    message.ack();
    return;
  }

  const claimId = crypto.randomUUID();
  let claimed = false;
  try {
    const activity = await loadActivity(env, input);
    if (!activity || activity.processing_status === "processed") {
      message.ack();
      return;
    }

    const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
    const claim = await env.DB.prepare(
      `UPDATE activities
          SET processing_status = 'processing',
              metadata_json = json_set(
                COALESCE(metadata_json, '{}'),
                '$._processing_claim_id', ?1,
                '$._processing_claimed_at', ?2
              )
        WHERE id = ?3
          AND workspace_id = ?4
          AND (
            processing_status IN ('pending', 'failed')
            OR (
              processing_status = 'processing'
              AND COALESCE(json_extract(metadata_json, '$._processing_claimed_at'), '') < ?5
            )
          )`
    )
      .bind(claimId, new Date().toISOString(), input.activityId, input.workspaceId, staleBefore)
      .run();
    claimed = (claim.meta.changes ?? 0) === 1;
    if (!claimed) {
      message.retry({ delaySeconds: 30 });
      return;
    }

    const directWorkstreamIds = await routeDirectWatches(env, activity);
    const automationWorkstreamIds = await runMatchingAutomations(env, activity);
    for (const workstreamId of automationWorkstreamIds) directWorkstreamIds.add(workstreamId);
    const routedContextually = await routeContextually(env, activity, directWorkstreamIds);
    if (directWorkstreamIds.size === 0 && !routedContextually) {
      await enqueueActivityOpportunity(env, activity.id);
    }

    await env.DB.prepare(
      `UPDATE activities
          SET processing_status = 'processed',
              metadata_json = json_remove(
                json_remove(metadata_json, '$._processing_claim_id'),
                '$._processing_claimed_at'
              )
        WHERE id = ?1
          AND workspace_id = ?2
          AND json_extract(metadata_json, '$._processing_claim_id') = ?3`
    )
      .bind(activity.id, activity.workspace_id, claimId)
      .run();
    message.ack();
  } catch (error) {
    if (claimed) {
      await env.DB.prepare(
        `UPDATE activities
            SET processing_status = 'failed',
                metadata_json = json_set(
                  json_remove(metadata_json, '$._processing_claim_id'),
                  '$._processing_error', ?1
                )
          WHERE id = ?2
            AND workspace_id = ?3
            AND json_extract(metadata_json, '$._processing_claim_id') = ?4`
      )
        .bind(
          error instanceof Error ? error.message.slice(0, 500) : "activity_processing_failed",
          input.activityId,
          input.workspaceId,
          claimId
        )
        .run();
    }
    const attempts = Math.max(1, message.attempts);
    message.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(attempts - 1, 6)) });
  }
}

async function loadActivity(env: Env, input: ActivityQueueMessage): Promise<ActivityRow | null> {
  return env.DB.prepare(
    `SELECT a.*, w.region AS workspace_region, c.connector_type
       FROM activities a
       JOIN workspaces w ON w.id = a.workspace_id
       JOIN connector_connections c ON c.id = a.connection_id
      WHERE a.id = ?1 AND a.workspace_id = ?2 AND w.region = ?3
      LIMIT 1`
  )
    .bind(input.activityId, input.workspaceId, input.region)
    .first<ActivityRow>();
}

async function routeDirectWatches(env: Env, activity: ActivityRow): Promise<Set<string>> {
  const entityKeys = parseStrings(activity.entity_keys_json);
  if (!activity.provider_resource_id && entityKeys.length === 0) return new Set();

  const direct = await env.DB.prepare(
    `SELECT DISTINCT wr.workstream_id
       FROM resources r
       JOIN workstream_resources wr ON wr.resource_id = r.id
       JOIN workstreams w ON w.id = wr.workstream_id
      WHERE r.workspace_id = ?1
        AND r.connection_id = ?2
        AND r.provider = ?3
        AND (
          r.provider_resource_id = ?4
          OR EXISTS (
            SELECT 1 FROM json_each(?5)
            WHERE json_each.value = r.provider_resource_id
          )
        )
        AND wr.watch_enabled = 1
        AND w.archived_at IS NULL`
  )
    .bind(activity.workspace_id, activity.connection_id, activity.provider, activity.provider_resource_id, JSON.stringify(entityKeys))
    .all<{ workstream_id: string }>();

  const routed = new Set<string>();
  for (const row of direct.results) {
    if (
      activity.connection_scope === "personal" &&
      activity.connection_owner_user_id &&
      !(await isWorkstreamVisibleToUser(env, row.workstream_id, activity.connection_owner_user_id))
    ) {
      continue;
    }
    if (await injectActivityMessage(env, activity, row.workstream_id)) {
      routed.add(row.workstream_id);
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
  const existing = await env.DB.prepare(
    `SELECT 1 FROM messages WHERE workstream_id = ?1 AND client_message_id = ?2 LIMIT 1`
  )
    .bind(workstreamId, clientMessageId)
    .first();
  if (existing) return true;

  const sequence = await env.DB.prepare(
    `UPDATE workstreams
        SET next_sequence_number = next_sequence_number + 1
      WHERE id = ?1 AND workspace_id = ?2
      RETURNING next_sequence_number - 1 AS sequence_number`
  )
    .bind(workstreamId, activity.workspace_id)
    .first<{ sequence_number: number }>();
  if (!sequence) return false;

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const text = [activity.title, activity.summary].filter(Boolean).join(" — ");
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO messages (
       id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
       message_type, text_content, structured_content_json, sequence_number, created_at, edited_at
     ) VALUES (?1, ?2, ?3, ?4, 'system', NULL, 'system', ?5, ?6, ?7, ?8, NULL)`
  )
    .bind(
      id,
      clientMessageId,
      activity.workspace_id,
      workstreamId,
      text,
      JSON.stringify({
        kind: "connected_activity",
        activityId: activity.id,
        provider: activity.provider,
        eventType: activity.event_type
      }),
      sequence.sequence_number,
      createdAt
    )
    .run();
  if ((inserted.meta.changes ?? 0) === 0) return true;

  await env.DB.prepare(
    `UPDATE workstreams
        SET latest_attention_sequence_number = MAX(latest_attention_sequence_number, ?1),
            last_activity_at = ?2,
            updated_at = ?2
      WHERE id = ?3 AND workspace_id = ?4`
  )
    .bind(sequence.sequence_number, createdAt, workstreamId, activity.workspace_id)
    .run();

  const canonicalMessage: AvalonMessage = {
    id,
    clientMessageId,
    workspaceId: activity.workspace_id,
    workstreamId,
    author: { type: "system" },
    messageType: "system",
    textContent: text,
    structuredContent: {
      kind: "connected_activity",
      activityId: activity.id,
      provider: activity.provider,
      eventType: activity.event_type
    },
    mentions: [],
    attachments: [],
    sequenceNumber: sequence.sequence_number,
    createdAt,
    editedAt: null
  };
  await publishWorkstreamRoomEvent(env, activity.workspace_region, activity.workspace_id, workstreamId, {
    type: "message_created",
    message: canonicalMessage
  });
  return true;
}

async function runMatchingAutomations(env: Env, activity: ActivityRow): Promise<Set<string>> {
  const subscriptions = await env.DB.prepare(
    `SELECT s.id, s.scope, s.owner_user_id, s.execution_principal_json,
            s.connector_bindings_json, s.activity_trigger_bindings_json,
            tv.trigger_definitions_json, t.name AS template_name,
            t.description AS template_description
       FROM automation_subscriptions s
       JOIN automation_template_versions tv ON tv.id = s.template_version_id
       JOIN automation_templates t ON t.id = s.template_id
      WHERE s.workspace_id = ?1 AND s.status = 'active'`
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

  const client = await structuredClient(env, activity.workspace_id);
  const result = await client.structured({
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
    const workstreamId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    harnessRunId = crypto.randomUUID();
    const emailRoute = await emailRouting.reserve({
      region: activity.workspace_region,
      workspaceId: activity.workspace_id,
      workstreamId,
    });
    const model = await scheduledWorkstreamModel(env, {
      workspaceId: activity.workspace_id,
      workstreamId,
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workstreams (
           id, workspace_id, title, objective, email_address, email_route_status, origin_type, created_by_user_id,
           automation_subscription_id, automation_run_id, planned_for, harness_status,
           next_sequence_number, last_activity_at, created_at, updated_at, archived_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, 'reserved', 'automation', NULL, ?6, NULL, NULL, 'running', 1, ?7, ?7, ?7, NULL)`
      ).bind(
        workstreamId,
        activity.workspace_id,
        `${subscription.template_name}: ${activity.title}`.slice(0, 180),
        subscription.template_description,
        emailRoute.emailAddress,
        subscription.id,
        now
      ),
      env.DB.prepare(
        `INSERT INTO automation_runs (
           id, workspace_id, automation_subscription_id, workstream_id, trigger_type,
           trigger_activity_id, planned_for, started_at, completed_at, status,
           result_summary, workflow_instance_id, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, NULL, 'running', NULL, NULL, ?7)`
      ).bind(runId, activity.workspace_id, subscription.id, workstreamId, activity.event_type, activity.id, now),
      env.DB.prepare(
        `INSERT INTO harness_runs (
           id, workspace_id, workstream_id, origin, execution_principal_json,
           workflow_instance_id, parent_harness_run_id, status, started_at, completed_at,
           model, usage_json, error_json, created_at
         ) VALUES (?1, ?2, ?3, 'automation_activity', ?4, NULL, NULL, 'scheduled', ?5,
                   NULL, ?6, '{}', NULL, ?5)`
      ).bind(
        harnessRunId,
        activity.workspace_id,
        workstreamId,
        JSON.stringify(principal),
        now,
        model
      ),
      env.DB.prepare(
        `UPDATE workstreams SET automation_run_id = ?1 WHERE id = ?2 AND workspace_id = ?3`
      ).bind(runId, workstreamId, activity.workspace_id)
    ]);
    run = { id: runId, workstream_id: workstreamId, workflow_instance_id: null, status: "running" };
  } else {
    const harness = await env.DB.prepare(
      `SELECT id FROM harness_runs
        WHERE workstream_id = ?1 AND parent_tool_call_id IS NULL
          AND origin != 'hypersight_block'
        ORDER BY created_at DESC LIMIT 1`
    )
      .bind(run.workstream_id)
      .first<{ id: string }>();
    if (!harness) throw new Error("activity_harness_run_missing");
    harnessRunId = harness.id;
  }

  await emailRouting.ensureWorkstreamAddress({
    region: activity.workspace_region,
    workspaceId: activity.workspace_id,
    workstreamId: run.workstream_id,
  });

  if (["completed", "failed", "needs_input"].includes(run.status)) return run.workstream_id;
  const workflowId = `activity-${subscription.id}-${activity.id}`;
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

  try {
    await env.WORKSTREAM_LOOP_WORKFLOW.create({ id: workflowId, params: workflowInput });
  } catch (error) {
    if (!workflowAlreadyExists(error)) throw error;
  }

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE automation_runs SET workflow_instance_id = ?1 WHERE id = ?2 AND workspace_id = ?3`
    ).bind(workflowId, run.id, activity.workspace_id),
    env.DB.prepare(
      `UPDATE harness_runs SET workflow_instance_id = ?1 WHERE id = ?2 AND workspace_id = ?3`
    ).bind(workflowId, harnessRunId, activity.workspace_id)
  ]);
  return run.workstream_id;
}

async function routeContextually(
  env: Env,
  activity: ActivityRow,
  excludedWorkstreamIds: Set<string>
): Promise<boolean> {
  if (!env.OPENROUTER_API_KEY) return false;
  const personalOwner = activity.connection_scope === "personal" ? activity.connection_owner_user_id : null;
  const candidates = await env.DB.prepare(
    `SELECT w.id, w.title, w.objective, w.last_activity_at
       FROM workstreams w
      WHERE w.workspace_id = ?1
        AND w.archived_at IS NULL
        AND w.harness_status IN ('idle', 'running', 'needs_input', 'scheduled')
        AND (?2 IS NULL OR w.created_by_user_id = ?2 OR EXISTS (
          SELECT 1 FROM workstream_participants wp
           WHERE wp.workstream_id = w.id AND wp.user_id = ?2 AND wp.removed_at IS NULL
        ))
      ORDER BY w.last_activity_at DESC
      LIMIT 12`
  )
    .bind(activity.workspace_id, personalOwner)
    .all<WorkstreamCandidate>();
  const eligible = candidates.results.filter((candidate) => !excludedWorkstreamIds.has(candidate.id));
  if (eligible.length === 0) return false;

  const client = await structuredClient(env, activity.workspace_id);
  const result = await client.structured({
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

  if (!result.suggest || result.confidence < 0.8 || !result.candidateWorkstreamId) return false;
  if (!eligible.some((candidate) => candidate.id === result.candidateWorkstreamId)) return false;
  await createActivitySuggestion(env, {
    region: activity.workspace_region,
    workspaceId: activity.workspace_id,
    activityId: activity.id,
    activityTitle: activity.title,
    activitySummary: activity.summary,
    workstreamId: result.candidateWorkstreamId,
    confidence: result.confidence,
    reason: result.reason,
    matchedEntities: result.matchedEntities,
  });
  return true;
}

async function structuredClient(env: Env, workspaceId: string): Promise<OpenRouterClient> {
  const routing = await resolveAgentModelRouting(env, "activity_structured", { workspaceId });
  return new OpenRouterClient({
    apiKey: env.OPENROUTER_API_KEY,
    primaryModel: routing.model,
    fallbackModels: routing.fallbackModels,
    appUrl: env.PUBLIC_API_BASE_URL,
    appName: "Avalon"
  });
}

async function isWorkstreamVisibleToUser(
  env: Env,
  workstreamId: string,
  userId: string
): Promise<boolean> {
  const visible = await env.DB.prepare(
    `SELECT 1
       FROM workstreams w
      WHERE w.id = ?1
        AND (w.created_by_user_id = ?2 OR EXISTS (
          SELECT 1 FROM workstream_participants wp
           WHERE wp.workstream_id = w.id AND wp.user_id = ?2 AND wp.removed_at IS NULL
        ))
      LIMIT 1`
  )
    .bind(workstreamId, userId)
    .first();
  return Boolean(visible);
}

export const __testing = {
  matchesFilters,
  triggerMatches,
};
