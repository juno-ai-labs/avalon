import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import {
  AutomationAgentSnapshotSchema,
  AutomationAttentionReasonSchema,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  AutomationDraftSchema,
  AgentModelOverrideSchema,
  AutomationDeliveryTargetSetSchema,
  AutomationDetailSchema,
  ActivitySourcePluginIdsSchema,
  ModelPluginIdSchema,
  ScopeSchema,
  isExternalEventTrigger,
  AutomationSetEvaluatorRulesInputV1Schema,
  AutomationSetEvaluatorRulesMutationSchema,
  AutomationScopeSchema,
  AutomationRunContextV1Schema,
  asAutomationId,
  asHarnessRunId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type AutomationAgentSnapshot,
  type AutomationDraft,
  type AutomationDraftTurnAdmissionRequest,
  type AutomationDetail,
  type AutomationSetEvaluatorRulesInputV1,
  type AutomationSetEvaluatorRulesMutation,
  type AutomationRunContextV1,
} from "@rally/contracts";
import {
} from "@rally/agent-harness";
import { z } from "zod";
import { sha256 } from "../lib/crypto";
import { assertDurableObjectJurisdiction } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import { classifyAutomationResult } from "../services/automation-result-disposition";
import { activateWorkstreamLoop } from "../services/integrations";
import {
  withWorkspaceRuntimeDatabase,
  workspaceRegionalDatabase,
} from "../services/workspace-runtime-database";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "../services/workstream-runtime-database";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";
import { createMessageObjectPort } from "../runtime/message-port";
import { automationModelOverride, scheduledWorkstreamModel } from "../services/agent-model-flags";
import { numericEnv, type Env } from "../env";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { substreamAgentName, substreamLoopId, workspaceDOName } from "./names";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { nextRRuleOccurrence } from "../lib/recurrence";
import { validateDraftEvaluatorRules } from "../services/external-event-evaluator";
import { WorkstreamEmailRoutingService } from "../services/workstream-email-routing-service";
import { attachWorkstreamRuntimeResource } from "../services/workstream-object-client";
import { workstreamImportHash } from "./workstream-import-hash";
import { AGENT_RUN_DISPATCH_LEASE_MS } from "./agent-run-dispatch-queue";
import {
  SCHEDULED_ALARM_SCHEMA_STATEMENTS,
  ScheduledDurableObject,
  scheduledAlarmRetryDelay,
  type ScheduledAlarm,
  type ScheduledAlarmOutcome,
} from "./scheduled-alarms";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";
import { ParticipantTranscriptStore } from "./ordered-transcript-sqlite/participant-transcript-store";
import { canonicalTranscriptJson } from "./ordered-transcript-sqlite/canonical-payload-store";
import { ORDERED_TRANSCRIPT_SCHEMA_V1 } from "./ordered-transcript-sqlite/schema-v1";
import {
  AutomationMemoryToolRequestSchema,
  automationMemorySchemaStatements,
  executeAutomationMemoryTool,
  importLegacyAutomationMemory,
  materializeAutomationMemoryDefinitions,
  readAutomationMemoryBootstrap,
} from "./automation-agent-memory";

/**
 * Every work-stream state a run projection can carry, and what it says about
 * the run.
 *
 * The keys are `workstreams.exact_state`'s own CHECK in `workstream-do.ts`,
 * plus `error` and `stopped`, which this projection has always accepted. Keep
 * them in step: a state WorkstreamDO can write and this map does not name is
 * refused by the parse, and that refusal takes down the whole directory-effect
 * batch rather than one run.
 *
 * `null` is deliberate and is not the same as "running". It marks a state that
 * describes the work stream rather than the run inside it, where the honest
 * answer is to leave the run's own execution state alone.
 */
const RUN_EXECUTION_STATE = {
  completed: "completed",
  failed: "failed",
  error: "failed",
  budget_exhausted: "failed",
  needs_input: "needs_input",
  stopped: "stopped",
  cancelled: "stopped",
  running: "running",
  scheduled: "running",
  preparing_context: "running",
  waiting_capacity: "running",
  interrupting: "running",
  idle: "running",
  archived: null,
  deleting: null,
  restoring: null,
} as const satisfies Record<string, "completed" | "failed" | "needs_input" | "stopped" | "running" | null>;

/** Once a run reads as one of these, no later projection moves it off. */
const TERMINAL_RUN_STATES = new Set(["completed", "failed", "stopped"]);

const RUN_PROJECTION_STATES = Object.keys(RUN_EXECUTION_STATE) as [
  keyof typeof RUN_EXECUTION_STATE,
  ...(keyof typeof RUN_EXECUTION_STATE)[],
];

const MIGRATION_COMPONENT = "automation_agent";
const COMPILER_DISPATCH_ALARM_KIND = "compiler_dispatch";
const AUTOMATION_SCHEDULE_ALARM_KIND = "automation_schedule";
const DEFAULT_AUTOMATION_EMAIL_MAX_RUNS_PER_HOUR = 30;

const AutomationInboundEmailAdmissionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  automationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  emailAddress: z.string().email(),
  resendEmailId: z.string().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/u),
  svixId: z.string().min(1).max(200),
  senderUserId: z.string().uuid().nullable(),
  receivedAt: z.number().int().nonnegative(),
  payloadRef: z.string().min(1),
  resourceId: z.string().uuid(),
  textContent: z.string().min(1),
  structuredContent: z.record(z.string(), z.unknown()),
});

const AutomationAcceptDraftRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  automationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  authorUserId: z.string().uuid(),
  definitionRevision: z.number().int().positive(),
  scope: AutomationScopeSchema,
  /**
   * The room that owns a `workstream` automation. Supplied by the Worker from
   * the loop the draft was submitted in, never by the model and never by the
   * request body's author: an agent cannot claim a room it is not running in.
   */
  owningWorkstreamId: z.string().uuid().nullable().default(null),
  /**
   * Whether the caller is an active participant of that room, resolved by the
   * Worker against the work stream's own object. It stands in for authorship on
   * a `workstream` acceptance, because the card is the room's to accept.
   */
  participantOfOwningWorkstream: z.boolean().default(false),
  defaultPluginIds: z.array(ModelPluginIdSchema),
  activitySourcePluginIds: ActivitySourcePluginIdsSchema,
  deliveryTargets: AutomationDeliveryTargetSetSchema,
  modelOverride: AgentModelOverrideSchema.nullable(),
  /**
   * The caller's workspace membership role, resolved by the Worker.
   *
   * It no longer gates acceptance. A workspace-scoped connection is already
   * visible and usable to every member — `connection-service.ts` lists
   * connections `WHERE workspace_id = ? AND (scope = 'workspace' OR
   * owner_user_id = ?)` — so a member can call that connection's tools from a
   * run in their own work stream today, by asking. What a workspace automation
   * adds is a *schedule* on something they can already do, not a capability
   * they lacked, and refusing that while permitting the same call by hand is a
   * rule that reads as governance and works as friction.
   *
   * What the workspace does acquire is a standing object it must manage, so
   * editing, pausing and deleting one stay owner-or-admin. Kept on the request
   * because the field is part of the shipped shape and a replayed acceptance
   * must still parse.
   */
  actorRole: z.string().optional(),
}).strict().superRefine((value, context) => {
  // The scope names the room; the room is not a second choice beside it.
  if ((value.scope === "workstream") !== (value.owningWorkstreamId !== null)) {
    context.addIssue({
      code: "custom",
      path: ["owningWorkstreamId"],
      message: "A work stream-scoped automation names the work stream that owns it, and no other scope may.",
    });
  }
});

const AutomationSocketRevocationSchema = z.strictObject({
  reason: z.string().min(1),
  workspaceId: z.string().uuid(),
  userId: z.string().uuid().nullable(),
  sessionId: z.string().min(1).nullable(),
});

const AutomationSocketIdentitySchema = z.strictObject({
  workspaceId: z.string().uuid(),
  userId: z.string().uuid(),
  automationId: z.string().uuid(),
  sessionId: z.string().min(1),
  ticketId: z.string().min(1),
  ticketExpiresAt: z.coerce.number().int().positive(),
});

const AutomationInboundEmailScreenSchema = z.strictObject({
  schemaVersion: z.literal(1),
  automationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  emailAddress: z.string().min(1),
  resendEmailId: z.string().min(1),
  /** Absent before the message is fetched; null once fetched and unresolvable. */
  senderUserId: z.string().uuid().nullable().optional(),
});

const AutomationLegacyImportRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  automationId: z.string().uuid(),
  workspaceId: z.string().uuid(),
  authorUserId: z.string().uuid(),
  region: z.enum(["global", "eu"]),
  sourceHash: z.string().min(1),
  source: z.strictObject({
    definition: AutomationDraftSchema,
    status: z.enum(["active", "paused", "error"]),
    scope: ScopeSchema,
    unsupportedTrigger: z.boolean(),
    defaultPluginIds: z.array(ModelPluginIdSchema),
    activitySourcePluginIds: ActivitySourcePluginIdsSchema,
    connectorBindings: z.record(z.string(), z.string()),
    deliveryTargets: AutomationRunContextV1Schema.shape.deliveryTargets,
    emailAddress: z.string().email().nullable(),
    modelOverride: AgentModelOverrideSchema.nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    schedules: z.array(z.strictObject({
      scheduleId: z.string().min(1),
      kind: z.enum(["calendar", "interval"]),
      definition: z.record(z.string(), z.unknown()),
      nextDueAt: z.number().int().nonnegative().nullable(),
    })),
    runs: z.array(z.strictObject({
      runId: z.string().uuid(),
      workstreamId: z.string().uuid(),
      triggerType: z.string().min(1),
      plannedFor: z.number().int().nonnegative().nullable(),
      status: z.enum(["scheduled", "running", "needs_input", "completed", "failed"]),
      workflowInstanceId: z.string().nullable(),
      createdAt: z.number().int().nonnegative(),
      updatedAt: z.number().int().nonnegative(),
    })),
    memoryRecords: z.array(z.strictObject({
      kind: z.enum([
        "scope",
        "item",
        "mutation",
        "index_receipt",
        "table",
        "table_column",
        "table_row",
        "table_cell",
        "table_mutation",
      ]),
      recordId: z.string().min(1),
      payload: z.record(z.string(), z.unknown()),
    })),
    /** The pre-cutover inbound-email dedupe ledger and its hourly windows. */
    inboundEmailReceipts: z.array(z.strictObject({
      resendEmailId: z.string().min(1),
      svixId: z.string().min(1),
      payloadRef: z.string().min(1).nullable(),
      workstreamId: z.string().uuid().nullable(),
      runId: z.string().uuid().nullable(),
      receivedAt: z.number().int().nonnegative(),
      refused: z.boolean(),
    })).optional(),
    inboundEmailRateWindows: z.array(z.strictObject({
      windowStartedAt: z.number().int().nonnegative(),
      acceptedCount: z.number().int().nonnegative(),
    })).optional(),
  }),
});

