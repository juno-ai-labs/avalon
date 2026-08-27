import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import {
  asWorkspaceId,
  IdSchema,
  MESSAGE_MAX_CHARACTERS,
  MESSAGE_TOO_LONG_MESSAGE,
  UserIdSchema,
  WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WORKSPACE_SYNC_TOPICS,
  WORKSTREAM_DESCRIPTION_MAX_CHARACTERS,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkspaceIdSchema,
  WorkspaceSidebarListEventSchema,
  WorkspaceSidebarSchema,
  WorkspaceWorkstreamPageEventSchema,
  WorkspaceWorkstreamStateEventSchema,
  WorkspaceSocketClientEventSchema,
  WorkspaceFeatureFlagsEventSchema,
  WorkspacePresenceEventSchema,
  WorkspaceSocketSyncEventSchema,
  WorkspaceSyncTopicSchema,
  WORKSTREAM_NAMING_GRACE_MS,
  WorkstreamIdSchema,
  WorkstreamSchema,
  WorkstreamSocketCommandResultSchema,
  type AutomationSummary,
  type WorkspaceSidebar,
  type NoteSummary,
  type Workstream,
  type WorkspaceSocketSyncEvent,
  type WorkspaceSyncTopic,
  type WorkstreamBatchFilter,
  ProductFeatureFlagKeySchema,
  type ProductFeatureFlagKey,
} from "@rally/contracts";
import { truncateUtf16Safe } from "@rally/contracts/text";
import { z } from "zod";

import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  assertDurableObjectJurisdiction,
  isWorkspacePlacementAffinityForRegion,
  workspacePlacementAffinity,
  type WorkspacePlacementAffinity,
} from "../lib/durable-object-namespace";
import { withDurableObjectSelf } from "../lib/durable-object-self";
import { uuidV7 } from "../lib/uuid-v7";
import { logInfo, logWarn } from "../observability/logger";
import { identityAttributes, inFlowSpan } from "../observability/tracing";
import {
  acceptsNewWorkstreamWork,
  readWorkstreamAuthorityControl,
} from "../services/workstream-authority";
import { WorkstreamObjectClient } from "../services/workstream-object-client";
import { resolveClientFeatureFlagsForSubject } from "../services/client-feature-flags";
import {
  revocationClosesSocket,
  SocketAccessRevocationSchema,
  type SocketAccessRevocation,
} from "../services/access-revocation";
import {
  AUTOMATION_SIDEBAR_SQL,
  AutomationSidebarRowSchema,
  NOTE_SIDEBAR_SQL,
  NoteSidebarRowSchema,
  SIDEBAR_LIST_LIMIT,
  toAutomationSummary,
  toNoteSummary,
} from "../services/sidebar-reads";
import {
  applyDurableObjectSqliteMigrations,
  type DurableObjectSqliteMigration,
} from "./sqlite-migrations";
import {
  SCHEDULED_ALARM_SCHEMA_STATEMENTS,
  ScheduledDurableObject,
  type ScheduledAlarm,
  type ScheduledAlarmOutcome,
} from "./scheduled-alarms";
import {
  observableWorkspaceScheduledAlarmKind,
  WorkspaceAlarmInstrumentation,
  type ObservableWorkspaceScheduledAlarmKind,
  type WorkspaceScheduledAlarmPhase,
} from "./workspace-alarm-instrumentation";
import type { DurableObjectMigrationPlan } from "./migratable-durable-object";
import {
  recordWorkspaceScheduleFailure,
  runWorkspaceScheduleTarget,
  workspaceScheduleTargets,
  type WorkspaceScheduleContext,
  type WorkspaceScheduleTargetKind,
} from "../services/workspace-schedule-execution";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import { workspaceDOName } from "./names";
import { reportScheduledAlarmAttempt } from "./scheduled-alarm-report";
import {
  WorkspaceDirectoryApplyRequestSchema,
  WorkspaceDirectoryBatchTargetsRequestSchema,
  WorkspaceDirectoryBatchTargetsResultSchema,
  WorkspaceBatchDispatchAdvanceRequestSchema,
  WorkspaceBatchDispatchAdvanceResultSchema,
  WorkspaceBatchDispatchBeginRequestSchema,
  WorkspaceBatchDispatchBeginResultSchema,
  WorkspaceDirectoryExistsRequestSchema,
  WorkspaceDirectoryApplyResultSchema,
  WorkspaceDirectoryDueRequestSchema,
  WorkspaceDirectoryFeedbackRequestSchema,
  WorkspaceDirectoryFeedbackResultSchema,
  WorkspaceDirectoryListRequestSchema,
  WorkspaceDirectoryLookupRequestSchema,
  WorkspaceDirectoryLookupResultSchema,
  WorkspaceDirectoryRecentRequestSchema,
  WorkspaceDirectoryReadableIdsRequestSchema,
  WorkspaceDirectoryReadableIdsResultSchema,
  WorkspaceDirectoryNotificationRequestSchema,
  WorkspaceDirectoryNotificationStateSchema,
  WorkspaceDirectoryPageSchema,
  WorkspaceDirectoryPinRequestSchema,
  WorkspaceDirectoryPlannedAutomationRequestSchema,
  WorkspaceDirectoryPlannedRequestSchema,
  WorkspaceDirectoryReorderPinsRequestSchema,
  WorkspaceDirectoryResourceAccessRequestSchema,
  WorkspaceDirectoryResourceAccessResultSchema,
  WorkspaceDirectoryResourceRequestSchema,
  WorkspaceDirectoryResourceResultSchema,
  WorkspaceDirectoryRoutingCandidatesRequestSchema,
  WorkspaceDirectoryScheduleTargetsRequestSchema,
  WorkspaceDirectoryScheduleTargetsResultSchema,
  WorkspaceDirectoryVisibilityRequestSchema,
  WorkspaceDirectoryVisibleIdsRequestSchema,
  WorkspaceDirectoryVisibleIdsPageSchema,
  WorkspaceRegionalEffectApplyRequestSchema,
  WorkspaceRegionalEffectApplyResultSchema,
  type WorkspaceDirectoryApplyRequest,
  type WorkspaceDirectoryBatchTargetsRequest,
  type WorkspaceBatchDispatchAdvanceRequest,
  type WorkspaceBatchDispatchBeginRequest,
  type WorkspaceDirectoryApplyResult,
  type WorkspaceDirectoryDueRequest,
  type WorkspaceDirectoryExistsRequest,
  type WorkspaceDirectoryFeedbackRequest,
  type WorkspaceDirectoryFeedbackResult,
  type WorkspaceDirectoryListRequest,
  type WorkspaceDirectoryLookupRequest,
  type WorkspaceDirectoryLookupResult,
  type WorkspaceDirectoryRecentRequest,
  type WorkspaceDirectoryReadableIdsRequest,
  type WorkspaceDirectoryReadableIdsResult,
  type WorkspaceDirectoryPage,
  type WorkspaceDirectoryPinRequest,
  type WorkspaceDirectoryPlannedAutomationRequest,
  type WorkspaceDirectoryPlannedRequest,
  type WorkspaceDirectoryReorderPinsRequest,
  type WorkspaceDirectoryResourceAccessRequest,
  type WorkspaceDirectoryResourceAccessResult,
  type WorkspaceDirectoryNotificationRequest,
  type WorkspaceDirectoryNotificationState,
  type WorkspaceDirectoryResourceRequest,
  type WorkspaceDirectoryResourceResult,
  type WorkspaceDirectoryRoutingCandidatesRequest,
  type WorkspaceDirectoryScheduleTargetsRequest,
  type WorkspaceDirectoryScheduleTargetsResult,
  type WorkspaceDirectoryVisibilityRequest,
  type WorkspaceDirectoryVisibleIdsRequest,
  type WorkspaceDirectoryVisibleIdsPage,
  type WorkspaceRegionalEffectApplyRequest,
  type WorkspaceRegionalEffectApplyResult,
} from "./workspace-directory-protocol";
import type { WorkstreamRegionalEffectEnvelope } from "./workstream-regional-effect";
import {
  LegacyWorkspaceConnectorEventClaimResultSchema,
  WorkspaceConnectorEventClaimRpcRequestSchema,
  WorkspaceConnectorEventClaimRequestSchema,
  WorkspaceConnectorEventClaimResultSchema,
  WorkspaceConnectorEventIngestRequestSchema,
  WorkspaceConnectorEventIngestResultSchema,
  WorkspaceConnectorEventRequestSchema,
  WorkspaceConnectorEventSchema,
  WorkspaceConnectorEventSettleRpcRequestSchema,
  type WorkspaceConnectorEvent,
  type WorkspaceConnectorEventClaimRequest,
  type WorkspaceConnectorEventClaimRpcRequest,
  type WorkspaceConnectorEventClaimRpcResult,
  type WorkspaceConnectorEventIngestRequest,
  type WorkspaceConnectorEventIngestResult,
  type WorkspaceConnectorEventRequest,
  type WorkspaceConnectorEventSettleRequest,
  type WorkspaceConnectorEventSettleRpcRequest,
} from "./workspace-connector-event-protocol";
import { WORKSPACE_PRODUCT_SCHEMA_STATEMENTS } from "./workspace-product-schema";
import {
  SLACK_REACTION_COLUMN_STATEMENTS,
  WORKSPACE_DOMAIN_SCHEMA_STATEMENTS,
} from "./workspace-domain-schema";
import {
  WorkspaceActivityEventCursorRequestSchema,
  WorkspaceActivityEventInputSchema,
  WorkspaceActivityEventListRequestSchema,
  WorkspaceActivityEventListResultSchema,
  WorkspaceActivityEventSourceRequestSchema,
  WorkspaceActivityEventSourceSchema,
  type WorkspaceActivityEventCursorRequest,
  type WorkspaceActivityEventInput,
  type WorkspaceActivityEventListRequest,
  type WorkspaceActivityEventListResult,
  type WorkspaceActivityEventSourceRequest,
} from "./workspace-activity-event-protocol";
import {
  WorkspaceOpportunityBatchEventsRequestSchema,
  WorkspaceOpportunityClaimStartRequestSchema,
  WorkspaceOpportunityCompleteStartRequestSchema,
  WorkspaceOpportunityDismissResultSchema,
  WorkspaceOpportunityDismissRequestSchema,
  WorkspaceOpportunityEnqueueRequestSchema,
  WorkspaceOpportunityEnqueueResultSchema,
  WorkspaceOpportunityExistingRequestSchema,
  WorkspaceOpportunityGetRequestSchema,
  WorkspaceOpportunityImpressionsRequestSchema,
  WorkspaceOpportunityListRequestSchema,
  WorkspaceOpportunityListResultSchema,
  WorkspaceOpportunityOriginEventsRequestSchema,
  WorkspaceOpportunityOriginEventsResultSchema,
  WorkspaceOpportunityPersistRequestSchema,
  WorkspaceOpportunityPersistResultSchema,
  WorkspaceOpportunityRankingCandidatesRequestSchema,
  WorkspaceOpportunityRankingRoundRequestSchema,
  WorkspaceOpportunityRankingSettleRequestSchema,
  WorkspaceOpportunityRankingStateSchema,
  WorkspaceOpportunityReleaseStartRequestSchema,
  WorkspaceOpportunityStoreRankingRequestSchema,
  WorkspaceOpportunityTelemetryContextSchema,
  WorkspaceOpportunityTelemetryContextsSchema,
  WorkspaceOpportunityWindowRequestSchema,
  WorkspaceOpportunityWindowSchema,
  WorkspaceOpportunityWindowSettleRequestSchema,
  WorkspaceOpportunityWorkflowInputSchema,
  type WorkspaceOpportunityBatchEventsRequest,
  type WorkspaceOpportunityClaimStartRequest,
  type WorkspaceOpportunityCompleteStartRequest,
  type WorkspaceOpportunityDismissRequest,
  type WorkspaceOpportunityEnqueueRequest,
  type WorkspaceOpportunityExistingRequest,
  type WorkspaceOpportunityGetRequest,
  type WorkspaceOpportunityImpressionsRequest,
  type WorkspaceOpportunityListRequest,
  type WorkspaceOpportunityOriginEventsRequest,
  type WorkspaceOpportunityPersistRequest,
  type WorkspaceOpportunityRankingCandidatesRequest,
  type WorkspaceOpportunityRankingRoundRequest,
  type WorkspaceOpportunityRankingSettleRequest,
  type WorkspaceOpportunityStoreRankingRequest,
  type WorkspaceOpportunityWindowRequest,
  type WorkspaceOpportunityWindowSettleRequest,
} from "./workspace-opportunity-protocol";
import { WorkspaceProductStorage } from "./workspace-product-storage";
import {
  applyWorkstreamRegionalEnvelope,
  insertWorkstreamEffectReceipt,
} from "./workspace-regional-effect-storage";
import {
  WorkspaceNotificationIntentClaimResultSchema,
  WorkspaceNotificationIntentMaintenanceRequestSchema,
  WorkspaceNotificationIntentMaintenanceTargetSchema,
  WorkspaceNotificationIntentReapRequestSchema,
  WorkspaceNotificationIntentReapResultSchema,
  WorkspaceNotificationIntentRequestSchema,
  WorkspaceNotificationIntentTransitionRequestSchema,
  WorkspaceNotificationIntentTransitionResultSchema,
  type WorkspaceNotificationIntentClaimResult,
  type WorkspaceNotificationIntentMaintenanceRequest,
  type WorkspaceNotificationIntentMaintenanceTarget,
  type WorkspaceNotificationIntentReapRequest,
  type WorkspaceNotificationIntentReapResult,
  type WorkspaceNotificationIntentRequest,
  type WorkspaceNotificationIntentTransitionRequest,
  type WorkspaceNotificationIntentTransitionResult,
} from "./workspace-notification-intent-protocol";
import {
  claimWorkspaceNotificationIntent as claimStoredWorkspaceNotificationIntent,
  reapSettledWorkspaceNotificationIntents as reapStoredWorkspaceNotificationIntents,
  transitionWorkspaceNotificationIntent as transitionStoredWorkspaceNotificationIntent,
  workspaceNotificationIntentMaintenanceTarget as storedWorkspaceNotificationIntentMaintenanceTarget,
} from "./workspace-notification-intent-storage";
import {
  responseToRpcResult,
  type DurableObjectRpcResult,
} from "./rpc-result";
import {
  executeWorkspaceRuntimeSql,
  WorkspaceRuntimeSqlRequestSchema,
  type WorkspaceRuntimeSqlRequest,
  type WorkspaceRuntimeSqlResult,
} from "./workspace-runtime-sql";

const WORKSPACE_ALARM_SOURCE_TABLES = new Set([
  "schedules",
  "resource_watches",
  "resource_object_deletion_outbox",
  "note_resource_deletion_outbox",
  "note_privacy_change_outbox",
  "memory_index_outbox",
  "slack_ingress_jobs",
  "slack_agent_thread_claims",
  "slack_agent_pending_prompts",
  "slack_link_challenges",
  "slack_unfurled_links",
]);

const WORKSPACE_TYPED_RPC_ONLY_TABLES = ["workstream_notification_intents"] as const;

function typedRpcOnlyWorkspaceTable(sql: string): string | null {
  return WORKSPACE_TYPED_RPC_ONLY_TABLES.find((table) => (
    new RegExp(`\\b${table}\\b`, "iu").test(sql)
  )) ?? null;
}

/**
 * Which sidebar list a write invalidates, by the table it writes.
 *
 * Every mutation of these tables — a desktop REST write, a Workflow, and the
 * scheduler advancing `next_run_at` after a run — reaches this object through
 * `executeRuntimeSql`, so one check here covers writers that have no request
 * to hang an invalidation off. The template tables are in the list because the
 * sidebar row's name, description and update badge are read from them.
 */
const SIDEBAR_LIST_SOURCE_TABLES = new Map<string, SidebarList>([
  ["automation_subscriptions", "automations"],
  ["automation_templates", "automations"],
  ["automation_template_versions", "automations"],
  ["notes", "notes"],
]);

type SidebarList = "automations" | "notes";

