import type { ScopeGrant } from "@rally/contracts/scope-grants";
import { ConnectorParticipantAdmissionSchema, ScopeGrantManagementRequestSchema, ManagedScopeGrantsSchema } from "@rally/contracts/scope-grants";
import { ScopeSharingOptionsRequestSchema, ScopeSharingOptionsSchema, type ScopeGrantTarget } from "@rally/contracts/scope-grants";
import { ListScopeInvitationsSchema } from "@rally/contracts/scope-grants";
import { SharedWorkstreamRequestSchema, SharedWorkstreamSchema } from "@rally/contracts/scope-grants";
import { ScopeInvitationService } from "./scope-invitation-service";
import { SCOPE_INVITATION_SCHEMA_STATEMENTS, SCOPE_INVITATION_DELIVERY_ALARM } from "./scope-invitation-storage";
import { CreateScopeInvitationsSchema, AcceptScopeInvitationSchema, RevokeScopeInvitationSchema,
  ScopeInvitationResultSchema, type ScopeInvitationResult } from "@rally/contracts/scope-grants";
import { parseRpcInput } from "../lib/rpc-input";
import type { Region } from "@rally/contracts/regions";
import { safeParseSocketEvent, isUnknownSocketEvent } from "@rally/contracts";
import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import { ConversationAuthorizationRequestSchema, type ConversationAuthorizationRequest } from '../services/authorization-policy';
import { createIdentityObjectPort } from '../runtime/identity-port';
import {
  UserIdSchema,
  IdSchema,
  SubstreamIdSchema,
  WORKSTREAM_REALTIME_MAX_FRAME_BYTES,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkspaceIdSchema,
  WorkstreamIdSchema,
  asWorkspaceId,
  asWorkstreamId,
  asSubstreamId,
  WorkstreamControlMetadataSchema,
  WorkstreamControlSocketClientEventSchema,
  WorkstreamControlSocketEventSchema,
  type WorkstreamControlMetadata,
  type UserId,
  type WorkspaceId,
  type SubstreamId,
  type WorkstreamControlSocketEvent,
} from "@rally/contracts";
import type {
  ConversationEffect,
  ConversationEffectEnvelope,
  ParentEffectEnvelope,
} from "@rally/contracts/conversation-effects";
import {
  ParentEffectEnvelopeSchema,
  WorkstreamDirectoryCommonEffectSchema,
  WorkstreamDirectoryUserEffectSchema,
  isPersonNotificationEffect,
} from "@rally/contracts/conversation-effects";
import {
  ConversationParentAuthorityRequestSchema,
  ConversationParentAuthorityResultSchema,
  ConversationParentAuthorizeViewerRequestSchema,
  ConversationParentAuthorizeViewerResultSchema,
  ConversationParentReserveChildRequestSchema,
  ConversationParentReserveChildResultSchema,
  BeginPrivateChildPreparationRequestSchema,
  ClaimPrivateChildConfirmationRequestSchema,
  ListVisiblePrivateChildrenRequestSchema,
  ListVisiblePrivateChildrenResultSchema,
  MutatePrivateChildParticipantRequestSchema,
  MutatePrivateChildParticipantResultSchema,
  PrivateChildPreparationOperationSchema,
  SetPrivateChildArchivedRequestSchema,
  SetPrivateChildArchivedResultSchema,
  ReadPrivateChildPreparationRequestSchema,
  SavePreparedPrivateChildContextRequestSchema,
  SavePrivateChildCaptureRequestSchema,
  SavePrivateChildPartRequestSchema,
  SetPrivateChildTerminalStatusRequestSchema,
  type ConversationParentAuthorityRequest,
  type ConversationParentAuthorityResult,
  type ConversationParentAuthorizeViewerRequest,
  type ConversationParentAuthorizeViewerResult,
  type ConversationParentReserveChildRequest,
  type ConversationParentReserveChildResult,
  type BeginPrivateChildPreparationRequest,
  type ClaimPrivateChildConfirmationRequest,
  type ListVisiblePrivateChildrenRequest,
  type ListVisiblePrivateChildrenResult,
  type MutatePrivateChildParticipantRequest,
  type MutatePrivateChildParticipantResult,
  type PrivateChildPreparationOperation,
  type SetPrivateChildArchivedRequest,
  type SetPrivateChildArchivedResult,
  type ReadPrivateChildPreparationRequest,
  type SavePreparedPrivateChildContextRequest,
  type SavePrivateChildCaptureRequest,
  type SavePrivateChildPartRequest,
  type SetPrivateChildTerminalStatusRequest,
} from "@rally/contracts/conversation-parent";
import { truncateUtf16Safe } from "@rally/contracts/text";
import { z } from "zod";
import { SCOPE_GRANT_SCHEMA_STATEMENTS, SCOPE_GRANT_DIRECTORY_ALARM, ScopeGrantStorage, PARTICIPANT_PROJECTION_ALARM, MAIN_PARTICIPANT_MIGRATION_ALARM, CHILD_PARTICIPANT_MIGRATION_ALARM, ParticipantProjectionDeliverySchema } from "./scope-grant-storage";
import { ParticipantTransferSnapshotSchema } from "./participant-authority-transfer";
import { ScopeAccessRequestSchema, ScopeAccessResultSchema, ScopeGrantMutationSchema,
  ParticipantGrantMutationSchema, type ParticipantGrantMutation,
  ScopeGrantMutationResultSchema, type ScopeAccessRequest, type ScopeAccessResult,
  type ScopeGrantMutation, type ScopeGrantMutationResult } from "@rally/contracts/scope-grants";
import { readWorkspaceRelationship, type WorkspaceRelationship } from "../services/workspace-relationship-service";
import { resolveScopedAccess } from "../services/scope-grant-policy";
import { stableUuid } from "../lib/stable-uuid";

import type { AuthContext, Env } from "../env";
import { assertDurableObjectJurisdiction } from "../lib/durable-object-namespace";
import { withDurableObjectSelf } from "../lib/durable-object-self";
import { durableObjectStubForWorkspace } from "../lib/durable-object-namespace";
import { uuidV7 } from "../lib/uuid-v7";
import { reportScheduledAlarmAttempt } from "./scheduled-alarm-report";
import { logWarn } from "../observability/logger";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";
import {
  OBJECT_RETIREMENT_SCHEMA_STATEMENTS,
  applyRetirementGate,
  retiredObjectResponse,
} from "./object-retirement";
import {
  SCHEDULED_ALARM_SCHEMA_STATEMENTS,
  type ScheduledAlarm,
} from "./scheduled-alarms";
import type { DurableObjectMigrationPlan } from "./migratable-durable-object";
import {
  CONVERSATION_CHILDREN_SCHEMA_STATEMENTS,
  ConversationParentDurableObject,
  type ConversationParentIdentity,
  type DirectoryCommonEffect,
} from "./conversation-parent-object";
import {
  conversationObjectName,
  workspaceDOName,
  workstreamDOName,
} from "./names";
import { WorkspaceDirectoryApplyResultSchema } from "./workspace-directory-protocol";
import {
  revocationClosesSession,
  SocketAccessRevocationSchema,
  type SocketAccessRevocation,
} from "../services/access-revocation";

const realtimeTextEncoder = new TextEncoder();
const PRIVATE_CHILD_EFFECT_RETRY_MS = 5_000;

function workstreamControlPayload(event: WorkstreamControlSocketEvent): string {
  const payload = JSON.stringify(WorkstreamControlSocketEventSchema.parse(event));
  if (realtimeTextEncoder.encode(payload).byteLength > WORKSTREAM_REALTIME_MAX_FRAME_BYTES) {
    throw new Error("Work-stream control event exceeds the bounded frame size");
  }
  return payload;
}

const WorkstreamSocketIdentitySchema = z.object({
  workspaceId: WorkspaceIdSchema,
  workstreamId: WorkstreamIdSchema,
  userId: UserIdSchema,
  sessionId: z.string().min(1).max(200),
  ticketId: z.string().uuid(),
  ticketExpiresAt: z.coerce.number().int().positive(),
});

type WorkstreamSocketIdentity = z.infer<typeof WorkstreamSocketIdentitySchema>;

interface WorkstreamSocketAttachment extends WorkstreamSocketIdentity {
  connectionId: string;
  connectedAt: string;
  subscribed: boolean;
}

interface WorkstreamMetadataRow extends Record<string, SqlStorageValue> {
  revision: number;
  authority_generation: number;
  workspace_id: string;
  workstream_id: string;
  region: Region;
  title: string;
  description: string;
  preview: string;
  scope: "personal" | "workspace";
  exact_state: string;
  system_kind: "digest" | null;
  last_activity_at: number;
  completed_at: number | null;
  archived_at: number | null;
  email_address: string | null;
  created_by_user_id: string | null;
  title_status: "naming" | "automatic" | "settled";
  latest_attention_ordinal: number;
  unread_tracking_start_ordinal: number;
  next_wakeup_due_at: number | null;
  next_wakeup_prompt: string | null;
  next_terminal_action_at: number | null;
  source_created_at: number;
  source_updated_at: number;
}

interface PrivateChildPreparationRow extends Record<string, SqlStorageValue> {
  operation_id: string;
  substream_id: string;
  creator_user_id: string;
  request_json: string;
  capture_json: string | null;
  completed_parts_json: string;
  prepared_context_json: string | null;
  prepared_conversation_hash: string | null;
  status: "preparing" | "prepared" | "confirming" | "ready" | "failed";
  error_code: string | null;
  created_at: number;
  updated_at: number;
  title: string;
  membership_version: number;
}

interface PrivateChildMembershipEffectRow extends Record<string, SqlStorageValue> {
  operation_id: string;
  substream_id: string;
  user_id: string;
  actor_user_id: string;
  active: number;
  membership_version: number;
}