export const AUTOMATION_AGENT_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "canonical automation lifecycle and durable draft compiler",
  statements: [
    `CREATE TABLE automation_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      automation_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      author_user_id TEXT NOT NULL,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE automation_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'activating', 'active', 'paused', 'deleted')),
      title TEXT NOT NULL,
      definition_revision INTEGER NOT NULL CHECK (definition_revision >= 0),
      accepted_definition_revision INTEGER CHECK (accepted_definition_revision IS NULL OR accepted_definition_revision > 0),
      event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
      attention_code TEXT,
      attention_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    ...ORDERED_TRANSCRIPT_SCHEMA_V1,
    `CREATE TABLE automation_draft_message_metadata (
      turn_id TEXT PRIMARY KEY REFERENCES participant_transcript_turns(turn_id) ON DELETE CASCADE,
      client_message_id TEXT UNIQUE,
      attachment_ids_json TEXT NOT NULL CHECK (json_valid(attachment_ids_json)),
      compiler_run_id TEXT,
      input_mode TEXT CHECK (input_mode IS NULL OR input_mode IN ('typed', 'suggested_prompt', 'elicitation_response', 'edit'))
    ) STRICT`,
    `CREATE TABLE automation_compiler_runs (
      run_id TEXT PRIMARY KEY,
      admitted_turn_id TEXT REFERENCES participant_transcript_turns(turn_id),
      state TEXT NOT NULL CHECK (state IN ('admitted', 'running', 'needs_input', 'completed', 'failed', 'cancelled')),
      attempt INTEGER NOT NULL CHECK (attempt >= 0),
      request_id TEXT NOT NULL,
      input_mode TEXT NOT NULL CHECK (input_mode IN ('typed', 'suggested_prompt', 'elicitation_response', 'edit')),
      error_code TEXT,
      error_message TEXT,
      admitted_at INTEGER NOT NULL,
      started_at INTEGER,
      settled_at INTEGER,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE UNIQUE INDEX automation_compiler_runs_one_active_idx
      ON automation_compiler_runs((1))
      WHERE state IN ('admitted', 'running')`,
    `CREATE TABLE automation_definition_revisions (
      definition_revision INTEGER PRIMARY KEY CHECK (definition_revision > 0),
      compiler_run_id TEXT REFERENCES automation_compiler_runs(run_id),
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
      definition_hash TEXT NOT NULL,
      ready INTEGER NOT NULL CHECK (ready IN (0, 1)),
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE automation_pending_elicitations (
      elicitation_id TEXT PRIMARY KEY,
      definition_revision INTEGER NOT NULL REFERENCES automation_definition_revisions(definition_revision),
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      state TEXT NOT NULL CHECK (state IN ('pending', 'answered', 'cancelled')),
      created_at INTEGER NOT NULL,
      settled_at INTEGER
    ) STRICT`,
    `CREATE UNIQUE INDEX automation_pending_elicitation_one_idx
      ON automation_pending_elicitations((1)) WHERE state = 'pending'`,
    `CREATE TABLE automation_draft_evaluator_sets (
      compiler_run_id TEXT PRIMARY KEY REFERENCES automation_compiler_runs(run_id),
      provider_call_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      evaluator_rules_json TEXT NOT NULL CHECK (json_valid(evaluator_rules_json)),
      updated_at INTEGER NOT NULL,
      UNIQUE(compiler_run_id, provider_call_id)
    ) STRICT`,
    `CREATE TABLE automation_staged_submissions (
      compiler_run_id TEXT PRIMARY KEY REFERENCES automation_compiler_runs(run_id),
      provider_call_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      draft_json TEXT NOT NULL CHECK (json_valid(draft_json)),
      updated_at INTEGER NOT NULL,
      UNIQUE(compiler_run_id, provider_call_id)
    ) STRICT`,
    `CREATE TABLE automation_staged_elicitations (
      compiler_run_id TEXT PRIMARY KEY REFERENCES automation_compiler_runs(run_id),
      provider_call_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      elicitation_json TEXT NOT NULL CHECK (json_valid(elicitation_json)),
      updated_at INTEGER NOT NULL,
      UNIQUE(compiler_run_id, provider_call_id)
    ) STRICT`,
    `CREATE TABLE automation_tool_receipts (
      compiler_run_id TEXT NOT NULL REFERENCES automation_compiler_runs(run_id),
      provider_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      settled_at INTEGER NOT NULL,
      PRIMARY KEY(compiler_run_id, provider_call_id)
    ) STRICT`,
    `CREATE TABLE automation_realtime_events (
      event_sequence INTEGER PRIMARY KEY CHECK (event_sequence > 0),
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE automation_schedules (
      schedule_id TEXT PRIMARY KEY,
      schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('calendar', 'interval')),
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
      next_due_at INTEGER,
      paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX automation_schedules_due_idx
      ON automation_schedules(paused, next_due_at, schedule_id)`,
    `CREATE TABLE automation_acceptance (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      definition_revision INTEGER NOT NULL,
      request_hash TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      default_plugin_ids_json TEXT NOT NULL CHECK (json_valid(default_plugin_ids_json)),
      activity_source_plugin_ids_json TEXT NOT NULL CHECK (json_valid(activity_source_plugin_ids_json)),
      connector_bindings_json TEXT NOT NULL CHECK (json_valid(connector_bindings_json)),
      delivery_targets_json TEXT NOT NULL CHECK (json_valid(delivery_targets_json)),
      model_override TEXT,
      evaluator_projection_json TEXT NOT NULL CHECK (json_valid(evaluator_projection_json)),
      evaluator_source_hash TEXT NOT NULL,
      effective_after_event_sequence INTEGER,
      accepted_at INTEGER NOT NULL,
      activated_at INTEGER
    ) STRICT`,
    `CREATE TABLE automation_runs (
      run_id TEXT PRIMARY KEY,
      occurrence_key TEXT NOT NULL UNIQUE,
      trigger_type TEXT NOT NULL,
      planned_for INTEGER,
      workstream_id TEXT UNIQUE,
      harness_run_id TEXT UNIQUE,
      workflow_instance_id TEXT,
      admission_state TEXT NOT NULL CHECK (admission_state IN ('claimed', 'provisioning', 'provisioned', 'refused')),
      execution_state TEXT NOT NULL CHECK (execution_state IN ('pending', 'running', 'needs_input', 'completed', 'failed', 'stopped')),
      delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending', 'delivering', 'delivered', 'failed', 'not_requested')),
      context_json TEXT NOT NULL CHECK (json_valid(context_json)),
      source_version INTEGER NOT NULL DEFAULT 0 CHECK (source_version >= 0),
      source_hash TEXT,
      workstream_generation INTEGER NOT NULL DEFAULT 1 CHECK (workstream_generation > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX automation_runs_history_idx
      ON automation_runs(created_at DESC, run_id)`,
    `CREATE TABLE automation_trigger_receipts (
      workspace_event_id TEXT PRIMARY KEY,
      event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      event_type TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('held_for_activation', 'admitted', 'refused')),
      outcome_code TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE automation_outbox (
      effect_id TEXT PRIMARY KEY,
      effect_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'failed')),
      attempt INTEGER NOT NULL CHECK (attempt >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX automation_outbox_due_idx
      ON automation_outbox(state, not_before, created_at, effect_id)`,
    ...SCHEDULED_ALARM_SCHEMA_STATEMENTS,
  ],
}, {
  version: 2,
  description: "result delivery receipts and automation-owned durable memory",
  statements: [
    `CREATE TABLE automation_delivery_receipts (
      run_id TEXT NOT NULL REFERENCES automation_runs(run_id) ON DELETE CASCADE,
      target_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('delivered', 'skipped', 'failed')),
      outcome_code TEXT NOT NULL,
      delivered_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, target_key)
    ) STRICT`,
    `CREATE TABLE automation_memory_tables (
      table_id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      description TEXT NOT NULL,
      usage_instructions TEXT NOT NULL,
      key_columns_json TEXT NOT NULL CHECK (json_valid(key_columns_json)),
      schema_revision INTEGER NOT NULL DEFAULT 1 CHECK (schema_revision > 0),
      data_revision INTEGER NOT NULL DEFAULT 0 CHECK (data_revision >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE automation_memory_columns (
      column_id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL REFERENCES automation_memory_tables(table_id) ON DELETE CASCADE,
      name TEXT NOT NULL COLLATE NOCASE,
      description TEXT NOT NULL,
      value_type TEXT NOT NULL CHECK (value_type IN ('string', 'url', 'number', 'integer', 'boolean', 'datetime', 'date')),
      is_required INTEGER NOT NULL CHECK (is_required IN (0, 1)),
      is_searchable INTEGER NOT NULL CHECK (is_searchable IN (0, 1)),
      position INTEGER NOT NULL CHECK (position >= 0),
      UNIQUE(table_id, name),
      UNIQUE(table_id, position)
    ) STRICT`,
    `CREATE TABLE automation_memory_rows (
      row_id TEXT PRIMARY KEY,
      table_id TEXT NOT NULL REFERENCES automation_memory_tables(table_id) ON DELETE CASCADE,
      data_json TEXT NOT NULL CHECK (json_valid(data_json)),
      revision INTEGER NOT NULL CHECK (revision > 0),
      last_mutation_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX automation_memory_rows_table_idx
      ON automation_memory_rows(table_id, updated_at DESC, row_id)`,
    `CREATE TABLE automation_memory_mutations (
      mutation_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      input_hash TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      settled_at INTEGER NOT NULL
    ) STRICT`,
  ],
}, {
  version: 3,
  description: "receipt for one-shot WorkspaceDO automation import",
  statements: [
    `CREATE TABLE automation_import_receipt (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      source_hash TEXT NOT NULL,
      imported_at INTEGER NOT NULL
    ) STRICT`,
  ],
}, {
  version: 4,
  description: "preserve complete legacy automation memory during cutover",
  statements: [
    `CREATE TABLE automation_email_route (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      email_address TEXT NOT NULL COLLATE NOCASE,
      claimed_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE automation_imported_memory_records (
      record_kind TEXT NOT NULL CHECK (record_kind IN (
        'scope', 'item', 'mutation', 'index_receipt', 'table',
        'table_column', 'table_row', 'table_cell', 'table_mutation'
      )),
      record_id TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      PRIMARY KEY(record_kind, record_id)
    ) STRICT`,
  ],
}, {
  version: 5,
  description: "automation-owned inbound email admission receipts and rate windows",
  statements: [
    `CREATE TABLE automation_inbound_email_receipts (
      resend_email_id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL UNIQUE,
      svix_id TEXT NOT NULL,
      sender_user_id TEXT,
      -- Nullable only for a receipt carried in by the cutover. This object
      -- never stored the payload or the resource for mail the legacy runtime
      -- admitted before it existed, and inventing a reference to either would
      -- be worse than saying there is none: the row is here to answer "have we
      -- already seen this Resend message", which is what stops a webhook retry
      -- that straddles the cutover from admitting the same email twice and
      -- running the automation again. Every receipt this object writes itself
      -- has both.
      payload_ref TEXT,
      resource_id TEXT,
      run_id TEXT REFERENCES automation_runs(run_id),
      workstream_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('admitted', 'refused')),
      outcome_code TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE automation_inbound_email_rate_windows (
      window_started_at INTEGER PRIMARY KEY,
      accepted_count INTEGER NOT NULL CHECK (accepted_count >= 0)
    ) STRICT`,
  ],
}, {
  version: 6,
  description: "fenced automation memory items and complete mutation receipts",
  statements: automationMemorySchemaStatements,
}, {
  version: 7,
  description: "one-time socket ticket receipts and a monotonic projection counter",
  statements: [
    // Separate from `event_sequence`, which acceptance resets so the draft
    // conversation's realtime cursor starts clean. WorkspaceDO orders
    // projections by (generation, version) and discards anything not newer, so
    // a counter that can go backwards silently drops the activation projection
    // and leaves the directory describing a draft forever.
    `ALTER TABLE automation_state ADD COLUMN projection_version INTEGER NOT NULL DEFAULT 0`,
    // Stored per turn so a replayed admission answers with the coordinate it
    // originally allocated. Answering with a fresh one would let a replay of
    // the first turn overwrite newer directory state.
    `ALTER TABLE automation_draft_message_metadata ADD COLUMN projection_version INTEGER`,
    `CREATE TABLE automation_socket_ticket_receipts (
      ticket_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
      consumed_at INTEGER NOT NULL CHECK (consumed_at >= 0)
    ) STRICT`,
  ],
}, {
  version: 8,
  description: "what a completed run's result was worth, decided once per run",
  statements: [
    // Written once, before the delivery loop runs, and read by it. A delivery
    // retry after a crash re-reads the disposition rather than classifying
    // again, which is what stops one occurrence being judged differently the
    // second time and delivering what the first attempt withheld.
    `ALTER TABLE automation_runs ADD COLUMN disposition TEXT
       CHECK (disposition IS NULL OR disposition IN ('done', 'deliver', 'expose_workstream'))`,
    // Two ways to get an answer, and they are worth telling apart: "the
    // classifier decided" and "the classifier was unreachable and we delivered
    // anyway" produce identical deliveries and completely different follow-up.
    // A run of `default` rows across a workspace is the shape a routing outage
    // takes here — nothing errors, everything delivers, and only this says so.
    `ALTER TABLE automation_runs ADD COLUMN disposition_source TEXT
       CHECK (disposition_source IS NULL OR disposition_source IN ('classified', 'default'))`,
    `ALTER TABLE automation_runs ADD COLUMN disposition_reason TEXT`,
    `ALTER TABLE automation_runs ADD COLUMN disposition_at INTEGER
       CHECK (disposition_at IS NULL OR disposition_at >= 0)`,
  ],
}, {
  version: 9,
  description: "an automation a work stream owns, and why a paused one is paused",
  statements: [
    // A rebuild, because SQLite cannot alter a CHECK in place and this one has
    // to admit a third scope. The table holds one row, so the copy is exact and
    // cheap; what matters is that the constraint keeps saying what it said and
    // says one more thing.
    `CREATE TABLE automation_acceptance_v9 (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      definition_revision INTEGER NOT NULL,
      request_hash TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace', 'workstream')),
      -- The room that owns this automation, set exactly when the scope says so.
      -- Recorded at acceptance and never changed afterwards: the owning work
      -- stream is identity, not configuration, and moving it would change who
      -- may manage the automation and whose results it reaches.
      owning_workstream_id TEXT,
      default_plugin_ids_json TEXT NOT NULL CHECK (json_valid(default_plugin_ids_json)),
      activity_source_plugin_ids_json TEXT NOT NULL CHECK (json_valid(activity_source_plugin_ids_json)),
      connector_bindings_json TEXT NOT NULL CHECK (json_valid(connector_bindings_json)),
      delivery_targets_json TEXT NOT NULL CHECK (json_valid(delivery_targets_json)),
      model_override TEXT,
      evaluator_projection_json TEXT NOT NULL CHECK (json_valid(evaluator_projection_json)),
      evaluator_source_hash TEXT NOT NULL,
      effective_after_event_sequence INTEGER,
      accepted_at INTEGER NOT NULL,
      activated_at INTEGER,
      CHECK ((scope = 'workstream') = (owning_workstream_id IS NOT NULL))
    ) STRICT`,
    `INSERT INTO automation_acceptance_v9
       (id, definition_revision, request_hash, scope, owning_workstream_id,
        default_plugin_ids_json, activity_source_plugin_ids_json, connector_bindings_json,
        delivery_targets_json, model_override, evaluator_projection_json,
        evaluator_source_hash, effective_after_event_sequence, accepted_at, activated_at)
     SELECT id, definition_revision, request_hash, scope, NULL,
            default_plugin_ids_json, activity_source_plugin_ids_json, connector_bindings_json,
            delivery_targets_json, model_override, evaluator_projection_json,
            evaluator_source_hash, effective_after_event_sequence, accepted_at, activated_at
       FROM automation_acceptance`,
    `DROP TABLE automation_acceptance`,
    `ALTER TABLE automation_acceptance_v9 RENAME TO automation_acceptance`,
    // Why a paused automation is paused. Archiving a work stream pauses the
    // automations it owns and unarchiving resumes them — but resuming
    // everything is wrong: one a person paused last month must not come back
    // because somebody unarchived the room. Only rows that say
    // `workstream_archived` are resumed.
    `ALTER TABLE automation_state ADD COLUMN paused_reason TEXT
       CHECK (paused_reason IS NULL OR paused_reason IN ('person', 'workstream_archived'))`,
  ],
}, {
  version: 10,
  description: "who an automation runs as becomes state, separate from who wrote it",
  statements: [
    // The execution principal was derived from the identity row's
    // `author_user_id`, which is immutable and was always meant to be: the
    // author *was* the answer. An automation a work stream owns outlives its
    // author, so "who it runs as" has to be state somebody can take over,
    // while "who wrote it" stays provenance the run history keeps saying.
    // NULL means nobody has taken it over and the author still answers.
    `ALTER TABLE automation_state ADD COLUMN run_as_user_id TEXT`,
    // What a takeover did, kept because the claim moves somebody's own
    // credentials onto a standing automation. The run history shows it beside
    // the runs it repaired, and `unbound_providers_json` is why a card can stay
    // up naming only what is still missing.
    `CREATE TABLE automation_principal_claims (
      claim_id TEXT PRIMARY KEY,
      claimed_by_user_id TEXT NOT NULL,
      previous_user_id TEXT,
      rebound_plugin_ids_json TEXT NOT NULL CHECK (
        json_valid(rebound_plugin_ids_json) AND json_type(rebound_plugin_ids_json) = 'array'
      ),
      unbound_providers_json TEXT NOT NULL CHECK (
        json_valid(unbound_providers_json) AND json_type(unbound_providers_json) = 'array'
      ),
      claimed_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX automation_principal_claims_recent_idx
       ON automation_principal_claims(claimed_at DESC, claim_id)`,
  ],
}, {
  version: 11,
  description: "a draft remembers the work stream it was written in",
  statements: [
    // Where the conversation happened, held until somebody accepts. Ownership
    // is `automation_acceptance.owning_workstream_id`, which exists only once
    // there is an acceptance; before that the room is a fact about the draft,
    // and the only place a `workstream` acceptance can honestly get its room —
    // the model never names one and no other room is reachable.
    `ALTER TABLE automation_state ADD COLUMN authored_in_workstream_id TEXT`,
    // Where the conversation was, when it was somewhere an occurrence can
    // speak. Frozen into the run context at acceptance and rendered as standing
    // context, never into the instructions a person reads and edits.
    `ALTER TABLE automation_state ADD COLUMN authored_origin_json TEXT CHECK (
       authored_origin_json IS NULL
       OR (json_valid(authored_origin_json) AND json_type(authored_origin_json) = 'object')
     )`,
  ],
}, {
  version: 12,
  description: "evaluator rules for a draft written outside the compiler loop",
  statements: [
    // Keyed by revision, because an authored draft has no compiler run to key
    // by: `automation_definition_revisions.compiler_run_id` is NULL for one, so
    // the existing set's join can never match it. Without this an event-driven
    // draft written in a work stream is proposed as ready and then refused at
    // acceptance for rules it had no way to record.
    `CREATE TABLE automation_authored_evaluator_sets (
      definition_revision INTEGER PRIMARY KEY
        REFERENCES automation_definition_revisions(definition_revision),
      evaluator_rules_json TEXT NOT NULL CHECK (json_valid(evaluator_rules_json)),
      updated_at INTEGER NOT NULL
    ) STRICT`,
  ],
}];

/**
 * What set an occurrence off, in one line, for the classifier to read.
 *
 * A schedule says nothing beyond its kind — the point of a schedule is that
 * nothing in particular happened — while an external event names the activity
 * type, which is most of what tells a summary of a candidate email apart from a
 * summary of a spreadsheet save.
 */
/**
 * Whether a definition needs evaluator rules and does not have them.
 *
 * Submission and acceptance both refuse on this, and the defect each exists to
 * catch is what happens when they disagree: a draft the first admits and the
 * second refuses reaches a person as a proposal whose Create button cannot
 * work. They shared a written invariant before and drifted anyway, so they
 * share the predicate now — a missing set and an explicit empty one are one
 * answer here, because the tool documents `[]` as the way to clear rules.
 */
function evaluatorRulesMissing(
  draft: AutomationDraft,
  rules: AutomationSetEvaluatorRulesInputV1 | null,
): boolean {
  return draft.triggers.some(isExternalEventTrigger) && (rules?.evaluators.length ?? 0) === 0;
}

function automationTriggerSummary(trigger: AutomationRunContextV1["trigger"]): string | null {
  switch (trigger.kind) {
    case "external_event": return trigger.eventType;
    case "schedule": return trigger.scheduleKind;
    case "manual":
    case "inbound_email":
      return null;
  }
}

interface ActiveCompilerRow extends Record<string, SqlStorageValue> {
  run_id: string;
  state: "admitted" | "running" | "needs_input" | "completed" | "failed" | "cancelled";
  admitted_turn_id: string;
  error_code: string | null;
  error_message: string | null;
}

type AutomationAcceptanceRow = {
  definition_revision: number;
  request_hash: string;
  scope: "personal" | "workspace" | "workstream";
  owning_workstream_id: string | null;
  default_plugin_ids_json: string;
  activity_source_plugin_ids_json: string;
  connector_bindings_json: string;
  delivery_targets_json: string;
  model_override: string | null;
  evaluator_projection_json: string;
  evaluator_source_hash: string;
  effective_after_event_sequence: number | null;
  accepted_at: number;
  activated_at: number | null;
};

export class AutomationAgent extends ScheduledDurableObject<Env> {
  private readonly state: DurableObjectState;
  private readonly initialized: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    this.initialized = this.initializeDurableObject(async () => {
      await this.applyMigrations(() => applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: AUTOMATION_AGENT_SCHEMA_MIGRATIONS,
        component: MIGRATION_COMPONENT,
        workerVersionId: env.APP_VERSION ?? "unknown",
      }));
      await this.armNextAlarm();
    });
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  protected override migrationPlan() {
    return {
      component: MIGRATION_COMPONENT,
      className: "AutomationAgent",
      migrations: AUTOMATION_AGENT_SCHEMA_MIGRATIONS,
    };
  }

  protected override migrationsReady(): Promise<void> {
    return this.initialized;
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    if (request.method !== "GET" || new URL(request.url).pathname !== "/socket") {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "websocket_upgrade_required" }, { status: 426 });
    }
    const identity = AutomationSocketIdentitySchema.safeParse({
      workspaceId: readRallyHeader(request.headers, RALLY_HEADERS.WORKSPACE_ID) ?? null,
      userId: readRallyHeader(request.headers, RALLY_HEADERS.USER_ID) ?? null,
      automationId: readRallyHeader(request.headers, RALLY_HEADERS.AUTOMATION_ID) ?? null,
      sessionId: readRallyHeader(request.headers, RALLY_HEADERS.SESSION_ID) ?? null,
      ticketId: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_ID) ?? null,
      ticketExpiresAt: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_EXPIRES_AT) ?? null,
    });
    if (!identity.success) {
      return Response.json({ error: "automation_socket_identity_required" }, { status: 401 });
    }
    const { workspaceId, userId, automationId } = identity.data;
    // A ticket authorizes exactly one upgrade. Without consuming it, a 60
    // second window is replayable and a signed-out session that still holds
    // one keeps opening feeds.
    if (!this.consumeSocketTicket(identity.data)) {
      return Response.json({ error: "socket_ticket_replayed" }, { status: 401 });
    }
    // And the ticket is not the authority on current access: a session that
    // has been revoked, or a member removed from the workspace since the
    // ticket was minted, must be refused here rather than trusted.
    if (!await this.sessionIsActive(identity.data)) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    this.assertAuthor(automationId, workspaceId, userId);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server, [automationId, userId]);
    server.serializeAttachment({
      automationId,
      userId,
      sessionId: identity.data.sessionId,
      eventSequence: this.eventSequence(),
    });
    server.send(JSON.stringify({ type: "snapshot", snapshot: this.snapshotUnchecked() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Close every socket a revoked session or ended membership held.
   *
   * The room admits on a ticket and never re-authorizes, so this queue hop is
   * the only thing that ends a live feed when access goes away.
   */
  async revokeSocketAccess(revocation: unknown): Promise<void> {
    await this.initialized;
    const request = AutomationSocketRevocationSchema.parse(revocation);
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as {
        userId?: unknown;
        sessionId?: unknown;
      } | null;
      if (!attachment || attachment.userId !== request.userId) continue;
      // A revoked session closes only the windows that presented it; an ended
      // membership carries no session and closes all of them.
      if (request.sessionId && attachment.sessionId !== request.sessionId) continue;
      try {
        socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer access this automation");
      } catch {
        // A socket the runtime already tore down needs no close.
      }
    }
  }

  private consumeSocketTicket(identity: {
    ticketId: string;
    ticketExpiresAt: number;
    userId: string;
  }): boolean {
    // Ticket claims carry epoch seconds; object SQL stores unix-ms.
    const now = Date.now();
    const expiresAtMs = identity.ticketExpiresAt * 1_000;
    if (expiresAtMs <= now) return false;
    return this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `DELETE FROM automation_socket_ticket_receipts WHERE expires_at < ?`,
        now - 300_000,
      );
      return this.state.storage.sql.exec<{ ticket_id: string }>(
        `INSERT OR IGNORE INTO automation_socket_ticket_receipts
           (ticket_id, user_id, expires_at, consumed_at)
         VALUES (?, ?, ?, ?) RETURNING ticket_id`,
        identity.ticketId,
        identity.userId,
        expiresAtMs,
        now,
      ).toArray().length === 1;
    });
  }

  /** Current membership, read from D1 rather than inferred from the ticket. */
  private async sessionIsActive(identity: {
    sessionId: string;
    userId: string;
    workspaceId: string;
  }): Promise<boolean> {
    if (this.env.APP_ENV === "development"
      && this.env.RALLY_DEV_AUTH === "true"
      && identity.sessionId === "development") {
      const row = await this.env.DB.prepare(
        `SELECT member.user_id FROM workspace_members member
          JOIN workspaces workspace ON workspace.id = member.workspace_id
         WHERE member.workspace_id = ? AND member.user_id = ?
           AND member.status = 'active' AND workspace.region = ?
           AND workspace.abandoned_at IS NULL`,
      ).bind(identity.workspaceId, identity.userId, this.env.AVALON_REGION).first<{ user_id: string }>();
      return row !== null;
    }
    const row = await this.env.DB.prepare(
      `SELECT member.user_id FROM sessions session
        JOIN workspace_members member
          ON member.workspace_id = session.workspace_id
         AND member.user_id = session.user_id AND member.status = 'active'
        JOIN workspaces workspace ON workspace.id = session.workspace_id
       WHERE session.id = ? AND session.user_id = ? AND session.workspace_id = ?
         AND session.revoked_at IS NULL AND session.expires_at > ?
         AND workspace.region = ? AND workspace.abandoned_at IS NULL`,
    ).bind(
      identity.sessionId,
      identity.userId,
      identity.workspaceId,
      new Date().toISOString(),
      this.env.AVALON_REGION,
    ).first<{ user_id: string }>();
    return row !== null;
  }

  /**
   * The draft, for somebody the owning room vouches for rather than its author.
   *
   * `readSnapshot` asserts authorship, which is the right gate for the surface
   * that reads a draft you are writing. A proposal card is read by the room,
   * and the room's answer to "may this person act" is participation — resolved
   * by the caller, because it lives in the work stream's own object.
   */
  async readAuthoredSnapshot(input: {
    automationId: string;
    workspaceId: string;
    userId: string;
    participantOfAuthoringWorkstream: boolean;
  }): Promise<AutomationAgentSnapshot> {
    await this.initialized;
    const identity = this.identity();
    if (identity.automation_id !== input.automationId || identity.workspace_id !== input.workspaceId) {
      throw new Error("automation_identity_mismatch");
    }
    if (identity.author_user_id !== input.userId && !input.participantOfAuthoringWorkstream) {
      throw new Error("automation_access_denied");
    }
    return this.snapshotUnchecked();
  }

  async setEvaluatorRules(rawMutation: AutomationSetEvaluatorRulesMutation): Promise<{ accepted: true }> {
    await this.initialized;
    const mutation = AutomationSetEvaluatorRulesMutationSchema.parse(rawMutation);
    const rules = AutomationSetEvaluatorRulesInputV1Schema.parse(mutation.evaluatorRules);
    this.assertAuthor(mutation.automationId, mutation.workspaceId, mutation.authorUserId);
    const now = Date.now();
    const result = this.state.storage.transactionSync(() => {
      const receipt = this.state.storage.sql.exec<{ input_hash: string; result_json: string }>(
        `SELECT input_hash, result_json FROM automation_tool_receipts
          WHERE compiler_run_id = ? AND provider_call_id = ?`,
        mutation.compilerRunId,
        mutation.providerCallId,
      ).toArray()[0];
      if (receipt) {
        if (receipt.input_hash !== mutation.inputHash) throw new Error("automation_tool_coordinate_conflict");
        return JSON.parse(receipt.result_json) as { accepted: true };
      }
      const active = this.activeCompilerRun();
      if (!active || active.run_id !== mutation.compilerRunId || active.state !== "running") {
        throw new Error("automation_compiler_run_not_active");
      }
      const result = { accepted: true } as const;
      this.state.storage.sql.exec(
        `INSERT INTO automation_draft_evaluator_sets
           (compiler_run_id, provider_call_id, input_hash, evaluator_rules_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(compiler_run_id) DO UPDATE SET
           provider_call_id = excluded.provider_call_id,
           input_hash = excluded.input_hash,
           evaluator_rules_json = excluded.evaluator_rules_json,
           updated_at = excluded.updated_at`,
        mutation.compilerRunId,
        mutation.providerCallId,
        mutation.inputHash,
        JSON.stringify(rules),
        now,
      );
      this.state.storage.sql.exec(
        `INSERT INTO automation_tool_receipts
           (compiler_run_id, provider_call_id, tool_name, input_hash, result_json, settled_at)
         VALUES (?, ?, 'automation_set_evaluator_rules', ?, ?, ?)`,
        mutation.compilerRunId,
        mutation.providerCallId,
        mutation.inputHash,
        JSON.stringify(result),
        now,
      );
      return result;
    });
    return result;
  }

  /**
   * Admit a draft an agent wrote inside a work stream.
   *
   * The compiler's own path cannot serve this: it stages a submission against
   * an automation that already exists, created by a person opening the draft
   * screen. Here the conversation *is* the authoring loop, so the first
   * submission is what brings the automation into being.
   *
   * `authoredInWorkstreamId` is supplied by the Worker from the loop the
   * submission was made in, never by the model. It is remembered rather than
   * acted on: ownership is a fact about an acceptance, and nobody has accepted
   * anything yet. When somebody does, it is the only place a `workstream`
   * acceptance can honestly get its room.
   *
   * Re-submitting refines the same draft — an agent that asked a clarifying
   * question and submitted again must not create a second automation.
   */
  async admitAuthoredDraft(input: unknown): Promise<{
    automationId: string;
    definitionRevision: number;
    created: boolean;
  }> {
    await this.initialized;
    const request = z.strictObject({
      schemaVersion: z.literal(1),
      automationId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      authorUserId: z.string().uuid(),
      region: z.enum(["global", "eu"]),
      authoredInWorkstreamId: z.string().uuid(),
      /** Supplied by the Worker from the loop, never by the model. */
      authoredOrigin: z.strictObject({
        kind: z.literal("slack"),
        teamId: z.string().min(1).max(255),
        channelId: z.string().min(1).max(255),
        channelName: z.string().min(1).max(255).nullable(),
      }).nullable().default(null),
      /**
       * Staged by the drafting loop and applied here rather than when the model
       * called for them: a draft's rules can be set before the first submission
       * has created anything to attach them to, and buffering removes the
       * ordering question instead of answering it.
       */
      evaluatorRules: AutomationSetEvaluatorRulesInputV1Schema.nullable().default(null),
      draft: AutomationDraftSchema,
    }).parse(input);
    const now = Date.now();
    const existing = this.state.storage.sql.exec<{
      automation_id: string;
      workspace_id: string;
    }>(`SELECT automation_id, workspace_id FROM automation_identity WHERE id = 1`).toArray()[0];
    if (existing
      && (existing.automation_id !== request.automationId
        || existing.workspace_id !== request.workspaceId)) {
      throw new Error("automation_authority_mismatch");
    }
    // Only a draft is refinable. An accepted automation is changed through the
    // definition-update path, which re-validates its bindings; letting a
    // submission overwrite one would edit a running automation from a
    // conversation.
    if (existing && this.lifecycle() !== "draft") throw new Error("automation_not_draft");
    // `prepareAcceptance`'s own condition, applied here instead. An event-driven
    // draft whose rules are absent or empty is one Create can only refuse, and
    // by then the refusal has nowhere to go: the drafting loop has ended, and
    // what is left is a proposal card whose button never works. Refusing the
    // submission puts it back inside that loop, where a rejected tool call is
    // repaired and retried. Only a `ready` draft is held to it — a partial
    // submission paired with a clarifying question has not chosen its rules
    // yet, and acceptance refuses it on `ready` alone anyway.
    //
    // Below the two refusals above rather than ahead of them: all three are
    // pure reads that write nothing, so the "nothing is committed" property
    // holds either way, and a submission that is both rules-less and aimed at
    // the wrong identity should answer with the sharper of the two.
    if (request.draft.ready && evaluatorRulesMissing(request.draft, request.evaluatorRules)) {
      throw new Error("automation_evaluator_rules_required");
    }
    const created = !existing;
    const revision = this.state.storage.transactionSync(() => {
      if (created) {
        this.state.storage.sql.exec(
          `INSERT INTO automation_identity
             (id, automation_id, workspace_id, author_user_id, region,
              authority_generation, created_at, updated_at)
           VALUES (1, ?, ?, ?, ?, 1, ?, ?)`,
          request.automationId,
          request.workspaceId,
          request.authorUserId,
          request.region,
          now,
          now,
        );
        this.state.storage.sql.exec(
          `INSERT INTO automation_state
             (id, lifecycle, title, definition_revision, accepted_definition_revision,
              event_sequence, authored_in_workstream_id, authored_origin_json,
              created_at, updated_at)
           VALUES (1, 'draft', ?, 0, NULL, 0, ?, ?, ?, ?)`,
          request.draft.name,
          request.authoredInWorkstreamId,
          request.authoredOrigin === null ? null : JSON.stringify(request.authoredOrigin),
          now,
          now,
        );
      }
      const next = Number(this.state.storage.sql.exec<{ definition_revision: number }>(
        `SELECT definition_revision FROM automation_state WHERE id = 1`,
      ).one().definition_revision) + 1;
      this.state.storage.sql.exec(
        `INSERT INTO automation_definition_revisions
           (definition_revision, compiler_run_id, definition_json, definition_hash, ready, created_at)
         VALUES (?, NULL, ?, ?, ?, ?)`,
        next,
        JSON.stringify(request.draft),
        `authored:${request.automationId}:${next}`,
        request.draft.ready ? 1 : 0,
        now,
      );
      if (request.evaluatorRules) {
        this.state.storage.sql.exec(
          `INSERT INTO automation_authored_evaluator_sets
             (definition_revision, evaluator_rules_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(definition_revision) DO UPDATE SET
             evaluator_rules_json = excluded.evaluator_rules_json,
             updated_at = excluded.updated_at`,
          next,
          JSON.stringify(request.evaluatorRules),
          now,
        );
      }
      this.state.storage.sql.exec(
        `UPDATE automation_state
            SET definition_revision = ?, title = ?, updated_at = ? WHERE id = 1`,
        next,
        request.draft.name,
        now,
      );
      return next;
    });
    return { automationId: request.automationId, definitionRevision: revision, created };
  }

  /** The room a draft was written in, for an acceptance that needs to name one. */
  authoredInWorkstreamId(): string | null {
    return this.state.storage.sql.exec<{ authored_in_workstream_id: string | null }>(
      `SELECT authored_in_workstream_id FROM automation_state WHERE id = 1`,
    ).toArray()[0]?.authored_in_workstream_id ?? null;
  }

  /** Where the conversation was, for a run that has to speak from somewhere. */
  private authoredOrigin(): AutomationRunContextV1["authoringOrigin"] {
    const raw = this.state.storage.sql.exec<{ authored_origin_json: string | null }>(
      `SELECT authored_origin_json FROM automation_state WHERE id = 1`,
    ).toArray()[0]?.authored_origin_json ?? null;
    return raw === null
      ? null
      : AutomationRunContextV1Schema.shape.authoringOrigin.parse(JSON.parse(raw));
  }

  /** Freeze the current compiled revision and activate this same durable object. */
  async acceptDraft(rawInput: unknown): Promise<AutomationDetail> {
    await this.initialized;
    const input = AutomationAcceptDraftRequestSchema.parse(rawInput);
    // Authorship, or the room's own vouching for a `workstream` acceptance: the
    // proposal card is addressed to the room, and a card only its author can
    // press is a card the room does not actually decide.
    if (input.owningWorkstreamId && input.participantOfOwningWorkstream) {
      const identity = this.identity();
      if (identity.automation_id !== input.automationId || identity.workspace_id !== input.workspaceId) {
        throw new Error("automation_authority_mismatch");
      }
    } else {
      this.assertAuthor(input.automationId, input.workspaceId, input.authorUserId);
    }
    // The role authorizes the request; it is not part of what was requested.
    // Hashing it would make an identical retry by a second admin look like a
    // changed acceptance and refuse with `automation_acceptance_conflict`.
    const hashedInput: Record<string, unknown> = { ...input };
    delete hashedInput.actorRole;
    const requestHash = await sha256(JSON.stringify(hashedInput));
    const existingAcceptance = this.acceptance();
    if (existingAcceptance && existingAcceptance.request_hash !== requestHash) {
      throw new Error("automation_acceptance_conflict");
    }
    const lifecycle = this.lifecycle();
    if (lifecycle === "active" || lifecycle === "paused") return this.detailUnchecked();
    if (lifecycle !== "draft" && lifecycle !== "activating") throw new Error("automation_not_acceptable");

    if (!existingAcceptance) {
      const activeCompiler = this.activeCompilerRun();
      if (activeCompiler) throw new Error("automation_compiler_busy");
      const definition = this.currentDefinition();
      const state = this.state.storage.sql.exec<{ definition_revision: number }>(
        `SELECT definition_revision FROM automation_state WHERE id = 1`,
      ).one();
      if (!definition?.ready || state.definition_revision !== input.definitionRevision) {
        throw new Error("automation_definition_not_ready");
      }
      const pending = this.state.storage.sql.exec<{ elicitation_id: string }>(
        `SELECT elicitation_id FROM automation_pending_elicitations WHERE state = 'pending' LIMIT 1`,
      ).toArray()[0];
      if (pending) throw new Error("automation_pending_elicitation");
      const prepared = await this.prepareAcceptance(input, definition);
      const now = Date.now();
      this.state.storage.transactionSync(() => {
        this.state.storage.sql.exec(
          `INSERT INTO automation_acceptance
             (id, definition_revision, request_hash, scope, owning_workstream_id,
              default_plugin_ids_json,
              activity_source_plugin_ids_json, connector_bindings_json,
              delivery_targets_json, model_override, evaluator_projection_json,
              evaluator_source_hash, accepted_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          input.definitionRevision,
          requestHash,
          input.scope,
          input.owningWorkstreamId,
          JSON.stringify(input.defaultPluginIds),
          JSON.stringify(input.activitySourcePluginIds),
          JSON.stringify(prepared.connectorBindings),
          JSON.stringify(prepared.deliveryTargets),
          input.modelOverride,
          JSON.stringify(prepared.evaluators),
          prepared.evaluatorSourceHash,
          now,
        );
        for (const schedule of prepared.schedules) {
          this.state.storage.sql.exec(
            `INSERT INTO automation_schedules
               (schedule_id, schedule_kind, definition_json, next_due_at, paused, updated_at)
             VALUES (?, ?, ?, ?, 1, ?)`,
            schedule.id,
            schedule.kind,
            JSON.stringify(schedule.definition),
            schedule.nextDueAt,
            now,
          );
        }
        this.state.storage.sql.exec(
          `UPDATE automation_state
              SET lifecycle = 'activating', accepted_definition_revision = ?, updated_at = ?
            WHERE id = 1`,
          input.definitionRevision,
          now,
        );
        materializeAutomationMemoryDefinitions(
          this.state.storage,
          input.automationId,
          this.currentDefinition()!.memoryTables,
          now,
        );
        this.appendRealtimeEvent("activation_started", { definitionRevision: input.definitionRevision }, now);
      });
      this.broadcastLatestEvents();
    }

    const acceptance = this.acceptance()!;
    const identity = this.identity();
    const activationGeneration = identity.authority_generation;
    const workspace = await this.workspace();
    const registration = await workspace.applyExternalEventRegistrations({
      schemaVersion: 1,
      workspaceId: identity.workspace_id,
      destination: { kind: "automation", automationId: identity.automation_id },
      authorityGeneration: identity.authority_generation,
      projectionVersion: acceptance.definition_revision,
      sourceHash: acceptance.evaluator_source_hash,
      evaluators: JSON.parse(acceptance.evaluator_projection_json),
    });
    const schedules = this.state.storage.sql.exec<{ schedule_id: string; next_due_at: number | null }>(
      `SELECT schedule_id, next_due_at FROM automation_schedules ORDER BY schedule_id`,
    ).toArray();
    for (const schedule of schedules) {
      if (schedule.next_due_at !== null) {
        await this.scheduleAlarm({
          kind: AUTOMATION_SCHEDULE_ALARM_KIND,
          key: schedule.schedule_id,
          dueAt: schedule.next_due_at,
        });
      }
    }
    const emailRoute = await new WorkstreamEmailRoutingService(this.env).reserveAutomation({
      region: identity.region,
      workspaceId: identity.workspace_id,
      automationSubscriptionId: identity.automation_id,
    });
    const now = Date.now();
    if (this.lifecycle() !== "activating" || this.identity().authority_generation !== activationGeneration) {
      await Promise.all(schedules.map((schedule) => (
        this.cancelScheduledAlarm(AUTOMATION_SCHEDULE_ALARM_KIND, schedule.schedule_id)
      )));
      throw new Error("automation_activation_fenced");
    }
    this.state.storage.transactionSync(() => {
      const current = this.acceptance();
      if (!current || current.request_hash !== requestHash) throw new Error("automation_acceptance_lost");
      this.state.storage.sql.exec(
        `UPDATE automation_acceptance
            SET effective_after_event_sequence = ?, activated_at = ? WHERE id = 1`,
        registration.effectiveAfterEventSequence,
        now,
      );
      this.state.storage.sql.exec(
        `UPDATE automation_schedules SET paused = 0, updated_at = ?`, now,
      );
      this.state.storage.sql.exec(
        `INSERT INTO automation_email_route (id, email_address, claimed_at)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET email_address = excluded.email_address`,
        emailRoute.emailAddress,
        now,
      );
      this.promoteHeldExternalEvents(
        this.identity().authority_generation,
        registration.effectiveAfterEventSequence,
        now,
      );
      this.deleteDraftConversation(input.definitionRevision);
      this.state.storage.sql.exec(`DELETE FROM automation_realtime_events`);
      this.state.storage.sql.exec(
        `UPDATE automation_state
            SET lifecycle = 'active', event_sequence = 0, attention_code = NULL,
                attention_message = NULL, updated_at = ? WHERE id = 1`,
        now,
      );
      this.appendRealtimeEvent("activation_completed", {
        definitionRevision: input.definitionRevision,
        effectiveAfterEventSequence: registration.effectiveAfterEventSequence,
      }, now);
      const definition = this.currentDefinition()!;
      this.enqueueWorkspaceProjection({
        lifecycle: "active",
        scope: input.scope,
        owningWorkstreamId: input.owningWorkstreamId,
        definition,
        payloadHash: acceptance.evaluator_source_hash,
        now,
      });
    });
    await this.armNextAlarm();
    this.broadcastSnapshot();
    return this.detailUnchecked();
  }

  async readDetail(input: { automationId: string; workspaceId: string; userId: string }): Promise<AutomationDetail> {
    await this.initialized;
    await this.assertViewer(input.automationId, input.workspaceId, input.userId);
    return this.detailUnchecked();
  }

  /** Shared-template publication copies the frozen definition; it does not link authorities. */
  async exportAcceptedDraft(input: {
    automationId: string;
    workspaceId: string;
    userId: string;
  }): Promise<{ draftJson: string }> {
    await this.initialized;
    this.assertAuthor(input.automationId, input.workspaceId, input.userId);
    if (!this.acceptance() || this.lifecycle() === "draft" || this.lifecycle() === "deleted") {
      throw new Error("automation_template_source_unavailable");
    }
    const definition = this.currentDefinition();
    if (!definition) throw new Error("automation_definition_missing");
    return { draftJson: JSON.stringify(AutomationDraftSchema.parse(definition)) };
  }

  /** Idempotently install one audited accepted legacy automation under the same ID. */
  async importAcceptedAutomation(rawInput: unknown): Promise<{
    sourceHash: string;
    lifecycle: "active" | "paused";
    authorityGeneration: number;
  }> {
    await this.initialized;
    const input = AutomationLegacyImportRequestSchema.parse(rawInput);
    const computedHash = await sha256(canonicalTranscriptJson(input.source));
    if (computedHash !== input.sourceHash) throw new Error("automation_import_source_hash_mismatch");
    const receipt = this.state.storage.sql.exec<{ source_hash: string }>(
      `SELECT source_hash FROM automation_import_receipt WHERE id = 1`,
    ).toArray()[0];
    if (receipt) {
      if (receipt.source_hash !== input.sourceHash) throw new Error("automation_import_receipt_conflict");
      return {
        sourceHash: receipt.source_hash,
        lifecycle: this.lifecycle() === "active" ? "active" : "paused",
        authorityGeneration: this.identity().authority_generation,
      };
    }
    if (this.state.storage.sql.exec(`SELECT automation_id FROM automation_identity`).toArray().length > 0) {
      throw new Error("automation_import_destination_not_empty");
    }

    const source = input.source;
    const importedEmailRoute = source.emailAddress
      ? await new WorkstreamEmailRoutingService(this.env).claimAutomation({
          region: input.region,
          workspaceId: input.workspaceId,
          automationSubscriptionId: input.automationId,
          emailAddress: source.emailAddress,
        })
      : null;
    const definitionHash = await sha256(JSON.stringify(source.definition));
    const lifecycle = source.status === "active" && !source.unsupportedTrigger ? "active" : "paused";
    const attentionCode = source.unsupportedTrigger
      ? "unsupported_trigger"
      : source.status === "error" ? "legacy_runtime_error" : null;
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `INSERT INTO automation_identity
           (id, automation_id, workspace_id, author_user_id, region,
            authority_generation, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, 1, ?, ?)`,
        input.automationId,
        input.workspaceId,
        input.authorUserId,
        input.region,
        source.createdAt,
        source.updatedAt,
      );
      this.state.storage.sql.exec(
        `INSERT INTO automation_state
           (id, lifecycle, title, definition_revision, accepted_definition_revision,
            event_sequence, attention_code, attention_message, created_at, updated_at)
         VALUES (1, ?, ?, 1, 1, 0, ?, ?, ?, ?)`,
        lifecycle,
        source.definition.name,
        attentionCode,
        attentionCode === "unsupported_trigger"
          ? "This automation uses a trigger that cannot be represented safely."
          : attentionCode === "legacy_runtime_error" ? "This automation was paused after a prior error." : null,
        source.createdAt,
        source.updatedAt,
      );
      this.state.storage.sql.exec(
        `INSERT INTO automation_definition_revisions
           (definition_revision, compiler_run_id, definition_json, definition_hash,
            ready, created_at)
         VALUES (1, NULL, ?, ?, 1, ?)`,
        JSON.stringify(source.definition),
        definitionHash,
        source.createdAt,
      );
      this.state.storage.sql.exec(
        `INSERT INTO automation_acceptance
           (id, definition_revision, request_hash, scope, default_plugin_ids_json,
            activity_source_plugin_ids_json, connector_bindings_json,
            delivery_targets_json, model_override, evaluator_projection_json,
            evaluator_source_hash, effective_after_event_sequence, accepted_at, activated_at)
         VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?, '[]', ?, 0, ?, ?)`,
        input.sourceHash,
        source.scope,
        JSON.stringify(source.defaultPluginIds),
        JSON.stringify(source.activitySourcePluginIds),
        JSON.stringify(source.connectorBindings),
        JSON.stringify(source.deliveryTargets),
        source.modelOverride,
        input.sourceHash,
        source.createdAt,
        lifecycle === "active" ? source.updatedAt : null,
      );
      for (const schedule of source.schedules) {
        this.state.storage.sql.exec(
          `INSERT INTO automation_schedules
             (schedule_id, schedule_kind, definition_json, next_due_at, paused, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          schedule.scheduleId,
          schedule.kind,
          JSON.stringify(schedule.definition),
          schedule.nextDueAt,
          lifecycle === "active" ? 0 : 1,
          source.updatedAt,
        );
      }
      for (const run of source.runs) {
        const trigger: AutomationRunContextV1["trigger"] = run.plannedFor !== null && source.schedules[0]
          ? {
              kind: "schedule",
              scheduleId: source.schedules[0].scheduleId,
              scheduleKind: source.schedules[0].kind,
              plannedFor: run.plannedFor,
            }
          : { kind: "manual", requestedByUserId: asUserId(input.authorUserId) };
        const executionState = run.status === "scheduled" ? "pending" : run.status;
        this.state.storage.sql.exec(
          `INSERT INTO automation_runs
             (run_id, occurrence_key, trigger_type, planned_for, workstream_id,
              harness_run_id, workflow_instance_id, admission_state, execution_state,
              delivery_state, context_json, source_version, source_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, 'provisioned', ?, 'not_requested', ?, 0, NULL, ?, ?)`,
          run.runId,
          `legacy:${run.runId}`,
          run.triggerType,
          run.plannedFor,
          run.workstreamId,
          run.workflowInstanceId,
          executionState,
          JSON.stringify(this.runContext(run.runId, trigger)),
          run.createdAt,
          run.updatedAt,
        );
      }
      for (const record of source.memoryRecords) {
        this.state.storage.sql.exec(
          `INSERT INTO automation_imported_memory_records
             (record_kind, record_id, payload_json) VALUES (?, ?, ?)`,
          record.kind,
          record.recordId,
          canonicalTranscriptJson(record.payload),
        );
      }
      importLegacyAutomationMemory(
        this.state.storage,
        input.automationId,
        source.definition.memoryTables,
        source.memoryRecords,
        source.updatedAt,
      );
      for (const receipt of source.inboundEmailReceipts ?? []) {
        // `run_id` is deliberately not carried across. The legacy run ID
        // referenced `automation_runs` rows in WorkspaceDO, and this object's
        // own `automation_runs` foreign key would refuse an ID it never
        // imported. What this row exists to answer is whether the Resend
        // message has been seen, and that is `resend_email_id` alone.
        this.state.storage.sql.exec(
          `INSERT INTO automation_inbound_email_receipts
             (resend_email_id, receipt_id, svix_id, sender_user_id, payload_ref,
              resource_id, run_id, workstream_id, state, outcome_code, received_at, created_at)
           VALUES (?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?)
           ON CONFLICT(resend_email_id) DO NOTHING`,
          receipt.resendEmailId,
          `imported:${receipt.resendEmailId}`,
          receipt.svixId,
          receipt.payloadRef,
          receipt.workstreamId,
          receipt.refused ? "refused" : "admitted",
          receipt.refused ? "email_refused_before_cutover" : "email_admitted_before_cutover",
          receipt.receivedAt,
          source.updatedAt,
        );
      }
      for (const window of source.inboundEmailRateWindows ?? []) {
        this.state.storage.sql.exec(
          `INSERT INTO automation_inbound_email_rate_windows (window_started_at, accepted_count)
           VALUES (?, ?)
           ON CONFLICT(window_started_at) DO UPDATE SET accepted_count = excluded.accepted_count`,
          window.windowStartedAt,
          window.acceptedCount,
        );
      }
      if (importedEmailRoute) {
        this.state.storage.sql.exec(
          `INSERT INTO automation_email_route (id, email_address, claimed_at) VALUES (1, ?, ?)`,
          importedEmailRoute.emailAddress,
          source.updatedAt,
        );
      }
      this.state.storage.sql.exec(
        `INSERT INTO automation_import_receipt (id, source_hash, imported_at) VALUES (1, ?, ?)`,
        input.sourceHash,
        Date.now(),
      );
    });
    if (lifecycle === "active") {
      for (const schedule of source.schedules) {
        if (schedule.nextDueAt !== null) {
          await this.scheduleAlarm({
            kind: AUTOMATION_SCHEDULE_ALARM_KIND,
            key: schedule.scheduleId,
            dueAt: schedule.nextDueAt,
          });
        }
      }
      await this.armNextAlarm();
    }
    return { sourceHash: input.sourceHash, lifecycle, authorityGeneration: 1 };
  }

  async pause(input: {
    automationId: string;
    workspaceId: string;
    userId: string;
    actorRole?: string;
    /** Resolved by the caller: participation lives in the work stream's object. */
    participantOfOwningWorkstream?: boolean;
  }): Promise<void> {
    await this.initialized;
    this.assertManager(
      input.automationId,
      input.workspaceId,
      input.userId,
      input.actorRole,
      input.participantOfOwningWorkstream ?? false,
    );
    await this.pauseWithReason("person");
  }

  /**
   * Pause because the work stream that owns this automation was archived.
   *
   * No manager check: nobody is acting on the automation. Archiving a room is a
   * decision about the room, and its automations follow it — which is the whole
   * point of the room owning them rather than a person who may be gone.
   */
  async pauseForArchivedWorkstream(input: unknown): Promise<{ paused: boolean; outcomeCode: string }> {
    await this.initialized;
    const request = z.strictObject({
      schemaVersion: z.literal(1),
      automationId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      workstreamId: z.string().uuid(),
    }).parse(input);
    const identity = this.identity();
    if (identity.automation_id !== request.automationId
      || identity.workspace_id !== request.workspaceId) {
      throw new Error("automation_identity_mismatch");
    }
    const acceptance = this.acceptance();
    // Only for the room that owns it. A room cannot pause an automation that
    // merely delivers to it.
    if (!acceptance || acceptance.owning_workstream_id !== request.workstreamId) {
      return { paused: false, outcomeCode: "automation_not_owned_by_workstream" };
    }
    if (this.lifecycle() === "paused") return { paused: false, outcomeCode: "automation_already_paused" };
    if (this.lifecycle() !== "active" && this.lifecycle() !== "activating") {
      return { paused: false, outcomeCode: "automation_not_pausable" };
    }
    await this.pauseWithReason("workstream_archived");
    return { paused: true, outcomeCode: "automation_paused" };
  }

  /**
   * Resume exactly what an archive paused.
   *
   * `paused_reason` is why this column exists: unarchiving a room must not
   * restart an automation somebody paused by hand before the archive, and
   * without the reason recorded the two are the same row.
   */
  async resumeForUnarchivedWorkstream(input: unknown): Promise<{ resumed: boolean; outcomeCode: string }> {
    await this.initialized;
    const request = z.strictObject({
      schemaVersion: z.literal(1),
      automationId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      workstreamId: z.string().uuid(),
    }).parse(input);
    const identity = this.identity();
    if (identity.automation_id !== request.automationId
      || identity.workspace_id !== request.workspaceId) {
      throw new Error("automation_identity_mismatch");
    }
    const acceptance = this.acceptance();
    if (!acceptance || acceptance.owning_workstream_id !== request.workstreamId) {
      return { resumed: false, outcomeCode: "automation_not_owned_by_workstream" };
    }
    const reason = this.state.storage.sql.exec<{ paused_reason: string | null }>(
      `SELECT paused_reason FROM automation_state WHERE id = 1`,
    ).toArray()[0]?.paused_reason ?? null;
    if (this.lifecycle() !== "paused" || reason !== "workstream_archived") {
      return { resumed: false, outcomeCode: "automation_not_paused_by_archive" };
    }
    await this.resumeFromPause();
    return { resumed: true, outcomeCode: "automation_resumed" };
  }

  private async pauseWithReason(reason: "person" | "workstream_archived"): Promise<void> {
    if (this.lifecycle() === "paused") return;
    if (this.lifecycle() !== "active" && this.lifecycle() !== "activating") {
      throw new Error("automation_not_pausable");
    }
    const acceptance = this.acceptance();
    if (!acceptance) throw new Error("automation_acceptance_missing");
    const schedules = this.state.storage.sql.exec<{ schedule_id: string }>(
      `SELECT schedule_id FROM automation_schedules`,
    ).toArray();
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `UPDATE automation_identity
            SET authority_generation = authority_generation + 1, updated_at = ? WHERE id = 1`,
        now,
      );
      this.state.storage.sql.exec(`UPDATE automation_schedules SET paused = 1, updated_at = ?`, now);
      this.state.storage.sql.exec(
        `UPDATE automation_trigger_receipts
            SET state = 'refused', outcome_code = 'automation_paused', updated_at = ?
          WHERE state = 'held_for_activation'`,
        now,
      );
      this.state.storage.sql.exec(
        `UPDATE automation_state SET lifecycle = 'paused', paused_reason = ?, updated_at = ?
          WHERE id = 1`,
        reason,
        now,
      );
      this.appendRealtimeEvent("automation_paused", {}, now);
      this.enqueueWorkspaceProjection({
        lifecycle: "paused",
        scope: acceptance.scope,
        owningWorkstreamId: acceptance.owning_workstream_id,
        definition: this.currentDefinition()!,
        payloadHash: acceptance.evaluator_source_hash,
        now,
      });
    });
    await Promise.all(schedules.map((schedule) => (
      this.cancelScheduledAlarm(AUTOMATION_SCHEDULE_ALARM_KIND, schedule.schedule_id)
    )));
    const identity = this.identity();
    await (await this.workspace()).applyExternalEventRegistrations({
      schemaVersion: 1,
      workspaceId: identity.workspace_id,
      destination: { kind: "automation", automationId: identity.automation_id },
      authorityGeneration: identity.authority_generation,
      projectionVersion: acceptance.definition_revision,
      sourceHash: acceptance.evaluator_source_hash,
      evaluators: [],
    });
    await this.armNextAlarm();
    this.broadcastLatestEvents();
  }

  async resume(input: {
    automationId: string;
    workspaceId: string;
    userId: string;
    actorRole?: string;
    /** Resolved by the caller: participation lives in the work stream's object. */
    participantOfOwningWorkstream?: boolean;
  }): Promise<void> {
    await this.initialized;
    this.assertManager(
      input.automationId,
      input.workspaceId,
      input.userId,
      input.actorRole,
      input.participantOfOwningWorkstream ?? false,
    );
    await this.resumeFromPause();
  }

  private async resumeFromPause(): Promise<void> {
    if (this.lifecycle() === "active") return;
    if (this.lifecycle() !== "paused") throw new Error("automation_not_resumable");
    const acceptance = this.acceptance();
    if (!acceptance) throw new Error("automation_acceptance_missing");
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `UPDATE automation_identity
            SET authority_generation = authority_generation + 1, updated_at = ? WHERE id = 1`,
        now,
      );
      this.state.storage.sql.exec(
        `UPDATE automation_state SET lifecycle = 'activating', updated_at = ? WHERE id = 1`, now,
      );
      this.appendRealtimeEvent("activation_started", { resume: true }, now);
    });
    const identity = this.identity();
    const registration = await (await this.workspace()).applyExternalEventRegistrations({
      schemaVersion: 1,
      workspaceId: identity.workspace_id,
      destination: { kind: "automation", automationId: identity.automation_id },
      authorityGeneration: identity.authority_generation,
      projectionVersion: acceptance.definition_revision,
      sourceHash: acceptance.evaluator_source_hash,
      evaluators: JSON.parse(acceptance.evaluator_projection_json),
    });
    const schedules = this.state.storage.sql.exec<{
      schedule_id: string;
      schedule_kind: "calendar" | "interval";
      definition_json: string;
    }>(`SELECT schedule_id, schedule_kind, definition_json FROM automation_schedules`).toArray();
    for (const schedule of schedules) {
      const nextDueAt = this.scheduleDueAfter(schedule.schedule_kind, schedule.definition_json, now);
      this.state.storage.sql.exec(
        `UPDATE automation_schedules
            SET next_due_at = ?, paused = 0, updated_at = ? WHERE schedule_id = ?`,
        nextDueAt,
        now,
        schedule.schedule_id,
      );
      if (nextDueAt !== null) {
        await this.scheduleAlarm({
          kind: AUTOMATION_SCHEDULE_ALARM_KIND,
          key: schedule.schedule_id,
          dueAt: nextDueAt,
        });
      }
    }
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `UPDATE automation_acceptance
            SET effective_after_event_sequence = ?, activated_at = ? WHERE id = 1`,
        registration.effectiveAfterEventSequence,
        now,
      );
      this.promoteHeldExternalEvents(
        identity.authority_generation,
        registration.effectiveAfterEventSequence,
        now,
      );
      this.state.storage.sql.exec(
        `UPDATE automation_state SET lifecycle = 'active', paused_reason = NULL, updated_at = ?
          WHERE id = 1`,
        now,
      );
      this.appendRealtimeEvent("activation_completed", { resume: true }, now);
      this.enqueueWorkspaceProjection({
        lifecycle: "active",
        scope: acceptance.scope,
        owningWorkstreamId: acceptance.owning_workstream_id,
        definition: this.currentDefinition()!,
        payloadHash: acceptance.evaluator_source_hash,
        now,
      });
    });
    await this.armNextAlarm();
    this.broadcastLatestEvents();
  }

  async updateDeliveryTargets(input: {
    automationId: string;
    workspaceId: string;
    userId: string;
    actorRole?: string;
    participantOfOwningWorkstream?: boolean;
    deliveryTargets: unknown;
  }): Promise<AutomationDetail> {
    await this.initialized;
    this.assertManager(
      input.automationId, input.workspaceId, input.userId, input.actorRole,
      input.participantOfOwningWorkstream ?? false,
    );
    if (!["active", "paused"].includes(this.lifecycle())) throw new Error("automation_not_configurable");
    const acceptance = this.acceptance();
    if (!acceptance) throw new Error("automation_acceptance_missing");
    const requested = AutomationDeliveryTargetSetSchema.parse(input.deliveryTargets);
    const deliveryTargets = await this.resolveDeliveryTargets({
      workspaceId: input.workspaceId,
      authorUserId: input.userId,
      scope: acceptance.scope,
      deliveryTargets: requested,
    });
    this.state.storage.sql.exec(
      `UPDATE automation_acceptance SET delivery_targets_json = ? WHERE id = 1`,
      JSON.stringify(deliveryTargets),
    );
    return this.detailUnchecked();
  }

  async deleteAutomation(input: {
    automationId: string;
    workspaceId: string;
    userId: string;
    actorRole?: string;
    participantOfOwningWorkstream?: boolean;
  }): Promise<void> {
    await this.initialized;
    this.assertManager(
      input.automationId, input.workspaceId, input.userId, input.actorRole,
      input.participantOfOwningWorkstream ?? false,
    );
    if (this.lifecycle() === "deleted") return;
    const acceptance = this.acceptance();
    if (!acceptance) {
      if (this.lifecycle() !== "draft") throw new Error("automation_acceptance_missing");
      const activeCompilerRuns = this.state.storage.sql.exec<{ run_id: string }>(
        `SELECT run_id FROM automation_compiler_runs WHERE state IN ('admitted', 'running')`,
      ).toArray();
      const now = Date.now();
      this.state.storage.transactionSync(() => {
        this.state.storage.sql.exec(
          `UPDATE automation_compiler_runs
              SET state = 'cancelled', error_code = 'automation_deleted',
                  error_message = 'Automation deleted', settled_at = ?, updated_at = ?
            WHERE state IN ('admitted', 'running')`,
          now,
          now,
        );
        this.state.storage.sql.exec(
          `UPDATE automation_identity
              SET authority_generation = authority_generation + 1, updated_at = ? WHERE id = 1`,
          now,
        );
        this.state.storage.sql.exec(
          `UPDATE automation_state SET lifecycle = 'deleted', updated_at = ? WHERE id = 1`, now,
        );
        this.appendRealtimeEvent("automation_deleted", {}, now);
        this.enqueueWorkspaceProjection({
          lifecycle: "deleted",
          scope: "personal",
          definition: this.currentDefinition(),
          payloadHash: `deleted-draft:${input.automationId}:${this.identity().authority_generation}`,
          now,
        });
      });
      await Promise.all(activeCompilerRuns.map((run) => (
        this.cancelScheduledAlarm(COMPILER_DISPATCH_ALARM_KIND, run.run_id)
      )));
      await this.armNextAlarm();
      this.broadcastLatestEvents();
      return;
    }
    if (this.lifecycle() === "active" || this.lifecycle() === "activating") await this.pause(input);
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `UPDATE automation_identity
            SET authority_generation = authority_generation + 1, updated_at = ? WHERE id = 1`,
        now,
      );
      this.state.storage.sql.exec(
        `UPDATE automation_state SET lifecycle = 'deleted', updated_at = ? WHERE id = 1`, now,
      );
      this.appendRealtimeEvent("automation_deleted", {}, now);
      this.enqueueWorkspaceProjection({
        lifecycle: "deleted",
        scope: acceptance.scope,
        owningWorkstreamId: acceptance.owning_workstream_id,
        definition: this.currentDefinition()!,
        payloadHash: acceptance.evaluator_source_hash,
        now,
      });
      const children = this.state.storage.sql.exec<{ workstream_id: string }>(
        `SELECT workstream_id FROM automation_runs WHERE workstream_id IS NOT NULL ORDER BY workstream_id`,
      ).toArray();
      for (const child of children) {
        const operationId = uuidV7(now);
        const update = { kind: "archive" as const };
        this.state.storage.sql.exec(
          `INSERT INTO automation_outbox
             (effect_id, effect_kind, payload_json, state, attempt, not_before,
              created_at, updated_at)
           VALUES (?, 'archive_child_workstream', ?, 'pending', 0, ?, ?, ?)`,
          `archive-child:${child.workstream_id}`,
          JSON.stringify({
            kind: "workstream_batch_update",
            region: this.identity().region,
            operationId,
            requestHash: workstreamImportHash({
              workspaceId: input.workspaceId,
              userId: input.userId,
              workstreamId: child.workstream_id,
              update,
            }),
            workspaceId: input.workspaceId,
            workstreamId: child.workstream_id,
            userId: input.userId,
            update,
          }),
          now,
          now,
          now,
        );
      }
    });
    const identity = this.identity();
    await (await this.workspace()).applyExternalEventRegistrations({
      schemaVersion: 1,
      workspaceId: identity.workspace_id,
      destination: { kind: "automation", automationId: identity.automation_id },
      authorityGeneration: identity.authority_generation,
      projectionVersion: acceptance.definition_revision,
      sourceHash: acceptance.evaluator_source_hash,
      evaluators: [],
    });
    await this.armNextAlarm();
    this.broadcastLatestEvents();
  }

  async runNow(input: {
    automationId: string;
    workspaceId: string;
    userId: string;
    actorRole?: string;
    participantOfOwningWorkstream?: boolean;
    idempotencyKey: string;
  }): Promise<{ runId: string; workstreamId: string; harnessRunId: string; reused: boolean }> {
    await this.initialized;
    this.assertManager(
      input.automationId, input.workspaceId, input.userId, input.actorRole,
      input.participantOfOwningWorkstream ?? false,
    );
    if (this.lifecycle() !== "active") throw new Error("automation_not_active");
    const occurrenceKey = `manual:${input.idempotencyKey}`;
    const existing = this.state.storage.sql.exec<{
      run_id: string;
      workstream_id: string;
      harness_run_id: string;
    }>(`SELECT run_id, workstream_id, harness_run_id FROM automation_runs
          WHERE occurrence_key = ?`, occurrenceKey).toArray()[0];
    if (existing) return {
      runId: existing.run_id,
      workstreamId: existing.workstream_id,
      harnessRunId: existing.harness_run_id,
      reused: true,
    };
    const now = Date.now();
    const runId = uuidV7(now);
    const workstreamId = uuidV7(now + 1);
    const harnessRunId = uuidV7(now + 2);
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `INSERT INTO automation_runs
           (run_id, occurrence_key, trigger_type, planned_for, workstream_id,
            harness_run_id, admission_state, execution_state, delivery_state,
            context_json, source_version, source_hash, created_at, updated_at)
         VALUES (?, ?, 'manual', NULL, ?, ?, 'claimed', 'pending', 'pending',
                 ?, 1, NULL, ?, ?)`,
        runId,
        occurrenceKey,
        workstreamId,
        harnessRunId,
        JSON.stringify(this.runContext(runId, {
          kind: "manual",
          requestedByUserId: asUserId(input.userId),
        })),
        now,
        now,
      );
      this.appendRealtimeEvent("run_admitted", { runId, triggerType: "manual" }, now);
    });
    await this.armNextAlarm();
    this.broadcastLatestEvents();
    return { runId, workstreamId, harnessRunId, reused: false };
  }

  /**
   * Whether an inbound message is worth fetching and storing, before it is.
   *
   * Admission is still the authority — it re-runs every one of these checks
   * inside the transaction that consumes the hourly budget and writes the
   * receipt. This exists so a message that admission would refuse never
   * reaches R2 or the workspace resource table: the address is a routing
   * identifier exposed to every member, not a secret, so anyone holding one
   * could otherwise make us store unbounded attacker-titled objects. Called
   * once without a sender (replay, lifecycle, and address are decidable from
   * the webhook alone) and again once the message has been fetched and its
   * sender resolved.
   */
  async screenInboundEmail(rawInput: unknown): Promise<{
    admissible: boolean;
    duplicate: boolean;
    outcomeCode: string;
    runId: string | null;
    workstreamId: string | null;
  }> {
    await this.initialized;
    const input = AutomationInboundEmailScreenSchema.parse(rawInput);
    const identity = this.identity();
    if (identity.automation_id !== input.automationId || identity.workspace_id !== input.workspaceId) {
      throw new Error("automation_inbound_email_destination_mismatch");
    }
    const existing = this.state.storage.sql.exec<{
      state: "admitted" | "refused";
      outcome_code: string;
      run_id: string | null;
      workstream_id: string | null;
    }>(`SELECT state, outcome_code, run_id, workstream_id
          FROM automation_inbound_email_receipts WHERE resend_email_id = ?`,
    input.resendEmailId).toArray()[0];
    if (existing) return {
      admissible: false,
      duplicate: true,
      outcomeCode: existing.outcome_code,
      runId: existing.run_id,
      workstreamId: existing.workstream_id,
    };
    const route = this.state.storage.sql.exec<{ email_address: string }>(
      `SELECT email_address FROM automation_email_route WHERE id = 1`,
    ).toArray()[0];
    const acceptance = this.acceptance();
    const refusal = this.lifecycle() !== "active" || !acceptance
      ? "automation_not_active"
      : !route || route.email_address.toLowerCase() !== input.emailAddress.toLowerCase()
        ? "automation_email_route_mismatch"
        : input.senderUserId !== undefined && (input.senderUserId === null
          || (acceptance.scope === "personal" && input.senderUserId !== identity.author_user_id))
          ? "email_sender_not_authorized"
          : null;
    return {
      admissible: refusal === null,
      duplicate: false,
      outcomeCode: refusal ?? "admissible",
      runId: null,
      workstreamId: null,
    };
  }

  async admitInboundEmail(rawInput: unknown): Promise<{
    admitted: boolean;
    duplicate: boolean;
    outcomeCode: string;
    runId: string | null;
    workstreamId: string | null;
  }> {
    await this.initialized;
    const input = AutomationInboundEmailAdmissionSchema.parse(rawInput);
    const identity = this.identity();
    if (identity.automation_id !== input.automationId || identity.workspace_id !== input.workspaceId) {
      throw new Error("automation_inbound_email_destination_mismatch");
    }
    const payloadHash = await sha256(JSON.stringify({
      payloadRef: input.payloadRef,
      resourceId: input.resourceId,
      structuredContent: input.structuredContent,
    }));
    const now = Date.now();
    const result = this.state.storage.transactionSync(() => {
      const existing = this.state.storage.sql.exec<{
        state: "admitted" | "refused";
        outcome_code: string;
        run_id: string | null;
        workstream_id: string | null;
      }>(`SELECT state, outcome_code, run_id, workstream_id
            FROM automation_inbound_email_receipts WHERE resend_email_id = ?`,
      input.resendEmailId).toArray()[0];
      if (existing) return {
        admitted: existing.state === "admitted",
        duplicate: true,
        outcomeCode: existing.outcome_code,
        runId: existing.run_id,
        workstreamId: existing.workstream_id,
      };

      const route = this.state.storage.sql.exec<{ email_address: string }>(
        `SELECT email_address FROM automation_email_route WHERE id = 1`,
      ).toArray()[0];
      const acceptance = this.acceptance();
      let refusal: string | null = null;
      if (this.lifecycle() !== "active" || !acceptance) refusal = "automation_not_active";
      else if (!route || route.email_address.toLowerCase() !== input.emailAddress.toLowerCase()) {
        refusal = "automation_email_route_mismatch";
      } else if (input.senderUserId === null
        || (acceptance.scope === "personal" && input.senderUserId !== identity.author_user_id)) {
        refusal = "email_sender_not_authorized";
      }

      const receiptId = uuidV7(now);
      if (refusal) {
        this.state.storage.sql.exec(
          `INSERT INTO automation_inbound_email_receipts
             (resend_email_id, receipt_id, svix_id, sender_user_id, payload_ref,
              resource_id, run_id, workstream_id, state, outcome_code, received_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'refused', ?, ?, ?)`,
          input.resendEmailId,
          receiptId,
          input.svixId,
          input.senderUserId,
          input.payloadRef,
          input.resourceId,
          refusal,
          input.receivedAt,
          now,
        );
        return { admitted: false, duplicate: false, outcomeCode: refusal, runId: null, workstreamId: null };
      }

      // The env var and its default are the team's number; a second ceiling
      // invented here bounds a resource that is already bounded.
      const limit = numericEnv(
        this.env,
        "AUTOMATION_EMAIL_MAX_RUNS_PER_HOUR",
        DEFAULT_AUTOMATION_EMAIL_MAX_RUNS_PER_HOUR,
      );
      const windowStartedAt = Math.floor(now / 3_600_000) * 3_600_000;
      const budget = this.state.storage.sql.exec<{ accepted_count: number }>(
        `INSERT INTO automation_inbound_email_rate_windows (window_started_at, accepted_count)
         VALUES (?, 1)
         ON CONFLICT(window_started_at) DO UPDATE SET accepted_count = accepted_count + 1
         WHERE automation_inbound_email_rate_windows.accepted_count < ?
         RETURNING accepted_count`,
        windowStartedAt,
        limit,
      ).toArray()[0];
      if (!budget) {
        this.state.storage.sql.exec(
          `INSERT INTO automation_inbound_email_receipts
             (resend_email_id, receipt_id, svix_id, sender_user_id, payload_ref,
              resource_id, run_id, workstream_id, state, outcome_code, received_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 'refused', 'email_rate_limit_exceeded', ?, ?)`,
          input.resendEmailId,
          receiptId,
          input.svixId,
          input.senderUserId,
          input.payloadRef,
          input.resourceId,
          input.receivedAt,
          now,
        );
        return {
          admitted: false,
          duplicate: false,
          outcomeCode: "email_rate_limit_exceeded",
          runId: null,
          workstreamId: null,
        };
      }

      const runId = uuidV7(now + 1);
      const workstreamId = uuidV7(now + 2);
      const harnessRunId = uuidV7(now + 3);
      const context = AutomationRunContextV1Schema.parse({
        ...this.runContext(runId, {
          kind: "inbound_email",
          receiptId,
          occurredAt: input.receivedAt,
        }),
        opening: {
          clientMessageId: receiptId,
          textContent: input.textContent,
          structuredContent: input.structuredContent,
          resourceId: input.resourceId,
        },
      });
      this.state.storage.sql.exec(
        `INSERT INTO automation_runs
           (run_id, occurrence_key, trigger_type, planned_for, workstream_id,
            harness_run_id, admission_state, execution_state, delivery_state,
            context_json, source_version, source_hash, created_at, updated_at)
         VALUES (?, ?, 'inbound_email', ?, ?, ?, 'claimed', 'pending', 'pending',
                 ?, 1, ?, ?, ?)`,
        runId,
        `inbound_email:${input.resendEmailId}`,
        input.receivedAt,
        workstreamId,
        harnessRunId,
        JSON.stringify(context),
        payloadHash,
        now,
        now,
      );
      this.state.storage.sql.exec(
        `INSERT INTO automation_inbound_email_receipts
           (resend_email_id, receipt_id, svix_id, sender_user_id, payload_ref,
            resource_id, run_id, workstream_id, state, outcome_code, received_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admitted', 'admitted', ?, ?)`,
        input.resendEmailId,
        receiptId,
        input.svixId,
        input.senderUserId,
        input.payloadRef,
        input.resourceId,
        runId,
        workstreamId,
        input.receivedAt,
        now,
      );
      this.appendRealtimeEvent("run_admitted", { runId, triggerType: "inbound_email" }, now);
      return { admitted: true, duplicate: false, outcomeCode: "admitted", runId, workstreamId };
    });
    if (result.admitted) await this.armNextAlarm();
    this.broadcastLatestEvents();
    return result;
  }

  /**
   * `stateChanged` is what a caller uses to decide whether anybody watching
   * this automation has to be told. It is narrower than `applied`: a
   * projection that only advances the source version — an archival, a work
   * stream that reopened after the run finished, a second envelope carrying
   * the state the run is already in — is a real acknowledgement the sender
   * must not retry, and it is also nothing a reader would see.
   */
  async applyRunProjection(
    input: unknown,
  ): Promise<{ applied: boolean; outcomeCode: string; stateChanged: boolean }> {
    await this.initialized;
    const request = z.strictObject({
      schemaVersion: z.literal(1),
      automationId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      runId: z.string().uuid(),
      workstreamId: z.string().uuid(),
      workstreamGeneration: z.number().int().positive(),
      sourceVersion: z.number().int().positive(),
      payloadHash: z.string().min(1),
      // A closed set, not an open string: this crosses WorkstreamDO →
      // WorkspaceDO → here, so an older or newer deployment sending an
      // unrecognised state would otherwise be silently mapped to "running"
      // and leave a finished run running forever.
      //
      // The set has to be the *whole* vocabulary the sender can produce, which
      // is `workstreams.exact_state`'s own CHECK in `workstream-do.ts`. An
      // earlier version listed seven values and left out `scheduled` — the
      // state of the very first envelope every automation-provisioned run
      // sends. The parse threw inside `applyWorkstreamDirectoryEffects`'
      // `Promise.all`, which failed the entire envelope batch and retried it
      // forever with the same payload, so every automation's directory updates
      // queued up behind one unparseable state.
      state: z.enum([...RUN_PROJECTION_STATES]),
      completedAt: z.number().int().nonnegative().nullable(),
    }).parse(input);
    const identity = this.identity();
    if (identity.automation_id !== request.automationId || identity.workspace_id !== request.workspaceId) {
      return { applied: false, outcomeCode: "automation_run_projection_destination_mismatch", stateChanged: false };
    }
    const row = this.state.storage.sql.exec<{
      workstream_id: string | null;
      workstream_generation: number;
      source_version: number;
      source_hash: string | null;
      execution_state: string;
    }>(`SELECT workstream_id, workstream_generation, source_version, source_hash, execution_state
          FROM automation_runs WHERE run_id = ?`,
    request.runId).toArray()[0];
    if (!row || row.workstream_id !== request.workstreamId) {
      return { applied: false, outcomeCode: "automation_run_projection_unknown", stateChanged: false };
    }
    if (request.workstreamGeneration !== row.workstream_generation) {
      return { applied: false, outcomeCode: "automation_run_projection_generation_stale", stateChanged: false };
    }
    if (request.sourceVersion < row.source_version) {
      return { applied: false, outcomeCode: "automation_run_projection_stale", stateChanged: false };
    }
    if (request.sourceVersion === row.source_version && row.source_hash !== null) {
      if (row.source_hash !== request.payloadHash) {
        const now = Date.now();
        this.state.storage.transactionSync(() => {
          this.state.storage.sql.exec(
            `UPDATE automation_state
                SET attention_code = 'run_projection_integrity_conflict',
                    attention_message = 'A run update could not be verified.', updated_at = ?
              WHERE id = 1`,
            now,
          );
          this.appendRealtimeEvent("attention_changed", {
            code: "run_projection_integrity_conflict",
            runId: request.runId,
          }, now);
        });
        this.broadcastLatestEvents();
        return { applied: false, outcomeCode: "automation_run_projection_hash_conflict", stateChanged: false };
      }
      return { applied: false, outcomeCode: "automation_run_projection_replayed", stateChanged: false };
    }
    // A run's execution state only ever moves forwards. Two different senders
    // would otherwise walk it backwards, both on ordinary paths: a work stream
    // settles a stop as `idle` rather than `cancelled` and lands on `idle`
    // again when it is unarchived, and a member replying on the same work
    // stream starts another loop, whose first envelope is `scheduled`. Either
    // one arrives with a higher source version than the run's own completion,
    // so without this a finished automation run is rewritten as in-flight and
    // its history says it is still going.
    //
    // `null` is the same rule stated for a different reason: archived,
    // deleting, and restoring describe the work stream and say nothing about
    // the run at all.
    const projected = RUN_EXECUTION_STATE[request.state];
    const executionState = projected === null || TERMINAL_RUN_STATES.has(row.execution_state)
      ? null
      : projected;
    // The source version still advances, so an ignored projection is a real
    // acknowledgement rather than something the sender should retry.
    if (executionState === null) {
      this.state.storage.sql.exec(
        `UPDATE automation_runs
            SET source_version = ?, source_hash = ?, updated_at = ?
          WHERE run_id = ?`,
        request.sourceVersion,
        request.payloadHash,
        Date.now(),
        request.runId,
      );
      return { applied: true, outcomeCode: "automation_run_projection_applied", stateChanged: false };
    }
    this.state.storage.sql.exec(
      `UPDATE automation_runs
          SET execution_state = ?, source_version = ?, source_hash = ?, updated_at = ?
        WHERE run_id = ?`,
      executionState,
      request.sourceVersion,
      request.payloadHash,
      Date.now(),
      request.runId,
    );
    this.state.storage.transactionSync(() => this.appendRealtimeEvent(
      "run_updated",
      { runId: request.runId, state: executionState, completedAt: request.completedAt },
      Date.now(),
    ));
    this.broadcastLatestEvents();
    return {
      applied: true,
      outcomeCode: "automation_run_projection_applied",
      stateChanged: executionState !== row.execution_state,
    };
  }

  async readRunTelemetry(input: {
    automationId: string;
    workspaceId: string;
    runId: string;
  }): Promise<{ automationId: string; triggerType: string } | null> {
    await this.initialized;
    const identity = this.identity();
    if (identity.automation_id !== input.automationId || identity.workspace_id !== input.workspaceId) return null;
    const run = this.state.storage.sql.exec<{ trigger_type: string }>(
      `SELECT trigger_type FROM automation_runs WHERE run_id = ?`,
      input.runId,
    ).toArray()[0];
    return run ? { automationId: identity.automation_id, triggerType: run.trigger_type } : null;
  }

  /**
   * Whether a run may still act on the world.
   *
   * A generated run holds frozen authority for its whole execution, which is
   * right for what it may *see* — but pausing or deleting an automation is a
   * person telling it to stop, and connector writes have to observe that. The
   * child re-reads this between tool batches; memory is already fenced on the
   * generation, and this brings provider writes under the same fence.
   */
  async readRunAuthority(input: {
    automationId: string;
    workspaceId: string;
    runId: string;
  }): Promise<{ lifecycle: string; authorityGeneration: number; runPresent: boolean } | null> {
    await this.initialized;
    const identity = this.identity();
    if (identity.automation_id !== input.automationId || identity.workspace_id !== input.workspaceId) return null;
    const run = this.state.storage.sql.exec<{ run_id: string }>(
      `SELECT run_id FROM automation_runs WHERE run_id = ?`,
      input.runId,
    ).toArray()[0];
    return {
      lifecycle: this.lifecycle(),
      authorityGeneration: identity.authority_generation,
      runPresent: run !== undefined,
    };
  }

  /** Fenced automation-memory bootstrap used when the child freezes its prompt context. */
  async readMemoryBootstrap(rawInput: unknown): Promise<ReturnType<typeof readAutomationMemoryBootstrap>> {
    await this.initialized;
    const input = AutomationMemoryToolRequestSchema.pick({
      schemaVersion: true,
      automationId: true,
      workspaceId: true,
      runId: true,
      harnessRunId: true,
      authorityGeneration: true,
    }).parse(rawInput);
    this.assertMemoryRunFence(input);
    return readAutomationMemoryBootstrap(this.state.storage, input.automationId);
  }

  /** Every generated-run memory read and mutation crosses this parsed authority boundary. */
  async executeMemoryTool(rawInput: unknown): Promise<{
    output: unknown;
    summary: string;
    providerOperationId?: string;
  }> {
    await this.initialized;
    const input = AutomationMemoryToolRequestSchema.parse(rawInput);
    this.assertMemoryRunFence(input);
    return executeAutomationMemoryTool(this.state.storage, input);
  }

  private assertMemoryRunFence(input: {
    automationId: string;
    workspaceId: string;
    runId: string;
    harnessRunId: string;
    authorityGeneration: number;
  }): void {
    const identity = this.identity();
    if (identity.automation_id !== input.automationId || identity.workspace_id !== input.workspaceId) {
      throw new Error("automation_memory_destination_mismatch");
    }
    if (identity.authority_generation !== input.authorityGeneration || this.lifecycle() === "deleted") {
      throw new Error("automation_memory_authority_fenced");
    }
    const run = this.state.storage.sql.exec<{ harness_run_id: string | null }>(
      `SELECT harness_run_id FROM automation_runs WHERE run_id = ? AND admission_state = 'provisioned'`,
      input.runId,
    ).toArray()[0];
    if (!run || run.harness_run_id !== input.harnessRunId) throw new Error("automation_memory_run_mismatch");
  }

  /** Record one child-owned delivery outcome without copying its result bytes. */
  /**
   * What this run's result is worth, decided once and kept.
   *
   * Here rather than in the caller because the answer belongs to the run, and
   * everything the decision reads — the definition, the trigger, what the last
   * few occurrences were judged to be — is this object's own state. The caller
   * has the result text and nothing else.
   *
   * Idempotent by storage: a delivery retry after a crash reads the stored
   * disposition rather than classifying again, which is what stops one
   * occurrence being judged differently the second time and delivering what the
   * first attempt withheld.
   */
  async resolveRunDisposition(input: unknown): Promise<{
    disposition: "done" | "deliver" | "expose_workstream";
    reason: string;
    source: "classified" | "default";
  }> {
    await this.initialized;
    const request = z.strictObject({
      schemaVersion: z.literal(1),
      automationId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      runId: z.string().uuid(),
      result: z.string(),
    }).parse(input);
    const identity = this.identity();
    if (identity.automation_id !== request.automationId || identity.workspace_id !== request.workspaceId) {
      throw new Error("automation_identity_mismatch");
    }
    const run = this.state.storage.sql.exec<{
      workstream_id: string | null;
      context_json: string;
      disposition: string | null;
      disposition_reason: string | null;
      disposition_source: string | null;
    }>(
      `SELECT workstream_id, context_json, disposition, disposition_reason, disposition_source
         FROM automation_runs WHERE run_id = ?`,
      request.runId,
    ).toArray()[0];
    if (!run) throw new Error("automation_run_not_found");
    if (run.disposition) {
      return {
        disposition: run.disposition as "done" | "deliver" | "expose_workstream",
        reason: run.disposition_reason ?? "",
        source: (run.disposition_source ?? "default") as "classified" | "default",
      };
    }
    const context = AutomationRunContextV1Schema.parse(JSON.parse(run.context_json));
    // Newest first, and only settled ones: an occurrence still deciding has
    // nothing to say about whether this one is repetitive.
    const recent = this.state.storage.sql.exec<{ disposition: string }>(
      `SELECT disposition FROM automation_runs
        WHERE disposition IS NOT NULL AND run_id <> ?
        ORDER BY created_at DESC, run_id DESC LIMIT 3`,
      request.runId,
    ).toArray().map((row) => row.disposition as "done" | "deliver" | "expose_workstream");
    const decision = await classifyAutomationResult(this.env, {
      workspaceId: identity.workspace_id,
      workstreamId: run.workstream_id ?? identity.automation_id,
      automationName: context.definition.name,
      automationObjective: context.definition.instructions,
      triggerKind: context.trigger.kind,
      triggerSummary: automationTriggerSummary(context.trigger),
      result: request.result,
      recentDispositions: recent,
      reach: {
        // A room's automation always has somewhere to deliver — the room it
        // belongs to — whether or not anybody added a destination beside it.
        canDeliver: context.deliveryTargets.length > 0 || context.owningWorkstreamId !== null,
        // A room's automation has nothing to expose: its results already arrive
        // in a work stream people can see, so revealing the occurrence's own
        // child work stream would add a second row for the same news.
        canExpose: context.owningWorkstreamId === null,
      },
    });
    this.state.storage.sql.exec(
      `UPDATE automation_runs
          SET disposition = ?, disposition_source = ?, disposition_reason = ?,
              disposition_at = ?, updated_at = ?
        WHERE run_id = ?`,
      decision.disposition,
      decision.source,
      decision.reason,
      Date.now(),
      Date.now(),
      request.runId,
    );
    return decision;
  }

  async recordDeliveryReceipt(input: unknown): Promise<{ applied: boolean; outcomeCode: string }> {
    await this.initialized;
    const request = z.strictObject({
      schemaVersion: z.literal(1),
      automationId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      runId: z.string().uuid(),
      workstreamId: z.string().uuid(),
      targetKey: z.string().min(1).max(500),
      payloadHash: z.string().min(1),
      state: z.enum(["delivered", "skipped", "failed"]),
      outcomeCode: z.string().min(1).max(160),
    }).parse(input);
    const identity = this.identity();
    if (identity.automation_id !== request.automationId || identity.workspace_id !== request.workspaceId) {
      throw new Error("automation_identity_mismatch");
    }
    const run = this.state.storage.sql.exec<{ workstream_id: string; context_json: string }>(
      `SELECT workstream_id, context_json FROM automation_runs WHERE run_id = ?`,
      request.runId,
    ).toArray()[0];
    if (!run || run.workstream_id !== request.workstreamId) {
      return { applied: false, outcomeCode: "automation_delivery_run_unknown" };
    }
    const context = AutomationRunContextV1Schema.parse(JSON.parse(run.context_json));
    const targetKeys = new Set(context.deliveryTargets.map((target) => target.type === "email"
      ? `email:${target.emailAddress.toLocaleLowerCase()}`
      : `slack_agent_dm:${target.connectionId}:${target.slackTeamId}:${target.slackUserId}`));
    // The owning room is a destination too, and the only one for most automations
    // a room owns. Built from `deliveryTargets` alone this set never contained
    // it, so every receipt for the delivery this scope exists for was refused —
    // and refused by returning `applied: false` rather than throwing, which the
    // settlement loop does not treat as a failure. The delivery happened, the
    // room got its message, and nothing recorded that it had.
    if (context.owningWorkstreamId !== null) {
      targetKeys.add(`workstream:${context.owningWorkstreamId}`);
    }
    if (!targetKeys.has(request.targetKey)) {
      return { applied: false, outcomeCode: "automation_delivery_target_unknown" };
    }
    const existing = this.state.storage.sql.exec<{ payload_hash: string; state: string }>(
      `SELECT payload_hash, state FROM automation_delivery_receipts
        WHERE run_id = ? AND target_key = ?`,
      request.runId,
      request.targetKey,
    ).toArray()[0];
    if (existing) {
      if (existing.payload_hash !== request.payloadHash) {
        throw new Error("automation_delivery_receipt_hash_conflict");
      }
      if (existing.state !== "failed" || request.state === "failed") {
        return { applied: false, outcomeCode: "automation_delivery_receipt_replayed" };
      }
    }
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO automation_delivery_receipts
         (run_id, target_key, payload_hash, state, outcome_code, delivered_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, target_key) DO UPDATE SET
         state = excluded.state,
         outcome_code = excluded.outcome_code,
         delivered_at = excluded.delivered_at,
         updated_at = excluded.updated_at`,
      request.runId,
      request.targetKey,
      request.payloadHash,
      request.state,
      request.outcomeCode,
      request.state === "delivered" ? now : null,
      now,
    );
    this.state.storage.sql.exec(
      `UPDATE automation_runs
          SET delivery_state = ?, updated_at = ? WHERE run_id = ?`,
      request.state === "delivered" ? "delivered" : request.state === "failed" ? "failed" : "not_requested",
      now,
      request.runId,
    );
    return { applied: true, outcomeCode: "automation_delivery_receipt_recorded" };
  }

  async listRuns(input: { automationId: string; workspaceId: string; userId: string }): Promise<{ items: unknown[] }> {
    await this.initialized;
    await this.assertViewer(input.automationId, input.workspaceId, input.userId);
    return { items: this.runSummariesUnchecked(input.automationId, 50) };
  }

  private runSummariesUnchecked(automationId: string, limit: number): unknown[] {
    const rows = this.state.storage.sql.exec<{
      run_id: string;
      trigger_type: string;
      planned_for: number | null;
      workstream_id: string;
      execution_state: string;
      created_at: number;
      updated_at: number;
    }>(`SELECT run_id, trigger_type, planned_for, workstream_id, execution_state,
              created_at, updated_at
          FROM automation_runs WHERE workstream_id IS NOT NULL
         ORDER BY created_at DESC, run_id LIMIT ?`, limit).toArray();
    return rows.map((row) => ({
        id: row.run_id,
        automationSubscriptionId: automationId,
        workstreamId: row.workstream_id,
        triggerType: row.trigger_type,
        plannedFor: row.planned_for === null ? null : new Date(row.planned_for).toISOString(),
        startedAt: row.execution_state === "pending" ? null : new Date(row.created_at).toISOString(),
        completedAt: ["completed", "failed", "stopped"].includes(row.execution_state)
          ? new Date(row.updated_at).toISOString()
          : null,
        status: row.execution_state === "pending" ? "scheduled" : row.execution_state,
        resultSummary: null,
        createdAt: new Date(row.created_at).toISOString(),
      }));
  }

  /** Admit one matched external event exactly once; execution provisioning is a later durable lane. */
  async admitExternalEvent(input: unknown): Promise<{ admitted: boolean; outcomeCode: string }> {
    await this.initialized;
    const request = z.strictObject({
      schemaVersion: z.literal(1),
      automationId: z.string().min(1),
      workspaceId: z.string().min(1),
      authorityGeneration: z.number().int().positive(),
      workspaceEventId: z.string().min(1),
      eventSequence: z.number().int().positive(),
      eventType: z.string().min(1),
      occurredAt: z.number().int().nonnegative(),
      payloadHash: z.string().min(1),
    }).parse(input);
    const identity = this.identity();
    if (
      identity.automation_id !== request.automationId
      || identity.workspace_id !== request.workspaceId
      || identity.authority_generation !== request.authorityGeneration
    ) return { admitted: false, outcomeCode: "automation_authority_generation_stale" };
    const lifecycle = this.lifecycle();
    if (lifecycle !== "active" && lifecycle !== "activating") {
      return { admitted: false, outcomeCode: `automation_${lifecycle}` };
    }
    const now = Date.now();
    const result = this.state.storage.transactionSync(() => {
      const existing = this.state.storage.sql.exec<{ state: string; outcome_code: string }>(
        `SELECT state, outcome_code FROM automation_trigger_receipts WHERE workspace_event_id = ?`,
        request.workspaceEventId,
      ).toArray()[0];
      if (existing) {
        return {
          admitted: existing.state !== "refused",
          outcomeCode: "automation_occurrence_replayed",
        };
      }
      const acceptance = this.acceptance();
      if (!acceptance) return { admitted: false, outcomeCode: "automation_acceptance_missing" };
      if (lifecycle === "activating") {
        this.state.storage.sql.exec(
          `INSERT INTO automation_trigger_receipts
             (workspace_event_id, event_sequence, authority_generation, event_type,
              occurred_at, payload_hash, state, outcome_code, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'held_for_activation', 'held_for_activation', ?, ?)`,
          request.workspaceEventId,
          request.eventSequence,
          request.authorityGeneration,
          request.eventType,
          request.occurredAt,
          request.payloadHash,
          now,
          now,
        );
        return { admitted: true, outcomeCode: "automation_event_held_for_activation" };
      }
      if (
        acceptance.effective_after_event_sequence === null
        || request.eventSequence <= acceptance.effective_after_event_sequence
      ) return { admitted: false, outcomeCode: "automation_event_before_activation_boundary" };
      const runId = this.insertExternalRun(request, now);
      this.state.storage.sql.exec(
        `INSERT INTO automation_trigger_receipts
           (workspace_event_id, event_sequence, authority_generation, event_type,
            occurred_at, payload_hash, state, outcome_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'admitted', 'automation_occurrence_admitted', ?, ?)`,
        request.workspaceEventId,
        request.eventSequence,
        request.authorityGeneration,
        request.eventType,
        request.occurredAt,
        request.payloadHash,
        now,
        now,
      );
      this.appendRealtimeEvent("run_admitted", { runId, workspaceEventId: request.workspaceEventId }, now);
      return { admitted: true, outcomeCode: "automation_occurrence_admitted" };
    });
    if (result.admitted) {
      await this.armNextAlarm();
      this.broadcastLatestEvents();
    }
    return result;
  }

  protected override nextDerivedAlarmCandidates(): readonly number[] {
    const outboxDue = this.state.storage.sql.exec<{ not_before: number }>(
      `SELECT not_before FROM automation_outbox
        WHERE state IN ('pending', 'delivering') ORDER BY not_before LIMIT 1`,
    ).toArray()[0]?.not_before;
    const runDue = this.state.storage.sql.exec<{ updated_at: number }>(
      `SELECT updated_at FROM automation_runs
        WHERE admission_state IN ('claimed', 'provisioning', 'provisioned')
          AND execution_state = 'pending'
        ORDER BY updated_at, run_id LIMIT 1`,
    ).toArray()[0]?.updated_at;
    return [outboxDue, runDue].filter((candidate): candidate is number => candidate !== undefined);
  }

  protected override async runScheduledAlarm(alarm: ScheduledAlarm): Promise<ScheduledAlarmOutcome> {
    if (alarm.kind === COMPILER_DISPATCH_ALARM_KIND) {
      // The drafting loop this alarm dispatched is gone. An object that stored
      // one before that deploy still wakes on it, and the kind is retained for
      // exactly that: settling it here discards it the way finishing the run
      // used to, where falling through would raise `automation_alarm_kind_unknown`
      // on every wake, forever, for an object whose only fault is being old.
      return;
    }
    if (alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND) {
      await this.executeSchedule(alarm.key);
      return;
    }
    throw new Error(`automation_alarm_kind_unknown:${alarm.kind}`);
  }

  protected override async runDueAlarmWork(): Promise<void> {
    // Two independent lanes on one alarm. Awaiting them in sequence let a run
    // that cannot be provisioned — a disabled connector, a deleted resource —
    // throw before the outbox ever ran, so workspace projections and the
    // child-archive effects that `deleteAutomation` depends on stopped with
    // it. Each lane keeps its own failure, and the first one to fail is
    // rethrown after both have had their pass so the alarm still retries.
    const failures: unknown[] = [];
    for (const lane of [() => this.provisionNextRun(), () => this.deliverNextOutboxEffect()]) {
      try {
        await lane();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  }

  protected override async scheduledAlarmDeferral(): Promise<number | null> {
    return null;
  }

  protected override onScheduledAlarmFailure(alarm: ScheduledAlarm, error: unknown, attempt: number): void {
    // `diagnosticErrorCode`, not the raw message. An alarm lane runs the
    // compiler and the connector tools, so the error reaching here can carry a
    // provider's prose — which may quote the workspace's own retrieved content
    // — and a log line is exactly where that must not end up. The helper keeps
    // a snake_case code and discards anything that is not one.
    logWarn(this.env, "automation_alarm_failed", {
      kind: alarm.kind,
      attempt,
      code: diagnosticErrorCode(error, "automation_alarm_failed"),
    });
  }

  protected override onScheduledAlarmStalled(alarm: ScheduledAlarm, attempt: number): void {
    logWarn(this.env, "automation_alarm_stalled", { kind: alarm.kind, attempt });
  }

  /** D1 owns the terminal workspace lifecycle, including for already-live objects. */
  private async workspaceOperationalOrFence(): Promise<boolean> {
    const identity = this.identity();
    const workspace = await this.env.DB.prepare(
      `SELECT id FROM workspaces
        WHERE id = ? AND region = ? AND abandoned_at IS NULL`,
    ).bind(identity.workspace_id, identity.region).first<{ id: string }>();
    if (workspace) return true;
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `UPDATE automation_schedules
            SET paused = 1, next_due_at = NULL, updated_at = ?
          WHERE paused = 0 OR next_due_at IS NOT NULL`,
        now,
      );
      this.state.storage.sql.exec(
        `UPDATE automation_compiler_runs
            SET state = 'failed', error_code = 'workspace_abandoned',
                error_message = 'Workspace closed', settled_at = ?, updated_at = ?
          WHERE state IN ('admitted', 'running', 'needs_input')`,
        now,
        now,
      );
      this.state.storage.sql.exec(
        `UPDATE automation_runs
            SET admission_state = 'refused', execution_state = 'stopped',
                delivery_state = 'not_requested', updated_at = ?
          WHERE execution_state = 'pending'`,
        now,
      );
      this.state.storage.sql.exec(
        `UPDATE automation_outbox SET state = 'failed', updated_at = ?
          WHERE state IN ('pending', 'delivering')`,
        now,
      );
    });
    return false;
  }

  private async deliverNextOutboxEffect(): Promise<void> {
    if (!await this.workspaceOperationalOrFence()) return;
    const now = Date.now();
    const claimed = this.state.storage.transactionSync(() => {
      const row = this.state.storage.sql.exec<{
        effect_id: string;
        effect_kind: string;
        payload_json: string;
        attempt: number;
      }>(`SELECT effect_id, effect_kind, payload_json, attempt
            FROM automation_outbox
           WHERE state IN ('pending', 'delivering') AND not_before <= ?
           ORDER BY created_at, effect_id LIMIT 1`, now).toArray()[0];
      if (!row) return null;
      this.state.storage.sql.exec(
        `UPDATE automation_outbox
            SET state = 'delivering', attempt = attempt + 1,
                not_before = ?, updated_at = ? WHERE effect_id = ?`,
        now + AGENT_RUN_DISPATCH_LEASE_MS,
        now,
        row.effect_id,
      );
      return row;
    });
    if (!claimed) return;
    try {
      const payload = JSON.parse(claimed.payload_json);
      if (claimed.effect_kind === "workspace_projection") {
        const workspace = await this.workspace();
        await workspace.applyAutomationProjection(payload);
      } else if (claimed.effect_kind === "archive_child_workstream") {
        const identity = this.identity();
        const child = await durableObjectStubForWorkspace(
          this.env,
          this.env.SUBSTREAM_AGENTS,
          asWorkspaceId(identity.workspace_id),
          substreamAgentName(
            identity.region,
            asWorkspaceId(identity.workspace_id),
            asWorkstreamId(payload.workstreamId),
            asSubstreamId("0"),
          ),
        );
        const result = await child.applyQueuedBatchUpdate(payload);
        if (result.outcome === "skipped" && result.reason !== "workstream_not_found") {
          throw new Error(`automation_child_archive_refused:${result.reason ?? "unknown"}`);
        }
      } else {
        // A kind nothing can deliver never becomes deliverable by waiting, so
        // it is retired rather than retried forever behind the effects queued
        // after it.
        this.state.storage.sql.exec(
          `UPDATE automation_outbox SET state = 'failed', updated_at = ? WHERE effect_id = ?`,
          Date.now(),
          claimed.effect_id,
        );
        throw new Error(`automation_outbox_effect_unknown:${claimed.effect_kind}`);
      }
      this.state.storage.sql.exec(
        `UPDATE automation_outbox SET state = 'delivered', updated_at = ? WHERE effect_id = ?`,
        Date.now(),
        claimed.effect_id,
      );
    } catch (error) {
      // Returning it at `not_before = now` with the attempt count unread meant
      // a permanently failing effect span-locked the lane at full speed. The
      // shared backoff spaces the retries and the attempt is what advances it.
      const attempt = claimed.attempt + 1;
      this.state.storage.sql.exec(
        `UPDATE automation_outbox
            SET state = CASE WHEN state = 'failed' THEN 'failed' ELSE 'pending' END,
                attempt = ?, not_before = ?, updated_at = ?
          WHERE effect_id = ?`,
        attempt,
        Date.now() + scheduledAlarmRetryDelay(attempt),
        Date.now(),
        claimed.effect_id,
      );
      throw error;
    }
  }

  private workspace() {
    const identity = this.identity();
    return durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      asWorkspaceId(identity.workspace_id),
      workspaceDOName(identity.region, asWorkspaceId(identity.workspace_id)),
    );
  }

  private async prepareAcceptance(
    input: z.infer<typeof AutomationAcceptDraftRequestSchema>,
    definition: AutomationDraft,
  ): Promise<{
    connectorBindings: Record<string, string>;
    deliveryTargets: AutomationRunContextV1["deliveryTargets"];
    evaluators: unknown[];
    evaluatorSourceHash: string;
    schedules: Array<{
      id: string;
      kind: "calendar" | "interval";
      definition: Record<string, unknown>;
      nextDueAt: number;
    }>;
  }> {
    const selectedPluginIds = [...new Set([
      ...input.defaultPluginIds,
      ...Object.values(input.activitySourcePluginIds),
    ])];
    // `status <> 'disabled'` is what makes the collapse below deterministic.
    // `connector_connections_active_model_plugin_id_uq` is partial on
    // `status != 'disabled'` and `allocateModelPluginId` hands a disabled row's
    // name back out, so connect/disconnect/reconnect leaves two rows sharing one
    // `model_plugin_id`. Reading both, `new Map` keeps whichever an ORDER BY-less
    // scan returned last; if that was the disabled one, acceptance refused a
    // plugin the create screen had just offered. This is the predicate that
    // screen's own catalog applies.
    const connections = selectedPluginIds.length === 0
      ? { results: [] }
      : await this.workspaceDatabase(input.workspaceId).prepare(
        `SELECT id, connector_type, scope, owner_user_id, model_plugin_id, status
           FROM connector_connections WHERE workspace_id = ? AND status <> 'disabled'`,
      ).bind(input.workspaceId).all<{
      id: string;
      connector_type: string;
      scope: string;
      owner_user_id: string | null;
      model_plugin_id: string;
      status: string;
      }>();
    const connectionsByPlugin = new Map(
      (connections.results ?? []).map((connection) => [connection.model_plugin_id, connection]),
    );
    const connectorBindings: Record<string, string> = {};
    for (const pluginId of selectedPluginIds) {
      const connection = connectionsByPlugin.get(pluginId);
      if (!connection || connection.status === "disabled") throw new Error("automation_plugin_unavailable");
      if (input.scope === "workspace" && connection.scope !== "workspace") {
        throw new Error("automation_workspace_connection_required");
      }
      // Every scope but `workspace` is held to this: you may bind a workspace
      // connection or your own personal one, never somebody else's. A room's
      // automation is managed by everyone in the room and outlives whoever
      // wrote it, so binding a colleague's personal connection to one would
      // lend their credentials to a standing automation they never agreed to.
      if (
        input.scope !== "workspace"
        && connection.scope === "personal"
        && connection.owner_user_id !== input.authorUserId
      ) throw new Error("automation_personal_connection_access_denied");
      connectorBindings[pluginId] = connection.id;
    }

    const deliveryTargets = await this.resolveDeliveryTargets(input);

    const externalTriggers = definition.triggers.filter(isExternalEventTrigger);
    const staged = this.state.storage.sql.exec<{ evaluator_rules_json: string | null }>(
      `SELECT evaluator.evaluator_rules_json
         FROM automation_definition_revisions definition
         LEFT JOIN automation_draft_evaluator_sets evaluator
           ON evaluator.compiler_run_id = definition.compiler_run_id
        WHERE definition.definition_revision = ?`,
      input.definitionRevision,
    ).toArray()[0];
    // An authored draft's rules hang off the revision, a compiled draft's off
    // the compiler run. One of the two is always the empty side.
    const authored = staged?.evaluator_rules_json
      ? null
      : this.state.storage.sql.exec<{ evaluator_rules_json: string }>(
          `SELECT evaluator_rules_json FROM automation_authored_evaluator_sets
            WHERE definition_revision = ?`,
          input.definitionRevision,
        ).toArray()[0] ?? null;
    const rulesJson = staged?.evaluator_rules_json ?? authored?.evaluator_rules_json ?? null;
    const rules = rulesJson
      ? AutomationSetEvaluatorRulesInputV1Schema.parse(JSON.parse(rulesJson))
      : AutomationSetEvaluatorRulesInputV1Schema.parse({ schemaVersion: 1, evaluators: [] });
    if (evaluatorRulesMissing(definition, rules)) {
      throw new Error("automation_evaluator_rules_required");
    }
    const selectedByBinding = new Map(Object.entries(input.activitySourcePluginIds));
    const registry = connectorRegistryForEnv(this.env);
    const inspectedPlugins = new Map<string, {
      pluginId: string;
      activityTriggers: ReturnType<typeof registry.get>["manifest"]["activityTriggers"];
      eventFamilies: Record<string, string[]>;
    }>();
    for (const evaluator of rules.evaluators) {
      const selectedPluginId = selectedByBinding.get(evaluator.source.sourceBindingKey);
      if (!selectedPluginId || selectedPluginId !== evaluator.source.suggestedSourcePluginId) {
        throw new Error("automation_evaluator_source_binding_mismatch");
      }
      const connection = connectionsByPlugin.get(selectedPluginId);
      if (!connection) throw new Error("automation_evaluator_connection_missing");
      const descriptors = registry.get(connection.connector_type).manifest.activityTriggers;
      const eventFamilies: Record<string, string[]> = {};
      for (const descriptor of descriptors) {
        for (const family of descriptor.eventFamilies) {
          eventFamilies[family] = [...(eventFamilies[family] ?? []), descriptor.eventType];
        }
      }
      inspectedPlugins.set(evaluator.source.suggestedSourcePluginId, {
        pluginId: evaluator.source.suggestedSourcePluginId,
        activityTriggers: descriptors,
        eventFamilies,
      });
    }
    const referencedPersonIds = new Set<string>();
    for (const evaluator of rules.evaluators) {
      if (evaluator.when.kind !== "dnf") continue;
      for (const group of evaluator.when.anyOf) {
        for (const leaf of group.allOf) {
          if (leaf.kind !== "person_id" && leaf.kind !== "person_id_array") continue;
          const values = Array.isArray(leaf.value) ? leaf.value : [leaf.value];
          for (const value of values) referencedPersonIds.add(value);
        }
      }
    }
    const resolvedPersonIds = new Set<string>();
    if (referencedPersonIds.size > 0) {
      const ids = [...referencedPersonIds];
      const members = await this.env.DB.prepare(
        `SELECT user_id FROM workspace_members
          WHERE workspace_id = ? AND status = 'active'
            AND user_id IN (${ids.map(() => "?").join(",")})`,
      ).bind(input.workspaceId, ...ids).all<{ user_id: string }>();
      for (const member of members.results ?? []) resolvedPersonIds.add(member.user_id);
      if (resolvedPersonIds.size !== referencedPersonIds.size) {
        throw new Error("automation_person_not_found");
      }
    }
    const referencedResources = new Map<string, {
      pluginId: string;
      sourceBindingKey: string;
      resourceType: string;
    }>();
    for (const evaluator of rules.evaluators) {
      if (!evaluator.source.resourceId) continue;
      const selectedPluginId = selectedByBinding.get(evaluator.source.sourceBindingKey);
      const selectedConnection = selectedPluginId ? connectionsByPlugin.get(selectedPluginId) : undefined;
      const resource = await this.workspaceDatabase(input.workspaceId).prepare(
        `SELECT id, connection_id, resource_type FROM resources WHERE workspace_id = ? AND id = ?`,
      ).bind(input.workspaceId, evaluator.source.resourceId).first<{
        id: string;
        connection_id: string | null;
        resource_type: string;
      }>();
      if (!resource || resource.connection_id !== selectedConnection?.id || !selectedPluginId) {
        throw new Error("automation_resource_not_found");
      }
      referencedResources.set(resource.id, {
        pluginId: evaluator.source.suggestedSourcePluginId,
        sourceBindingKey: evaluator.source.sourceBindingKey,
        resourceType: resource.resource_type,
      });
    }
    const validated = externalTriggers.length === 0
      ? []
      : validateDraftEvaluatorRules(rules, {
          inspectedPlugins,
          personIds: resolvedPersonIds,
          resources: referencedResources,
        });
    const evaluators = validated.flatMap(({ evaluator, expandedEventTypes }) => {
      const pluginId = selectedByBinding.get(evaluator.source.sourceBindingKey)!;
      const connection = connectionsByPlugin.get(pluginId)!;
      return expandedEventTypes.map((eventType) => ({
        evaluatorId: uuidV7(),
        source: {
          connectorType: connection.connector_type,
          connectionId: connection.id,
          eventType,
          ...(evaluator.source.resourceId ? { resourceId: evaluator.source.resourceId } : {}),
        },
        when: evaluator.when,
      }));
    });
    const evaluatorSourceHash = await sha256(JSON.stringify({
      definitionRevision: input.definitionRevision,
      evaluators,
    }));

    const now = Date.now();
    const needsDefaultTimezone = definition.triggers.some(
      (trigger) => trigger.type === "calendar" && trigger.timezone === null,
    );
    const timezone = needsDefaultTimezone
      ? await this.acceptanceTimezone(input.scope, input.authorUserId)
      : "UTC";
    const schedules: Array<{
      id: string;
      kind: "calendar" | "interval";
      definition: Record<string, unknown>;
      nextDueAt: number;
    }> = [];
    for (const trigger of definition.triggers) {
      if (trigger.type === "interval") {
        schedules.push({
          id: uuidV7(),
          kind: "interval",
          definition: { intervalSeconds: trigger.intervalSeconds, acceptedAt: now },
          nextDueAt: now + trigger.intervalSeconds * 1_000,
        });
        continue;
      }
      if (trigger.type !== "calendar") continue;
      const effectiveTimezone = trigger.timezone ?? timezone;
      const next = nextRRuleOccurrence(trigger.rrule, effectiveTimezone, new Date(now), new Date(now));
      if (!next) throw new Error("automation_recurrence_has_no_future");
      schedules.push({
        id: uuidV7(),
        kind: "calendar",
        definition: { rrule: trigger.rrule, timezone: effectiveTimezone, acceptedAt: now },
        nextDueAt: next.getTime(),
      });
    }
    return { connectorBindings, deliveryTargets, evaluators, evaluatorSourceHash, schedules };
  }

  private recordDraftMutation(input: {
    compilerRunId: string;
    providerCallId: string;
    inputHash: string;
    toolName: "automation_submit_draft" | "automation_request_elicitation";
    table: "automation_staged_submissions" | "automation_staged_elicitations";
    json: string;
    evaluatorDisposition?: "require" | "clear";
  }): { accepted: true } {
    return this.state.storage.transactionSync(() => {
      const receipt = this.state.storage.sql.exec<{ input_hash: string; result_json: string }>(
        `SELECT input_hash, result_json FROM automation_tool_receipts
          WHERE compiler_run_id = ? AND provider_call_id = ?`,
        input.compilerRunId,
        input.providerCallId,
      ).toArray()[0];
      if (receipt) {
        if (receipt.input_hash !== input.inputHash) throw new Error("automation_tool_coordinate_conflict");
        return JSON.parse(receipt.result_json) as { accepted: true };
      }
      const active = this.activeCompilerRun();
      if (!active || active.run_id !== input.compilerRunId || active.state !== "running") {
        throw new Error("automation_compiler_run_not_active");
      }
      const now = Date.now();
      if (input.evaluatorDisposition === "require") {
        const evaluatorSet = this.state.storage.sql.exec<{ compiler_run_id: string }>(
          `SELECT compiler_run_id FROM automation_draft_evaluator_sets WHERE compiler_run_id = ?`,
          input.compilerRunId,
        ).toArray()[0];
        if (!evaluatorSet) throw new Error("automation_evaluator_rules_required");
      } else if (input.evaluatorDisposition === "clear") {
        this.state.storage.sql.exec(
          `INSERT INTO automation_draft_evaluator_sets
             (compiler_run_id, provider_call_id, input_hash, evaluator_rules_json, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(compiler_run_id) DO UPDATE SET
             provider_call_id = excluded.provider_call_id,
             input_hash = excluded.input_hash,
             evaluator_rules_json = excluded.evaluator_rules_json,
             updated_at = excluded.updated_at`,
          input.compilerRunId,
          `submit-clear:${input.providerCallId}`,
          input.inputHash,
          JSON.stringify({ schemaVersion: 1, evaluators: [] }),
          now,
        );
      }
      if (input.table === "automation_staged_submissions") {
        this.state.storage.sql.exec(
          `INSERT INTO automation_staged_submissions
             (compiler_run_id, provider_call_id, input_hash, draft_json, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(compiler_run_id) DO UPDATE SET
             provider_call_id = excluded.provider_call_id,
             input_hash = excluded.input_hash,
             draft_json = excluded.draft_json,
             updated_at = excluded.updated_at`,
          input.compilerRunId,
          input.providerCallId,
          input.inputHash,
          input.json,
          now,
        );
      } else {
        this.state.storage.sql.exec(
          `INSERT INTO automation_staged_elicitations
             (compiler_run_id, provider_call_id, input_hash, elicitation_json, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(compiler_run_id) DO UPDATE SET
             provider_call_id = excluded.provider_call_id,
             input_hash = excluded.input_hash,
             elicitation_json = excluded.elicitation_json,
             updated_at = excluded.updated_at`,
          input.compilerRunId,
          input.providerCallId,
          input.inputHash,
          input.json,
          now,
        );
      }
      const result = { accepted: true } as const;
      this.state.storage.sql.exec(
        `INSERT INTO automation_tool_receipts
           (compiler_run_id, provider_call_id, tool_name, input_hash, result_json, settled_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        input.compilerRunId,
        input.providerCallId,
        input.toolName,
        input.inputHash,
        JSON.stringify(result),
        now,
      );
      return result;
    });
  }

  /**
   * The database port for this workspace's product tables.
   *
   * WorkspaceDO is the authority for every `WORKSPACE_LOCAL_TABLES` table this
   * object reads — `connector_connections`, `slack_user_links`, `resources` —
   * and migration 0090 dropped them from regional D1 when that authority
   * opened. The object's own `this.env.DB` is the regional binding, so a
   * statement sent there names a table that is not present: `no such table`,
   * which is not one of this object's snake_case codes, so `withAutomationErrors`
   * let it through as a 500 and saving a connector delivery destination failed
   * with "An unexpected error occurred". Nothing wraps a Durable Object's
   * environment on the way in the way it wraps a service's, so the crossing is
   * named here instead, once.
   *
   * Not the constructor: the port needs a workspace id, and the constructor has
   * none — identity is read from storage behind `await this.initialized`.
   */
  private workspaceDatabase(workspaceId: string): D1Database {
    return withWorkspaceRuntimeDatabase(this.env, asWorkspaceId(workspaceId)).DB;
  }

  private async resolveDeliveryTargets(input: {
    workspaceId: string;
    authorUserId: string;
    scope: z.infer<typeof AutomationScopeSchema>;
    deliveryTargets: z.infer<typeof AutomationDeliveryTargetSetSchema>;
  }): Promise<AutomationRunContextV1["deliveryTargets"]> {
    if (input.scope !== "personal" && input.deliveryTargets.length > 0) {
      throw new Error("automation_personal_delivery_required");
    }
    const workspaceDatabase = this.workspaceDatabase(input.workspaceId);
    const resolved: AutomationRunContextV1["deliveryTargets"] = [];
    for (const target of input.deliveryTargets) {
      if (target.type === "email") {
        // Named rather than `this.env.DB`: this read belongs to the regional
        // authority, and saying so keeps it correct if the object's environment
        // is ever wrapped.
        const user = await workspaceRegionalDatabase(this.env).prepare(
          `SELECT email FROM users WHERE id = ?`,
        ).bind(input.authorUserId).first<{ email: string | null }>();
        if (!user?.email) throw new Error("automation_email_delivery_unavailable");
        resolved.push({ type: "email", emailAddress: user.email });
        continue;
      }
      const connection = await workspaceDatabase.prepare(
        `SELECT status, scope, owner_user_id FROM connector_connections
          WHERE workspace_id = ? AND id = ?`,
      ).bind(input.workspaceId, target.connectionId).first<{
        status: string;
        scope: string;
        owner_user_id: string | null;
      }>();
      if (
        !connection
        || connection.status === "disabled"
        || (connection.scope === "personal" && connection.owner_user_id !== input.authorUserId)
      ) throw new Error("automation_delivery_connection_unavailable");
      const link = await workspaceDatabase.prepare(
        `SELECT slack_team_id, slack_user_id FROM slack_user_links
          WHERE workspace_id = ? AND connection_id = ? AND user_id = ? AND status = 'active'`,
      ).bind(input.workspaceId, target.connectionId, input.authorUserId).first<{
        slack_team_id: string;
        slack_user_id: string;
      }>();
      if (!link) throw new Error("automation_delivery_identity_unavailable");
      resolved.push({
        type: "slack_agent_dm",
        connectionId: target.connectionId,
        slackTeamId: link.slack_team_id,
        slackUserId: link.slack_user_id,
      });
    }
    return resolved;
  }

  private async acceptanceTimezone(
    scope: "personal" | "workspace" | "workstream",
    authorUserId: string,
  ): Promise<string> {
    const row = scope === "personal"
      ? await this.env.DB.prepare(`SELECT timezone FROM users WHERE id = ?`).bind(authorUserId)
          .first<{ timezone: string | null }>()
      : await this.env.DB.prepare(`SELECT timezone FROM workspaces WHERE id = ?`).bind(this.identity().workspace_id)
          .first<{ timezone: string | null }>();
    const timezone = row?.timezone ?? "UTC";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch {
      throw new Error("automation_timezone_invalid");
    }
    return timezone;
  }

  private async provisionNextRun(): Promise<void> {
    if (!await this.workspaceOperationalOrFence()) return;
    const claimed = this.state.storage.transactionSync(() => {
      const row = this.state.storage.sql.exec<{
        run_id: string;
        trigger_type: string;
        planned_for: number | null;
        context_json: string;
        workstream_id: string | null;
        harness_run_id: string | null;
        admission_state: "claimed" | "provisioning" | "provisioned" | "refused";
      }>(`SELECT run_id, trigger_type, planned_for, context_json, workstream_id, harness_run_id, admission_state
            FROM automation_runs
           WHERE admission_state IN ('claimed', 'provisioning', 'provisioned')
             AND execution_state = 'pending'
           ORDER BY updated_at, run_id LIMIT 1`).toArray()[0];
      if (!row || this.lifecycle() !== "active") return null;
      const now = Date.now();
      const workstreamId = row.workstream_id ?? uuidV7(now);
      const harnessRunId = row.harness_run_id ?? uuidV7(now + 1);
      this.state.storage.sql.exec(
        `UPDATE automation_runs
            SET workstream_id = ?, harness_run_id = ?, admission_state = 'provisioning',
                updated_at = ? WHERE run_id = ?`,
        workstreamId,
        harnessRunId,
        now,
        row.run_id,
      );
      return { ...row, workstream_id: workstreamId, harness_run_id: harnessRunId };
    });
    if (!claimed) return;
    const identity = this.identity();
    const context = AutomationRunContextV1Schema.parse(JSON.parse(claimed.context_json));
    const workstreamId = asWorkstreamId(claimed.workstream_id);
    const harnessRunId = asHarnessRunId(claimed.harness_run_id);
    try {
      const executionEnv = await bootstrapWorkstreamRuntimeEnvironment(
        this.env,
        identity.workspace_id,
        workstreamId,
      );
      await provisionWorkstreamObject(this.env, {
        workspaceId: asWorkspaceId(identity.workspace_id),
        workstreamId,
        title: context.definition.name,
        objective: context.definition.instructions,
        // Generated runs are nested implementation detail, not workspace
        // rooms. Even a workspace-scoped automation admits only its frozen
        // execution participant into the child.
        scope: "personal",
        originType: "automation",
        createdByUserId: identity.author_user_id,
        participantUserIds: [identity.author_user_id],
        harnessStatus: "scheduled",
        emailAddress: null,
        emailRouteStatus: null,
        systemKind: null,
        automationSubscriptionId: identity.automation_id,
        automationRunId: claimed.run_id,
        plannedFor: claimed.planned_for,
        modelOverride: context.modelOverride,
        now: Date.now(),
      });
      let triggerMessageId: string | null = null;
      if (context.opening) {
        await attachWorkstreamRuntimeResource(this.env, {
          workspaceId: identity.workspace_id,
          workstreamId,
          resourceId: context.opening.resourceId,
          attachedByUserId: null,
          relationshipType: "inbound_email",
        });
        const appended = await createMessageObjectPort(
          executionEnv,
          identity.workspace_id,
          workstreamId,
        ).appendMessage({
          messageId: uuidV7(Date.now()),
          clientMessageId: context.opening.clientMessageId,
          authorType: "system",
          authorUserId: null,
          externalActorJson: null,
          messageType: "system",
          text: context.opening.textContent,
          structuredContentJson: JSON.stringify(context.opening.structuredContent),
          producedByRunId: null,
          now: Date.now(),
        });
        triggerMessageId = appended.messageId;
      }
      // The pin is validated on its way onto the run, not taken as read. It
      // was frozen into the run context when the automation was accepted, and
      // a model retired from the catalog since then would otherwise be handed
      // to the provider as though it still existed — with nothing in the logs
      // to connect the failure to the pin. `automationModelOverride` drops an
      // unknown model back to the flag's choice and says so as
      // `workstream_model_override_unknown`, which is the diagnostic
      // `docs/feature-flags.md` promises for exactly this case.
      const pinned = automationModelOverride(executionEnv, context.modelOverride, {
        workspaceId: identity.workspace_id,
        automationSubscriptionId: context.automationId,
      });
      const model = pinned ?? await scheduledWorkstreamModel(executionEnv, {
        workspaceId: identity.workspace_id,
        workstreamId,
      });
      await createHarnessRunObjectPort(executionEnv, identity.workspace_id, workstreamId).admitRun({
        runId: harnessRunId,
        origin: "automation_run",
        executionPrincipalJson: JSON.stringify(context.executionPrincipal),
        status: "admitted",
        startedAt: null,
        model,
        triggerPartId: null,
        parentRunId: null,
        expectedLatestRunId: null,
        now: Date.now(),
      });
      this.state.storage.sql.exec(
        `UPDATE automation_runs
            SET admission_state = 'provisioned', updated_at = ? WHERE run_id = ?`,
        Date.now(),
        claimed.run_id,
      );
      const workflowInstanceId = await activateWorkstreamLoop(this.env, {
        region: identity.region,
        workspaceId: asWorkspaceId(identity.workspace_id),
        workstreamId,
        loopId: substreamLoopId(workstreamId),
        harnessRunId,
        triggerMessageId,
        automationSubscriptionId: identity.automation_id,
        automationRunContext: context,
        activityId: null,
        executionPrincipal: {
          type: "user",
          userId: asUserId(context.executionPrincipal.userId),
        },
        reason: claimed.trigger_type,
      });
      this.state.storage.sql.exec(
        `UPDATE automation_runs
            SET execution_state = 'running', workflow_instance_id = ?, updated_at = ?
          WHERE run_id = ?`,
        workflowInstanceId,
        Date.now(),
        claimed.run_id,
      );
    } catch (error) {
      this.state.storage.sql.exec(
        `UPDATE automation_runs
            SET admission_state = CASE WHEN workstream_id IS NULL THEN 'claimed' ELSE admission_state END,
                updated_at = ? WHERE run_id = ? AND execution_state = 'pending'`,
        Date.now(),
        claimed.run_id,
      );
      throw error;
    }
  }

  private async executeSchedule(scheduleId: string): Promise<void> {
    if (!await this.workspaceOperationalOrFence()) return;
    const schedule = this.state.storage.sql.exec<{
      schedule_kind: "calendar" | "interval";
      definition_json: string;
      next_due_at: number | null;
      paused: number;
    }>(`SELECT schedule_kind, definition_json, next_due_at, paused
          FROM automation_schedules WHERE schedule_id = ?`, scheduleId).toArray()[0];
    if (!schedule || schedule.paused === 1 || schedule.next_due_at === null || this.lifecycle() !== "active") return;
    const now = Date.now();
    const dueAt = schedule.next_due_at;
    const occurrenceKey = `schedule:${scheduleId}:${dueAt}`;
    const runId = uuidV7(now);
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO automation_runs
           (run_id, occurrence_key, trigger_type, planned_for, workstream_id,
            admission_state, execution_state, delivery_state, context_json,
            source_version, source_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, 'claimed', 'pending', 'pending', ?, 1, NULL, ?, ?)`,
        runId,
        occurrenceKey,
        "schedule",
        dueAt,
        JSON.stringify(this.runContext(runId, {
          kind: "schedule",
          scheduleId,
          scheduleKind: schedule.schedule_kind,
          plannedFor: dueAt,
        })),
        now,
        now,
      );
    });
    const definition = JSON.parse(schedule.definition_json) as {
      acceptedAt: number;
      intervalSeconds?: number;
      rrule?: string;
      timezone?: string;
    };
    const nextDueAt = schedule.schedule_kind === "interval"
      ? now + definition.intervalSeconds! * 1_000
      : nextRRuleOccurrence(
          definition.rrule!,
          definition.timezone!,
          new Date(definition.acceptedAt),
          new Date(now),
        )?.getTime() ?? null;
    this.state.storage.sql.exec(
      `UPDATE automation_schedules SET next_due_at = ?, updated_at = ? WHERE schedule_id = ?`,
      nextDueAt,
      now,
      scheduleId,
    );
    if (nextDueAt !== null) {
      await this.scheduleAlarm({ kind: AUTOMATION_SCHEDULE_ALARM_KIND, key: scheduleId, dueAt: nextDueAt });
    }
  }

  private scheduleDueAfter(
    kind: "calendar" | "interval",
    definitionJson: string,
    after: number,
  ): number | null {
    const definition = JSON.parse(definitionJson) as {
      acceptedAt: number;
      intervalSeconds?: number;
      rrule?: string;
      timezone?: string;
    };
    if (kind === "interval") return after + definition.intervalSeconds! * 1_000;
    return nextRRuleOccurrence(
      definition.rrule!,
      definition.timezone!,
      new Date(definition.acceptedAt),
      new Date(after),
    )?.getTime() ?? null;
  }

  private runContext(
    runId: string,
    trigger: AutomationRunContextV1["trigger"],
  ): AutomationRunContextV1 {
    const identity = this.identity();
    const acceptance = this.acceptance();
    const definition = this.currentDefinition();
    if (!acceptance || !definition) throw new Error("automation_acceptance_missing");
    return AutomationRunContextV1Schema.parse({
      schemaVersion: 1,
      automationId: identity.automation_id,
      workspaceId: identity.workspace_id,
      runId,
      authorityGeneration: identity.authority_generation,
      definitionRevision: acceptance.definition_revision,
      definition: {
        name: definition.name,
        description: definition.description,
        overview: definition.overview,
        instructions: definition.instructions,
        requiredCapabilities: definition.requiredCapabilities,
        expectedOutputs: definition.expectedOutputs,
        defaultBehavior: definition.defaultBehavior,
        recommendedPlugins: definition.recommendedPlugins,
        memoryTables: definition.memoryTables,
      },
      defaultPluginIds: JSON.parse(acceptance.default_plugin_ids_json),
      activitySourcePluginIds: JSON.parse(acceptance.activity_source_plugin_ids_json),
      connectorBindings: JSON.parse(acceptance.connector_bindings_json),
      deliveryTargets: JSON.parse(acceptance.delivery_targets_json),
      owningWorkstreamId: acceptance.owning_workstream_id,
      scope: acceptance.scope as "personal" | "workspace" | "workstream",
      authoringOrigin: this.authoredOrigin(),
      modelOverride: acceptance.model_override,
      executionPrincipal: { type: "user", userId: this.executionPrincipalUserId() },
      trigger,
      opening: null,
      memoryScope: {
        automationId: identity.automation_id,
        authorityGeneration: identity.authority_generation,
      },
    });
  }

  private insertExternalRun(request: {
    automationId: string;
    workspaceEventId: string;
    eventType: string;
    occurredAt: number;
    payloadHash: string;
  }, now: number): string {
    const runId = uuidV7(now);
    this.state.storage.sql.exec(
      `INSERT INTO automation_runs
         (run_id, occurrence_key, trigger_type, planned_for, workstream_id,
          admission_state, execution_state, delivery_state, context_json,
          source_version, source_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, 'claimed', 'pending', 'pending', ?, 1, ?, ?, ?)`,
      runId,
      `external:${request.workspaceEventId}`,
      request.eventType,
      request.occurredAt,
      JSON.stringify({
        ...this.runContext(runId, {
          kind: "external_event",
          workspaceEventId: request.workspaceEventId,
          eventType: request.eventType,
          occurredAt: request.occurredAt,
          payloadHash: request.payloadHash,
        }),
      }),
      request.payloadHash,
      now,
      now,
    );
    return runId;
  }

  private promoteHeldExternalEvents(
    authorityGeneration: number,
    effectiveAfterEventSequence: number,
    now: number,
  ): void {
    const held = this.state.storage.sql.exec<{
      workspace_event_id: string;
      event_sequence: number;
      authority_generation: number;
      event_type: string;
      occurred_at: number;
      payload_hash: string;
    }>(`SELECT workspace_event_id, event_sequence, authority_generation, event_type,
              occurred_at, payload_hash
          FROM automation_trigger_receipts
         WHERE state = 'held_for_activation'
         ORDER BY event_sequence, workspace_event_id`).toArray();
    const identity = this.identity();
    for (const receipt of held) {
      if (
        receipt.authority_generation !== authorityGeneration
        || receipt.event_sequence <= effectiveAfterEventSequence
      ) {
        this.state.storage.sql.exec(
          `UPDATE automation_trigger_receipts
              SET state = 'refused', outcome_code = 'automation_event_before_activation_boundary',
                  updated_at = ? WHERE workspace_event_id = ?`,
          now,
          receipt.workspace_event_id,
        );
        continue;
      }
      this.insertExternalRun({
        automationId: identity.automation_id,
        workspaceEventId: receipt.workspace_event_id,
        eventType: receipt.event_type,
        occurredAt: receipt.occurred_at,
        payloadHash: receipt.payload_hash,
      }, now);
      this.state.storage.sql.exec(
        `UPDATE automation_trigger_receipts
            SET state = 'admitted', outcome_code = 'automation_occurrence_admitted',
                updated_at = ? WHERE workspace_event_id = ?`,
        now,
        receipt.workspace_event_id,
      );
    }
  }

  /**
   * Drop a settled run's narration deltas.
   *
   * They exist to rebuild the *current* run's narration for a reader who
   * connects mid-compile. Once the run settles nothing reads them again, and
   * left in place they were the one table that grew without bound for the life
   * of the automation — one row per streamed token.
   */
  private retireCompilerStreamEvents(runId: string): void {
    this.state.storage.sql.exec(
      `DELETE FROM automation_realtime_events
        WHERE event_type = 'compiler_stream' AND json_extract(payload_json, '$.runId') = ?`,
      runId,
    );
  }

  /** Drop every run's narration deltas except the one just admitted. */
  private retireSupersededCompilerStreamEvents(currentRunId: string): void {
    this.state.storage.sql.exec(
      `DELETE FROM automation_realtime_events
        WHERE event_type = 'compiler_stream'
          AND json_extract(payload_json, '$.runId') <> ?`,
      currentRunId,
    );
  }

  private ensureIdentity(input: AutomationDraftTurnAdmissionRequest, now: number): void {
    const existing = this.state.storage.sql.exec<{ automation_id: string }>(
      `SELECT automation_id FROM automation_identity WHERE id = 1`,
    ).toArray()[0];
    if (existing) return;
    this.state.storage.sql.exec(
      `INSERT INTO automation_identity
         (id, automation_id, workspace_id, author_user_id, region,
          authority_generation, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, 1, ?, ?)`,
      input.automationId,
      input.workspaceId,
      input.authorUserId,
      input.region,
      now,
      now,
    );
    this.state.storage.sql.exec(
      `INSERT INTO automation_state
         (id, lifecycle, title, definition_revision, accepted_definition_revision,
          event_sequence, created_at, updated_at)
       VALUES (1, 'draft', 'New automation', 0, NULL, 0, ?, ?)`,
      now,
      now,
    );
  }

  private assertDraftAuthor(input: AutomationDraftTurnAdmissionRequest): void {
    this.assertAuthor(input.automationId, input.workspaceId, input.authorUserId);
    const lifecycle = this.state.storage.sql.exec<{ lifecycle: string }>(
      `SELECT lifecycle FROM automation_state WHERE id = 1`,
    ).toArray()[0]?.lifecycle;
    if (lifecycle !== "draft") throw new Error("automation_not_draft");
  }

  private lifecycle(): "draft" | "activating" | "active" | "paused" | "deleted" {
    return this.state.storage.sql.exec<{
      lifecycle: "draft" | "activating" | "active" | "paused" | "deleted";
    }>(`SELECT lifecycle FROM automation_state WHERE id = 1`).one().lifecycle;
  }

  /**
   * Who this automation runs as.
   *
   * `run_as_user_id` when somebody has taken it over, and the author otherwise.
   * The author is provenance — the run history goes on saying who wrote the
   * automation long after somebody else is running it — so a takeover writes
   * the state column and never the identity row.
   */
  /*
   * The `{ type: "workspace" }` arm the design also describes is deliberately
   * not built. Producing it means knowing, synchronously, that every binding
   * points at a workspace-scoped connection — and `runContext` cannot read the
   * connector rows, which live in WorkspaceDO. Freezing the answer at
   * acceptance would make it wrong the first time somebody converts a
   * connection between scopes.
   *
   * What it would buy is already delivered: the only thing that treats such an
   * automation differently is the principal-unavailable card, and that is
   * written when a run *finds a dead binding*, which an all-workspace
   * automation never does. The arm changes which principal a run carries and
   * nothing a person can see, so it waits for a reader that needs it.
   */
  private executionPrincipalUserId(): string {
    const runAs = this.state.storage.sql.exec<{ run_as_user_id: string | null }>(
      `SELECT run_as_user_id FROM automation_state WHERE id = 1`,
    ).toArray()[0]?.run_as_user_id ?? null;
    return runAs ?? this.identity().author_user_id;
  }

  /** Why this automation needs a person, or `null` when it does not. */
  private attentionCode(): string | null {
    return this.state.storage.sql.exec<{ attention_code: string | null }>(
      `SELECT attention_code FROM automation_state WHERE id = 1`,
    ).one().attention_code;
  }

  private acceptance(): AutomationAcceptanceRow | null {
    return this.state.storage.sql.exec<AutomationAcceptanceRow>(
      `SELECT definition_revision, request_hash, scope, owning_workstream_id,
              default_plugin_ids_json,
              activity_source_plugin_ids_json, connector_bindings_json,
              delivery_targets_json, model_override, evaluator_projection_json,
              evaluator_source_hash, effective_after_event_sequence, accepted_at, activated_at
         FROM automation_acceptance WHERE id = 1`,
    ).toArray()[0] ?? null;
  }

  private deleteDraftConversation(acceptedDefinitionRevision: number): void {
    this.state.storage.sql.exec(
      `UPDATE automation_definition_revisions SET compiler_run_id = NULL
        WHERE definition_revision = ?`,
      acceptedDefinitionRevision,
    );
    this.state.storage.sql.exec(`DELETE FROM automation_pending_elicitations`);
    this.state.storage.sql.exec(`DELETE FROM automation_tool_receipts`);
    this.state.storage.sql.exec(`DELETE FROM automation_staged_elicitations`);
    this.state.storage.sql.exec(`DELETE FROM automation_staged_submissions`);
    this.state.storage.sql.exec(`DELETE FROM automation_draft_evaluator_sets`);
    this.state.storage.sql.exec(
      `DELETE FROM automation_definition_revisions WHERE definition_revision <> ?`,
      acceptedDefinitionRevision,
    );
    this.state.storage.sql.exec(`DELETE FROM automation_compiler_runs`);
    this.state.storage.sql.exec(`DELETE FROM automation_draft_message_metadata`);
    this.state.storage.sql.exec(`DELETE FROM bind_provider_boundaries`);
    this.state.storage.sql.exec(`DELETE FROM bind_loop_state_messages`);
    this.state.storage.sql.exec(`DELETE FROM bind_loop_states`);
    this.state.storage.sql.exec(`DELETE FROM bind_loop_heads`);
    this.state.storage.sql.exec(`DELETE FROM transcript_compaction_checkpoints`);
    this.state.storage.sql.exec(`DELETE FROM transcript_activity_intervals`);
    this.state.storage.sql.exec(`DELETE FROM transcript_activities`);
    this.state.storage.sql.exec(`DELETE FROM participant_transcript_blocks`);
    this.state.storage.sql.exec(`DELETE FROM participant_transcript_turns`);
    this.state.storage.sql.exec(`DELETE FROM transcript_facts`);
    this.state.storage.sql.exec(`DELETE FROM transcript_payloads`);
  }

  /**
   * The next projection coordinate, monotonic for the life of the object.
   *
   * WorkspaceDO compares (authorityGeneration, projectionVersion) and refuses
   * anything that is not strictly newer. Deriving this from `event_sequence`
   * made acceptance — which resets that cursor — publish version 1 behind the
   * draft's own higher versions, so the activation projection was discarded
   * and the directory kept showing a live automation as an unfinished draft.
   */
  private nextProjectionVersion(): number {
    const row = this.state.storage.sql.exec<{ projection_version: number }>(
      `UPDATE automation_state SET projection_version = projection_version + 1
        WHERE id = 1 RETURNING projection_version`,
    ).toArray()[0];
    if (!row) throw new Error("automation_state_missing");
    return row.projection_version;
  }

  private enqueueWorkspaceProjection(input: {
    lifecycle: "draft" | "activating" | "active" | "paused" | "deleted";
    scope: "personal" | "workspace" | "workstream";
    owningWorkstreamId?: string | null;
    definition: AutomationDraft | null;
    payloadHash: string;
    now: number;
  }): void {
    const identity = this.identity();
    const projectionVersion = this.nextProjectionVersion();
    const nextRunAt = this.state.storage.sql.exec<{ next_due_at: number | null }>(
      `SELECT MIN(next_due_at) AS next_due_at FROM automation_schedules WHERE paused = 0`,
    ).toArray()[0]?.next_due_at ?? null;
    // The reason as this object currently holds it, not a constant. A projection
    // that always said "nothing is wrong" cleared the directory's copy on the
    // next pause or resume, so an imported automation whose trigger cannot fire
    // lost its sidebar marker the first time anybody touched it — while this
    // object went on saying the trigger cannot fire.
    const attentionCode = AutomationAttentionReasonSchema.nullable().parse(
      this.attentionCode(),
    );
    this.state.storage.sql.exec(
      `INSERT INTO automation_outbox
         (effect_id, effect_kind, payload_json, state, attempt, not_before, created_at, updated_at)
       VALUES (?, 'workspace_projection', ?, 'pending', 0, ?, ?, ?)`,
      `projection:${identity.authority_generation}:${projectionVersion}:${uuidV7(input.now)}`,
      JSON.stringify({
        schemaVersion: 1,
        automationId: identity.automation_id,
        workspaceId: identity.workspace_id,
        authorUserId: identity.author_user_id,
        authorityGeneration: identity.authority_generation,
        projectionVersion,
        payloadHash: input.payloadHash,
        lifecycle: input.lifecycle,
        scope: input.scope,
        owningWorkstreamId: input.owningWorkstreamId ?? null,
        title: input.definition?.name ?? "New automation",
        description: input.definition?.description ?? "",
        nextRunAt,
        attentionCode,
      }),
      input.now,
      input.now,
      input.now,
    );
  }

  private detailUnchecked(): AutomationDetail {
    const identity = this.identity();
    const acceptance = this.acceptance();
    if (!acceptance) throw new Error("automation_not_accepted");
    const definition = this.currentDefinition();
    if (!definition) throw new Error("automation_definition_missing");
    const state = this.state.storage.sql.exec<{
      lifecycle: string;
      attention_code: string | null;
      updated_at: number;
    }>(`SELECT lifecycle, attention_code, updated_at FROM automation_state WHERE id = 1`).one();
    const nextRunAt = this.state.storage.sql.exec<{ next_due_at: number | null }>(
      `SELECT MIN(next_due_at) AS next_due_at FROM automation_schedules WHERE paused = 0`,
    ).toArray()[0]?.next_due_at ?? null;
    const lastRunAt = this.state.storage.sql.exec<{ created_at: number }>(
      `SELECT created_at FROM automation_runs ORDER BY created_at DESC LIMIT 1`,
    ).toArray()[0]?.created_at ?? null;
    const emailAddress = this.state.storage.sql.exec<{ email_address: string }>(
      `SELECT email_address FROM automation_email_route WHERE id = 1`,
    ).toArray()[0]?.email_address ?? null;
    const deliveryTargets = JSON.parse(acceptance.delivery_targets_json) as Array<{
      type: "email" | "slack_agent_dm";
      connectionId?: string;
      emailAddress?: string;
      slackUserId?: string;
    }>;
    return AutomationDetailSchema.parse({
      id: identity.automation_id,
      name: definition.name,
      description: definition.description,
      emailAddress,
      scope: acceptance.scope,
      owningWorkstreamId: acceptance.owning_workstream_id,
      status: state.lifecycle === "paused" ? "paused" : "active",
      // This object is the authority on the reason; the directory row is a copy
      // of it. `AutomationDetailSchema` is what turns the stored code into one
      // of the contract's reasons.
      attention: state.attention_code,
      nextRunAt: nextRunAt === null ? null : new Date(nextRunAt).toISOString(),
      lastRunAt: lastRunAt === null ? null : new Date(lastRunAt).toISOString(),
      updatedAt: new Date(state.updated_at).toISOString(),
      updateAvailable: false,
      templateId: identity.automation_id,
      templateVersionId: identity.automation_id,
      versionNumber: acceptance.definition_revision,
      instructions: definition.instructions,
      overview: definition.overview,
      triggers: definition.triggers,
      requiredCapabilities: definition.requiredCapabilities,
      expectedOutputs: definition.expectedOutputs,
      executionPrincipal: { type: "user", userId: this.executionPrincipalUserId() },
      recommendedPlugins: definition.recommendedPlugins,
      memoryTables: definition.memoryTables,
      defaultPluginIds: JSON.parse(acceptance.default_plugin_ids_json),
      activitySourcePluginIds: JSON.parse(acceptance.activity_source_plugin_ids_json),
      deliveryTargets: deliveryTargets.map((target) => ({
        type: target.type,
        connectionId: target.connectionId ?? null,
        // Never the provider's own id. This field is read only for a
        // destination whose connection is gone, where it is the sole label on
        // the one row telling a person something is wrong — and `U0ABCDEF` is
        // not something they have ever seen in Slack. The projection is
        // synchronous (`broadcastSnapshot` calls it), so it cannot join the
        // connection's name; the target type's own noun is what it has.
        displayName: target.type === "email"
          ? target.emailAddress ?? "Email"
          : "Slack direct message",
        status: "active",
      })),
      templateUpdate: null,
      nextPlannedWorkstream: null,
      // Preserve the existing detail contract's recent-history window. The
      // complete route uses the same mapper with its wider list window.
      recentRuns: this.runSummariesUnchecked(identity.automation_id, 20),
    });
  }

  private broadcastSnapshot(): void {
    const snapshot = this.snapshotUnchecked();
    const sequence = this.eventSequence();
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Record<string, unknown> | null;
      try {
        socket.send(JSON.stringify({ type: "snapshot", snapshot }));
        socket.serializeAttachment({ ...(attachment ?? {}), eventSequence: sequence });
      } catch {
        // Reconnect reads the active snapshot from the durable object.
      }
    }
  }

  /**
   * Who may change an automation that already belongs to the workspace.
   *
   * The author always may. A workspace-scoped automation additionally answers
   * to the workspace's owners and admins, because it holds workspace connector
   * bindings and publishes a directory entry every member sees — the same
   * people who authorized its scope are the ones who can withdraw it. A
   * personal automation is its author's alone, and an admin role does not
   * reach into it.
   */
  /**
   * Who may change an automation that already exists — which is a different
   * question from who may accept one, and the two are easy to run together.
   * Accepting starts a standing behavior somebody asked for; managing alters
   * one the workspace or a room has come to depend on.
   */
  private assertManager(
    automationId: string,
    workspaceId: string,
    userId: string,
    actorRole: string | undefined,
    participantOfOwningWorkstream = false,
  ): void {
    const identity = this.identity();
    if (
      identity.automation_id !== automationId
      || identity.workspace_id !== workspaceId
      || identity.region !== this.env.AVALON_REGION
    ) throw new Error("automation_authority_mismatch");
    const scope = this.acceptance()?.scope;
    // A room's automation belongs to the room, and authorship is not a share in
    // it. Checked before the author shortcut rather than after, because after
    // is indistinguishable from no check at all: somebody removed from the room
    // would keep pausing, editing and deleting its automation for as long as
    // they remained in the workspace, which is the exact tenure this scope
    // exists to end. Participation lives in the work stream's own object, so
    // the caller resolves it and this asserts on the answer.
    if (scope === "workstream") {
      if (participantOfOwningWorkstream) return;
      throw new Error("automation_authority_mismatch");
    }
    if (identity.author_user_id === userId) return;
    if (scope === "workspace" && (actorRole === "owner" || actorRole === "admin")) return;
    throw new Error("automation_authority_mismatch");
  }

  /**
   * Take over who this automation runs as, and rebind what the last principal
   * took with them.
   *
   * The claimant is always the caller. There is no user ID to pass, because a
   * field naming somebody else would let one person lend a colleague's Gmail to
   * a standing automation — an agreement the person themselves has to make.
   *
   * Bindings to workspace-scoped connections are left alone: they belong to the
   * workspace rather than to whoever authorized them, so they never broke, and
   * rewriting them would be a write on the one thing that still worked. A
   * provider the claimant has no connection for stays unbound and is reported,
   * because the room would rather have most of its automation back than none.
   */
  async claimExecutionPrincipal(input: unknown): Promise<{
    principalUserId: string;
    reboundPluginIds: string[];
    unboundProviders: string[];
    changed: boolean;
  }> {
    await this.initialized;
    const request = z.strictObject({
      schemaVersion: z.literal(1),
      automationId: z.string().uuid(),
      workspaceId: z.string().uuid(),
      userId: z.string().uuid(),
      actorRole: z.string().optional(),
      participantOfOwningWorkstream: z.boolean().default(false),
    }).parse(input);
    this.assertManager(
      request.automationId,
      request.workspaceId,
      request.userId,
      request.actorRole,
      request.participantOfOwningWorkstream,
    );
    const acceptance = this.acceptance();
    if (!acceptance) throw new Error("automation_acceptance_missing");
    const current = this.executionPrincipalUserId();
    const bindings = JSON.parse(acceptance.connector_bindings_json) as Record<string, string>;
    const connections = await this.workspaceDatabase(request.workspaceId).prepare(
      `SELECT id, scope, owner_user_id, model_plugin_id, status
         FROM connector_connections WHERE workspace_id = ? AND status <> 'disabled'`,
    ).bind(request.workspaceId).all<{
      id: string;
      scope: string;
      owner_user_id: string | null;
      model_plugin_id: string;
      status: string;
    }>();
    const rows = connections.results ?? [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const claimantByPlugin = new Map(rows
      .filter((row) => row.scope === "workspace"
        || row.owner_user_id === request.userId)
      .map((row) => [row.model_plugin_id, row]));
    const rebound: string[] = [];
    const unbound: string[] = [];
    const next = { ...bindings };
    for (const [pluginId, connectionId] of Object.entries(bindings)) {
      const bound = byId.get(connectionId);
      // Still live, or workspace-scoped and therefore never at risk.
      if (bound && (bound.scope === "workspace" || bound.owner_user_id === request.userId)) continue;
      const replacement = claimantByPlugin.get(pluginId);
      if (!replacement) {
        unbound.push(pluginId);
        continue;
      }
      next[pluginId] = replacement.id;
      rebound.push(pluginId);
    }
    // Idempotent: claiming an automation you already run, with nothing to move,
    // reports the current state rather than writing a second audit row.
    const changed = current !== request.userId || rebound.length > 0;
    if (changed) {
      const now = Date.now();
      this.state.storage.transactionSync(() => {
        this.state.storage.sql.exec(
          `UPDATE automation_state SET run_as_user_id = ?, updated_at = ? WHERE id = 1`,
          request.userId,
          now,
        );
        if (rebound.length > 0) {
          this.state.storage.sql.exec(
            `UPDATE automation_acceptance SET connector_bindings_json = ? WHERE id = 1`,
            JSON.stringify(next),
          );
        }
        this.state.storage.sql.exec(
          `INSERT INTO automation_principal_claims
             (claim_id, claimed_by_user_id, previous_user_id, rebound_plugin_ids_json,
              unbound_providers_json, claimed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          uuidV7(now),
          request.userId,
          current === request.userId ? null : current,
          JSON.stringify(rebound),
          JSON.stringify(unbound),
          now,
        );
      });
    }
    return {
      principalUserId: request.userId,
      reboundPluginIds: rebound,
      unboundProviders: unbound,
      changed,
    };
  }

  private assertAuthor(automationId: string, workspaceId: string, userId: string): void {
    const identity = this.identity();
    if (
      identity.automation_id !== automationId
      || identity.workspace_id !== workspaceId
      || identity.author_user_id !== userId
      || identity.region !== this.env.AVALON_REGION
    ) throw new Error("automation_authority_mismatch");
  }

  private async assertViewer(automationId: string, workspaceId: string, userId: string): Promise<void> {
    const identity = this.identity();
    if (identity.automation_id !== automationId || identity.workspace_id !== workspaceId) {
      throw new Error("automation_identity_mismatch");
    }
    // Not for a room's automation: `authorizeAutomationViewer` answers that one
    // from current participation, and letting authorship short-circuit it would
    // leave a former participant reading a room's automation forever.
    if (identity.author_user_id === userId && this.acceptance()?.scope !== "workstream") return;
    const result = await (await this.workspace()).authorizeAutomationViewer({
      workspaceId,
      automationId,
      userId,
    });
    if (!result.authorized) throw new Error("automation_access_denied");
  }

  private identity(): {
    automation_id: string;
    workspace_id: string;
    author_user_id: string;
    region: "global" | "eu";
    authority_generation: number;
  } {
    const row = this.state.storage.sql.exec<{
      automation_id: string;
      workspace_id: string;
      author_user_id: string;
      region: "global" | "eu";
      authority_generation: number;
    }>(`SELECT automation_id, workspace_id, author_user_id, region, authority_generation
          FROM automation_identity WHERE id = 1`).toArray()[0];
    if (!row) throw new Error("automation_identity_missing");
    return row;
  }

  private activeCompilerRun(): ActiveCompilerRow | null {
    return this.state.storage.sql.exec<ActiveCompilerRow>(
      `SELECT run_id, state, admitted_turn_id, error_code, error_message
         FROM automation_compiler_runs
        WHERE state IN ('admitted', 'running')
        ORDER BY admitted_at DESC LIMIT 1`,
    ).toArray()[0] ?? null;
  }

  /**
   * The current compiler status exposed to reconnecting clients. Failed and
   * needs-input runs are no longer execution locks, but they remain the most
   * recent durable outcome until another turn is admitted. Hiding them made a
   * compiler failure look like a successful idle reconnect.
   */
  private visibleCompilerRun(): ActiveCompilerRow | null {
    return this.state.storage.sql.exec<ActiveCompilerRow>(
      `SELECT run_id, state, admitted_turn_id, error_code, error_message
         FROM automation_compiler_runs
        WHERE state NOT IN ('completed', 'cancelled')
        ORDER BY admitted_at DESC LIMIT 1`,
    ).toArray()[0] ?? null;
  }

  private compilerMessages(): Array<{ role: "user" | "assistant"; content: string }> {
    return this.transcript().messages().map((message) => ({
      role: message.actor === "assistant" ? "assistant" : "user",
      content: message.content,
    }));
  }

  private currentAttachmentIds(): string[] {
    const row = this.state.storage.sql.exec<{ attachment_ids_json: string }>(
      `SELECT metadata.attachment_ids_json
         FROM automation_draft_message_metadata metadata
         JOIN participant_transcript_turns turn ON turn.turn_id = metadata.turn_id
        WHERE turn.actor = 'human'
        ORDER BY turn.transcript_sequence DESC LIMIT 1`,
    ).toArray()[0];
    return row ? JSON.parse(row.attachment_ids_json) as string[] : [];
  }

  private transcript(): ParticipantTranscriptStore {
    return new ParticipantTranscriptStore(this.state.storage.sql);
  }

  private currentDefinition(): AutomationDraft | null {
    const row = this.state.storage.sql.exec<{ definition_json: string }>(
      `SELECT definition_json FROM automation_definition_revisions
        ORDER BY definition_revision DESC LIMIT 1`,
    ).toArray()[0];
    return row ? AutomationDraftSchema.parse(JSON.parse(row.definition_json)) : null;
  }

  private eventSequence(): number {
    return this.state.storage.sql.exec<{ event_sequence: number }>(
      `SELECT event_sequence FROM automation_state WHERE id = 1`,
    ).toArray()[0]?.event_sequence ?? 0;
  }

  private appendRealtimeEvent(eventType: string, payload: unknown, now: number): number {
    const sequence = this.eventSequence() + 1;
    this.state.storage.sql.exec(
      `INSERT INTO automation_realtime_events
         (event_sequence, event_id, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      sequence,
      uuidV7(now),
      eventType,
      JSON.stringify(payload),
      now,
    );
    this.state.storage.sql.exec(
      `UPDATE automation_state SET event_sequence = ?, updated_at = ? WHERE id = 1`,
      sequence,
      now,
    );
    return sequence;
  }

  private broadcastLatestEvents(): void {
    const latest = this.eventSequence();
    for (const socket of this.state.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as { eventSequence?: number } | null;
      const after = attachment?.eventSequence ?? 0;
      const events = this.state.storage.sql.exec<{
        event_sequence: number;
        event_type: string;
        payload_json: string;
      }>(`SELECT event_sequence, event_type, payload_json
            FROM automation_realtime_events
           WHERE event_sequence > ? ORDER BY event_sequence`, after).toArray();
      try {
        for (const event of events) {
          socket.send(JSON.stringify({
            type: "event",
            eventSequence: event.event_sequence,
            eventType: event.event_type,
            payload: JSON.parse(event.payload_json),
          }));
        }
        socket.serializeAttachment({ ...(attachment ?? {}), eventSequence: latest });
      } catch {
        // Hibernating sockets are transport projections. The durable event log
        // remains the recovery source and reconnect supplies a fresh snapshot.
      }
    }
  }

  private snapshotUnchecked(): AutomationAgentSnapshot {
    const identity = this.identity();
    const state = this.state.storage.sql.exec<{
      lifecycle: string;
      title: string;
      definition_revision: number;
      event_sequence: number;
    }>(`SELECT lifecycle, title, definition_revision, event_sequence
          FROM automation_state WHERE id = 1`).toArray()[0]!;
    const messages = this.state.storage.sql.exec<{
      turn_id: string;
      transcript_sequence: number;
      actor: "human" | "assistant";
      author_user_id: string | null;
      client_message_id: string | null;
      payload_json: string;
      attachment_ids_json: string;
      created_at: number;
    }>(`SELECT turn.turn_id, turn.transcript_sequence, turn.actor, turn.author_user_id,
              metadata.client_message_id, payload.payload_json,
              metadata.attachment_ids_json, turn.created_at
          FROM participant_transcript_turns turn
          JOIN transcript_facts fact ON fact.fact_id = turn.root_fact_id
          JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
          JOIN automation_draft_message_metadata metadata ON metadata.turn_id = turn.turn_id
         WHERE turn.entry_kind = 'conversation'
         ORDER BY turn.transcript_sequence`).toArray();
    const elicitation = this.state.storage.sql.exec<{
      elicitation_id: string;
      definition_revision: number;
      payload_json: string;
    }>(`SELECT elicitation_id, definition_revision, payload_json
          FROM automation_pending_elicitations WHERE state = 'pending' LIMIT 1`).toArray()[0];
    const visibleCompilerRun = this.visibleCompilerRun();
    let narration = "";
    if (visibleCompilerRun) {
      // Filtered in SQL rather than in JS: every snapshot read and every
      // socket connect used to parse each delta this automation had ever
      // streamed, across all prior compiler runs, to rebuild one run's
      // narration.
      const streamEvents = this.state.storage.sql.exec<{ payload_json: string }>(
        `SELECT payload_json FROM automation_realtime_events
          WHERE event_type = 'compiler_stream'
            AND json_extract(payload_json, '$.runId') = ?
          ORDER BY event_sequence`,
        visibleCompilerRun.run_id,
      ).toArray();
      for (const row of streamEvents) {
        const payload = JSON.parse(row.payload_json) as { runId?: unknown; event?: unknown };
        if (!payload.event || typeof payload.event !== "object") continue;
        const event = payload.event as { type?: unknown; delta?: unknown; reset?: unknown };
        if (event.type === "started") narration = "";
        if (event.type === "delta" && typeof event.delta === "string") {
          narration = event.reset === true ? event.delta : narration + event.delta;
        }
      }
    }
    return AutomationAgentSnapshotSchema.parse({
      schemaVersion: 1,
      automationId: asAutomationId(identity.automation_id),
      workspaceId: asWorkspaceId(identity.workspace_id),
      authorUserId: asUserId(identity.author_user_id),
      region: identity.region,
      lifecycle: state.lifecycle,
      authorityGeneration: identity.authority_generation,
      title: state.title,
      definitionRevision: state.definition_revision,
      definition: this.currentDefinition(),
      messages: messages.map((message) => ({
        turnId: message.turn_id,
        transcriptSequence: message.transcript_sequence,
        role: message.actor === "assistant" ? "assistant" : "user",
        authorUserId: message.author_user_id,
        clientMessageId: message.client_message_id,
        content: String((JSON.parse(message.payload_json) as { content?: unknown }).content ?? ""),
        attachmentIds: JSON.parse(message.attachment_ids_json),
        createdAt: message.created_at,
      })),
      activeCompilerRun: visibleCompilerRun ? {
        id: visibleCompilerRun.run_id,
        state: visibleCompilerRun.state,
        admittedTurnId: visibleCompilerRun.admitted_turn_id,
        errorCode: visibleCompilerRun.error_code,
        errorMessage: visibleCompilerRun.error_message,
      } : null,
      compilerCheckpoint: visibleCompilerRun ? {
        runId: visibleCompilerRun.run_id,
        narration,
      } : null,
      pendingElicitation: elicitation ? {
        id: elicitation.elicitation_id,
        definitionRevision: elicitation.definition_revision,
        payload: JSON.parse(elicitation.payload_json),
      } : null,
      eventSequence: state.event_sequence,
    });
  }
}