function workspaceMutationTarget(sql: string): string | null {
  return /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM)\s+["`[]?([\w]+)["`\]]?/iu
    .exec(sql)?.[1]?.toLowerCase() ?? null;
}

const SocketIdentitySchema = z.object({
  workspaceId: WorkspaceIdSchema,
  userId: UserIdSchema,
  sessionId: z.string().min(1).max(200),
  ticketId: z.string().uuid(),
  ticketExpiresAt: z.coerce.number().int().positive(),
});

type SocketIdentity = z.infer<typeof SocketIdentitySchema>;
type CreateMessageCommand = Extract<
  z.infer<typeof WorkspaceSocketClientEventSchema>,
  { type: "create_message" }
>;

/**
 * The `clientMessageId` of a `create_message` frame whose text is over the
 * ceiling, or null when the frame is anything else.
 *
 * Reads the decoded JSON rather than a parsed command because the parse is what
 * this runs ahead of. Deliberately narrow: it answers only for a frame that is
 * recognisably a create_message carrying a correlatable id, so anything it is
 * unsure about falls through to the schema and is refused there. The reply is
 * correlated by `clientMessageId`, so a frame without a usable one has nothing
 * to answer to and is left to the parse as well.
 */
function overLongCreateMessageCommand(decoded: unknown): { clientMessageId: string } | null {
  if (decoded === null || typeof decoded !== "object") return null;
  const frame = decoded as { type?: unknown; payload?: unknown };
  if (frame.type !== "create_message") return null;
  if (frame.payload === null || typeof frame.payload !== "object") return null;
  const payload = frame.payload as { text?: unknown; clientMessageId?: unknown };
  if (typeof payload.text !== "string" || payload.text.length <= MESSAGE_MAX_CHARACTERS) return null;
  if (typeof payload.clientMessageId !== "string") return null;
  if (payload.clientMessageId.length < 1 || payload.clientMessageId.length > 120) return null;
  return { clientMessageId: payload.clientMessageId };
}

interface WorkspaceSocketAttachment extends SocketIdentity {
  connectionId: string;
  connectedAt: string;
  subscribed: boolean;
  lastWaterline: number;
  presenceRevision: number;
  applicationState: "foreground" | "background";
  foregroundWorkstreamId: string | null;
}

interface WorkspaceDirectoryRow extends Record<string, SqlStorageValue> {
  workstream_id: string;
  authority_generation: number;
  common_waterline: number;
  common_event_id: string;
  title: string;
  description: string;
  scope: "personal" | "workspace";
  exact_state: string;
  system_kind: "digest" | null;
  last_activity_at: number;
  completed_at: number | null;
  archived_at: number | null;
  email_address: string | null;
  origin_type: "ad_hoc" | "automation";
  origin_label: string | null;
  created_by_user_id: string | null;
  automation_subscription_id: string | null;
  automation_run_id: string | null;
  planned_for: number | null;
  title_status: "naming" | "automatic" | "settled";
  latest_attention_ordinal: number;
  unread_tracking_start_ordinal: number;
  next_wakeup_due_at: number | null;
  next_wakeup_prompt: string | null;
  source_created_at: number;
  source_updated_at: number;
  seen_attention_ordinal: number | null;
  manual_unread_from_ordinal: number | null;
  manual_unread_generation: number | null;
  latest_mention_attention_ordinal: number | null;
  is_participant: number | null;
  unseen: number | null;
  viewer_waterline: number | null;
  viewer_event_id: string | null;
  pin_position: number | null;
}

interface WorkspaceConnectorEventRow extends Record<string, SqlStorageValue> {
  event_id: string;
  payload_hash: string;
  connection_id: string;
  connection_scope: "personal" | "workspace";
  connection_owner_user_id: string | null;
  connector_type: string;
  provider: string;
  provider_event_id: string;
  event_type: string;
  resource_type: string | null;
  provider_resource_id: string | null;
  actor_json: string;
  subject_json: string;
  occurred_at: number;
  received_at: number;
  title: string;
  summary: string;
  text_snippet: string;
  payload_ref: string | null;
  visibility_json: string;
  target_user_ids_json: string;
  entity_keys_json: string;
  dedupe_key: string;
  raw_content_hash: string | null;
  metadata_json: string;
  external_people_json: string;
  processing_status: "pending" | "processing" | "processed" | "failed";
  processing_attempt: number;
  workflow_instance_id: string | null;
  processing_orchestrator: "queue" | "workflow" | null;
  claimed_at: number | null;
}

const MAX_WORKSPACE_PINS_PER_USER = 1_000;
const CONNECTOR_EVENT_INGRESS_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60_000;
// Queue consumers have a 15-minute platform wall-time limit. This expiry is
// only for Queue claims. A retiring Workflow can retry multiple 15-minute
// processing attempts, so its claim remains exclusive until it settles.
const CONNECTOR_EVENT_PROCESSING_LEASE_MS = 15 * 60_000;
// Thirteen months, deliberately the most generous window in the fleet: event
// bodies are provenance input, and the 10 GB object ceiling is the only hard
// bound this fence exists to protect.
const CONNECTOR_EVENT_BODY_RETENTION_MS = 396 * 24 * 60 * 60_000;
const ACTIVITY_EVENT_RETENTION_MS = 90 * 24 * 60 * 60_000;
const PRODUCT_ALARM_BATCH = 6;
/** How often a workspace rechecks a region that is closed for maintenance. */
const MAINTENANCE_RECHECK_MS = 5 * 60_000;
/** `_internal_durable_alarms` identity for this workspace's opportunity and ranking work. */
const PRODUCT_ALARM_KIND = "product";
const PRODUCT_ALARM_KEY = "workspace";
/** The one-shot entry a migrating object uses to reconcile itself once. */
const SCHEDULE_BOOTSTRAP_ALARM_KIND = "schedule_bootstrap";
/** The kinds `refreshSchedule` reconciles, each dispatched to the schedule runner. */
const WORKSPACE_SCHEDULE_ALARM_KINDS: readonly WorkspaceScheduleTargetKind[] = [
  "schedule",
  "watch",
  "maintenance",
  "terminal",
];

function isWorkspaceScheduleAlarmKind(kind: string): kind is WorkspaceScheduleTargetKind {
  return (WORKSPACE_SCHEDULE_ALARM_KINDS as readonly string[]).includes(kind);
}

export const WORKSPACE_DO_SCHEMA_MIGRATIONS: readonly DurableObjectSqliteMigration[] = [{
  version: 1,
  description: "workspace control-plane authority and realtime synchronization",
  statements: [
    `CREATE TABLE workspace_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL UNIQUE,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      placement_affinity TEXT NOT NULL CHECK (placement_affinity IN ('wnam', 'enam', 'weur', 'eeur')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TABLE workspace_sync_events (
      waterline INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      topics_json TEXT NOT NULL CHECK (json_valid(topics_json) AND length(topics_json) <= 4096),
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0)
    ) STRICT`,
    `CREATE TABLE workspace_connector_events (
      event_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      payload_hash TEXT NOT NULL CHECK (
        substr(payload_hash, 1, 7) = 'sha256:' AND length(payload_hash) = 71
        AND substr(payload_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      connection_id TEXT NOT NULL,
      connection_scope TEXT NOT NULL CHECK (connection_scope IN ('personal', 'workspace')),
      connection_owner_user_id TEXT,
      connector_type TEXT NOT NULL CHECK (length(connector_type) BETWEEN 1 AND 120),
      provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 120),
      provider_event_id TEXT NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 1000),
      event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 200),
      resource_type TEXT CHECK (resource_type IS NULL OR length(resource_type) <= 200),
      provider_resource_id TEXT CHECK (provider_resource_id IS NULL OR length(provider_resource_id) <= 2000),
      actor_json TEXT NOT NULL CHECK (json_valid(actor_json) AND length(actor_json) <= 262144),
      subject_json TEXT NOT NULL CHECK (json_valid(subject_json) AND length(subject_json) <= 262144),
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
      received_at INTEGER NOT NULL CHECK (received_at >= 0),
      title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 1000),
      summary TEXT NOT NULL CHECK (length(summary) <= 65536),
      text_snippet TEXT NOT NULL CHECK (length(text_snippet) <= 4000),
      payload_ref TEXT CHECK (payload_ref IS NULL OR length(payload_ref) <= 2000),
      visibility_json TEXT NOT NULL CHECK (json_valid(visibility_json) AND length(visibility_json) <= 262144),
      target_user_ids_json TEXT NOT NULL CHECK (json_valid(target_user_ids_json) AND length(target_user_ids_json) <= 262144),
      entity_keys_json TEXT NOT NULL CHECK (json_valid(entity_keys_json) AND length(entity_keys_json) <= 262144),
      dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 1000),
      raw_content_hash TEXT CHECK (raw_content_hash IS NULL OR length(raw_content_hash) <= 256),
      metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json) AND length(metadata_json) <= 524288),
      external_people_json TEXT NOT NULL CHECK (json_valid(external_people_json) AND length(external_people_json) <= 262144),
      processing_status TEXT NOT NULL CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed')),
      processing_attempt INTEGER NOT NULL DEFAULT -1 CHECK (processing_attempt BETWEEN -1 AND 5),
      workflow_instance_id TEXT CHECK (workflow_instance_id IS NULL OR length(workflow_instance_id) BETWEEN 1 AND 100),
      claimed_at INTEGER CHECK (claimed_at IS NULL OR claimed_at >= 0),
      processed_at INTEGER CHECK (processed_at IS NULL OR processed_at >= 0),
      processing_error TEXT CHECK (processing_error IS NULL OR length(processing_error) <= 1000),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      CHECK (
        (connection_scope = 'personal' AND connection_owner_user_id IS NOT NULL)
        OR (connection_scope = 'workspace' AND connection_owner_user_id IS NULL)
      ),
      UNIQUE(connection_id, provider_event_id, event_type),
      UNIQUE(connection_id, dedupe_key)
    ) STRICT`,
    `CREATE INDEX workspace_connector_events_processing_idx
      ON workspace_connector_events(processing_status, received_at, event_sequence)`,
    `CREATE TABLE workspace_connector_event_ingress_receipts (
      ingress_event_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL CHECK (
        substr(payload_hash, 1, 7) = 'sha256:' AND length(payload_hash) = 71
        AND substr(payload_hash, 8) NOT GLOB '*[^0-9a-f]*'
      ),
      connector_event_id TEXT NOT NULL REFERENCES workspace_connector_events(event_id) ON DELETE CASCADE,
      received_at INTEGER NOT NULL CHECK (received_at >= 0)
    ) STRICT`,
    `CREATE INDEX workspace_connector_event_ingress_receipts_retention_idx
      ON workspace_connector_event_ingress_receipts(received_at, ingress_event_id)`,
    `CREATE TABLE workspace_socket_ticket_receipts (
      ticket_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      consumed_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE INDEX workspace_socket_ticket_receipts_expiry_idx
      ON workspace_socket_ticket_receipts(expires_at, ticket_id)`,
    `CREATE TABLE workspace_directory_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      waterline INTEGER NOT NULL CHECK (waterline >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT`,
    `INSERT INTO workspace_directory_state(id, waterline, updated_at) VALUES (1, 0, 0)`,
    `CREATE TABLE workspace_workstream_directory (
      workstream_id TEXT PRIMARY KEY,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      waterline INTEGER NOT NULL CHECK (waterline > 0),
      source_event_id TEXT NOT NULL UNIQUE,
      payload_hash TEXT NOT NULL,
      title TEXT NOT NULL CHECK (length(title) <= 500),
      description TEXT NOT NULL CHECK (length(description) <= 4000),
      preview TEXT NOT NULL CHECK (length(preview) <= 1000),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      exact_state TEXT NOT NULL CHECK (length(exact_state) BETWEEN 1 AND 80),
      system_kind TEXT CHECK (system_kind IS NULL OR length(system_kind) <= 80),
      last_activity_at INTEGER NOT NULL CHECK (last_activity_at >= 0),
      completed_at INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
      archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
      email_address TEXT,
      origin_type TEXT NOT NULL CHECK (origin_type IN ('ad_hoc', 'automation')),
      origin_label TEXT CHECK (origin_label IS NULL OR length(origin_label) <= 120),
      created_by_user_id TEXT,
      automation_subscription_id TEXT,
      automation_run_id TEXT,
      planned_for INTEGER CHECK (planned_for IS NULL OR planned_for >= 0),
      title_status TEXT NOT NULL CHECK (title_status IN ('naming', 'automatic', 'settled')),
      latest_attention_ordinal INTEGER NOT NULL CHECK (latest_attention_ordinal >= 0),
      unread_tracking_start_ordinal INTEGER NOT NULL CHECK (unread_tracking_start_ordinal >= 0),
      next_wakeup_due_at INTEGER CHECK (next_wakeup_due_at IS NULL OR next_wakeup_due_at >= 0),
      next_wakeup_prompt TEXT CHECK (next_wakeup_prompt IS NULL OR length(next_wakeup_prompt) <= 500),
      next_terminal_action_at INTEGER CHECK (next_terminal_action_at IS NULL OR next_terminal_action_at >= 0),
      source_created_at INTEGER NOT NULL CHECK (source_created_at >= 0),
      source_updated_at INTEGER NOT NULL CHECK (source_updated_at >= 0),
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_directory_list_idx
      ON workspace_workstream_directory(archived_at, system_kind, last_activity_at DESC, workstream_id)`,
    `CREATE INDEX workspace_workstream_directory_automation_idx
      ON workspace_workstream_directory(automation_subscription_id, planned_for, archived_at)`,
    `CREATE INDEX workspace_workstream_directory_due_idx
      ON workspace_workstream_directory(next_wakeup_due_at, next_terminal_action_at, workstream_id)`,
    `CREATE INDEX workspace_workstream_directory_terminal_idx
      ON workspace_workstream_directory(next_terminal_action_at, workstream_id)
      WHERE next_terminal_action_at IS NOT NULL`,
    `CREATE TABLE workspace_workstream_viewers (
      workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      waterline INTEGER NOT NULL CHECK (waterline > 0),
      source_event_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      is_participant INTEGER NOT NULL CHECK (is_participant IN (0, 1)),
      unread_count INTEGER NOT NULL CHECK (unread_count >= 0),
      you_are_mentioned INTEGER NOT NULL CHECK (you_are_mentioned IN (0, 1)),
      listable INTEGER NOT NULL CHECK (listable IN (0, 1)),
      seen_attention_ordinal INTEGER NOT NULL CHECK (seen_attention_ordinal >= 0),
      manual_unread_from_ordinal INTEGER CHECK (manual_unread_from_ordinal IS NULL OR manual_unread_from_ordinal >= 0),
      manual_unread_generation INTEGER NOT NULL CHECK (manual_unread_generation >= 0),
      latest_mention_attention_ordinal INTEGER NOT NULL CHECK (latest_mention_attention_ordinal >= 0),
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0),
      PRIMARY KEY (workstream_id, user_id)
    ) STRICT`,
    `CREATE TABLE workspace_workstream_pins (
      user_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY (user_id, workstream_id)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_pins_order_idx
      ON workspace_workstream_pins(user_id, position, workstream_id)`,
    `CREATE TABLE workspace_workstream_resource_links (
      workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL,
      watch_enabled INTEGER NOT NULL CHECK (watch_enabled IN (0, 1)),
      relationship_type TEXT NOT NULL CHECK (length(relationship_type) BETWEEN 1 AND 80),
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      waterline INTEGER NOT NULL CHECK (waterline > 0),
      source_event_id TEXT NOT NULL,
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0),
      PRIMARY KEY (workstream_id, resource_id)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_resource_links_lookup_idx
      ON workspace_workstream_resource_links(resource_id, watch_enabled, workstream_id)`,
    `CREATE TABLE workspace_workstream_suggestion_feedback (
      workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
      action_id TEXT NOT NULL,
      activity_id TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('contextual_routing', 'suggested_work')),
      status TEXT NOT NULL CHECK (status IN ('accepted', 'dismissed')),
      resolved_at INTEGER NOT NULL CHECK (resolved_at >= 0),
      resolved_by_user_id TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      waterline INTEGER NOT NULL CHECK (waterline > 0),
      source_event_id TEXT NOT NULL,
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0),
      PRIMARY KEY (workstream_id, action_id)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_suggestion_feedback_activity_idx
      ON workspace_workstream_suggestion_feedback(source, resolved_at, status, activity_id)`,
    `CREATE TABLE workspace_workstream_effect_receipts (
      message_id TEXT PRIMARY KEY,
      workstream_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      received_at INTEGER NOT NULL CHECK (received_at >= 0)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_effect_receipts_received_idx
      ON workspace_workstream_effect_receipts(received_at, message_id)`,
    ...WORKSPACE_PRODUCT_SCHEMA_STATEMENTS,
    ...WORKSPACE_DOMAIN_SCHEMA_STATEMENTS,
    `CREATE TRIGGER workspace_identity_placement_valid_insert
      BEFORE INSERT ON workspace_identity
      WHEN NEW.placement_affinity IS NULL
        OR (NEW.region = 'global' AND NEW.placement_affinity NOT IN ('wnam', 'enam'))
        OR (NEW.region = 'eu' AND NEW.placement_affinity NOT IN ('weur', 'eeur'))
      BEGIN
        SELECT RAISE(ABORT, 'workspace_placement_affinity_invalid');
      END`,
    `CREATE TRIGGER workspace_identity_placement_valid_update
      BEFORE UPDATE OF placement_affinity ON workspace_identity
      WHEN NEW.placement_affinity IS NULL
        OR (NEW.region = 'global' AND NEW.placement_affinity NOT IN ('wnam', 'enam'))
        OR (NEW.region = 'eu' AND NEW.placement_affinity NOT IN ('weur', 'eeur'))
      BEGIN
        SELECT RAISE(ABORT, 'workspace_placement_affinity_invalid');
      END`,
    `CREATE TRIGGER workspace_identity_placement_immutable
      BEFORE UPDATE OF placement_affinity ON workspace_identity
      WHEN OLD.placement_affinity IS NOT NULL
        AND NEW.placement_affinity <> OLD.placement_affinity
      BEGIN
        SELECT RAISE(ABORT, 'workspace_placement_affinity_immutable');
      END`,
  ],
}, {
  version: 2,
  description: "connector OAuth attempt telemetry columns the connection service reads",
  statements: [
    // `connection-service.ts` writes and reads these four alongside
    // `telemetry_operation_id`, which version 1 carried alone. The object
    // table was therefore narrower than the queries routed to it: every
    // connector OAuth attempt statement naming them fails once a region serves
    // this table from the object, and the maintenance import — which passes
    // each D1 column through by name — cannot land the rows at all. Added
    // rather than dropped at import because the columns are live product
    // telemetry, not migration residue.
    `ALTER TABLE connector_oauth_attempts ADD COLUMN telemetry_event_version INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE connector_oauth_attempts ADD COLUMN telemetry_scope TEXT`,
    `ALTER TABLE connector_oauth_attempts ADD COLUMN telemetry_capability_count INTEGER`,
    `ALTER TABLE connector_oauth_attempts ADD COLUMN telemetry_reconnect INTEGER NOT NULL DEFAULT 0`,
  ],
}, {
  version: 3,
  description: "drop the two workspace tables no code reads or writes",
  statements: [
    // As in the SubstreamAgent's migration 11, version 1 still creates these
    // and must: its statements are hashed into every deployed object's
    // `_sql_schema_migrations` receipt. `WORKSPACE_FENCED_TABLES` still names
    // `external_delivery_attempts` for the same reason — it feeds v1's
    // identity-fence triggers, so pruning the list would edit v1 in place.
    // Dropping the table takes those triggers and its index with it.
    //
    // `external_delivery_attempts` declared a unified outbound pipeline —
    // idempotency key, lease, attempt count, five states — for automation,
    // digest, mention, and note-privacy sends. Nothing ever wrote it, and the
    // delivery that does happen runs through `workstream_notification_intents`
    // and the per-channel services. Two pipelines in the schema, one of them
    // empty, is a standing invitation to extend the wrong one.
    `DROP TABLE IF EXISTS external_delivery_attempts`,
    // `slack_agent_channel_allowlist` was superseded before it was used:
    // `slack_agent_policies.public_channel_mode` and `private_channel_mode`
    // decide channel admission, and no query ever consulted the allowlist.
    `DROP TABLE IF EXISTS slack_agent_channel_allowlist`,
  ],
}, {
  version: 4,
  description: "hold this workspace's whole schedule behind its single alarm",
  statements: [
    ...SCHEDULED_ALARM_SCHEMA_STATEMENTS,
    // Product work already queued keeps its wake-up across the cutover. Every
    // other target — schedules, watches, maintenance, Terminal deadlines — is
    // reconciled from its own table by `refreshSchedule`, which the retiring
    // scheduler object calls on its next alarm; product work has no such
    // second writer, so a window queued before this deploy would otherwise
    // wait for an unrelated enqueue to rediscover it.
    `INSERT INTO _internal_durable_alarms
       (kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json,
        created_at, updated_at)
     SELECT 'product', 'workspace', MIN(due_at), NULL, 0, 0, NULL,
            unixepoch() * 1000, unixepoch() * 1000
       FROM (
         SELECT process_after AS due_at FROM opportunity_batch_windows WHERE status = 'pending'
         UNION ALL
         SELECT lease_expires_at AS due_at FROM opportunity_batch_windows WHERE status = 'processing'
         UNION ALL
         SELECT COALESCE(lease_expires_at, due_at) AS due_at
           FROM suggested_work_sets WHERE due_at IS NOT NULL
       )
      WHERE due_at IS NOT NULL
     HAVING MIN(due_at) IS NOT NULL`,
  ],
}, {
  version: 5,
  description: "reconcile a carried-over workspace's schedule once",
  statements: [
    // Version 4 arrived with the scheduler object still running, so its final
    // alarm was what reconciled every non-product target. This change deletes
    // that object, and a schedule whose only pending wake-up lived there now
    // has no other writer until a person or a connector happens to touch the
    // workspace. One immediate entry, consumed once, closes that gap.
    //
    // A separate version rather than an amendment to 4: every object that
    // constructed between the two deploys recorded a hash of 4's statements,
    // and editing them in place throws `workspace_do_schema_hash_mismatch:4`
    // in the constructor — permanently, for every workspace that ran the
    // earlier release.
    //
    // Only for an object that already exists. A workspace created after this
    // deploy runs its whole ledger before it has an identity row, and arming a
    // reconcile for a database with nothing in it would make every new
    // workspace pay for a wake-up that can only find zero targets.
    `INSERT INTO _internal_durable_alarms
       (kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json,
        created_at, updated_at)
     SELECT 'schedule_bootstrap', 'workspace', unixepoch() * 1000, NULL, 0, 0, NULL,
            unixepoch() * 1000, unixepoch() * 1000
      WHERE EXISTS (SELECT 1 FROM workspace_identity WHERE id = 1)`,
  ],
}, {
  version: 6,
  description: "per-list ordering for the pushed sidebar lists",
  statements: [
    // One counter per list, not one for both. `choosing-sockets-or-rest.md`:
    // fields that change independently need independent counters, or updates
    // to the faster one hide updates to the slower one. Rows are seeded here
    // so a push never has to decide what an absent counter means.
    `CREATE TABLE workspace_sidebar_list_state (
      list TEXT PRIMARY KEY CHECK (list IN ('automations', 'notes')),
      waterline INTEGER NOT NULL CHECK (waterline >= 0)
    ) STRICT`,
    `INSERT INTO workspace_sidebar_list_state (list, waterline) VALUES ('automations', 0)`,
    `INSERT INTO workspace_sidebar_list_state (list, waterline) VALUES ('notes', 0)`,
  ],
}, {
  version: 7,
  description: "drop the automation email-route marker Global no longer mirrors",
  statements: [
    // The column existed to track a lifecycle Global held a second copy of, so
    // that an interrupted transition could be reconciled. Global now records
    // only that an address is claimed, and every reader of this marker already
    // had the real answer beside it: inbound mail resolves an automation with
    // `status = 'active' AND lifecycle_state = 'visible'`, which is what the
    // marker was derived from in the first place.
    `ALTER TABLE automation_subscriptions DROP COLUMN email_route_status`,
  ],
}, {
  version: 8,
  description: "where Avalon's Slack status reaction sits, and which one it is",
  statements: [
    // The reaction on the message that started a run is the only status a
    // member sees without opening the thread. It used to be added once and
    // removed by nothing, so a finished run and a failed one looked identical
    // at the message that asked for them. Giving it a lifecycle means a later
    // invocation — delivery, which owns the terminal transition — has to know
    // what Avalon last put there and on which message.
    //
    // The timestamp is the *triggering* message, not the thread root, and the
    // two differ whenever a member replies inside an existing Avalon thread.
    // Reacting to the root would move the status off the message they just
    // sent and onto one they may have stopped looking at hours ago.
    ...SLACK_REACTION_COLUMN_STATEMENTS,
  ],
}, {
  version: 9,
  description: "admit a second person-notification kind alongside the mention",
  statements: [
    // `notification_kind` was pinned to a single literal, so being added to a
    // work stream — the other thing that is worth telling one person about —
    // had nowhere to be recorded. SQLite cannot alter a CHECK in place, so the
    // table is rebuilt the way `terminal_workspace` was in the work-stream
    // object's schema: new table, copy, drop, rename.
    //
    // Version 1 still creates the narrow table and must: its statements are
    // hashed into every deployed object's `_sql_schema_migrations` receipt,
    // and editing them in place throws `workspace_do_schema_hash_mismatch:1`
    // in the constructor of every workspace that ran an earlier release. A new
    // object therefore creates the old shape and immediately rebuilds it,
    // which costs one empty copy once.
    `CREATE TABLE workstream_notification_intents_kinds (
      intent_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL,
      recipient_user_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      source_generation INTEGER NOT NULL CHECK (source_generation > 0),
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      required_directory_version INTEGER NOT NULL CHECK (required_directory_version > 0),
      notification_kind TEXT NOT NULL CHECK (notification_kind IN ('mention', 'participant_added')),
      payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'delivered', 'skipped', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      lease_id TEXT,
      lease_expires_at TEXT,
      last_error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      delivered_at TEXT,
      UNIQUE (source_message_id, recipient_user_id, notification_kind)
    ) STRICT`,
    `INSERT INTO workstream_notification_intents_kinds
       (intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id,
        source_generation, source_version, required_directory_version, notification_kind,
        payload_json, payload_hash, state, attempts, lease_id, lease_expires_at,
        last_error_code, created_at, updated_at, delivered_at)
     SELECT intent_id, workspace_id, workstream_id, recipient_user_id, source_message_id,
        source_generation, source_version, required_directory_version, notification_kind,
        payload_json, payload_hash, state, attempts, lease_id, lease_expires_at,
        last_error_code, created_at, updated_at, delivered_at
       FROM workstream_notification_intents`,
    // Takes the old table's indexes and identity-fence triggers with it, which
    // is why both are restated below rather than left to version 1.
    `DROP TABLE workstream_notification_intents`,
    `ALTER TABLE workstream_notification_intents_kinds RENAME TO workstream_notification_intents`,
    `CREATE INDEX workstream_notification_intents_delivery_idx
      ON workstream_notification_intents(state, lease_expires_at, created_at, intent_id)`,
    `CREATE INDEX workstream_notification_intents_terminal_idx
      ON workstream_notification_intents(workstream_id, state, created_at)`,
    `CREATE TRIGGER workstream_notification_intents_workspace_identity_insert
      BEFORE INSERT ON workstream_notification_intents
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER workstream_notification_intents_workspace_identity_update
      BEFORE UPDATE OF workspace_id ON workstream_notification_intents
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
  ],
}, {
  version: 10,
  description: "carry the per-person unseen flag into the sidebar's viewer projection",
  statements: [
    // The sidebar reads this table, not the work-stream object, so a state the
    // object knows about and this projection does not is a dot that never
    // lights. Defaulted to 0 because every row already here belongs to
    // somebody who has had the work stream for a while — the same reading the
    // object's own backfill takes.
    `ALTER TABLE workspace_workstream_viewers
       ADD COLUMN unseen INTEGER NOT NULL DEFAULT 0 CHECK (unseen IN (0, 1))`,
  ],
}, {
  version: 11,
  description: "freeze and resume generic work-stream batch Queue dispatch",
  statements: [
    `CREATE TABLE workspace_batch_dispatches (
      operation_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      user_id TEXT NOT NULL,
      target_count INTEGER NOT NULL CHECK (target_count >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT`,
    `CREATE TABLE workspace_batch_dispatch_targets (
      operation_id TEXT NOT NULL REFERENCES workspace_batch_dispatches(operation_id) ON DELETE CASCADE,
      workstream_id TEXT NOT NULL,
      dispatched_at INTEGER CHECK (dispatched_at IS NULL OR dispatched_at >= 0),
      PRIMARY KEY (operation_id, workstream_id)
    ) STRICT`,
    `CREATE INDEX workspace_batch_dispatch_targets_pending_idx
      ON workspace_batch_dispatch_targets(operation_id, workstream_id)
      WHERE dispatched_at IS NULL`,
  ],
}, {
  version: 12,
  description: "distinguish expiring Queue claims from drain-only Workflow ownership",
  statements: [
    // NULL is intentionally meaningful for rows already processing when this
    // migration lands: Queue claims did not exist before this version, so such
    // a row is a pre-cutover Workflow claim and remains exclusive until settle.
    `ALTER TABLE workspace_connector_events
       ADD COLUMN processing_orchestrator TEXT
       CHECK (processing_orchestrator IS NULL OR processing_orchestrator IN ('queue', 'workflow'))`,
  ],
}, {
  version: 13,
  description: "retain every semantic resource revision and its regional R2 objects",
  statements: [
    `ALTER TABLE resources
       ADD COLUMN current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version >= 1)`,
    `CREATE TABLE resource_versions (
      resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      connection_id TEXT,
      resource_type TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_resource_id TEXT,
      title TEXT NOT NULL,
      mime_type TEXT,
      content_ref TEXT,
      canonical_url TEXT,
      metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
      last_hydrated_at TEXT,
      uploaded_by_user_id TEXT,
      attachment_status TEXT NOT NULL CHECK (attachment_status IN ('draft', 'attached')),
      model_content_ref TEXT,
      model_mime_type TEXT,
      model_content_sha256 TEXT,
      model_metadata_json TEXT CHECK (model_metadata_json IS NULL OR json_valid(model_metadata_json)),
      content_sha256 TEXT,
      model_content_status TEXT CHECK (model_content_status IN ('pending', 'processing', 'ready', 'failed', 'unsupported')),
      model_content_extractor_version TEXT,
      model_content_character_count INTEGER CHECK (model_content_character_count IS NULL OR model_content_character_count >= 0),
      model_content_extracted_at TEXT,
      model_content_error_code TEXT,
      captured_at TEXT NOT NULL,
      PRIMARY KEY (resource_id, version)
    ) STRICT`,
    `CREATE INDEX resource_versions_workspace_idx
       ON resource_versions(workspace_id, resource_id, version DESC)`,
    `INSERT INTO resource_versions
       (resource_id, workspace_id, version, connection_id, resource_type, provider,
        provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
        last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
        model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
        model_content_status, model_content_extractor_version, model_content_character_count,
        model_content_extracted_at, model_content_error_code, captured_at)
     SELECT id, workspace_id, 1, connection_id, resource_type, provider,
            provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
            last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
            model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
            model_content_status, model_content_extractor_version, model_content_character_count,
            model_content_extracted_at, model_content_error_code, updated_at
       FROM resources`,
    `CREATE TRIGGER resource_versions_workspace_identity_insert
       BEFORE INSERT ON resource_versions
       WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
       BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER resource_versions_workspace_identity_update
       BEFORE UPDATE OF workspace_id ON resource_versions
       WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
       BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER resources_create_initial_version
       AFTER INSERT ON resources BEGIN
         INSERT INTO resource_versions
           (resource_id, workspace_id, version, connection_id, resource_type, provider,
            provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
            last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
            model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
            model_content_status, model_content_extractor_version, model_content_character_count,
            model_content_extracted_at, model_content_error_code, captured_at)
         VALUES
           (NEW.id, NEW.workspace_id, NEW.current_version, NEW.connection_id, NEW.resource_type, NEW.provider,
            NEW.provider_resource_id, NEW.title, NEW.mime_type, NEW.content_ref, NEW.canonical_url, NEW.metadata_json,
            NEW.last_hydrated_at, NEW.uploaded_by_user_id, NEW.attachment_status, NEW.model_content_ref,
            NEW.model_mime_type, NEW.model_content_sha256, NEW.model_metadata_json, NEW.content_sha256,
            NEW.model_content_status, NEW.model_content_extractor_version, NEW.model_content_character_count,
            NEW.model_content_extracted_at, NEW.model_content_error_code, NEW.updated_at);
       END`,
    `CREATE TRIGGER resources_create_semantic_version
       AFTER UPDATE OF connection_id, resource_type, provider, provider_resource_id, title,
         mime_type, content_ref, canonical_url, metadata_json, last_hydrated_at,
         uploaded_by_user_id, attachment_status, content_sha256 ON resources
       WHEN NEW.current_version = OLD.current_version BEGIN
         UPDATE resources SET current_version = OLD.current_version + 1 WHERE id = NEW.id;
         INSERT INTO resource_versions
           (resource_id, workspace_id, version, connection_id, resource_type, provider,
            provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
            last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
            model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
            model_content_status, model_content_extractor_version, model_content_character_count,
            model_content_extracted_at, model_content_error_code, captured_at)
         SELECT id, workspace_id, current_version, connection_id, resource_type, provider,
                provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
                last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
                model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
                model_content_status, model_content_extractor_version, model_content_character_count,
                model_content_extracted_at, model_content_error_code, updated_at
           FROM resources WHERE id = NEW.id;
       END`,
    `CREATE TRIGGER resources_sync_current_version_derivative
       AFTER UPDATE OF model_content_ref, model_mime_type, model_content_sha256,
         model_metadata_json, model_content_status, model_content_extractor_version,
         model_content_character_count, model_content_extracted_at, model_content_error_code
       ON resources
       WHEN NEW.connection_id IS OLD.connection_id
        AND NEW.resource_type IS OLD.resource_type
        AND NEW.provider IS OLD.provider
        AND NEW.provider_resource_id IS OLD.provider_resource_id
        AND NEW.title IS OLD.title
        AND NEW.mime_type IS OLD.mime_type
        AND NEW.content_ref IS OLD.content_ref
        AND NEW.canonical_url IS OLD.canonical_url
        AND NEW.metadata_json IS OLD.metadata_json
        AND NEW.last_hydrated_at IS OLD.last_hydrated_at
        AND NEW.uploaded_by_user_id IS OLD.uploaded_by_user_id
        AND NEW.attachment_status IS OLD.attachment_status
        AND NEW.content_sha256 IS OLD.content_sha256 BEGIN
         UPDATE resource_versions
            SET model_content_ref = NEW.model_content_ref,
                model_mime_type = NEW.model_mime_type,
                model_content_sha256 = NEW.model_content_sha256,
                model_metadata_json = NEW.model_metadata_json,
                model_content_status = NEW.model_content_status,
                model_content_extractor_version = NEW.model_content_extractor_version,
                model_content_character_count = NEW.model_content_character_count,
                model_content_extracted_at = NEW.model_content_extracted_at,
                model_content_error_code = NEW.model_content_error_code
          WHERE resource_id = NEW.id AND version = NEW.current_version;
       END`,
    `CREATE TRIGGER resource_versions_enqueue_objects_before_delete
       BEFORE DELETE ON resource_versions BEGIN
         INSERT OR IGNORE INTO resource_object_deletion_outbox
           (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
           SELECT OLD.content_ref, OLD.workspace_id, OLD.resource_id, 'original', datetime('now'), datetime('now')
            WHERE OLD.content_ref IS NOT NULL;
         INSERT OR IGNORE INTO resource_object_deletion_outbox
           (object_ref, workspace_id, resource_id, object_kind, created_at, updated_at)
           SELECT OLD.model_content_ref, OLD.workspace_id, OLD.resource_id, 'derivative', datetime('now'), datetime('now')
            WHERE OLD.model_content_ref IS NOT NULL;
       END`,
  ],
}];

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function readAttachment(socket: WebSocket): WorkspaceSocketAttachment | null {
  try {
    const parsed = SocketIdentitySchema.extend({
      connectionId: z.string().uuid(),
      connectedAt: z.string().datetime({ offset: true }),
      subscribed: z.boolean(),
      lastWaterline: z.number().int().nonnegative(),
      // Sockets accepted by the previous deployment carry none of these fields. They
      // resume safely as backgrounded and write the explicit shape on their
      // first presence event instead of being disconnected during rollout.
      presenceRevision: z.number().int().nonnegative().default(0),
      applicationState: z.enum(["foreground", "background"]).default("background"),
      foregroundWorkstreamId: WorkstreamIdSchema.nullable().default(null),
    }).safeParse(socket.deserializeAttachment());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function contributesPresence(
  attachment: WorkspaceSocketAttachment | null,
): attachment is WorkspaceSocketAttachment & {
  subscribed: true;
  applicationState: "foreground";
  foregroundWorkstreamId: string;
} {
  return attachment?.subscribed === true
    && attachment.applicationState === "foreground"
    && attachment.foregroundWorkstreamId !== null;
}

/**
 * Stop sending to a socket, then close it.
 *
 * The attachment is marked unsubscribed first because that is the filter both
 * publish loops apply. Closing alone would leave the guarantee to the runtime —
 * `send` on a closed socket throws, and both loops catch that throw — so a
 * disconnected listener would be spared the next payload by accident rather
 * than on purpose. On an access path that is the wrong place for the rule to
 * live.
 */
function disconnect(socket: WebSocket, code: number, reason: string): void {
  const attachment = readAttachment(socket);
  if (attachment) {
    try {
      socket.serializeAttachment({ ...attachment, subscribed: false } satisfies WorkspaceSocketAttachment);
    } catch {
      // An unreadable attachment already fails both publish filters.
    }
  }
  try {
    socket.close(code, reason);
  } catch {
    // Already closing or closed; the runtime owns the rest of the teardown.
  }
}

type WorkspaceSocketOperation =
  | "attachment"
  | "decode"
  | "validate"
  | "subscribe"
  | "presence"
  | "list_workstreams"
  | "create_message";

interface WorkspaceSocketCloseInput {
  code: number;
  reason: string;
  cause: string;
  operation: WorkspaceSocketOperation;
  frameBytes?: number;
  validationIssues?: ReadonlyArray<{ path: string; code: string }>;
}

function closeWorkspaceSocket(
  env: Env,
  socket: WebSocket,
  attachment: WorkspaceSocketAttachment | null,
  input: WorkspaceSocketCloseInput,
): void {
  logWarn(env, "workspace_socket_closed", {
    code: input.cause,
    close_code: input.code,
    close_reason: input.reason,
    operation: input.operation,
    ...(input.frameBytes === undefined ? {} : { frame_bytes: input.frameBytes }),
    ...(input.validationIssues ? { validation_issues: input.validationIssues.slice(0, 25) } : {}),
    ...(attachment
      ? {
        workspace_id: attachment.workspaceId,
        user_id: attachment.userId,
        session_id: attachment.sessionId,
        connection_id: attachment.connectionId,
      }
      : {}),
  });
  disconnect(socket, input.code, input.reason);
}

function epoch(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error("workspace_directory_timestamp_invalid");
  return parsed;
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function workflowAlreadyExists(error: unknown): boolean {
  return error instanceof Error && /(already exists|duplicate|conflict)/iu.test(error.message);
}

function connectorEventFromRow(
  row: WorkspaceConnectorEventRow,
  workspaceId: string,
  region: Env["AVALON_REGION"],
): WorkspaceConnectorEvent {
  return WorkspaceConnectorEventSchema.parse({
    connectorType: row.connector_type,
    activity: {
      id: row.event_id,
      workspaceId,
      region,
      connectionId: row.connection_id,
      connectionScope: row.connection_scope,
      connectionOwnerUserId: row.connection_owner_user_id,
      provider: row.provider,
      providerEventId: row.provider_event_id,
      eventType: row.event_type,
      resourceType: row.resource_type,
      providerResourceId: row.provider_resource_id,
      actor: JSON.parse(row.actor_json) as unknown,
      subject: JSON.parse(row.subject_json) as unknown,
      occurredAt: iso(row.occurred_at),
      receivedAt: iso(row.received_at),
      title: row.title,
      summary: row.summary,
      textSnippet: row.text_snippet,
      payloadRef: row.payload_ref,
      visibility: JSON.parse(row.visibility_json) as unknown,
      targetUserIds: JSON.parse(row.target_user_ids_json) as unknown,
      entityKeys: JSON.parse(row.entity_keys_json) as unknown,
      dedupeKey: row.dedupe_key,
      rawContentHash: row.raw_content_hash,
      metadata: JSON.parse(row.metadata_json) as unknown,
      externalPeople: JSON.parse(row.external_people_json) as unknown,
    },
  });
}

function directoryCursor(value: string): { lastActivityAt: number; workstreamId: string } {
  const separator = value.indexOf(":");
  const lastActivityAt = Number(value.slice(0, separator));
  const workstreamId = value.slice(separator + 1);
  if (!Number.isSafeInteger(lastActivityAt) || lastActivityAt < 0 || !workstreamId) {
    throw new Error("workspace_directory_cursor_invalid");
  }
  return { lastActivityAt, workstreamId };
}

function workstreamHarnessStatus(state: string): Workstream["harnessStatus"] {
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

function directoryWorkstream(row: WorkspaceDirectoryRow, workspaceId: string): Workstream {
  const latest = Number(row.latest_attention_ordinal);
  const seen = row.seen_attention_ordinal === null
    ? Number(row.unread_tracking_start_ordinal)
    : Number(row.seen_attention_ordinal);
  const manual = row.manual_unread_from_ordinal === null
    ? null
    : Number(row.manual_unread_from_ordinal);
  const firstUnread = manual ?? (latest > seen ? Math.min(latest, seen + 1) : null);
  const titleStatus = row.title_status === "naming"
    && Date.now() - row.source_created_at > WORKSTREAM_NAMING_GRACE_MS
    ? "automatic"
    : row.title_status;
  return WorkstreamSchema.parse({
    id: row.workstream_id,
    workspaceId,
    title: truncateUtf16Safe(row.title, 180),
    titleStatus,
    objective: truncateUtf16Safe(row.description, WORKSTREAM_DESCRIPTION_MAX_CHARACTERS),
    emailAddress: row.email_address,
    originType: row.origin_type,
    originLabel: row.origin_label,
    createdByUserId: row.created_by_user_id,
    automationSubscriptionId: row.automation_subscription_id,
    automationRunId: row.automation_run_id,
    plannedFor: iso(row.planned_for),
    harnessStatus: workstreamHarnessStatus(row.exact_state),
    latestAttentionSequenceNumber: latest,
    readThroughSequenceNumber: seen,
    manualUnreadFromSequenceNumber: manual,
    manualUnreadGeneration: Number(row.manual_unread_generation ?? 0),
    hasUnread: firstUnread !== null,
    youAreMentioned: Number(row.latest_mention_attention_ordinal ?? 0) > seen,
    unseen: row.unseen === 1,
    firstUnreadSequenceNumber: firstUnread,
    lastActivityAt: iso(row.last_activity_at),
    createdAt: iso(row.source_created_at),
    updatedAt: iso(row.source_updated_at),
    archivedAt: iso(row.archived_at),
    scope: row.scope,
    systemKind: row.system_kind,
    nextPendingWakeup: row.next_wakeup_due_at !== null && row.next_wakeup_prompt
      ? {
          dueAt: iso(row.next_wakeup_due_at),
          promptPreview: truncateUtf16Safe(row.next_wakeup_prompt.replace(/\s+/gu, " ").trim(), 40),
        }
      : null,
    pinPosition: row.pin_position,
  });
}

function directoryStateVersion(row: WorkspaceDirectoryRow) {
  return {
    workstreamId: row.workstream_id,
    commonEventId: row.common_event_id,
    viewerEventId: row.viewer_event_id,
    authorityGeneration: row.authority_generation,
    commonWaterline: row.common_waterline,
    viewerWaterline: row.viewer_waterline ?? 0,
  };
}

function internalDirectoryItem(row: WorkspaceDirectoryRow) {
  return {
    workstreamId: row.workstream_id,
    title: row.title,
    description: row.description,
    scope: row.scope,
    state: row.exact_state,
    systemKind: row.system_kind,
    lastActivityAt: iso(row.last_activity_at),
    archivedAt: iso(row.archived_at),
    updatedAt: iso(row.source_updated_at),
    originType: row.origin_type,
    originLabel: row.origin_label,
    createdByUserId: row.created_by_user_id,
    automationSubscriptionId: row.automation_subscription_id,
    automationRunId: row.automation_run_id,
    plannedFor: iso(row.planned_for),
  };
}

const SELECT_WORKSPACE_DIRECTORY = `SELECT directory.workstream_id,
    directory.authority_generation, directory.waterline AS common_waterline,
    directory.source_event_id AS common_event_id, directory.title,
    directory.description, directory.scope, directory.exact_state,
    directory.system_kind, directory.last_activity_at, directory.completed_at,
    directory.archived_at, directory.email_address, directory.origin_type,
    directory.origin_label, directory.created_by_user_id,
    directory.automation_subscription_id, directory.automation_run_id,
    directory.planned_for, directory.title_status,
    directory.latest_attention_ordinal, directory.unread_tracking_start_ordinal,
    directory.next_wakeup_due_at, directory.next_wakeup_prompt,
    directory.source_created_at, directory.source_updated_at,
    viewer.seen_attention_ordinal, viewer.manual_unread_from_ordinal,
    viewer.manual_unread_generation, viewer.latest_mention_attention_ordinal,
    viewer.is_participant, viewer.unseen, viewer.waterline AS viewer_waterline,
    viewer.source_event_id AS viewer_event_id, pin.position AS pin_position
  FROM workspace_workstream_directory directory
  LEFT JOIN workspace_workstream_viewers viewer
    ON viewer.workstream_id = directory.workstream_id
   AND viewer.user_id = ?
   AND viewer.authority_generation = directory.authority_generation
  LEFT JOIN workspace_workstream_pins pin
    ON pin.workstream_id = directory.workstream_id AND pin.user_id = ?`;

/**
 * One regional synchronization and command/control object per workspace.
 *
 * The Electron app keeps one hibernating socket here for workspace-wide query
 * invalidations, directory pages, and user writes. Message commands name their
 * target branch. WorkspaceDO SQL is authoritative for cross-workstream serving
 * state; regional D1 retains only identity, membership, routing,
 * migration/control, and operational audit/telemetry.
 */
/**
 * What the command socket's authorization query answers with. The analytics
 * column is absent on the development path, which selects only the role —
 * optional rather than nullable so that shape stays legal.
 */
interface WorkspaceAuthRoleRow {
  role: AuthContext["role"];
  analytics_workspace_id?: string | null;
}

/**
 * The migration runner's component key for this class.
 *
 * One constant because two call sites need the identical value: the runner
 * keys the object's schema ledger by it, and the migration report keys the
 * tracker's component rollup by it. Two literals that drift put an object
 * under a component its own ledger does not use, which shows up as a silent
 * miscount rather than an error.
 */
const MIGRATION_COMPONENT = "workspace_do";

export class WorkspaceDO extends ScheduledDurableObject<Env> {
  private readonly state: DurableObjectState;
  private readonly initialized: Promise<void>;
  /** This object's own `WORKSPACE_DOS` name; see {@link selfObjectName}. */
  private objectName: string | null = null;
  /** Content-free phase timings for the alarm invocation currently running. */
  private workspaceAlarmInstrumentation: WorkspaceAlarmInstrumentation | null = null;

  constructor(
    state: DurableObjectState,
    env: Env,
  ) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    this.state = state;
    // Everything downstream is handed this environment or one derived from it,
    // so a helper that addresses "the WorkspaceDO for this workspace" reaches
    // the object it is already running in rather than the namespace. See
    // `lib/durable-object-self.ts`.
    //
    // The parameter is rebound as well as the field, so the rest of this
    // constructor cannot hand the unregistered environment to something
    // long-lived.
    this.env = env = withDurableObjectSelf(env, {
      namespace: env.WORKSPACE_DOS,
      name: () => this.selfObjectName(),
      id: state.id,
      instance: this,
    });
    this.initialized = this.initializeDurableObject(async () => {
      await this.applyMigrations(() => applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: MIGRATION_COMPONENT,
        workerVersionId: env.APP_VERSION ?? "unknown",
      }));
      await this.armNextAlarm();
    });
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  protected override migrationPlan(): DurableObjectMigrationPlan {
    return {
      component: MIGRATION_COMPONENT,
      className: "WorkspaceDO",
      migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
    };
  }

  protected override migrationsReady(): Promise<void> {
    return this.initialized;
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
        role: "workspace-control",
        workspaceId: this.workspaceId(),
        placementAffinity: this.placementAffinity(),
        syncWaterline: this.latestSyncWaterline(),
        databaseBytes: this.state.storage.sql.databaseSize,
      });
    }
    return json({ error: "not_found" }, 404);
  }

  /** Trusted Worker compatibility port for WorkspaceDO-owned relational state. */
  async executeRuntimeSql(input: WorkspaceRuntimeSqlRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    try {
      const request = WorkspaceRuntimeSqlRequestSchema.parse(input);
      this.assertWorkspace(request.workspaceId);
      const results = this.runWorkspaceSql(request);
      if (request.statements.some((statement) => {
        const target = workspaceMutationTarget(statement.sql);
        return target !== null && WORKSPACE_ALARM_SOURCE_TABLES.has(target);
      })) {
        this.state.waitUntil(this.refreshSchedule(request.workspaceId).catch((error: unknown) => {
          // Swallowed silently, a failed refresh here leaves a schedule dark
          // until something else reconciles. The alarm's own end-of-drain
          // refresh is the backstop; this line is how anyone finds out the
          // backstop was needed.
          logWarn(this.env, "workspace_schedule_auto_refresh_failed", {
            workspace_id: request.workspaceId,
            code: error instanceof Error ? error.message : "unknown_error",
          });
        }));
      }
      return responseToRpcResult(json({ results }));
    } catch (error) {
      return responseToRpcResult(json({
        error: error instanceof Error ? error.message : "workspace_runtime_sql_failed",
      }, 409));
    }
  }

  override async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): Promise<void> {
    await this.initialized;
    const attachment = readAttachment(socket);
    if (!attachment) {
      this.closeSocket(socket, null, {
        code: 1011,
        reason: "Missing workspace connection identity",
        cause: "missing_connection_identity",
        operation: "attachment",
      });
      return;
    }
    const raw = typeof message === "string" ? message : new TextDecoder().decode(message);
    const frameBytes = typeof message === "string"
      ? new TextEncoder().encode(message).byteLength
      : message.byteLength;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      this.closeSocket(socket, attachment, {
        code: WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
        reason: "Workspace commands must be JSON",
        cause: "invalid_json",
        operation: "decode",
        frameBytes,
        validationIssues: [{ path: "(root)", code: "invalid_json" }],
      });
      return;
    }
    // Ahead of the parse, and the only bound that is. Every other way this
    // event can be malformed is a client defect, and closing the socket is the
    // right answer to one. An over-long message is not a defect — it is a
    // person who pasted more than Avalon takes — and closing their connection
    // to say so would drop the transcript they are looking at, tell them
    // nothing, and reconnect into the same refusal on the next attempt. The
    // desktop already stops this at the composer; this is what a build that has
    // not caught up, or a message grown past the ceiling between the two, is
    // told instead.
    const overLong = overLongCreateMessageCommand(decoded);
    if (overLong) {
      socket.send(JSON.stringify(WorkstreamSocketCommandResultSchema.parse({
        type: "client_command_failed",
        command: "create_message",
        clientMessageId: overLong.clientMessageId,
        error: { status: 400, code: "message_too_long", message: MESSAGE_TOO_LONG_MESSAGE },
      })));
      return;
    }
    const parsed = WorkspaceSocketClientEventSchema.safeParse(decoded);
    if (!parsed.success) {
      this.closeSocket(socket, attachment, {
        code: WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
        reason: "Invalid workspace socket event",
        cause: "invalid_event",
        operation: "validate",
        frameBytes,
        validationIssues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join(".") || "(root)",
          code: issue.code,
        })),
      });
      return;
    }
    if (parsed.data.type === "subscribe") {
      const auth = await this.sessionAuth(attachment);
      if (!auth) {
        this.closeSocket(socket, attachment, {
          code: WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
          reason: "Session no longer active",
          cause: "session_inactive",
          operation: "subscribe",
        });
        return;
      }
      await this.subscribe(socket, attachment, parsed.data.afterWaterline);
      return;
    }
    if (parsed.data.type === "set_presence") {
      const auth = await this.sessionAuth(attachment);
      if (!auth) {
        this.closeSocket(socket, attachment, {
          code: WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
          reason: "Session no longer active",
          cause: "session_inactive",
          operation: "presence",
        });
        return;
      }
      // D1 authentication yields the input gate. A newer focus transition can
      // therefore finish while this one is waiting; re-read the attachment and
      // fence the older command before it can restore stale presence.
      const currentAttachment = readAttachment(socket);
      if (!currentAttachment || parsed.data.revision <= currentAttachment.presenceRevision) return;
      if (!currentAttachment.subscribed
        || (parsed.data.foregroundWorkstreamId !== null
          && !this.directoryVisible(currentAttachment.userId, parsed.data.foregroundWorkstreamId))) {
        this.closeSocket(socket, currentAttachment, {
          code: WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
          reason: "Invalid workspace presence",
          cause: currentAttachment.subscribed
            ? "presence_workstream_inaccessible"
            : "presence_before_subscribe",
          operation: "presence",
        });
        return;
      }
      const presenceChanged = currentAttachment.applicationState !== parsed.data.applicationState
        || currentAttachment.foregroundWorkstreamId !== parsed.data.foregroundWorkstreamId;
      socket.serializeAttachment({
        ...currentAttachment,
        presenceRevision: parsed.data.revision,
        applicationState: parsed.data.applicationState,
        foregroundWorkstreamId: parsed.data.foregroundWorkstreamId,
      } satisfies WorkspaceSocketAttachment);
      if (presenceChanged) this.broadcastPresence();
      return;
    }
    if (parsed.data.type === "list_workstreams") {
      const auth = await this.sessionAuth(attachment);
      if (!auth) {
        this.closeSocket(socket, attachment, {
          code: WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
          reason: "Session no longer active",
          cause: "session_inactive",
          operation: "list_workstreams",
        });
        return;
      }
      const page = this.listDirectory({
        workspaceId: attachment.workspaceId,
        userId: attachment.userId,
        limit: parsed.data.limit,
        ...(parsed.data.before ? { before: parsed.data.before } : {}),
        includeSystem: parsed.data.includeSystem,
      });
      socket.send(JSON.stringify(WorkspaceWorkstreamPageEventSchema.parse({
        type: "workspace_workstream_page",
        requestId: parsed.data.requestId,
        ...page,
      })));
      return;
    }
    await this.createMessage(socket, attachment, parsed.data);
  }

  override webSocketClose(socket: WebSocket): void {
    if (contributesPresence(readAttachment(socket))) this.broadcastPresence(socket);
  }

  override webSocketError(socket: WebSocket): void {
    // The client reconnects with a new one-time ticket when it still has work;
    // everyone else must stop seeing the failed connection immediately.
    if (contributesPresence(readAttachment(socket))) this.broadcastPresence(socket);
  }

  private closeSocket(
    socket: WebSocket,
    attachment: WorkspaceSocketAttachment | null,
    input: WorkspaceSocketCloseInput,
  ): void {
    const wasPresent = contributesPresence(attachment);
    if (wasPresent) {
      try {
        socket.serializeAttachment({
          ...attachment,
          applicationState: "background",
          foregroundWorkstreamId: null,
        } satisfies WorkspaceSocketAttachment);
      } catch {
        // Closing and the exclusion fence below still remove this socket from
        // the canonical set when its attachment cannot be rewritten.
      }
    }
    closeWorkspaceSocket(this.env, socket, attachment, input);
    // Exclusion is the cleanup fence even if attachment serialization failed
    // while disconnecting. A broken socket cannot block or rejoin this rebuild.
    if (wasPresent) this.broadcastPresence(socket);
  }

  /**
   * Send each connection only the presence for the work stream it currently
   * foregrounds. This both avoids leaking personal work-stream identities and
   * keeps the frame equal to the one face pile the renderer can paint.
   */
  private broadcastPresence(excluding?: WebSocket): void {
    const sockets: Array<{ socket: WebSocket; attachment: WorkspaceSocketAttachment }> = [];
    for (const socket of this.state.getWebSockets()) {
      if (socket === excluding) continue;
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      if (contributesPresence(attachment)
        && !this.directoryVisible(attachment.userId, attachment.foregroundWorkstreamId)) {
        try {
          socket.serializeAttachment({
            ...attachment,
            applicationState: "background",
            foregroundWorkstreamId: null,
          } satisfies WorkspaceSocketAttachment);
        } catch {
          // Fail closed: an attachment that cannot record lost visibility must
          // reconnect before it can contribute or receive presence again.
          disconnect(socket, WORKSPACE_SOCKET_INVALID_MESSAGE_CODE, "Invalid workspace presence");
        }
        continue;
      }
      sockets.push({ socket, attachment });
    }
    const presentUsers = new Map<string, Set<string>>();
    for (const { attachment } of sockets) {
      if (attachment.applicationState !== "foreground" || attachment.foregroundWorkstreamId === null) continue;
      const users = presentUsers.get(attachment.foregroundWorkstreamId) ?? new Set<string>();
      users.add(attachment.userId);
      presentUsers.set(attachment.foregroundWorkstreamId, users);
    }
    const occurredAt = new Date().toISOString();
    for (const { socket, attachment } of sockets) {
      if (!contributesPresence(attachment)) continue;
      const workstreamId = attachment.foregroundWorkstreamId;
      const userIds = [...(presentUsers.get(workstreamId) ?? [])]
        .filter((userId) => userId !== attachment.userId);
      try {
        socket.send(JSON.stringify(WorkspacePresenceEventSchema.parse({
          type: "workspace_presence",
          occurredAt,
          workstreamId,
          userIds,
        })));
      } catch {
        // Presence is reconstructed from healthy attachments on the next
        // foreground change. One stale socket must not block the others.
      }
    }
  }

  /**
   * Workspace-local product scheduler.
   *
   * SQLite decides what is due and fences each claim. The alarm only starts a
   * deterministic Workflow instance; inference and ranking never run in the
   * object's single-threaded request path. A dormant member deliberately leaves
   * a due request parked without another alarm. Their next authenticated read
   * schedules the object again, avoiding an idle per-workspace polling loop.
   */
  /**
   * Hold every due target while this region is closed for maintenance.
   *
   * The frozen D1 snapshot is the authority for this object's tables during an
   * import, and the importer re-verifies every page it sends. Claiming a
   * window, advancing a schedule, or reaping a completed one here would mutate
   * exactly those rows between a page and its retry. Nothing is dropped: every
   * entry keeps its due time and this rechecks on a fixed cadence rather than
   * waiting for the next future target, so a workspace whose whole schedule is
   * already overdue still resumes the moment the region reopens.
   */
  protected override async scheduledAlarmDeferral(now: number): Promise<number | null> {
    const deferral = await this.instrumentWorkspaceAlarmPhase("authority_check", undefined, async () => {
      const authority = await readWorkstreamAuthorityControl(this.env);
      if (authority.phase === "durable_object_open" || authority.phase === "legacy_open") {
        return null;
      }
      return now + MAINTENANCE_RECHECK_MS;
    });
    // A deferred invocation returns from the base before the ordinary final
    // re-arm hook. Close its summary here; the base's direct `setAlarm` is a
    // platform storage span and not scheduled application work.
    if (deferral !== null) this.finishWorkspaceAlarmInstrumentation();
    return deferral;
  }

  protected override armAlarmBeforeDueWork(now: number): Promise<unknown> {
    // This is the first awaited phase after the base has verified migrations,
    // so a fresh recorder here also discards any incomplete recorder left by a
    // continuation the runtime ended before the previous alarm could finish.
    this.workspaceAlarmInstrumentation = new WorkspaceAlarmInstrumentation(this.env);
    return this.instrumentWorkspaceAlarmPhase("recovery_rearm", undefined, async () =>
      super.armAlarmBeforeDueWork(now));
  }

  protected override async armAlarmAfterDueWork(): Promise<unknown> {
    try {
      return await this.instrumentWorkspaceAlarmPhase("final_rearm", undefined, async () =>
        super.armAlarmAfterDueWork());
    } finally {
      this.finishWorkspaceAlarmInstrumentation();
    }
  }

  /**
   * Everything this object wakes for that is not a stored entry.
   *
   * Only the activity-event retention sweep: it is derived from the oldest row
   * in a table this object writes constantly, so an entry would be rewritten on
   * every event. Product work, schedules, watches, maintenance passes, and
   * Terminal deadlines are all entries, each with its own retry gate.
   */
  protected override nextDerivedAlarmCandidates(): readonly number[] {
    const oldest = this.state.storage.sql.exec<{ created_at: number | null }>(
      `SELECT MIN(created_at) AS created_at FROM workspace_activity_events`,
    ).one().created_at;
    return oldest === null ? [] : [Number(oldest) + ACTIVITY_EVENT_RETENTION_MS];
  }

  /**
   * The one thing this object's alarm does that no entry owns.
   *
   * Expired activity events are swept on every wake rather than through an
   * entry: the sweep is idempotent, bounded to 500 rows, and its due time
   * moves with every event this workspace records.
   */
  protected override async runDueAlarmWork(now: number): Promise<void> {
    await this.instrumentWorkspaceAlarmPhase("activity_reap", undefined, async () => {
      this.reapExpiredActivityEvents(now);
    });
    const workspaceId = this.workspaceId();
    // Re-derive the whole index before this alarm ends, exactly as the object
    // that used to own it did. A target that just fired has advanced its own
    // canonical row — `runSchedule` writes the next `next_run_at`,
    // `runResourceWatch` the next `next_poll_at`, a bounded maintenance pass
    // can leave rows behind — and it writes them through the local executor,
    // which does not pass the auto-refresh in `executeRuntimeSql`. Without
    // this, the drain settles the one-shot entry it just ran and nothing arms
    // the occurrence that replaced it: a recurring automation fires once and
    // then never again until an unrelated mutation happens to reconcile.
    if (workspaceId) {
      await this.instrumentWorkspaceAlarmPhase("schedule_reconcile", undefined, async () => {
        await this.refreshSchedule(workspaceId);
      });
    }
  }

  protected override async runScheduledAlarm(alarm: ScheduledAlarm): Promise<ScheduledAlarmOutcome> {
    return this.instrumentWorkspaceAlarmPhase(
      "stored_target",
      observableWorkspaceScheduledAlarmKind(alarm.kind),
      async () => {
        const workspaceId = this.workspaceId();
        if (!workspaceId) return;
        if (alarm.kind === PRODUCT_ALARM_KIND) {
          await this.runProductAlarm(workspaceId);
          return;
        }
        if (alarm.kind === SCHEDULE_BOOTSTRAP_ALARM_KIND) {
          // One-shot, written by the migration that created this index: it exists
          // so an object that has never been asked to reconcile does it once,
          // unprompted. Settling deletes it.
          await this.refreshSchedule(workspaceId);
          return;
        }
        if (!isWorkspaceScheduleAlarmKind(alarm.kind)) {
          throw new Error(`workspace_object_unknown_alarm_kind:${alarm.kind}`);
        }
        return runWorkspaceScheduleTarget(
          this.scheduleContext(workspaceId),
          { kind: alarm.kind, id: alarm.key, dueAt: new Date(alarm.dueAt).toISOString() },
          new Date(),
        );
      },
    );
  }

  /**
   * Time one bounded, content-free phase of this WorkspaceDO alarm.
   *
   * Cloudflare adds the invocation and Durable Object ids itself. Keeping
   * identity out of these fields means a phase row can explain a hot object
   * without copying a workspace id, target key, due time, payload, or error
   * message into Workers Logs or the Global trace export.
   */
  private instrumentWorkspaceAlarmPhase<T>(
    phase: WorkspaceScheduledAlarmPhase,
    alarmKind: ObservableWorkspaceScheduledAlarmKind | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    // Defensive for direct private-method tests and future internal callers;
    // the normal alarm sequence initializes this in armAlarmBeforeDueWork.
    this.workspaceAlarmInstrumentation ??= new WorkspaceAlarmInstrumentation(this.env);
    return this.workspaceAlarmInstrumentation.phase(phase, alarmKind, run);
  }

  private finishWorkspaceAlarmInstrumentation(): void {
    this.workspaceAlarmInstrumentation?.finish();
    this.workspaceAlarmInstrumentation = null;
  }

  protected override onScheduledAlarmFailure(
    alarm: ScheduledAlarm,
    error: unknown,
    attempt: number,
  ): void {
    const workspaceId = this.workspaceId();
    reportScheduledAlarmAttempt(this.env, (promise) => this.state.waitUntil(promise), {
      event: "workspace_scheduled_alarm_failed",
      summary: "A workspace alarm target keeps throwing; `code` is the handler's error, and `alarm_kind` and `alarm_key` name the target.",
      attempt,
      fields: {
        workspace_id: workspaceId,
        alarm_kind: alarm.kind,
        alarm_key: alarm.key,
      },
      error,
    });
    if (!workspaceId || !isWorkspaceScheduleAlarmKind(alarm.kind)) return;
    // The audit row is a regional D1 write and this hook cannot await; the
    // retry gate is already persisted, so losing the record to an eviction
    // costs the operator one line and the product nothing.
    this.state.waitUntil(recordWorkspaceScheduleFailure(
      this.scheduleContext(workspaceId),
      { kind: alarm.kind, id: alarm.key, dueAt: new Date(alarm.dueAt).toISOString() },
      error,
    ).catch(() => undefined));
  }

  protected override onScheduledAlarmStalled(alarm: ScheduledAlarm, attempt: number): void {
    reportScheduledAlarmAttempt(this.env, (promise) => this.state.waitUntil(promise), {
      event: "workspace_scheduled_alarm_stalled",
      summary: "A workspace alarm target keeps coming back due at the same instant after running: the reap or reconcile named by `alarm_kind` and `alarm_key` is not removing what its due-time query counts. Find the row it counts and why the pass does not move it.",
      attempt,
      fields: {
        workspace_id: this.workspaceId(),
        alarm_kind: alarm.kind,
        alarm_key: alarm.key,
        due_at: new Date(alarm.dueAt).toISOString(),
      },
    });
  }

  /**
   * Reconcile every workspace-wide target into the alarm index.
   *
   * Called after any mutation that can move a due time — a schedule edited, a
   * watch enabled, an outbox row written through the runtime SQL port — and
   * once by the `schedule_bootstrap` entry the alarm migration writes.
   * Reconciling rather than appending is what lets a cancelled schedule take
   * its alarm with it.
   */
  async refreshSchedule(workspaceId: string): Promise<{ alarmAt: string | null }> {
    await this.initialized;
    const parsed = WorkspaceIdSchema.parse(workspaceId);
    // No identity means no workspace rows: every write to this object asserts
    // its identity first, so there is nothing here that could be due.
    if (this.workspaceId() === null) return { alarmAt: null };
    this.assertWorkspace(parsed);
    const targets = await workspaceScheduleTargets(this.scheduleContext(parsed));
    const grouped = new Map<WorkspaceScheduleTargetKind, { key: string; dueAt: number }[]>(
      WORKSPACE_SCHEDULE_ALARM_KINDS.map((kind) => [kind, []]),
    );
    for (const target of targets) {
      grouped.get(target.kind)?.push({ key: target.id, dueAt: Date.parse(target.dueAt) });
    }
    this.state.storage.transactionSync(() => {
      for (const [kind, entries] of grouped) this.scheduledAlarms.reconcile(kind, entries);
    });
    const alarmAt = await this.armNextAlarm();
    return { alarmAt: alarmAt === null ? null : new Date(alarmAt).toISOString() };
  }

  /**
   * Re-derive the Terminal deadlines alone.
   *
   * Only this kind: the other three read tables a directory effect never
   * touches, and a full refresh on the hottest write path this object has
   * would put ten queries behind every directory publish. The source is the
   * same method the full reconcile reads, so there is still one derivation of
   * when a sandbox is due.
   */
  private async refreshTerminalSchedule(): Promise<void> {
    const workspaceId = this.workspaceId();
    if (!workspaceId) return;
    const targets = await this.workstreamScheduleTargets({ workspaceId });
    await this.reconcileScheduledAlarms(
      "terminal",
      targets.items
        .filter((target) => target.kind === "terminal")
        .map((target) => ({ key: target.workstreamId, dueAt: Date.parse(target.dueAt) }))
        .filter((target) => Number.isFinite(target.dueAt)),
    );
  }

  private scheduleContext(workspaceId: string): WorkspaceScheduleContext {
    return {
      env: this.env,
      workspaceEnv: this.localWorkspaceEnv(workspaceId),
      workspaceId,
      directory: this,
      notificationIntents: this,
    };
  }

  /**
   * This workspace's database, addressed without leaving the object.
   *
   * The moved schedule code speaks `env.DB`, and routing that back through the
   * namespace would have the object call itself. The local executor runs the
   * same statements against its own storage instead.
   */
  private localWorkspaceEnv(workspaceId: string): Env {
    return withWorkspaceRuntimeDatabase(this.env, workspaceId, (statements) =>
      Promise.resolve(this.runWorkspaceSql(WorkspaceRuntimeSqlRequestSchema.parse({
        workspaceId,
        requestId: uuidV7(),
        statements,
      }))));
  }

  /**
   * Every write this object makes to its own product tables, from either
   * direction: the Worker's RPC port and the schedule work that runs inside the
   * alarm. Both go through here so neither can quietly stop pushing.
   *
   * That is not hypothetical. The schedule loop advancing an automation's
   * `next_run_at` after a run is the write with no request behind it, and it
   * reaches these tables through `localWorkspaceEnv` rather than the RPC —
   * exactly the writer a check on the RPC alone would miss.
   */
  private runWorkspaceSql(request: WorkspaceRuntimeSqlRequest): WorkspaceRuntimeSqlResult[] {
    const lists = new Set<SidebarList>();
    for (const statement of request.statements) {
      const typedOnlyTable = typedRpcOnlyWorkspaceTable(statement.sql);
      if (typedOnlyTable) {
        throw new Error(`workspace_runtime_table_requires_typed_rpc:${typedOnlyTable}`);
      }
      const target = workspaceMutationTarget(statement.sql);
      const list = target === null ? undefined : SIDEBAR_LIST_SOURCE_TABLES.get(target);
      if (list) lists.add(list);
    }
    // The counters advance inside the write's own transaction, so a version can
    // never describe rows that rolled back; the publish waits for the commit,
    // so a socket is never sent a list built from rows about to disappear.
    const results = executeWorkspaceRuntimeSql(this.state.storage, request, [...lists]);
    for (const list of lists) this.publishSidebarList(list);
    return results;
  }

  /**
   * Workspace-local product scheduler.
   *
   * SQLite decides what is due and fences each claim. The alarm only starts a
   * deterministic Workflow instance; inference and ranking never run in the
   * object's single-threaded request path. A dormant member deliberately leaves
   * a due request parked without another alarm. Their next authenticated read
   * schedules the object again, avoiding an idle per-workspace polling loop.
   */
  private async runProductAlarm(workspaceId: string): Promise<void> {
    const now = Date.now();
    const product = this.productStorage();
    product.reapCompletedOpportunityWindows(now - 30 * 24 * 60 * 60_000);
    product.reapSettledSuggestedWork(now);
    let launched = 0;

    for (const row of product.dueOpportunityWindows(now, PRODUCT_ALARM_BATCH)) {
      const claim = product.claimOpportunityWindow(row.window_id, now);
      if (!claim) continue;
      const input = WorkspaceOpportunityWorkflowInputSchema.parse({
        kind: "admission",
        region: this.env.AVALON_REGION,
        workspaceId,
        windowId: claim.windowId,
        leaseId: claim.leaseId,
        attempt: claim.attempt,
      });
      try {
        await this.env.WORK_OPPORTUNITY_WORKFLOW.create({
          id: `opportunity-admission-${claim.windowId}-${claim.attempt}`,
          params: input,
        });
      } catch (error) {
        if (!workflowAlreadyExists(error)) throw error;
      }
      launched += 1;
    }

    const dueRankings = product.dueRankingRows(now, PRODUCT_ALARM_BATCH);
    if (dueRankings.length > 0) {
      const ids = dueRankings.map((row) => row.user_id);
      const members = await this.env.DB.prepare(
        `SELECT user_id, last_seen_at FROM workspace_members
          WHERE workspace_id = ? AND status = 'active'
            AND user_id IN (SELECT value FROM json_each(?))`,
      ).bind(workspaceId, JSON.stringify(ids)).all<{ user_id: string; last_seen_at: string | null }>();
      const lastSeen = new Map(members.results.map((row) => [row.user_id, epoch(row.last_seen_at)]));
      const dormantCutoff = now - 7 * 24 * 60 * 60_000;
      const activeCutoff = now - 15 * 60_000;
      const starvedCutoff = now - 30 * 60_000;
      const eligible = dueRankings
        .filter((row) => (lastSeen.get(row.user_id) ?? 0) > dormantCutoff)
        .sort((left, right) => {
          const leftUrgent = (lastSeen.get(left.user_id) ?? 0) > activeCutoff || left.due_at <= starvedCutoff;
          const rightUrgent = (lastSeen.get(right.user_id) ?? 0) > activeCutoff || right.due_at <= starvedCutoff;
          return Number(rightUrgent) - Number(leftUrgent) || left.due_at - right.due_at;
        });
      for (const row of eligible.slice(0, Math.max(0, PRODUCT_ALARM_BATCH - launched))) {
        const claim = product.claimRanking(row.user_id, row.request_seq, now);
        if (!claim) continue;
        const input = WorkspaceOpportunityWorkflowInputSchema.parse({
          kind: "ranking",
          region: this.env.AVALON_REGION,
          workspaceId,
          userId: claim.userId,
          requestSeq: claim.requestSeq,
          leaseId: claim.leaseId,
        });
        try {
          await this.env.WORK_OPPORTUNITY_WORKFLOW.create({
            id: `opportunity-ranking-${workspaceId}-${claim.userId}-${claim.requestSeq}`,
            params: input,
          });
        } catch (error) {
          if (!workflowAlreadyExists(error)) throw error;
        }
        launched += 1;
      }
    }
    // Suppressed when nothing launched: what is left is parked behind a
    // dormant member, and re-arming for an instant already past is the one way
    // this object turns into a polling loop.
    await this.refreshProductAlarm({ suppressPastDue: launched === 0 });
  }

  /**
   * Record and fan out a workspace-owned surface change. This RPC is called by
   * authenticated HTTP mutations and regional background consumers only; the
   * socket itself never lets a desktop manufacture an invalidation.
   */
  async publishSync(
    topics: WorkspaceSyncTopic[],
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
  ): Promise<number> {
    await this.initialized;
    this.ensureIdentity(workspaceId, placementAffinity);
    const parsed = z.array(WorkspaceSyncTopicSchema).min(1).safeParse(topics);
    if (!parsed.success) throw new Error("invalid_workspace_sync_topics");
    const requested = new Set(parsed.data);
    const ordered = WORKSPACE_SYNC_TOPICS.filter((topic) => requested.has(topic));
    const occurredAtMs = Date.now();
    const occurredAt = new Date(occurredAtMs).toISOString();
    const eventId = uuidV7(occurredAtMs);
    const waterline = this.state.storage.transactionSync(() => {
      const row = this.state.storage.sql.exec<{ waterline: number }>(
        `INSERT INTO workspace_sync_events(event_id, topics_json, occurred_at)
         VALUES (?, ?, ?) RETURNING waterline`,
        eventId,
        JSON.stringify(ordered),
        occurredAtMs,
      ).one();
      this.state.storage.sql.exec(
        `DELETE FROM workspace_sync_events WHERE waterline <= ?`,
        row.waterline - 1_024,
      );
      return row.waterline;
    });
    const event = WorkspaceSocketSyncEventSchema.parse({
      type: "workspace_sync",
      eventId,
      waterline,
      occurredAt,
      topics: ordered,
      reason: "change",
    });
    const payload = JSON.stringify(event);
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      try {
        socket.send(payload);
        socket.serializeAttachment({ ...attachment, lastWaterline: waterline });
      } catch {
        // The hibernation runtime owns close cleanup. A reconnect receives a
        // full invalidation or replays the bounded SQL log.
      }
    }
    return waterline;
  }

  /**
   * Re-evaluate one product flag for every connected person and send the full
   * client contract privately to each socket. The Queue/RPC wake-up carries no
   * value: Flagship remains authoritative, and two members of this workspace
   * may match different targeting rules.
   */
  async notifyProductFeatureFlagChanged(
    flagKey: ProductFeatureFlagKey,
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
  ): Promise<number> {
    await this.initialized;
    this.ensureIdentity(workspaceId, placementAffinity);
    const changedFlag = ProductFeatureFlagKeySchema.parse(flagKey);
    const socketsByUser = new Map<string, WebSocket[]>();
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      socketsByUser.set(attachment.userId, [
        ...(socketsByUser.get(attachment.userId) ?? []),
        socket,
      ]);
    }
    let sent = 0;
    await Promise.all([...socketsByUser].map(async ([userId, sockets]) => {
      const payload = JSON.stringify(WorkspaceFeatureFlagsEventSchema.parse({
        type: "workspace_feature_flags",
        occurredAt: new Date().toISOString(),
        changedFlag,
        flags: await resolveClientFeatureFlagsForSubject(this.env, { userId, workspaceId }),
      }));
      for (const socket of sockets) {
        try {
          socket.send(payload);
          sent += 1;
        } catch {
          // Hibernation owns cleanup; a reconnect gets a fresh evaluation.
        }
      }
    }));
    return sent;
  }

  /**
   * Drop every socket this object holds for a person whose access ended, and
   * carry the same revocation to the work streams they could be reading.
   *
   * The only way a socket here is closed for lost access. Nothing in this
   * object can observe a revoked session or an ended membership — both are D1
   * facts owned by the Worker that wrote them — so it is told, once, by the
   * access-revocation consumer. See `docs/access-revocation.md`.
   *
   * The work streams come back as a list rather than being published from
   * here: this object holds sockets and a directory, and that is all it needs
   * to know. The consumer decides what to do with the list, so nothing about
   * the revocation transport reaches inside the object.
   */
  async revokeSocketAccess(revocation: SocketAccessRevocation): Promise<{ workstreamIds: string[] }> {
    await this.initialized;
    const request = SocketAccessRevocationSchema.parse(revocation);
    let closed = 0;
    let presenceChanged = false;
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      // A revoked session closes only the windows that presented it; an ended
      // membership carries no session and closes all of them. The rule lives in
      // one place because the four socket roles disagree about their own
      // attachments — see `revocationClosesSocket`.
      if (!attachment || !revocationClosesSocket(request, attachment)) continue;
      const wasPresent = contributesPresence(attachment);
      presenceChanged ||= wasPresent;
      if (wasPresent) {
        try {
          socket.serializeAttachment({
            ...attachment,
            applicationState: "background",
            foregroundWorkstreamId: null,
          } satisfies WorkspaceSocketAttachment);
        } catch {
          // `disconnect` still unsubscribes or closes the socket; a failed
          // attachment rewrite must not interrupt access revocation.
        }
      }
      disconnect(socket, WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE, "You can no longer access this workspace");
      closed += 1;
    }
    if (closed > 0) {
      if (presenceChanged) this.broadcastPresence();
      logWarn(this.env, "workspace_socket_access_revoked", {
        workspace_id: this.workspaceId(),
        user_id: request.userId,
        session_id: request.sessionId,
        sockets: closed,
      });
    }
    return { workstreamIds: this.revocableWorkstreamIds(request.userId) };
  }

  /**
   * The work streams this person could be holding a socket on.
   *
   * Their own rows, plus every workspace-scoped work stream — those are
   * readable by any member, so a socket can exist there without this object
   * ever having written a viewer row for them. Narrower than the directory and
   * still complete; a personal work stream they never joined cannot have
   * admitted them in the first place.
   */
  private revocableWorkstreamIds(userId: string): string[] {
    return this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT directory.workstream_id
         FROM workspace_workstream_directory directory
         LEFT JOIN workspace_workstream_viewers viewer
           ON viewer.workstream_id = directory.workstream_id AND viewer.user_id = ?
        WHERE viewer.user_id IS NOT NULL OR directory.scope = 'workspace'
        ORDER BY directory.workstream_id`,
      userId,
    ).toArray().map((row) => row.workstream_id);
  }

  /** Pin the workspace identity before any child object can be resolved. */
  async initializeWorkspace(
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
  ): Promise<void> {
    await this.initialized;
    this.ensureIdentity(workspaceId, placementAffinity);
  }

  /**
   * Accept one workspace-scoped connector event from the regional Queue.
   *
   * The ingress identifier names a delivery attempt. Provider identity and the
   * connector dedupe key choose the canonical event, so an at-least-once Queue
   * delivery or a provider replay cannot create a second durable record.
   */
  async ingestConnectorEvent(
    input: WorkspaceConnectorEventIngestRequest,
  ): Promise<WorkspaceConnectorEventIngestResult> {
    await this.initialized;
    const request = WorkspaceConnectorEventIngestRequestSchema.parse(input);
    if (!this.workspaceId()) {
      this.ensureIdentity(
        request.workspaceId,
        await workspacePlacementAffinity(this.env, request.workspaceId),
      );
    }
    this.assertWorkspace(request.workspaceId);
    const activity = request.event.activity;
    const result = WorkspaceConnectorEventIngestResultSchema.parse(
      this.state.storage.transactionSync(() => {
        const receipt = this.state.storage.sql.exec<{
          payload_hash: string;
          connector_event_id: string;
          processing_status: WorkspaceConnectorEventRow["processing_status"];
          processing_attempt: number;
        }>(
          `SELECT receipt.payload_hash, receipt.connector_event_id, event.processing_status,
                  event.processing_attempt
             FROM workspace_connector_event_ingress_receipts receipt
             JOIN workspace_connector_events event ON event.event_id = receipt.connector_event_id
            WHERE receipt.ingress_event_id = ?`,
          request.ingressEventId,
        ).toArray()[0];
        if (receipt) {
          if (receipt.payload_hash !== request.payloadHash) {
            throw new Error("connector_event_ingress_idempotency_conflict");
          }
          return {
            eventId: receipt.connector_event_id,
            duplicate: true,
            processingStatus: receipt.processing_status,
            processingAttempt: receipt.processing_attempt,
          };
        }

        const byProvider = this.state.storage.sql.exec<WorkspaceConnectorEventRow>(
          `SELECT * FROM workspace_connector_events
            WHERE connection_id = ? AND provider_event_id = ? AND event_type = ?`,
          activity.connectionId,
          activity.providerEventId,
          activity.eventType,
        ).toArray()[0];
        const byDedupe = this.state.storage.sql.exec<WorkspaceConnectorEventRow>(
          `SELECT * FROM workspace_connector_events
            WHERE connection_id = ? AND dedupe_key = ?`,
          activity.connectionId,
          activity.dedupeKey,
        ).toArray()[0];
        if (byProvider && byDedupe && byProvider.event_id !== byDedupe.event_id) {
          throw new Error("connector_event_identity_collision");
        }
        const canonical = byProvider ?? byDedupe;
        if (canonical && canonical.payload_hash !== request.payloadHash) {
          throw new Error("connector_event_identity_reused_with_different_content");
        }

        const now = Date.now();
        let eventId = canonical?.event_id ?? activity.id;
        let processingStatus = canonical?.processing_status ?? "pending";
        if (!canonical) {
          this.state.storage.sql.exec(
            `INSERT INTO workspace_connector_events (
              event_id, payload_hash, connection_id, connection_scope,
              connection_owner_user_id, connector_type, provider,
              provider_event_id, event_type, resource_type, provider_resource_id,
              actor_json, subject_json, occurred_at, received_at, title, summary,
              text_snippet, payload_ref, visibility_json, target_user_ids_json,
              entity_keys_json, dedupe_key, raw_content_hash, metadata_json,
              external_people_json, processing_status, workflow_instance_id,
              processing_attempt, claimed_at, processed_at, processing_error, created_at, updated_at
            ) VALUES (
              ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?, ?, 'pending', NULL, -1, NULL, NULL, NULL, ?, ?
            )`,
            activity.id,
            request.payloadHash,
            activity.connectionId,
            activity.connectionScope,
            activity.connectionOwnerUserId,
            request.event.connectorType,
            activity.provider,
            activity.providerEventId,
            activity.eventType,
            activity.resourceType,
            activity.providerResourceId,
            JSON.stringify(activity.actor),
            JSON.stringify(activity.subject),
            Date.parse(activity.occurredAt),
            Date.parse(activity.receivedAt),
            activity.title,
            activity.summary,
            activity.textSnippet,
            activity.payloadRef,
            JSON.stringify(activity.visibility),
            JSON.stringify(activity.targetUserIds),
            JSON.stringify(activity.entityKeys),
            activity.dedupeKey,
            activity.rawContentHash,
            JSON.stringify(activity.metadata),
            JSON.stringify(activity.externalPeople ?? []),
            now,
            now,
          );
          eventId = activity.id;
          processingStatus = "pending";
        }
        this.state.storage.sql.exec(
          `INSERT INTO workspace_connector_event_ingress_receipts
             (ingress_event_id, payload_hash, connector_event_id, received_at)
           VALUES (?, ?, ?, ?)`,
          request.ingressEventId,
          request.payloadHash,
          eventId,
          now,
        );
        this.state.storage.sql.exec(
          `DELETE FROM workspace_connector_event_ingress_receipts
            WHERE ingress_event_id IN (
              SELECT ingress_event_id FROM workspace_connector_event_ingress_receipts
               WHERE received_at < ?
               ORDER BY received_at, ingress_event_id LIMIT 100
            )`,
          now - CONNECTOR_EVENT_INGRESS_RECEIPT_RETENTION_MS,
        );
        // Processed event bodies are the highest-volume rows in the object,
        // and the only unbounded ones absent this reap. Thirteen months —
        // matching the longest regional retention anywhere in Avalon — dwarfs
        // every consumer's reach-back (opportunity evidence expires in weeks
        // and start snapshots copy what they need), so this is a size fence,
        // not a semantics change. Pending/failed rows never age out.
        this.state.storage.sql.exec(
          `DELETE FROM workspace_connector_events
            WHERE event_id IN (
              SELECT event_id FROM workspace_connector_events
               WHERE processing_status = 'processed' AND received_at < ?
               ORDER BY received_at, event_sequence LIMIT 50
            )`,
          now - CONNECTOR_EVENT_BODY_RETENTION_MS,
        );
        return {
          eventId,
          duplicate: Boolean(canonical),
          processingStatus,
          processingAttempt: canonical?.processing_attempt ?? -1,
        };
      }),
    );
    logInfo(this.env, "connector_event_authority_ingested", {
      workspace_id: request.workspaceId,
      connection_id: activity.connectionId,
      connector_type: request.event.connectorType,
      provider: activity.provider,
      ingress_event_id: request.ingressEventId,
      connector_event_id: result.eventId,
      duplicate: result.duplicate,
      processing_status: result.processingStatus,
      processing_attempt: result.processingAttempt,
      outcome: "committed",
    });
    return result;
  }

  async connectorEvent(input: WorkspaceConnectorEventRequest): Promise<WorkspaceConnectorEvent | null> {
    await this.initialized;
    const request = WorkspaceConnectorEventRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<WorkspaceConnectorEventRow>(
      `SELECT * FROM workspace_connector_events WHERE event_id = ?`,
      request.eventId,
    ).toArray()[0];
    return row ? connectorEventFromRow(row, request.workspaceId, this.env.AVALON_REGION) : null;
  }

  async claimConnectorEvent(
    input: WorkspaceConnectorEventClaimRpcRequest,
  ): Promise<WorkspaceConnectorEventClaimRpcResult> {
    await this.initialized;
    const rpcRequest = WorkspaceConnectorEventClaimRpcRequestSchema.parse(input);
    const legacyWorkflowContract = "workflowInstanceId" in rpcRequest;
    const request: WorkspaceConnectorEventClaimRequest = legacyWorkflowContract
      ? {
          workspaceId: rpcRequest.workspaceId,
          eventId: rpcRequest.eventId,
          processingOwnerId: rpcRequest.workflowInstanceId,
          attempt: rpcRequest.attempt,
          orchestrator: "workflow",
        }
      : WorkspaceConnectorEventClaimRequestSchema.parse(rpcRequest);
    this.assertWorkspace(request.workspaceId);
    const result = WorkspaceConnectorEventClaimResultSchema.parse(
      this.state.storage.transactionSync(() => {
        const row = this.state.storage.sql.exec<WorkspaceConnectorEventRow>(
          `SELECT * FROM workspace_connector_events WHERE event_id = ?`,
          request.eventId,
        ).toArray()[0];
        if (!row) throw new Error("connector_event_not_found");
        if (row.processing_status === "processed") return { outcome: "processed" as const };
        const now = Date.now();
        // A pre-cutover Workflow may replay its claim step after WorkspaceDO
        // committed the claim but before Workflows persisted the step result.
        // Reissuing that exact Workflow lease is idempotent. Queue owners are
        // only correlation IDs, so Queue replays must never use this exception.
        const sameLegacyWorkflowLease = request.orchestrator === "workflow"
          && row.processing_status === "processing"
          && (row.processing_orchestrator ?? "workflow") === "workflow"
          && row.workflow_instance_id === request.processingOwnerId;
        if (row.processing_status === "processing" && !sameLegacyWorkflowLease) {
          // A pre-v12 active claim has no discriminator because only Workflows
          // could create it. Workflow step timeouts apply per retry attempt, so
          // no finite Queue lease can safely prove that handler has stopped.
          // Its own terminal path either completes or enqueues a failed redrive.
          if ((row.processing_orchestrator ?? "workflow") === "workflow") {
            return {
              outcome: "busy" as const,
              reason: "legacy_workflow_active" as const,
              retryAt: null,
            };
          }
          const claimedAt = typeof row.claimed_at === "number" ? row.claimed_at : now;
          const retryAt = claimedAt + CONNECTOR_EVENT_PROCESSING_LEASE_MS;
          if (retryAt > now) {
            return {
              outcome: "busy" as const,
              reason: "active_lease_not_expired" as const,
              retryAt,
            };
          }
        }
        if (
          (row.processing_status === "processing" || row.processing_status === "failed")
          && request.attempt < row.processing_attempt
        ) {
          return {
            outcome: "busy" as const,
            reason: "failed_attempt_not_advanced" as const,
            retryAt: null,
          };
        }
        // `workflow_instance_id` is the compatibility-era physical column. A
        // Workflow's instance ID remains its lease; Queue claims receive a new
        // authority-generated UUID on every acquisition. Settlement fences on
        // this value, so an expired handler cannot settle its successor's work.
        const processingLeaseId = request.orchestrator === "workflow"
          ? request.processingOwnerId
          : uuidV7(now);
        const processingLeaseExpiresAt = request.orchestrator === "workflow"
          ? null
          : now + CONNECTOR_EVENT_PROCESSING_LEASE_MS;
        this.state.storage.sql.exec(
          `UPDATE workspace_connector_events
              SET processing_status = 'processing', workflow_instance_id = ?,
                  processing_orchestrator = ?, processing_attempt = ?, claimed_at = ?,
                  processing_error = NULL, updated_at = ?
            WHERE event_id = ?`,
          processingLeaseId,
          request.orchestrator,
          request.attempt,
          now,
          now,
          request.eventId,
        );
        return {
          outcome: "claimed" as const,
          event: connectorEventFromRow(row, request.workspaceId, this.env.AVALON_REGION),
          processingLeaseId,
          processingLeaseExpiresAt,
        };
      }),
    );
    logInfo(this.env, "connector_event_authority_claimed", {
      workspace_id: request.workspaceId,
      connector_event_id: request.eventId,
      processing_owner_id: request.processingOwnerId,
      processing_attempt: request.attempt,
      processing_orchestrator: request.orchestrator,
      processing_rpc_contract: legacyWorkflowContract ? "legacy_workflow" : "current",
      processing_lease_id: result.outcome === "claimed" ? result.processingLeaseId : null,
      processing_lease_expires_at: result.outcome === "claimed"
        ? result.processingLeaseExpiresAt
        : result.outcome === "busy"
          ? result.retryAt
          : null,
      outcome: result.outcome,
      reason: result.outcome === "busy" ? result.reason : null,
    });
    if (!legacyWorkflowContract) return result;
    return LegacyWorkspaceConnectorEventClaimResultSchema.parse(
      result.outcome === "claimed"
        ? { outcome: "claimed", event: result.event }
        : { outcome: result.outcome },
    );
  }

  async settleConnectorEvent(input: WorkspaceConnectorEventSettleRpcRequest): Promise<void> {
    await this.initialized;
    const rpcRequest = WorkspaceConnectorEventSettleRpcRequestSchema.parse(input);
    const legacyWorkflowContract = "workflowInstanceId" in rpcRequest;
    const request: WorkspaceConnectorEventSettleRequest = legacyWorkflowContract
      ? {
          workspaceId: rpcRequest.workspaceId,
          eventId: rpcRequest.eventId,
          processingOwnerId: rpcRequest.workflowInstanceId,
          outcome: rpcRequest.outcome,
          error: rpcRequest.error,
        }
      : rpcRequest;
    this.assertWorkspace(request.workspaceId);
    // A persisted pre-cutover Workflow claim has no separate lease in its step
    // result; its instance ID is exactly the value stored in the physical lease
    // column, so this fallback is both narrow and replay-compatible.
    const processingLeaseId = request.processingLeaseId ?? request.processingOwnerId;
    const now = Date.now();
    const changed = this.state.storage.sql.exec<{ event_id: string }>(
      `UPDATE workspace_connector_events
          SET processing_status = ?, processed_at = CASE WHEN ? = 'processed' THEN ? ELSE NULL END,
              processing_error = ?, updated_at = ?
        WHERE event_id = ? AND workflow_instance_id = ? AND processing_status = 'processing'
        RETURNING event_id`,
      request.outcome,
      request.outcome,
      now,
      request.error,
      now,
      request.eventId,
      processingLeaseId,
    ).toArray().length;
    if (changed === 1) {
      logInfo(this.env, "connector_event_authority_terminal", {
        workspace_id: request.workspaceId,
        connector_event_id: request.eventId,
        processing_owner_id: request.processingOwnerId,
        processing_lease_id: processingLeaseId,
        processing_rpc_contract: legacyWorkflowContract ? "legacy_workflow" : "current",
        outcome: request.outcome,
        reason: "settlement_committed",
      });
      return;
    }
    const settled = this.state.storage.sql.exec<{
      processing_status: WorkspaceConnectorEventRow["processing_status"];
      workflow_instance_id: string | null;
    }>(
      `SELECT processing_status, workflow_instance_id
         FROM workspace_connector_events WHERE event_id = ?`,
      request.eventId,
    ).toArray()[0];
    if (
      settled?.workflow_instance_id === processingLeaseId
      && settled.processing_status === request.outcome
    ) {
      logInfo(this.env, "connector_event_authority_terminal", {
        workspace_id: request.workspaceId,
        connector_event_id: request.eventId,
        processing_owner_id: request.processingOwnerId,
        processing_lease_id: processingLeaseId,
        processing_rpc_contract: legacyWorkflowContract ? "legacy_workflow" : "current",
        outcome: request.outcome,
        reason: "settlement_replayed",
      });
      return;
    }
    logWarn(this.env, "connector_event_authority_settlement_failed", {
      workspace_id: request.workspaceId,
      connector_event_id: request.eventId,
      processing_owner_id: request.processingOwnerId,
      processing_lease_id: processingLeaseId,
      processing_rpc_contract: legacyWorkflowContract ? "legacy_workflow" : "current",
      requested_outcome: request.outcome,
      authoritative_outcome: settled?.processing_status ?? "missing",
      authoritative_processing_owner_id: settled?.workflow_instance_id ?? null,
      reason: "settlement_fenced",
    });
    throw new Error("connector_event_settlement_fenced");
  }

  /** Append one first-party activity-log event and all of its target edges atomically. */
  async recordActivityEvent(input: WorkspaceActivityEventInput): Promise<string> {
    await this.initialized;
    const request = WorkspaceActivityEventInputSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const now = Date.now();
    const proposedId = request.eventId ?? uuidV7(now);
    const eventId = this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `INSERT OR IGNORE INTO workspace_activity_events (
          event_id, event_type, subject_type, subject_id, subject_sequence_number,
          actor_type, actor_user_id, actor_label, title, body, canonical_url,
          audience_kind, audience_user_id, audience_workstream_id, digestible,
          occurred_at, created_at, source_kind, source_id, dedupe_key, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        proposedId,
        request.eventType,
        request.subjectType,
        request.subjectId,
        request.subjectSequenceNumber ?? null,
        request.actorType,
        request.actorUserId ?? null,
        request.actorLabel,
        request.title,
        request.body ?? "",
        request.canonicalUrl ?? null,
        request.audience.kind,
        request.audience.kind === "user" ? request.audience.userId : null,
        request.audience.kind === "workstream" ? request.audience.workstreamId : null,
        request.digestible ? 1 : 0,
        epoch(request.occurredAt),
        now,
        request.sourceKind,
        request.sourceId ?? null,
        request.dedupeKey,
        JSON.stringify(request.metadata ?? {}),
      );
      const canonical = this.state.storage.sql.exec<{ event_id: string }>(
        `SELECT event_id FROM workspace_activity_events WHERE dedupe_key = ?`,
        request.dedupeKey,
      ).one().event_id;
      for (const target of request.targets ?? []) {
        this.state.storage.sql.exec(
          `INSERT OR IGNORE INTO workspace_activity_event_targets
             (event_id, user_id, relation, created_at) VALUES (?, ?, ?, ?)`,
          canonical,
          target.userId,
          target.relation,
          now,
        );
      }
      return canonical;
    });
    await this.refreshProductAlarm();
    return eventId;
  }

  /** Read one active member's visibility-filtered, insertion-ordered activity window. */
  async listActivityEvents(
    input: WorkspaceActivityEventListRequest,
  ): Promise<WorkspaceActivityEventListResult> {
    await this.initialized;
    const request = WorkspaceActivityEventListRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const member = await this.env.DB.prepare(
      `SELECT 1 FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
    ).bind(request.workspaceId, request.userId).first();
    if (!member) return { items: [] };
    const rows = this.state.storage.sql.exec<{
      event_sequence: number;
      event_id: string;
      event_type: string;
      subject_type: string;
      subject_id: string | null;
      subject_sequence_number: number | null;
      actor_type: string;
      actor_user_id: string | null;
      actor_label: string;
      title: string;
      body: string;
      canonical_url: string | null;
      occurred_at: number;
      created_at: number;
      metadata_json: string;
      is_target: number;
      target_relations: string | null;
    }>(
      `SELECT event.event_sequence, event.event_id, event.event_type,
              event.subject_type, event.subject_id, event.subject_sequence_number,
              event.actor_type, event.actor_user_id, event.actor_label,
              event.title, event.body, event.canonical_url, event.occurred_at,
              event.created_at, event.metadata_json,
              CASE WHEN target.user_id IS NULL THEN 0 ELSE 1 END AS is_target,
              target.relations AS target_relations
         FROM workspace_activity_events event
         LEFT JOIN (
           SELECT event_id, user_id, group_concat(relation) AS relations
             FROM workspace_activity_event_targets
            WHERE user_id = ? GROUP BY event_id, user_id
         ) target ON target.event_id = event.event_id
        WHERE (? IS NULL OR event.event_sequence > ?)
          AND event.event_sequence <= ?
          AND (? IS NULL OR event.created_at >= ?)
          AND (? = 0 OR event.digestible = 1)
          AND (
            event.audience_kind = 'workspace'
            OR (event.audience_kind = 'user' AND event.audience_user_id = ?)
            OR (event.audience_kind = 'workstream' AND EXISTS (
              SELECT 1 FROM workspace_workstream_directory directory
              JOIN workspace_workstream_viewers viewer
                ON viewer.workstream_id = directory.workstream_id
               AND viewer.authority_generation = directory.authority_generation
               AND viewer.user_id = ?
             WHERE directory.workstream_id = event.audience_workstream_id
               AND directory.archived_at IS NULL AND directory.system_kind IS NULL
               AND viewer.is_participant = 1
            ))
          )
        ORDER BY event.event_sequence LIMIT ?`,
      request.userId,
      request.from ?? null,
      request.from ?? null,
      request.through,
      epoch(request.notBefore ?? null),
      epoch(request.notBefore ?? null),
      request.digestibleOnly ? 1 : 0,
      request.userId,
      request.userId,
      request.limit,
    ).toArray();
    return WorkspaceActivityEventListResultSchema.parse({
      items: rows.map((row) => ({
        sequence: Number(row.event_sequence),
        id: row.event_id,
        eventType: row.event_type,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        subjectSequenceNumber: row.subject_sequence_number,
        actorType: row.actor_type,
        actorUserId: row.actor_user_id,
        actorLabel: row.actor_label,
        title: row.title,
        body: row.body,
        canonicalUrl: row.canonical_url,
        occurredAt: iso(row.occurred_at),
        createdAt: iso(row.created_at),
        metadata: JSON.parse(row.metadata_json) as unknown,
        isTarget: row.is_target === 1,
        targetRelations: row.target_relations?.split(",").filter(Boolean) ?? [],
      })),
    });
  }

  async latestActivityEventCursor(input: WorkspaceActivityEventCursorRequest): Promise<number> {
    await this.initialized;
    const request = WorkspaceActivityEventCursorRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return Number(this.state.storage.sql.exec<{ sequence: number | null }>(
      `SELECT MAX(event_sequence) AS sequence FROM workspace_activity_events`,
    ).one().sequence ?? 0);
  }

  async activityEventSource(input: WorkspaceActivityEventSourceRequest) {
    await this.initialized;
    const request = WorkspaceActivityEventSourceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{
      event_id: string;
      source_id: string;
      title: string;
      body: string;
      actor_user_id: string | null;
      actor_label: string;
      audience_workstream_id: string | null;
      occurred_at: number;
    }>(
      `SELECT event_id, source_id, title, body, actor_user_id, actor_label,
              audience_workstream_id, occurred_at
         FROM workspace_activity_events
        WHERE source_kind = ? AND source_id = ? LIMIT 1`,
      request.sourceKind,
      request.sourceId,
    ).toArray()[0];
    return row ? WorkspaceActivityEventSourceSchema.parse({
      id: row.event_id,
      sourceId: row.source_id,
      title: row.title,
      body: row.body,
      actorUserId: row.actor_user_id,
      actorLabel: row.actor_label,
      audienceWorkstreamId: row.audience_workstream_id,
      occurredAt: iso(row.occurred_at),
    }) : null;
  }

  async enqueueOpportunitySource(input: WorkspaceOpportunityEnqueueRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityEnqueueRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = WorkspaceOpportunityEnqueueResultSchema.parse(
      this.productStorage().enqueueOpportunitySource(request),
    );
    await this.refreshProductAlarm();
    return result;
  }

  async opportunityWindow(input: WorkspaceOpportunityWindowRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityWindowRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return WorkspaceOpportunityWindowSchema.parse(this.productStorage().opportunityWindow(request));
  }

  async mutateOpportunityBatchEvents(input: WorkspaceOpportunityBatchEventsRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceOpportunityBatchEventsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    this.productStorage().mutateOpportunityBatchEvents(request);
  }

  async settleOpportunityWindow(input: WorkspaceOpportunityWindowSettleRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceOpportunityWindowSettleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    this.productStorage().settleOpportunityWindow(request);
    await this.refreshProductAlarm();
  }

  async existingOpportunities(input: WorkspaceOpportunityExistingRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityExistingRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.productStorage().existingOpportunities(request);
  }

  async persistOpportunity(input: WorkspaceOpportunityPersistRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityPersistRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = WorkspaceOpportunityPersistResultSchema.parse(
      this.productStorage().persistOpportunity(request),
    );
    await this.refreshProductAlarm();
    return result;
  }

  async markOpportunityRankingDue(
    workspaceId: string,
    userIds: string[],
    delayMs: number,
    clearFingerprint = false,
  ): Promise<void> {
    await this.initialized;
    this.assertWorkspace(IdSchema.parse(workspaceId));
    const ids = z.array(IdSchema).max(10_000).parse([...new Set(userIds)]);
    const delay = z.number().int().min(0).max(24 * 60 * 60_000).parse(delayMs);
    const now = Date.now();
    for (const userId of ids) {
      this.productStorage().markRankingDue(userId, now + delay, now, clearFingerprint);
    }
    await this.refreshProductAlarm();
  }

  async markWorkspaceOpportunityRankingDue(workspaceId: string, delayMs: number): Promise<void> {
    await this.initialized;
    this.assertWorkspace(IdSchema.parse(workspaceId));
    const members = await this.env.DB.prepare(
      `SELECT user_id FROM workspace_members WHERE workspace_id = ? AND status = 'active'`,
    ).bind(workspaceId).all<{ user_id: string }>();
    await this.markOpportunityRankingDue(
      workspaceId,
      members.results.map((row) => row.user_id),
      delayMs,
    );
  }

  async opportunityRankingCandidates(input: WorkspaceOpportunityRankingCandidatesRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityRankingCandidatesRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.productStorage().rankingCandidates(request);
  }

  async opportunityRankingState(workspaceId: string, userId: string) {
    await this.initialized;
    this.assertWorkspace(IdSchema.parse(workspaceId));
    return WorkspaceOpportunityRankingStateSchema.parse(
      this.productStorage().rankingState(IdSchema.parse(userId)),
    );
  }

  async recordOpportunityRankingRound(input: WorkspaceOpportunityRankingRoundRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceOpportunityRankingRoundRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    this.productStorage().recordRankingRound(request);
  }

  async storeOpportunityRanking(input: WorkspaceOpportunityStoreRankingRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceOpportunityStoreRankingRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    this.productStorage().storeRanking(request);
  }

  async settleOpportunityRanking(input: WorkspaceOpportunityRankingSettleRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceOpportunityRankingSettleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    this.productStorage().settleRanking(request);
    await this.refreshProductAlarm();
  }

  async listOpportunities(input: WorkspaceOpportunityListRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityListRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = WorkspaceOpportunityListResultSchema.parse(
      this.productStorage().listOpportunities(request),
    );
    await this.refreshProductAlarm();
    return result;
  }

  async recordOpportunityImpressions(input: WorkspaceOpportunityImpressionsRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityImpressionsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = this.productStorage().recordImpressions(request);
    const contexts = WorkspaceOpportunityTelemetryContextsSchema.safeParse(result.telemetryContexts);
    if (result.telemetryContextReadFailed || !contexts.success) {
      logWarn(this.env, "workspace_opportunity_telemetry_context_failed", {
        workspace_id: request.workspaceId,
        operation: "impression",
      });
    }
    await this.refreshProductAlarm();
    return contexts.success ? contexts.data : [];
  }

  async dismissOpportunity(input: WorkspaceOpportunityDismissRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityDismissRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = this.productStorage().dismissOpportunity(request);
    const parsed = WorkspaceOpportunityDismissResultSchema.safeParse({
      dismissed: result.dismissed,
      telemetryContext: result.telemetryContext,
    });
    if (result.telemetryContextReadFailed || !parsed.success) {
      logWarn(this.env, "workspace_opportunity_telemetry_context_failed", {
        workspace_id: request.workspaceId,
        operation: "dismiss",
      });
    }
    await this.refreshProductAlarm();
    return parsed.success
      ? parsed.data
      : { dismissed: result.dismissed, telemetryContext: null };
  }

  async getOpportunity(input: WorkspaceOpportunityGetRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityGetRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.productStorage().getOpportunity(request);
  }

  async opportunityOriginEvents(
    input: WorkspaceOpportunityOriginEventsRequest,
  ): Promise<WorkspaceConnectorEvent[]> {
    await this.initialized;
    const request = WorkspaceOpportunityOriginEventsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const sourceIds = this.productStorage().opportunityActivitySourceIds(request);
    const events = sourceIds.flatMap((eventId) => {
      const row = this.state.storage.sql.exec<WorkspaceConnectorEventRow>(
        `SELECT * FROM workspace_connector_events WHERE event_id = ?`,
        eventId,
      ).toArray()[0];
      return row
        ? [connectorEventFromRow(row, request.workspaceId, this.env.AVALON_REGION)]
        : [];
    });
    return WorkspaceOpportunityOriginEventsResultSchema.parse(events);
  }

  async claimOpportunityStart(input: WorkspaceOpportunityClaimStartRequest) {
    await this.initialized;
    const request = WorkspaceOpportunityClaimStartRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = this.productStorage().claimOpportunityStart(request);
    const context = WorkspaceOpportunityTelemetryContextSchema.nullable().safeParse(result.telemetryContext);
    if (result.telemetryContextReadFailed || !context.success) {
      logWarn(this.env, "workspace_opportunity_telemetry_context_failed", {
        workspace_id: request.workspaceId,
        operation: "start",
      });
    }
    return {
      outcome: result.outcome,
      opportunity: result.opportunity,
      telemetryContext: context.success ? context.data : null,
    };
  }

  async releaseOpportunityStart(input: WorkspaceOpportunityClaimStartRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceOpportunityReleaseStartRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    this.productStorage().releaseOpportunityStart(request);
  }

  async completeOpportunityStart(input: WorkspaceOpportunityCompleteStartRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceOpportunityCompleteStartRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    this.productStorage().completeOpportunityStart(request);
    await this.refreshProductAlarm();
  }


  /** Commit WorkstreamDO-owned facts into the workspace's authoritative directory. */
  async applyWorkstreamDirectoryEffects(
    input: WorkspaceDirectoryApplyRequest,
  ): Promise<WorkspaceDirectoryApplyResult> {
    await this.initialized;
    const request = WorkspaceDirectoryApplyRequestSchema.parse(input);
    if (!this.workspaceId()) {
      this.ensureIdentity(
        request.workspaceId,
        await workspacePlacementAffinity(this.env, request.workspaceId),
      );
    }
    this.assertWorkspace(request.workspaceId);
    const userIds = [...new Set(request.envelopes.flatMap((envelope) => (
      envelope.effect.kind === "directory_user" ? [envelope.effect.userId] : []
    )))];
    const activeUsers = new Set<string>();
    if (userIds.length > 0) {
      const placeholders = userIds.map(() => "?").join(",");
      const members = await this.env.DB.prepare(
        `SELECT user_id FROM workspace_members
          WHERE workspace_id = ? AND status = 'active' AND user_id IN (${placeholders})`,
      ).bind(request.workspaceId, ...userIds).all<{ user_id: string }>();
      for (const member of members.results ?? []) activeUsers.add(member.user_id);
    }
    const subscriptionIds = [...new Set(request.envelopes.flatMap((envelope) => (
      envelope.effect.kind === "directory_common" && envelope.effect.automationSubscriptionId
        ? [envelope.effect.automationSubscriptionId]
        : []
    )))];
    const originLabels = new Map<string, string>();
    if (subscriptionIds.length > 0) {
      const placeholders = subscriptionIds.map(() => "?").join(",");
      const labels = this.state.storage.sql.exec<{ id: string; name: string }>(
        `SELECT subscription.id, template.name
           FROM automation_subscriptions subscription
           JOIN automation_templates template ON template.id = subscription.template_id
          WHERE subscription.workspace_id = ? AND subscription.id IN (${placeholders})`,
        request.workspaceId,
        ...subscriptionIds,
      ).toArray();
      for (const label of labels) {
        originLabels.set(label.id, truncateUtf16Safe(label.name, 120));
      }
    }
    let directoryChanged = false;
    const commonChanges = new Set<string>();
    const viewerChanges = new Map<string, Set<string>>();
    const accepted: WorkspaceDirectoryApplyResult["accepted"] = [];
    for (const envelope of request.envelopes) {
      const changed = this.applyDirectoryEnvelope(envelope, activeUsers, originLabels);
      directoryChanged = directoryChanged || changed;
      if (changed && envelope.effect.kind === "directory_common") {
        commonChanges.add(envelope.workstreamId);
      } else if (changed && envelope.effect.kind === "directory_user") {
        const users = viewerChanges.get(envelope.workstreamId) ?? new Set<string>();
        users.add(envelope.effect.userId);
        viewerChanges.set(envelope.workstreamId, users);
      }
      accepted.push({ messageId: envelope.messageId, payloadHash: envelope.payloadHash });
    }
    if (commonChanges.size > 0) {
      // A `directory_common` effect is the only writer of
      // `next_terminal_action_at`, and it arrives outside any alarm — off the
      // Queue — so a sandbox deadline created or moved here would otherwise
      // wait for an unrelated target to reconcile before anything armed it.
      await this.refreshTerminalSchedule();
    }
    if (directoryChanged) {
      // Scope, participant, generation, and archival effects can invalidate a
      // foreground attachment without another client focus event. Rebuild now,
      // before the async state publications yield, so removed viewers neither
      // contribute to nor receive the next presence snapshot.
      this.broadcastPresence();
      await Promise.all([
        ...commonChanges,
      ].map((workstreamId) => this.publishWorkstreamState(workstreamId)));
      await Promise.all([...viewerChanges].flatMap(([workstreamId, users]) => (
        commonChanges.has(workstreamId)
          ? []
          : [...users].map((userId) => this.publishWorkstreamState(workstreamId, userId))
      )));
    }
    return WorkspaceDirectoryApplyResultSchema.parse({ accepted, directoryChanged });
  }

  /**
   * Apply one WorkstreamDO activity/mention effect and its replay receipt in a
   * single transaction. The caller resolves current D1 identity (actor, target
   * membership, mention recipient) before the call; the object never reaches
   * back into the regional database mid-transaction, and the receipt can never
   * commit without the product row it acknowledges.
   */
  async applyWorkstreamRegionalEffect(
    input: WorkspaceRegionalEffectApplyRequest,
  ): Promise<WorkspaceRegionalEffectApplyResult> {
    await this.initialized;
    const request = WorkspaceRegionalEffectApplyRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = applyWorkstreamRegionalEnvelope(this.state.storage, request, Date.now());
    if (!result.replayed && request.envelope.effect.kind === "activity_event") {
      await this.refreshProductAlarm();
    }
    return WorkspaceRegionalEffectApplyResultSchema.parse(result);
  }

  /** Claim one notification intent without exposing SQL or physical write counters. */
  async claimWorkstreamNotificationIntent(
    input: WorkspaceNotificationIntentRequest,
  ): Promise<WorkspaceNotificationIntentClaimResult> {
    await this.initialized;
    const request = WorkspaceNotificationIntentRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = WorkspaceNotificationIntentClaimResultSchema.parse(
      claimStoredWorkspaceNotificationIntent(
        this.state.storage,
        request,
        uuidV7(),
        Date.now(),
      ),
    );
    logInfo(this.env, "workstream_notification_intent_claim", {
      workspace_id: request.workspaceId,
      notification_intent_id: request.intentId,
      workstream_id: result.outcome === "missing" ? null : result.intent.workstreamId,
      recipient_user_id: result.outcome === "missing" ? null : result.intent.recipientUserId,
      kind: result.outcome === "missing" ? null : result.intent.notificationKind,
      state: result.outcome === "missing" ? null : result.intent.state,
      lease_id: result.outcome === "claimed" ? result.leaseId : null,
      outcome: result.outcome,
    });
    // A terminal replay can mean the earlier settle committed and its
    // post-commit schedule refresh failed. Reconcile here so that failure
    // cannot strand the terminal receipt past its retention window.
    if (result.outcome === "terminal") await this.refreshSchedule(request.workspaceId);
    return result;
  }

  /** Apply one lease-fenced notification lifecycle transition. */
  async transitionWorkstreamNotificationIntent(
    input: WorkspaceNotificationIntentTransitionRequest,
  ): Promise<WorkspaceNotificationIntentTransitionResult> {
    await this.initialized;
    const request = WorkspaceNotificationIntentTransitionRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = WorkspaceNotificationIntentTransitionResultSchema.parse(
      transitionStoredWorkspaceNotificationIntent(this.state.storage, request, Date.now()),
    );
    logInfo(this.env, "workstream_notification_intent_transition", {
      workspace_id: request.workspaceId,
      notification_intent_id: request.intentId,
      lease_id: request.leaseId,
      transition: request.transition,
      requested_state: request.transition === "settle" ? request.state : null,
      error_code: request.transition === "settle" ? null : request.errorCode,
      current_state: result.outcome === "lease_lost" ? result.state : null,
      outcome: result.outcome,
    });
    if (
      request.transition === "settle"
      && (result.outcome === "applied"
        || (result.outcome === "lease_lost"
          && (result.state === "delivered" || result.state === "skipped")))
    ) {
      await this.refreshSchedule(request.workspaceId);
    }
    return result;
  }

  /** Derive the retention alarm target from terminal notification receipts. */
  async notificationIntentMaintenanceTarget(
    input: WorkspaceNotificationIntentMaintenanceRequest,
  ): Promise<WorkspaceNotificationIntentMaintenanceTarget> {
    await this.initialized;
    const request = WorkspaceNotificationIntentMaintenanceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return WorkspaceNotificationIntentMaintenanceTargetSchema.parse(
      storedWorkspaceNotificationIntentMaintenanceTarget(this.state.storage, request.workspaceId),
    );
  }

  /** Reap terminal notification receipts and return exact deleted identities. */
  async reapSettledWorkstreamNotificationIntents(
    input: WorkspaceNotificationIntentReapRequest,
  ): Promise<WorkspaceNotificationIntentReapResult> {
    await this.initialized;
    const request = WorkspaceNotificationIntentReapRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = WorkspaceNotificationIntentReapResultSchema.parse(
      reapStoredWorkspaceNotificationIntents(this.state.storage, request, Date.now()),
    );
    logInfo(this.env, "workstream_notification_intent_reap", {
      workspace_id: request.workspaceId,
      reaped_intent_ids: result.reapedIntentIds,
      reaped_count: result.reapedIntentIds.length,
      outcome: result.reapedIntentIds.length > 0 ? "deleted" : "empty",
    });
    return result;
  }

  async listWorkstreams(input: WorkspaceDirectoryListRequest): Promise<WorkspaceDirectoryPage> {
    await this.initialized;
    const request = WorkspaceDirectoryListRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return WorkspaceDirectoryPageSchema.parse(this.listDirectory(request));
  }

  /**
   * Resolve a generic member-visible filter once, inside the object that owns
   * the cross-work-stream index. The caller turns each returned id into one
   * Queue event; it never probes child objects to rediscover this list.
   */
  async batchUpdateTargets(input: WorkspaceDirectoryBatchTargetsRequest) {
    await this.initialized;
    const request = WorkspaceDirectoryBatchTargetsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return WorkspaceDirectoryBatchTargetsResultSchema.parse({
      items: this.batchTargetIds(request.userId, request.filter),
    });
  }

  private batchTargetIds(userId: string, filter: WorkstreamBatchFilter): string[] {
    const atOrAfter = filter.lastActivityAt?.atOrAfter;
    const before = filter.lastActivityAt?.before;
    const pinned = filter.pinned;
    return this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT directory.workstream_id
         FROM workspace_workstream_directory directory
         LEFT JOIN workspace_workstream_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?
          AND viewer.authority_generation = directory.authority_generation
         LEFT JOIN workspace_workstream_pins pin
           ON pin.workstream_id = directory.workstream_id AND pin.user_id = ?
        WHERE directory.archived_at IS NULL
          AND (? = 1 OR directory.system_kind IS NULL)
          AND (directory.scope = 'workspace' OR viewer.is_participant = 1)
          AND (? IS NULL OR directory.last_activity_at >= ?)
          AND (? IS NULL OR directory.last_activity_at < ?)
          AND (? IS NULL
            OR (? = 1 AND pin.user_id IS NOT NULL)
            OR (? = 0 AND pin.user_id IS NULL))
        ORDER BY directory.workstream_id`,
      userId,
      userId,
      filter.includeSystem ? 1 : 0,
      atOrAfter ?? null,
      atOrAfter ? Date.parse(atOrAfter) : 0,
      before ?? null,
      before ? Date.parse(before) : 0,
      pinned === undefined ? null : Number(pinned),
      Number(pinned ?? false),
      Number(pinned ?? false),
    ).toArray().map((row) => row.workstream_id);
  }

  /** Freeze one target set and return only the Queue events not yet published. */
  async beginWorkstreamBatchDispatch(input: WorkspaceBatchDispatchBeginRequest) {
    await this.initialized;
    const request = WorkspaceBatchDispatchBeginRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.state.storage.transactionSync(() => {
      const existing = this.state.storage.sql.exec<{
        request_hash: string;
        user_id: string;
        target_count: number;
      }>(
        `SELECT request_hash, user_id, target_count
           FROM workspace_batch_dispatches WHERE operation_id = ?`,
        request.operationId,
      ).toArray()[0];
      if (existing
        && (existing.request_hash !== request.requestHash || existing.user_id !== request.userId)) {
        throw new Error("workstream_batch_dispatch_conflict");
      }

      let targetCount = existing?.target_count;
      if (!existing) {
        const now = Date.now();
        const targetIds = this.batchTargetIds(request.userId, request.filter);
        this.state.storage.sql.exec(
          `INSERT INTO workspace_batch_dispatches
             (operation_id, request_hash, user_id, target_count, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          request.operationId,
          request.requestHash,
          request.userId,
          targetIds.length,
          now,
          now,
        );
        this.state.storage.sql.exec(
          `INSERT INTO workspace_batch_dispatch_targets
             (operation_id, workstream_id, dispatched_at)
           SELECT ?, value, NULL FROM json_each(?)`,
          request.operationId,
          JSON.stringify(targetIds),
        );
        targetCount = targetIds.length;
      }

      const pending = this.state.storage.sql.exec<{ workstream_id: string }>(
        `SELECT workstream_id FROM workspace_batch_dispatch_targets
          WHERE operation_id = ? AND dispatched_at IS NULL
          ORDER BY workstream_id`,
        request.operationId,
      ).toArray();
      return WorkspaceBatchDispatchBeginResultSchema.parse({
        items: pending.map((row) => row.workstream_id),
        targetCount: targetCount ?? 0,
      });
    });
  }

  /** Persist one successful Queue sendBatch chunk; redelivery is a no-op. */
  async advanceWorkstreamBatchDispatch(input: WorkspaceBatchDispatchAdvanceRequest) {
    await this.initialized;
    const request = WorkspaceBatchDispatchAdvanceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.state.storage.transactionSync(() => {
      const dispatch = this.state.storage.sql.exec<{ request_hash: string }>(
        `SELECT request_hash FROM workspace_batch_dispatches WHERE operation_id = ?`,
        request.operationId,
      ).toArray()[0];
      if (!dispatch || dispatch.request_hash !== request.requestHash) {
        throw new Error("workstream_batch_dispatch_conflict");
      }
      const placeholders = request.workstreamIds.map(() => "?").join(", ");
      const now = Date.now();
      this.state.storage.sql.exec(
        `UPDATE workspace_batch_dispatch_targets SET dispatched_at = COALESCE(dispatched_at, ?)
          WHERE operation_id = ? AND workstream_id IN (${placeholders})`,
        now,
        request.operationId,
        ...request.workstreamIds,
      );
      this.state.storage.sql.exec(
        `UPDATE workspace_batch_dispatches SET updated_at = ? WHERE operation_id = ?`,
        now,
        request.operationId,
      );
      const remaining = this.state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM workspace_batch_dispatch_targets
          WHERE operation_id = ? AND dispatched_at IS NULL`,
        request.operationId,
      ).one();
      return WorkspaceBatchDispatchAdvanceResultSchema.parse({ remainingCount: remaining.count });
    });
  }

  async canReadWorkstream(input: WorkspaceDirectoryVisibilityRequest): Promise<boolean> {
    await this.initialized;
    const request = WorkspaceDirectoryVisibilityRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.directoryVisible(request.userId, request.workstreamId);
  }

  async readableWorkstreamIds(
    input: WorkspaceDirectoryReadableIdsRequest,
  ): Promise<WorkspaceDirectoryReadableIdsResult> {
    await this.initialized;
    const request = WorkspaceDirectoryReadableIdsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const placeholders = request.workstreamIds.map(() => "?").join(", ");
    const rows = this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT directory.workstream_id FROM workspace_workstream_directory directory
       LEFT JOIN workspace_workstream_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE directory.workstream_id IN (${placeholders})
         AND (directory.scope = 'workspace' OR viewer.is_participant = 1)
       ORDER BY directory.workstream_id`,
      request.userId,
      ...request.workstreamIds,
    ).toArray();
    return WorkspaceDirectoryReadableIdsResultSchema.parse({
      items: rows.map((row) => row.workstream_id),
    });
  }

  async visibleWorkstreamIds(input: WorkspaceDirectoryVisibleIdsRequest): Promise<WorkspaceDirectoryVisibleIdsPage> {
    await this.initialized;
    const request = WorkspaceDirectoryVisibleIdsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT directory.workstream_id FROM workspace_workstream_directory directory
       LEFT JOIN workspace_workstream_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE directory.archived_at IS NULL
         AND (? = 1 OR directory.system_kind IS NULL)
         AND ((? = 0 AND directory.scope = 'workspace')
              OR viewer.is_participant = 1)
         AND (? IS NULL OR directory.workstream_id > ?)
       ORDER BY directory.workstream_id
       LIMIT ?`,
      request.userId,
      request.includeSystem ? 1 : 0,
      request.participantsOnly ? 1 : 0,
      request.after ?? null,
      request.after ?? null,
      request.limit + 1,
    ).toArray();
    const hasMore = rows.length > request.limit;
    if (hasMore) rows.pop();
    return WorkspaceDirectoryVisibleIdsPageSchema.parse({
      items: rows.map((row) => row.workstream_id),
      nextCursor: hasMore ? rows.at(-1)?.workstream_id ?? null : null,
    });
  }

  /** Maintenance fence used before a D1 route may advertise an active child. */
  async hasWorkstreamDirectory(input: WorkspaceDirectoryExistsRequest): Promise<boolean> {
    await this.initialized;
    const request = WorkspaceDirectoryExistsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return Boolean(this.state.storage.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM workspace_workstream_directory WHERE workstream_id = ?`,
      request.workstreamId,
    ).toArray()[0]);
  }

  async plannedWorkstream(input: WorkspaceDirectoryPlannedRequest): Promise<Workstream | null> {
    await this.initialized;
    const request = WorkspaceDirectoryPlannedRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const viewerId = request.userId;
    const row = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.automation_subscription_id = ?
         AND directory.planned_for = ? AND directory.archived_at IS NULL
         AND (directory.scope = 'workspace' OR viewer.is_participant = 1)
       ORDER BY directory.source_updated_at DESC, directory.workstream_id LIMIT 1`,
      viewerId,
      viewerId,
      request.automationSubscriptionId,
      epoch(request.plannedFor),
    ).toArray()[0];
    return row ? directoryWorkstream(row, request.workspaceId) : null;
  }

  /** Exact idempotency lookup for the scheduler, independent of any member's visibility. */
  async plannedAutomationWorkstream(
    input: WorkspaceDirectoryPlannedAutomationRequest,
  ): Promise<Workstream | null> {
    await this.initialized;
    const request = WorkspaceDirectoryPlannedAutomationRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.automation_subscription_id = ?
         AND directory.planned_for = ? AND directory.archived_at IS NULL
       ORDER BY directory.source_updated_at DESC, directory.workstream_id LIMIT 1`,
      "",
      "",
      request.automationSubscriptionId,
      epoch(request.plannedFor),
    ).toArray()[0];
    return row ? directoryWorkstream(row, request.workspaceId) : null;
  }

  async pinWorkstream(input: WorkspaceDirectoryPinRequest): Promise<{ items: Workstream[] }> {
    await this.initialized;
    const request = WorkspaceDirectoryPinRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!this.directoryVisible(request.userId, request.workstreamId)) {
      throw new Error("workstream_not_found");
    }
    const now = Date.now();
    const changed = this.state.storage.transactionSync(() => {
      const alreadyPinned = this.state.storage.sql.exec<{ one: number }>(
        `SELECT 1 AS one FROM workspace_workstream_pins
          WHERE user_id = ? AND workstream_id = ?`,
        request.userId,
        request.workstreamId,
      ).toArray().length === 1;
      if (!alreadyPinned) {
        const count = this.state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM workspace_workstream_pins WHERE user_id = ?`,
          request.userId,
        ).one().count;
        if (count >= MAX_WORKSPACE_PINS_PER_USER) throw new Error("workstream_pin_limit_reached");
      }
      const inserted = this.state.storage.sql.exec<{ workstream_id: string }>(
        `INSERT OR IGNORE INTO workspace_workstream_pins
           (user_id, workstream_id, position, created_at, updated_at)
         VALUES (?, ?, COALESCE((SELECT MAX(position) + 1 FROM workspace_workstream_pins
                                  WHERE user_id = ?), 0), ?, ?)
         RETURNING workstream_id`,
        request.userId,
        request.workstreamId,
        request.userId,
        now,
        now,
      ).toArray().length === 1;
      if (inserted) this.advanceDirectoryVersion(now);
      return inserted;
    });
    if (changed) await this.publishDirectorySync(request.workspaceId);
    return { items: this.pinnedDirectoryRows(request.userId, true).map((row) => (
      directoryWorkstream(row, request.workspaceId)
    )) };
  }

  async unpinWorkstream(input: WorkspaceDirectoryPinRequest): Promise<{ items: Workstream[] }> {
    await this.initialized;
    const request = WorkspaceDirectoryPinRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const now = Date.now();
    const changed = this.state.storage.transactionSync(() => {
      const removed = this.state.storage.sql.exec<{ workstream_id: string }>(
        `DELETE FROM workspace_workstream_pins
          WHERE user_id = ? AND workstream_id = ? RETURNING workstream_id`,
        request.userId,
        request.workstreamId,
      ).toArray().length === 1;
      if (removed) {
        this.rewritePinOrder(request.userId, [], now);
        this.advanceDirectoryVersion(now);
      }
      return removed;
    });
    if (changed) await this.publishDirectorySync(request.workspaceId);
    return { items: this.pinnedDirectoryRows(request.userId, true).map((row) => (
      directoryWorkstream(row, request.workspaceId)
    )) };
  }

  async reorderWorkstreamPins(
    input: WorkspaceDirectoryReorderPinsRequest,
  ): Promise<{ items: Workstream[] }> {
    await this.initialized;
    const request = WorkspaceDirectoryReorderPinsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      this.rewritePinOrder(request.userId, request.workstreamIds, now);
      this.advanceDirectoryVersion(now);
    });
    await this.publishDirectorySync(request.workspaceId);
    return { items: this.pinnedDirectoryRows(request.userId, true).map((row) => (
      directoryWorkstream(row, request.workspaceId)
    )) };
  }

  async notificationDirectoryState(
    input: WorkspaceDirectoryNotificationRequest,
  ): Promise<WorkspaceDirectoryNotificationState | null> {
    await this.initialized;
    const request = WorkspaceDirectoryNotificationRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{
      authority_generation: number;
      waterline: number;
      listable: number;
      title: string;
      email_address: string | null;
    }>(
      `SELECT directory.authority_generation, viewer.waterline,
              viewer.listable, directory.title, directory.email_address
         FROM workspace_workstream_directory directory
         JOIN workspace_workstream_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?
          AND viewer.authority_generation = directory.authority_generation
        WHERE directory.workstream_id = ? AND directory.archived_at IS NULL`,
      request.userId,
      request.workstreamId,
    ).toArray()[0];
    return row ? WorkspaceDirectoryNotificationStateSchema.parse({
      authorityGeneration: row.authority_generation,
      viewerVersion: row.waterline,
      listable: row.listable === 1,
      title: row.title,
      emailAddress: row.email_address,
    }) : null;
  }

  async workstreamsForResource(
    input: WorkspaceDirectoryResourceRequest,
  ): Promise<WorkspaceDirectoryResourceResult> {
    await this.initialized;
    const request = WorkspaceDirectoryResourceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT link.workstream_id FROM workspace_workstream_resource_links link
       JOIN workspace_workstream_directory directory
         ON directory.workstream_id = link.workstream_id
       WHERE link.resource_id = ? AND directory.archived_at IS NULL
         AND (? = 0 OR link.watch_enabled = 1)
       ORDER BY link.workstream_id`,
      request.resourceId,
      request.watchedOnly ? 1 : 0,
    ).toArray();
    return WorkspaceDirectoryResourceResultSchema.parse({
      workstreamIds: rows.map((row) => row.workstream_id),
    });
  }

  /** Internal cross-workstream lookup; never exposes viewer-specific state. */
  async lookupWorkstreamDirectory(
    input: WorkspaceDirectoryLookupRequest,
  ): Promise<WorkspaceDirectoryLookupResult> {
    await this.initialized;
    const request = WorkspaceDirectoryLookupRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const placeholders = request.workstreamIds.map(() => "?").join(",");
    const rows = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.workstream_id IN (${placeholders})
       ORDER BY directory.last_activity_at DESC, directory.workstream_id`,
      "",
      "",
      ...request.workstreamIds,
    ).toArray();
    return WorkspaceDirectoryLookupResultSchema.parse({
      items: rows.map(internalDirectoryItem),
    });
  }

  async recentWorkstreamDirectory(
    input: WorkspaceDirectoryRecentRequest,
  ): Promise<WorkspaceDirectoryLookupResult> {
    await this.initialized;
    const request = WorkspaceDirectoryRecentRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const viewerId = request.audience.scope === "user" ? request.audience.userId : "";
    const audienceScope = request.audience.scope;
    const rows = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.archived_at IS NULL
         AND (? = 1 OR directory.system_kind IS NULL)
         AND ((? = 'workspace' AND directory.scope = 'workspace')
           OR (? = 'user' AND (
             (? = 0 AND directory.scope = 'workspace')
             OR viewer.is_participant = 1
           )))
       ORDER BY directory.last_activity_at DESC, directory.workstream_id LIMIT ?`,
      viewerId,
      viewerId,
      request.includeSystem ? 1 : 0,
      audienceScope,
      audienceScope,
      request.participantsOnly ? 1 : 0,
      request.limit,
    ).toArray();
    return WorkspaceDirectoryLookupResultSchema.parse({ items: rows.map(internalDirectoryItem) });
  }

  async dueWorkstreamDirectory(input: WorkspaceDirectoryDueRequest): Promise<string[]> {
    await this.initialized;
    const request = WorkspaceDirectoryDueRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const column = request.kind === "terminal" ? "next_terminal_action_at" : "next_wakeup_due_at";
    return this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT workstream_id FROM workspace_workstream_directory
        WHERE archived_at IS NULL AND ${column} IS NOT NULL AND ${column} <= ?
        ORDER BY ${column}, workstream_id LIMIT ?`,
      epoch(request.through),
      request.limit,
    ).toArray().map((row) => row.workstream_id);
  }

  async workstreamScheduleTargets(
    input: WorkspaceDirectoryScheduleTargetsRequest,
  ): Promise<WorkspaceDirectoryScheduleTargetsResult> {
    await this.initialized;
    const request = WorkspaceDirectoryScheduleTargetsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{
      kind: "wakeup" | "terminal";
      workstream_id: string;
      due_at: number;
    }>(
      `SELECT 'terminal' AS kind, workstream_id, next_terminal_action_at AS due_at
         FROM workspace_workstream_directory
        WHERE archived_at IS NULL AND next_terminal_action_at IS NOT NULL
       ORDER BY due_at, workstream_id`,
    ).toArray();
    return WorkspaceDirectoryScheduleTargetsResultSchema.parse({
      items: rows.map((row) => ({
        kind: row.kind,
        workstreamId: row.workstream_id,
        dueAt: iso(row.due_at),
      })),
    });
  }

  async routingCandidates(
    input: WorkspaceDirectoryRoutingCandidatesRequest,
  ): Promise<WorkspaceDirectoryLookupResult> {
    await this.initialized;
    const request = WorkspaceDirectoryRoutingCandidatesRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const restrictedJson = request.audience.scope === "users"
      ? JSON.stringify(request.audience.userIds)
      : "[]";
    const audienceScope = request.audience.scope;
    const excludedJson = JSON.stringify(request.excludedWorkstreamIds);
    const rows = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.archived_at IS NULL
         AND directory.system_kind IS NULL
         AND directory.exact_state IN ('idle', 'running', 'interrupting', 'preparing_context',
                                       'waiting_capacity', 'needs_input', 'scheduled')
         AND ((? = 'workspace' AND directory.scope = 'workspace')
           OR (? = 'users' AND (
             directory.scope = 'personal'
             AND NOT EXISTS (
               SELECT 1 FROM workspace_workstream_viewers reader
                WHERE reader.workstream_id = directory.workstream_id
                  AND reader.authority_generation = directory.authority_generation
                  AND reader.is_participant = 1
                  AND reader.user_id NOT IN (SELECT value FROM json_each(?))
             )
             AND EXISTS (
               SELECT 1 FROM workspace_workstream_viewers allowed
                WHERE allowed.workstream_id = directory.workstream_id
                  AND allowed.authority_generation = directory.authority_generation
                  AND allowed.user_id IN (SELECT value FROM json_each(?))
                  AND allowed.is_participant = 1
             )
           )))
         AND (
           SELECT COUNT(*) FROM workspace_workstream_suggestion_feedback dismissed
            WHERE dismissed.workstream_id = directory.workstream_id
              AND dismissed.source = 'contextual_routing'
              AND dismissed.status = 'dismissed'
              AND dismissed.resolved_at >= ?
              AND dismissed.resolved_at > COALESCE((
                SELECT MAX(accepted.resolved_at)
                  FROM workspace_workstream_suggestion_feedback accepted
                 WHERE accepted.workstream_id = directory.workstream_id
                   AND accepted.source = 'contextual_routing'
                   AND accepted.status = 'accepted'
              ), 0)
         ) < ?
         AND directory.workstream_id NOT IN (SELECT value FROM json_each(?))
       ORDER BY directory.last_activity_at DESC, directory.workstream_id
       LIMIT ?`,
      "",
      "",
      audienceScope,
      audienceScope,
      restrictedJson,
      restrictedJson,
      epoch(request.feedbackSince),
      request.dismissalLimit,
      excludedJson,
      request.limit,
    ).toArray();
    return WorkspaceDirectoryLookupResultSchema.parse({ items: rows.map(internalDirectoryItem) });
  }

  async suggestionFeedback(
    input: WorkspaceDirectoryFeedbackRequest,
  ): Promise<WorkspaceDirectoryFeedbackResult> {
    await this.initialized;
    const request = WorkspaceDirectoryFeedbackRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{
      workstream_id: string;
      activity_id: string;
      status: "accepted" | "dismissed";
      resolved_at: number;
      resolved_by_user_id: string;
    }>(
      `SELECT feedback.workstream_id, feedback.activity_id, feedback.status,
              feedback.resolved_at, feedback.resolved_by_user_id
         FROM workspace_workstream_suggestion_feedback feedback
         JOIN workspace_connector_events event ON event.event_id = feedback.activity_id
        WHERE feedback.source = ? AND feedback.resolved_at >= ?
          AND event.provider = ? AND event.event_type = ?
        ORDER BY feedback.resolved_at, feedback.workstream_id, feedback.action_id`,
      request.source,
      epoch(request.since),
      request.provider,
      request.eventType,
    ).toArray();
    return WorkspaceDirectoryFeedbackResultSchema.parse({
      items: rows.map((row) => ({
        workstreamId: row.workstream_id,
        activityId: row.activity_id,
        status: row.status,
        resolvedAt: iso(row.resolved_at),
        resolvedByUserId: row.resolved_by_user_id || null,
      })),
    });
  }

  async resourceAccess(
    input: WorkspaceDirectoryResourceAccessRequest,
  ): Promise<WorkspaceDirectoryResourceAccessResult> {
    await this.initialized;
    const request = WorkspaceDirectoryResourceAccessRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{
      workstream_id: string;
      scope: "personal" | "workspace";
      created_by_user_id: string | null;
      automation_subscription_id: string | null;
      is_participant: number;
    }>(
      `SELECT directory.workstream_id, directory.scope, directory.created_by_user_id,
              directory.automation_subscription_id,
              COALESCE(viewer.is_participant, 0) AS is_participant
         FROM workspace_workstream_resource_links link
         JOIN workspace_workstream_directory directory
           ON directory.workstream_id = link.workstream_id
         LEFT JOIN workspace_workstream_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?
          AND viewer.authority_generation = directory.authority_generation
        WHERE link.resource_id = ? AND directory.archived_at IS NULL
        ORDER BY directory.workstream_id`,
      request.userId,
      request.resourceId,
    ).toArray();
    return WorkspaceDirectoryResourceAccessResultSchema.parse({
      items: rows.map((row) => ({
        workstreamId: row.workstream_id,
        scope: row.scope,
        createdByUserId: row.created_by_user_id,
        automationSubscriptionId: row.automation_subscription_id,
        isParticipant: row.is_participant === 1,
      })),
    });
  }

  private async acceptSocket(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket_upgrade_required" }, 426);
    }
    const identity = SocketIdentitySchema.safeParse({
      workspaceId: readRallyHeader(request.headers, RALLY_HEADERS.WORKSPACE_ID) ?? null,
      userId: readRallyHeader(request.headers, RALLY_HEADERS.USER_ID) ?? null,
      sessionId: readRallyHeader(request.headers, RALLY_HEADERS.SESSION_ID) ?? null,
      ticketId: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_ID) ?? null,
      ticketExpiresAt: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_TICKET_EXPIRES_AT) ?? null,
    });
    if (!identity.success) return json({ error: "invalid_socket_identity" }, 400);

    const authority = await readWorkstreamAuthorityControl(this.env);
    if (!acceptsNewWorkstreamWork(authority) || authority.phase !== "durable_object_open") {
      return json({ error: "workstream_maintenance", phase: authority.phase }, 503);
    }
    const placementAffinity = readRallyHeader(request.headers, RALLY_HEADERS.PLACEMENT_AFFINITY) ?? null;
    if (!isWorkspacePlacementAffinityForRegion(this.env.AVALON_REGION, placementAffinity)) {
      return json({ error: "invalid_workspace_placement_affinity" }, 400);
    }
    this.ensureIdentity(identity.data.workspaceId, placementAffinity);
    if (!this.consumeSocketTicket(identity.data)) {
      return json({ error: "socket_ticket_replayed" }, 401);
    }
    const auth = await this.sessionAuth(identity.data);
    if (!auth) return json({ error: "session_revoked" }, 401);

    const [client, server] = Object.values(new WebSocketPair());
    if (!client || !server) return json({ error: "websocket_unavailable" }, 500);
    const attachment: WorkspaceSocketAttachment = {
      ...identity.data,
      connectionId: uuidV7(),
      connectedAt: new Date().toISOString(),
      subscribed: false,
      lastWaterline: 0,
      presenceRevision: 0,
      applicationState: "background",
      foregroundWorkstreamId: null,
    };
    this.state.acceptWebSocket(server, [attachment.workspaceId, attachment.userId]);
    // Register the server end with the hibernation API before attaching the
    // state that handlers will recover after an isolate wake. Both operations
    // are synchronous, so no client event can interleave between them.
    server.serializeAttachment(attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async createMessage(
    socket: WebSocket,
    attachment: WorkspaceSocketAttachment,
    command: CreateMessageCommand,
  ): Promise<void> {
    // A command arrives over an already-open socket, which the platform traces
    // as its own invocation with no relationship to the HTTP request the
    // desktop made to open it. `rally.message.client_id` is what joins this
    // trace to the composer that sent it: the desktop prints the same id, and
    // the command result comes back keyed by it.
    return inFlowSpan(this.env, "workstream.message.send", {
      flow: "workstream_message_send",
      component: "workspace_do",
      identity: {
        workspaceId: attachment.workspaceId,
        workstreamId: command.workstreamId,
        userId: attachment.userId,
        substreamId: command.substreamId,
      },
      attributes: {
        "rally.transport": "workspace_socket",
        "rally.message.client_id": command.payload.clientMessageId,
        "rally.message.attachment_count": command.payload.attachmentIds?.length ?? 0,
      },
    }, async (span) => {
      try {
        const authority = await span.step("workstream.message.authority_read", () =>
          readWorkstreamAuthorityControl(this.env));
        if (!acceptsNewWorkstreamWork(authority) || authority.phase !== "durable_object_open") {
          throw new ApiError(503, "workstream_maintenance", "Work streams are temporarily unavailable");
        }
        const auth = await span.step("workstream.message.session_auth", () => this.sessionAuth(attachment));
        if (auth) span.setAttributes(identityAttributes({
          analyticsWorkspaceId: auth.analyticsWorkspaceId,
        }));
        if (!auth) {
          span.setError("session_inactive");
          this.closeSocket(socket, attachment, {
            code: WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
            reason: "Session no longer active",
            cause: "session_inactive",
            operation: "create_message",
          });
          return;
        }
        const result = await span.step("workstream.message.object_write", () => new WorkstreamObjectClient(
          this.env,
          auth,
          command.workstreamId,
          command.substreamId,
          true,
        ).createMessage({
          ...command.payload,
          telemetryOperationId: command.operationId,
        }));
        span.setAttributes({
          "rally.agent.invoked": result.agentInvoked,
          "rally.harness_run.id": result.harnessRunId,
        });
        socket.send(JSON.stringify(WorkstreamSocketCommandResultSchema.parse({
          type: "client_command_succeeded",
          command: "create_message",
          clientMessageId: command.payload.clientMessageId,
          ...result,
        })));
        span.mark("workstream.message.respond");
      } catch (error) {
        const safe = error instanceof ApiError
          ? error
          : new ApiError(500, "message_write_failed", "The message could not be sent");
        socket.send(JSON.stringify(WorkstreamSocketCommandResultSchema.parse({
          type: "client_command_failed",
          command: "create_message",
          clientMessageId: command.payload.clientMessageId,
          error: {
            status: safe.status,
            code: safe.code,
            message: safe.message,
            ...(safe.details ? { details: safe.details } : {}),
          },
        })));
        if (!(error instanceof ApiError)) {
          logWarn(this.env, "workspace_socket_create_message_failed", {
            workspace_id: attachment.workspaceId,
            workstream_id: command.workstreamId,
            substream_id: command.substreamId,
            user_id: attachment.userId,
            client_message_id: command.payload.clientMessageId,
            reason: error instanceof Error ? error.message : "unknown",
          });
        }
        span.setError(safe.code, safe.message);
        span.setAttributes({ "http.response.status_code": safe.status });
      }
    });
  }

  private applyDirectoryEnvelope(
    envelope: WorkstreamRegionalEffectEnvelope,
    activeUsers: ReadonlySet<string>,
    originLabels: ReadonlyMap<string, string>,
  ): boolean {
    return this.state.storage.transactionSync(() => {
      const receipt = this.state.storage.sql.exec<{ payload_hash: string }>(
        `SELECT payload_hash FROM workspace_workstream_effect_receipts WHERE message_id = ?`,
        envelope.messageId,
      ).toArray()[0];
      if (receipt) {
        if (receipt.payload_hash !== envelope.payloadHash) {
          throw new Error("workspace_directory_effect_idempotency_conflict");
        }
        return false;
      }

      const now = Date.now();
      let changed = false;
      if (envelope.effect.kind === "directory_common") {
        const current = this.state.storage.sql.exec<{
          authority_generation: number;
          waterline: number;
          payload_hash: string;
        }>(
          `SELECT authority_generation, waterline, payload_hash
             FROM workspace_workstream_directory WHERE workstream_id = ?`,
          envelope.workstreamId,
        ).toArray()[0];
        const applies = !current
          || envelope.generation > current.authority_generation
          || (envelope.generation === current.authority_generation
            && envelope.sourceVersion > current.waterline);
        if (current
          && envelope.generation === current.authority_generation
          && envelope.sourceVersion === current.waterline
          && envelope.payloadHash !== current.payload_hash) {
          throw new Error("workspace_directory_projection_version_conflict");
        }
        if (applies) {
          const effect = envelope.effect;
          const originLabel = effect.automationSubscriptionId
            ? originLabels.get(effect.automationSubscriptionId) ?? null
            : null;
          this.state.storage.sql.exec(
            `INSERT INTO workspace_workstream_directory
               (workstream_id, authority_generation, waterline, source_event_id, payload_hash,
                title, description, preview, scope, exact_state, system_kind,
                last_activity_at, completed_at, archived_at, email_address,
                origin_type, origin_label, created_by_user_id,
                automation_subscription_id, automation_run_id, planned_for,
                title_status, latest_attention_ordinal,
                unread_tracking_start_ordinal, next_wakeup_due_at,
                next_wakeup_prompt, next_terminal_action_at, source_created_at,
                source_updated_at, projected_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(workstream_id) DO UPDATE SET
               authority_generation = excluded.authority_generation,
               waterline = excluded.waterline,
               source_event_id = excluded.source_event_id,
               payload_hash = excluded.payload_hash,
               title = excluded.title, description = excluded.description,
               preview = excluded.preview, scope = excluded.scope,
               exact_state = excluded.exact_state, system_kind = excluded.system_kind,
               last_activity_at = excluded.last_activity_at,
               completed_at = excluded.completed_at, archived_at = excluded.archived_at,
               email_address = excluded.email_address, origin_type = excluded.origin_type,
               origin_label = excluded.origin_label,
               created_by_user_id = excluded.created_by_user_id,
               automation_subscription_id = excluded.automation_subscription_id,
               automation_run_id = excluded.automation_run_id,
               planned_for = excluded.planned_for, title_status = excluded.title_status,
               latest_attention_ordinal = excluded.latest_attention_ordinal,
               unread_tracking_start_ordinal = excluded.unread_tracking_start_ordinal,
               next_wakeup_due_at = excluded.next_wakeup_due_at,
               next_wakeup_prompt = excluded.next_wakeup_prompt,
               next_terminal_action_at = excluded.next_terminal_action_at,
               source_created_at = excluded.source_created_at,
               source_updated_at = excluded.source_updated_at,
               projected_at = excluded.projected_at`,
            envelope.workstreamId,
            envelope.generation,
            envelope.sourceVersion,
            envelope.messageId,
            envelope.payloadHash,
            effect.title,
            effect.description,
            effect.preview,
            effect.scope,
            effect.state,
            effect.systemKind,
            epoch(effect.lastActivityAt),
            epoch(effect.completedAt),
            epoch(effect.archivedAt),
            effect.emailAddress ?? null,
            effect.originType ?? "ad_hoc",
            originLabel,
            effect.createdByUserId ?? null,
            effect.automationSubscriptionId ?? null,
            effect.automationRunId ?? null,
            epoch(effect.plannedFor),
            effect.titleStatus ?? "settled",
            effect.latestAttentionOrdinal ?? 0,
            effect.unreadTrackingStartOrdinal ?? 0,
            epoch(effect.nextWakeupDueAt),
            effect.nextWakeupPrompt ?? null,
            epoch(effect.nextTerminalActionAt),
            epoch(effect.createdAt ?? effect.lastActivityAt),
            epoch(effect.updatedAt ?? effect.lastActivityAt),
            now,
          );
          const automationStatus = effect.state === "completed"
            ? "completed"
            : ["failed", "error", "stopped"].includes(effect.state)
              ? "failed"
              : effect.state === "needs_input" ? "needs_input" : null;
          if (effect.automationRunId && automationStatus) {
            this.state.storage.sql.exec(
              `UPDATE automation_runs
                  SET status = ?,
                      completed_at = CASE WHEN ? IN ('completed', 'failed')
                        THEN COALESCE(?, completed_at) ELSE completed_at END
                WHERE id = ? AND workspace_id = ?
                  AND status IN ('scheduled', 'running', 'needs_input')`,
              automationStatus,
              automationStatus,
              effect.completedAt ?? effect.updatedAt ?? effect.lastActivityAt,
              effect.automationRunId,
              envelope.workspaceId,
            );
          }
          this.state.storage.sql.exec(
            `DELETE FROM workspace_workstream_resource_links WHERE workstream_id = ?`,
            envelope.workstreamId,
          );
          for (const link of effect.resourceLinks ?? []) {
            this.state.storage.sql.exec(
              `INSERT INTO workspace_workstream_resource_links
                 (workstream_id, resource_id, watch_enabled, relationship_type,
                  authority_generation, waterline, source_event_id, projected_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              envelope.workstreamId,
              link.resourceId,
              link.watchEnabled ? 1 : 0,
              link.relationshipType,
              envelope.generation,
              envelope.sourceVersion,
              envelope.messageId,
              now,
            );
          }
          changed = true;
        }
      } else if (envelope.effect.kind === "directory_user") {
        const effect = envelope.effect;
        const current = this.state.storage.sql.exec<{
          authority_generation: number;
          waterline: number;
          payload_hash: string;
        }>(
          `SELECT authority_generation, waterline, payload_hash
             FROM workspace_workstream_viewers WHERE workstream_id = ? AND user_id = ?`,
          envelope.workstreamId,
          effect.userId,
        ).toArray()[0];
        if (!activeUsers.has(effect.userId)) {
          changed = this.state.storage.sql.exec<{ user_id: string }>(
            `DELETE FROM workspace_workstream_viewers
              WHERE workstream_id = ? AND user_id = ? RETURNING user_id`,
            envelope.workstreamId,
            effect.userId,
          ).toArray().length === 1;
        } else {
          const applies = !current
            || envelope.generation > current.authority_generation
            || (envelope.generation === current.authority_generation
              && envelope.sourceVersion > current.waterline);
          if (current
            && envelope.generation === current.authority_generation
            && envelope.sourceVersion === current.waterline
            && envelope.payloadHash !== current.payload_hash) {
            throw new Error("workspace_directory_viewer_version_conflict");
          }
          if (applies) {
            this.state.storage.sql.exec(
              `INSERT INTO workspace_workstream_viewers
                 (workstream_id, user_id, authority_generation, waterline,
                  source_event_id, payload_hash, is_participant, unread_count, you_are_mentioned,
                  unseen, listable, seen_attention_ordinal, manual_unread_from_ordinal,
                  manual_unread_generation, latest_mention_attention_ordinal,
                  projected_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(workstream_id, user_id) DO UPDATE SET
                 authority_generation = excluded.authority_generation,
                 waterline = excluded.waterline,
                 source_event_id = excluded.source_event_id,
                 payload_hash = excluded.payload_hash,
                 is_participant = excluded.is_participant,
                 unread_count = excluded.unread_count,
                 you_are_mentioned = excluded.you_are_mentioned,
                 unseen = excluded.unseen,
                 listable = excluded.listable,
                 seen_attention_ordinal = excluded.seen_attention_ordinal,
                 manual_unread_from_ordinal = excluded.manual_unread_from_ordinal,
                 manual_unread_generation = excluded.manual_unread_generation,
                 latest_mention_attention_ordinal = excluded.latest_mention_attention_ordinal,
                 projected_at = excluded.projected_at`,
              envelope.workstreamId,
              effect.userId,
              envelope.generation,
              envelope.sourceVersion,
              envelope.messageId,
              envelope.payloadHash,
              effect.isParticipant ? 1 : 0,
              effect.unreadCount,
              effect.youAreMentioned ? 1 : 0,
              effect.unseen === true ? 1 : 0,
              effect.listable ? 1 : 0,
              effect.seenAttentionOrdinal ?? 0,
              effect.manualUnreadFromOrdinal ?? null,
              effect.manualUnreadGeneration ?? 0,
              effect.latestMentionAttentionOrdinal ?? 0,
              now,
            );
            changed = true;
          }
        }
      } else if (envelope.effect.kind === "suggestion_feedback") {
        const effect = envelope.effect;
        const current = this.state.storage.sql.exec<{
          authority_generation: number;
          waterline: number;
        }>(
          `SELECT authority_generation, waterline
             FROM workspace_workstream_suggestion_feedback
            WHERE workstream_id = ? AND action_id = ?`,
          envelope.workstreamId,
          effect.actionId,
        ).toArray()[0];
        if (!current
          || envelope.generation > current.authority_generation
          || (envelope.generation === current.authority_generation
            && envelope.sourceVersion > current.waterline)) {
          this.state.storage.sql.exec(
            `INSERT INTO workspace_workstream_suggestion_feedback
               (workstream_id, action_id, activity_id, source, status, resolved_at,
                resolved_by_user_id, authority_generation, waterline, source_event_id, projected_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(workstream_id, action_id) DO UPDATE SET
               activity_id = excluded.activity_id, source = excluded.source,
               status = excluded.status, resolved_at = excluded.resolved_at,
               resolved_by_user_id = excluded.resolved_by_user_id,
               authority_generation = excluded.authority_generation,
               waterline = excluded.waterline,
               source_event_id = excluded.source_event_id,
               projected_at = excluded.projected_at`,
            envelope.workstreamId,
            effect.actionId,
            effect.activityId,
            effect.source,
            effect.status,
            epoch(effect.resolvedAt),
            effect.resolvedByUserId,
            envelope.generation,
            envelope.sourceVersion,
            envelope.messageId,
            now,
          );
        }
      }

      insertWorkstreamEffectReceipt(
        this.state.storage,
        envelope.messageId,
        envelope.workstreamId,
        envelope.payloadHash,
        now,
      );
      if (changed) this.advanceDirectoryVersion(now);
      return changed;
    });
  }

  private listDirectory(request: WorkspaceDirectoryListRequest): WorkspaceDirectoryPage {
    const cursor = request.before ? directoryCursor(request.before) : null;
    const rows = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.archived_at IS NULL AND pin.user_id IS NULL
         AND directory.exact_state NOT IN ('running', 'interrupting', 'preparing_context',
                                           'waiting_capacity')
         AND (? = 1 OR directory.system_kind IS NULL)
         AND (directory.scope = 'workspace' OR viewer.is_participant = 1)
         AND (? IS NULL OR directory.last_activity_at < ?
              OR (directory.last_activity_at = ? AND directory.workstream_id > ?))
       ORDER BY directory.last_activity_at DESC, directory.workstream_id LIMIT ?`,
      request.userId,
      request.userId,
      request.includeSystem ? 1 : 0,
      cursor?.lastActivityAt ?? null,
      cursor?.lastActivityAt ?? 0,
      cursor?.lastActivityAt ?? 0,
      cursor?.workstreamId ?? "",
      request.limit + 1,
    ).toArray();
    const hasMore = rows.length > request.limit;
    if (hasMore) rows.pop();
    const last = rows.at(-1);
    const nextCursor = hasMore && last
      ? `${last.last_activity_at}:${last.workstream_id}`
      : null;
    if (!request.before) {
      const selected = new Set(rows.map((row) => row.workstream_id));
      const supplemental = [
        ...this.pinnedDirectoryRows(request.userId, request.includeSystem),
        ...this.runningDirectoryRows(request.userId, request.includeSystem),
      ];
      for (const row of supplemental) {
        if (selected.has(row.workstream_id)) continue;
        selected.add(row.workstream_id);
        rows.push(row);
      }
    }
    return {
      items: rows.map((row) => directoryWorkstream(row, request.workspaceId)),
      stateVersions: rows.map(directoryStateVersion),
      nextCursor,
      directoryWaterline: this.directoryWaterline(),
    };
  }

  /**
   * The automations the sidebar opens with, read straight from this object.
   *
   * The REST list reconciles each automation's email route against the Global
   * registry before answering. That is a network call, and this runs on the
   * socket handler's single thread with the directory read beside it, so the
   * address is served as stored and reconciled by the next `automations`
   * refresh. No sidebar row renders it. `sidebar-reads.ts` holds the reasoning
   * along with the statement both callers use.
   */
  private listSidebarAutomations(workspaceId: string, userId: string): AutomationSummary[] {
    return this.state.storage.sql.exec<Record<string, SqlStorageValue>>(
      AUTOMATION_SIDEBAR_SQL,
      workspaceId,
      userId,
      SIDEBAR_LIST_LIMIT,
    ).toArray().map((row) => toAutomationSummary(AutomationSidebarRowSchema.parse(row)));
  }

  private listSidebarNotes(workspaceId: string, userId: string): NoteSummary[] {
    return this.state.storage.sql.exec<Record<string, SqlStorageValue>>(
      NOTE_SIDEBAR_SQL,
      workspaceId,
      userId,
      SIDEBAR_LIST_LIMIT,
    ).toArray().map((row) => toNoteSummary(NoteSidebarRowSchema.parse(row)));
  }

  private pinnedDirectoryRows(userId: string, includeSystem: boolean): WorkspaceDirectoryRow[] {
    return this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.archived_at IS NULL AND pin.user_id IS NOT NULL
         AND (? = 1 OR directory.system_kind IS NULL)
         AND (directory.scope = 'workspace' OR viewer.is_participant = 1)
       ORDER BY pin.position, directory.workstream_id`,
      userId,
      userId,
      includeSystem ? 1 : 0,
    ).toArray();
  }

  /**
   * Running work streams are connection targets, not merely directory rows.
   * Return every visible one with the first page so an old active stream is
   * not hidden behind the recent-work cursor and omitted from socket prewarm.
   */
  private runningDirectoryRows(userId: string, includeSystem: boolean): WorkspaceDirectoryRow[] {
    return this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.archived_at IS NULL
         AND directory.exact_state IN ('running', 'interrupting', 'preparing_context',
                                       'waiting_capacity')
         AND (? = 1 OR directory.system_kind IS NULL)
         AND (directory.scope = 'workspace' OR viewer.is_participant = 1)
       ORDER BY directory.last_activity_at DESC, directory.workstream_id`,
      userId,
      userId,
      includeSystem ? 1 : 0,
    ).toArray();
  }

  private directoryVisible(userId: string, workstreamId: string): boolean {
    return this.state.storage.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM workspace_workstream_directory directory
       LEFT JOIN workspace_workstream_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE directory.workstream_id = ? AND directory.archived_at IS NULL
         AND (directory.scope = 'workspace' OR viewer.is_participant = 1)`,
      userId,
      workstreamId,
    ).toArray().length === 1;
  }

  private rewritePinOrder(userId: string, requestedIds: string[], now: number): void {
    const current = this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT workstream_id FROM workspace_workstream_pins
        WHERE user_id = ? ORDER BY position, workstream_id`,
      userId,
    ).toArray().map((row) => row.workstream_id);
    const pinned = new Set(current);
    const requested = [...new Set(requestedIds)].filter((id) => pinned.has(id));
    const requestedSet = new Set(requested);
    const ordered = [...requested, ...current.filter((id) => !requestedSet.has(id))];
    for (const [position, workstreamId] of ordered.entries()) {
      this.state.storage.sql.exec(
        `UPDATE workspace_workstream_pins SET position = ?, updated_at = ?
          WHERE user_id = ? AND workstream_id = ?`,
        position,
        now,
        userId,
        workstreamId,
      );
    }
  }

  private directoryWaterline(): number {
    return this.state.storage.sql.exec<{ waterline: number }>(
      `SELECT waterline FROM workspace_directory_state WHERE id = 1`,
    ).one().waterline;
  }

  private advanceDirectoryVersion(now: number): void {
    this.state.storage.sql.exec(
      `UPDATE workspace_directory_state SET waterline = waterline + 1, updated_at = ? WHERE id = 1`,
      now,
    );
  }

  /** Push the current row; missed intermediate rows are intentionally irrelevant. */
  private async publishWorkstreamState(workstreamId: string, targetUserId?: string): Promise<void> {
    const occurredAt = new Date().toISOString();
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      if (targetUserId && attachment.userId !== targetUserId) continue;
      const row = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
        `${SELECT_WORKSPACE_DIRECTORY}
         WHERE directory.workstream_id = ?`,
        attachment.userId,
        attachment.userId,
        workstreamId,
      ).toArray()[0];
      if (!row) continue;
      const visible = row.archived_at === null
        && (row.scope === "workspace" || row.is_participant === 1);
      const stateVersion = directoryStateVersion(row);
      const payload = JSON.stringify(WorkspaceWorkstreamStateEventSchema.parse({
        type: "workspace_workstream_state",
        occurredAt,
        workstreamId,
        stateVersion: {
          commonEventId: stateVersion.commonEventId,
          viewerEventId: stateVersion.viewerEventId,
          authorityGeneration: stateVersion.authorityGeneration,
          commonWaterline: stateVersion.commonWaterline,
          viewerWaterline: stateVersion.viewerWaterline,
        },
        workstream: visible ? directoryWorkstream(row, attachment.workspaceId) : null,
      }));
      try {
        socket.send(payload);
      } catch {
        // Hibernation owns close cleanup; reconnect loads the current page and
        // does not need the state rows missed while this socket was unhealthy.
      }
    }
  }

  /**
   * The whole sidebar for one viewer, from three local reads with no `await`
   * between them, so it is one consistent snapshot rather than three answers a
   * concurrent write could land between.
   *
   * `includeSystem` is false and not a parameter: this is the connect payload
   * every window gets, and system rows belong to a debug preference the server
   * does not hold. A client with it on asks for the wider directory afterwards.
   */
  private sidebarPayload(attachment: WorkspaceSocketAttachment): WorkspaceSidebar {
    return WorkspaceSidebarSchema.parse({
      workstreams: this.listDirectory({
        workspaceId: attachment.workspaceId,
        userId: attachment.userId,
        limit: SIDEBAR_LIST_LIMIT,
        includeSystem: false,
      }),
      automations: {
        waterline: this.sidebarListWaterline("automations"),
        items: this.listSidebarAutomations(attachment.workspaceId, attachment.userId),
      },
      notes: {
        waterline: this.sidebarListWaterline("notes"),
        items: this.listSidebarNotes(attachment.workspaceId, attachment.userId),
      },
    });
  }

  private sidebarListWaterline(list: SidebarList): number {
    return this.state.storage.sql.exec<{ waterline: number }>(
      `SELECT waterline FROM workspace_sidebar_list_state WHERE list = ?`,
      list,
    ).one().waterline;
  }

  /**
   * Re-send one sidebar list to every subscribed socket, per viewer.
   *
   * Read once per socket rather than once per workspace because both lists are
   * scoped — a personal automation or note belongs to its owner, and sending
   * one reader's list to another would leak it. This mirrors
   * `publishWorkstreamState`, which re-reads its row per viewer for the same
   * reason.
   *
   * The event carries the list's waterline, read once here so every socket is
   * told the same version of the same read. Transport ordering is not relied on
   * for that: `WorkspaceSidebarListEventSchema` carries the number because the
   * connect payload sends these lists too, and two producers cannot be ordered
   * by one of their transports.
   */
  private publishSidebarList(list: SidebarList): void {
    const occurredAt = new Date().toISOString();
    const waterline = this.sidebarListWaterline(list);
    // No authorization re-check on the way out. An open socket is closed by the
    // access-revocation queue, never by a publisher asking again — see
    // `docs/access-revocation.md`, which names that as the mechanism it
    // replaced and asks for it not to come back.
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      const items = list === "automations"
        ? this.listSidebarAutomations(attachment.workspaceId, attachment.userId)
        : this.listSidebarNotes(attachment.workspaceId, attachment.userId);
      try {
        socket.send(JSON.stringify(WorkspaceSidebarListEventSchema.parse({
          type: "workspace_sidebar_list",
          occurredAt,
          list,
          waterline,
          items,
        })));
      } catch {
        // Hibernation owns close cleanup, and a reconnect asks for the whole
        // sidebar again, so a socket that missed this list is not left stale.
      }
    }
  }

  private async publishDirectorySync(workspaceId: string): Promise<void> {
    const placementAffinity = this.placementAffinity();
    if (!placementAffinity) throw new Error("workspace_object_placement_affinity_missing");
    await this.publishSync(["workstream_directory"], workspaceId, placementAffinity);
  }

  private productStorage(): WorkspaceProductStorage {
    return new WorkspaceProductStorage(this.state.storage);
  }

  private reapExpiredActivityEvents(now: number): void {
    this.state.storage.sql.exec(
      `DELETE FROM workspace_activity_events
        WHERE event_sequence IN (
          SELECT event_sequence FROM workspace_activity_events
           WHERE created_at < ? ORDER BY event_sequence LIMIT 500
        )`,
      now - ACTIVITY_EVENT_RETENTION_MS,
    );
  }

  /**
   * Point the product entry at the next opportunity window or ranking request.
   *
   * An entry rather than a derived timestamp because the answer depends on the
   * caller: an enqueue wants the instant even if it is already past, while the
   * alarm that launched nothing wants past-due rows left parked. A derived
   * source has no way to carry that distinction, and reading it the wrong way
   * turns a parked window into a wake every millisecond.
   */
  private async refreshProductAlarm(options: { suppressPastDue?: boolean } = {}): Promise<void> {
    const now = Date.now();
    const productDue = this.productStorage().nextProductAlarmAt(now, options.suppressPastDue === true);
    if (productDue === null) {
      await this.cancelScheduledAlarm(PRODUCT_ALARM_KIND, PRODUCT_ALARM_KEY);
      return;
    }
    await this.scheduleAlarm({
      kind: PRODUCT_ALARM_KIND,
      key: PRODUCT_ALARM_KEY,
      dueAt: Math.max(now + 1, productDue),
    });
  }

  private assertWorkspace(workspaceId: string): void {
    if (this.workspaceId() !== workspaceId) throw new Error("workspace_object_identity_mismatch");
  }

  private ensureIdentity(
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
  ): void {
    const existing = this.workspaceId();
    if (existing && existing !== workspaceId) throw new Error("workspace_object_identity_mismatch");
    const existingAffinity = this.placementAffinity();
    if (existing) {
      if (existingAffinity !== placementAffinity) {
        throw new Error("workspace_object_placement_affinity_mismatch");
      }
      return;
    }
    const now = Date.now();
    this.state.storage.sql.exec(
      `INSERT INTO workspace_identity
       (id, workspace_id, region, placement_affinity, created_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      workspaceId,
      this.env.AVALON_REGION,
      placementAffinity,
      now,
      now,
    );
  }

  private workspaceId(): string | null {
    return this.state.storage.sql.exec<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_identity WHERE id = 1`,
    ).toArray()[0]?.workspace_id ?? null;
  }

  /**
   * This object's own name in `WORKSPACE_DOS`, or `null` before it has one.
   *
   * Memoized because a workspace identity is written once and never changes,
   * and because this is read on every name resolution the object performs.
   */
  private selfObjectName(): string | null {
    if (this.objectName !== null) return this.objectName;
    let workspaceId: string | null;
    try {
      workspaceId = this.workspaceId();
    } catch {
      // First wake: the identity table does not exist until the constructor's
      // migrations have run, and nothing can address this object by name yet.
      return null;
    }
    if (workspaceId === null) return null;
    this.objectName = workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(workspaceId));
    return this.objectName;
  }

  private placementAffinity(): WorkspacePlacementAffinity | null {
    const value = this.state.storage.sql.exec<{ placement_affinity: string | null }>(
      `SELECT placement_affinity FROM workspace_identity WHERE id = 1`,
    ).toArray()[0]?.placement_affinity;
    return isWorkspacePlacementAffinityForRegion(this.env.AVALON_REGION, value) ? value : null;
  }

  private latestSyncWaterline(): number {
    return this.state.storage.sql.exec<{ waterline: number }>(
      `SELECT COALESCE(MAX(waterline), 0) AS waterline FROM workspace_sync_events`,
    ).one().waterline;
  }

  private async subscribe(
    socket: WebSocket,
    attachment: WorkspaceSocketAttachment,
    afterWaterline: number,
  ): Promise<void> {
    const latest = this.latestSyncWaterline();
    const earliest = this.state.storage.sql.exec<{ waterline: number | null }>(
      `SELECT MIN(waterline) AS waterline FROM workspace_sync_events`,
    ).one().waterline;
    // Built once and attached to whichever event this subscribe answers with.
    // Every branch carries it, including the resume where no topic moved: a
    // push can have been missed while the socket was away — a scheduled
    // automation advancing its next run publishes no topic at all — and the
    // client's per-list comparison makes a resume that missed nothing free to
    // ignore.
    const sidebar = this.sidebarPayload(attachment);
    let events: WorkspaceSocketSyncEvent[];
    if (afterWaterline === 0) {
      events = [{
        type: "workspace_sync",
        eventId: uuidV7(),
        waterline: latest,
        occurredAt: new Date().toISOString(),
        topics: [...WORKSPACE_SYNC_TOPICS],
        reason: "initial",
        sidebar,
      }];
    } else if (afterWaterline > latest || (earliest !== null && afterWaterline < earliest - 1)) {
      events = [{
        type: "workspace_sync",
        eventId: uuidV7(),
        waterline: latest,
        occurredAt: new Date().toISOString(),
        topics: [...WORKSPACE_SYNC_TOPICS],
        reason: "history_unavailable",
        sidebar,
      }];
    } else {
      const rows = this.state.storage.sql.exec<{
        waterline: number;
        event_id: string;
        topics_json: string;
        occurred_at: number;
      }>(
        `SELECT waterline, event_id, topics_json, occurred_at FROM workspace_sync_events
          WHERE waterline > ? ORDER BY waterline`,
        afterWaterline,
      ).toArray();
      const newest = rows.at(-1);
      const changedTopics = new Set<WorkspaceSyncTopic>();
      for (const row of rows) {
        for (const topic of z.array(WorkspaceSyncTopicSchema).parse(JSON.parse(row.topics_json))) {
          changedTopics.add(topic);
        }
      }
      events = [WorkspaceSocketSyncEventSchema.parse(newest ? {
        type: "workspace_sync",
        eventId: newest.event_id,
        waterline: newest.waterline,
        occurredAt: new Date(newest.occurred_at).toISOString(),
        topics: WORKSPACE_SYNC_TOPICS.filter((topic) => changedTopics.has(topic)),
        reason: "change",
        sidebar,
      } : {
        // Nothing to report, which is not the same as nothing to send.
        type: "workspace_sync",
        eventId: uuidV7(),
        waterline: latest,
        occurredAt: new Date().toISOString(),
        topics: [],
        reason: "resume",
        sidebar,
      })];
    }
    const featureFlags = await resolveClientFeatureFlagsForSubject(this.env, {
        userId: attachment.userId,
        workspaceId: attachment.workspaceId,
    });
    for (const event of events) {
      socket.send(JSON.stringify(WorkspaceSocketSyncEventSchema.parse({ ...event, featureFlags })));
    }
    socket.serializeAttachment({
      ...attachment,
      subscribed: true,
      lastWaterline: events.at(-1)?.waterline ?? Math.max(afterWaterline, latest),
    });
  }

  private consumeSocketTicket(identity: SocketIdentity): boolean {
    // Ticket claims carry epoch seconds; object SQL stores unix-ms
    // (data-model invariant 7), so convert once at this boundary.
    const now = Date.now();
    const expiresAtMs = identity.ticketExpiresAt * 1_000;
    if (expiresAtMs <= now) return false;
    return this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `DELETE FROM workspace_socket_ticket_receipts WHERE expires_at < ?`,
        now - 300_000,
      );
      const inserted = this.state.storage.sql.exec<{ ticket_id: string }>(
        `INSERT OR IGNORE INTO workspace_socket_ticket_receipts
           (ticket_id, user_id, expires_at, consumed_at)
         VALUES (?, ?, ?, ?)
         RETURNING ticket_id`,
        identity.ticketId,
        identity.userId,
        expiresAtMs,
        now,
      );
      return inserted.toArray().length === 1;
    });
  }

  /**
   * The authorization question every admission and every inbound command asks.
   *
   * Asked on the way in, never on the way out: a socket that is already open is
   * closed by the access-revocation queue rather than by this being re-asked.
   * See `docs/access-revocation.md`.
   */
  private async sessionAuth(identity: Pick<SocketIdentity, "sessionId" | "userId" | "workspaceId">): Promise<AuthContext | null> {
    const role = this.env.APP_ENV === "development"
      && this.env.RALLY_DEV_AUTH === "true"
      && identity.sessionId === "development"
      ? await this.env.DB.prepare(
        `SELECT member.role
           FROM workspace_members member
           JOIN workspaces workspace ON workspace.id = member.workspace_id
          WHERE member.workspace_id = ? AND member.user_id = ?
            AND member.status = 'active' AND workspace.region = ?`,
      ).bind(identity.workspaceId, identity.userId, this.env.AVALON_REGION)
        .first<WorkspaceAuthRoleRow>()
      : await this.env.DB.prepare(
        // The workspace surrogate rides this query rather than being looked
        // up: a command socket authorizes itself on every frame anyway, and
        // `workspaces` is already joined. The person surrogate is not fetched
        // here — see `docs/performance-tracing.md` for where it comes from.
        `SELECT member.role, workspace.analytics_workspace_id
           FROM sessions session
           JOIN workspace_members member
             ON member.workspace_id = session.workspace_id
            AND member.user_id = session.user_id
            AND member.status = 'active'
           JOIN workspaces workspace ON workspace.id = session.workspace_id
          WHERE session.id = ? AND session.user_id = ? AND session.workspace_id = ?
            AND session.region = ? AND session.revoked_at IS NULL
            AND session.expires_at > ? AND workspace.region = ?`,
      ).bind(
        identity.sessionId,
        identity.userId,
        identity.workspaceId,
        this.env.AVALON_REGION,
        new Date().toISOString(),
        this.env.AVALON_REGION,
      ).first<WorkspaceAuthRoleRow>();
    return role ? {
      sessionId: identity.sessionId,
      userId: identity.userId,
      workspaceId: identity.workspaceId,
      region: this.env.AVALON_REGION,
      role: role.role,
      analyticsWorkspaceId: role.analytics_workspace_id ?? null,
    } : null;
  }
}