export const WORKSTREAM_DO_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "workstream control-plane metadata, HyperSight coordination, and regional effects",
  statements: [
    `PRAGMA foreign_keys = ON`,
    `CREATE TABLE workstream_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL UNIQUE,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      revision INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      preview TEXT NOT NULL,
      email_address TEXT,
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      exact_state TEXT NOT NULL CHECK (exact_state IN (
        'scheduled', 'running', 'interrupting', 'preparing_context', 'waiting_capacity',
        'needs_input', 'completed', 'cancelled', 'failed', 'budget_exhausted',
        'idle', 'archived', 'deleting', 'restoring'
      )),
      origin_type TEXT NOT NULL DEFAULT 'ad_hoc'
        CHECK (origin_type IN ('ad_hoc', 'automation')),
      created_by_user_id TEXT,
      automation_subscription_id TEXT,
      automation_run_id TEXT,
      planned_for INTEGER CHECK (planned_for IS NULL OR planned_for >= 0),
      title_status TEXT NOT NULL DEFAULT 'settled'
        CHECK (title_status IN ('naming', 'automatic', 'settled')),
      system_kind TEXT CHECK (system_kind IS NULL OR system_kind = 'digest'),
      last_activity_at INTEGER NOT NULL CHECK (last_activity_at >= 0),
      completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
      archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
      latest_attention_ordinal INTEGER NOT NULL DEFAULT 0
        CHECK (latest_attention_ordinal >= 0),
      unread_tracking_start_ordinal INTEGER NOT NULL DEFAULT 0
        CHECK (unread_tracking_start_ordinal >= 0),
      next_wakeup_due_at INTEGER CHECK (next_wakeup_due_at IS NULL OR next_wakeup_due_at >= 0),
      next_wakeup_prompt TEXT,
      next_terminal_action_at INTEGER
        CHECK (next_terminal_action_at IS NULL OR next_terminal_action_at >= 0),
      source_created_at INTEGER NOT NULL DEFAULT 0 CHECK (source_created_at >= 0),
      source_updated_at INTEGER NOT NULL DEFAULT 0 CHECK (source_updated_at >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE substream_directory (
      substream_id TEXT PRIMARY KEY,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      effect_json TEXT NOT NULL CHECK (
        json_valid(effect_json) AND length(CAST(effect_json AS BLOB)) <= 1900000
      ),
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE substream_user_directory (
      substream_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      effect_json TEXT NOT NULL CHECK (
        json_valid(effect_json) AND length(CAST(effect_json AS BLOB)) <= 1900000
      ),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (substream_id, user_id)
    ) STRICT`,
    `CREATE INDEX substream_user_directory_user_idx
      ON substream_user_directory(user_id, substream_id)`,
    `CREATE TABLE child_effect_receipts (
      substream_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      PRIMARY KEY (substream_id, message_id)
    ) STRICT`,
    `CREATE TABLE projection_keys (
      projection_key TEXT PRIMARY KEY,
      next_version INTEGER NOT NULL CHECK (next_version > 0),
      last_payload_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE workstream_state_clock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      next_sequence INTEGER NOT NULL CHECK (next_sequence > 0),
      last_event_time INTEGER NOT NULL CHECK (last_event_time >= 0)
    ) STRICT`,
    `INSERT INTO workstream_state_clock(id, next_sequence, last_event_time)
      VALUES (1, 1, 0)`,
    `CREATE TABLE workstream_state_changes (
      sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
      state_key TEXT NOT NULL CHECK (length(state_key) BETWEEN 1 AND 180),
      waterline INTEGER NOT NULL CHECK (waterline > 0),
      event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND 180),
      payload_hash TEXT NOT NULL,
      state_json TEXT NOT NULL CHECK (json_valid(state_json) AND length(state_json) <= 262144),
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
      UNIQUE (state_key, waterline)
    ) STRICT`,
    `CREATE INDEX workstream_state_changes_latest_idx
      ON workstream_state_changes(state_key, waterline DESC)`,
    `CREATE TABLE durable_outbox (
      message_id TEXT PRIMARY KEY,
      partition_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
      effect_kind TEXT NOT NULL CHECK (effect_kind IN (
        'directory_common', 'directory_user', 'suggestion_feedback',
        'activity_event', 'mention_notification'
      )),
      -- The payload budget matches the producing child outbox bound (just
      -- under the platform's 2 MB per-row BYTE ceiling, measured in bytes —
      -- length() on TEXT counts characters) so an envelope the child could
      -- commit is never one this parent must reject: a mid-chain rejection of
      -- an already durable effect is a permanent poison retry.
      payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1900000
      ),
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX durable_outbox_delivery_idx
      ON durable_outbox(state, not_before, created_at, message_id)`,
    `CREATE TABLE workstream_socket_ticket_receipts (
      ticket_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX workstream_socket_ticket_receipts_expiry_idx
      ON workstream_socket_ticket_receipts(expires_at, ticket_id)`,
    `CREATE TABLE block_dashboard_configuration_versions (
      configuration_version_id TEXT PRIMARY KEY,
      version_number INTEGER NOT NULL UNIQUE CHECK (version_number > 0),
      blocks_json TEXT NOT NULL CHECK (json_valid(blocks_json) AND length(blocks_json) <= 262144),
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE block_dashboard_block_runs (
      block_run_id TEXT PRIMARY KEY,
      configuration_version_id TEXT NOT NULL
        REFERENCES block_dashboard_configuration_versions(configuration_version_id) ON DELETE CASCADE,
      block_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      trigger_sequence INTEGER NOT NULL CHECK (trigger_sequence >= 0),
      harness_run_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'stopped')),
      markdown TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      UNIQUE (configuration_version_id, block_id, trigger_sequence)
    ) STRICT`,
    `CREATE INDEX block_dashboard_block_runs_latest_idx
      ON block_dashboard_block_runs(block_id, trigger_sequence DESC, created_at DESC)`,
    `CREATE TABLE block_dashboard_user_preferences (
      user_id TEXT PRIMARY KEY,
      visible INTEGER NOT NULL CHECK (visible IN (0, 1)),
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE block_dashboard_dispatch_outbox (
      block_run_id TEXT PRIMARY KEY REFERENCES block_dashboard_block_runs(block_run_id) ON DELETE CASCADE,
      block_id TEXT NOT NULL,
      dispatch_json TEXT NOT NULL CHECK (json_valid(dispatch_json) AND length(dispatch_json) <= 262144),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX block_dashboard_dispatch_outbox_due_idx
      ON block_dashboard_dispatch_outbox(not_before, created_at, block_run_id)`,
    `CREATE TABLE block_dashboard_block_result_receipts (
      block_run_id TEXT PRIMARY KEY REFERENCES block_dashboard_block_runs(block_run_id) ON DELETE CASCADE,
      block_id TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      received_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE block_dashboard_source_refresh_outbox (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      trigger_sequence INTEGER NOT NULL CHECK (trigger_sequence >= 0),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
  ],
}, {
  version: 2,
  description: "shared multi-alarm index behind this object's single alarm",
  statements: [...SCHEDULED_ALARM_SCHEMA_STATEMENTS],
}, {
  version: 3,
  description: "carry the participant-added notification through this object's outbox",
  statements: [
    // The outbox enumerates the effect kinds it will hold, and a person being
    // added to a work stream is a new one. Enumerating them is worth keeping:
    // this row is what a poison delivery would be stuck on, and a kind nobody
    // downstream handles should fail here rather than in a Queue consumer.
    //
    // SQLite cannot widen a CHECK in place, so the table is rebuilt. Version 1
    // still creates the narrow shape and must — its statements are hashed into
    // every deployed object's `_sql_schema_migrations` receipt, and editing
    // them throws `workstream_do_schema_hash_mismatch:1` in the constructor of
    // every work stream that ran an earlier release.
    `CREATE TABLE durable_outbox_kinds (
      message_id TEXT PRIMARY KEY,
      partition_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
      effect_kind TEXT NOT NULL CHECK (effect_kind IN (
        'directory_common', 'directory_user', 'suggestion_feedback',
        'activity_event', 'mention_notification', 'participant_notification'
      )),
      payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1900000
      ),
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    // An effect mid-flight keeps its place in the queue rather than being
    // dropped and rediscovered: this runs in the constructor, before the
    // object serves anything, so the copy is of a settled table.
    `INSERT INTO durable_outbox_kinds
       (message_id, partition_key, source_version, source_epoch, effect_kind,
        payload_json, payload_hash, state, attempts, not_before, created_at)
     SELECT message_id, partition_key, source_version, source_epoch, effect_kind,
        payload_json, payload_hash, state, attempts, not_before, created_at
       FROM durable_outbox`,
    `DROP TABLE durable_outbox`,
    `ALTER TABLE durable_outbox_kinds RENAME TO durable_outbox`,
    `CREATE INDEX durable_outbox_delivery_idx
      ON durable_outbox(state, not_before, created_at, message_id)`,
  ],
}, {
  version: 4,
  description: "retire context-suggestion deliveries from the durable outbox",
  statements: [
    `CREATE TABLE durable_outbox_without_suggestions (
      message_id TEXT PRIMARY KEY,
      partition_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
      effect_kind TEXT NOT NULL CHECK (effect_kind IN (
        'directory_common', 'directory_user', 'activity_event',
        'mention_notification', 'participant_notification'
      )),
      payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1900000
      ),
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `INSERT INTO durable_outbox_without_suggestions
       (message_id, partition_key, source_version, source_epoch, effect_kind,
        payload_json, payload_hash, state, attempts, not_before, created_at)
     SELECT message_id, partition_key, source_version, source_epoch, effect_kind,
            payload_json, payload_hash, state, attempts, not_before, created_at
       FROM durable_outbox WHERE effect_kind != 'suggestion_feedback'`,
    `DROP TABLE durable_outbox`,
    `ALTER TABLE durable_outbox_without_suggestions RENAME TO durable_outbox`,
    `CREATE INDEX durable_outbox_delivery_idx
      ON durable_outbox(state, not_before, created_at, message_id)`,
  ],
}, {
  version: 5,
  description: "remove retired block dashboard product state and pending deliveries",
  statements: [
    `DROP TABLE IF EXISTS block_dashboard_source_refresh_outbox`,
    `DROP TABLE IF EXISTS block_dashboard_dispatch_outbox`,
    `DROP TABLE IF EXISTS block_dashboard_block_result_receipts`,
    `DROP TABLE IF EXISTS block_dashboard_block_runs`,
    `DROP TABLE IF EXISTS block_dashboard_configuration_versions`,
    `DROP TABLE IF EXISTS block_dashboard_user_preferences`,
  ],
}, {
  version: 6,
  description: "register a child conversation before its first effect arrives",
  statements: [
    // Until now a child existed here only once its first `directory_common`
    // effect landed. Creation now reserves the main conversation before the
    // child object is initialized, and a run or side conversation is reserved
    // the same way, so the parent can list its children without waiting for
    // each to say something. The projection tables keep their shape; this is
    // the registry beside them.
    ...CONVERSATION_CHILDREN_SCHEMA_STATEMENTS,
  ],
}, {
  version: 7,
  description: "make private work-stream children parent-owned and retryable",
  statements: [
    `ALTER TABLE conversation_children ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'
      CHECK (status IN ('reserved', 'ready', 'failed'))`,
    `ALTER TABLE conversation_children ADD COLUMN title TEXT`,
    `ALTER TABLE conversation_children ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE private_child_preparations (
      operation_id TEXT PRIMARY KEY,
      substream_id TEXT NOT NULL UNIQUE REFERENCES conversation_children(substream_id) ON DELETE CASCADE,
      creator_user_id TEXT NOT NULL,
      request_json TEXT NOT NULL CHECK (json_valid(request_json)),
      capture_json TEXT CHECK (capture_json IS NULL OR json_valid(capture_json)),
      completed_parts_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(completed_parts_json)),
      prepared_context_json TEXT CHECK (prepared_context_json IS NULL OR json_valid(prepared_context_json)),
      status TEXT NOT NULL CHECK (status IN ('preparing', 'prepared', 'confirming', 'ready', 'failed')),
      error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE private_child_memberships (
      substream_id TEXT NOT NULL REFERENCES conversation_children(substream_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      version INTEGER NOT NULL CHECK (version > 0),
      added_by_user_id TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      removed_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (substream_id, user_id)
    ) STRICT`,
    `CREATE INDEX private_child_memberships_user_idx
      ON private_child_memberships(user_id, active, substream_id)`,
    `CREATE TABLE private_child_membership_effects (
      operation_id TEXT PRIMARY KEY,
      substream_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      membership_version INTEGER NOT NULL CHECK (membership_version > 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight', 'delivered')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX private_child_membership_effects_due_idx
      ON private_child_membership_effects(state, not_before, created_at, operation_id)`,
  ],
}, {
  version: 8,
  description: "record a permanent retirement tombstone",
  statements: [
    // A retired workspace never reopens, and the fence in front of every
    // method here reads this table. It lives in the object rather than D1
    // because the gate answers during constructor recovery, before anything
    // else this object could consult is admitted.
    ...OBJECT_RETIREMENT_SCHEMA_STATEMENTS,
  ],
}, {
  version: 9,
  description: "let a private child be archived the way its work stream can be",
  statements: [
    // Archive is independent of creation readiness. Adding a timestamp preserves
    // the existing child roster and preparation rows without rebuilding their parent.
    `ALTER TABLE conversation_children
       ADD COLUMN archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0)`,
  ],
}, {
  version: 10,
  description: "durably deliver private child archive state to its executing room",
  statements: [
    `ALTER TABLE conversation_children ADD COLUMN lifecycle_version INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE conversation_children ADD COLUMN lifecycle_delivered_version INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE conversation_children ADD COLUMN lifecycle_not_before INTEGER NOT NULL DEFAULT 0`,
  ],
}, { version: 11, description: "allow configured deployment identifiers", statements: [
  "PRAGMA defer_foreign_keys = ON",
  "CREATE TABLE \"_region_copy_workstream_metadata\" AS SELECT * FROM \"workstream_metadata\"",
  "DELETE FROM \"workstream_metadata\"",
  "DROP TABLE \"workstream_metadata\"",
  "CREATE TABLE workstream_metadata (\n      id INTEGER PRIMARY KEY CHECK (id = 1),\n      workspace_id TEXT NOT NULL,\n      workstream_id TEXT NOT NULL UNIQUE,\n      region TEXT NOT NULL,\n      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),\n      revision INTEGER NOT NULL DEFAULT 0,\n      title TEXT NOT NULL,\n      description TEXT NOT NULL,\n      preview TEXT NOT NULL,\n      email_address TEXT,\n      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),\n      exact_state TEXT NOT NULL CHECK (exact_state IN (\n        'scheduled', 'running', 'interrupting', 'preparing_context', 'waiting_capacity',\n        'needs_input', 'completed', 'cancelled', 'failed', 'budget_exhausted',\n        'idle', 'archived', 'deleting', 'restoring'\n      )),\n      origin_type TEXT NOT NULL DEFAULT 'ad_hoc'\n        CHECK (origin_type IN ('ad_hoc', 'automation')),\n      created_by_user_id TEXT,\n      automation_subscription_id TEXT,\n      automation_run_id TEXT,\n      planned_for INTEGER CHECK (planned_for IS NULL OR planned_for >= 0),\n      title_status TEXT NOT NULL DEFAULT 'settled'\n        CHECK (title_status IN ('naming', 'automatic', 'settled')),\n      system_kind TEXT CHECK (system_kind IS NULL OR system_kind = 'digest'),\n      last_activity_at INTEGER NOT NULL CHECK (last_activity_at >= 0),\n      completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),\n      archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),\n      latest_attention_ordinal INTEGER NOT NULL DEFAULT 0\n        CHECK (latest_attention_ordinal >= 0),\n      unread_tracking_start_ordinal INTEGER NOT NULL DEFAULT 0\n        CHECK (unread_tracking_start_ordinal >= 0),\n      next_wakeup_due_at INTEGER CHECK (next_wakeup_due_at IS NULL OR next_wakeup_due_at >= 0),\n      next_wakeup_prompt TEXT,\n      next_terminal_action_at INTEGER\n        CHECK (next_terminal_action_at IS NULL OR next_terminal_action_at >= 0),\n      source_created_at INTEGER NOT NULL DEFAULT 0 CHECK (source_created_at >= 0),\n      source_updated_at INTEGER NOT NULL DEFAULT 0 CHECK (source_updated_at >= 0),\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    ) STRICT",
  "INSERT INTO \"workstream_metadata\" SELECT * FROM \"_region_copy_workstream_metadata\"",
  "DROP TABLE \"_region_copy_workstream_metadata\"",
  "PRAGMA defer_foreign_keys = OFF"
]
}, {
  version: 12, description: "freeze private child historical content before publication", statements: [
    // Previously claimed operations had no prepared-history input. Null keeps their replay semantics.
    `ALTER TABLE private_child_preparations ADD COLUMN prepared_conversation_hash TEXT
      CHECK (prepared_conversation_hash IS NULL OR (length(prepared_conversation_hash) = 24 AND substr(prepared_conversation_hash, 1, 8) = 'fnv1a64:'))`,
  ],
}, {
  version: 13,
  description: "workspace Sidekicks recommended for a workstream",
  statements: [
    `CREATE TABLE workstream_sidekick_attachments (sidekick_id TEXT PRIMARY KEY, attached_at INTEGER NOT NULL) STRICT`,
  ],
}, {
  version: 14,
  description: "store versioned scope grants and preserve restricted child audiences",
  statements: [
    ...SCOPE_GRANT_SCHEMA_STATEMENTS,
    ...SCOPE_INVITATION_SCHEMA_STATEMENTS,
    `ALTER TABLE conversation_children ADD COLUMN audience TEXT NOT NULL DEFAULT 'restricted'
      CHECK (audience IN ('restricted', 'inherits_workstream'))`,
  ],
}, {
  version: 15,
  description: "deliver scope grant discovery through the parent outbox",
  statements: [
    `CREATE TABLE durable_outbox_with_scope_grants (
      message_id TEXT PRIMARY KEY,
      partition_key TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      source_epoch INTEGER NOT NULL CHECK (source_epoch > 0),
      effect_kind TEXT NOT NULL CHECK (effect_kind IN (
        'directory_common', 'directory_user', 'activity_event',
        'mention_notification', 'participant_notification', 'scope_grant_directory'
      )),
      payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1900000
      ),
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'inflight')),
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      not_before INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT`,
    `INSERT INTO durable_outbox_with_scope_grants
       SELECT * FROM durable_outbox`,
    `DROP TABLE durable_outbox`,
    `ALTER TABLE durable_outbox_with_scope_grants RENAME TO durable_outbox`,
    `CREATE INDEX durable_outbox_delivery_idx
      ON durable_outbox(state, not_before, created_at, message_id)`,
  ],
}, {
  version: 16,
  description: "receipt connector audience admission under grant authority",
  statements: [
    `CREATE TABLE connector_participant_admissions (
      event_id TEXT PRIMARY KEY, request_json TEXT NOT NULL CHECK(json_valid(request_json))
    ) STRICT`,
  ],
}, {
  version: 17,
  description: "retire intermediate grant discovery deliveries",
  statements: ["DELETE FROM scope_grant_deliveries WHERE delivered_at IS NOT NULL"],
}];

function first<T extends Record<string, SqlStorageValue>>(cursor: SqlStorageCursor<T>): T | null {
  return cursor.toArray()[0] ?? null;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function iso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function epoch(timestamp: string | null | undefined): number | null {
  if (timestamp == null) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("invalid_workstream_timestamp");
  return parsed;
}

function readSocketAttachment(socket: WebSocket): WorkstreamSocketAttachment | null {
  try {
    const parsed = WorkstreamSocketIdentitySchema.extend({
      connectionId: z.string().uuid(),
      connectedAt: z.string().datetime({ offset: true }),
      subscribed: z.boolean(),
    }).safeParse(socket.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function harnessStatus(state: string): WorkstreamControlMetadata["harnessStatus"] {
  if (state === "scheduled") return "scheduled";
  if (["running", "interrupting", "preparing_context", "waiting_capacity"].includes(state)) {
    return "running";
  }
  if (state === "needs_input") return "needs_input";
  if (state === "completed") return "completed";
  if (["failed", "budget_exhausted"].includes(state)) return "failed";
  if (state === "cancelled") return "stopped";
  return "idle";
}

function promptPreview(prompt: string): string {
  return truncateUtf16Safe(prompt.replace(/\s+/gu, " ").trim(), 40);
}

export { workstreamDOName };

/**
 * WorkstreamDO is the non-agent parent/control object.
 *
 * It owns no transcript and runs no model loop. SubstreamAgent children send
 * versioned state RPCs here. This object aggregates those facts and is the sole
 * object allowed to publish authoritative directory changes to WorkspaceDO or
 * enqueue external activity/notification effects. That prevents one work
 * stream with many substreams from exposing conflicting sidebar versions.
 */
/**
 * The migration runner's component key for this class.
 *
 * One constant because two call sites need the identical value: the runner
 * keys the object's schema ledger by it, and the migration report keys the
 * tracker's component rollup by it. Two literals that drift put an object
 * under a component its own ledger does not use, which shows up as a silent
 * miscount rather than an error.
 */
const MIGRATION_COMPONENT = "workstream_do";

export class WorkstreamDO extends ConversationParentDurableObject {
  private readonly state: DurableObjectState;
  /** This object's own `WORKSTREAM_DOS` name; see {@link selfObjectName}. */
  private objectName: string | null = null;
  private readonly initialized: Promise<void>;

  constructor(
    state: DurableObjectState,
    env: Env,
  ) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    // Everything downstream is handed this environment or one derived from it,
    // so a helper that addresses "the WorkstreamDO for this work stream" reaches
    // the object it is already running in rather than the namespace. See
    // `lib/durable-object-self.ts`.
    //
    // The parameter is rebound as well as the field, so the rest of this
    // constructor cannot hand the unregistered environment to something
    // long-lived.
    this.env = env = withDurableObjectSelf(env, {
      namespace: env.WORKSTREAM_DOS,
      name: () => this.selfObjectName(),
      id: state.id,
      instance: this,
    });
    // Before the migrations below, not after: the child's cold start is the
    // expensive half and it does not depend on anything this object is about to
    // do. A work stream and its main substream are always opened together — the
    // control socket wakes this object while the feed socket wakes that one —
    // so waking them in sequence pays for two cold starts a person waits
    // through end to end.
    this.wakeMainSubstream(env);
    this.initialized = this.initializeDurableObject(async () => {
      await this.applyMigrations(() => applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS,
        component: MIGRATION_COMPONENT,
        workerVersionId: env.APP_VERSION ?? "unknown",
        afterMigrations: (_sql, applied) => {
          if (!applied.includes(17)) return;
          this.retireGrantDirectoryDeliveries();
        },
      }));
      await this.armNextAlarm();
    });
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  protected override migrationPlan(): DurableObjectMigrationPlan {
    return {
      component: MIGRATION_COMPONENT,
      className: "WorkstreamDO",
      migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS,
    };
  }

  protected override migrationsReady(): Promise<void> {
    return this.initialized;
  }

  protected override async runScheduledAlarm(alarm: ScheduledAlarm): Promise<void> {
    if (alarm.kind === SCOPE_GRANT_DIRECTORY_ALARM) {
      const metadata = this.metadataRow();
      if (!metadata) throw new Error("scope_grant_directory_parent_missing");
      this.state.storage.transactionSync(() => {
        const store = this.scopeGrants({ workspaceId: metadata.workspace_id, parentId: metadata.workstream_id });
        for (const { grant } of store.pendingDeliveries()) {
          const scopeKey = grant.target.kind === "workstream" ? "workstream" : `conversation:${grant.target.substreamId}`;
          this.enqueueProjection(`grant:${grant.userId}:${scopeKey}`, { kind: "scope_grant_directory", grant }, Date.now());
          store.acknowledgeDelivery(grant.revision);
        }
      });
      return;
    }
    if (alarm.kind === SCOPE_INVITATION_DELIVERY_ALARM) return this.scopeInvitations().deliver(alarm.key);
    if (alarm.kind === MAIN_PARTICIPANT_MIGRATION_ALARM) return this.runMainParticipantMigration();
    if (alarm.kind === CHILD_PARTICIPANT_MIGRATION_ALARM) return this.runChildParticipantMigration(SubstreamIdSchema.parse(alarm.key));
    if (alarm.kind !== PARTICIPANT_PROJECTION_ALARM) throw new Error(`workstream_object_unknown_alarm_kind:${alarm.kind}`);
    const requested = ParticipantProjectionDeliverySchema.parse(JSON.parse(alarm.payload ?? "null"));
    await this.deliverParticipantProjection(requested.substreamId, requested.projection.userId, requested.projection.revision);
  }

  private async deliverParticipantProjection(substreamId: string, userId: string, revision?: number): Promise<void> {
    const metadata = this.metadataRow();
    if (!metadata) throw new Error("participant_projection_parent_missing");
    const store = this.scopeGrants({ workspaceId: metadata.workspace_id, parentId: metadata.workstream_id });
    const delivery = store.pendingParticipantProjection(substreamId, userId, revision);
    if (!delivery) return;
    const child = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS,
      metadata.workspace_id, conversationObjectName(this.env.AVALON_REGION, asWorkspaceId(metadata.workspace_id),
        metadata.workstream_id, delivery.substreamId));
    const result = await child.applyParticipantProjection({ workspaceId: metadata.workspace_id,
      parentId: metadata.workstream_id, substreamId: delivery.substreamId, projection: delivery.projection });
    if (result.status !== "applied" && result.status !== "unchanged" && result.status !== "stale") {
      throw new Error(`participant_projection_delivery_${result.status}`);
    }
    store.acknowledgeParticipantProjection(delivery.substreamId, delivery.projection.userId, delivery.projection.revision);
  }

  private async membershipIncarnations(workspaceId: string): Promise<Record<string,string>> {
    const rows = await this.env.DB.prepare("SELECT user_id,incarnation FROM workspace_members WHERE workspace_id=? AND status='active'")
      .bind(workspaceId).all<{ user_id:string;incarnation:string }>();
    return Object.fromEntries(rows.results.map((row) => [row.user_id,row.incarnation]));
  }

  /** Resumes from canonical receipts after failure at any cross-object boundary. */
  private async runMainParticipantMigration(): Promise<void> {
    const migration = this.parentSql.exec<{ transfer_id: string; phase: string; incarnations_json:string }>(
      "SELECT transfer_id,phase,incarnations_json FROM main_participant_migration WHERE singleton=1",
    ).toArray()[0];
    if (!migration || migration.phase === "complete") return;
    const metadata = this.metadataRow();
    if (!metadata) throw new Error("participant_migration_parent_missing");
    const workspaceId = asWorkspaceId(metadata.workspace_id);
    const source = await durableObjectStubForWorkspace(this.env,this.env.SUBSTREAM_AGENTS,workspaceId,
      conversationObjectName(this.env.AVALON_REGION,workspaceId,metadata.workstream_id));
    const address = { workspaceId, parentId: metadata.workstream_id, substreamId: asSubstreamId("0"), transferId: migration.transfer_id };
    const prepared = await source.transferParticipantAuthority({ ...address, phase: "prepare" });
    if (prepared.status !== "prepared") throw new Error(`participant_migration_prepare_${prepared.status}`);
    const store = this.scopeGrants(address);
    store.importParticipants({ kind: "workstream",workspaceId,parentId: metadata.workstream_id },prepared.snapshot,
      z.record(z.string(),z.string().min(1)).parse(JSON.parse(migration.incarnations_json)));
    const committed = await source.transferParticipantAuthority({ ...address,phase: "commit" });
    if (committed.status !== "committed") throw new Error(`participant_migration_commit_${committed.status}`);
    this.state.storage.transactionSync(() => {
      store.registerParticipantProjection("0",migration.transfer_id);
      this.parentSql.exec("UPDATE main_participant_migration SET phase='complete' WHERE singleton=1 AND transfer_id=?",migration.transfer_id);
    });
  }

  /** Internal cutover command; callers must migrate legacy writers before invoking it. */
  async beginMainParticipantMigration(input: ConversationParentAuthorityRequest): Promise<{
    status: "pending" | "complete" | "conflict"; transferId?: string;
  }> {
    await this.initialized;
    const request = parseRpcInput(ConversationParentAuthorityRequestSchema,input,"main_participant_migration");
    this.assertParent(request.workspaceId,request.parentId);
    const incarnations = await this.membershipIncarnations(request.workspaceId);
    const result = this.state.storage.transactionSync(() => {
      const existing = this.parentSql.exec<{ transfer_id: string; phase: string }>(
        "SELECT transfer_id,phase FROM main_participant_migration WHERE singleton=1",
      ).toArray()[0];
      if (existing) return { status: z.enum(["pending","complete"]).parse(existing.phase),transferId: existing.transfer_id };
      if (this.parentSql.exec("SELECT 1 FROM scope_grants WHERE scope_kind='workstream' LIMIT 1").toArray().length > 0) {
        return { status: "conflict" as const };
      }
      const main = this.parentSql.exec<{ status: string }>("SELECT status FROM conversation_children WHERE substream_id='0'").toArray()[0];
      if (main?.status !== "ready") return { status: "conflict" as const };
      const transferId = uuidV7();
      this.parentSql.exec("INSERT INTO main_participant_migration(singleton,transfer_id,phase,incarnations_json) VALUES (1,?,'pending',?)",transferId,JSON.stringify(incarnations));
      this.scheduledAlarms.schedule({ kind: MAIN_PARTICIPANT_MIGRATION_ALARM,key: "main",dueAt: Date.now() });
      return { status: "pending" as const,transferId };
    });
    await this.armNextAlarm();
    return result;
  }

  private async runChildParticipantMigration(substreamId: SubstreamId): Promise<void> {
    const migration = this.parentSql.exec<{ transfer_id: string; phase: string }>(
      "SELECT transfer_id,phase FROM child_participant_migrations WHERE substream_id=?",substreamId,
    ).toArray()[0];
    if (!migration || migration.phase === "complete") return;
    const metadata = this.metadataRow();
    if (!metadata) throw new Error("participant_migration_parent_missing");
    const workspaceId = asWorkspaceId(metadata.workspace_id);
    const source = await durableObjectStubForWorkspace(this.env,this.env.SUBSTREAM_AGENTS,workspaceId,
      conversationObjectName(this.env.AVALON_REGION,workspaceId,metadata.workstream_id,substreamId));
    const address = { workspaceId,parentId: metadata.workstream_id,substreamId,transferId:migration.transfer_id };
    const prepared = await source.transferParticipantAuthority({ ...address,phase:"prepare" });
    if (prepared.status !== "prepared") throw new Error(`participant_migration_prepare_${prepared.status}`);
    const committed = await source.transferParticipantAuthority({ ...address,phase:"commit" });
    if (committed.status !== "committed") throw new Error(`participant_migration_commit_${committed.status}`);
    this.state.storage.transactionSync(() => {
      // Parent membership was imported before any external await. The child's
      // local roster is only a reconciliation audience, never granting evidence.
      this.scopeGrants(address).registerParticipantProjection(substreamId,migration.transfer_id,
        prepared.snapshot.participants.map((participant) => participant.userId));
      this.parentSql.exec("UPDATE child_participant_migrations SET phase='complete' WHERE substream_id=? AND transfer_id=?",
        substreamId,migration.transfer_id);
    });
  }

  async beginChildParticipantMigration(input: { workspaceId: string; parentId: string; substreamId: string }): Promise<{
    status: "pending" | "complete" | "conflict"; transferId?: string;
  }> {
    await this.initialized;
    const request = parseRpcInput(z.strictObject({ workspaceId: WorkspaceIdSchema,parentId: IdSchema,
      substreamId: SubstreamIdSchema.refine((id) => id !== "0") }),input,"child_participant_migration");
    this.assertParent(request.workspaceId,request.parentId);
    const incarnations = await this.membershipIncarnations(request.workspaceId);
    const result = this.startChildParticipantMigration(request, incarnations);
    await this.armNextAlarm();
    return result;
  }

  private startChildParticipantMigration(
    request: { workspaceId: WorkspaceId; parentId: string; substreamId: SubstreamId },
    incarnations: Record<string, string>,
  ): { status: "pending" | "complete" | "conflict"; transferId?: string } {
    return this.state.storage.transactionSync(() => {
      const existing = this.parentSql.exec<{ transfer_id: string; phase: string }>(
        "SELECT transfer_id,phase FROM child_participant_migrations WHERE substream_id=?",request.substreamId,
      ).toArray()[0];
      if (existing) return { status:z.enum(["pending","complete"]).parse(existing.phase),transferId:existing.transfer_id };
      const child = this.parentSql.exec<{ status: string }>(
        "SELECT status FROM conversation_children WHERE substream_id=? AND kind='child'",request.substreamId,
      ).toArray()[0];
      if (child?.status !== "ready" || this.parentSql.exec(
        "SELECT 1 FROM scope_grants WHERE scope_kind='conversation' AND substream_id=? LIMIT 1",request.substreamId,
      ).toArray().length) return { status:"conflict" as const };
      const transferId = uuidV7();
      const participants = this.parentSql.exec<{ user_id: string; added_by_user_id: string; added_at: number }>(
        "SELECT user_id,added_by_user_id,added_at FROM private_child_memberships WHERE substream_id=? AND active=1 ORDER BY user_id",
        request.substreamId,
      ).toArray();
      this.parentSql.exec("INSERT INTO child_participant_migrations(substream_id,transfer_id,phase) VALUES (?,?,'pending')",request.substreamId,transferId);
      this.scopeGrants(request).importParticipants({ kind:"conversation",...request },
        ParticipantTransferSnapshotSchema.parse({ transferId,participants:participants.map((participant) => ({
          userId:participant.user_id,addedByUserId:participant.added_by_user_id,addedAt:participant.added_at,reason:"explicit",
        })) }),incarnations);
      this.scheduledAlarms.schedule({ kind:CHILD_PARTICIPANT_MIGRATION_ALARM,key:request.substreamId,dueAt:Date.now() });
      return { status:"pending" as const,transferId };
    });
  }

  /** No authority gate here: this object forwards effects it already committed. */
  protected override scheduledAlarmDeferral(): Promise<number | null> {
    return Promise.resolve(null);
  }

  protected override onScheduledAlarmFailure(alarm: ScheduledAlarm, error: unknown, attempt: number): void {
    reportScheduledAlarmAttempt(this.env, (promise) => this.state.waitUntil(promise), {
      event: "workstream_object_scheduled_alarm_failed",
      summary: "A work-stream object's alarm entry keeps throwing; `code` is the handler's error, and `alarm_kind` and `alarm_key` name the entry.",
      attempt,
      fields: {
        workstream_id: this.metadataRow()?.workstream_id ?? null,
        alarm_kind: alarm.kind,
        alarm_key: alarm.key,
      },
      error,
    });
  }

  protected override onScheduledAlarmStalled(alarm: ScheduledAlarm, attempt: number): void {
    reportScheduledAlarmAttempt(this.env, (promise) => this.state.waitUntil(promise), {
      event: "workstream_object_scheduled_alarm_stalled",
      summary: "A work-stream object's alarm entry keeps coming back due at the same instant after running: the source row behind `alarm_kind` and `alarm_key` is not moving. Find why.",
      attempt,
      fields: {
        workstream_id: this.metadataRow()?.workstream_id ?? null,
        alarm_kind: alarm.kind,
        alarm_key: alarm.key,
        due_at: new Date(alarm.dueAt).toISOString(),
      },
    });
  }

  /**
   * This object's own name in `WORKSTREAM_DOS`, or `null` before it has one.
   *
   * Memoized: the metadata row's identity is written once and never changes,
   * and this is read on every name resolution the object performs. The read is
   * guarded the same way {@link wakeMainSubstream} guards its own, because a
   * first wake reaches here before the schema exists.
   */
  private selfObjectName(): string | null {
    if (this.objectName !== null) return this.objectName;
    let identity: { workspace_id: string; workstream_id: string } | null;
    try {
      identity = first(this.state.storage.sql.exec<{ workspace_id: string; workstream_id: string }>(
        `SELECT workspace_id, workstream_id FROM workstream_metadata WHERE id = 1`,
      ));
    } catch {
      return null;
    }
    if (!identity) return null;
    this.objectName = workstreamDOName(
      this.env.AVALON_REGION,
      asWorkspaceId(identity.workspace_id),
      asWorkstreamId(identity.workstream_id),
    );
    return this.objectName;
  }

  /**
   * Start substream `0` warming, without waiting for it.
   *
   * Reads identity straight out of storage rather than waiting for the
   * migrations: SQLite persists across hibernation, so on every wake but the
   * first the row is already there. On the first there is no child to wake
   * either, and no table to read — hence the guard rather than a check.
   *
   * Nothing here is awaited or retried. A child that fails to wake is woken by
   * the request that actually needs it, exactly as before; this only ever
   * removes latency, and must never be able to add a failure.
   */
  private wakeMainSubstream(env: Env): void {
    let identity: { workspace_id: string; workstream_id: string } | null;
    try {
      identity = first(this.state.storage.sql.exec<{ workspace_id: string; workstream_id: string }>(
        `SELECT workspace_id, workstream_id FROM workstream_metadata WHERE id = 1`,
      ));
    } catch {
      // First wake: the schema does not exist yet, and neither does the child.
      return;
    }
    if (!identity) return;
    const { workspace_id: workspaceId, workstream_id: workstreamId } = identity;
    this.state.waitUntil((async () => {
      try {
        const stub = await durableObjectStubForWorkspace(
          env,
          env.SUBSTREAM_AGENTS,
          workspaceId,
          conversationObjectName(env.AVALON_REGION, asWorkspaceId(workspaceId), workstreamId),
        );
        await stub.wake();
      } catch {
        // Warming is best effort by construction.
      }
    })());
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && (path === "/socket" || path === "/")) {
      return this.acceptSocket(request);
    }
    if (request.method === "GET" && path === "/health") {
      return json({
        ok: true,
        role: "workstream-control",
        databaseBytes: this.state.storage.sql.databaseSize,
      });
    }
    return json({ error: "not_found" }, 404);
  }

  /** Internal catalog read; consumers authorize each Sidekick source. */
  async recommendedSidekickIds(input: { workspaceId: string; parentId: string }): Promise<string[]> {
    await this.initialized;
    const request = parseRpcInput(z.strictObject({ workspaceId: WorkspaceIdSchema, parentId: IdSchema }), input, "sidekick_recommendations");
    this.assertParent(request.workspaceId, request.parentId);
    return this.parentSql.exec<{ sidekick_id: string }>(
      `SELECT sidekick_id FROM workstream_sidekick_attachments ORDER BY attached_at, sidekick_id`,
    ).toArray().map((row) => row.sidekick_id);
  }

  /** Parent mutations are distinct from collaboration in Main or a child. */
  async readManagementAccess(input: { workspaceId: string; parentId: string; userId: string }): Promise<ScopeAccessResult> {
    await this.initialized;
    const request = parseRpcInput(z.strictObject({ workspaceId: WorkspaceIdSchema, parentId: IdSchema,
      userId: UserIdSchema }), input, "workstream_management_access");
    this.assertParent(request.workspaceId, request.parentId);
    const relationship = await readWorkspaceRelationship(this.env.DB, request.workspaceId, request.userId);
    const target = { kind: "workstream" as const, workspaceId: request.workspaceId, parentId: request.parentId };
    const access = this.resolveScopeAccess({ userId: request.userId, target }, relationship);
    if (access.allowed || access.reason !== "grant_required") return access;
    // Preserve the existing participant rule only before authority transfers.
    // A projected Main participant is never a substitute for a parent grant.
    if (relationship?.accessClass === "member" && this.participantMigrationPhase("0") === null
      && this.parentSql.exec("SELECT 1 FROM scope_grants WHERE scope_kind='workstream' LIMIT 1").toArray().length === 0
      && this.isParticipant(request.userId)) {
      return { allowed: true, writable: this.metadataRow()?.archived_at === null,
        grantIds: [], workspaceMemberAccess: false };
    }
    return access;
  }

  /** The service validates workspace scope before adding a recommendation. */
  async setSidekickRecommendation(input: { workspaceId: string; parentId: string; userId: string; sidekickId: string; attached: boolean }): Promise<string[]> {
    await this.initialized;
    const request = parseRpcInput(z.strictObject({ workspaceId: WorkspaceIdSchema, parentId: IdSchema,
      userId: UserIdSchema, sidekickId: IdSchema, attached: z.boolean() }), input, "sidekick_recommendation");
    this.assertParent(request.workspaceId, request.parentId);
    const access = await this.readManagementAccess({ workspaceId: request.workspaceId, parentId: request.parentId, userId: request.userId });
    if (!access.allowed) throw new Error("sidekick_attachment_participant_required");
    if (!access.writable) throw new Error("sidekick_attachment_workstream_archived");
    if (request.attached) {
      this.parentSql.exec(`INSERT OR IGNORE INTO workstream_sidekick_attachments (sidekick_id, attached_at) VALUES (?, ?)`, request.sidekickId, Date.now());
    } else {
      this.parentSql.exec(`DELETE FROM workstream_sidekick_attachments WHERE sidekick_id = ?`, request.sidekickId);
    }
    return this.recommendedSidekickIds({ workspaceId: request.workspaceId, parentId: request.parentId });
  }

  // ---------------------------------------------------------------------------
  // The conversation-parent contract. `receiveChildEffects` and `listChildren`
  // are inherited; the three below need this object's own row.
  // ---------------------------------------------------------------------------

  async authorizeViewer(
    input: ConversationParentAuthorizeViewerRequest,
  ): Promise<ConversationParentAuthorizeViewerResult> {
    await this.initialized;
    const request = ConversationParentAuthorizeViewerRequestSchema.parse(input);
    const row = this.metadataRow();
    if (!row) return ConversationParentAuthorizeViewerResultSchema.parse({ authorized: false, archived: false });
    this.assertParent(request.workspaceId, request.parentId);
    const substreamId = request.substreamId ?? "0";
    if (this.participantMigrationPhase(substreamId) !== null) {
      const relationship = await readWorkspaceRelationship(this.env.DB, request.workspaceId, request.userId);
      const access = this.migratedConversationAccess(request, asSubstreamId(substreamId), relationship);
      const current = this.metadataRow();
      const child = this.parentSql.exec<{ archived_at: number | null; status: "reserved" | "ready" | "failed" }>(
        "SELECT archived_at,status FROM conversation_children WHERE substream_id=?", substreamId,
      ).toArray()[0];
      return ConversationParentAuthorizeViewerResultSchema.parse({ authorized: access.allowed,
        archived: current?.archived_at != null || child?.archived_at != null,
        childStatus: child?.status ?? null,
        membershipVersion: substreamId === "0" && access.allowed && access.workspaceMemberAccess && !access.grantIds.length
          ? 0 : this.scopeGrants(request).participantProjection(substreamId,request.userId)?.revision ?? 0 });
    }
    if (request.requireGrantAuthority) {
      return ConversationParentAuthorizeViewerResultSchema.parse({ authorized:false,archived:row.archived_at !== null });
    }
    if (substreamId !== "0") {
      const child = first(this.parentSql.exec<{
        status: "reserved" | "ready" | "failed"; version: number | null; archived_at: number | null;
      }>(
        `SELECT child.status, child.archived_at, member.version
           FROM conversation_children child
           LEFT JOIN private_child_memberships member
             ON member.substream_id = child.substream_id AND member.user_id = ? AND member.active = 1
          WHERE child.substream_id = ? AND child.kind = 'child'`,
        request.userId, substreamId,
      ));
      return ConversationParentAuthorizeViewerResultSchema.parse({
        authorized: (row.scope === "workspace" || this.isParticipant(request.userId))
          && child?.status === "ready" && child.version !== null,
        // Either archive reaches this conversation: the work stream's, which
        // takes all of its children with it, and the child's own. One field
        // because every caller downstream already refuses writes and socket
        // tickets on it, and neither archive means anything different here.
        archived: row.archived_at !== null || child?.archived_at != null,
        childStatus: child?.status ?? null,
        membershipVersion: child?.version ?? 0,
      });
    }
    // Archive is reported, not folded into the answer: an archived work stream
    // is still readable by the people who could read it, only not writable.
    const authorized = row.scope === "workspace" || this.isParticipant(request.userId);
    return ConversationParentAuthorizeViewerResultSchema.parse({
      authorized,
      archived: row.archived_at !== null,
    });
  }

  private participantMigrationPhase(substreamId: string): "pending" | "complete" | null {
    const row = substreamId === "0"
      ? this.parentSql.exec<{ phase: "pending" | "complete" }>("SELECT phase FROM main_participant_migration WHERE singleton=1").toArray()[0]
      : this.parentSql.exec<{ phase: "pending" | "complete" }>("SELECT phase FROM child_participant_migrations WHERE substream_id=?",substreamId).toArray()[0];
    return row?.phase ?? null;
  }

  private migratedConversationAccess(request: { workspaceId: string; parentId: string; userId: UserId },
    substreamId: SubstreamId, relationship: WorkspaceRelationship | null): ScopeAccessResult {
    if (this.participantMigrationPhase(substreamId) !== "complete") return { allowed:false,reason:"not_ready" };
    return this.resolveScopeAccess({ userId:request.userId,
      target:{ kind:"conversation",workspaceId:asWorkspaceId(request.workspaceId),parentId:request.parentId,substreamId } },relationship);
  }

  /** Runs synchronously inside the version-17 migration transaction. */
  private retireGrantDirectoryDeliveries(): void {
    const metadata = this.metadataRow();
    if (metadata) {
      const legacy = this.scopeGrants({ workspaceId: metadata.workspace_id, parentId: metadata.workstream_id });
      for (const { grant } of legacy.pendingDeliveries()) this.enqueueGrantDirectory(grant, Date.now());
    } else if (this.parentSql.exec("SELECT 1 FROM scope_grant_deliveries LIMIT 1").toArray().length) {
      throw new Error("scope_grant_directory_parent_missing");
    }
    this.parentSql.exec("DELETE FROM scope_grant_deliveries");
    this.parentSql.exec("DELETE FROM _internal_durable_alarms WHERE kind=?", SCOPE_GRANT_DIRECTORY_ALARM);
  }

  private scopeGrants(address: { workspaceId: string; parentId: string }): ScopeGrantStorage {
    return new ScopeGrantStorage(this.state.storage, address, (grant, now) => this.enqueueGrantDirectory(grant, now));
  }

  private enqueueGrantDirectory(grant: ScopeGrant, now: number): void {
    const scopeKey = grant.target.kind === "workstream" ? "workstream" : `conversation:${grant.target.substreamId}`;
    this.enqueueProjection(`grant:${grant.userId}:${scopeKey}`, { kind: "scope_grant_directory", grant }, now);
  }

  private scopeInvitations(): ScopeInvitationService {
    return new ScopeInvitationService(this.env, this.state.storage,
      (request, relationship) => this.resolveScopeAccess(request, relationship),
      (request) => this.completeWorkstreamCoverage(request.targets),
      (grant, now) => this.enqueueGrantDirectory(grant, now));
  }

  private completeWorkstreamCoverage(targets: readonly ScopeGrantTarget[]): boolean {
    if (!targets.some((target) => target.kind === "workstream")) return false;
    return this.parentSql.exec<{ substream_id: string; audience: string }>(
      "SELECT substream_id,audience FROM conversation_children WHERE kind='child' AND status='ready'",
    ).toArray().every((child) => child.audience === "inherits_workstream" || targets.some((target) =>
      target.kind === "conversation" && target.substreamId === child.substream_id));
  }

  /** Advisory choices; invitation creation repeats authorization after all awaits. */
  async scopeSharingOptions(input: z.infer<typeof ScopeSharingOptionsRequestSchema>) {
    await this.initialized;
    const request = ScopeSharingOptionsRequestSchema.parse(input);
    if (!this.metadataRow()) return ScopeSharingOptionsSchema.parse({ scopes: [], completeWorkstreamTargets: null });
    this.assertParent(request.workspaceId, request.parentId);
    let actor = await readWorkspaceRelationship(this.env.DB, request.workspaceId, request.actorUserId);
    if (actor?.status !== "active") return ScopeSharingOptionsSchema.parse({ scopes: [], completeWorkstreamTargets: null });
    let legacyMainParticipant = false;
    if (this.participantMigrationPhase("0") === null) {
      const main = await createIdentityObjectPort(this.env, request.workspaceId, request.parentId)
        .readAuthorizationFacts({ userId: request.actorUserId });
      legacyMainParticipant = main.exists && main.participant && !main.archived;
      actor = await readWorkspaceRelationship(this.env.DB, request.workspaceId, request.actorUserId);
    }
    const metadata = this.metadataRow();
    if (!metadata || actor?.status !== "active" || metadata.archived_at !== null) {
      return ScopeSharingOptionsSchema.parse({ scopes: [], completeWorkstreamTargets: null });
    }
    const parent: ScopeGrantTarget = { kind: "workstream", workspaceId: request.workspaceId, parentId: request.parentId };
    const canShare = (target: ScopeGrantTarget) => {
      const access = this.resolveScopeAccess({ userId: request.actorUserId, target }, actor);
      if (access.allowed && access.writable && access.grantIds.length > 0) return true;
      const id = target.kind === "workstream" ? "0" : target.substreamId;
      if (this.participantMigrationPhase(id) !== null) return false;
      return id === "0" ? legacyMainParticipant : this.parentSql.exec(
        "SELECT 1 FROM private_child_memberships WHERE substream_id=? AND user_id=? AND active=1", id, request.actorUserId,
      ).toArray().length > 0;
    };
    const scopes: Array<{ target: ScopeGrantTarget; title: string }> = [];
    if (canShare(parent)) scopes.push({ target: parent, title: "Main and inheriting substreams" });
    for (const child of this.parentSql.exec<{ substream_id: string; title: string | null; archived_at: number | null }>(
      "SELECT substream_id,title,archived_at FROM conversation_children WHERE status='ready' ORDER BY substream_id",
    ).toArray()) {
      const target: ScopeGrantTarget = { ...parent, kind: "conversation", substreamId: asSubstreamId(child.substream_id) };
      if (child.archived_at === null && canShare(target)) scopes.push({ target,
        title: child.substream_id === "0" ? "Main" : child.title ?? "Shared substream" });
    }
    // Parents predating child registration still own a real Main conversation.
    // Discovery stays read-only; first-share preparation records it after
    // consulting the canonical source, before transferring its participants.
    if (legacyMainParticipant && !scopes.some((scope) => scope.target.kind === "conversation" && scope.target.substreamId === "0")
      && !this.parentSql.exec("SELECT 1 FROM conversation_children WHERE substream_id='0'").toArray().length) {
      scopes.push({ target:{ ...parent,kind:"conversation",substreamId:asSubstreamId("0") },title:"Main" });
    }
    const restricted = new Set(this.parentSql.exec<{ substream_id: string }>(
      "SELECT substream_id FROM conversation_children WHERE kind='child' AND status='ready' AND audience='restricted'",
    ).toArray().map((child) => child.substream_id));
    const targets = scopes.map((scope) => scope.target).filter((target) => target.kind === "workstream"
      || restricted.has(target.substreamId));
    return ScopeSharingOptionsSchema.parse({ scopes,
      completeWorkstreamTargets: this.completeWorkstreamCoverage(targets) ? targets : null });
  }

  /** Cut over only addressed legacy scopes; invitation creation rechecks grants afterwards. */
  private async prepareInvitationTargets(request: z.infer<typeof CreateScopeInvitationsSchema>): Promise<Extract<ScopeInvitationResult, { status: "denied" }> | null> {
    const inherited = request.targets.some((target) => target.kind === "workstream")
      ? this.parentSql.exec<{ substream_id: string }>("SELECT substream_id FROM conversation_children WHERE kind='child' AND status='ready' AND audience='inherits_workstream'")
        .toArray().map((child) => child.substream_id) : [];
    const substreamIds = [...new Set([...request.targets.map((target) =>
      target.kind === "workstream" ? "0" : target.substreamId), ...inherited])];
    const legacy = substreamIds.filter((id) => this.participantMigrationPhase(id) !== "complete");
    if (!legacy.length) return null;
    const actor = await readWorkspaceRelationship(this.env.DB, request.workspaceId, request.actorUserId);
    if (actor?.status !== "active") return { status: "denied", reason: "relationship_required" };
    // Main's directory projection is not authorization evidence. Consult its
    // canonical roster before transferring authority; workspace-public reading
    // alone must not let an arbitrary member initiate sharing.
    const parentAccess = this.resolveScopeAccess({ userId: request.actorUserId,
      target: { kind: "workstream", workspaceId: request.workspaceId, parentId: request.parentId } }, actor);
    let sharesInherited = parentAccess.allowed && parentAccess.writable && parentAccess.grantIds.length > 0;
    if (legacy.includes("0")) {
      const main = await createIdentityObjectPort(this.env, request.workspaceId, request.parentId)
        .readAuthorizationFacts({ userId: request.actorUserId });
      if (!main.exists || !main.participant || main.archived) return { status: "denied", reason: "sharing_required" };
      // Older parents list Main implicitly. Register only after the real source
      // confirms its existence and the sharer's participation; never fabricate
      // source authority from a directory row or workspace-public visibility.
      this.registerChild("0", "main", null, Date.now());
      sharesInherited = true;
    }
    for (const substreamId of legacy) {
      if (substreamId !== "0" && !(sharesInherited && inherited.includes(substreamId)) && !this.parentSql.exec(
        "SELECT 1 FROM private_child_memberships WHERE substream_id=? AND user_id=? AND active=1",
        substreamId, request.actorUserId,
      ).toArray().length) return { status: "denied", reason: "sharing_required" };
    }
    for (const substreamId of legacy) {
      const address = { workspaceId: request.workspaceId, parentId: request.parentId };
      const migration = substreamId === "0"
        ? await this.beginMainParticipantMigration(address)
        : await this.beginChildParticipantMigration({ ...address, substreamId });
      if (migration.status === "conflict") return { status: "denied", reason: "migration_pending" };
      // Foreground progress avoids a polling-only first-share experience. The
      // persisted alarm and transfer token recover any interrupted boundary.
      if (substreamId === "0") await this.runMainParticipantMigration();
      else await this.runChildParticipantMigration(asSubstreamId(substreamId));
    }
    return null;
  }

  async listManagedScopeGrants(input: z.infer<typeof ScopeGrantManagementRequestSchema>) {
    await this.initialized;
    const request = ScopeGrantManagementRequestSchema.parse(input);
    this.assertParent(request.target.workspaceId, request.target.parentId);
    const denied = { status: "denied" as const, reason: "sharing_required" as const };
    const actor = await readWorkspaceRelationship(this.env.DB, request.target.workspaceId, request.actorUserId);
    const canManage = (relationship: WorkspaceRelationship | null) => {
      const access = this.resolveScopeAccess({ target: request.target, userId: request.actorUserId }, relationship);
      return access.allowed && access.writable && access.grantIds.length > 0;
    };
    if (!canManage(actor)) return ManagedScopeGrantsSchema.parse(denied);
    const store = this.scopeGrants(request.target);
    const initial = store.forTarget(request.target).filter((grant) => grant.active);
    const profiles = new Map(await Promise.all(initial.map(async (grant) => [grant.userId,
      await this.env.DB.prepare("SELECT name,email FROM users WHERE id=?").bind(grant.userId)
        .first<{ name: string; email: string }>(),
    ] as const)));
    const current = await readWorkspaceRelationship(this.env.DB, request.target.workspaceId, request.actorUserId);
    // Profile lookup interleaves. Re-read authority and grants before releasing
    // labels or revisions; a stale list cannot reveal a scope after revocation.
    if (!canManage(current) || current?.incarnation !== actor?.incarnation || current?.revision !== actor?.revision) {
      return ManagedScopeGrantsSchema.parse(denied);
    }
    return ManagedScopeGrantsSchema.parse({ status: "ready", grants: store.forTarget(request.target)
      .filter((grant) => grant.active && profiles.has(grant.userId)).map((grant) => ({ grant,
        name: profiles.get(grant.userId)?.name ?? null, email: profiles.get(grant.userId)?.email ?? null })) });
  }

  async listScopeInvitations(input: z.infer<typeof ListScopeInvitationsSchema>) {
    await this.initialized;
    const request = ListScopeInvitationsSchema.parse(input);
    this.assertParent(request.target.workspaceId, request.target.parentId);
    return this.scopeInvitations().list(request);
  }

  async createScopeInvitations(input: z.infer<typeof CreateScopeInvitationsSchema>): Promise<ScopeInvitationResult> {
    await this.initialized;
    const request = parseRpcInput(CreateScopeInvitationsSchema, input, "create_scope_invitations");
    this.assertParent(request.workspaceId, request.parentId);
    const denied = await this.prepareInvitationTargets(request);
    if (denied) return denied;
    const result = await this.scopeInvitations().create(request);
    await this.armNextAlarm();
    return ScopeInvitationResultSchema.parse(result);
  }

  async acceptScopeInvitation(input: z.infer<typeof AcceptScopeInvitationSchema>): Promise<ScopeInvitationResult> {
    await this.initialized;
    const request = parseRpcInput(AcceptScopeInvitationSchema, input, "accept_scope_invitation");
    this.assertParent(request.workspaceId, request.parentId);
    const result = await this.scopeInvitations().accept(request);
    await this.armNextAlarm();
    return ScopeInvitationResultSchema.parse(result);
  }

  async revokeScopeInvitation(input: z.infer<typeof RevokeScopeInvitationSchema>): Promise<ScopeInvitationResult> {
    await this.initialized;
    const request = parseRpcInput(RevokeScopeInvitationSchema, input, "revoke_scope_invitation");
    this.assertParent(request.workspaceId, request.parentId);
    return ScopeInvitationResultSchema.parse(await this.scopeInvitations().revoke(request));
  }

  /** Canonical exact-scope admission for the new sharing protocol. No Main preflight. */
  async readScopeAccess(input: ScopeAccessRequest): Promise<ScopeAccessResult> {
    await this.initialized;
    const request = parseRpcInput(ScopeAccessRequestSchema, input, "scope_access");
    const relationship = await readWorkspaceRelationship(this.env.DB, request.target.workspaceId, request.userId);
    return this.resolveScopeAccess(request, relationship);
  }

  async readSharedWorkstream(input: z.infer<typeof SharedWorkstreamRequestSchema>) {
    await this.initialized;
    const request = SharedWorkstreamRequestSchema.parse(input);
    const relationship = await readWorkspaceRelationship(this.env.DB, request.workspaceId, request.userId);
    const metadata = this.metadataRow();
    if (!metadata || relationship?.status !== "active" || relationship.incarnation !== request.membershipIncarnation) return null;
    this.assertParent(request.workspaceId, request.parentId);
    // No external await after relationship admission: grants, lifecycle and labels
    // are read together from the canonical parent, not from the discovery index.
    const conversations = this.parentSql.exec<{ substream_id: string; title: string | null; archived_at: number | null }>(
      "SELECT substream_id,title,archived_at FROM conversation_children ORDER BY substream_id",
    ).toArray().filter((child) => this.resolveScopeAccess({ userId: request.userId,
      target: { kind: "conversation", workspaceId: request.workspaceId, parentId: request.parentId,
        substreamId: asSubstreamId(child.substream_id) } }, relationship).allowed)
      .map((child) => ({ substreamId: child.substream_id, archived: metadata.archived_at !== null || child.archived_at !== null,
        title: child.substream_id === "0" ? "Main" : child.title ?? "Shared substream" }));
    if (!conversations.length) return null;
    return SharedWorkstreamSchema.parse({ parentId: request.parentId, archived: metadata.archived_at !== null,
      title: conversations.some((child) => child.substreamId === "0") ? metadata.title : null,
      ...(conversations.some((child) => child.substreamId === "0") && this.childCommonProjections()[0]?.appearance
        ? { appearance: this.childCommonProjections()[0]!.appearance } : {}),
      conversations });
  }

  private resolveScopeAccess(request: ScopeAccessRequest, relationship: WorkspaceRelationship | null): ScopeAccessResult {
    const metadata = this.metadataRow();
    if (!metadata) return { allowed: false, reason: "not_found" };
    this.assertParent(request.target.workspaceId, request.target.parentId);
    const conversation = request.target.kind === "conversation" ? first(this.parentSql.exec<{
      status: "reserved" | "ready" | "failed";
      archived_at: number | null;
      audience: "restricted" | "inherits_workstream";
    }>(`SELECT status, archived_at, audience FROM conversation_children WHERE substream_id = ?`, request.target.substreamId)) : null;
    return ScopeAccessResultSchema.parse(resolveScopedAccess({
      userId: request.userId, target: request.target, relationship,
      parentExists: true, parentArchived: metadata.archived_at !== null,
      parentVisibility: metadata.scope,
      conversation: conversation ? { status: conversation.status, archived: conversation.archived_at !== null, audience: conversation.audience } : null,
      grants: this.scopeGrants(request.target).forUser(request.userId),
    }));
  }

  /**
   * Workers supply the authenticated actor, never an actor chosen by the model.
   * Local grants and lifecycle are re-read after the external relationship reads,
   * with no await between the sharing decision and its durable mutation.
   */
  async mutateScopeGrant(input: ScopeGrantMutation): Promise<ScopeGrantMutationResult> {
    await this.initialized;
    const request = parseRpcInput(ScopeGrantMutationSchema, input, "scope_grant_mutation");
    const result = await this.authorizedGrantMutation(request,false);
    if (result.status === "committed") {
      const targets = request.target.kind === "conversation" ? [request.target.substreamId]
        : this.parentSql.exec<{ substream_id: string }>(
          "SELECT substream_id FROM participant_projection_targets",
        ).toArray().map((row) => row.substream_id);
      await Promise.all(targets.map((substreamId) => this.deliverParticipantProjection(substreamId, request.userId)));
    }
    return result;
  }

  async mutateParticipantGrant(input: ParticipantGrantMutation): Promise<ScopeGrantMutationResult> {
    await this.initialized;
    const request = parseRpcInput(ParticipantGrantMutationSchema,input,"participant_grant_mutation");
    const result = await this.authorizedGrantMutation({ ...request,expectedRevision:0 },true);
    if (result.status === "committed") {
      // Compatibility APIs return a participant, so converge the addressed
      // roster before replying. The durable alarm remains the recovery path.
      // Read the newest pending projection, not this operation's old receipt:
      // retrying a superseded add must never undo a subsequent removal.
      await this.deliverParticipantProjection(request.target.kind === "workstream" ? "0" : request.target.substreamId, request.userId);
    }
    return result;
  }

  async admitConnectorParticipants(input: z.infer<typeof ConnectorParticipantAdmissionSchema>): Promise<{ status: "legacy" | "ready" | "pending" }> {
    await this.initialized;
    const request = ConnectorParticipantAdmissionSchema.parse(input);
    if (this.metadataRow()) this.assertParent(request.workspaceId, request.parentId);
    if (this.participantMigrationPhase("0") === null) return { status: "legacy" };
    const userIds = [...new Set(request.userIds)].sort();
    const canonical = JSON.stringify({ ...request, userIds });
    const receipt = this.parentSql.exec<{ request_json: string }>(
      "SELECT request_json FROM connector_participant_admissions WHERE event_id=?", request.eventId,
    ).toArray()[0];
    if (receipt) {
      if (receipt.request_json !== canonical) throw new Error("connector_participant_admission_conflict");
      const store = this.scopeGrants(request);
      for (const userId of userIds) {
        if (store.pendingParticipantProjection("0", userId)) await this.deliverParticipantProjection("0", userId);
      }
      return { status: "ready" };
    }
    const relationships = await Promise.all(userIds.map((userId) =>
      readWorkspaceRelationship(this.env.DB, request.workspaceId, userId)));
    const target = { kind: "conversation" as const, workspaceId: request.workspaceId,
      parentId: request.parentId, substreamId: asSubstreamId("0") };
    const store = this.scopeGrants(target);
    let changed = false;
    const result = this.state.storage.transactionSync(() => {
      if (this.participantMigrationPhase("0") !== "complete") return { status: "pending" as const };
      const prior = this.parentSql.exec<{ request_json: string }>(
        "SELECT request_json FROM connector_participant_admissions WHERE event_id=?", request.eventId,
      ).toArray()[0];
      if (prior) {
        if (prior.request_json !== canonical) throw new Error("connector_participant_admission_conflict");
        return { status: "ready" as const };
      }
      if (this.metadataRow()?.archived_at !== null) return { status: "pending" as const };
      for (const [index, userId] of userIds.entries()) {
        const relationship = relationships[index];
        // Provider membership can seat an ordinary workspace member. A guest
        // still needs an explicit share; connector mapping cannot widen it.
        if (relationship?.status !== "active" || relationship.accessClass !== "member") continue;
        const access = this.resolveScopeAccess({ target, userId }, relationship);
        if (access.allowed && access.grantIds.length > 0) continue;
        const mutation = store.mutateCurrent({ target, userId, actorUserId: request.addedByUserId ?? userId,
          operationId: uuidV7(), active: true }, relationship.incarnation);
        if (mutation.status !== "committed") throw new Error("connector_participant_admission_conflict");
        changed = true;
      }
      this.parentSql.exec("INSERT INTO connector_participant_admissions(event_id,request_json) VALUES (?,?)", request.eventId,canonical);
      return { status: "ready" as const };
    });
    if (changed) await this.armNextAlarm();
    if (result.status === "ready") {
      for (const userId of userIds) {
        if (store.pendingParticipantProjection("0", userId)) await this.deliverParticipantProjection("0", userId);
      }
    }
    return result;
  }

  /** Posting may join a member-readable conversation, never grant a parent or another user. */
  async joinConversation(input: ParticipantGrantMutation): Promise<{ status: "ready" | "denied" }> {
    await this.initialized;
    const request = parseRpcInput(ParticipantGrantMutationSchema, input, "join_conversation");
    if (!request.active || request.userId !== request.actorUserId || request.target.kind !== "conversation") {
      return { status: "denied" };
    }
    const relationship = await readWorkspaceRelationship(this.env.DB, request.target.workspaceId, request.userId);
    const access = this.migratedConversationAccess({ ...request.target, userId: request.userId }, request.target.substreamId, relationship);
    if (!access.allowed || !access.writable || relationship?.status !== "active") return { status: "denied" };
    const store = this.scopeGrants(request.target);
    // Existing inherited access remains inherited. Materializing a direct grant
    // here would incorrectly survive removal of the parent grant.
    if (access.grantIds.length === 0) {
      const result = store.mutateCurrent(request, relationship.incarnation);
      if (result.status !== "committed") return { status: "denied" };
      await this.armNextAlarm();
    }
    await this.deliverParticipantProjection(request.target.substreamId, request.userId);
    return { status: store.participantProjection(request.target.substreamId, request.userId)?.active ? "ready" : "denied" };
  }

  private async authorizedGrantMutation(request: ScopeGrantMutation, useCurrentRevision: boolean): Promise<ScopeGrantMutationResult> {
    const [actor, recipient, activeIncarnations] = await Promise.all([
      readWorkspaceRelationship(this.env.DB, request.target.workspaceId, request.actorUserId),
      readWorkspaceRelationship(this.env.DB, request.target.workspaceId, request.userId),
      !request.active ? this.membershipIncarnations(request.target.workspaceId) : Promise.resolve(null),
    ]);
    if (this.parentSql.exec("SELECT 1 FROM main_participant_migration WHERE singleton=1 AND phase='pending'").toArray().length) {
      return { status: "denied", reason: "migration_pending" };
    }
    if (this.parentSql.exec("SELECT 1 FROM child_participant_migrations WHERE phase='pending' LIMIT 1").toArray().length) {
      return { status: "denied", reason: "migration_pending" };
    }
    const admission = this.resolveScopeAccess({ target: request.target, userId: request.actorUserId }, actor);
    // Implicit workspace-public reading is not the right to invite somebody.
    // Direct/inherited collaborator grants carry the scope's sharing authority.
    if (!admission.allowed || !admission.writable || admission.grantIds.length === 0) {
      return { status: "denied", reason: "sharing_required" };
    }
    if (request.active && recipient?.status !== "active") return { status: "denied", reason: "recipient_relationship_required" };
    const store = this.scopeGrants(request.target);
    if (useCurrentRevision && !request.active && request.target.kind === "conversation"
      && !store.hasOperation(request.operationId)) {
      const inherited = store.read(request.userId, { kind: "workstream", workspaceId: request.target.workspaceId,
        parentId: request.target.parentId });
      const inherits = request.target.substreamId === "0" || this.parentSql.exec<{ audience: string }>(
        "SELECT audience FROM conversation_children WHERE substream_id=?", request.target.substreamId,
      ).toArray()[0]?.audience === "inherits_workstream";
      if (inherits && inherited?.active && inherited.membershipIncarnation === recipient?.incarnation) {
        // Removing a row from a conversation must not silently revoke a parent
        // grant across sibling conversations, nor report effective removal
        // while an inherited grant continues to admit this participant.
        return { status: "denied", reason: "inherited_access" };
      }
    }
    if (!request.active && !store.hasOperation(request.operationId)
      && !store.hasParticipantAfterRemoval(request.userId,request.target, activeIncarnations ?? {})) {
      return { status:"denied",reason:"participant_required" };
    }
    const result = ScopeGrantMutationResultSchema.parse(useCurrentRevision
      ? store.mutateCurrent(ParticipantGrantMutationSchema.parse({ operationId:request.operationId,actorUserId:request.actorUserId,
        userId:request.userId,target:request.target,active:request.active }), recipient?.incarnation ?? null)
      : store.mutate(request, recipient?.incarnation ?? null));
    await this.armNextAlarm();
    return result;
  }

  /** Failed or reserved preparations have no readable content to migrate. */
  async listAuthorizationChildren(input: ConversationParentAuthorityRequest) {
    await this.initialized;
    const request = ConversationParentAuthorityRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    return { substreamIds: this.parentSql.exec<{ substream_id: string }>(
      "SELECT substream_id FROM conversation_children WHERE kind = 'main' OR status = 'ready' ORDER BY substream_id",
    ).toArray().map((row) => SubstreamIdSchema.parse(row.substream_id)) };
  }

  /** Read-only authorization evidence; validates the main roster at its canonical child. */
  async readAuthorizationFacts(input: ConversationAuthorizationRequest) {
    await this.initialized;
    const request = ConversationAuthorizationRequestSchema.parse(input);
    const metadata = this.metadataRow();
    if (!metadata) return { exists: false as const, validatedAt: Date.now() };
    this.assertParent(request.workspaceId, request.parentId);
    const migrated = request.substreamIds.filter((id) => this.participantMigrationPhase(id) !== null);
    const relationship = migrated.length
      ? await readWorkspaceRelationship(this.env.DB, request.workspaceId, request.userId) : null;
    const store = this.scopeGrants(request);
    const scopes = migrated.map((substreamId) => ({ substreamId,
      access: this.migratedConversationAccess(request, substreamId, relationship),
      revision: JSON.stringify([relationship?.incarnation, relationship?.revision,
        store.participantProjection(substreamId, request.userId)?.revision ?? 0]) }));
    if (migrated.length && migrated.length === request.substreamIds.length) {
      return { exists: true as const, authority: "grants" as const, validatedAt: Date.now(), scopes };
    }
    const main = await createIdentityObjectPort(this.env, request.workspaceId, request.parentId)
      .readAuthorizationFacts({ userId: request.userId });
    const children = (request.substreamIds.length ? request.substreamIds : this.childRegistry().map((child) => child.substreamId)).map((substreamId) => {
      const child = substreamId === '0' ? null : first(this.parentSql.exec<{
        status: string; active: number | null; version: number | null;
      }>(`SELECT child.status, member.active, member.version FROM conversation_children child
          LEFT JOIN private_child_memberships member ON member.substream_id = child.substream_id AND member.user_id = ?
          WHERE child.substream_id = ? AND child.kind = 'child'`, request.userId, substreamId));
      return { substreamId, exists: substreamId === '0' ? main.exists : Boolean(child),
        ready: substreamId === '0' || child?.status === 'ready', failed: child?.status === 'failed',
        member: substreamId === '0' || child?.active === 1, version: child?.version ?? 0 };
    });
    return { exists: true as const, authority:"legacy" as const, main, children, scopes, validatedAt: Date.now(),
      generation: this.metadataRow()?.authority_generation ?? metadata.authority_generation };
  }

  async authority(input: ConversationParentAuthorityRequest): Promise<ConversationParentAuthorityResult> {
    await this.initialized;
    const request = ConversationParentAuthorityRequestSchema.parse(input);
    const row = this.metadataRow();
    if (!row) {
      return ConversationParentAuthorityResultSchema.parse({ exists: false, authorityGeneration: 0, archived: false });
    }
    this.assertParent(request.workspaceId, request.parentId);
    return ConversationParentAuthorityResultSchema.parse({
      exists: true,
      authorityGeneration: row.authority_generation,
      archived: row.archived_at !== null,
    });
  }

  /** Reserve against current parent authority without a caller-side preflight RPC. */
  async reserveAgentChild(input: Omit<ConversationParentReserveChildRequest, "authorityGeneration" | "directory" | "kind">): Promise<ConversationParentReserveChildResult> {
    const authority = await this.authority({ workspaceId: input.workspaceId, parentId: input.parentId });
    if (!authority.exists || authority.archived) throw new Error("workstream_archived");
    return this.reserveChild({ ...input, kind: "child", authorityGeneration: authority.authorityGeneration });
  }

  /**
   * Record a child before it is addressed.
   *
   * Reserving the main conversation of a work stream that does not exist yet
   * creates this object's row and a version-one provisional directory outbox.
   * Ordinary callers deliver it synchronously. Creation may explicitly defer
   * that RPC, overlap it with child initialization, and then flush the exact
   * version-one rows before answering. The child's first real aggregate lands
   * as version 2 and replaces the provisional projection.
   */
  async reserveChild(input: ConversationParentReserveChildRequest): Promise<ConversationParentReserveChildResult> {
    await this.initialized;
    const request = ConversationParentReserveChildRequestSchema.parse(input);
    const now = Date.now();
    const reserved = this.state.storage.transactionSync(() => {
      let metadata = this.metadataRow();
      if (!metadata) {
        if (request.substreamId !== "0" || !request.directory) throw new Error("workstream_parent_missing");
        this.insertProvisionalMetadata(request, request.directory, now);
        metadata = this.metadataRow();
        if (!metadata) throw new Error("workstream_metadata_missing");
      } else {
        this.assertParent(request.workspaceId, request.parentId);
      }
      if (request.kind === "child" && metadata.archived_at !== null) throw new Error("workstream_archived");
      const registered = this.registerChild(request.substreamId, request.kind, request.createdByUserId, now);
      const envelopes: ParentEffectEnvelope[] = [];
      if (registered && request.substreamId === "0" && request.directory) {
        const directory = request.directory;
        const common = this.enqueueProjection("common", {
          kind: "directory_common",
          title: directory.title,
          description: directory.description,
          preview: "",
          scope: directory.scope,
          state: "idle",
          systemKind: directory.systemKind,
          lastActivityAt: directory.createdAt,
          completedAt: null,
          archivedAt: null,
          emailAddress: directory.emailAddress,
          createdByUserId: request.createdByUserId,
          titleStatus: directory.titleStatus,
          createdAt: directory.createdAt,
          updatedAt: directory.createdAt,
        }, now);
        if (common) envelopes.push(common);
        if (request.createdByUserId) {
          const viewer = this.enqueueProjection(`user:${request.createdByUserId}`, {
            kind: "directory_user",
            userId: request.createdByUserId,
            isParticipant: true,
            participantAddedAt: directory.createdAt,
            unreadCount: 0,
            youAreMentioned: false,
            unseen: false,
            listable: true,
          }, now);
          if (viewer) envelopes.push(viewer);
        }
      }
      return { authorityGeneration: metadata.authority_generation, envelopes };
    });
    if (reserved.envelopes.length > 0 && !request.deferDirectoryDelivery) {
      await this.deliverProvisionalDirectory(reserved.envelopes);
    }
    await this.armNextAlarm();
    return ConversationParentReserveChildResultSchema.parse({
      reserved: true,
      authorityGeneration: reserved.authorityGeneration,
    });
  }

  /**
   * Finish a deferred provisional directory delivery before the create route
   * answers. The outbox is the authority, so retrying after an accepted
   * delivery is a no-op and an alarm remains the recovery path.
   */
  async flushProvisionalDirectory(input: ConversationParentAuthorityRequest): Promise<void> {
    await this.initialized;
    const request = ConversationParentAuthorityRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    const provisional = this.provisionalDirectoryEffects(false);
    if (provisional.length > 0) await this.deliverProvisionalDirectory(provisional);
    await this.armNextAlarm();
  }

  /** The reservation's exact version-one rows; no unrelated outbox cap or backoff applies. */
  private provisionalDirectoryEffects(dueOnly: boolean, now = Date.now()): ParentEffectEnvelope[] {
    const sql = `SELECT payload_json FROM durable_outbox
      WHERE state IN ('pending', 'inflight')
        AND source_version = 1
        AND effect_kind IN ('directory_common', 'directory_user')
        ${dueOnly ? "AND not_before <= ?" : ""}
      ORDER BY CASE effect_kind WHEN 'directory_common' THEN 0 ELSE 1 END, message_id`;
    const rows = dueOnly
      ? this.parentSql.exec<{ payload_json: string }>(sql, now).toArray()
      : this.parentSql.exec<{ payload_json: string }>(sql).toArray();
    return rows.map((row) => ParentEffectEnvelopeSchema.parse(JSON.parse(row.payload_json)));
  }

  private canPreparePrivateChild(address: { workspaceId: string; parentId: string }, userId: UserId,
    relationship: WorkspaceRelationship | null): boolean {
    if (this.participantMigrationPhase("0") !== null) {
      const access = this.migratedConversationAccess({ ...address, userId }, asSubstreamId("0"), relationship);
      return access.allowed && access.writable;
    }
    return this.canRead(userId);
  }

  /** Reserve one creator-only nonzero child and its immutable preparation receipt. */
  async beginPrivateChildPreparation(
    input: BeginPrivateChildPreparationRequest,
  ): Promise<PrivateChildPreparationOperation> {
    await this.initialized;
    const request = BeginPrivateChildPreparationRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    const initialMembers = [...new Set(request.membershipInitializer.memberUserIds)];
    if (initialMembers.length !== request.membershipInitializer.memberUserIds.length
      || !initialMembers.includes(request.creatorUserId)) {
      throw new Error("private_child_membership_initializer_invalid");
    }
    const relationships = new Map(this.participantMigrationPhase("0") !== null
      ? await Promise.all(initialMembers.map(async (userId) => [userId,
        await readWorkspaceRelationship(this.env.DB, request.workspaceId, userId)] as const)) : []);
    if (!this.canPreparePrivateChild(request, request.creatorUserId, relationships.get(request.creatorUserId) ?? null)) {
      throw new Error("private_child_creator_not_admitted_to_parent");
    }
    for (const userId of initialMembers) {
      if (!this.canPreparePrivateChild(request, userId, relationships.get(userId) ?? null)) {
        throw new Error("private_child_initial_member_not_admitted_to_parent");
      }
    }
    const canonicalRequest = JSON.stringify(request);
    const existing = this.privateChildPreparation(request.operationId);
    if (existing) {
      const stored = first(this.parentSql.exec<{ request_json: string }>(
        `SELECT request_json FROM private_child_preparations WHERE operation_id = ?`,
        request.operationId,
      ));
      if (stored?.request_json !== canonicalRequest) throw new Error("private_child_preparation_conflict");
      return existing;
    }
    const now = Date.now();
    const substreamId = uuidV7(now);
    this.state.storage.transactionSync(() => {
      this.registerChild(substreamId, "child", request.creatorUserId, now);
      this.parentSql.exec(
        `UPDATE conversation_children SET status = 'reserved', title = ?, updated_at = ?
          WHERE substream_id = ?`,
        request.title, now, substreamId,
      );
      for (const userId of initialMembers) {
        this.parentSql.exec(
          `INSERT INTO private_child_memberships
             (substream_id, user_id, active, version, added_by_user_id, added_at, removed_at, updated_at)
           VALUES (?, ?, 1, 1, ?, ?, NULL, ?)`,
          substreamId, userId, request.creatorUserId, now, now,
        );
      }
      this.parentSql.exec(
        `INSERT INTO private_child_preparations
           (operation_id, substream_id, creator_user_id, request_json, capture_json,
            completed_parts_json, prepared_context_json, status, error_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, '[]', NULL, 'preparing', NULL, ?, ?)`,
        request.operationId, substreamId, request.creatorUserId, canonicalRequest, now, now,
      );
      for (const userId of initialMembers) {
        this.insertPrivateChildMembershipEffect({
          operationId: `prepare:${request.operationId}:${userId}`,
          substreamId,
          userId,
          actorUserId: request.creatorUserId,
          active: true,
          membershipVersion: 1,
          now,
        });
      }
    });
    await this.armNextAlarm();
    return this.requirePrivateChildPreparation(request.operationId);
  }

  async readPrivateChildPreparation(
    input: ReadPrivateChildPreparationRequest,
  ): Promise<PrivateChildPreparationOperation | null> {
    await this.initialized;
    const request = ReadPrivateChildPreparationRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    return this.privateChildPreparation(request.operationId);
  }

  async claimPrivateChildConfirmation(
    input: ClaimPrivateChildConfirmationRequest,
  ): Promise<PrivateChildPreparationOperation> {
    await this.initialized;
    const request = parseRpcInput(ClaimPrivateChildConfirmationRequestSchema, input, "private_child_confirmation");
    this.assertParent(request.workspaceId, request.parentId);
    const relationship = this.participantMigrationPhase("0") !== null
      ? await readWorkspaceRelationship(this.env.DB, request.workspaceId, request.actorUserId) : null;
    this.state.storage.transactionSync(() => {
      const operation = this.requirePrivateChildPreparation(request.operationId);
      if (operation.creatorUserId !== request.actorUserId) throw new Error("private_child_confirmation_forbidden");
      if (!this.canPreparePrivateChild(request, request.actorUserId, relationship)) throw new Error("private_child_confirmation_forbidden");
      if (operation.status === "failed") throw new Error("private_child_preparation_failed");
      if (operation.status === "preparing") throw new Error("private_child_context_not_prepared");
      if (operation.status !== "prepared" && operation.preparedConversationHash !== (request.preparedConversationHash ?? null)) {
        throw new Error("private_child_initialization_conflict");
      }
      if (operation.status === "prepared") {
        this.parentSql.exec(
          `UPDATE private_child_preparations SET status = 'confirming', prepared_conversation_hash = ?, updated_at = ? WHERE operation_id = ?`,
          request.preparedConversationHash ?? null, Date.now(), request.operationId,
        );
      }
    });
    return this.requirePrivateChildPreparation(request.operationId);
  }

  async savePrivateChildCapture(input: SavePrivateChildCaptureRequest): Promise<PrivateChildPreparationOperation> {
    await this.initialized;
    const request = SavePrivateChildCaptureRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    this.storePreparationJson(request.operationId, "capture_json", JSON.stringify(request.capture), ["preparing"]);
    return this.requirePrivateChildPreparation(request.operationId);
  }

  async savePrivateChildPart(input: SavePrivateChildPartRequest): Promise<PrivateChildPreparationOperation> {
    await this.initialized;
    const request = SavePrivateChildPartRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    const operation = this.requirePrivateChildPreparation(request.operationId);
    if (operation.status !== "preparing") throw new Error("private_child_preparation_not_writable");
    const existing = operation.completedParts.find((part) => part.recipe.id === request.part.recipe.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(request.part)) {
      throw new Error("private_child_part_conflict");
    }
    if (!existing) {
      this.parentSql.exec(
        `UPDATE private_child_preparations SET completed_parts_json = ?, updated_at = ?
          WHERE operation_id = ? AND status = 'preparing'`,
        JSON.stringify([...operation.completedParts, request.part]), Date.now(), request.operationId,
      );
    }
    return this.requirePrivateChildPreparation(request.operationId);
  }

  async savePreparedPrivateChildContext(
    input: SavePreparedPrivateChildContextRequest,
  ): Promise<PrivateChildPreparationOperation> {
    await this.initialized;
    const request = SavePreparedPrivateChildContextRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    const json = JSON.stringify(request.preparedContext);
    const creator = this.requirePrivateChildPreparation(request.operationId).creatorUserId;
    const relationship = this.participantMigrationPhase("0") !== null
      ? await readWorkspaceRelationship(this.env.DB, request.workspaceId, creator) : null;
    const operation = this.requirePrivateChildPreparation(request.operationId);
    // Re-read local grant authority after the relationship read, before commit/return.
    if (!this.canPreparePrivateChild(request, operation.creatorUserId, relationship)) throw new Error("private_child_preparation_forbidden");
    if (operation.preparedContext && JSON.stringify(operation.preparedContext) !== json) {
      throw new Error("private_child_context_conflict");
    }
    if (!operation.preparedContext) {
      this.state.storage.transactionSync(() => {
        const current = this.requirePrivateChildPreparation(request.operationId);
        if (current.status !== "preparing") throw new Error("private_child_preparation_not_writable");
        this.parentSql.exec(
          `UPDATE private_child_preparations
              SET prepared_context_json = ?, completed_parts_json = ?, status = 'prepared', updated_at = ?
            WHERE operation_id = ?`,
          json, JSON.stringify(request.preparedContext.parts), Date.now(), request.operationId,
        );
      });
    }
    return this.requirePrivateChildPreparation(request.operationId);
  }

  async setPrivateChildTerminalStatus(
    input: SetPrivateChildTerminalStatusRequest,
  ): Promise<PrivateChildPreparationOperation> {
    await this.initialized;
    const request = SetPrivateChildTerminalStatusRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    const selectedOperation = this.requirePrivateChildPreparation(request.operationId);
    if (request.status === "ready" && selectedOperation.status === "confirming") {
      await this.drainPrivateChildMembershipEffects(selectedOperation.substreamId);
    }
    const incarnations = request.status === "ready" && this.participantMigrationPhase("0") !== null
      ? await this.membershipIncarnations(request.workspaceId) : {};
    const relationship = this.participantMigrationPhase("0") !== null
      ? await readWorkspaceRelationship(this.env.DB, request.workspaceId, selectedOperation.creatorUserId) : null;
    this.state.storage.transactionSync(() => {
      const operation = this.requirePrivateChildPreparation(request.operationId);
      if (!this.canPreparePrivateChild(request, operation.creatorUserId, relationship)) throw new Error("private_child_preparation_forbidden");
      if (operation.status === request.status) return;
      if (operation.status === "ready" || operation.status === "failed") {
        throw new Error("private_child_terminal_status_conflict");
      }
      if (request.status === "failed" && operation.status === "confirming") {
        throw new Error("private_child_confirmation_in_progress");
      }
      if (request.status === "ready" && operation.status !== "confirming") {
        throw new Error("private_child_context_not_prepared");
      }
      if (request.status === "ready" && first(this.parentSql.exec(
        `SELECT operation_id FROM private_child_membership_effects
          WHERE substream_id = ? AND state <> 'delivered' LIMIT 1`,
        operation.substreamId,
      ))) throw new Error("private_child_membership_delivery_pending");
      const now = Date.now();
      this.parentSql.exec(
        `UPDATE private_child_preparations SET status = ?, error_code = ?, updated_at = ?
          WHERE operation_id = ?`,
        request.status, request.status === "failed" ? request.errorCode : null, now, request.operationId,
      );
      this.parentSql.exec(
        `UPDATE conversation_children SET status = ?, title = COALESCE(?, title), updated_at = ?
          WHERE substream_id = ?`,
        request.status, request.title ?? null, now, operation.substreamId,
      );
      // Publication and durable handoff intent share one commit. A child under
      // grant authority must never be left permanently on the legacy roster.
      if (request.status === "ready" && this.participantMigrationPhase("0") !== null) {
        const migration = this.startChildParticipantMigration({ workspaceId: request.workspaceId, parentId: request.parentId, substreamId: operation.substreamId }, incarnations);
        if (migration.status === "conflict") throw new Error("private_child_participant_migration_conflict");
      }
    });
    if (request.status === "ready") {
      await this.armNextAlarm();
      await this.runChildParticipantMigration(selectedOperation.substreamId);
      const now = Date.now();
      for (const member of this.parentSql.exec<{ user_id: string }>(
        `SELECT user_id FROM private_child_memberships WHERE substream_id = ? AND active = 1`,
        selectedOperation.substreamId,
      ).toArray()) {
        this.advancePrivateChildrenVersion(member.user_id, now);
      }
    }
    await this.broadcastMetadata();
    return this.requirePrivateChildPreparation(request.operationId);
  }

  async listVisiblePrivateChildren(
    input: ListVisiblePrivateChildrenRequest,
  ): Promise<ListVisiblePrivateChildrenResult> {
    await this.initialized;
    const request = ListVisiblePrivateChildrenRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    return ListVisiblePrivateChildrenResultSchema.parse({
      children: this.visiblePrivateChildrenForUser(request.userId),
    });
  }

  async addPrivateChildParticipant(
    input: MutatePrivateChildParticipantRequest,
  ): Promise<MutatePrivateChildParticipantResult> {
    return this.mutatePrivateChildParticipant(input, true);
  }

  async removePrivateChildParticipant(
    input: MutatePrivateChildParticipantRequest,
  ): Promise<MutatePrivateChildParticipantResult> {
    return this.mutatePrivateChildParticipant(input, false);
  }

  /** Archive the child registry entry without deleting membership or transcript. */
  async setPrivateChildArchived(
    input: SetPrivateChildArchivedRequest,
  ): Promise<SetPrivateChildArchivedResult> {
    await this.initialized;
    const request = SetPrivateChildArchivedRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    const relationship = this.participantMigrationPhase(request.substreamId) !== null
      ? await readWorkspaceRelationship(this.env.DB, request.workspaceId, request.actorUserId) : null;
    const now = Date.now();
    const result = this.state.storage.transactionSync(() => {
      const child = first(this.parentSql.exec<{ status: string; archived_at: number | null }>(
        `SELECT status, archived_at FROM conversation_children
          WHERE substream_id = ? AND kind = 'child'`,
        request.substreamId,
      ));
      if (!child || child.status !== "ready") throw new Error("private_child_not_ready");
      if (this.metadataRow()?.archived_at != null) throw new Error("workstream_archived");
      if (this.participantMigrationPhase(request.substreamId) !== null) {
        if (!this.migratedConversationAccess({ ...request, userId: request.actorUserId },
          request.substreamId, relationship).allowed) throw new Error("private_child_participant_required");
      } else {
        if (!this.canRead(request.actorUserId)) throw new Error("private_child_participant_required");
        const actor = first(this.parentSql.exec<{ active: number }>(
          `SELECT active FROM private_child_memberships WHERE substream_id = ? AND user_id = ?`,
          request.substreamId, request.actorUserId,
        ));
        if (actor?.active !== 1) throw new Error("private_child_participant_required");
      }
      if ((child.archived_at !== null) === request.archived) {
        return { outcome: "unchanged" as const, archivedAt: child.archived_at };
      }
      const archivedAt = request.archived ? now : null;
      this.parentSql.exec(
        `UPDATE conversation_children SET archived_at = ?, updated_at = ?, lifecycle_version = lifecycle_version + 1, lifecycle_not_before = 0 WHERE substream_id = ?`,
        archivedAt, now, request.substreamId,
      );
      // After the update and inside the same transaction, so each member's
      // recomputed row set reflects the state this call just wrote rather than
      // the one it left.
      this.advancePrivateChildrenVersionsFor(request.substreamId, now);
      return {
        outcome: request.archived ? "archived" as const : "restored" as const,
        archivedAt,
      };
    });
    await this.armNextAlarm();
    await this.drainPrivateChildLifecycleEffects();
    // The child enforces the pushed archive locally, including already-open sockets.
    if (result.outcome !== "unchanged") await this.broadcastMetadata();
    return SetPrivateChildArchivedResultSchema.parse(result);
  }

  private privateChildLifecycleDueAt(): number | null {
    return first(this.parentSql.exec<{ due_at: number | null }>(
      `SELECT MIN(lifecycle_not_before) AS due_at FROM conversation_children
       WHERE lifecycle_version > lifecycle_delivered_version`,
    ))?.due_at ?? null;
  }

  private async drainPrivateChildLifecycleEffects(): Promise<void> {
    const identity = this.parentIdentity();
    if (!identity) return;
    const rows = this.parentSql.exec<{ substream_id: string; archived_at: number | null; lifecycle_version: number }>(
      `SELECT substream_id, archived_at, lifecycle_version FROM conversation_children
       WHERE lifecycle_version > lifecycle_delivered_version AND lifecycle_not_before <= ?`, Date.now(),
    ).toArray();
    for (const row of rows) {
      try {
        const child = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS,
          identity.workspaceId, conversationObjectName(this.env.AVALON_REGION,
            identity.workspaceId, identity.parentId, asSubstreamId(row.substream_id)));
        await child.applyPrivateChildLifecycle({ workspaceId: identity.workspaceId,
          parentId: identity.parentId, substreamId: row.substream_id,
          version: row.lifecycle_version, archivedAt: row.archived_at });
        this.parentSql.exec(`UPDATE conversation_children SET lifecycle_delivered_version = MAX(lifecycle_delivered_version, ?)
          WHERE substream_id = ?`, row.lifecycle_version, row.substream_id);
      } catch (error) {
        this.parentSql.exec(`UPDATE conversation_children SET lifecycle_not_before = ? WHERE substream_id = ?`,
          Date.now() + PRIVATE_CHILD_EFFECT_RETRY_MS, row.substream_id);
        logWarn(this.env, "private_child_lifecycle_effect_failed", {
          ...this.parentLogFields(), substream_id: row.substream_id, error: String(error),
        });
      }
    }
  }

  private privateChildPreparation(operationId: string): PrivateChildPreparationOperation | null {
    const row = first(this.parentSql.exec<PrivateChildPreparationRow>(
      `SELECT preparation.*, child.title,
              COALESCE(member.version, 1) AS membership_version
         FROM private_child_preparations preparation
         JOIN conversation_children child ON child.substream_id = preparation.substream_id
         LEFT JOIN private_child_memberships member
           ON member.substream_id = preparation.substream_id
          AND member.user_id = preparation.creator_user_id
        WHERE preparation.operation_id = ?`,
      operationId,
    ));
    if (!row) return null;
    const request = BeginPrivateChildPreparationRequestSchema.parse(JSON.parse(row.request_json));
    return PrivateChildPreparationOperationSchema.parse({
      operationId: row.operation_id,
      substreamId: row.substream_id,
      creatorUserId: row.creator_user_id,
      title: row.title,
      sourceSubstreamId: request.sourceSubstreamId,
      sourceThroughTurnId: request.sourceThroughTurnId,
      recipe: request.recipe,
      status: row.status,
      preparedConversationHash: row.prepared_conversation_hash,
      capture: row.capture_json ? JSON.parse(row.capture_json) : null,
      completedParts: JSON.parse(row.completed_parts_json),
      preparedContext: row.prepared_context_json ? JSON.parse(row.prepared_context_json) : null,
      errorCode: row.error_code,
      membershipVersion: row.membership_version,
      membershipInitializer: request.membershipInitializer,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private requirePrivateChildPreparation(operationId: string): PrivateChildPreparationOperation {
    const operation = this.privateChildPreparation(operationId);
    if (!operation) throw new Error("private_child_preparation_not_found");
    return operation;
  }

  private storePreparationJson(
    operationId: string,
    column: "capture_json",
    value: string,
    writableStatuses: readonly ("preparing" | "prepared")[],
  ): void {
    this.state.storage.transactionSync(() => {
      const row = first(this.parentSql.exec<{ status: "preparing" | "prepared" | "confirming" | "ready" | "failed"; value: string | null }>(
        `SELECT status, ${column} AS value FROM private_child_preparations WHERE operation_id = ?`,
        operationId,
      ));
      if (!row) throw new Error("private_child_preparation_not_found");
      if (row.value !== null) {
        if (row.value !== value) throw new Error("private_child_preparation_conflict");
        return;
      }
      if (!writableStatuses.includes(row.status as "preparing" | "prepared")) {
        throw new Error("private_child_preparation_not_writable");
      }
      this.parentSql.exec(
        `UPDATE private_child_preparations SET ${column} = ?, updated_at = ? WHERE operation_id = ?`,
        value, Date.now(), operationId,
      );
    });
  }

  private async mutatePrivateChildParticipant(
    input: MutatePrivateChildParticipantRequest,
    active: boolean,
  ): Promise<MutatePrivateChildParticipantResult> {
    await this.initialized;
    const request = MutatePrivateChildParticipantRequestSchema.parse(input);
    this.assertParent(request.workspaceId, request.parentId);
    const migration = this.parentSql.exec<{ phase: string }>(
      "SELECT phase FROM child_participant_migrations WHERE substream_id=?",request.substreamId,
    ).toArray()[0];
    if (migration) {
      if (migration.phase !== "complete") throw new Error("participant_migration_pending");
      const operationId = await stableUuid(["legacy-child-participant",request.operationId]);
      const result = await this.mutateParticipantGrant({ operationId,actorUserId:request.actorUserId,userId:request.userId,
        target:{ kind:"conversation",workspaceId:request.workspaceId,parentId:request.parentId,substreamId:request.substreamId },active });
      if (result.status === "denied") {
        if (result.reason === "participant_required") throw new Error("private_child_last_participant");
        throw new Error(result.reason === "migration_pending" ? "participant_migration_pending" : "private_child_participant_required");
      }
      if (result.status !== "committed") throw new Error("participant_grant_conflict");
      return { outcome:active ? "added" : "removed",membershipVersion:result.grant.revision };
    }
    if (active && !this.canRead(request.userId)) {
      throw new Error("private_child_member_not_admitted_to_parent");
    }
    if (!this.canRead(request.actorUserId)) throw new Error("private_child_participant_required");
    const now = Date.now();
    const result = this.state.storage.transactionSync(() => {
      const child = first(this.parentSql.exec<{ status: string; archived_at: number | null }>(
        `SELECT status, archived_at FROM conversation_children WHERE substream_id = ? AND kind = 'child'`,
        request.substreamId,
      ));
      if (!child || child.status !== "ready") throw new Error("private_child_not_ready");
      // Adding somebody to an archived substream would seat them in a room
      // that is in nobody's sidebar; removing from one is equally moot. Restore
      // it first. Refused for both directions so the roster of an archived
      // child is exactly the roster it had when it was archived.
      if (child.archived_at !== null) throw new Error("private_child_archived");
      const actor = first(this.parentSql.exec<{ active: number }>(
        `SELECT active FROM private_child_memberships WHERE substream_id = ? AND user_id = ?`,
        request.substreamId, request.actorUserId,
      ));
      if (actor?.active !== 1) throw new Error("private_child_participant_required");
      const replay = first(this.parentSql.exec<PrivateChildMembershipEffectRow>(
        `SELECT operation_id, substream_id, user_id, actor_user_id, active, membership_version
           FROM private_child_membership_effects WHERE operation_id = ?`,
        request.operationId,
      ));
      if (replay) {
        if (replay.substream_id !== request.substreamId || replay.user_id !== request.userId
          || replay.actor_user_id !== request.actorUserId || replay.active !== Number(active)) {
          throw new Error("private_child_membership_operation_conflict");
        }
        return { outcome: "unchanged" as const, membershipVersion: replay.membership_version };
      }
      const current = first(this.parentSql.exec<{ active: number; version: number }>(
        `SELECT active, version FROM private_child_memberships WHERE substream_id = ? AND user_id = ?`,
        request.substreamId, request.userId,
      ));
      if (!active && !current) {
        this.insertPrivateChildMembershipEffect({
          operationId: request.operationId, substreamId: request.substreamId,
          userId: request.userId, actorUserId: request.actorUserId,
          active, membershipVersion: 1, now, state: "delivered",
        });
        return { outcome: "not_found" as const, membershipVersion: 1 };
      }
      if (current?.active === Number(active)) {
        this.insertPrivateChildMembershipEffect({
          operationId: request.operationId, substreamId: request.substreamId,
          userId: request.userId, actorUserId: request.actorUserId,
          active, membershipVersion: current.version, now, state: "delivered",
        });
        return { outcome: "unchanged" as const, membershipVersion: current.version };
      }
      if (!active) {
        const remaining = first(this.parentSql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM private_child_memberships
            WHERE substream_id = ? AND active = 1`,
          request.substreamId,
        ))?.count ?? 0;
        if (remaining <= 1) throw new Error("private_child_last_participant");
      }
      const version = (current?.version ?? 0) + 1;
      this.parentSql.exec(
        `INSERT INTO private_child_memberships
           (substream_id, user_id, active, version, added_by_user_id, added_at, removed_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(substream_id, user_id) DO UPDATE SET
           active = excluded.active, version = excluded.version,
           added_by_user_id = CASE WHEN excluded.active = 1 THEN excluded.added_by_user_id
                                   ELSE private_child_memberships.added_by_user_id END,
           added_at = CASE WHEN excluded.active = 1 THEN excluded.added_at
                           ELSE private_child_memberships.added_at END,
           removed_at = excluded.removed_at, updated_at = excluded.updated_at`,
        request.substreamId, request.userId, Number(active), version, request.actorUserId,
        now, active ? null : now, now,
      );
      this.insertPrivateChildMembershipEffect({
        operationId: request.operationId,
        substreamId: request.substreamId,
        userId: request.userId,
        actorUserId: request.actorUserId,
        active,
        membershipVersion: version,
        now,
      });
      return { outcome: active ? "added" as const : "removed" as const, membershipVersion: version };
    });
    await this.armNextAlarm();
    await this.drainPrivateChildMembershipEffects(request.substreamId);
    this.advancePrivateChildrenVersion(request.userId, Date.now());
    await this.broadcastMetadata();
    return MutatePrivateChildParticipantResultSchema.parse(result);
  }

  private insertPrivateChildMembershipEffect(input: {
    operationId: string; substreamId: string; userId: string; actorUserId: string;
    active: boolean; membershipVersion: number; now: number;
    state?: "pending" | "delivered";
  }): void {
    this.parentSql.exec(
      `INSERT INTO private_child_membership_effects
         (operation_id, substream_id, user_id, actor_user_id, active,
          membership_version, state, attempts, not_before, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      input.operationId, input.substreamId, input.userId, input.actorUserId,
      Number(input.active), input.membershipVersion, input.state ?? "pending", input.now, input.now,
    );
  }

  private privateChildMembershipEffectsDueAt(): number | null {
    return first(this.parentSql.exec<{ due_at: number | null }>(
      `SELECT MIN(effect.not_before) AS due_at
         FROM private_child_membership_effects effect
         JOIN conversation_children child ON child.substream_id = effect.substream_id
        WHERE effect.state IN ('pending', 'inflight') AND child.status = 'ready'
          AND NOT EXISTS(SELECT 1 FROM child_participant_migrations migration WHERE migration.substream_id=effect.substream_id)`,
    ))?.due_at ?? null;
  }

  private async drainPrivateChildMembershipEffects(substreamId?: string): Promise<void> {
    const rows = this.parentSql.exec<PrivateChildMembershipEffectRow>(
      `SELECT effect.operation_id, effect.substream_id, effect.user_id, effect.actor_user_id,
              effect.active, effect.membership_version
         FROM private_child_membership_effects effect
         JOIN conversation_children child ON child.substream_id = effect.substream_id
        WHERE effect.state IN ('pending', 'inflight') AND effect.not_before <= ?
          AND NOT EXISTS(SELECT 1 FROM child_participant_migrations migration WHERE migration.substream_id=effect.substream_id)
          AND (${substreamId ? "effect.substream_id = ?" : "child.status = 'ready'"})
        ORDER BY effect.created_at, effect.operation_id LIMIT 25`,
      ...(substreamId ? [Date.now(), substreamId] : [Date.now()]),
    ).toArray();
    for (const row of rows) {
      try {
        const identity = this.parentIdentity();
        if (!identity) throw new Error("conversation_parent_missing");
        const stub = await durableObjectStubForWorkspace(
          this.env,
          this.env.SUBSTREAM_AGENTS,
          identity.workspaceId,
          conversationObjectName(
            this.env.AVALON_REGION,
            identity.workspaceId,
            identity.parentId,
            asSubstreamId(row.substream_id),
          ),
        );
        await stub.applyPrivateChildMembership({
          workspaceId: identity.workspaceId,
          parentId: identity.parentId,
          substreamId: row.substream_id,
          userId: row.user_id,
          actorUserId: row.actor_user_id,
          active: row.active === 1,
          membershipVersion: row.membership_version,
        });
        this.parentSql.exec(
          `UPDATE private_child_membership_effects SET state = 'delivered'
            WHERE operation_id = ? AND membership_version = ?`,
          row.operation_id, row.membership_version,
        );
      } catch (error) {
        const retryAt = Date.now() + PRIVATE_CHILD_EFFECT_RETRY_MS;
        this.parentSql.exec(
          `UPDATE private_child_membership_effects
              SET state = 'pending', attempts = attempts + 1, not_before = ?
            WHERE operation_id = ? AND membership_version = ?`,
          retryAt, row.operation_id, row.membership_version,
        );
        logWarn(this.env, "private_child_membership_effect_failed", {
          ...this.parentLogFields(),
          operation_id: row.operation_id,
          substream_id: row.substream_id,
          user_id: row.user_id,
          membership_version: row.membership_version,
          retry_at: new Date(retryAt).toISOString(),
          reason: error instanceof Error ? error.message : "unknown",
        });
        throw error;
      }
    }
  }

  private insertProvisionalMetadata(
    request: ConversationParentReserveChildRequest,
    directory: NonNullable<ConversationParentReserveChildRequest["directory"]>,
    now: number,
  ): void {
    const createdAt = epoch(directory.createdAt) ?? now;
    this.state.storage.sql.exec(
      `INSERT INTO workstream_metadata
         (id, workspace_id, workstream_id, region, authority_generation, title, description,
          preview, scope, exact_state, system_kind, last_activity_at, completed_at,
          archived_at, email_address, created_by_user_id, title_status,
          source_created_at, source_updated_at, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, '', ?, 'idle', ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      request.workspaceId,
      request.parentId,
      this.env.AVALON_REGION,
      request.authorityGeneration,
      directory.title,
      directory.description,
      directory.scope,
      directory.systemKind,
      createdAt,
      directory.emailAddress,
      request.createdByUserId,
      directory.titleStatus,
      createdAt,
      createdAt,
      now,
      now,
    );
  }

  /**
   * The one synchronous parent-to-workspace delivery. Rows the workspace
   * accepts leave the outbox here; anything it does not accept stays for the
   * alarm, and the caller hears about it, because a person is waiting on this.
   */
  private async deliverProvisionalDirectory(envelopes: readonly ParentEffectEnvelope[]): Promise<void> {
    const metadata = this.metadataRow();
    if (!metadata) throw new Error("workstream_metadata_missing");
    const workspace = await durableObjectStubForWorkspace(
      this.env,
      this.env.WORKSPACE_DOS,
      metadata.workspace_id,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(metadata.workspace_id)),
    );
    const result = WorkspaceDirectoryApplyResultSchema.parse(
      await workspace.applyWorkstreamDirectoryEffects({
        workspaceId: metadata.workspace_id,
        envelopes: [...envelopes],
      }),
    );
    const accepted = new Set(result.accepted.map((entry) => `${entry.messageId}:${entry.payloadHash}`));
    this.deleteParentEffects(envelopes.filter((envelope) => (
      accepted.has(`${envelope.messageId}:${envelope.payloadHash}`)
    )));
    if (accepted.size !== envelopes.length) throw new Error("workspace_directory_provisional_row_incomplete");
  }

  // ---------------------------------------------------------------------------
  // Hooks the shared parent machinery calls.
  // ---------------------------------------------------------------------------

  protected override parentIdentity(): ConversationParentIdentity | null {
    const row = this.metadataRow();
    return row ? {
      region: row.region,
      workspaceId: asWorkspaceId(row.workspace_id),
      parentKind: "workstream",
      parentId: row.workstream_id,
      authorityGeneration: row.authority_generation,
    } : null;
  }

  protected override admitChildEnvelope(envelope: ConversationEffectEnvelope, now: number): void {
    if (envelope.parentKind !== "workstream") throw new Error("workstream_effect_parent_kind_mismatch");
    const metadata = this.metadataRow();
    // Identity is the workspace and the work stream. The generation is an
    // epoch that this row *follows*, not a gate: it is stamped once when the
    // metadata is first created and never rewritten, while a child stamps
    // every effect with whatever generation is current when it enqueues.
    // Effects are deduped by the receipt table, so accepting an effect from
    // any epoch of the same work stream is safe; the row keeps up with the
    // newest one it has seen.
    if (metadata && (
      metadata.workspace_id !== envelope.workspaceId
      || metadata.workstream_id !== envelope.parentId
    )) throw new Error("workstream_effect_identity_mismatch");
    if (metadata && envelope.generation > metadata.authority_generation) {
      this.state.storage.sql.exec(
        `UPDATE workstream_metadata SET authority_generation = ? WHERE id = 1`,
        envelope.generation,
      );
    }
    if (!metadata) this.ensureMetadata(envelope, now);
  }

  /** Only recipient-addressed child notifications leave this parent. */
  protected override forwardsChildEffect(substreamId: string, effect: ConversationEffect): boolean {
    if (substreamId === "0") return true;
    return isPersonNotificationEffect(effect);
  }

  /** A notification needs a delivery barrier, never a merge of child attention or permissions. */
  protected override prepareNotificationProjection(userId: string, now: number): void {
    const main = this.userProjection(userId) ?? WorkstreamDirectoryUserEffectSchema.parse({
      kind: "directory_user", userId, isParticipant: false, participantAddedAt: null,
      unreadCount: 0, youAreMentioned: false, unseen: false, listable: false,
      seenAttentionOrdinal: 0, manualUnreadFromOrdinal: null, manualUnreadGeneration: 0,
      latestMentionAttentionOrdinal: 0,
    });
    this.enqueueProjection(`user:${userId}`, main, now);
  }

  protected override aggregatesChildProjection(substreamId: string): boolean {
    return substreamId === "0";
  }

  protected override childCommonProjections(): DirectoryCommonEffect[] {
    return this.parentSql.exec<{ effect_json: string }>(
      `SELECT effect_json FROM substream_directory WHERE substream_id = '0'`,
    ).toArray().map((row) => WorkstreamDirectoryCommonEffectSchema.parse(JSON.parse(row.effect_json)));
  }

  protected override userProjection(userId: string): z.infer<typeof WorkstreamDirectoryUserEffectSchema> | null {
    const row = first(this.parentSql.exec<{ effect_json: string }>(
      `SELECT effect_json FROM substream_user_directory WHERE substream_id = '0' AND user_id = ?`,
      userId,
    ));
    return row ? WorkstreamDirectoryUserEffectSchema.parse(JSON.parse(row.effect_json)) : null;
  }

  /** Parent/main participation is never inferred from membership in a private child. */
  protected override isParticipant(userId: string): boolean {
    const row = first(this.parentSql.exec<{ effect_json: string }>(
      `SELECT effect_json FROM substream_user_directory WHERE substream_id = '0' AND user_id = ?`,
      userId,
    ));
    if (row) return WorkstreamDirectoryUserEffectSchema.parse(JSON.parse(row.effect_json)).isParticipant;
    const mainReported = first(this.parentSql.exec<{ one: number }>(
      `SELECT 1 AS one FROM substream_directory WHERE substream_id = '0'`,
    ));
    return mainReported === null && this.mainChildCreatedBy() === userId;
  }

  protected override parentLogFields(): Record<string, unknown> {
    const metadata = this.metadataRow();
    return {
      workspace_id: metadata?.workspace_id ?? null,
      workstream_id: metadata?.workstream_id ?? null,
      parent_kind: "workstream",
    };
  }

  protected override onChildCommonAggregate(
    substreamId: string,
    aggregate: DirectoryCommonEffect,
    envelope: ConversationEffectEnvelope,
    now: number,
  ): void {
    if (substreamId !== "0") return;
    this.upsertMetadata(envelope, aggregate, now);
  }

  protected override onChildUserAggregate(substreamId: string): void {
    if (substreamId !== "0") return;
    this.state.storage.sql.exec(
      `UPDATE workstream_metadata SET revision = revision + 1, updated_at = ? WHERE id = 1`,
      Date.now(),
    );
  }

  /**
   * Keep the child registry's title the child's own.
   *
   * The sidebar reads `conversation_children.title`, which creation seeds from
   * the reserved title. A rename lands in the child's object, so without this
   * the registry would need a second write from whatever renamed it — and the
   * naming agent, which nobody routes through that path, would never converge
   * at all. The parent still owns discovery; it just believes the child about
   * what the child is called.
   */
  protected override onChildCommonProjection(
    substreamId: string,
    effect: DirectoryCommonEffect,
    now: number,
  ): void {
    if (substreamId === "0") return;
    if (effect.backgroundAgent) {
      this.parentSql.exec("UPDATE workstream_metadata SET revision = revision + 1, updated_at = ? WHERE id = 1", now);
      return;
    }
    const changed = this.parentSql.exec<{ substream_id: string }>(
      `UPDATE conversation_children SET title = ?, updated_at = ?
        WHERE substream_id = ? AND kind = 'child' AND title IS NOT ?
       RETURNING substream_id`,
      effect.title, now, substreamId, effect.title,
    ).toArray().length === 1;
    if (changed) this.advancePrivateChildrenVersionsFor(substreamId, now);
  }

  protected override async afterChildEffects(): Promise<void> {
    const row = this.metadataRow();
    if (row?.archived_at != null) {
      // The durable archive is the retry authority. Every owned worker uses
      // this same parent, including recursively delegated workers. A shared
      // Sidekick has a different parent and is not part of this traversal.
      for (const child of this.childRegistry()) {
        const stub = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS,
          row.workspace_id, conversationObjectName(this.env.AVALON_REGION, asWorkspaceId(row.workspace_id),
            row.workstream_id, asSubstreamId(child.substreamId)));
        await stub.stopOwnedAgent();
      }
    }
    // Everyone reading this workstream hears through the existing control socket.
    await this.broadcastMetadata();
  }

  override async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await this.initialized;
    const attachment = readSocketAttachment(socket);
    if (!attachment) {
      socket.close(1011, "Missing work-stream connection identity");
      return;
    }
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      socket.close(1008, "Work-stream control events must be JSON");
      return;
    }
    if (isUnknownSocketEvent(decoded, WorkstreamControlSocketClientEventSchema.shape.type)) return;
    const parsed = safeParseSocketEvent(WorkstreamControlSocketClientEventSchema, decoded);
    if (!parsed.success) {
      socket.close(1008, "Invalid work-stream control event");
      return;
    }
    const auth = await this.sessionAuth(attachment);
    if (!auth || !this.canRead(attachment.userId)) {
      socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
      return;
    }
    const metadata = this.metadataForUser(attachment.userId);
    if (!metadata) {
      socket.close(1011, "Work-stream metadata is not initialized");
      return;
    }
    socket.serializeAttachment({ ...attachment, subscribed: true });
    socket.send(workstreamControlPayload({
      type: "workstream_metadata",
      occurredAt: new Date().toISOString(),
      metadata,
    }));
  }

  override webSocketClose(): void {
    // Hibernating sockets carry all durable identity in their attachment.
  }

  override webSocketError(): void {
    // The desktop reconnects with a new one-time ticket.
  }

  /**
   * This object's derived wake reason: outbox rows whose `not_before` has come.
   * The base has already armed the next alarm, so this is free to await the
   * network; a throw costs nothing but the attempt counters the outbox keeps.
   */
  protected override runDueAlarmWork(): Promise<void> {
    return Promise.all([
      this.drainParentOutboxWithCreationFence(),
      this.drainPrivateChildMembershipEffects(),
      this.drainPrivateChildLifecycleEffects(),
    ]).then(() => undefined);
  }

  /**
   * A deferred creation projection still has to reach WorkspaceDO directly if
   * its recovery alarm wins the race with the create coordinator. Version one
   * is uniquely the provisional row; later aggregate projections use the
   * ordinary Queue outbox.
   */
  private async drainParentOutboxWithCreationFence(): Promise<void> {
    const provisional = this.provisionalDirectoryEffects(true);
    if (provisional.length > 0) await this.deliverProvisionalDirectory(provisional);
    await this.drainParentOutbox();
  }

  private async acceptSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426);
    }
    const identity = WorkstreamSocketIdentitySchema.safeParse({
      workspaceId: readRallyHeader(request.headers, RALLY_HEADERS.WORKSPACE_ID) ?? null,
      workstreamId: readRallyHeader(request.headers, RALLY_HEADERS.WORKSTREAM_ID) ?? null,
      userId: readRallyHeader(request.headers, RALLY_HEADERS.USER_ID) ?? null,
      sessionId: readRallyHeader(request.headers, RALLY_HEADERS.SESSION_ID) ?? null,
      ticketId: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_ID) ?? null,
      ticketExpiresAt: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_EXPIRES_AT) ?? null,
    });
    if (!identity.success) return json({ error: "invalid_socket_identity" }, 400);
    const metadata = this.metadataRow();
    if (
      !metadata
      || metadata.workspace_id !== identity.data.workspaceId
      || metadata.workstream_id !== identity.data.workstreamId
    ) return json({ error: "workstream_identity_mismatch" }, 409);
    if (!this.consumeSocketTicket(identity.data)) return json({ error: "socket_ticket_replayed" }, 401);
    const auth = await this.sessionAuth(identity.data);
    if (!auth || !this.canRead(identity.data.userId)) return json({ error: "forbidden" }, 403);

    const [client, server] = Object.values(new WebSocketPair());
    if (!client || !server) return json({ error: "websocket_unavailable" }, 500);
    const attachment: WorkstreamSocketAttachment = {
      ...identity.data,
      connectionId: uuidV7(),
      connectedAt: new Date().toISOString(),
      subscribed: false,
    };
    this.state.acceptWebSocket(server, [
      attachment.workspaceId,
      attachment.workstreamId,
      attachment.userId,
    ]);
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private consumeSocketTicket(identity: WorkstreamSocketIdentity): boolean {
    // Ticket claims carry epoch seconds; object SQL stores unix-ms
    // (data-model invariant 7), so convert once at this boundary.
    const now = Date.now();
    const expiresAtMs = identity.ticketExpiresAt * 1_000;
    if (expiresAtMs <= now) return false;
    return this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `DELETE FROM workstream_socket_ticket_receipts WHERE expires_at < ?`,
        now - 300_000,
      );
      return this.state.storage.sql.exec<{ ticket_id: string }>(
        `INSERT OR IGNORE INTO workstream_socket_ticket_receipts
           (ticket_id, user_id, expires_at, consumed_at)
         VALUES (?, ?, ?, ?) RETURNING ticket_id`,
        identity.ticketId,
        identity.userId,
        expiresAtMs,
        now,
      ).toArray().length === 1;
    });
  }

  private async sessionAuth(
    identity: Pick<WorkstreamSocketIdentity, "sessionId" | "userId" | "workspaceId">,
  ): Promise<AuthContext | null> {
    const role = this.env.APP_ENV === "development"
      && this.env.RALLY_DEV_AUTH === "true"
      && identity.sessionId === "development"
      ? await this.env.DB.prepare(
        `SELECT member.role FROM workspace_members member
          JOIN workspaces workspace ON workspace.id = member.workspace_id
         WHERE member.workspace_id = ? AND member.user_id = ?
           AND member.status = 'active' AND workspace.region = ?
           AND workspace.abandoned_at IS NULL`,
      ).bind(identity.workspaceId, identity.userId, this.env.AVALON_REGION)
        .first<{ role: AuthContext["role"] }>()
      : await this.env.DB.prepare(
        `SELECT member.role FROM sessions session
          JOIN workspace_members member
            ON member.workspace_id = session.workspace_id
           AND member.user_id = session.user_id AND member.incarnation = session.workspace_incarnation AND member.status = 'active'
          JOIN workspaces workspace ON workspace.id = session.workspace_id
         WHERE session.id = ? AND session.user_id = ? AND session.workspace_id = ?
           AND session.region = ? AND session.revoked_at IS NULL
           AND session.expires_at > ? AND workspace.region = ?
           AND workspace.abandoned_at IS NULL`,
      ).bind(
        identity.sessionId,
        identity.userId,
        identity.workspaceId,
        this.env.AVALON_REGION,
        new Date().toISOString(),
        this.env.AVALON_REGION,
      ).first<{ role: AuthContext["role"] }>();
    return role ? {
      sessionId: identity.sessionId,
      userId: identity.userId,
      workspaceId: identity.workspaceId,
      region: this.env.AVALON_REGION,
      role: role.role,
    } : null;
  }

  private ensureMetadata(envelope: ConversationEffectEnvelope, now: number): void {
    const existing = first(this.state.storage.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM workstream_metadata WHERE id = 1`,
    ));
    if (existing) return;
    this.state.storage.sql.exec(
      `INSERT INTO workstream_metadata
         (id, workspace_id, workstream_id, region, authority_generation, title, description,
          preview, scope, exact_state, system_kind, last_activity_at, completed_at,
          archived_at, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, '', '', '', 'workspace', 'idle', NULL, ?, NULL, NULL, ?, ?)`,
      envelope.workspaceId,
      envelope.parentId,
      envelope.region,
      envelope.generation,
      now,
      now,
      now,
    );
  }

  private upsertMetadata(
    envelope: ConversationEffectEnvelope,
    effect: DirectoryCommonEffect,
    now: number,
  ): void {
    this.state.storage.sql.exec(
      `INSERT INTO workstream_metadata
         (id, workspace_id, workstream_id, region, authority_generation, title, description,
          preview, scope, exact_state, system_kind, last_activity_at, completed_at,
          archived_at, created_at, updated_at, revision, email_address,
          created_by_user_id,
          title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
          next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
          source_created_at, source_updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
         preview = excluded.preview, scope = excluded.scope, exact_state = excluded.exact_state,
         system_kind = excluded.system_kind, last_activity_at = excluded.last_activity_at,
         completed_at = excluded.completed_at, archived_at = excluded.archived_at,
         updated_at = excluded.updated_at, revision = workstream_metadata.revision + 1,
         email_address = excluded.email_address,
         created_by_user_id = excluded.created_by_user_id,
         title_status = excluded.title_status,
         latest_attention_ordinal = excluded.latest_attention_ordinal,
         unread_tracking_start_ordinal = excluded.unread_tracking_start_ordinal,
         next_wakeup_due_at = excluded.next_wakeup_due_at,
         next_wakeup_prompt = excluded.next_wakeup_prompt,
         next_terminal_action_at = excluded.next_terminal_action_at,
         source_created_at = excluded.source_created_at,
         source_updated_at = excluded.source_updated_at`,
      envelope.workspaceId,
      envelope.parentId,
      envelope.region,
      envelope.generation,
      effect.title,
      effect.description,
      effect.preview,
      effect.scope,
      effect.state,
      effect.systemKind,
      epoch(effect.lastActivityAt),
      epoch(effect.completedAt),
      epoch(effect.archivedAt),
      now,
      now,
      effect.emailAddress ?? null,
      effect.createdByUserId ?? null,
      effect.titleStatus ?? "settled",
      effect.latestAttentionOrdinal ?? 0,
      effect.unreadTrackingStartOrdinal ?? 0,
      epoch(effect.nextWakeupDueAt),
      effect.nextWakeupPrompt ?? null,
      epoch(effect.nextTerminalActionAt),
      epoch(effect.createdAt ?? effect.lastActivityAt),
      epoch(effect.updatedAt ?? effect.lastActivityAt),
    );
  }

  private metadataRow(): WorkstreamMetadataRow | null {
    return first(this.state.storage.sql.exec<WorkstreamMetadataRow>(
      `SELECT revision, authority_generation, workspace_id, workstream_id, region, title, description, preview,
              scope, exact_state, system_kind, last_activity_at, completed_at,
              archived_at, email_address, created_by_user_id,
              title_status, latest_attention_ordinal, unread_tracking_start_ordinal,
              next_wakeup_due_at, next_wakeup_prompt, next_terminal_action_at,
              source_created_at, source_updated_at
         FROM workstream_metadata WHERE id = 1`,
    ));
  }

  /**
   * Whether one person may currently read this work stream.
   *
   * The public face of the predicate below, for a caller that holds a viewer
   * open against this work stream's content but is not itself this object —
   * today, the artifact supervisor deciding whether a live artifact keeps
   * serving to someone.
   *
   * It exists as an RPC rather than a queue message because **work-stream
   * visibility is not a D1 fact**: it lives in this object's own SQL, and
   * `docs/access-revocation.md` is explicit that routing it through the
   * revocation queue would put a round trip between a scope change and the
   * reader it excludes. So the authority answers directly, exactly as it does
   * for a socket, and the caller caches the answer for a bounded interval
   * rather than asking per request.
   */
  async canReadWorkstream(userId: UserId): Promise<boolean> {
    await this.initialized;
    return this.canRead(userId);
  }

  private canRead(userId: string): boolean {
    const row = this.metadataRow();
    if (!row || row.archived_at !== null) return false;
    if (row.scope === "workspace") return true;
    return this.isParticipant(userId);
  }

  private stateVersionForUser(row: WorkstreamMetadataRow, userId: string) {
    const common = this.latestStateRow("common");
    if (!common) throw new Error("workstream_common_state_missing");
    const viewer = this.latestStateRow(`user:${userId}`);
    return {
      commonEventId: common.event_id,
      viewerEventId: viewer?.event_id ?? null,
      authorityGeneration: row.authority_generation,
      commonWaterline: common.waterline,
      viewerWaterline: viewer?.waterline ?? 0,
    };
  }

  private metadataForUser(userId: string): WorkstreamControlMetadata | null {
    const row = this.metadataRow();
    if (!row) return null;
    const viewer = this.userProjection(userId);
    const readThrough = viewer?.seenAttentionOrdinal ?? row.unread_tracking_start_ordinal;
    const nextPendingWakeup = row.next_wakeup_due_at && row.next_wakeup_prompt
      ? { dueAt: iso(row.next_wakeup_due_at), promptPreview: promptPreview(row.next_wakeup_prompt) }
      : null;
    return WorkstreamControlMetadataSchema.parse({
      stateVersion: this.stateVersionForUser(row, userId),
      privateChildrenWaterline: this.latestStateRow(`children:${userId}`)?.waterline ?? 0,
      revision: row.revision,
      id: row.workstream_id,
      workspaceId: row.workspace_id,
      title: row.title,
      appearance: this.childCommonProjections()[0]?.appearance,
      description: row.description,
      preview: row.preview,
      emailAddress: row.email_address,
      createdByUserId: row.created_by_user_id,
      titleStatus: row.title_status,
      exactState: row.exact_state,
      harnessStatus: harnessStatus(row.exact_state),
      backgroundAgentCount: this.parentSql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM substream_directory
          WHERE substream_id <> '0' AND json_extract(effect_json, '$.backgroundAgent') = 1
            AND json_extract(effect_json, '$.state') = 'running'
            AND json_extract(effect_json, '$.archivedAt') IS NULL`,
      ).one().n,
      latestAttentionSequenceNumber: row.latest_attention_ordinal,
      unreadTrackingStartSequenceNumber: row.unread_tracking_start_ordinal,
      lastActivityAt: iso(row.last_activity_at),
      completedAt: iso(row.completed_at),
      archivedAt: iso(row.archived_at),
      createdAt: iso(row.source_created_at),
      updatedAt: iso(row.source_updated_at),
      scope: row.scope,
      systemKind: row.system_kind,
      nextPendingWakeup,
      nextTerminalActionAt: iso(row.next_terminal_action_at),
      privateChildren: this.visiblePrivateChildrenForUser(userId).map((child) => ({
        substreamId: child.substreamId,
        title: child.title,
        createdByUserId: child.createdByUserId,
        createdAt: iso(child.createdAt),
        updatedAt: iso(child.updatedAt),
      })),
      viewer: {
        isParticipant: viewer?.isParticipant ?? false,
        listable: row.archived_at === null
          && (row.scope === "workspace" || viewer?.isParticipant === true)
          && (viewer?.listable ?? true),
        unreadCount: viewer?.unreadCount ?? 0,
        youAreMentioned: viewer?.youAreMentioned ?? false,
        unseen: viewer?.unseen ?? false,
        readThroughSequenceNumber: readThrough,
        manualUnreadFromSequenceNumber: viewer?.manualUnreadFromOrdinal ?? null,
        manualUnreadGeneration: viewer?.manualUnreadGeneration ?? 0,
        latestMentionSequenceNumber: viewer?.latestMentionAttentionOrdinal ?? 0,
      },
    });
  }

  private visiblePrivateChildrenForUser(userId: string): ListVisiblePrivateChildrenResult["children"] {
    return this.parentSql.exec<{
      substream_id: string; title: string; created_by_user_id: string; created_at: number; updated_at: number;
    }>(
      `SELECT child.substream_id, child.title, child.created_by_user_id, child.created_at, child.updated_at
         FROM conversation_children child
         JOIN private_child_memberships member ON member.substream_id = child.substream_id
        WHERE child.kind = 'child' AND child.status = 'ready' AND child.archived_at IS NULL
          AND member.user_id = ? AND member.active = 1
        ORDER BY child.created_at, child.substream_id`,
      userId,
    ).toArray().map((child) => ({
      substreamId: asSubstreamId(child.substream_id),
      title: child.title,
      createdByUserId: UserIdSchema.parse(child.created_by_user_id),
      createdAt: child.created_at,
      updatedAt: child.updated_at,
    }));
  }

  private advancePrivateChildrenVersion(userId: string, now: number): void {
    this.advanceLocalStateVersion(`children:${userId}`, this.visiblePrivateChildrenForUser(userId), now);
  }

  /** Every active member of one child hears that its row changed. */
  private advancePrivateChildrenVersionsFor(substreamId: string, now: number): void {
    for (const row of this.parentSql.exec<{ user_id: string }>(
      `SELECT user_id FROM private_child_memberships WHERE substream_id = ? AND active = 1`,
      substreamId,
    ).toArray()) {
      this.advancePrivateChildrenVersion(row.user_id, now);
    }
  }

  /**
   * Drop every socket this object holds for a person whose access ended, and
   * carry the same revocation to its substreams.
   *
   * The only way a socket here is closed for lost access; see
   * `docs/access-revocation.md`. Its registries are the only place its
   * substreams are listed, so it answers with them and stops there —
   * what carries the revocation onward is the consumer's business, not this
   * object's.
   */
  async revokeSocketAccess(
    revocation: SocketAccessRevocation,
  ): Promise<{ substreamIds: string[] }> {
    await this.initialized;
    const request = SocketAccessRevocationSchema.parse(revocation);
    const identity = this.metadataRow();
    for (const socket of this.state.getWebSockets()) {
      const attachment = readSocketAttachment(socket);
      if (!attachment || !(await revocationClosesSession(this.env, request, attachment))) continue;
      try {
        socket.serializeAttachment({ ...attachment, subscribed: false });
      } catch {
        // An unreadable attachment already fails the broadcast filter.
      }
      try {
        socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
      } catch {
        // Already closing; the runtime owns the rest of the teardown.
      }
    }
    if (!identity) return { substreamIds: [] };
    // Registered children plus any that spoke before registration existed.
    const substreamIds = [...new Set([
      ...this.childRegistry().map((child) => child.substreamId),
      ...this.state.storage.sql.exec<{ substream_id: string }>(
        `SELECT substream_id FROM substream_directory ORDER BY substream_id`,
      ).toArray().map((row) => row.substream_id),
    ])];
    return { substreamIds };
  }

  private async broadcastMetadata(): Promise<void> {
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0) return;
    const activeUsers = new Set<string>();
    for (const socket of sockets) {
      const attachment = readSocketAttachment(socket);
      if (!attachment?.subscribed) continue;
      activeUsers.add(attachment.userId);
    }
    if (activeUsers.size === 0) return;
    const occurredAt = new Date().toISOString();
    for (const socket of sockets) {
      const attachment = readSocketAttachment(socket);
      if (!attachment?.subscribed) continue;
      // Object-local, and deliberately still here. What was removed from this
      // path is the D1 `workspace_members` read — a question this object cannot
      // answer, which the revocation queue now answers properly. Whether this
      // work stream is still readable by this person is a different question,
      // answered entirely from this object's own SQL, and it is the only place
      // that can answer it. `metadataForUser` does not consult it, so without
      // this a reader excluded by a scope change keeps receiving title,
      // description, preview and state until they close the window.
      if (!this.canRead(attachment.userId)) {
        socket.close(WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer read this work stream");
        continue;
      }
      const metadata = this.metadataForUser(attachment.userId);
      if (!metadata) continue;
      socket.send(workstreamControlPayload({
        type: "workstream_metadata",
        occurredAt,
        metadata,
      }));
    }
  }

  protected override nextDerivedAlarmCandidates(): readonly number[] {
    return [this.nextParentOutboxDueAt(), this.privateChildMembershipEffectsDueAt(), this.privateChildLifecycleDueAt()]
      .filter((due): due is number => due !== null);
  }
}

applyRetirementGate(WorkstreamDO, {
  // The shared classification is inherited from ConversationParentDurableObject;
  // this call is what wraps the doors *this* class overrides for itself.
  drop: {
    // A visibility question answered, not refused. The artifact host asks this
    // on every viewer request and treats a throw as a transport fault — it
    // keeps its cached answer, so a refusal here served a retired work
    // stream's artifacts to every viewer with a session until the session
    // expired. Nobody can read a retired work stream, and saying so is the
    // answer that caller can act on.
    canReadWorkstream: () => false,
    fetch: () => retiredObjectResponse(),
    webSocketMessage: () => Promise.resolve(),
    webSocketClose: () => Promise.resolve(),
    webSocketError: () => Promise.resolve(),
    alarm: () => Promise.resolve(),
  },
});
