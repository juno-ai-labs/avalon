import type { Region } from "@rally/contracts/regions";
import { ConversationAuthorizationRequestSchema, type ConversationAuthorizationRequest } from '../services/authorization-policy';
import { z } from "zod";
import {
  AutomationDetailSchema,
  SidekickSkillSourceSchema,
  type SidekickSkillSource,
  AutomationDraftSchema,
  AutomationExecutionPrincipalClaimSchema,
  AutomationRunDefinitionV1Schema,
  AutomationRunSchema,
  AutomationSetEvaluatorRulesInputV1Schema,
  DemoSeedSchema,
  WorkstreamAppearanceSchema,
  WorkstreamAppearancePatchSchema,
  automationAcceptanceSelections,
  sidekickLoadable,
  sidekickReceivesEmail,
  automationDraftAcceptanceBlocker,
  asAutomationId,
  asHarnessRunId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  isExternalEventTrigger,
  type AutomationDetail,
  type AutomationDraft,
  type AutomationExecutionPrincipalClaim,
  type AutomationRun,
  type AutomationRunDefinitionV1,
  type AutomationRunTriggerV1,
  type AutomationScope,
  type DemoSeed,
  externalEventOccurrenceKey,
  withoutUnusableAutomationResourceIds,
} from "@rally/contracts";
import type {
  ConversationEffectEnvelope,
  ParentEffect,
} from "@rally/contracts/conversation-effects";
import {
  ConversationParentAuthorityRequestSchema,
  ConversationParentAuthorityResultSchema,
  ConversationParentAuthorizeViewerRequestSchema,
  ConversationParentAuthorizeViewerResultSchema,
  ConversationParentReserveChildRequestSchema,
  ConversationParentReserveChildResultSchema,
  type ConversationParentAuthorityRequest,
  type ConversationParentAuthorityResult,
  type ConversationParentAuthorizeViewerRequest,
  type ConversationParentAuthorizeViewerResult,
  type ConversationParentReserveChildRequest,
  type ConversationParentReserveChildResult,
} from "@rally/contracts/conversation-parent";

import type { Env } from "../env";
import {
  OBJECT_RETIREMENT_SCHEMA_STATEMENTS,
  applyRetirementGate,
  retiredObjectResponse,
} from "./object-retirement";
import { connectorActivityTriggerDescriptors, storedConnectionScope } from "../lib/connector-activity-triggers";
import { ApiError } from "../lib/api-error";
import { externalEventOpening } from "../lib/external-event-opening";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { sha256 } from "../lib/crypto";
import { assertDurableObjectJurisdiction, durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { withDurableObjectSelf } from "../lib/durable-object-self";
import { nextRRuleOccurrence } from "../lib/recurrence";
import { uuidV7 } from "../lib/uuid-v7";
import { createHarnessRunObjectPort } from "../runtime/harness-run-port";
import { createMessageObjectPort } from "../runtime/message-port";
import { automationModelOverride, scheduledWorkstreamModel } from "../services/agent-model-flags";
import { validateDraftEvaluatorRules } from "../services/external-event-evaluator";
import { activateWorkstreamLoop } from "../services/integrations";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import { materializeAutomationMemoryTables } from "../services/memory-table-service";
import { WorkstreamEmailRoutingService } from "../services/workstream-email-routing-service";
import { attachWorkstreamRuntimeResource } from "../services/workstream-object-client";
import {
  bootstrapConversationChildRuntime,
  provisionWorkstreamObject,
} from "../services/workstream-runtime-database";
import {
  SidekickSkillReadRequestSchema,
  type SidekickSkillReadRequest,
  AUTOMATION_RUN_ALARM_KIND,
  AUTOMATION_SCHEDULE_ALARM_KIND,
  AutomationActorSchema,
  AutomationActorRequestSchema,
  AutomationCreateRequestSchema,
  AutomationExternalEventAdmissionSchema,
  AutomationInboundEmailAdmissionSchema,
  AutomationOwningRoomArchivedRequestSchema,
  AutomationRunNowRequestSchema,
  AutomationRunRequestSchema,
  AutomationRunSeededRequestSchema,
  AutomationSetAppearanceRequestSchema,
  AutomationSubmitDefinitionRequestSchema,
  type AutomationActor,
  type AutomationActorRequest,
  type AutomationCreateRequest,
  type AutomationExternalEventAdmission,
  type AutomationInboundEmailAdmission,
  type AutomationOwningRoomArchivedRequest,
  type AutomationRunNowRequest,
  type AutomationRunRequest,
  type AutomationRunSeededRequest,
  type AutomationSetAppearanceRequest,
  type AutomationSubmitDefinitionRequest,
} from "./automation-do-protocol";
import {
  CONVERSATION_PARENT_SCHEMA_STATEMENTS,
  ConversationParentDurableObject,
  type ConversationParentIdentity,
  type DirectoryCommonEffect,
} from "./conversation-parent-object";
import type { DurableObjectMigrationPlan } from "./migratable-durable-object";
import { automationDOName, substreamLoopId, workspaceDOName } from "./names";
import { reportScheduledAlarmAttempt } from "./scheduled-alarm-report";
import {
  SCHEDULED_ALARM_SCHEMA_STATEMENTS,
  type ScheduledAlarm,
  type ScheduledAlarmOutcome,
} from "./scheduled-alarms";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";

/**
 * `SidekickDO` owns a Sidekick and its authoring and run conversations.
 *
 * Substream `0` is the automation's conversation for its whole life: drafting,
 * Create, and every later edit happen there, with the `rally:sidekicks`
 * plugin preloaded. Each run is a child substream under the automation; it
 * reads its definition from here by revision and reports state through the
 * same child-effect path every substream uses. Nothing a child says leaves
 * this object: an automation's children produce no workspace activity and no
 * notifications, and the only thing the workspace hears is this object's own
 * sidebar row.
 *
 * There are no authority-generation fences on an automation. Pausing or
 * deleting marks the run rows, and a run that outlived its consent finds out
 * when it next asks `readRunState` before a provider write.
 */

const MIGRATION_COMPONENT = "automation_do";

/**
 * What a child conversation's state says about the run inside it.
 *
 * `null` marks a state that describes the conversation rather than the run,
 * where the honest answer is to leave the run's own state alone.
 */
const RUN_STATE_FROM_CONVERSATION_STATE: Record<string, RunState | null> = {
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
};
const TERMINAL_RUN_STATES = new Set<RunState>(["completed", "failed", "stopped"]);

type RunState = "pending" | "running" | "needs_input" | "completed" | "failed" | "stopped";
type Lifecycle = "draft" | "active" | "paused" | "deleted";

interface AutomationRow extends Record<string, SqlStorageValue> {
  registration_generation: number;
  automation_id: string;
  workspace_id: string;
  region: Region;
  author_user_id: string;
  run_as_user_id: string;
  lifecycle: Lifecycle;
  paused_by: "person" | "room_archive" | null;
  scope: AutomationScope;
  owning_workstream_id: string | null;
  owning_room_archived_at: number | null;
  title: string;
  description: string;
  current_definition_revision: number;
  accepted_definition_revision: number | null;
  connector_bindings_json: string;
  default_plugin_ids_json: string;
  activity_source_plugin_ids_json: string;
  evaluator_projection_json: string;
  model_override: string | null;
  email_address: string | null;
  effective_after_event_sequence: number | null;
  /**
   * The revision whose post-transaction effects (schedule alarms, workspace
   * registrations, declared memory tables) are known to have landed. Set
   * last, so a failure between the accepted-revision write and here leaves
   * it behind and the next apply re-runs the tail instead of answering that
   * nothing needs doing.
   */
  applied_effects_revision: number | null;
  loadable: number;
  /** The chosen icon and colour as `WorkstreamAppearance` JSON; null until picked. */
  appearance_json: string | null;
  authority_generation: number;
  created_at: number;
  updated_at: number;
}

interface RevisionRow extends Record<string, SqlStorageValue> {
  definition_revision: number;
  definition_json: string;
  evaluator_rules_json: string | null;
  ready: number;
  created_at: number;
}

interface ScheduleRow extends Record<string, SqlStorageValue> {
  schedule_id: string;
  schedule_kind: "calendar" | "interval";
  definition_json: string;
  next_due_at: number | null;
}

interface RunRow extends Record<string, SqlStorageValue> {
  run_id: string;
  occurrence_key: string;
  trigger_json: string;
  definition_revision: number;
  harness_run_id: string;
  state: RunState;
  summary: string | null;
  opening_json: string | null;
  /** A demo seed's script for this run's model bytes; null for every other run. */
  seed_json: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  updated_at: number;
}

interface ScheduleDefinition {
  acceptedAt: number;
  intervalSeconds?: number;
  rrule?: string;
  timezone?: string;
}

export const AUTOMATION_DO_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "an automation, its definition revisions, schedules, runs, and the shared parent tables",
  statements: [
    `PRAGMA foreign_keys = ON`,
    `CREATE TABLE automation (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      automation_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      author_user_id TEXT NOT NULL,
      run_as_user_id TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'active', 'paused', 'deleted')),
      paused_by TEXT CHECK (paused_by IS NULL OR paused_by IN ('person', 'room_archive')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace', 'workstream')),
      owning_workstream_id TEXT,
      owning_room_archived_at INTEGER CHECK (owning_room_archived_at IS NULL OR owning_room_archived_at >= 0),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      current_definition_revision INTEGER NOT NULL CHECK (current_definition_revision >= 0),
      accepted_definition_revision INTEGER
        CHECK (accepted_definition_revision IS NULL OR accepted_definition_revision > 0),
      connector_bindings_json TEXT NOT NULL CHECK (json_valid(connector_bindings_json)),
      default_plugin_ids_json TEXT NOT NULL CHECK (json_valid(default_plugin_ids_json)),
      activity_source_plugin_ids_json TEXT NOT NULL CHECK (json_valid(activity_source_plugin_ids_json)),
      evaluator_projection_json TEXT NOT NULL CHECK (json_valid(evaluator_projection_json)),
      model_override TEXT,
      email_address TEXT COLLATE NOCASE,
      effective_after_event_sequence INTEGER,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK ((scope = 'workstream') = (owning_workstream_id IS NOT NULL))
    ) STRICT`,
    `CREATE TABLE definition_revisions (
      definition_revision INTEGER PRIMARY KEY CHECK (definition_revision > 0),
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
      definition_hash TEXT NOT NULL,
      evaluator_rules_json TEXT CHECK (evaluator_rules_json IS NULL OR json_valid(evaluator_rules_json)),
      ready INTEGER NOT NULL CHECK (ready IN (0, 1)),
      submitted_by_run_id TEXT,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE schedules (
      schedule_id TEXT PRIMARY KEY,
      definition_revision INTEGER NOT NULL,
      schedule_kind TEXT NOT NULL CHECK (schedule_kind IN ('calendar', 'interval')),
      definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
      next_due_at INTEGER CHECK (next_due_at IS NULL OR next_due_at >= 0),
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE runs (
      run_id TEXT PRIMARY KEY,
      occurrence_key TEXT NOT NULL UNIQUE,
      trigger_json TEXT NOT NULL CHECK (json_valid(trigger_json)),
      definition_revision INTEGER NOT NULL CHECK (definition_revision > 0),
      harness_run_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'needs_input', 'completed', 'failed', 'stopped')),
      summary TEXT,
      opening_json TEXT CHECK (opening_json IS NULL OR json_valid(opening_json)),
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX runs_history_idx ON runs(created_at DESC, run_id)`,
    `CREATE TABLE inbound_email_receipts (
      resend_email_id TEXT PRIMARY KEY,
      run_id TEXT,
      outcome_code TEXT NOT NULL,
      payload_ref TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      received_at INTEGER NOT NULL
    ) STRICT`,
    ...CONVERSATION_PARENT_SCHEMA_STATEMENTS,
    ...SCHEDULED_ALARM_SCHEMA_STATEMENTS,
  ],
}, {
  version: 2,
  description: "which revision's apply effects landed, so a replayed apply reconciles instead of returning",
  statements: [
    `ALTER TABLE automation ADD COLUMN applied_effects_revision INTEGER`,
  ],
}, {
  version: 3,
  description: "stored Sidekick loading capability, independent of lifecycle and authorization",
  statements: [
    `ALTER TABLE automation ADD COLUMN loadable INTEGER NOT NULL DEFAULT 0 CHECK (loadable IN (0, 1))`,
    // Every legacy accepted definition implicitly permits email execution.
    // It therefore remains non-loadable without rewriting its immutable revision.
  ],
}, {
  version: 4,
  description: "fence external registration effects across publication and lifecycle changes",
  statements: [`ALTER TABLE automation ADD COLUMN registration_generation INTEGER NOT NULL DEFAULT 0`],
}, {
  version: 5,
  description: "record a permanent retirement tombstone",
  statements: [
    // A retired workspace never reopens, and the fence in front of every
    // method here reads this table. It lives in the object rather than D1
    // because the gate answers during constructor recovery, before anything
    // else this object could consult is admitted.
    ...OBJECT_RETIREMENT_SCHEMA_STATEMENTS,
  ],
}, {
  version: 6,
  description: "where a scripted run's model bytes come from",
  statements: [
    // Null on every run but a seeded one, which is every run in production:
    // only `runSeeded` writes it, and only a demo's seeder calls that. It is a
    // run-scoped fact, so it lives on the run rather than on the definition or
    // the schedule, and `provisionRun` hands it to the loop the same way it
    // hands over the trigger.
    `ALTER TABLE runs ADD COLUMN seed_json TEXT CHECK (seed_json IS NULL OR json_valid(seed_json))`,
  ],
}, {
  version: 7,
  description: "the Sidekick's chosen icon and colour",
  statements: [
    // Null means nobody has chosen, which is not the same as choosing the
    // default: the mark derived from the automation's id is what a null
    // renders, and it moves if the catalog is ever reordered. A stored value
    // is a person's decision and never moves.
    `ALTER TABLE automation ADD COLUMN appearance_json TEXT
       CHECK (appearance_json IS NULL OR json_valid(appearance_json))`,
  ],
}, { version: 8, description: "allow configured deployment identifiers", statements: [
  "PRAGMA defer_foreign_keys = ON",
  "CREATE TABLE \"_region_copy_automation\" AS SELECT * FROM \"automation\"",
  "DELETE FROM \"automation\"",
  "DROP TABLE \"automation\"",
  "CREATE TABLE automation (\n      id INTEGER PRIMARY KEY CHECK (id = 1),\n      automation_id TEXT NOT NULL UNIQUE,\n      workspace_id TEXT NOT NULL,\n      region TEXT NOT NULL,\n      author_user_id TEXT NOT NULL,\n      run_as_user_id TEXT NOT NULL,\n      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'active', 'paused', 'deleted')),\n      paused_by TEXT CHECK (paused_by IS NULL OR paused_by IN ('person', 'room_archive')),\n      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace', 'workstream')),\n      owning_workstream_id TEXT,\n      owning_room_archived_at INTEGER CHECK (owning_room_archived_at IS NULL OR owning_room_archived_at >= 0),\n      title TEXT NOT NULL,\n      description TEXT NOT NULL,\n      current_definition_revision INTEGER NOT NULL CHECK (current_definition_revision >= 0),\n      accepted_definition_revision INTEGER\n        CHECK (accepted_definition_revision IS NULL OR accepted_definition_revision > 0),\n      connector_bindings_json TEXT NOT NULL CHECK (json_valid(connector_bindings_json)),\n      default_plugin_ids_json TEXT NOT NULL CHECK (json_valid(default_plugin_ids_json)),\n      activity_source_plugin_ids_json TEXT NOT NULL CHECK (json_valid(activity_source_plugin_ids_json)),\n      evaluator_projection_json TEXT NOT NULL CHECK (json_valid(evaluator_projection_json)),\n      model_override TEXT,\n      email_address TEXT COLLATE NOCASE,\n      effective_after_event_sequence INTEGER,\n      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL, applied_effects_revision INTEGER, loadable INTEGER NOT NULL DEFAULT 0 CHECK (loadable IN (0, 1)), registration_generation INTEGER NOT NULL DEFAULT 0, appearance_json TEXT\n       CHECK (appearance_json IS NULL OR json_valid(appearance_json)),\n      CHECK ((scope = 'workstream') = (owning_workstream_id IS NOT NULL))\n    ) STRICT",
  "INSERT INTO \"automation\" SELECT * FROM \"_region_copy_automation\"",
  "DROP TABLE \"_region_copy_automation\"",
  "PRAGMA defer_foreign_keys = OFF"
]
}];

