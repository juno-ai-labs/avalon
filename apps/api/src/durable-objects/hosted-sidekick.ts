import { type SidekickAttachment, SidekickAttachmentSchema } from "@rally/contracts";
import type { Region } from "@rally/contracts/regions";
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
  ExternalEventRegistrationProjectionV1Schema,
  PROJECT_COLOR_RING,
  WORKSTREAM_ICON_KEYS,
  WorkstreamAppearanceSchema,
  WorkstreamAppearancePatchSchema,
  automationAcceptanceSelections,
  sidekickLoadable,
  sidekickReceivesEmail,
  automationDraftAcceptanceBlocker,
  asAutomationId,
  asUserId,
  isExternalEventTrigger,
  semanticConditionsForEventType,
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
import type { WorkspaceRelationship } from "@rally/contracts/scope-grants";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import type { ConversationEffectEnvelope } from "@rally/contracts/conversation-effects";
import {
  ConversationParentAuthorityRequestSchema,
  ConversationParentAuthorityResultSchema,
  ConversationParentAuthorizeViewerRequestSchema,
  ConversationParentAuthorizeViewerResultSchema,
  ConversationParentListChildrenRequestSchema,
  ConversationParentListChildrenResultSchema,
  ConversationParentReserveChildRequestSchema,
  ConversationParentReserveChildResultSchema,
  ConversationParentTerminalDeadlinesRequestSchema,
  ConversationParentTerminalDeadlinesResultSchema,
  type ConversationParentAuthorityRequest,
  type ConversationParentAuthorityResult,
  type ConversationParentAuthorizeViewerRequest,
  type ConversationParentAuthorizeViewerResult,
  type ConversationParentListChildrenRequest,
  type ConversationParentListChildrenResult,
  type ConversationParentReserveChildRequest,
  type ConversationParentReserveChildResult,
  type ConversationParentTerminalDeadlinesRequest,
  type ConversationParentTerminalDeadlinesResult,
} from "@rally/contracts/conversation-parent";

import type { Env } from "../env";
import { ApiError } from "../lib/api-error";
import { connectorActivityTriggerDescriptors, storedConnectionScope } from "../lib/connector-activity-triggers";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import { sha256 } from "../lib/crypto";
import { externalEventOpening } from "../lib/external-event-opening";
import { nextRRuleOccurrence } from "../lib/recurrence";
import { parseRpcInput } from "../lib/rpc-input";
import { uuidV7 } from "../lib/uuid-v7";
import { logWarn } from "../observability/logger";
import { ConversationAuthorizationRequestSchema, type ConversationAuthorizationRequest } from "../services/authorization-policy";
import { validateDraftEvaluatorRules } from "../services/external-event-evaluator";
import { materializeAutomationMemoryTables } from "../services/memory-table-service";
import { WorkstreamEmailRoutingService } from "../services/workstream-email-routing-service";
import {
  AutomationActorRequestSchema,
  AutomationCreateRequestSchema,
  AutomationExternalEventAdmissionSchema,
  AutomationInboundEmailAdmissionSchema,
  AutomationOwningRoomArchivedRequestSchema,
  AutomationRunDefinitionRequestSchema,
  AutomationRunNowRequestSchema,
  AutomationRunRequestSchema,
  AutomationRunSeededRequestSchema,
  AutomationSetAppearanceRequestSchema,
  AutomationSubmitDefinitionRequestSchema,
  AUTOMATION_RUN_ALARM_KIND,
  AUTOMATION_SCHEDULE_ALARM_KIND,
  SidekickRunContinuationSchema,
  SidekickSkillReadRequestSchema,
  type AutomationActor,
  type AutomationActorRequest,
  type AutomationCreateRequest,
  type AutomationExternalEventAdmission,
  type AutomationExternalEventPlan,
  type AutomationInboundEmailAdmission,
  type AutomationOwningRoomArchivedRequest,
  type AutomationRunDefinitionRequest,
  type AutomationRunNowRequest,
  type AutomationRunRequest,
  type AutomationRunSeededRequest,
  type AutomationSetAppearanceRequest,
  type AutomationSubmitDefinitionRequest,
  type SidekickRunContinuation,
  type SidekickSkillReadRequest,
} from "./automation-do-protocol";
import { ReceiveChildEffectsRequestSchema, type DirectoryCommonEffect, type ReceiveChildEffectsRequest } from "./conversation-parent-object";
import { sidekickAudienceAllows } from "./sidekick-audience";
import { scheduledAlarmRetryDelay, type ScheduledAlarm, type ScheduledAlarmOutcome, type ScheduledAlarmStore } from "./scheduled-alarms";

/**
 * A Sidekick's parent, hosted in its Organization's `WorkspaceDO`.
 *
 * Constructed per call for one Sidekick, over the Organization object's own
 * storage: the definition row is the Sidekick's `automation_directory` row,
 * and every other table leads with `sidekick_id`. This is what `SidekickDO`
 * was, moved; the method names and their contracts are the ones that object
 * answered, so a caller changes only which object it asks.
 *
 * Substream `0` is the Sidekick's authoring conversation and each run is a
 * child substream whose id is the run id. Nothing a child reports leaves this
 * object: a child effect lands in the child tables and moves the run row, and
 * the receipt makes a redelivery a no-op.
 *
 * Every change to what the Sidekick has registered (publish, pause, resume,
 * remove, its home's archive) commits the definition row, the schedules, their
 * alarm entries and the connector registrations in one transaction. The one
 * effect that cannot join it, declared memory tables, is a stored alarm entry
 * armed in that transaction. `docs/automation-lifecycle.md` owns the lifecycle;
 * `docs/hosted-conversation-parents.md` owns the hosting.
 */

/** A stored entry per accepted revision whose declared memory tables are still owed. */
export const SIDEKICK_MEMORY_TABLES_ALARM_KIND = "sidekick_memory_tables";
/** The Sidekick alarm kinds `WorkspaceDO` dispatches here. */
export const HOSTED_SIDEKICK_ALARM_KINDS: ReadonlySet<string> = new Set([
  AUTOMATION_SCHEDULE_ALARM_KIND,
  AUTOMATION_RUN_ALARM_KIND,
  SIDEKICK_MEMORY_TABLES_ALARM_KIND,
]);

/** `<sidekickId>:<key>`: every Sidekick entry names its Sidekick, so one Sidekick's are cancelled alone. */
export function sidekickAlarmKey(sidekickId: string, key: string): string {
  return `${sidekickId}:${key}`;
}

/** The Sidekick and the inner key a stored entry names; `null` for a key that names neither. */
export function parseSidekickAlarmKey(key: string): { sidekickId: string; key: string } | null {
  const separator = key.indexOf(":");
  if (separator <= 0 || separator === key.length - 1) return null;
  return { sidekickId: key.slice(0, separator), key: key.slice(separator + 1) };
}

/**
 * What a child conversation's state says about the run inside it. `null` marks
 * a state that describes the conversation rather than the run.
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
// The same replay window `SidekickDO` kept: a fence, not history.
const CHILD_EFFECT_RECEIPT_RETENTION_MS = 180 * 24 * 60 * 60_000;

export type RunState = "pending" | "running" | "needs_input" | "completed" | "failed" | "stopped";
export type Lifecycle = "draft" | "active" | "paused" | "deleted";

/** A hosted Sidekick's row: its directory row, with every definition column filled. */
export interface HostedSidekickRow extends Record<string, SqlStorageValue> {
  automation_id: string;
  workspace_id: string;
  region: Region;
  author_user_id: string;
  run_as_user_id: string;
  lifecycle: Lifecycle;
  paused_by: "person" | "room_archive" | null;
  scope: AutomationScope;
  owning_workstream_id: string | null;
  /** The home under `owning_workstream_id`: `"0"` for its Main conversation, else a Breakout id. */
  owning_substream_id: string;
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
  loadable: number;
  appearance_json: string | null;
  chat_appearance_json: string | null;
  authority_generation: number;
  /** Moved by every Sidekick-side stop of open runs; see `continueRun`. */
  stop_generation: number;
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
  /** Who the run runs as, recorded when it is provisioned; null while pending. */
  run_as_user_id: string | null;
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

interface PreparedSchedule {
  id: string;
  kind: "calendar" | "interval";
  definition: ScheduleDefinition;
  nextDueAt: number;
}

/** What a run's provisioning needs, read once by the Queue consumer that provisions it. */
export interface SidekickRunProvisioning {
  region: Region;
  workspaceId: string;
  automationId: string;
  runId: string;
  harnessRunId: string;
  runAsUserId: string;
  modelOverride: string | null;
  definitionRevision: number;
  definition: AutomationRunDefinitionV1;
  seedJson: string | null;
}

/** What `WorkspaceDO` lends a hosted Sidekick. */
export interface HostedSidekickHost {
  env: Env;
  storage: DurableObjectStorage;
  /**
   * The Organization's alarm entries. A hosted Sidekick only writes them;
   * `WorkspaceDO` re-arms its one native alarm after every Sidekick call.
   */
  alarms: ScheduledAlarmStore;
  /**
   * Replace this Sidekick's connector registrations, inside the caller's
   * transaction, and return the connector-event sequence they take effect
   * after. Throws when a registration cannot be written; the caller's change
   * then rolls back with it.
   */
  writeRegistrations(automationId: string, evaluators: readonly unknown[]): number;
  /** After the commit that wrote registrations: the schedule-kind refresh and the Slack source joins. */
  afterRegistrations(automationId: string, revision: number | null, evaluators: readonly unknown[]): Promise<void>;
  /** Inside the transaction that changed a directory row: the sidebar's waterline and a deleted Sidekick's bindings. */
  noteDirectoryChanged(automationId: string, deleted: boolean, now: number): void;
  /** This Organization's runtime tables, read without leaving the object. */
  workspaceDatabase(workspaceId: string): D1Database;
  workstreamParticipant(input: { workspaceId: string; workstreamId: string; userId: string }): Promise<{ participant: boolean }>;
  /** A Channel's or Breakout's own viewer decision, for a Sidekick homed there. */
  channelViewer(input: {
    workspaceId: string; parentId: string; substreamId: string; userId: string; requireGrantAuthority?: boolean;
  }): Promise<{ authorized: boolean; archived: boolean }>;
  readManagementAccess(input: { workspaceId: string; parentId: string; userId: string }): Promise<{ allowed: boolean; writable: boolean }>;
  readRelationship(workspaceId: string, userId: string): Promise<WorkspaceRelationship | null>;
  /** Hand a run to the activity Queue, whose consumer provisions it. */
  sendRunProvision(message: { workspaceId: string; automationId: string; runId: string }): Promise<void>;
}

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

/**
 * The library's and the management API's read rule, over a directory row
 * alone, so a Sidekick whose import has not run is decided the same way.
 *
 * Organization scope admits members with a role and never a guest; personal
 * scope its author and the person it runs as; Channel scope that Channel's
 * participants, or a Breakout home's members.
 */
export async function sidekickReaderAllows(
  row: {
    scope: string; author_user_id: string; run_as_user_id: string | null; lifecycle: string;
    owning_workstream_id: string | null; owning_substream_id: string; workspace_id: string;
  },
  actor: { userId: string; actorRole: "owner" | "admin" | "member" | null },
  host: Pick<HostedSidekickHost, "workstreamParticipant" | "channelViewer">,
): Promise<boolean> {
  if (row.lifecycle === "deleted") return false;
  if (row.author_user_id === actor.userId || row.run_as_user_id === actor.userId) return true;
  if (row.scope === "workspace") return actor.actorRole != null;
  if (row.scope !== "workstream" || row.owning_workstream_id === null) return false;
  return homeAdmits(row, actor.userId, host);
}

/** Whether a Channel-scoped Sidekick's home admits this person: Main's participants, or a Breakout's members. */
async function homeAdmits(
  row: { owning_workstream_id: string | null; owning_substream_id: string; workspace_id: string },
  userId: string,
  host: Pick<HostedSidekickHost, "workstreamParticipant" | "channelViewer">,
): Promise<boolean> {
  if (row.owning_workstream_id === null) return false;
  if (row.owning_substream_id === "0") {
    return (await host.workstreamParticipant({
      workspaceId: row.workspace_id, workstreamId: row.owning_workstream_id, userId,
    })).participant;
  }
  return (await host.channelViewer({
    workspaceId: row.workspace_id, parentId: row.owning_workstream_id,
    substreamId: row.owning_substream_id, userId,
  })).authorized;
}

export class HostedSidekick {
  constructor(
    private readonly host: HostedSidekickHost,
    readonly sidekickId: string,
  ) {}

  private get env(): Env {
    return this.host.env;
  }

  private get storage(): DurableObjectStorage {
    return this.host.storage;
  }

  private get sql(): SqlStorage {
    return this.host.storage.sql;
  }

  private logFields(): Record<string, unknown> {
    const row = this.row();
    return { workspace_id: row?.workspace_id ?? null, automation_id: this.sidekickId, parent_kind: "automation" };
  }

  // ---------------------------------------------------------------------------
  // The Sidekick itself.
  // ---------------------------------------------------------------------------

  /** Bring the Sidekick into existence, in draft, with its conversation reserved. */
  async create(input: AutomationCreateRequest): Promise<{ created: boolean }> {
    const request = parseRpcInput(AutomationCreateRequestSchema, input, "create");
    if (request.automationId !== this.sidekickId) throw new Error("sidekick_identity_mismatch");
    if (this.row()) {
      this.assertSidekick(request.workspaceId, request.automationId);
      return { created: false };
    }
    const now = Date.now();
    this.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO automation_directory
           (automation_id, workspace_id, region, author_user_id, run_as_user_id, source_version, payload_hash,
            lifecycle, paused_by, scope, owning_workstream_id, owning_substream_id, owning_room_archived_at,
            title, description, next_run_at, projected_at, loadable, appearance_json,
            current_definition_revision, accepted_definition_revision, connector_bindings_json,
            default_plugin_ids_json, activity_source_plugin_ids_json, evaluator_projection_json,
            model_override, email_address, effective_after_event_sequence, authority_generation,
            stop_generation, chat_appearance_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 'hosted', 'draft', NULL, ?, ?, ?, NULL, '', '', NULL, ?, 0, NULL,
                 0, NULL, '{}', '[]', '{}', '[]', NULL, NULL, NULL, ?, 0, NULL, ?, ?)`,
        request.automationId,
        request.workspaceId,
        this.env.AVALON_REGION,
        request.authorUserId,
        request.authorUserId,
        request.scope,
        request.owningWorkstreamId,
        request.owningSubstreamId,
        now,
        request.authorityGeneration,
        now,
        now,
      );
      // Hosted from birth: nothing in a legacy object to import.
      this.sql.exec(
        `INSERT INTO sidekick_imports (sidekick_id, state, imported_at) VALUES (?, 'imported', ?)
         ON CONFLICT(sidekick_id) DO UPDATE SET state = 'imported', imported_at = excluded.imported_at`,
        request.automationId, now,
      );
      this.registerChild("0", "main", request.authorUserId, now);
      this.host.noteDirectoryChanged(this.sidekickId, false, now);
    });
    return { created: true };
  }

  /**
   * Record what the conversation drafted, and apply it when it says it is ready.
   * The manager check comes first, so a person who may not change the Sidekick
   * cannot leave a revision behind either.
   */
  async saveDefinition(input: AutomationSubmitDefinitionRequest & { actor: AutomationActor }): Promise<{ definitionRevision: number; ready: boolean }> {
    const { actor, ...definitionInput } = input;
    const request = parseRpcInput(AutomationSubmitDefinitionRequestSchema, definitionInput, "save_definition");
    await this.assertManager(this.assertSidekick(request.workspaceId, request.automationId), actor);
    const submitted = await this.submitDefinition(request);
    if (submitted.ready) await this.apply({ workspaceId: request.workspaceId, automationId: request.automationId, actor });
    return submitted;
  }

  /**
   * Record what the conversation drafted: a new immutable revision. The title
   * and description follow the latest draft so the sidebar row names it; scope
   * follows the draft only while the Sidekick is still a draft and only between
   * the two scopes a sidebar Sidekick may take.
   */
  async submitDefinition(input: AutomationSubmitDefinitionRequest): Promise<{ definitionRevision: number; ready: boolean }> {
    const request = parseRpcInput(AutomationSubmitDefinitionRequestSchema, input, "submit_definition");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    if (row.lifecycle === "deleted") throw new ApiError(404, "sidekick_not_found", "This Sidekick was archived");
    const definitionJson = JSON.stringify(request.draft);
    const definitionHash = await sha256(definitionJson);
    const now = Date.now();
    const revision = this.storage.transactionSync(() => {
      const latest = this.assertSidekick(request.workspaceId, request.automationId);
      if (latest.lifecycle === "deleted") throw new ApiError(404, "sidekick_not_found", "This Sidekick was archived");
      // A colour outside the ring, or an icon the catalog no longer offers, is
      // one nobody can pick any more, so it may only be the one this Sidekick
      // already wears, kept through an edit.
      const worn = latest.appearance_json
        ? WorkstreamAppearanceSchema.parse(JSON.parse(latest.appearance_json))
        : null;
      if (request.appearance && !(PROJECT_COLOR_RING as readonly string[]).includes(request.appearance.color)
        && worn?.color !== request.appearance.color) {
        throw new ApiError(400, "sidekick_color_not_offered",
          `color ${request.appearance.color} is kept only when it is the Sidekick's current color; choose one of ${PROJECT_COLOR_RING.join(", ")}`);
      }
      if (request.appearance && !(WORKSTREAM_ICON_KEYS as readonly string[]).includes(request.appearance.icon)
        && worn?.icon !== request.appearance.icon) {
        throw new ApiError(400, "sidekick_icon_not_offered",
          `icon ${request.appearance.icon} is kept only when it is the Sidekick's current icon; choose one from the icon catalog`);
      }
      const definitionRevision = latest.current_definition_revision + 1;
      this.sql.exec(
        `INSERT INTO sidekick_revisions
           (sidekick_id, definition_revision, definition_json, definition_hash, evaluator_rules_json, ready,
            submitted_by_run_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        this.sidekickId,
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
      // A submitted appearance is a new choice only when it differs from the
      // last one the chat knew of: its own previous submission, or what the
      // Sidekick wore when it first submitted. A repeat of that is the chat
      // copying its own earlier call, and writing it would undo whatever a
      // person picked since.
      const submittedAppearance = request.appearance ? JSON.stringify(request.appearance) : null;
      const knownAppearance = latest.chat_appearance_json ?? latest.appearance_json;
      const appearance = submittedAppearance !== null
        && (latest.appearance_json === null || submittedAppearance !== knownAppearance)
        ? submittedAppearance
        : latest.appearance_json;
      this.sql.exec(
        `UPDATE automation_directory
            SET current_definition_revision = ?, title = ?, description = ?, scope = ?,
                appearance_json = ?, chat_appearance_json = COALESCE(?, chat_appearance_json), updated_at = ?
          WHERE automation_id = ?`,
        definitionRevision,
        request.draft.name,
        request.draft.description,
        scope,
        appearance,
        submittedAppearance,
        now,
        this.sidekickId,
      );
      this.touchDirectory(now);
      return definitionRevision;
    });
    return { definitionRevision: revision, ready: request.draft.ready };
  }

  /**
   * Make the current ready revision the one that runs.
   *
   * Everything read from outside (connections, the person's timezone, the
   * email route) happens first; then one transaction writes the accepted
   * revision, replaces the schedules and their alarm entries, and replaces the
   * connector registrations. A registration that cannot be written fails the
   * whole change, so a Sidekick is never active with its registrations
   * missing. Declared memory tables are owed by a stored entry armed in the
   * same transaction, and attempted once straight after it.
   *
   * A paused Sidekick keeps its pause: `resume` is what lifts one, and a
   * Channel archive's pause must hold through an edit.
   */
  async apply(input: AutomationActorRequest): Promise<AutomationDetail> {
    const request = parseRpcInput(AutomationActorRequestSchema, input, "apply");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    if (row.lifecycle === "deleted") throw new ApiError(404, "sidekick_not_found", "This Sidekick was archived");
    await this.assertManager(row, request.actor);
    if (row.owning_room_archived_at !== null) {
      throw new ApiError(409, "sidekick_room_archived", "The Channel that owns this Sidekick is archived");
    }
    const revision = this.revision(row.current_definition_revision);
    if (!revision || revision.ready !== 1) {
      throw new ApiError(422, "sidekick_definition_not_ready", "The Sidekick's definition is not ready to apply");
    }
    if (row.lifecycle === "active" && row.accepted_definition_revision === revision.definition_revision) {
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
    this.storage.transactionSync(() => {
      const current = this.row();
      if (!current || current.current_definition_revision !== revision.definition_revision
        || current.lifecycle !== row.lifecycle || current.run_as_user_id !== row.run_as_user_id
        || current.scope !== row.scope || current.owning_room_archived_at !== row.owning_room_archived_at) {
        throw new ApiError(409, "sidekick_revision_changed", "The Sidekick changed while saving; retry the latest revision");
      }
      const paused = current.lifecycle === "paused";
      this.replaceSchedules(revision.definition_revision, prepared.schedules, paused, now);
      this.sql.exec(
        `UPDATE automation_directory
            SET lifecycle = CASE WHEN lifecycle = 'paused' THEN 'paused' ELSE 'active' END,
                accepted_definition_revision = ?, connector_bindings_json = ?, default_plugin_ids_json = ?,
                activity_source_plugin_ids_json = ?, evaluator_projection_json = ?,
                email_address = ?, loadable = ?, updated_at = ?
          WHERE automation_id = ?`,
        revision.definition_revision,
        JSON.stringify(prepared.connectorBindings),
        JSON.stringify(prepared.selections.defaultPluginIds),
        JSON.stringify(prepared.selections.activitySourcePluginIds),
        JSON.stringify(prepared.evaluators),
        emailRoute.emailAddress,
        sidekickLoadable(definition) ? 1 : 0,
        now,
        this.sidekickId,
      );
      this.writeRegistrations(paused ? [] : prepared.evaluators, now);
      if (definition.triggers.length > 0 && definition.memoryTables.length > 0) {
        this.host.alarms.schedule({
          kind: SIDEKICK_MEMORY_TABLES_ALARM_KIND,
          key: sidekickAlarmKey(this.sidekickId, String(revision.definition_revision)),
          dueAt: now,
        }, now);
      }
      this.touchDirectory(now);
    });
    await this.host.afterRegistrations(this.sidekickId, revision.definition_revision, prepared.evaluators);
    await this.materializeMemoryTables(revision.definition_revision).catch((error: unknown) => {
      // The stored entry retries on its own backoff; the publish has committed.
      logWarn(this.env, "sidekick_memory_tables_deferred", {
        ...this.logFields(), definition_revision: revision.definition_revision,
        code: error instanceof Error ? error.message : "sidekick_memory_tables_failed",
      });
    });
    return this.detail();
  }

  /** Explicit reconciliation when the loading policy changes. */
  async reconcileLoadable(input: AutomationActorRequest): Promise<{ loadable: boolean }> {
    const request = parseRpcInput(AutomationActorRequestSchema, input, "reconcile_loadable");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    await this.assertManager(row, request.actor);
    const revision = row.accepted_definition_revision === null ? null : this.revision(row.accepted_definition_revision);
    const definition = revision ? AutomationDraftSchema.parse(JSON.parse(revision.definition_json)) : null;
    // Legacy email is effective trigger configuration even when absent in JSON.
    const loadable = definition !== null && sidekickLoadable(definition);
    this.storage.transactionSync(() => {
      this.sql.exec(`UPDATE automation_directory SET loadable = ? WHERE automation_id = ?`, loadable ? 1 : 0, this.sidekickId);
      this.touchDirectory(Date.now());
    });
    return { loadable };
  }

  /**
   * Choose the Sidekick's icon or colour. The patch merges over what is stored,
   * so a colour choice cannot undo somebody's icon, and the row every client
   * reads changes in the same write.
   */
  async setAppearance(input: AutomationSetAppearanceRequest): Promise<AutomationDetail> {
    const request = parseRpcInput(AutomationSetAppearanceRequestSchema, input, "set_appearance");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    await this.assertManager(row, request.actor);
    if (row.lifecycle === "deleted") throw new ApiError(404, "sidekick_not_found", "This Sidekick was archived");
    const patch = WorkstreamAppearancePatchSchema.parse(request.appearance);
    const current = row.appearance_json
      ? WorkstreamAppearanceSchema.parse(JSON.parse(row.appearance_json))
      : { icon: null, color: null };
    const appearance = WorkstreamAppearanceSchema.parse({ ...current, ...patch });
    const now = Date.now();
    this.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE automation_directory SET appearance_json = ?, updated_at = ? WHERE automation_id = ?`,
        JSON.stringify(appearance), now, this.sidekickId,
      );
      this.touchDirectory(now);
    });
    return this.detail();
  }

  async pause(input: AutomationActorRequest): Promise<void> {
    const request = parseRpcInput(AutomationActorRequestSchema, input, "pause");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    await this.assertManager(row, request.actor);
    if (row.lifecycle === "paused") return;
    if (row.lifecycle !== "active") throw new ApiError(409, "sidekick_not_active", "Only an active Sidekick can be paused");
    this.storage.transactionSync(() => this.pauseBy("person", Date.now()));
    await this.host.afterRegistrations(this.sidekickId, null, []);
  }

  async resume(input: AutomationActorRequest): Promise<void> {
    const request = parseRpcInput(AutomationActorRequestSchema, input, "resume");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    await this.assertManager(row, request.actor);
    if (row.lifecycle === "active") return;
    if (row.lifecycle !== "paused") throw new ApiError(409, "sidekick_not_paused", "Only a paused Sidekick can be resumed");
    if (row.owning_room_archived_at !== null) {
      throw new ApiError(409, "sidekick_room_archived", "The Channel that owns this Sidekick is archived");
    }
    const evaluators = this.storage.transactionSync(() => this.resumeFromPause(Date.now()));
    await this.host.afterRegistrations(this.sidekickId, row.accepted_definition_revision, evaluators);
  }

  async remove(input: AutomationActorRequest): Promise<void> {
    const request = parseRpcInput(AutomationActorRequestSchema, input, "remove");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    await this.assertManager(row, request.actor);
    if (row.lifecycle === "deleted") return;
    const now = Date.now();
    this.storage.transactionSync(() => {
      this.stopOpenRuns(now);
      this.cancelSidekickAlarms();
      this.sql.exec(
        `UPDATE automation_directory SET lifecycle = 'deleted', updated_at = ? WHERE automation_id = ?`,
        now, this.sidekickId,
      );
      this.writeRegistrations([], now);
      this.touchDirectory(now);
    });
    await this.host.afterRegistrations(this.sidekickId, null, []);
  }

  /**
   * Archiving the home Channel pauses the Sidekick; unarchiving resumes it only
   * when the archive paused it. Called inside the archive's own transaction.
   */
  setOwningRoomArchived(input: AutomationOwningRoomArchivedRequest, now: number): { changed: boolean; outcomeCode: string } {
    const request = parseRpcInput(AutomationOwningRoomArchivedRequestSchema, input, "set_owning_room_archived");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    if (row.owning_workstream_id !== request.workstreamId) {
      return { changed: false, outcomeCode: "sidekick_not_owned_by_workstream" };
    }
    if (request.archived) {
      if (row.owning_room_archived_at !== null) return { changed: false, outcomeCode: "sidekick_room_already_archived" };
      this.sql.exec(
        `UPDATE automation_directory SET owning_room_archived_at = ?, updated_at = ? WHERE automation_id = ?`,
        now, now, this.sidekickId,
      );
      if (row.lifecycle === "active") {
        this.pauseBy("room_archive", now);
        return { changed: true, outcomeCode: "sidekick_paused" };
      }
      this.touchDirectory(now);
      return { changed: true, outcomeCode: "sidekick_room_archived" };
    }
    if (row.owning_room_archived_at === null) return { changed: false, outcomeCode: "sidekick_room_not_archived" };
    this.sql.exec(
      `UPDATE automation_directory SET owning_room_archived_at = NULL, updated_at = ? WHERE automation_id = ?`,
      now, this.sidekickId,
    );
    if (row.lifecycle === "paused" && row.paused_by === "room_archive") {
      this.resumeFromPause(now);
      return { changed: true, outcomeCode: "sidekick_resumed" };
    }
    this.touchDirectory(now);
    return { changed: true, outcomeCode: "sidekick_room_unarchived" };
  }

  async runNow(input: AutomationRunNowRequest): Promise<{ runId: string; reused: boolean }> {
    const request = parseRpcInput(AutomationRunNowRequestSchema, input, "run_now");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    await this.assertManager(row, request.actor);
    if (row.lifecycle !== "active") throw new ApiError(409, "sidekick_not_active", "Only an active Sidekick can run");
    const accepted = row.accepted_definition_revision === null ? null : this.revision(row.accepted_definition_revision);
    const definition = accepted ? AutomationDraftSchema.parse(JSON.parse(accepted.definition_json)) : null;
    if (!definition || (definition.triggers.length === 0 && !sidekickReceivesEmail(definition))) {
      throw new ApiError(409, "sidekick_not_runnable", "Use this Sidekick in a conversation");
    }
    const admitted = this.admitOccurrence(
      `manual:${request.idempotencyKey}`,
      { kind: "manual", requestedByUserId: asUserId(request.actor.userId) },
      null,
    );
    return admitted;
  }

  /**
   * Run once from a script instead of from a model, for a demo's seeded
   * history. Separate from `runNow` so no client request shape carries a seed;
   * `docs/demo-workspaces.md` owns the seeding rules.
   */
  async runSeeded(input: AutomationRunSeededRequest): Promise<{ runId: string; reused: boolean }> {
    const request = parseRpcInput(AutomationRunSeededRequestSchema, input, "run_seeded");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    await this.assertManager(row, request.actor);
    if (row.lifecycle !== "active") throw new ApiError(409, "sidekick_not_active", "Only an active Sidekick can run");
    if (request.seed.assistant === null) {
      throw new ApiError(422, "demo_seed_run_without_script", "A seeded run needs a turn to answer with");
    }
    const admitted = this.admitOccurrence(
      `seed:${request.seed.packVersion}:${request.seed.actionId}`,
      { kind: "manual", requestedByUserId: asUserId(request.actor.userId) },
      null,
      request.seed,
    );
    return admitted;
  }

  /**
   * What this delivery has to do before it may admit its event. Every check
   * `admitExternalEvent` applies lives here and is read by both.
   */
  private externalEventPlan(request: AutomationExternalEventAdmission): AutomationExternalEventPlan {
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    if (row.lifecycle !== "active") return { kind: "refuse", outcomeCode: `sidekick_${row.lifecycle}` };
    const revision = row.accepted_definition_revision === null ? null : this.revision(row.accepted_definition_revision);
    const definition = revision ? AutomationDraftSchema.parse(JSON.parse(revision.definition_json)) : null;
    if (definition?.definitionVersion === 2) {
      const sources = z.array(z.object({ evaluatorId: z.string(), source: z.object({ eventType: z.string() }) })).parse(JSON.parse(row.evaluator_projection_json));
      if (!definition.triggers.some(isExternalEventTrigger) || !sources.some((entry) => entry.evaluatorId === request.registrationId && entry.source.eventType === request.event.eventType)) {
        return { kind: "refuse", outcomeCode: "sidekick_trigger_removed" };
      }
    }
    if (row.effective_after_event_sequence === null
      || request.event.eventSequence <= row.effective_after_event_sequence) {
      return { kind: "refuse", outcomeCode: "sidekick_event_before_activation_boundary" };
    }
    const semantic = semanticConditionsForEventType(definition, request.event.eventType);
    if (semantic.conditions.length > 0) {
      return { kind: "judge", conditions: semantic.conditions, connectorType: semantic.connectorType };
    }
    // A Sidekick that gates events and whose join found none of them is
    // refused, not admitted: admitting would run it ungated.
    return semantic.gated
      ? { kind: "refuse", outcomeCode: "sidekick_semantic_condition_unresolved" }
      : { kind: "admit" };
  }

  /** Admit one matched external event, once. */
  async admitExternalEvent(input: AutomationExternalEventAdmission): Promise<{
    admitted: boolean;
    outcomeCode: string;
    judge?: { conditions: string[]; connectorType: string | null };
  }> {
    const request = parseRpcInput(AutomationExternalEventAdmissionSchema, input, "admit_external_event");
    const plan = this.externalEventPlan(request);
    if (plan.kind === "refuse") return { admitted: false, outcomeCode: plan.outcomeCode };
    if (plan.kind === "judge") {
      // The condition the member wrote is the gate: a delivery that did not
      // bring a verdict is refused, and both halves of a verdict must agree.
      // The refusal carries the conditions, so the caller can judge them and
      // ask again without a separate planning call.
      const verdict = request.conditionVerdict;
      if (!verdict) {
        return {
          admitted: false,
          outcomeCode: "sidekick_semantic_condition_unjudged",
          judge: { conditions: plan.conditions, connectorType: plan.connectorType },
        };
      }
      if (!verdict.admit || verdict.code !== "condition_met") {
        return { admitted: false, outcomeCode: `sidekick_semantic_${verdict.code}` };
      }
    }
    const admitted = this.admitOccurrence(externalEventOccurrenceKey(request.event), {
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
   * message id, so a webhook retry answers from it.
   */
  async admitInboundEmail(input: AutomationInboundEmailAdmission): Promise<{
    admitted: boolean; duplicate: boolean; outcomeCode: string; runId: string | null;
  }> {
    const request = parseRpcInput(AutomationInboundEmailAdmissionSchema, input, "admit_inbound_email");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    const existing = first(this.sql.exec<{ run_id: string | null; outcome_code: string }>(
      `SELECT run_id, outcome_code FROM sidekick_email_receipts WHERE sidekick_id = ? AND resend_email_id = ?`,
      this.sidekickId, request.resendEmailId,
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
      this.sql.exec(
        `INSERT OR IGNORE INTO sidekick_email_receipts
           (sidekick_id, resend_email_id, run_id, outcome_code, payload_ref, resource_id, received_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?)`,
        this.sidekickId, request.resendEmailId, refusal, request.payloadRef, request.resourceId, request.receivedAt,
      );
      return { admitted: false, duplicate: false, outcomeCode: refusal, runId: null };
    }
    const admitted = this.storage.transactionSync(() => {
      const run = this.admitOccurrence(
        `inbound_email:${request.resendEmailId}`,
        { kind: "inbound_email", receiptId: uuidV7(now), occurredAt: request.receivedAt },
        { textContent: request.textContent, structuredContent: request.structuredContent, resourceId: request.resourceId },
      );
      this.sql.exec(
        `INSERT OR IGNORE INTO sidekick_email_receipts
           (sidekick_id, resend_email_id, run_id, outcome_code, payload_ref, resource_id, received_at)
         VALUES (?, ?, ?, 'admitted', ?, ?, ?)`,
        this.sidekickId, request.resendEmailId, run.runId, request.payloadRef, request.resourceId, request.receivedAt,
      );
      return run;
    });
    return { admitted: true, duplicate: admitted.reused, outcomeCode: "admitted", runId: admitted.runId };
  }

  /** Instruction-use audience is independent of authoring/history admission. */
  private skillAudienceAllows(row: HostedSidekickRow, request: SidekickSkillReadRequest): boolean {
    return sidekickAudienceAllows({
      scope: row.scope,
      authorUserId: row.author_user_id,
      runAsUserId: row.run_as_user_id,
      owningWorkstreamId: row.owning_workstream_id,
    }, request);
  }

  /** Minimal rail metadata for an already admitted receiving conversation. */
  readSkillSummary(input: SidekickSkillReadRequest): SidekickAttachment | null {
    const request = SidekickSkillReadRequestSchema.parse(input);
    const row = this.row();
    if (!row) return null;
    this.assertSidekick(request.workspaceId, request.automationId);
    if (row.lifecycle === "deleted" || !this.skillAudienceAllows(row, request)) return null;
    return SidekickAttachmentSchema.parse({
      id: row.automation_id, name: row.title, description: row.description,
      available: row.lifecycle === "active" && row.loadable === 1
        && row.accepted_definition_revision !== null && row.owning_room_archived_at === null,
    });
  }

  /** What a run reads at start: its definition by revision, and how it was triggered. */
  readSkillSource(input: SidekickSkillReadRequest): SidekickSkillSource | null {
    const request = parseRpcInput(SidekickSkillReadRequestSchema, input, "read_skill_source");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    if (row.lifecycle === "deleted" || row.accepted_definition_revision === null || row.owning_room_archived_at !== null) return null;
    if (!request.existingExecution && (row.lifecycle !== "active" || row.loadable !== 1)) return null;
    if (!this.skillAudienceAllows(row, request)) return null;
    const revision = this.revision(row.accepted_definition_revision);
    if (!revision) throw new Error("sidekick_accepted_revision_missing");
    const definition = AutomationDraftSchema.parse(JSON.parse(revision.definition_json));
    return SidekickSkillSourceSchema.parse({
      id: row.automation_id, revision: revision.definition_revision, loadable: row.loadable === 1,
      name: definition.name, description: definition.description,
      whenToUse: definition.whenToUse || definition.description, instructions: definition.instructions,
    });
  }

  readRunDefinition(input: AutomationRunDefinitionRequest): AutomationRunDefinitionV1 {
    const request = parseRpcInput(AutomationRunDefinitionRequestSchema, input, "read_run_definition");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    const run = this.run(request.runId);
    if (!run) throw new ApiError(404, "sidekick_run_not_found", "This run does not exist");
    // A continued run names the revision it continued under; a scheduled start
    // names the one it was admitted under, which is the run row's own.
    const definitionRevision = request.definitionRevision ?? run.definition_revision;
    const revision = this.revision(definitionRevision);
    if (!revision) throw new ApiError(404, "sidekick_definition_not_found", "The run's definition revision is missing");
    const definition = AutomationDraftSchema.parse(JSON.parse(revision.definition_json));
    return AutomationRunDefinitionV1Schema.parse({
      schemaVersion: 1,
      automationId: row.automation_id,
      runId: run.run_id,
      definitionRevision,
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
      owningSubstreamId: row.owning_substream_id,
      runAsUserId: row.run_as_user_id,
      modelOverride: row.model_override,
      trigger: JSON.parse(run.trigger_json),
      opening: run.opening_json ? JSON.parse(run.opening_json) : null,
      state: run.state,
    });
  }

  /**
   * Whether a run may still act: its own state, and the Sidekick's.
   * `stopGeneration` counts this Sidekick's stops of its open runs, so a
   * continued run can tell a stop it was approved after from one since.
   */
  readRunState(input: AutomationRunRequest): {
    state: RunState; lifecycle: Lifecycle; completedAt: number | null; stopGeneration: number;
  } | null {
    const request = parseRpcInput(AutomationRunRequestSchema, input, "read_run_state");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    const run = this.run(request.runId);
    return run
      ? { state: run.state, lifecycle: row.lifecycle, completedAt: run.completed_at, stopGeneration: row.stop_generation }
      : null;
  }

  /**
   * Whether input that reached a run child may continue the run, and with
   * what: the `automationRun` block and run-as principal, against the
   * Sidekick's currently accepted revision. A read with no side effects.
   */
  continueRun(input: AutomationRunRequest): SidekickRunContinuation {
    const request = parseRpcInput(AutomationRunRequestSchema, input, "continue_run");
    const row = this.row();
    if (!row) return { outcome: "refused", code: "run_not_found" };
    this.assertSidekick(request.workspaceId, request.automationId);
    if (row.lifecycle === "deleted") return { outcome: "refused", code: "sidekick_deleted" };
    if (row.lifecycle === "paused") return { outcome: "refused", code: "sidekick_paused" };
    const run = this.run(request.runId);
    if (!run || row.lifecycle !== "active" || row.accepted_definition_revision === null) {
      return { outcome: "refused", code: "run_not_found" };
    }
    // The transcript the continuation would read is the run-as user's it was
    // provisioned for; a claim since then moves who the Sidekick runs as.
    if (run.run_as_user_id !== null && run.run_as_user_id !== row.run_as_user_id) {
      return { outcome: "refused", code: "run_principal_changed" };
    }
    return SidekickRunContinuationSchema.parse({
      outcome: "continue",
      automationRun: {
        schemaVersion: 1,
        automationId: asAutomationId(row.automation_id),
        runId: run.run_id,
        definitionRevision: row.accepted_definition_revision,
        trigger: JSON.parse(run.trigger_json),
      },
      executionPrincipal: { type: "user", userId: asUserId(row.run_as_user_id) },
      stopGeneration: row.stop_generation,
    });
  }

  async readDetail(input: AutomationActorRequest): Promise<AutomationDetail> {
    const request = parseRpcInput(AutomationActorRequestSchema, input, "read_detail");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    await this.assertReader(row, request.actor);
    return this.detail();
  }

  async listRuns(input: AutomationActorRequest): Promise<{ items: AutomationRun[] }> {
    const request = parseRpcInput(AutomationActorRequestSchema, input, "list_runs");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    await this.assertReader(row, request.actor);
    return { items: this.runSummaries(50) };
  }

  /**
   * Take over who this Sidekick runs as, and rebind what the last principal
   * took with them. The claimant is always the caller.
   */
  async claimExecutionPrincipal(input: AutomationActorRequest): Promise<AutomationExecutionPrincipalClaim> {
    const request = parseRpcInput(AutomationActorRequestSchema, input, "claim_execution_principal");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    await this.assertManager(row, request.actor);
    const bindings = JSON.parse(row.connector_bindings_json) as Record<string, string>;
    const connections = await this.host.workspaceDatabase(row.workspace_id).prepare(
      `SELECT id, scope, owner_user_id, model_plugin_id, status
         FROM connector_connections WHERE workspace_id = ? AND status <> 'disabled'`,
    ).bind(row.workspace_id).all<{
      id: string; scope: string; owner_user_id: string | null; model_plugin_id: string; status: string;
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
      const now = Date.now();
      this.storage.transactionSync(() => {
        this.sql.exec(
          `UPDATE automation_directory SET run_as_user_id = ?, connector_bindings_json = ?, updated_at = ?
            WHERE automation_id = ?`,
          request.actor.userId, JSON.stringify(next), now, this.sidekickId,
        );
        this.touchDirectory(now);
      });
    }
    return AutomationExecutionPrincipalClaimSchema.parse({
      principalUserId: request.actor.userId,
      reboundPluginIds: rebound,
      unboundProviders: unbound,
      changed,
    });
  }

  // ---------------------------------------------------------------------------
  // The conversation-parent contract.
  // ---------------------------------------------------------------------------

  /**
   * The conversation-parent viewer check (`sidekickViewer`), or with
   * `requireGrantAuthority` the guest path (`sidekickGrantViewer`): a guest
   * reaches a Channel- or Breakout-homed Sidekick through that place's grants,
   * and nothing else.
   */
  async authorizeViewer(input: ConversationParentAuthorizeViewerRequest): Promise<ConversationParentAuthorizeViewerResult> {
    const request = parseRpcInput(ConversationParentAuthorizeViewerRequestSchema, input, "authorize_viewer");
    const row = this.row();
    if (!row || row.lifecycle === "deleted") {
      return ConversationParentAuthorizeViewerResultSchema.parse({ authorized: false, archived: true });
    }
    this.assertSidekick(request.workspaceId, request.parentId);
    if (request.requireGrantAuthority) return this.sidekickGrantViewer(row, request.userId);
    return ConversationParentAuthorizeViewerResultSchema.parse({
      authorized: await this.sidekickViewer(row, request.userId),
      archived: row.owning_room_archived_at !== null,
    });
  }

  /** Who may read a Sidekick's conversations. */
  private async sidekickViewer(row: HostedSidekickRow, userId: string): Promise<boolean> {
    if (row.scope === "workspace" || row.author_user_id === userId || row.run_as_user_id === userId) return true;
    if (row.scope !== "workstream") return false;
    return homeAdmits(row, userId, this.host);
  }

  /** A guest's path: the home Channel's grants, or a Breakout home's own. */
  private async sidekickGrantViewer(row: HostedSidekickRow, userId: string): Promise<ConversationParentAuthorizeViewerResult> {
    if (row.scope !== "workstream" || !row.owning_workstream_id) {
      return ConversationParentAuthorizeViewerResultSchema.parse({ authorized: false, archived: false });
    }
    if (row.owning_substream_id !== "0") {
      const home = await this.host.channelViewer({
        workspaceId: row.workspace_id, parentId: row.owning_workstream_id,
        substreamId: row.owning_substream_id, userId, requireGrantAuthority: true,
      });
      return ConversationParentAuthorizeViewerResultSchema.parse({
        authorized: home.authorized, archived: row.owning_room_archived_at !== null || home.archived,
      });
    }
    const access = await this.host.readManagementAccess({
      workspaceId: row.workspace_id, parentId: row.owning_workstream_id, userId,
    });
    return ConversationParentAuthorizeViewerResultSchema.parse({
      authorized: access.allowed,
      archived: row.owning_room_archived_at !== null || (access.allowed && !access.writable),
    });
  }

  authorizationDiscoveryChildren(input: ConversationParentAuthorityRequest): { substreamIds: string[] } {
    const request = parseRpcInput(ConversationParentAuthorityRequestSchema, input, "authorization_discovery_children");
    const row = this.row();
    if (!row || row.lifecycle === "deleted") return { substreamIds: [] };
    this.assertSidekick(request.workspaceId, request.parentId);
    // A registered, unprovisioned child is unresolved authority, not evidence
    // that its content can be discarded.
    return { substreamIds: this.childRegistry().map((child) => child.substreamId) };
  }

  /** No participant admission and no projection-dependent permission decision. */
  readAuthorizationFacts(input: ConversationAuthorizationRequest) {
    const request = parseRpcInput(ConversationAuthorizationRequestSchema, input, "read_authorization_facts");
    const row = this.row();
    if (!row || row.lifecycle === "deleted") return { exists: false as const, validatedAt: Date.now() };
    this.assertSidekick(request.workspaceId, request.parentId);
    return {
      exists: true as const, scope: row.scope, owningWorkstreamId: row.owning_workstream_id,
      owningSubstreamId: row.owning_substream_id,
      author: row.author_user_id === request.userId, executor: row.run_as_user_id === request.userId,
      children: this.childRegistry().map((child) => child.substreamId),
      revision: JSON.stringify([row.authority_generation, row.updated_at]), validatedAt: Date.now(),
    };
  }

  authority(input: ConversationParentAuthorityRequest): ConversationParentAuthorityResult {
    const request = parseRpcInput(ConversationParentAuthorityRequestSchema, input, "authority");
    const row = this.row();
    if (!row) return ConversationParentAuthorityResultSchema.parse({ exists: false, authorityGeneration: 0, archived: false });
    this.assertSidekick(request.workspaceId, request.parentId);
    return ConversationParentAuthorityResultSchema.parse({
      exists: true,
      authorityGeneration: row.authority_generation,
      archived: row.lifecycle === "deleted" || row.owning_room_archived_at !== null,
    });
  }

  /** Reserve against current parent authority without a caller-side preflight call. */
  reserveAgentChild(input: Omit<ConversationParentReserveChildRequest, "authorityGeneration" | "directory" | "kind">): ConversationParentReserveChildResult {
    const authority = this.authority({ workspaceId: input.workspaceId, parentId: input.parentId });
    if (!authority.exists || authority.archived) throw new Error("workstream_archived");
    return this.reserveChild({ ...input, kind: "child", authorityGeneration: authority.authorityGeneration });
  }

  reserveChild(input: ConversationParentReserveChildRequest): ConversationParentReserveChildResult {
    const request = parseRpcInput(ConversationParentReserveChildRequestSchema, input, "reserve_child");
    const row = this.assertSidekick(request.workspaceId, request.parentId);
    if (request.kind === "child" && (row.lifecycle === "deleted" || row.owning_room_archived_at !== null)) {
      throw new Error("workstream_archived");
    }
    this.registerChild(request.substreamId, request.kind, request.createdByUserId, Date.now());
    return ConversationParentReserveChildResultSchema.parse({ reserved: true, authorityGeneration: row.authority_generation });
  }

  /** The children whose own projection names a terminal action, soonest first. */
  childTerminalDeadlines(input: ConversationParentTerminalDeadlinesRequest): ConversationParentTerminalDeadlinesResult {
    const request = ConversationParentTerminalDeadlinesRequestSchema.parse(input);
    this.assertSidekick(request.workspaceId, request.parentId);
    return ConversationParentTerminalDeadlinesResultSchema.parse({
      items: this.sql.exec<{ substream_id: string; next_terminal_action_at: string }>(
        `SELECT substream_id, json_extract(effect_json, '$.nextTerminalActionAt') AS next_terminal_action_at
           FROM sidekick_child_projections
          WHERE sidekick_id = ? AND json_extract(effect_json, '$.kind') = 'directory_common'
            AND json_extract(effect_json, '$.nextTerminalActionAt') IS NOT NULL
          ORDER BY next_terminal_action_at, substream_id`,
        this.sidekickId,
      ).toArray().map((row) => ({ substreamId: row.substream_id, nextTerminalActionAt: row.next_terminal_action_at })),
    });
  }

  listChildren(input: ConversationParentListChildrenRequest): ConversationParentListChildrenResult {
    const request = ConversationParentListChildrenRequestSchema.parse(input);
    this.assertSidekick(request.workspaceId, request.parentId);
    return ConversationParentListChildrenResultSchema.parse({ children: this.childRegistry() });
  }

  /** The children the retirement walk closes; `missing` when no row exists. */
  childrenForRetirement(): { status: "missing" } | { status: "ok"; children: ReturnType<HostedSidekick["childRegistry"]> } {
    return this.row() ? { status: "ok", children: this.childRegistry() } : { status: "missing" };
  }

  /**
   * Apply one batch of a run's or the authoring conversation's effects. Each
   * envelope is its own transaction; nothing leaves this object, and a
   * redelivery is answered by its receipt.
   */
  receiveChildEffects(input: ReceiveChildEffectsRequest): { messageId: string; payloadHash: string }[] {
    const request = parseRpcInput(ReceiveChildEffectsRequestSchema, input, "receive_child_effects");
    const accepted: { messageId: string; payloadHash: string }[] = [];
    for (const envelope of request.envelopes) {
      if (envelope.region !== this.env.AVALON_REGION) throw new Error("conversation_effect_region_mismatch");
      if (envelope.substreamId !== request.substreamId) throw new Error("conversation_effect_substream_mismatch");
      this.applyChildEnvelope(request.substreamId, envelope);
      accepted.push({ messageId: envelope.messageId, payloadHash: envelope.payloadHash });
    }
    return accepted;
  }

  private applyChildEnvelope(substreamId: string, envelope: ConversationEffectEnvelope): void {
    this.storage.transactionSync(() => {
      const now = Date.now();
      if (envelope.parentKind !== "automation") throw new Error("sidekick_effect_parent_kind_mismatch");
      const row = this.row();
      if (!row) throw new Error("sidekick_missing");
      if (row.workspace_id !== envelope.workspaceId || row.automation_id !== envelope.parentId) {
        throw new Error("sidekick_effect_identity_mismatch");
      }
      const receipt = first(this.sql.exec<{ payload_hash: string }>(
        `SELECT payload_hash FROM sidekick_child_receipts WHERE sidekick_id = ? AND substream_id = ? AND message_id = ?`,
        this.sidekickId, substreamId, envelope.messageId,
      ));
      if (receipt) {
        if (receipt.payload_hash !== envelope.payloadHash) throw new Error("substream_effect_idempotency_conflict");
        return;
      }
      if (envelope.effect.kind === "directory_common" && this.acceptChildProjection(substreamId, envelope, now)) {
        this.onChildCommonProjection(substreamId, envelope.effect, now);
      }
      this.sql.exec(
        `INSERT INTO sidekick_child_receipts(sidekick_id, substream_id, message_id, payload_hash, received_at)
         VALUES (?, ?, ?, ?, ?)`,
        this.sidekickId, substreamId, envelope.messageId, envelope.payloadHash, now,
      );
      // The receipt is a replay fence, not history: past retention a
      // redelivery converges on the projection's version.
      this.sql.exec(
        `DELETE FROM sidekick_child_receipts
          WHERE (sidekick_id, substream_id, message_id) IN (
            SELECT sidekick_id, substream_id, message_id FROM sidekick_child_receipts
             WHERE received_at < ? ORDER BY received_at LIMIT 100
          )`,
        now - CHILD_EFFECT_RECEIPT_RETENTION_MS,
      );
    });
  }

  /** Keep a child's newest common projection; `false` for one that is not newer. */
  private acceptChildProjection(substreamId: string, envelope: ConversationEffectEnvelope, now: number): boolean {
    const existing = first(this.sql.exec<{ source_version: number; payload_hash: string }>(
      `SELECT source_version, payload_hash FROM sidekick_child_projections WHERE sidekick_id = ? AND substream_id = ?`,
      this.sidekickId, substreamId,
    ));
    if (existing && existing.source_version > envelope.sourceVersion) return false;
    if (existing?.source_version === envelope.sourceVersion) {
      if (existing.payload_hash === envelope.payloadHash) return false;
      // The child is the authority for its own projection and restarts its
      // counter when a maintenance import rebuilds it, so the newer bytes win.
      logWarn(this.env, "substream_projection_version_reused", {
        ...this.logFields(), substream_id: substreamId, source_version: envelope.sourceVersion,
      });
    }
    this.sql.exec(
      `INSERT INTO sidekick_child_projections(sidekick_id, substream_id, source_version, payload_hash, effect_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(sidekick_id, substream_id) DO UPDATE SET source_version = excluded.source_version,
         payload_hash = excluded.payload_hash, effect_json = excluded.effect_json, updated_at = excluded.updated_at`,
      this.sidekickId, substreamId, envelope.sourceVersion, envelope.payloadHash, JSON.stringify(envelope.effect), now,
    );
    return true;
  }

  /**
   * A run's conversation moved; the run row follows it, driven by the
   * accepted projection only, so a stale `completed` from an earlier
   * activation cannot close a continued run. A finished run reopens only on a
   * live state other than `idle`, and only while the Sidekick is active; one
   * finished state never replaces another.
   */
  private onChildCommonProjection(substreamId: string, effect: DirectoryCommonEffect, now: number): void {
    if (substreamId === "0") return;
    const next = RUN_STATE_FROM_CONVERSATION_STATE[effect.state] ?? null;
    if (next === null) return;
    const run = this.run(substreamId);
    if (!run) return;
    const summary = effect.preview || null;
    const finished = TERMINAL_RUN_STATES.has(run.state);
    const live = !TERMINAL_RUN_STATES.has(next);
    const reopens = finished && live && effect.state !== "idle" && this.row()?.lifecycle === "active";
    if (run.state === next || (finished && !reopens)) {
      if (!finished) {
        this.sql.exec(
          `UPDATE sidekick_runs SET summary = ?, updated_at = ? WHERE sidekick_id = ? AND run_id = ?`,
          summary, now, this.sidekickId, substreamId,
        );
      }
      return;
    }
    this.sql.exec(
      `UPDATE sidekick_runs
          SET state = ?, summary = ?, completed_at = CASE WHEN ? THEN ? ELSE completed_at END, updated_at = ?
        WHERE sidekick_id = ? AND run_id = ?`,
      next, summary, live ? 0 : 1, now, now, this.sidekickId, substreamId,
    );
  }

  // ---------------------------------------------------------------------------
  // Alarm entries: schedules fire, runs are handed to provisioning, memory
  // tables are materialized.
  // ---------------------------------------------------------------------------

  async runAlarm(alarm: ScheduledAlarm, innerKey: string): Promise<ScheduledAlarmOutcome> {
    if (alarm.kind === AUTOMATION_SCHEDULE_ALARM_KIND) {
      await this.executeSchedule(innerKey);
      return { progressed: true };
    }
    if (alarm.kind === AUTOMATION_RUN_ALARM_KIND) return this.startRun(innerKey, alarm.attempt);
    if (alarm.kind === SIDEKICK_MEMORY_TABLES_ALARM_KIND) {
      await this.materializeMemoryTables(Number(innerKey));
      return { progressed: true };
    }
    throw new Error(`sidekick_unknown_alarm_kind:${alarm.kind}`);
  }

  private async executeSchedule(scheduleId: string): Promise<void> {
    const row = this.row();
    const schedule = first(this.sql.exec<ScheduleRow>(
      `SELECT schedule_id, schedule_kind, definition_json, next_due_at FROM sidekick_schedules
        WHERE sidekick_id = ? AND schedule_id = ?`,
      this.sidekickId, scheduleId,
    ));
    if (!row || !schedule || schedule.next_due_at === null || row.lifecycle !== "active") return;
    const now = Date.now();
    const dueAt = schedule.next_due_at;
    const nextDueAt = scheduleDueAfter(schedule.schedule_kind, schedule.definition_json, now);
    this.storage.transactionSync(() => {
      this.admitOccurrence(`schedule:${scheduleId}:${dueAt}`, {
        kind: "schedule",
        scheduleId,
        scheduleKind: schedule.schedule_kind,
        plannedFor: dueAt,
      }, null);
      this.sql.exec(
        `UPDATE sidekick_schedules SET next_due_at = ?, updated_at = ? WHERE sidekick_id = ? AND schedule_id = ?`,
        nextDueAt, now, this.sidekickId, scheduleId,
      );
      if (nextDueAt !== null) {
        this.host.alarms.schedule({
          kind: AUTOMATION_SCHEDULE_ALARM_KIND, key: sidekickAlarmKey(this.sidekickId, scheduleId), dueAt: nextDueAt,
        }, now);
      }
      this.touchDirectory(now);
    });
  }

  /**
   * Record one occurrence and arm the entry that starts its run, in the
   * caller's transaction. Idempotent on the occurrence key: a retried
   * admission answers with the run it already made. The run id is also the
   * child substream id.
   */
  private admitOccurrence(
    occurrenceKey: string,
    trigger: AutomationRunTriggerV1,
    opening: { textContent: string; structuredContent: Record<string, unknown>; resourceId: string | null } | null,
    seed: DemoSeed | null = null,
  ): { runId: string; reused: boolean } {
    const row = this.row();
    if (!row || row.accepted_definition_revision === null) {
      throw new ApiError(409, "sidekick_not_active", "The Sidekick has no accepted definition");
    }
    const now = Date.now();
    const runId = uuidV7(now);
    const inserted = this.sql.exec<{ run_id: string }>(
      `INSERT OR IGNORE INTO sidekick_runs
         (sidekick_id, run_id, occurrence_key, trigger_json, definition_revision, harness_run_id, state,
          summary, opening_json, seed_json, created_at, started_at, completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, ?, NULL, NULL, ?)
       RETURNING run_id`,
      this.sidekickId,
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
      const existing = first(this.sql.exec<{ run_id: string; state: string }>(
        `SELECT run_id, state FROM sidekick_runs WHERE sidekick_id = ? AND occurrence_key = ?`,
        this.sidekickId, occurrenceKey,
      ));
      if (!existing) throw new Error("sidekick_occurrence_missing");
      if (existing.state === "pending") this.armRunStart(existing.run_id, now);
      return { runId: existing.run_id, reused: true };
    }
    this.armRunStart(runId, now);
    return { runId, reused: false };
  }

  private armRunStart(runId: string, now: number): void {
    this.host.alarms.schedule({ kind: AUTOMATION_RUN_ALARM_KIND, key: sidekickAlarmKey(this.sidekickId, runId), dueAt: now }, now);
  }

  /**
   * Hand a pending run to provisioning, without waiting on it.
   *
   * Records whose transcript the run will hold and registers its child first,
   * because `continueRun` relies on both; then one Queue message, whose
   * consumer opens the child and starts its loop and reports back with
   * `runProvisioned`. The entry stays armed until that report, and sends again
   * on its own backoff if none comes; every step of provisioning is idempotent
   * on the run id. Awaiting the child here would hold every other alarm job in
   * the Organization behind one cold conversation.
   */
  private async startRun(runId: string, attempt: number): Promise<ScheduledAlarmOutcome> {
    const row = this.row();
    const run = this.run(runId);
    if (!row || !run || run.state !== "pending") return { progressed: true };
    const now = Date.now();
    if (row.lifecycle !== "active") {
      this.sql.exec(
        `UPDATE sidekick_runs SET state = 'stopped', completed_at = ?, updated_at = ? WHERE sidekick_id = ? AND run_id = ?`,
        now, now, this.sidekickId, runId,
      );
      return { progressed: true };
    }
    this.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE sidekick_runs SET run_as_user_id = COALESCE(run_as_user_id, ?) WHERE sidekick_id = ? AND run_id = ?`,
        row.run_as_user_id, this.sidekickId, runId,
      );
      this.registerChild(runId, "child", null, now);
    });
    await this.host.sendRunProvision({ workspaceId: row.workspace_id, automationId: this.sidekickId, runId });
    return { waitMs: scheduledAlarmRetryDelay(attempt + 1) };
  }

  /** What the provisioning consumer needs for one pending run; `null` once it is not pending. */
  runProvisioning(input: AutomationRunRequest): SidekickRunProvisioning | null {
    const request = parseRpcInput(AutomationRunRequestSchema, input, "run_provisioning");
    const row = this.assertSidekick(request.workspaceId, request.automationId);
    const run = this.run(request.runId);
    if (!run || run.state !== "pending" || row.lifecycle !== "active") return null;
    return {
      region: row.region,
      workspaceId: row.workspace_id,
      automationId: row.automation_id,
      runId: run.run_id,
      harnessRunId: run.harness_run_id,
      runAsUserId: run.run_as_user_id ?? row.run_as_user_id,
      modelOverride: row.model_override,
      definitionRevision: run.definition_revision,
      definition: this.readRunDefinition(request),
      seedJson: run.seed_json,
    };
  }

  /** The provisioning consumer started the run's loop: mark it running and settle its entry. */
  runProvisioned(input: AutomationRunRequest): void {
    const request = parseRpcInput(AutomationRunRequestSchema, input, "run_provisioned");
    this.assertSidekick(request.workspaceId, request.automationId);
    const now = Date.now();
    this.storage.transactionSync(() => {
      this.sql.exec(
        `UPDATE sidekick_runs SET state = 'running', started_at = ?, updated_at = ?
          WHERE sidekick_id = ? AND run_id = ? AND state = 'pending'`,
        now, now, this.sidekickId, request.runId,
      );
      this.host.alarms.cancel(AUTOMATION_RUN_ALARM_KIND, sidekickAlarmKey(this.sidekickId, request.runId));
    });
  }

  /**
   * Materialize the memory tables an accepted revision declares. A revision
   * that is no longer the accepted one owes nothing, so an older publish never
   * acts after a newer one.
   */
  private async materializeMemoryTables(definitionRevision: number): Promise<void> {
    const row = this.row();
    if (!row || row.lifecycle === "deleted" || row.accepted_definition_revision !== definitionRevision) {
      this.host.alarms.cancel(SIDEKICK_MEMORY_TABLES_ALARM_KIND, sidekickAlarmKey(this.sidekickId, String(definitionRevision)));
      return;
    }
    const revision = this.revision(definitionRevision);
    if (!revision) throw new Error("sidekick_accepted_revision_missing");
    const definition = AutomationDraftSchema.parse(JSON.parse(revision.definition_json));
    if (definition.triggers.length > 0) {
      await materializeAutomationMemoryTables(this.env, {
        workspaceId: row.workspace_id,
        automationId: row.automation_id,
        definitionRevision,
        runAsUserId: row.run_as_user_id,
        tables: definition.memoryTables,
      });
    }
    this.host.alarms.cancel(SIDEKICK_MEMORY_TABLES_ALARM_KIND, sidekickAlarmKey(this.sidekickId, String(definitionRevision)));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle helpers, each inside the caller's transaction.
  // ---------------------------------------------------------------------------

  private pauseBy(by: "person" | "room_archive", now: number): void {
    this.stopOpenRuns(now);
    this.cancelSidekickAlarms();
    this.sql.exec(
      `UPDATE automation_directory SET lifecycle = 'paused', paused_by = ?, updated_at = ? WHERE automation_id = ?`,
      by, now, this.sidekickId,
    );
    this.writeRegistrations([], now);
    this.touchDirectory(now);
  }

  /** Returns the registrations it restored, for the caller's post-commit step. */
  private resumeFromPause(now: number): unknown[] {
    const row = this.row();
    if (!row) throw new Error("sidekick_missing");
    for (const schedule of this.schedules()) {
      const nextDueAt = scheduleDueAfter(schedule.schedule_kind, schedule.definition_json, now);
      this.sql.exec(
        `UPDATE sidekick_schedules SET next_due_at = ?, updated_at = ? WHERE sidekick_id = ? AND schedule_id = ?`,
        nextDueAt, now, this.sidekickId, schedule.schedule_id,
      );
      if (nextDueAt !== null) {
        this.host.alarms.schedule({
          kind: AUTOMATION_SCHEDULE_ALARM_KIND, key: sidekickAlarmKey(this.sidekickId, schedule.schedule_id), dueAt: nextDueAt,
        }, now);
      }
    }
    this.sql.exec(
      `UPDATE automation_directory SET lifecycle = 'active', paused_by = NULL, updated_at = ? WHERE automation_id = ?`,
      now, this.sidekickId,
    );
    const evaluators = JSON.parse(row.evaluator_projection_json) as unknown[];
    this.writeRegistrations(evaluators, now);
    this.touchDirectory(now);
    return evaluators;
  }

  private stopOpenRuns(now: number): void {
    this.sql.exec(
      `UPDATE sidekick_runs SET state = 'stopped', completed_at = ?, updated_at = ?
        WHERE sidekick_id = ? AND state IN ('pending', 'running', 'needs_input')`,
      now, now, this.sidekickId,
    );
    // In the same transaction as the stop, so no continuation can be approved
    // between the two and read the old count with the new stop.
    this.sql.exec(
      `UPDATE automation_directory SET stop_generation = stop_generation + 1 WHERE automation_id = ?`,
      this.sidekickId,
    );
  }

  /**
   * Cancel this Sidekick's schedule and run-start entries, and no other
   * Sidekick's: every entry key starts with the Sidekick's id.
   */
  private cancelSidekickAlarms(): void {
    const prefix = sidekickAlarmKey(this.sidekickId, "");
    for (const kind of [AUTOMATION_SCHEDULE_ALARM_KIND, AUTOMATION_RUN_ALARM_KIND]) {
      for (const alarm of this.host.alarms.list(kind)) {
        if (alarm.key.startsWith(prefix)) this.host.alarms.cancel(kind, alarm.key);
      }
    }
  }

  /** The schedules of a newly accepted revision, and their entries, replacing the last ones. */
  private replaceSchedules(definitionRevision: number, schedules: readonly PreparedSchedule[], paused: boolean, now: number): void {
    for (const previous of this.schedules()) {
      this.host.alarms.cancel(AUTOMATION_SCHEDULE_ALARM_KIND, sidekickAlarmKey(this.sidekickId, previous.schedule_id));
    }
    this.sql.exec(`DELETE FROM sidekick_schedules WHERE sidekick_id = ?`, this.sidekickId);
    for (const schedule of schedules) {
      this.sql.exec(
        `INSERT INTO sidekick_schedules
           (sidekick_id, schedule_id, definition_revision, schedule_kind, definition_json, next_due_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        this.sidekickId, schedule.id, definitionRevision, schedule.kind, JSON.stringify(schedule.definition),
        schedule.nextDueAt, now,
      );
      if (!paused) {
        this.host.alarms.schedule({
          kind: AUTOMATION_SCHEDULE_ALARM_KIND, key: sidekickAlarmKey(this.sidekickId, schedule.id), dueAt: schedule.nextDueAt,
        }, now);
      }
    }
  }

  /** This Sidekick's registrations, replaced whole, and the event sequence they take effect after. */
  private writeRegistrations(evaluators: readonly unknown[], now: number): void {
    const cutoff = this.host.writeRegistrations(this.sidekickId, evaluators);
    this.sql.exec(
      `UPDATE automation_directory SET effective_after_event_sequence = ?, updated_at = ? WHERE automation_id = ?`,
      cutoff, now, this.sidekickId,
    );
  }

  /**
   * Everything applying a revision needs from outside: which connection each
   * selected plugin binds to, the registrations the Organization will match
   * on, and the schedules with their first due instants. Every registration
   * is parsed against the shape the Organization stores, here, so a refusal
   * names its field before anything is written.
   */
  private async prepareApplication(
    row: HostedSidekickRow,
    revision: RevisionRow,
    definition: AutomationDraft,
    actorUserId: string,
  ): Promise<{
    selections: ReturnType<typeof automationAcceptanceSelections>;
    connectorBindings: Record<string, string>;
    evaluators: unknown[];
    schedules: PreparedSchedule[];
  }> {
    const selections = automationAcceptanceSelections(definition);
    const selectedPluginIds = [...new Set([
      ...selections.defaultPluginIds,
      ...Object.values(selections.activitySourcePluginIds),
    ])];
    const database = this.host.workspaceDatabase(row.workspace_id);
    const connections = selectedPluginIds.length === 0
      ? { results: [] }
      : await database.prepare(
        `SELECT id, connector_type, scope, owner_user_id, model_plugin_id, status, config_json
           FROM connector_connections WHERE workspace_id = ? AND status <> 'disabled'`,
      ).bind(row.workspace_id).all<{
        id: string; connector_type: string; scope: string; owner_user_id: string | null;
        model_plugin_id: string; status: string; config_json: string | null;
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
      // A workspace connection or your own personal one, never somebody
      // else's: binding a colleague's credentials to a standing Sidekick would
      // lend them to something they never agreed to.
      if (row.scope !== "workspace" && connection.scope === "personal"
        && connection.owner_user_id !== actorUserId && connection.owner_user_id !== row.run_as_user_id) {
        throw new ApiError(422, "sidekick_personal_connection_access_denied", "That connection belongs to somebody else");
      }
      connectorBindings[pluginId] = connection.id;
    }

    const registry = connectorRegistryForEnv(this.env);
    // The drafting tool's normalization, so a revision written before it
    // existed is read the same way.
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
    if (blocker) throw new ApiError(422, blocker, "The Sidekick's definition cannot be applied");
    const selectedByBinding = new Map(Object.entries(selections.activitySourcePluginIds));
    const inspectedPlugins = new Map<string, {
      pluginId: string;
      activityTriggers: ReturnType<typeof registry.get>["manifest"]["activityTriggers"];
      eventFamilies: Record<string, string[]>;
    }>();
    for (const evaluator of rules.evaluators) {
      const connection = connectionsByPlugin.get(evaluator.source.suggestedSourcePluginId);
      if (!connection) throw new ApiError(422, "sidekick_plugin_unavailable", "An evaluator names a plugin with no connection");
      if (connection.connector_type === "canva" && !evaluator.source.resourceId) {
        throw new ApiError(422, "canva_trigger_requires_design", "Choose a Canva design for this trigger.");
      }
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
      const resource = await database.prepare(
        `SELECT id, connection_id, resource_type FROM resources WHERE workspace_id = ? AND id = ?`,
      ).bind(row.workspace_id, evaluator.source.resourceId).first<{
        id: string; connection_id: string | null; resource_type: string;
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
      : validateDraftEvaluatorRules(rules, { inspectedPlugins, personIds: resolvedPersonIds, resources: referencedResources });
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
    // The shape the Organization stores, checked before the transaction so a
    // refusal names the field that failed rather than aborting a write.
    const checked = ExternalEventRegistrationProjectionV1Schema.safeParse({
      schemaVersion: 1,
      workspaceId: row.workspace_id,
      destination: { kind: "automation", automationId: row.automation_id },
      evaluators,
    });
    if (!checked.success) {
      throw new ApiError(422, zodDiagnosticCode(checked.error, "sidekick_registration") ?? "sidekick_registration_invalid",
        "A trigger of this Sidekick cannot be registered");
    }

    const now = Date.now();
    const needsDefaultTimezone = definition.triggers.some(
      (trigger) => trigger.type === "calendar" && trigger.timezone === null,
    );
    const timezone = needsDefaultTimezone ? await this.defaultTimezone(row) : "UTC";
    const schedules: PreparedSchedule[] = [];
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

  private async defaultTimezone(row: HostedSidekickRow): Promise<string> {
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
  // Reads and the directory.
  // ---------------------------------------------------------------------------

  /** The Sidekick's row, once it is hosted: a row whose definition columns are still empty is one awaiting import. */
  row(): HostedSidekickRow | null {
    const row = first(this.sql.exec<HostedSidekickRow>(
      `SELECT * FROM automation_directory WHERE automation_id = ? AND region IS NOT NULL`, this.sidekickId,
    ));
    return row;
  }

  private assertSidekick(workspaceId: string, automationId: string): HostedSidekickRow {
    const row = this.row();
    if (!row) throw new ApiError(404, "sidekick_not_found", "This Sidekick does not exist");
    if (row.workspace_id !== workspaceId || row.automation_id !== automationId) {
      throw new Error("sidekick_identity_mismatch");
    }
    return row;
  }

  private revision(definitionRevision: number): RevisionRow | null {
    if (definitionRevision <= 0) return null;
    return first(this.sql.exec<RevisionRow>(
      `SELECT definition_revision, definition_json, evaluator_rules_json, ready, created_at
         FROM sidekick_revisions WHERE sidekick_id = ? AND definition_revision = ?`,
      this.sidekickId, definitionRevision,
    ));
  }

  private schedules(): ScheduleRow[] {
    return this.sql.exec<ScheduleRow>(
      `SELECT schedule_id, schedule_kind, definition_json, next_due_at FROM sidekick_schedules
        WHERE sidekick_id = ? ORDER BY schedule_id`,
      this.sidekickId,
    ).toArray();
  }

  private run(runId: string): RunRow | null {
    return first(this.sql.exec<RunRow>(
      `SELECT run_id, occurrence_key, trigger_json, definition_revision, harness_run_id, state, summary,
              opening_json, seed_json, run_as_user_id, created_at, started_at, completed_at, updated_at
         FROM sidekick_runs WHERE sidekick_id = ? AND run_id = ?`,
      this.sidekickId, runId,
    ));
  }

  /** Record a child; `false` when it was already there. */
  private registerChild(substreamId: string, kind: "main" | "child", createdByUserId: string | null, now: number): boolean {
    return this.sql.exec<{ substream_id: string }>(
      `INSERT OR IGNORE INTO sidekick_children(sidekick_id, substream_id, kind, created_by_user_id, created_at)
       VALUES (?, ?, ?, ?, ?) RETURNING substream_id`,
      this.sidekickId, substreamId, kind, createdByUserId, now,
    ).toArray().length === 1;
  }

  /** Every child this Sidekick knows, the authoring conversation first; `"0"` always. */
  childRegistry(): { substreamId: string; kind: "main" | "child"; createdAt: number }[] {
    const rows = this.sql.exec<{ substream_id: string; kind: "main" | "child"; created_at: number }>(
      `SELECT substream_id, kind, created_at FROM sidekick_children WHERE sidekick_id = ?
        ORDER BY CASE WHEN substream_id = '0' THEN 0 ELSE 1 END, created_at, substream_id`,
      this.sidekickId,
    ).toArray();
    const children = rows.map((row) => ({ substreamId: row.substream_id, kind: row.kind, createdAt: row.created_at }));
    if (!children.some((child) => child.substreamId === "0")) children.unshift({ substreamId: "0", kind: "main", createdAt: 0 });
    return children;
  }

  /** Who may change a Sidekick (`sidekickManager`). */
  private async assertManager(row: HostedSidekickRow, actor: AutomationActor): Promise<void> {
    if (row.scope === "workstream") {
      // The home's people manage it, and so does the person who asked for it.
      if (row.author_user_id === actor.userId || await homeAdmits(row, actor.userId, this.host)) return;
      throw forbidden();
    }
    if (row.author_user_id === actor.userId || row.run_as_user_id === actor.userId) return;
    if (row.scope === "workspace" && (actor.actorRole === "owner" || actor.actorRole === "admin")) return;
    throw forbidden();
  }

  /** The management API's read check (`sidekickReader`). */
  private async assertReader(row: HostedSidekickRow, actor: AutomationActor): Promise<void> {
    if (row.lifecycle === "deleted") throw new ApiError(404, "sidekick_not_found", "This Sidekick was archived");
    if (await sidekickReaderAllows(row, { userId: actor.userId, actorRole: actor.actorRole ?? null }, this.host)) return;
    throw new ApiError(404, "sidekick_not_found", "This Sidekick does not exist");
  }

  private nextRunAt(row: HostedSidekickRow): number | null {
    if (row.lifecycle !== "active") return null;
    return first(this.sql.exec<{ next_due_at: number | null }>(
      `SELECT MIN(next_due_at) AS next_due_at FROM sidekick_schedules WHERE sidekick_id = ?`, this.sidekickId,
    ))?.next_due_at ?? null;
  }

  detail(): AutomationDetail {
    const row = this.row();
    if (!row) throw new ApiError(404, "sidekick_not_found", "This Sidekick does not exist");
    if (row.lifecycle === "deleted") throw new ApiError(404, "sidekick_not_found", "This Sidekick was archived");
    const current = this.revision(row.current_definition_revision);
    const accepted = row.accepted_definition_revision === null ? null : this.revision(row.accepted_definition_revision);
    const acceptedDefinition = accepted ? AutomationDraftSchema.parse(JSON.parse(accepted.definition_json)) : null;
    const lastRunAt = first(this.sql.exec<{ created_at: number }>(
      `SELECT created_at FROM sidekick_runs WHERE sidekick_id = ? ORDER BY created_at DESC LIMIT 1`, this.sidekickId,
    ))?.created_at ?? null;
    return AutomationDetailSchema.parse({
      id: row.automation_id,
      ...(row.appearance_json ? { appearance: WorkstreamAppearanceSchema.parse(JSON.parse(row.appearance_json)) } : {}),
      name: row.title || "New Sidekick",
      loadable: row.loadable === 1,
      description: row.description,
      emailAddress: acceptedDefinition !== null && sidekickReceivesEmail(acceptedDefinition) ? row.email_address : null,
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
      runnable: acceptedDefinition !== null
        && (acceptedDefinition.triggers.length > 0 || sidekickReceivesEmail(acceptedDefinition)),
      connectorBindings: JSON.parse(row.connector_bindings_json),
      recentRuns: this.runSummaries(20),
    });
  }

  private runSummaries(limit: number): AutomationRun[] {
    return this.sql.exec<RunRow>(
      `SELECT run_id, occurrence_key, trigger_json, definition_revision, harness_run_id, state, summary,
              opening_json, seed_json, run_as_user_id, created_at, started_at, completed_at, updated_at
         FROM sidekick_runs WHERE sidekick_id = ? ORDER BY created_at DESC, run_id LIMIT ?`,
      this.sidekickId, limit,
    ).toArray().map((run) => {
      const trigger = JSON.parse(run.trigger_json) as AutomationRunTriggerV1;
      return AutomationRunSchema.parse({
        id: run.run_id,
        automationId: this.sidekickId,
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

  /**
   * The directory columns that are derived rather than written: the version
   * every reader of this row keys its change on, the next run, and when the
   * row last moved. Inside the caller's transaction; the sidebar learns from
   * the host.
   */
  private touchDirectory(now: number): void {
    const row = this.row();
    if (!row) throw new Error("sidekick_missing");
    this.sql.exec(
      `UPDATE automation_directory
          SET source_version = source_version + 1, payload_hash = 'hosted', next_run_at = ?, projected_at = ?
        WHERE automation_id = ?`,
      this.nextRunAt(row), now, this.sidekickId,
    );
    this.host.noteDirectoryChanged(this.sidekickId, row.lifecycle === "deleted", now);
  }
}

/** For a reader that has a stored entry in hand: which Sidekick it names, if any. */
export function hostedSidekickAlarmTarget(alarm: ScheduledAlarm): { sidekickId: string; key: string } | null {
  if (!HOSTED_SIDEKICK_ALARM_KINDS.has(alarm.kind)) return null;
  return parseSidekickAlarmKey(alarm.key);
}