function first<T extends Record<string, SqlStorageValue>>(cursor: SqlStorageCursor<T>): T | null {
  return cursor.toArray()[0] ?? null;
}

function iso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function forbidden(): ApiError {
  return new ApiError(403, "sidekick_forbidden", "You cannot manage this Sidekick");
}

function scheduleDueAfter(kind: "calendar" | "interval", definitionJson: string, after: number): number | null {
  const definition = JSON.parse(definitionJson) as ScheduleDefinition;
  if (kind === "interval") return after + definition.intervalSeconds! * 1_000;
  return nextRRuleOccurrence(
    definition.rrule!,
    definition.timezone!,
    new Date(definition.acceptedAt),
    new Date(after),
  )?.getTime() ?? null;
}

export class SidekickDO extends ConversationParentDurableObject {
  private readonly state: DurableObjectState;
  private objectName: string | null = null;
  private readonly initialized: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    this.env = env = withDurableObjectSelf(env, {
      namespace: env.AUTOMATION_DOS,
      name: () => this.selfObjectName(),
      id: state.id,
      instance: this,
    });
    this.initialized = this.initializeDurableObject(async () => {
      await this.applyMigrations(() => applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: AUTOMATION_DO_SCHEMA_MIGRATIONS,
        component: MIGRATION_COMPONENT,
        workerVersionId: env.APP_VERSION ?? "unknown",
        afterMigrations: (_sql, versions) => {
          if (versions.includes(3) && this.row()) this.enqueueDirectory(Date.now());
        },
      }));
      await this.armNextAlarm();
    });
  }

  protected override migrationPlan(): DurableObjectMigrationPlan {
    return {
      component: MIGRATION_COMPONENT,
      className: "SidekickDO",
      migrations: AUTOMATION_DO_SCHEMA_MIGRATIONS,
    };
  }

  protected override migrationsReady(): Promise<void> {
    return this.initialized;
  }

  private selfObjectName(): string | null {
    if (this.objectName !== null) return this.objectName;
    let row: { workspace_id: string; automation_id: string } | null;
    try {
      row = first(this.state.storage.sql.exec<{ workspace_id: string; automation_id: string }>(
        `SELECT workspace_id, automation_id FROM automation WHERE id = 1`,
      ));
    } catch {
      return null;
    }
    if (!row) return null;
    this.objectName = automationDOName(
      this.env.AVALON_REGION,
      asWorkspaceId(row.workspace_id),
      asAutomationId(row.automation_id),
    );
    return this.objectName;
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/health") {
      return Response.json({ ok: true, role: "automation", databaseBytes: this.state.storage.sql.databaseSize });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  // ---------------------------------------------------------------------------
  // The automation itself.
  // ---------------------------------------------------------------------------

  /** Bring the automation into existence, in draft, with its conversation reserved. */
  async create(input: AutomationCreateRequest): Promise<{ created: boolean }> {
    await this.initialized;
    const request = AutomationCreateRequestSchema.parse(input);
    const existing = this.row();
    if (existing) {
      this.assertAutomation(request.workspaceId, request.automationId);
      return { created: false };
    }
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `INSERT INTO automation
           (id, automation_id, workspace_id, region, author_user_id, run_as_user_id, lifecycle,
            paused_by, scope, owning_workstream_id, owning_room_archived_at, title, description,
            current_definition_revision, accepted_definition_revision, connector_bindings_json,
            default_plugin_ids_json, activity_source_plugin_ids_json, evaluator_projection_json,
            model_override, email_address, effective_after_event_sequence, authority_generation,
            created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?, NULL, '', '', 0, NULL, '{}', '[]', '{}', '[]',
                 NULL, NULL, NULL, ?, ?, ?)`,
        request.automationId,
        request.workspaceId,
        this.env.AVALON_REGION,
        request.authorUserId,
        request.authorUserId,
        request.scope,
        request.owningWorkstreamId,
        request.authorityGeneration,
        now,
        now,
      );
      this.registerChild("0", "main", request.authorUserId, now);
      this.enqueueDirectory(now);
    });
    await this.armNextAlarm();
    return { created: true };
  }

  /**
   * Record what the conversation drafted: a new immutable revision.
   *
   * The title and description follow the latest draft so the sidebar row names
   * it. Scope follows the draft only while the automation is still a draft and
   * only between the two scopes a sidebar automation may take; a room's
   * automation is the room's from the start and stays so.
   */
  async saveDefinition(input: AutomationSubmitDefinitionRequest & { actor: AutomationActor }): Promise<{ definitionRevision: number; ready: boolean }> {
    await this.initialized;
    const { actor: rawActor, ...definitionInput } = input;
    const request = AutomationSubmitDefinitionRequestSchema.parse(definitionInput);
    const actor = AutomationActorSchema.parse(rawActor);
    this.assertManager(this.assertAutomation(request.workspaceId, request.automationId), actor);
    const submitted = await this.submitDefinition(request);
    if (submitted.ready) await this.apply({ workspaceId: request.workspaceId, automationId: request.automationId, actor });
    return submitted;
  }

  async submitDefinition(input: AutomationSubmitDefinitionRequest): Promise<{
    definitionRevision: number;
    ready: boolean;
  }> {
    await this.initialized;
    const request = AutomationSubmitDefinitionRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    if (row.lifecycle === "deleted") throw new ApiError(404, "sidekick_not_found", "This Sidekick was archived");
    const definitionJson = JSON.stringify(request.draft);
    const definitionHash = await sha256(definitionJson);
    const now = Date.now();
    const revision = this.state.storage.transactionSync(() => {
      const latest = this.assertAutomation(request.workspaceId, request.automationId);
      if (latest.lifecycle === "deleted") throw new ApiError(404, "sidekick_not_found", "This Sidekick was archived");
      const definitionRevision = latest.current_definition_revision + 1;
      this.state.storage.sql.exec(
        `INSERT INTO definition_revisions
           (definition_revision, definition_json, definition_hash, evaluator_rules_json, ready,
            submitted_by_run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        definitionRevision,
        definitionJson,
        definitionHash,
        request.evaluatorRules ? JSON.stringify(request.evaluatorRules) : null,
        request.draft.ready ? 1 : 0,
        request.submittedByRunId,
        now,
      );
      const scope = latest.lifecycle === "draft" && latest.scope !== "workstream" && request.draft.suggestedScope !== "workstream"
        ? request.draft.suggestedScope
        : latest.scope;
      this.state.storage.sql.exec(
        `UPDATE automation
            SET current_definition_revision = ?, title = ?, description = ?, scope = ?, updated_at = ?
          WHERE id = 1`,
        definitionRevision,
        request.draft.name,
        request.draft.description,
        scope,
        now,
      );
      this.enqueueDirectory(now);
      return definitionRevision;
    });
    await this.armNextAlarm();
    return { definitionRevision: revision, ready: request.draft.ready };
  }

  /**
   * Make the current ready revision the one that runs.
   *
   * Everything read from outside (connections, the person's timezone, the
   * email route) happens first; then one transaction replaces the schedules
   * and moves the lifecycle; then the tail: schedule alarms, the workspace's
   * registrations, and the declared memory tables, each idempotent. The tail
   * is recorded as done in `applied_effects_revision` only at its end, so a
   * failure anywhere in it is repaired by applying again: the replay guard
   * reads that marker, not the accepted revision, which the transaction wrote
   * before the tail ran.
   *
   * A paused automation is not applied to. Room-archive paused it so the
   * archive holds, and `resume` is what lifts a pause; applying here used to
   * set `lifecycle = 'active'` regardless and so resumed an automation whose
   * room was archived, with its schedules and connector writes, while the one
   * place its result could go stayed refused.
   */
  async apply(input: AutomationActorRequest): Promise<AutomationDetail> {
    await this.initialized;
    const request = AutomationActorRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    if (row.lifecycle === "deleted") throw new ApiError(404, "sidekick_not_found", "This Sidekick was archived");
    this.assertManager(row, request.actor);
    if (row.owning_room_archived_at !== null) {
      throw new ApiError(409, "sidekick_room_archived", "The work stream that owns this Sidekick is archived");
    }
    const revision = this.revision(row.current_definition_revision);
    if (!revision || revision.ready !== 1) {
      throw new ApiError(422, "sidekick_definition_not_ready", "The Sidekick's definition is not ready to apply");
    }
    if (
      row.lifecycle === "active"
      && row.accepted_definition_revision === revision.definition_revision
      && row.applied_effects_revision === revision.definition_revision
    ) {
      return this.detail();
    }
    const definition = AutomationDraftSchema.parse(JSON.parse(revision.definition_json));
    const prepared = definition.triggers.length === 0
      ? { selections: { defaultPluginIds: [], activitySourcePluginIds: {} }, connectorBindings: {}, evaluators: [], schedules: [] }
      : await this.prepareApplication(row, revision, definition, request.actor.userId);
    const emailRoute = sidekickReceivesEmail(definition) ? await new WorkstreamEmailRoutingService(this.env).reserveAutomation({
      region: row.region,
      workspaceId: row.workspace_id,
      automationSubscriptionId: row.automation_id,
    }) : { emailAddress: row.email_address };
    const now = Date.now();
    const previousSchedules = this.schedules().map((schedule) => schedule.schedule_id);
    this.state.storage.transactionSync(() => {
      const current = this.row();
      if (!current || current.current_definition_revision !== revision.definition_revision
        || current.lifecycle !== row.lifecycle || current.run_as_user_id !== row.run_as_user_id
        || current.scope !== row.scope || current.owning_room_archived_at !== row.owning_room_archived_at) {
        throw new ApiError(409, "sidekick_revision_changed", "The Sidekick changed while saving; retry the latest revision");
      }
      this.state.storage.sql.exec(`DELETE FROM schedules`);
      for (const schedule of prepared.schedules) {
        this.state.storage.sql.exec(
          `INSERT INTO schedules
             (schedule_id, definition_revision, schedule_kind, definition_json, next_due_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          schedule.id,
          revision.definition_revision,
          schedule.kind,
          JSON.stringify(schedule.definition),
          schedule.nextDueAt,
          now,
        );
      }
      this.state.storage.sql.exec(
        `UPDATE automation
            SET lifecycle = CASE WHEN lifecycle = 'paused' THEN 'paused' ELSE 'active' END, effective_after_event_sequence = NULL, accepted_definition_revision = ?,
                connector_bindings_json = ?, default_plugin_ids_json = ?,
                activity_source_plugin_ids_json = ?, evaluator_projection_json = ?,
                email_address = ?, loadable = ?, updated_at = ?
          WHERE id = 1`,
        revision.definition_revision,
        JSON.stringify(prepared.connectorBindings),
        JSON.stringify(prepared.selections.defaultPluginIds),
        JSON.stringify(prepared.selections.activitySourcePluginIds),
        JSON.stringify(prepared.evaluators),
        emailRoute.emailAddress,
        sidekickLoadable(definition) ? 1 : 0,
        now,
      );
      this.enqueueDirectory(now);
      this.scheduledAlarms.schedule({ kind: "sidekick_publication", key: String(revision.definition_revision), dueAt: now });
    });
    await this.armNextAlarm();
    await this.applyEffects(this.row()!, revision.definition_revision, definition, previousSchedules, prepared);
    if (this.row()?.applied_effects_revision === revision.definition_revision) {
      await this.cancelScheduledAlarm("sidekick_publication", String(revision.definition_revision));
    }
    return this.detail();
  }

  /**
   * The tail of an apply, run again by the next apply until it has all landed.
   *
   * `previousSchedules` are whatever schedule ids existed before this call:
   * on a replay the table already holds the new revision's, so cancelling
   * them and arming them again is one idempotent pass.
   */
  private async applyEffects(
    row: AutomationRow,
    definitionRevision: number,
    definition: AutomationDraft,
    previousSchedules: readonly string[],
    prepared: Pick<Awaited<ReturnType<typeof this.prepareApplication>>, "schedules" | "evaluators">,
  ): Promise<void> {
    await Promise.all(previousSchedules.map((scheduleId) => (
      this.cancelScheduledAlarm(AUTOMATION_SCHEDULE_ALARM_KIND, scheduleId)
    )));
    for (const schedule of row.lifecycle === "paused" ? [] : prepared.schedules) {
      await this.scheduleAlarm({ kind: AUTOMATION_SCHEDULE_ALARM_KIND, key: schedule.id, dueAt: schedule.nextDueAt });
    }
    if (row.accepted_definition_revision !== definitionRevision) return;
    await this.replaceRegistrations(row.lifecycle === "paused" ? [] : prepared.evaluators, row);
    if (definition.triggers.length > 0) await materializeAutomationMemoryTables(this.env, {
      workspaceId: row.workspace_id,
      automationId: row.automation_id,
      definitionRevision,
      runAsUserId: row.run_as_user_id,
      tables: definition.memoryTables,
    });
    const current = this.row();
    if (current?.accepted_definition_revision === definitionRevision && current.lifecycle === row.lifecycle && current.registration_generation === row.registration_generation) {
      this.state.storage.sql.exec(
        `UPDATE automation SET applied_effects_revision = ?, updated_at = ? WHERE id = 1`,
        definitionRevision, Date.now(),
      );
    } else if (current && current.lifecycle !== "deleted" && current.accepted_definition_revision !== null) {
      // An older asynchronous tail must not claim a newer publication's effects.
      // Reconcile the current accepted setup even if its earlier tail finished first.
      this.state.storage.transactionSync(() => {
        this.state.storage.sql.exec(`UPDATE automation SET applied_effects_revision = NULL WHERE id = 1`);
        this.scheduledAlarms.schedule({ kind: "sidekick_publication", key: String(current.accepted_definition_revision), dueAt: Date.now() });
      });
    }
    await this.armNextAlarm();
  }

  /** Explicit object-owned reconciliation when the loading policy changes. */
  async reconcileLoadable(input: AutomationActorRequest): Promise<{ loadable: boolean }> {
    await this.initialized;
    const request = AutomationActorRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    this.assertManager(row, request.actor);
    const revision = row.accepted_definition_revision === null ? null : this.revision(row.accepted_definition_revision);
    const definition = revision ? AutomationDraftSchema.parse(JSON.parse(revision.definition_json)) : null;
    // Legacy email is effective trigger configuration even when absent in JSON.
    const loadable = definition !== null && sidekickLoadable(definition);
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(`UPDATE automation SET loadable = ? WHERE id = 1`, loadable ? 1 : 0);
      this.enqueueDirectory(Date.now());
    });
    await this.armNextAlarm();
    return { loadable };
  }

  /**
   * Choose the Sidekick's icon or colour.
   *
   * A parent-owned mutation, so it arrives over REST rather than on the
   * authoring conversation's socket: this object owns the Sidekick's identity
   * the way it owns its name and lifecycle, and the conversation underneath is
   * a child that happens to be open. Everyone else finds out the way they find
   * out about a rename — through the directory row this enqueues, which
   * WorkspaceDO pushes to every connected client.
   *
   * The patch merges over what is stored, so a colour choice cannot undo
   * somebody's icon; the caller gets the merged value back, which is the whole
   * detail rather than a receipt, so the person who picked never has to wait
   * for the projection to come back round.
   */
  async setAppearance(input: AutomationSetAppearanceRequest): Promise<AutomationDetail> {
    await this.initialized;
    const request = AutomationSetAppearanceRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    this.assertManager(row, request.actor);
    if (row.lifecycle === "deleted") throw new ApiError(404, "sidekick_not_found", "This Sidekick was archived");
    const patch = WorkstreamAppearancePatchSchema.parse(request.appearance);
    const current = row.appearance_json
      ? WorkstreamAppearanceSchema.parse(JSON.parse(row.appearance_json))
      : { icon: null, color: null };
    const appearance = WorkstreamAppearanceSchema.parse({ ...current, ...patch });
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `UPDATE automation SET appearance_json = ?, updated_at = ? WHERE id = 1`,
        JSON.stringify(appearance),
        now,
      );
      this.enqueueDirectory(now);
    });
    await this.armNextAlarm();
    return this.detail();
  }

  async pause(input: AutomationActorRequest): Promise<void> {
    await this.initialized;
    const request = AutomationActorRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    this.assertManager(row, request.actor);
    if (row.lifecycle === "paused") return;
    if (row.lifecycle !== "active") throw new ApiError(409, "sidekick_not_active", "Only an active Sidekick can be paused");
    await this.pauseBy(row, "person");
  }

  async resume(input: AutomationActorRequest): Promise<void> {
    await this.initialized;
    const request = AutomationActorRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    this.assertManager(row, request.actor);
    if (row.lifecycle === "active") return;
    if (row.lifecycle !== "paused") throw new ApiError(409, "sidekick_not_paused", "Only a paused Sidekick can be resumed");
    if (row.owning_room_archived_at !== null) {
      throw new ApiError(409, "sidekick_room_archived", "The work stream that owns this Sidekick is archived");
    }
    await this.resumeFromPause(row);
  }

  async remove(input: AutomationActorRequest): Promise<void> {
    await this.initialized;
    const request = AutomationActorRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    this.assertManager(row, request.actor);
    const now = Date.now();
    if (row.lifecycle === "deleted") {
      // Already gone here; say so to the workspace again. The directory row
      // is the one thing a lost queue message can leave behind, and a repeat
      // delete is the natural way to ask for it to be cleared.
      this.state.storage.transactionSync(() => this.enqueueDirectory(now));
      await this.armNextAlarm();
      return;
    }
    const schedules = this.schedules().map((schedule) => schedule.schedule_id);
    this.state.storage.transactionSync(() => {
      this.stopOpenRuns(now);
      this.state.storage.sql.exec(
        `UPDATE automation SET lifecycle = 'deleted', updated_at = ? WHERE id = 1`,
        now,
      );
      this.enqueueDirectory(now);
    });
    await Promise.all(schedules.map((scheduleId) => (
      this.cancelScheduledAlarm(AUTOMATION_SCHEDULE_ALARM_KIND, scheduleId)
    )));
    await this.cancelScheduledAlarmKind(AUTOMATION_RUN_ALARM_KIND);
    if (row.lifecycle === "active") await this.replaceRegistrations([]);
    await this.armNextAlarm();
  }

  /**
   * Archiving a room pauses the automations it owns; unarchiving resumes the
   * ones the archive paused and no other. `paused_by` is why: an automation a
   * person paused before the archive must not come back because somebody
   * unarchived the room.
   */
  async setOwningRoomArchived(input: AutomationOwningRoomArchivedRequest): Promise<{
    changed: boolean;
    outcomeCode: string;
  }> {
    await this.initialized;
    const request = AutomationOwningRoomArchivedRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    if (row.owning_workstream_id !== request.workstreamId) {
      return { changed: false, outcomeCode: "sidekick_not_owned_by_workstream" };
    }
    const now = Date.now();
    if (request.archived) {
      if (row.owning_room_archived_at !== null) return { changed: false, outcomeCode: "sidekick_room_already_archived" };
      this.state.storage.sql.exec(
        `UPDATE automation SET owning_room_archived_at = ?, updated_at = ? WHERE id = 1`,
        now,
        now,
      );
      if (row.lifecycle === "active") {
        await this.pauseBy(this.row()!, "room_archive");
        return { changed: true, outcomeCode: "sidekick_paused" };
      }
      return { changed: true, outcomeCode: "sidekick_room_archived" };
    }
    if (row.owning_room_archived_at === null) return { changed: false, outcomeCode: "sidekick_room_not_archived" };
    this.state.storage.sql.exec(
      `UPDATE automation SET owning_room_archived_at = NULL, updated_at = ? WHERE id = 1`,
      now,
    );
    if (row.lifecycle === "paused" && row.paused_by === "room_archive") {
      await this.resumeFromPause(this.row()!);
      return { changed: true, outcomeCode: "sidekick_resumed" };
    }
    return { changed: true, outcomeCode: "sidekick_room_unarchived" };
  }

  async runNow(input: AutomationRunNowRequest): Promise<{ runId: string; reused: boolean }> {
    await this.initialized;
    const request = AutomationRunNowRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    this.assertManager(row, request.actor);
    if (row.lifecycle !== "active") throw new ApiError(409, "sidekick_not_active", "Only an active Sidekick can run");
    const accepted = row.accepted_definition_revision === null ? null : this.revision(row.accepted_definition_revision);
    const definition = accepted ? AutomationDraftSchema.parse(JSON.parse(accepted.definition_json)) : null;
    if (!definition || (definition.triggers.length === 0 && !sidekickReceivesEmail(definition))) {
      throw new ApiError(409, "sidekick_not_runnable", "Use this Sidekick in a conversation");
    }
    const admitted = await this.admitOccurrence(
      `manual:${request.idempotencyKey}`,
      { kind: "manual", requestedByUserId: asUserId(request.actor.userId) },
      null,
    );
    return { runId: admitted.runId, reused: admitted.reused };
  }

  /**
   * Run once from a script instead of from a model.
   *
   * A demo workspace is seeded with a Sidekick that has already produced one
   * briefing, and that briefing is produced by an ordinary run: the same
   * admission, provisioning, Bind loop, tool surface and settlement as a run
   * somebody starts by hand. The only thing the seed replaces is where the
   * model's bytes come from, and it replaces it exactly where a seeded message
   * does — the run's execution context, read by the harness.
   *
   * Separate from `runNow` rather than an optional field on it, because
   * `runNow` is what `POST /sidekicks/:id/run` reaches: a seed on that request
   * shape would be one deserialization away from letting a member script their
   * own Sidekick's output and keep the result as history. Nothing routes a
   * client body here. The trigger recorded is `manual` and names the author,
   * which is what actually happened; inventing a schedule occurrence the
   * schedule never fired would be the fabricated history this feature refuses
   * everywhere else. `docs/demo-workspaces.md` owns the seeding rules.
   */
  async runSeeded(input: AutomationRunSeededRequest): Promise<{ runId: string; reused: boolean }> {
    await this.initialized;
    const request = AutomationRunSeededRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    this.assertManager(row, request.actor);
    if (row.lifecycle !== "active") throw new ApiError(409, "sidekick_not_active", "Only an active Sidekick can run");
    if (request.seed.assistant === null) {
      throw new ApiError(422, "demo_seed_run_without_script", "A seeded run needs a turn to answer with");
    }
    const admitted = await this.admitOccurrence(
      `seed:${request.seed.packVersion}:${request.seed.actionId}`,
      { kind: "manual", requestedByUserId: asUserId(request.actor.userId) },
      null,
      request.seed,
    );
    return { runId: admitted.runId, reused: admitted.reused };
  }

  /** Admit one matched external event, once. */
  async admitExternalEvent(input: AutomationExternalEventAdmission): Promise<{
    admitted: boolean;
    outcomeCode: string;
  }> {
    await this.initialized;
    const request = AutomationExternalEventAdmissionSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    if (row.lifecycle !== "active") return { admitted: false, outcomeCode: `sidekick_${row.lifecycle}` };
    const revision = row.accepted_definition_revision === null ? null : this.revision(row.accepted_definition_revision);
    const definition = revision ? AutomationDraftSchema.parse(JSON.parse(revision.definition_json)) : null;
    if (definition?.definitionVersion === 2) {
      const sources = z.array(z.object({ evaluatorId: z.string(), source: z.object({ eventType: z.string() }) })).parse(JSON.parse(row.evaluator_projection_json));
      if (!definition.triggers.some(isExternalEventTrigger) || !sources.some((entry) => entry.evaluatorId === request.registrationId && entry.source.eventType === request.event.eventType)) {
        return { admitted: false, outcomeCode: "sidekick_trigger_removed" };
      }
    }
    if (row.effective_after_event_sequence === null
      || request.event.eventSequence <= row.effective_after_event_sequence) {
      return { admitted: false, outcomeCode: "sidekick_event_before_activation_boundary" };
    }
    const admitted = await this.admitOccurrence(externalEventOccurrenceKey(request.event), {
      kind: "external_event",
      workspaceEventId: request.event.id,
      eventType: request.event.eventType,
      occurredAt: request.event.occurredAt,
      payloadHash: request.payloadHash,
    }, externalEventOpening(request.event));
    return {
      admitted: true,
      outcomeCode: admitted.reused ? "sidekick_occurrence_replayed" : "sidekick_occurrence_admitted",
    };
  }

  /**
   * Admit one inbound email, once: the receipt is keyed by the provider's
   * message id, so a webhook retry answers from it. Lifecycle, address and
   * sender are decided here and nowhere else.
   */
  async admitInboundEmail(input: AutomationInboundEmailAdmission): Promise<{
    admitted: boolean;
    duplicate: boolean;
    outcomeCode: string;
    runId: string | null;
  }> {
    await this.initialized;
    const request = AutomationInboundEmailAdmissionSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    const existing = first(this.state.storage.sql.exec<{ run_id: string | null; outcome_code: string }>(
      `SELECT run_id, outcome_code FROM inbound_email_receipts WHERE resend_email_id = ?`,
      request.resendEmailId,
    ));
    if (existing) {
      return { admitted: existing.run_id !== null, duplicate: true, outcomeCode: existing.outcome_code, runId: existing.run_id };
    }
    const accepted = row.accepted_definition_revision === null ? null : this.revision(row.accepted_definition_revision);
    const emailEnabled = accepted !== null && sidekickReceivesEmail(AutomationDraftSchema.parse(JSON.parse(accepted.definition_json)));
    const refusal = row.lifecycle !== "active"
      ? "sidekick_not_active"
      : !emailEnabled || row.email_address === null || row.email_address.toLowerCase() !== request.emailAddress.toLowerCase()
        ? "sidekick_email_route_mismatch"
        : request.senderUserId === null
          || (row.scope === "personal"
            && request.senderUserId !== row.author_user_id
            && request.senderUserId !== row.run_as_user_id)
          ? "email_sender_not_authorized"
          : null;
    const now = Date.now();
    if (refusal) {
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO inbound_email_receipts
           (resend_email_id, run_id, outcome_code, payload_ref, resource_id, received_at)
         VALUES (?, NULL, ?, ?, ?, ?)`,
        request.resendEmailId,
        refusal,
        request.payloadRef,
        request.resourceId,
        request.receivedAt,
      );
      return { admitted: false, duplicate: false, outcomeCode: refusal, runId: null };
    }
    const admitted = await this.admitOccurrence(
      `inbound_email:${request.resendEmailId}`,
      { kind: "inbound_email", receiptId: uuidV7(now), occurredAt: request.receivedAt },
      {
        textContent: request.textContent,
        structuredContent: request.structuredContent,
        resourceId: request.resourceId,
      },
    );
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO inbound_email_receipts
         (resend_email_id, run_id, outcome_code, payload_ref, resource_id, received_at)
       VALUES (?, ?, 'admitted', ?, ?, ?)`,
      request.resendEmailId,
      admitted.runId,
      request.payloadRef,
      request.resourceId,
      request.receivedAt,
    );
    return { admitted: true, duplicate: admitted.reused, outcomeCode: "admitted", runId: admitted.runId };
  }

  /** What a run reads at start: its definition by revision, and how it was triggered. */
  async readSkillSource(input: SidekickSkillReadRequest): Promise<SidekickSkillSource | null> {
    await this.initialized;
    const request = SidekickSkillReadRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    if (row.lifecycle === "deleted" || row.accepted_definition_revision === null || row.owning_room_archived_at !== null) return null;
    if (!request.existingExecution && (row.lifecycle !== "active" || row.loadable !== 1)) return null;
    if (row.scope === "personal") {
      const allowed = new Set([row.author_user_id, row.run_as_user_id]);
      if (request.principalUserId === null || !allowed.has(request.principalUserId)
        || request.audienceScope === "workspace" || request.audienceUserIds.length === 0
        || request.audienceUserIds.some((id) => !allowed.has(id))) return null;
    }
    if (row.scope === "workstream" && request.conversationParentId !== row.owning_workstream_id) return null;
    const revision = this.revision(row.accepted_definition_revision);
    if (!revision) throw new Error("sidekick_accepted_revision_missing");
    const definition = AutomationDraftSchema.parse(JSON.parse(revision.definition_json));
    return SidekickSkillSourceSchema.parse({
      id: row.automation_id, revision: revision.definition_revision, loadable: row.loadable === 1,
      name: definition.name, description: definition.description,
      whenToUse: definition.whenToUse || definition.description, instructions: definition.instructions,
    });
  }

  async readRunDefinition(input: AutomationRunRequest): Promise<AutomationRunDefinitionV1> {
    await this.initialized;
    const request = AutomationRunRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    const run = this.run(request.runId);
    if (!run) throw new ApiError(404, "sidekick_run_not_found", "This run does not exist");
    const revision = this.revision(run.definition_revision);
    if (!revision) throw new ApiError(404, "sidekick_definition_not_found", "The run's definition revision is missing");
    const definition = AutomationDraftSchema.parse(JSON.parse(revision.definition_json));
    return AutomationRunDefinitionV1Schema.parse({
      schemaVersion: 1,
      automationId: row.automation_id,
      runId: run.run_id,
      definitionRevision: run.definition_revision,
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
      defaultPluginIds: JSON.parse(row.default_plugin_ids_json),
      activitySourcePluginIds: JSON.parse(row.activity_source_plugin_ids_json),
      connectorBindings: JSON.parse(row.connector_bindings_json),
      scope: row.scope,
      owningWorkstreamId: row.owning_workstream_id,
      runAsUserId: row.run_as_user_id,
      modelOverride: row.model_override,
      trigger: JSON.parse(run.trigger_json),
      opening: run.opening_json ? JSON.parse(run.opening_json) : null,
      state: run.state,
    });
  }

  /** Whether a run may still act: its own state, and the automation's. */
  async readRunState(input: AutomationRunRequest): Promise<{ state: RunState; lifecycle: Lifecycle } | null> {
    await this.initialized;
    const request = AutomationRunRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    const run = this.run(request.runId);
    return run ? { state: run.state, lifecycle: row.lifecycle } : null;
  }

  async readDetail(input: AutomationActorRequest): Promise<AutomationDetail> {
    await this.initialized;
    const request = AutomationActorRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    this.assertViewer(row, request.actor);
    return this.detail();
  }

  async listRuns(input: AutomationActorRequest): Promise<{ items: AutomationRun[] }> {
    await this.initialized;
    const request = AutomationActorRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    this.assertViewer(row, request.actor);
    return { items: this.runSummaries(50) };
  }

  /**
   * Take over who this automation runs as, and rebind what the last principal
   * took with them. The claimant is always the caller: a field naming
   * somebody else would let one person lend a colleague's credentials to a
   * standing automation.
   */
  async claimExecutionPrincipal(input: AutomationActorRequest): Promise<AutomationExecutionPrincipalClaim> {
    await this.initialized;
    const request = AutomationActorRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.automationId);
    this.assertManager(row, request.actor);
    const bindings = JSON.parse(row.connector_bindings_json) as Record<string, string>;
    const connections = await this.workspaceDatabase().prepare(
      `SELECT id, scope, owner_user_id, model_plugin_id, status
         FROM connector_connections WHERE workspace_id = ? AND status <> 'disabled'`,
    ).bind(row.workspace_id).all<{
      id: string;
      scope: string;
      owner_user_id: string | null;
      model_plugin_id: string;
      status: string;
    }>();
    const rows = connections.results ?? [];
    const byId = new Map(rows.map((connection) => [connection.id, connection]));
    const claimantByPlugin = new Map(rows
      .filter((connection) => connection.scope === "workspace" || connection.owner_user_id === request.actor.userId)
      .map((connection) => [connection.model_plugin_id, connection]));
    const rebound: string[] = [];
    const unbound: string[] = [];
    const next = { ...bindings };
    for (const [pluginId, connectionId] of Object.entries(bindings)) {
      const bound = byId.get(connectionId);
      if (bound && (bound.scope === "workspace" || bound.owner_user_id === request.actor.userId)) continue;
      const replacement = claimantByPlugin.get(pluginId);
      if (!replacement) {
        unbound.push(pluginId);
        continue;
      }
      next[pluginId] = replacement.id;
      rebound.push(pluginId);
    }
    const changed = row.run_as_user_id !== request.actor.userId || rebound.length > 0;
    if (changed) {
      this.state.storage.sql.exec(
        `UPDATE automation SET run_as_user_id = ?, connector_bindings_json = ?, updated_at = ? WHERE id = 1`,
        request.actor.userId,
        JSON.stringify(next),
        Date.now(),
      );
    }
    return AutomationExecutionPrincipalClaimSchema.parse({
      principalUserId: request.actor.userId,
      reboundPluginIds: rebound,
      unboundProviders: unbound,
      changed,
    });
  }

  // ---------------------------------------------------------------------------
  // The conversation-parent contract. `receiveChildEffects` and `listChildren`
  // are inherited.
  // ---------------------------------------------------------------------------

  async authorizeViewer(
    input: ConversationParentAuthorizeViewerRequest,
  ): Promise<ConversationParentAuthorizeViewerResult> {
    await this.initialized;
    const request = ConversationParentAuthorizeViewerRequestSchema.parse(input);
    const row = this.row();
    if (!row || row.lifecycle === "deleted") {
      return ConversationParentAuthorizeViewerResultSchema.parse({ authorized: false, archived: true });
    }
    this.assertAutomation(request.workspaceId, request.parentId);
    let authorized = row.scope === "workspace"
      || row.author_user_id === request.userId
      || row.run_as_user_id === request.userId;
    if (!authorized && row.scope === "workstream" && row.owning_workstream_id) {
      const workspace = await durableObjectStubForWorkspace(
        this.env,
        this.env.WORKSPACE_DOS,
        row.workspace_id,
        workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(row.workspace_id)),
      );
      authorized = (await workspace.workstreamParticipant({
        workspaceId: row.workspace_id,
        workstreamId: row.owning_workstream_id,
        userId: request.userId,
      })).participant;
    }
    return ConversationParentAuthorizeViewerResultSchema.parse({
      authorized,
      archived: row.owning_room_archived_at !== null,
    });
  }

  async authorizationDiscoveryChildren(input: ConversationParentAuthorityRequest) {
    await this.initialized;
    const request = ConversationParentAuthorityRequestSchema.parse(input);
    const row = this.row();
    if (!row || row.lifecycle === 'deleted') return { substreamIds: [] as string[] };
    this.assertAutomation(request.workspaceId, request.parentId);
    // Automation registries have no failed/ready preparation state. A registered, unprovisioned
    // child is unresolved authority, not evidence that its content can be discarded.
    return { substreamIds: this.childRegistry().map((child) => child.substreamId) };
  }

  /** No participant admission and no projection-dependent permission decision. */
  async readAuthorizationFacts(input: ConversationAuthorizationRequest) {
    await this.initialized;
    const request = ConversationAuthorizationRequestSchema.parse(input);
    const row = this.row();
    if (!row || row.lifecycle === 'deleted') return { exists: false as const, validatedAt: Date.now() };
    this.assertAutomation(request.workspaceId, request.parentId);
    return { exists: true as const, scope: row.scope, owningWorkstreamId: row.owning_workstream_id,
      author: row.author_user_id === request.userId, executor: row.run_as_user_id === request.userId,
      children: this.childRegistry().map((child) => child.substreamId),
      revision: JSON.stringify([row.authority_generation, row.updated_at]), validatedAt: Date.now() };
  }

  async authority(input: ConversationParentAuthorityRequest): Promise<ConversationParentAuthorityResult> {
    await this.initialized;
    const request = ConversationParentAuthorityRequestSchema.parse(input);
    const row = this.row();
    if (!row) {
      return ConversationParentAuthorityResultSchema.parse({ exists: false, authorityGeneration: 0, archived: false });
    }
    this.assertAutomation(request.workspaceId, request.parentId);
    return ConversationParentAuthorityResultSchema.parse({
      exists: true,
      authorityGeneration: row.authority_generation,
      archived: row.lifecycle === "deleted" || row.owning_room_archived_at !== null,
    });
  }

  /** Reserve against current parent authority without a caller-side preflight RPC. */
  async reserveAgentChild(input: Omit<ConversationParentReserveChildRequest, "authorityGeneration" | "directory" | "kind">): Promise<ConversationParentReserveChildResult> {
    const authority = await this.authority({ workspaceId: input.workspaceId, parentId: input.parentId });
    if (!authority.exists || authority.archived) throw new Error("workstream_archived");
    return this.reserveChild({ ...input, kind: "child", authorityGeneration: authority.authorityGeneration });
  }

  async reserveChild(input: ConversationParentReserveChildRequest): Promise<ConversationParentReserveChildResult> {
    await this.initialized;
    const request = ConversationParentReserveChildRequestSchema.parse(input);
    const row = this.assertAutomation(request.workspaceId, request.parentId);
    if (request.kind === "child" && (row.lifecycle === "deleted" || row.owning_room_archived_at !== null)) throw new Error("workstream_archived");
    this.registerChild(request.substreamId, request.kind, request.createdByUserId, Date.now());
    return ConversationParentReserveChildResultSchema.parse({
      reserved: true,
      authorityGeneration: row.authority_generation,
    });
  }

  protected override parentIdentity(): ConversationParentIdentity | null {
    const row = this.row();
    return row ? {
      region: row.region,
      workspaceId: asWorkspaceId(row.workspace_id),
      parentKind: "automation",
      parentId: row.automation_id,
      authorityGeneration: row.authority_generation,
    } : null;
  }

  protected override admitChildEnvelope(envelope: ConversationEffectEnvelope): void {
    if (envelope.parentKind !== "automation") throw new Error("sidekick_effect_parent_kind_mismatch");
    const row = this.row();
    if (!row) throw new Error("sidekick_missing");
    if (row.workspace_id !== envelope.workspaceId || row.automation_id !== envelope.parentId) {
      throw new Error("sidekick_effect_identity_mismatch");
    }
  }

  /**
   * Nothing a child says leaves this object. An automation's conversation and
   * its runs are not workspace rooms: they produce no sidebar rows, no
   * activity, and no notifications. What the workspace hears is the
   * automation's own row, enqueued by this object when the automation changes.
   */
  protected override forwardsChildEffect(): boolean {
    return false;
  }

  protected override parentLogFields(): Record<string, unknown> {
    const row = this.row();
    return {
      workspace_id: row?.workspace_id ?? null,
      automation_id: row?.automation_id ?? null,
      parent_kind: "automation",
    };
  }

  /** A run's conversation moved; the run row follows it, forward only. */
  protected override onChildCommonAggregate(
    substreamId: string,
    _aggregate: DirectoryCommonEffect,
    envelope: ConversationEffectEnvelope,
    now: number,
  ): void {
    if (substreamId === "0" || envelope.effect.kind !== "directory_common") return;
    const next = RUN_STATE_FROM_CONVERSATION_STATE[envelope.effect.state] ?? null;
    if (next === null) return;
    const run = this.run(substreamId);
    if (!run || TERMINAL_RUN_STATES.has(run.state) || run.state === next) {
      if (run && !TERMINAL_RUN_STATES.has(run.state)) {
        this.state.storage.sql.exec(
          `UPDATE runs SET summary = ?, updated_at = ? WHERE run_id = ?`,
          envelope.effect.preview || null,
          now,
          substreamId,
        );
      }
      return;
    }
    this.state.storage.sql.exec(
      `UPDATE runs
          SET state = ?, summary = ?, completed_at = CASE WHEN ? THEN ? ELSE completed_at END,
              updated_at = ?
        WHERE run_id = ?`,
      next,
      envelope.effect.preview || null,
      TERMINAL_RUN_STATES.has(next) ? 1 : 0,
      now,
      now,
      substreamId,
    );
  }

  // ---------------------------------------------------------------------------
  // Alarms: schedules fire, runs are provisioned, the outbox drains.
  // ---------------------------------------------------------------------------

  protected override async runScheduledAlarm(alarm: ScheduledAlarm): Promise<ScheduledAlarmOutcome> {
    if (alarm.kind === "sidekick_publication") {
      const row = this.row();
      if (!row || row.lifecycle === "deleted" || row.accepted_definition_revision !== Number(alarm.key)
        || row.applied_effects_revision === row.accepted_definition_revision) return { progressed: true };
      const revision = this.revision(row.accepted_definition_revision);
      if (!revision) throw new Error("sidekick_accepted_revision_missing");
      const definition = AutomationDraftSchema.parse(JSON.parse(revision.definition_json));
      const schedules = this.state.storage.sql.exec<ScheduleRow & { definition_json: string }>(`SELECT * FROM schedules`).toArray();
      await this.applyEffects(row, revision.definition_revision, definition, [], {
        schedules: schedules.filter((entry) => entry.next_due_at !== null).map((entry) => ({ id: entry.schedule_id, kind: entry.schedule_kind, definition: JSON.parse(entry.definition_json), nextDueAt: entry.next_due_at! })),
        evaluators: JSON.parse(row.evaluator_projection_json),
      });
      return { progressed: true };
    }
    if (alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND) {
      await this.executeSchedule(alarm.key);
      return { progressed: true };
    }
    if (alarm.kind === AUTOMATION_RUN_ALARM_KIND) {
      await this.provisionRun(alarm.key);
      return { progressed: true };
    }
    throw new Error(`sidekick_unknown_alarm_kind:${alarm.kind}`);
  }

  protected override runDueAlarmWork(): Promise<void> {
    return this.drainParentOutbox();
  }

  protected override nextDerivedAlarmCandidates(): readonly number[] {
    const due = this.nextParentOutboxDueAt();
    return due === null ? [] : [due];
  }

  protected override scheduledAlarmDeferral(): Promise<number | null> {
    return Promise.resolve(null);
  }

  protected override onScheduledAlarmFailure(alarm: ScheduledAlarm, error: unknown, attempt: number): void {
    reportScheduledAlarmAttempt(this.env, (promise) => this.state.waitUntil(promise), {
      event: "sidekick_scheduled_alarm_failed",
      summary: "An automation's alarm entry keeps throwing; `code` is the handler's error, and `alarm_kind` and `alarm_key` name the entry.",
      attempt,
      fields: { ...this.parentLogFields(), alarm_kind: alarm.kind, alarm_key: alarm.key },
      error,
    });
  }

  protected override onScheduledAlarmStalled(alarm: ScheduledAlarm, attempt: number): void {
    reportScheduledAlarmAttempt(this.env, (promise) => this.state.waitUntil(promise), {
      event: "sidekick_scheduled_alarm_stalled",
      summary: "An automation's alarm entry keeps coming back due at the same instant after running.",
      attempt,
      fields: {
        ...this.parentLogFields(),
        alarm_kind: alarm.kind,
        alarm_key: alarm.key,
        due_at: new Date(alarm.dueAt).toISOString(),
      },
    });
  }

  private async executeSchedule(scheduleId: string): Promise<void> {
    const row = this.row();
    const schedule = first(this.state.storage.sql.exec<ScheduleRow>(
      `SELECT schedule_id, schedule_kind, definition_json, next_due_at FROM schedules WHERE schedule_id = ?`,
      scheduleId,
    ));
    if (!row || !schedule || schedule.next_due_at === null || row.lifecycle !== "active") return;
    const now = Date.now();
    const dueAt = schedule.next_due_at;
    await this.admitOccurrence(`schedule:${scheduleId}:${dueAt}`, {
      kind: "schedule",
      scheduleId,
      scheduleKind: schedule.schedule_kind,
      plannedFor: dueAt,
    }, null);
    const nextDueAt = scheduleDueAfter(schedule.schedule_kind, schedule.definition_json, now);
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `UPDATE schedules SET next_due_at = ?, updated_at = ? WHERE schedule_id = ?`,
        nextDueAt,
        now,
        scheduleId,
      );
      this.enqueueDirectory(now);
    });
    if (nextDueAt !== null) {
      await this.scheduleAlarm({ kind: AUTOMATION_SCHEDULE_ALARM_KIND, key: scheduleId, dueAt: nextDueAt });
    }
  }

  /**
   * Record one occurrence and arm the alarm that provisions its run.
   *
   * Idempotent on the occurrence key: a retried admission of the same event,
   * schedule instant, email, or manual key answers with the run it already
   * made. The run id is also the child substream id.
   */
  private async admitOccurrence(
    occurrenceKey: string,
    trigger: AutomationRunTriggerV1,
    opening: { textContent: string; structuredContent: Record<string, unknown>; resourceId: string | null } | null,
    seed: DemoSeed | null = null,
  ): Promise<{ runId: string; reused: boolean }> {
    const row = this.row();
    if (!row || row.accepted_definition_revision === null) {
      throw new ApiError(409, "sidekick_not_active", "The Sidekick has no accepted definition");
    }
    const now = Date.now();
    const runId = uuidV7(now);
    const inserted = this.state.storage.sql.exec<{ run_id: string }>(
      `INSERT OR IGNORE INTO runs
         (run_id, occurrence_key, trigger_json, definition_revision, harness_run_id, state,
          summary, opening_json, seed_json, created_at, started_at, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL, NULL, ?)
       RETURNING run_id`,
      runId,
      occurrenceKey,
      JSON.stringify(trigger),
      row.accepted_definition_revision,
      uuidV7(now + 1),
      opening ? JSON.stringify(opening) : null,
      seed ? JSON.stringify(seed) : null,
      now,
      now,
    ).toArray()[0];
    if (!inserted) {
      const existing = first(this.state.storage.sql.exec<{ run_id: string; state: string }>(
        `SELECT run_id, state FROM runs WHERE occurrence_key = ?`,
        occurrenceKey,
      ));
      if (!existing) throw new Error("sidekick_occurrence_missing");
      // The row commits on its own and the alarm is armed after it, so a
      // retry of an admission that died between the two finds the row and
      // must arm the alarm it never got; the alarm is keyed by run id and
      // `provisionRun` ignores a run that is no longer pending, so arming a
      // second time for a run that was provisioned costs nothing.
      if (existing.state === "pending") {
        await this.scheduleAlarm({ kind: AUTOMATION_RUN_ALARM_KIND, key: existing.run_id, dueAt: now });
      }
      return { runId: existing.run_id, reused: true };
    }
    await this.scheduleAlarm({ kind: AUTOMATION_RUN_ALARM_KIND, key: runId, dueAt: now });
    return { runId, reused: false };
  }

  /**
   * Open the run's conversation and start its loop.
   *
   * Every step is idempotent, so a retry after a failure part-way resumes
   * rather than provisioning twice: the child bootstrap and provision are
   * replays on an opened object, the run admission answers `exists`, and the
   * loop activation keys its receipt on the run.
   */
  private async provisionRun(runId: string): Promise<void> {
    const row = this.row();
    const run = this.run(runId);
    if (!row || !run || run.state !== "pending") return;
    if (row.lifecycle !== "active") {
      this.state.storage.sql.exec(
        `UPDATE runs SET state = 'stopped', completed_at = ?, updated_at = ? WHERE run_id = ?`,
        Date.now(),
        Date.now(),
        runId,
      );
      return;
    }
    const definition = await this.readRunDefinition({
      workspaceId: asWorkspaceId(row.workspace_id),
      automationId: row.automation_id,
      runId,
    });
    const now = Date.now();
    this.registerChild(runId, "child", null, now);
    await bootstrapConversationChildRuntime(this.env, row.workspace_id, "automation", row.automation_id, runId);
    await provisionWorkstreamObject(this.env, {
      workspaceId: row.workspace_id,
      workstreamId: row.automation_id,
      substreamId: runId,
      title: definition.definition.name,
      objective: definition.definition.instructions,
      // A run is nested implementation detail, not a room: it admits only the
      // person it runs as.
      scope: "personal",
      createdByUserId: row.run_as_user_id,
      participantUserIds: [row.run_as_user_id],
      harnessStatus: "scheduled",
      emailAddress: null,
      emailRouteStatus: null,
      systemKind: null,
      modelOverride: row.model_override,
      now,
    });
    let triggerMessageId: string | null = null;
    if (definition.opening) {
      // Only an email is also a resource the run can open; an event is prose.
      if (definition.opening.resourceId) {
        await attachWorkstreamRuntimeResource(this.env, {
          workspaceId: row.workspace_id,
          workstreamId: row.automation_id,
          substreamId: runId,
          resourceId: definition.opening.resourceId,
          attachedByUserId: null,
          relationshipType: "inbound_email",
        });
      }
      const appended = await createMessageObjectPort(this.env, row.workspace_id, row.automation_id, undefined, runId)
        .appendMessage({
          messageId: uuidV7(Date.now()),
          clientMessageId: `automation-opening:${runId}`,
          authorType: "system",
          authorUserId: null,
          externalActorJson: null,
          messageType: "system",
          text: definition.opening.textContent,
          structuredContentJson: JSON.stringify(definition.opening.structuredContent),
          producedByRunId: null,
          now: Date.now(),
        });
      triggerMessageId = appended.messageId;
    }
    const pinned = automationModelOverride(this.env, row.model_override, {
      workspaceId: row.workspace_id,
      automationId: row.automation_id,
    });
    const model = pinned ?? await scheduledWorkstreamModel(this.env, {
      workspaceId: row.workspace_id,
      workstreamId: row.automation_id,
    });
    const runs = createHarnessRunObjectPort(this.env, row.workspace_id, row.automation_id, undefined, runId);
    const executionPrincipal = { type: "user" as const, userId: asUserId(row.run_as_user_id) };
    if (!await runs.run({ runId: run.harness_run_id })) {
      await runs.admitRun({
        runId: run.harness_run_id,
        origin: "automation_run",
        executionPrincipalJson: JSON.stringify(executionPrincipal),
        status: "admitted",
        startedAt: null,
        model,
        triggerPartId: null,
        parentRunId: null,
        expectedLatestRunId: null,
        now: Date.now(),
      });
    }
    await activateWorkstreamLoop(this.env, {
      region: row.region,
      workspaceId: asWorkspaceId(row.workspace_id),
      parentKind: "automation",
      parentId: row.automation_id,
      substreamId: asSubstreamId(runId),
      loopId: substreamLoopId(row.automation_id, asSubstreamId(runId)),
      harnessRunId: asHarnessRunId(run.harness_run_id),
      triggerMessageId,
      activityId: null,
      automationRun: {
        schemaVersion: 1,
        automationId: asAutomationId(row.automation_id),
        runId,
        definitionRevision: run.definition_revision,
        trigger: definition.trigger,
      },
      executionPrincipal,
      // A seeded run answers its own provider requests from here; every other
      // run carries nothing and reaches the real provider. See `runSeeded`.
      ...(run.seed_json ? { seed: DemoSeedSchema.parse(JSON.parse(run.seed_json)) } : {}),
      reason: definition.trigger.kind,
    });
    this.state.storage.sql.exec(
      `UPDATE runs SET state = 'running', started_at = ?, updated_at = ? WHERE run_id = ? AND state = 'pending'`,
      Date.now(),
      Date.now(),
      runId,
    );
  }

  // ---------------------------------------------------------------------------
  // Lifecycle helpers.
  // ---------------------------------------------------------------------------

  private async pauseBy(row: AutomationRow, by: "person" | "room_archive"): Promise<void> {
    const now = Date.now();
    const schedules = this.schedules().map((schedule) => schedule.schedule_id);
    this.state.storage.transactionSync(() => {
      this.stopOpenRuns(now);
      this.state.storage.sql.exec(
        `UPDATE automation SET lifecycle = 'paused', paused_by = ?, updated_at = ? WHERE id = 1`,
        by,
        now,
      );
      this.enqueueDirectory(now);
    });
    await Promise.all(schedules.map((scheduleId) => (
      this.cancelScheduledAlarm(AUTOMATION_SCHEDULE_ALARM_KIND, scheduleId)
    )));
    await this.cancelScheduledAlarmKind(AUTOMATION_RUN_ALARM_KIND);
    await this.replaceRegistrations([]);
    await this.armNextAlarm();
    void row;
  }

  private async resumeFromPause(row: AutomationRow): Promise<void> {
    const now = Date.now();
    const schedules = this.schedules();
    this.state.storage.transactionSync(() => {
      for (const schedule of schedules) {
        this.state.storage.sql.exec(
          `UPDATE schedules SET next_due_at = ?, updated_at = ? WHERE schedule_id = ?`,
          scheduleDueAfter(schedule.schedule_kind, schedule.definition_json, now),
          now,
          schedule.schedule_id,
        );
      }
      this.state.storage.sql.exec(
        `UPDATE automation SET lifecycle = 'active', paused_by = NULL, updated_at = ? WHERE id = 1`,
        now,
      );
      this.enqueueDirectory(now);
    });
    for (const schedule of this.schedules()) {
      if (schedule.next_due_at !== null) {
        await this.scheduleAlarm({
          kind: AUTOMATION_SCHEDULE_ALARM_KIND,
          key: schedule.schedule_id,
          dueAt: schedule.next_due_at,
        });
      }
    }
    await this.replaceRegistrations(JSON.parse(row.evaluator_projection_json) as unknown[]);
    await this.armNextAlarm();
  }

  private stopOpenRuns(now: number): void {
    this.state.storage.sql.exec(
      `UPDATE runs SET state = 'stopped', completed_at = ?, updated_at = ?
        WHERE state IN ('pending', 'running', 'needs_input')`,
      now,
      now,
    );
  }

  /** The workspace's registrations for this automation, replaced whole. */
  private async replaceRegistrations(evaluators: unknown[], row = this.row()): Promise<void> {
    if (!row) throw new Error("sidekick_missing");
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      row.workspace_id,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(row.workspace_id)),
    );
    const registration = await workspace.applyExternalEventRegistrations({
      schemaVersion: 1,
      workspaceId: row.workspace_id,
      destination: { kind: "automation", automationId: row.automation_id },
      sourceGeneration: row.registration_generation,
      evaluators,
    });
    this.state.storage.sql.exec(
      `UPDATE automation SET effective_after_event_sequence = ?, updated_at = ? WHERE id = 1 AND registration_generation = ?`,
      registration.effectiveAfterEventSequence,
      Date.now(),
      row.registration_generation,
    );
  }

  /**
   * Everything applying a revision needs from outside this object: which
   * connection each selected plugin binds to, the evaluator registrations the
   * workspace will match on, and the schedules with their first due instants.
   */
  private async prepareApplication(
    row: AutomationRow,
    revision: RevisionRow,
    definition: AutomationDraft,
    actorUserId: string,
  ): Promise<{
    selections: ReturnType<typeof automationAcceptanceSelections>;
    connectorBindings: Record<string, string>;
    evaluators: unknown[];
    schedules: Array<{ id: string; kind: "calendar" | "interval"; definition: ScheduleDefinition; nextDueAt: number }>;
  }> {
    const selections = automationAcceptanceSelections(definition);
    const selectedPluginIds = [...new Set([
      ...selections.defaultPluginIds,
      ...Object.values(selections.activitySourcePluginIds),
    ])];
    const connections = selectedPluginIds.length === 0
      ? { results: [] }
      : await this.workspaceDatabase().prepare(
        `SELECT id, connector_type, scope, owner_user_id, model_plugin_id, status, config_json
           FROM connector_connections WHERE workspace_id = ? AND status <> 'disabled'`,
      ).bind(row.workspace_id).all<{
        id: string;
        connector_type: string;
        scope: string;
        owner_user_id: string | null;
        model_plugin_id: string;
        status: string;
        config_json: string | null;
      }>();
    const connectionsByPlugin = new Map(
      (connections.results ?? []).map((connection) => [connection.model_plugin_id, connection]),
    );
    const connectorBindings: Record<string, string> = {};
    for (const pluginId of selectedPluginIds) {
      const connection = connectionsByPlugin.get(pluginId);
      if (!connection) throw new ApiError(422, "sidekick_plugin_unavailable", `No connection is available for ${pluginId}`);
      if (row.scope === "workspace" && connection.scope !== "workspace") {
        throw new ApiError(422, "sidekick_workspace_connection_required", "A workspace Sidekick may bind only workspace connections");
      }
      // You may bind a workspace connection or your own personal one, never
      // somebody else's: a room's automation outlives whoever wrote it, and
      // binding a colleague's credentials to it would lend them to a standing
      // automation they never agreed to.
      if (row.scope !== "workspace" && connection.scope === "personal"
        && connection.owner_user_id !== actorUserId && connection.owner_user_id !== row.run_as_user_id) {
        throw new ApiError(422, "sidekick_personal_connection_access_denied", "That connection belongs to somebody else");
      }
      connectorBindings[pluginId] = connection.id;
    }

    const registry = connectorRegistryForEnv(this.env);
    // The same normalization the drafting tool applies, so a revision written
    // before it existed, or by a path that skipped it, is read the same way:
    // a placeholder id, or an id on a trigger that cannot name a resource,
    // is dropped rather than looked up and refused.
    const rules = AutomationSetEvaluatorRulesInputV1Schema.parse(withoutUnusableAutomationResourceIds(
      revision.evaluator_rules_json ? JSON.parse(revision.evaluator_rules_json) : { schemaVersion: 1, evaluators: [] },
      (pluginId) => {
        const connection = connectionsByPlugin.get(pluginId);
        return connection
          ? connectorActivityTriggerDescriptors(
            registry.get(connection.connector_type),
            connection.config_json,
            storedConnectionScope(connection.scope),
          )
          : undefined;
      },
    ));
    const blocker = automationDraftAcceptanceBlocker(definition, rules);
    if (blocker) throw new ApiError(422, blocker, "The automation's definition cannot be applied");
    const selectedByBinding = new Map(Object.entries(selections.activitySourcePluginIds));
    const inspectedPlugins = new Map<string, {
      pluginId: string;
      activityTriggers: ReturnType<typeof registry.get>["manifest"]["activityTriggers"];
      eventFamilies: Record<string, string[]>;
    }>();
    for (const evaluator of rules.evaluators) {
      const connection = connectionsByPlugin.get(evaluator.source.suggestedSourcePluginId);
      if (!connection) throw new ApiError(422, "sidekick_plugin_unavailable", "An evaluator names a plugin with no connection");
      const descriptors = connectorActivityTriggerDescriptors(
        registry.get(connection.connector_type),
        connection.config_json,
        storedConnectionScope(connection.scope),
      );
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
      if (evaluator.when.kind !== "all") continue;
      for (const leaf of evaluator.when.allOf) {
        if (leaf.kind !== "person_id" && leaf.kind !== "person_id_array") continue;
        for (const value of Array.isArray(leaf.value) ? leaf.value : [leaf.value]) referencedPersonIds.add(value);
      }
    }
    const resolvedPersonIds = new Set<string>();
    if (referencedPersonIds.size > 0) {
      const ids = [...referencedPersonIds];
      const members = await this.env.DB.prepare(
        `SELECT user_id FROM workspace_members
          WHERE workspace_id = ? AND status = 'active'
            AND user_id IN (${ids.map(() => "?").join(",")})`,
      ).bind(row.workspace_id, ...ids).all<{ user_id: string }>();
      for (const member of members.results ?? []) resolvedPersonIds.add(member.user_id);
      if (resolvedPersonIds.size !== referencedPersonIds.size) {
        throw new ApiError(422, "sidekick_person_not_found", "An evaluator names a person who is not in the workspace");
      }
    }
    const referencedResources = new Map<string, { pluginId: string; sourceBindingKey: string; resourceType: string }>();
    for (const evaluator of rules.evaluators) {
      if (!evaluator.source.resourceId) continue;
      const selectedPluginId = selectedByBinding.get(evaluator.source.sourceBindingKey);
      const selectedConnection = selectedPluginId ? connectionsByPlugin.get(selectedPluginId) : undefined;
      const resource = await this.workspaceDatabase().prepare(
        `SELECT id, connection_id, resource_type FROM resources WHERE workspace_id = ? AND id = ?`,
      ).bind(row.workspace_id, evaluator.source.resourceId).first<{
        id: string;
        connection_id: string | null;
        resource_type: string;
      }>();
      if (!resource || resource.connection_id !== selectedConnection?.id || !selectedPluginId) {
        throw new ApiError(422, "sidekick_resource_not_found", "An evaluator names a resource this Sidekick cannot watch");
      }
      referencedResources.set(resource.id, {
        pluginId: evaluator.source.suggestedSourcePluginId,
        sourceBindingKey: evaluator.source.sourceBindingKey,
        resourceType: resource.resource_type,
      });
    }
    const externalTriggers = definition.triggers.filter(isExternalEventTrigger);
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

    const now = Date.now();
    const needsDefaultTimezone = definition.triggers.some(
      (trigger) => trigger.type === "calendar" && trigger.timezone === null,
    );
    const timezone = needsDefaultTimezone ? await this.defaultTimezone(row) : "UTC";
    const schedules: Array<{ id: string; kind: "calendar" | "interval"; definition: ScheduleDefinition; nextDueAt: number }> = [];
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
      if (!next) throw new ApiError(422, "sidekick_recurrence_has_no_future", "The schedule never occurs again");
      schedules.push({
        id: uuidV7(),
        kind: "calendar",
        definition: { rrule: trigger.rrule, timezone: effectiveTimezone, acceptedAt: now },
        nextDueAt: next.getTime(),
      });
    }
    return { selections, connectorBindings, evaluators, schedules };
  }

  private async defaultTimezone(row: AutomationRow): Promise<string> {
    const stored = row.scope === "personal"
      ? await this.env.DB.prepare(`SELECT timezone FROM users WHERE id = ?`).bind(row.run_as_user_id)
        .first<{ timezone: string | null }>()
      : await this.env.DB.prepare(`SELECT timezone FROM workspaces WHERE id = ?`).bind(row.workspace_id)
        .first<{ timezone: string | null }>();
    const timezone = stored?.timezone ?? "UTC";
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch {
      throw new ApiError(422, "sidekick_timezone_invalid", "The schedule's timezone is not valid");
    }
    return timezone;
  }

  // ---------------------------------------------------------------------------
  // Reads.
  // ---------------------------------------------------------------------------

  private row(): AutomationRow | null {
    return first(this.state.storage.sql.exec<AutomationRow>(`SELECT * FROM automation WHERE id = 1`));
  }

  private assertAutomation(workspaceId: string, automationId: string): AutomationRow {
    const row = this.row();
    if (!row) throw new ApiError(404, "sidekick_not_found", "This Sidekick does not exist");
    if (row.workspace_id !== workspaceId || row.automation_id !== automationId) {
      throw new Error("sidekick_identity_mismatch");
    }
    return row;
  }

  private revision(definitionRevision: number): RevisionRow | null {
    if (definitionRevision <= 0) return null;
    return first(this.state.storage.sql.exec<RevisionRow>(
      `SELECT definition_revision, definition_json, evaluator_rules_json, ready, created_at
         FROM definition_revisions WHERE definition_revision = ?`,
      definitionRevision,
    ));
  }

  private schedules(): ScheduleRow[] {
    return this.state.storage.sql.exec<ScheduleRow>(
      `SELECT schedule_id, schedule_kind, definition_json, next_due_at FROM schedules ORDER BY schedule_id`,
    ).toArray();
  }

  private run(runId: string): RunRow | null {
    return first(this.state.storage.sql.exec<RunRow>(`SELECT * FROM runs WHERE run_id = ?`, runId));
  }

  private workspaceDatabase(): D1Database {
    const row = this.row();
    if (!row) throw new Error("sidekick_missing");
    return withWorkspaceRuntimeDatabase(this.env, asWorkspaceId(row.workspace_id)).DB;
  }

  /**
   * Who may change an automation. The author always may; a workspace
   * automation additionally answers to the workspace's owners and admins; a
   * room's automation belongs to the room, and authorship is not a share in
   * it, so participation is the only standing.
   */
  private assertManager(row: AutomationRow, actor: AutomationActor): void {
    if (row.scope === "workstream") {
      // The room's participants manage it, and so does the person who asked
      // for it: the directory row that names the room's participants lands
      // through the effect queue, and a card that says "accept" must not be
      // refused while that row is still in flight.
      if (actor.participantOfOwningWorkstream || row.author_user_id === actor.userId) return;
      throw forbidden();
    }
    if (row.author_user_id === actor.userId || row.run_as_user_id === actor.userId) return;
    if (row.scope === "workspace" && (actor.actorRole === "owner" || actor.actorRole === "admin")) return;
    throw forbidden();
  }

  private assertViewer(row: AutomationRow, actor: AutomationActor): void {
    if (row.lifecycle === "deleted") throw new ApiError(404, "sidekick_not_found", "This Sidekick was archived");
    if (row.scope === "workspace" || row.author_user_id === actor.userId || row.run_as_user_id === actor.userId) return;
    if (row.scope === "workstream" && actor.participantOfOwningWorkstream) return;
    throw new ApiError(404, "sidekick_not_found", "This Sidekick does not exist");
  }

  private nextRunAt(row: AutomationRow): number | null {
    if (row.lifecycle !== "active") return null;
    return first(this.state.storage.sql.exec<{ next_due_at: number | null }>(
      `SELECT MIN(next_due_at) AS next_due_at FROM schedules`,
    ))?.next_due_at ?? null;
  }

  private detail(): AutomationDetail {
    const row = this.row();
    if (!row) throw new ApiError(404, "sidekick_not_found", "This Sidekick does not exist");
    if (row.lifecycle === "deleted") throw new ApiError(404, "sidekick_not_found", "This Sidekick was archived");
    const current = this.revision(row.current_definition_revision);
    const lastRunAt = first(this.state.storage.sql.exec<{ created_at: number }>(
      `SELECT created_at FROM runs ORDER BY created_at DESC LIMIT 1`,
    ))?.created_at ?? null;
    return AutomationDetailSchema.parse({
      id: row.automation_id,
      ...(row.appearance_json
        ? { appearance: WorkstreamAppearanceSchema.parse(JSON.parse(row.appearance_json)) }
        : {}),
      name: row.title || "New Sidekick",
      loadable: row.loadable === 1,
      description: row.description,
      emailAddress: row.accepted_definition_revision !== null && sidekickReceivesEmail(AutomationDraftSchema.parse(JSON.parse(this.revision(row.accepted_definition_revision)!.definition_json))) ? row.email_address : null,
      scope: row.scope,
      owningWorkstreamId: row.owning_workstream_id,
      status: row.lifecycle,
      nextRunAt: iso(this.nextRunAt(row)),
      lastRunAt: iso(lastRunAt),
      updatedAt: iso(row.updated_at),
      lifecycle: row.lifecycle,
      authorUserId: row.author_user_id,
      runAsUserId: row.run_as_user_id,
      currentDefinition: current ? JSON.parse(current.definition_json) : null,
      currentDefinitionRevision: row.current_definition_revision,
      acceptedDefinitionRevision: row.accepted_definition_revision,
      runnable: (() => {
        const accepted = row.accepted_definition_revision === null ? null : this.revision(row.accepted_definition_revision);
        if (!accepted) return false;
        const definition = AutomationDraftSchema.parse(JSON.parse(accepted.definition_json));
        return definition.triggers.length > 0 || sidekickReceivesEmail(definition);
      })(),
      connectorBindings: JSON.parse(row.connector_bindings_json),
      recentRuns: this.runSummaries(20),
    });
  }

  private runSummaries(limit: number): AutomationRun[] {
    const row = this.row();
    if (!row) return [];
    return this.state.storage.sql.exec<RunRow>(
      `SELECT * FROM runs ORDER BY created_at DESC, run_id LIMIT ?`,
      limit,
    ).toArray().map((run) => {
      const trigger = JSON.parse(run.trigger_json) as AutomationRunTriggerV1;
      return AutomationRunSchema.parse({
        id: run.run_id,
        automationId: row.automation_id,
        triggerType: trigger.kind,
        plannedFor: trigger.kind === "schedule" ? iso(trigger.plannedFor) : null,
        startedAt: iso(run.started_at),
        completedAt: iso(run.completed_at),
        status: run.state,
        resultSummary: run.summary,
        createdAt: iso(run.created_at),
      });
    });
  }

  /** The automation's own sidebar row, into the shared outbox. */
  private enqueueDirectory(now: number): void {
    this.state.storage.sql.exec(`UPDATE automation SET registration_generation = registration_generation + 1 WHERE id = 1`);
    const row = this.row();
    if (!row) throw new Error("sidekick_missing");
    const effect: ParentEffect = {
      kind: "directory_automation",
      loadable: row.loadable === 1,
      ...(row.appearance_json
        ? { appearance: WorkstreamAppearanceSchema.parse(JSON.parse(row.appearance_json)) }
        : {}),
      automationId: row.automation_id,
      authorUserId: row.author_user_id,
      lifecycle: row.lifecycle,
      scope: row.scope,
      owningWorkstreamId: row.owning_workstream_id,
      title: row.title,
      description: row.description,
      nextRunAt: iso(this.nextRunAt(row)),
    };
    this.enqueueProjection("automation", effect, now);
  }
}

applyRetirementGate(SidekickDO, {
  // The shared classification is inherited from ConversationParentDurableObject;
  // this call is what wraps the doors *this* class overrides for itself.
  drop: {
    fetch: () => retiredObjectResponse(),
    // No socket callbacks: a Sidekick's transcript is served by its
    // substream agent, not by this object.
    alarm: () => Promise.resolve(),
  },
});
