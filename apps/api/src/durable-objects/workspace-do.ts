import {
  CHANNEL_COLOR_SYNC_MIGRATION,
  CHANNEL_MESSAGE_SEARCH_MIGRATION,
  CHANNEL_RAIL_MIGRATION,
  CONVERSATION_ACCESS_REQUESTS_MIGRATION,
  SPACE_INDIVIDUAL_SCOPE_MIGRATION,
  SPACE_INVITEES_MIGRATION,
  SPACE_MESSAGE_MERGES_MIGRATION,
  SPACE_MESSAGES_MIGRATION,
  SPACE_PUBLIC_ONLY_MIGRATION,
  SPACE_VIEWER_JOINED_AT_MIGRATION,
  WORKSPACE_BREAKOUT_SCHEMA_STATEMENTS,
  WORKSPACE_CHANNEL_READS_MIGRATION,
  WORKSPACE_PINNED_ORDER_MIGRATION,
  WORKSPACE_SPACE_SCHEMA_STATEMENTS,
  SUGGESTION_BACKFILL_MIGRATION,
  THREAD_BACKFILL_MIGRATION,
  THREAD_BACKFILL_RESUME_MIGRATION,
  IMPORT_RESERVATION_RECLAIM_MIGRATION,
  WORKSPACE_ACTIVITY_PUSH_MIGRATION,
  WORKSPACE_ACTIVITY_READS_MIGRATION,
  WORKSPACE_PEOPLE_RANKING_MIGRATION,
  WORKSPACE_REPLY_ALERT_MIGRATION,
  THREAD_ERA_TABLES_DROP_MIGRATION,
} from "./retired-workspace-schema";
import {
  automationSummary,
  AUTOMATION_AUDIENCE_SQL,
  AUTOMATION_VIEWER_JOINS,
  SIDEBAR_SIDEKICK_LISTED_SQL,
  AUTOMATION_VIEWER_SQL,
  type AutomationDirectoryRow,
  type InvalidAppearanceReport,
} from "./sidekick-directory-sql";
import { SIDEKICK_SOURCE_CONNECTION_SCHEMA_STATEMENTS } from "./sidekick-source-registrations";
import { RESOURCE_READ_PROJECTION_SQL } from '../services/resource-read-projection';
import { WorkspaceConversationView, WORKSPACE_CONVERSATION_VIEW_MIGRATION } from "./workspace-conversation-view";
import { ConversationViewProjectionSchema } from "./conversation-view-projection";
import { CONNECTOR_EVENT_PEOPLE_MIGRATION, writeConnectorEventPeople, readConnectorEventPeople, copyConnectorEventPeople } from "./connector-event-people";
import { CANVA_POLL_SECONDS } from "@rally/connectors";
import { SCOPE_GRANT_DIRECTORY_SCHEMA, applyScopeGrantDirectory, scopeGrantCandidates, ScopeGrantCandidatesRequestSchema } from "./scope-grant-directory";

import { ParentEffectEnvelopeSchema } from "@rally/contracts/conversation-effects";
import { ConversationEffectEnvelopeSchema, type ConversationEffectEnvelope } from "@rally/contracts/conversation-effects";
import type {
  ConversationParentAuthorityRequest,
  ConversationParentAuthorityResult,
  ConversationParentAuthorizeViewerRequest,
  ConversationParentAuthorizeViewerResult,
  ConversationParentKind,
  ConversationParentListChildrenRequest,
  ConversationParentListChildrenResult,
  ConversationParentReserveChildRequest,
  ConversationParentReserveChildResult,
  ConversationParentTerminalDeadlinesRequest,
  ConversationParentTerminalDeadlinesResult,
} from "@rally/contracts/conversation-parent";

/**
 * One object the retirement walk has to close before this workspace can report
 * complete: a Canvas, a Sidekick, or a Thread or Channel still awaiting the
 * Thread retirement operation. `workspace_retirement_graph`'s CHECK admits all
 * four kinds from migration 146.
 */
interface RetirementGraphNode {
  parentKind: ConversationParentKind;
  parentId: string;
}
import {
  SlackIngressQueueMessageSchema,
  WorkspaceSocketClientEventTypeSchema,
  isUnknownSocketEvent,
  safeParseSocketEvent,
  type AutomationDetail,
  type SidekickAttachment,
  type SidekickSkillSource,
} from "@rally/contracts";
import {
  InstallationCreateSchema,
  InstallationReadSchema,
  InstallationBatchReadSchema,
  type InstallationBatchRead,
  InstallationClaimSchema,
  InstallationDeliverySchema,
  InstallationSettleSchema,
  InstallationChangeSchema,
  type InstallationCreate,
  type InstallationClaim,
  type InstallationDelivery,
  type InstallationSettle,
  type InstallationChange,
  InstallationCredentialReplaceSchema,
  InstallationMaintenanceCancelSchema,
  InstallationMaintenanceSchema,
  InstallationRotationPrepareSchema,
  type InstallationCredentialReplace,
  type InstallationMaintenance,
  type InstallationMaintenanceCancel,
  type InstallationRotationPrepare,
} from './connector-installation-protocol';
import { createInstallation, readInstallation, readInstallations, claimInstallation, recordInstallationDelivery, settleInstallation, changeInstallation, cancelInstallationMaintenance, prepareInstallationMaintenance, prepareInstallationRotation, replaceInstallationCredentials } from './connector-installation-storage';
import { MEETING_NOTES_FINALIZATION_MIGRATION, MEETING_NOTES_RETIREMENT_MIGRATION, purgeRetiredMeetingObjects, applyMeetingRetirementMigrations } from "./meeting-notes-retirement";
import { AgentIdSchema, type AgentId } from "@rally/contracts";
import { AGENT_TEAM_SCHEMA, AgentTeamStorage, agentTeamResult, type AgentMessageRoute, type AgentTeamResult } from "./agent-team-storage";
import type { WorkspaceNotificationIntentDelivery } from "./workspace-notification-intent-protocol";
import {
  NOTIFICATION_INTENTS_RUN_KINDS_MIGRATION,
  readNotificationIntentForDelivery as readStoredPushIntent,
} from "./workspace-notification-intent-storage";

import {
  ExternalEventEvaluatorV1Schema,
  ExternalEventRegistrationProjectionV1Schema,
  WorkspaceExternalEventDeliveryQueueMessageSchema,
  WorkspaceExternalEventMatchResultSchema,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  IdSchema,
  UserIdSchema,
  SubstreamIdSchema,
  WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WORKSPACE_SYNC_TOPICS,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkspaceIdSchema,
  WorkspaceAttentionSchema,
  WorkspaceSidebarListEventSchema,
  WorkspaceCanvasListEventSchema,
  WorkspaceSidebarSchema,
  WorkspaceSocketClientEventSchema,
  WorkspaceFeatureFlagsEventSchema,
  WorkspacePresenceEventSchema,
  type ResourceHead,
  type WorkspaceResourceVersionsEvent,
  WorkspaceSocketSyncEventSchema,
  type MemberPreferences,
  WorkspaceSyncTopicSchema,
  WorkstreamIdSchema,
  type AutomationSummary,
  type WorkspaceSidebar,
  type WorkspaceSocketSyncEvent,
  type WorkspaceSyncTopic,
  ProductFeatureFlagKeySchema,
  type ProductFeatureFlagKey,
  UpdateOnboardingJourneySchema,
  type OnboardingJourney,
  type UpdateOnboardingJourney,
} from "@rally/contracts";
import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import type { OrganizationUsage, WorkspaceUsageEvent } from "@rally/contracts/usage";

import { sendInteractive } from "../services/interactive-queue";
import { z } from "zod";
import {
  RevokeImpersonationRelationshipsRequestSchema,
  UpsertImpersonationRelationshipsRequestSchema,
} from "@rally/contracts";
import { WorkspaceImpersonationStorage } from "./workspace-impersonation-storage";
import {
  AuthorizationSnapshotSchema, AuthorizationSubjectSchema, AuthorizationResourceSchema,
  admitsOrganizationWide, connectionAdmits, sidekickAdmits, type Viewer,
} from '../services/authorization-policy';
import { SearchAuthorizationSnapshotSchema, SearchAuthorizationTargetSchema, searchAuthorizationKey, searchDecisionFingerprint } from '../services/search-authorization';
import { flushAuthorizationDeliveries, type AuthorizationProjectionJob } from './authorization-projection';
import { AuthorizationStorage, AUTHORIZATION_STORAGE_MIGRATION, AUTHORIZATION_STORAGE_TABLES, AuthorizationLocationSchema, SPACE_MERGE_EMBED_LINKS_MIGRATION } from './authorization-storage';
import { ONBOARDING_JOURNEY_SQL, OnboardingJourneyStore } from './onboarding-journey';
import { RESOURCE_SEARCH_MIGRATION_STATEMENTS, RESOURCE_SEARCH_CONTENT_UPDATE_MIGRATION, RESOURCE_SEARCH_AUDIENCE_MIGRATION, ResourceSearchProjectionSchema, ResourceSearchRevisionRequestSchema,
  resourceSearchRevision, nextResourceSearchDueAt, publishResourceSearch, prepareResourceSearch, type ResourceSearchPace } from './resource-search-projection';
import { isDraftUpload, requiresAttachment } from '../services/resource-read-rules';
import { searchAudienceGroup, searchAudienceGroupIds } from '../services/search-audience';
import { MEMORY_SEARCH_KEY_PURGE_MIGRATION, SEARCH_AUTHORIZATION_PUSH_MIGRATION } from './search-authorization-projection';
import { observeSqlWrites } from './sql-write-observer';
import { enumerateSearchAuthorizationUniverse, type SearchAuthorizationTarget } from './search-authorization-universe';
import { resolveWorkspaceEventResources } from "./workspace-event-resources";

import type { ParentEffectEnvelope } from "@rally/contracts/conversation-effects";
import type { AuthContext, Env } from "../env";
import { restrictedActivityUserIds } from "../lib/activity-visibility";
import { ApiError } from "../lib/api-error";
import {
  assertDurableObjectJurisdiction,
  isWorkspacePlacementAffinityForRegion,
  workspacePlacementAffinity,
  type WorkspacePlacementAffinity,
} from "../lib/durable-object-namespace";
import { withDurableObjectSelf } from "../lib/durable-object-self";
import { judgeUnheardSockets, nextFirstFrameDeadline, type UnheardSocket } from "./socket-first-frame-watch";
import { parseRpcInput } from "../lib/rpc-input";
import { uuidV7 } from "../lib/uuid-v7";

import { diagnosticErrorCode, logError, logInfo, logWarn } from "../observability/logger";
import {
  revocationClosesSession,
  SocketAccessRevocationSchema,
  type SocketAccessRevocation,
} from "../services/access-revocation";
import { resolveClientFeatureFlagsForSubject } from "../services/client-feature-flags";
import {
  readWorkspaceRelationship,
  WorkspaceRelationshipSchema,
  type WorkspaceRelationship,
} from "../services/workspace-relationship-service";
import { evaluateExternalEventPredicate } from "../services/external-event-evaluator";
import { SIDEBAR_LIST_LIMIT } from "../services/sidebar-reads";

import { googleConnectorReplayCompatibility, workspaceConnectorEventContentFingerprint, workspaceConnectorEventPayloadHash } from "../services/workspace-connector-event-ingress";
import { withWorkspaceRuntimeDatabase } from "../services/workspace-runtime-database";
import {
  recordWorkspaceScheduleFailure,
  runWorkspaceScheduleTarget,
  workspaceScheduleTargets,
  WORKSPACE_ALARM_SOURCE_KINDS,
  WORKSPACE_SCHEDULE_ALARM_KINDS,
  type WorkspaceScheduleContext,
  type WorkspaceScheduleTargetKind,
} from "../services/workspace-schedule-execution";
import {
  acceptsNewWorkstreamWork,
  readWorkstreamAuthorityControl,
} from "../services/workstream-authority";

import type { DurableObjectMigrationPlan } from "./migratable-durable-object";
import { workspaceDOName } from "./names";
import {
  OBJECT_RETIREMENT_SCHEMA_STATEMENTS,
  applyRetirementGate,
  droppedEnvelopeReceipts,
  isRetirementRefusal,
  readObjectRetirement,
  retiredObjectResponse,
} from "./object-retirement";
import {
  responseToRpcResult,
  type DurableObjectRpcResult,
} from "./rpc-result";
import { reportScheduledAlarmAttempt } from "./scheduled-alarm-report";
import {
  SCHEDULED_ALARM_DRAIN_LIMIT,
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
import {
  observableWorkspaceScheduledAlarmKind,
  WorkspaceAlarmInstrumentation,
  type ObservableWorkspaceScheduledAlarmKind,
  type WorkspaceScheduledAlarmPhase,
} from "./workspace-alarm-instrumentation";
import {
  WorkspaceConnectorOAuthAttemptAbandonRequestSchema,
  WorkspaceConnectorOAuthAttemptExtendRequestSchema,
  WorkspaceConnectorOAuthAttemptFinishRequestSchema,
  WorkspaceConnectorOAuthAttemptReadRequestSchema,
  WorkspaceConnectorOAuthAttemptStartRequestSchema,
  WorkspaceConnectorOAuthAttemptTelemetryBindRequestSchema,
  WorkspaceWebhookReceiptClaimRequestSchema,
  type WorkspaceConnectorOAuthAttemptAbandonRequest,
  type WorkspaceConnectorOAuthAttemptExtendRequest,
  type WorkspaceConnectorOAuthAttemptFinishRequest,
  type WorkspaceConnectorOAuthAttemptFinishResult,
  type WorkspaceConnectorOAuthAttemptReadRequest,
  type WorkspaceConnectorOAuthAttemptReadResult,
  type WorkspaceConnectorOAuthAttemptStartRequest,
  type WorkspaceConnectorOAuthAttemptTelemetryBindRequest,
  type WorkspaceWebhookReceiptClaimRequest,
  type WorkspaceWebhookReceiptClaimResult,
} from "./workspace-connections-protocol";
import {
  abandonWorkspaceConnectorOAuthAttempt,
  bindWorkspaceConnectorOAuthAttemptTelemetry,
  claimWorkspaceWebhookReceipt,
  extendWorkspaceConnectorOAuthAttempt,
  finishWorkspaceConnectorOAuthAttempt,
  readWorkspaceConnectorOAuthAttempt,
  startWorkspaceConnectorOAuthAttempt,
} from "./workspace-connections-storage";
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
import {
  WorkspaceAttentionRequestSchema,
  WorkspaceLinkTitleRequestSchema,
  WorkspaceDirectoryNotificationRequestSchema,
  WorkspaceDirectoryNotificationStateSchema,
  WorkspaceDirectoryScheduleTargetsRequestSchema,
  WorkspaceDirectoryScheduleTargetsResultSchema,
  WorkspaceRegionalEffectApplyRequestSchema,
  WorkspaceRegionalEffectApplyResultSchema,
  type WorkspaceAttentionRequest,
  type WorkspaceAttentionResult,
  type WorkspaceDirectoryNotificationRequest,
  type WorkspaceDirectoryNotificationState,
  type WorkspaceDirectoryScheduleTargetsRequest,
  type WorkspaceDirectoryScheduleTargetsResult,
  type WorkspaceRegionalEffectApplyRequest,
  type WorkspaceRegionalEffectApplyResult,
} from "./workspace-directory-protocol";
import {
  SLACK_REACTION_COLUMN_STATEMENTS,
  WORKSPACE_DOMAIN_SCHEMA_STATEMENTS,
  workspaceIdentityFencesFor,
} from "./workspace-domain-schema";
import {
  WorkspaceReleaseDraftAttachmentsRequestSchema,
  WorkspaceReleaseDraftAttachmentsResultSchema,
  WorkspaceReserveDraftAttachmentsRequestSchema,
  WorkspaceReserveDraftAttachmentsResultSchema,
  type WorkspaceReleaseDraftAttachmentsRequest,
  type WorkspaceReleaseDraftAttachmentsResult,
  type WorkspaceReserveDraftAttachmentsRequest,
  type WorkspaceReserveDraftAttachmentsResult,
} from "./workspace-draft-attachment-protocol";
import {
  WorkspaceMemoryReceiptRequestSchema,
  WorkspaceMemoryScopeEnsureRequestSchema,
  WorkspaceMemoryTableCreateRequestSchema,
  WorkspaceMemoryTableInsertRowsRequestSchema,
  WorkspaceMemoryTableInvalidateRowsRequestSchema,
  WorkspaceMemoryTableQueryRequestSchema,
  WorkspaceMemoryTableRequestSchema,
  WorkspaceMemoryTableRowsByIdRequestSchema,
  WorkspaceMemoryTableSearchRequestSchema,
  WorkspaceMemoryTableUpdateRowsRequestSchema,
  type WorkspaceMemoryReceiptRequest,
  type WorkspaceMemoryReceiptResult,
  type WorkspaceMemoryScope,
  type WorkspaceMemoryScopeEnsureRequest,
  type WorkspaceMemoryTableCreateRequest,
  type WorkspaceMemoryTableCreateResult,
  type WorkspaceMemoryTableInsertRowsRequest,
  type WorkspaceMemoryTableInsertRowsResult,
  type WorkspaceMemoryTableInvalidateRowsRequest,
  type WorkspaceMemoryTableQueryRequest,
  type WorkspaceMemoryTableQueryResult,
  type WorkspaceMemoryTableRequest,
  type WorkspaceMemoryTableResult,
  type WorkspaceMemoryTableRowList,
  type WorkspaceMemoryTableRowsByIdRequest,
  type WorkspaceMemoryTableSearchRequest,
  type WorkspaceMemoryTableSearchResult,
  type WorkspaceMemoryTableUpdateRowsRequest,
  type WorkspaceMemoryTableWriteResult,
} from "./workspace-memory-protocol";
import {
  createWorkspaceMemoryTable,
  ensureWorkspaceMemoryScope,
  insertWorkspaceMemoryTableRows,
  invalidateWorkspaceMemoryTableRows,
  queryWorkspaceMemoryTableRows,
  searchWorkspaceMemoryTables,
  updateWorkspaceMemoryTableRows,
  workspaceMemoryTableMutationReceipt,
  workspaceMemoryTableRowsById,
  workspaceMemoryTableWithColumns,
} from "./workspace-memory-storage";
import {
  WorkspaceMemoryApplySweepRequestSchema,
  WorkspaceMemoryDigestRequestSchema,
  WorkspaceMemoryForgetRequestSchema,
  WorkspaceMemoryRecallRequestSchema,
  WorkspaceMemoryRememberRequestSchema,
  WorkspaceMemoryReviewForgetRequestSchema,
  WorkspaceMemoryReviewRequestSchema,
  WorkspaceMemorySweepCandidatesRequestSchema,
  type MemoryReader,
  type WorkspaceMemoryApplySweepResult,
  type WorkspaceMemoryDigestResult,
  type WorkspaceMemoryForgetResult,
  type WorkspaceMemoryRecallResult,
  type WorkspaceMemoryRememberResult,
  type WorkspaceMemoryReviewForgetResult,
  type WorkspaceMemoryReviewResult,
  type WorkspaceMemorySweepCandidatesResult,
} from "./workspace-memory-facts-protocol";
import {
  MEMORY_FACTS_MIGRATION,
  applyMemorySweep,
  forgetMemoryFact,
  forgetReviewedMemoryFact,
  memoryDigestFacts,
  memorySweepCandidates,
  recallMemoryFacts,
  rememberMemoryFact,
  reviewMemoryFacts,
} from "./workspace-memory-facts-storage";
import {
  MEMORY_DIGEST_HOLDERS_ADMIT_CANVAS_MIGRATION, MEMORY_DIGEST_CANVAS_SIDEKICK_TRIGGERS_MIGRATION,
  MEMORY_DIGEST_SYNC_MIGRATION,
  MemoryDigestSyncMessageSchema,
  MemoryDigestSyncWorkSchema,
  completeMemoryDigestSync,
  memoryDigestSyncWork,
  nextMemoryDigestSyncAt,
  publishMemoryDigestSync,
  releaseMemoryDigestSync,
  type MemoryDigestSyncMessage,
  type MemoryDigestSyncWork,
} from "./memory-digest-sync";
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
import { WORKSPACE_PRODUCT_SCHEMA_STATEMENTS } from "./workspace-product-schema";

import {
  WorkspacePinStorage,
  WORKSPACE_ARTIFACT_PINS_MIGRATION,
  RESOURCE_VERSIONS_QUEUE_ARTIFACT_UPDATE,
  WORKSPACE_ARTIFACT_UPDATES_MIGRATION,
  WORKSPACE_PINS_MIGRATION,
} from "./workspace-pin-storage";
import {
  drainResourceVersionChanges,
  readResourceHeads,
  resourceVersionLedgerReady,
  WORKSPACE_RESOURCE_VERSION_CHANGES_MIGRATION,
} from "./workspace-resource-versions";

import {
  PersonalSystemPromptReadRequestSchema,
  PersonalSystemPromptWriteRequestSchema,
  WORKSPACE_PERSONAL_SYSTEM_PROMPT_MIGRATION,
  type PersonalSystemPromptReadRequest,
  type PersonalSystemPromptRecord,
  type PersonalSystemPromptWriteRequest,
} from "./personal-system-prompt";
import {
  MemberPreferencesReadRequestSchema,
  MemberPreferencesWriteRequestSchema,
  WORKSPACE_MEMBER_PREFERENCES_MIGRATION,
  WORKSPACE_MEMBER_PUSH_PREFERENCES_MIGRATION,
  WORKSPACE_MEMBER_NOTIFY_PREFERENCES_MIGRATION,
  NotificationAllowsRequestSchema,
  mergePushPreferences,
  notificationAllows,
  savedNotify,
  storedMemberPreferences,
  storedPushPreferences,
  type NotificationAllowsRequest,
  type MemberPreferencesReadRequest,
  type MemberPreferencesWriteRequest,
} from "./member-preferences";
import { HOSTED_PARENT_SCHEMA_STATEMENTS, HOSTED_PARENT_STATE_TABLES } from "./hosted-parent-schema";
import { ReceiveChildEffectsRequestSchema, type ReceiveChildEffectsRequest } from "./conversation-parent-object";
import type { HostedConversation } from "./hosted-conversation";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import {
  PARTICIPANT_MIGRATION_ALARM,
  PARTICIPANT_PROJECTION_ALARM,
} from "./scope-grant-storage";
import { SCOPE_INVITATION_DELIVERY_ALARM, SCOPE_INVITATION_INDEX_ALARM } from "./scope-invitation-storage";
import {
  applyWorkstreamRegionalEnvelope,
} from "./workspace-regional-effect-storage";
import {
  WorkspaceConnectorResourceResolveRequestSchema,
  WorkspaceDiscoveredResourcesRequestSchema,
  WorkspaceExpiredDraftReapRequestSchema,
  WorkspaceInboundEmailResourceRequestSchema,
  WorkspaceReapableResourceObjectListRequestSchema,
  WorkspaceResourceDescriptorsRequestSchema,
  WorkspaceResourceExistsRequestSchema,
  WorkspaceResourceHydrationPublishRequestSchema,
  WorkspaceResourceHydrationRefreshRequestSchema,
  WorkspaceResourceRenameRequestSchema,
  WorkspaceResourceObjectFailureRequestSchema,
  WorkspaceResourceObjectRefRequestSchema,
  WorkspaceResourceSlugBacklogRequestSchema,
  WorkspaceResourceSlugClaimRequestSchema,
  WorkspaceResourceVersionListRequestSchema,
  WorkspaceResourceWatchDisableRequestSchema,
  WorkspaceResourceWatchEnableRequestSchema,
  WorkspaceUploadDraftCreateRequestSchema,
  WorkspaceUploadDraftDeleteRequestSchema,
  type WorkspaceConnectorResourceResolveRequest,
  type WorkspaceConnectorResourceResolveResult,
  type WorkspaceDiscoveredResourcesRequest,
  type WorkspaceExpiredDraftReapRequest,
  type WorkspaceExpiredDraftReapResult,
  type WorkspaceInboundEmailResourceRequest,
  type WorkspaceInboundEmailResourceResult,
  type WorkspaceReapableResourceObjectList,
  type WorkspaceReapableResourceObjectListRequest,
  type WorkspaceResourceDescriptorList,
  type WorkspaceResourceDescriptorsRequest,
  type WorkspaceResourceExistsRequest,
  type WorkspaceResourceExistsResult,
  type WorkspaceResourceHydrationPublishRequest,
  type WorkspaceResourceHydrationRefreshRequest,
  type WorkspaceResourceHydrationResult,
  type WorkspaceResourceRenameRequest,
  type WorkspaceResourceRenameResult,
  type WorkspaceResourceObjectFailureRequest,
  type WorkspaceResourceObjectRefRequest,
  type WorkspaceResourceObjectRemovalResult,
  type WorkspaceResourceObjectRetireResult,
  type WorkspaceResourceSlugBacklog,
  type WorkspaceResourceSlugBacklogRequest,
  type WorkspaceResourceSlugClaimRequest,
  type WorkspaceResourceSlugClaimResult,
  type WorkspaceResourceVersionList,
  type WorkspaceResourceVersionListRequest,
  type WorkspaceResourceWatchDisableRequest,
  type WorkspaceResourceWatchEnableRequest,
  type WorkspaceUploadDraftCreateRequest,
  type WorkspaceUploadDraftCreateResult,
  type WorkspaceUploadDraftDeleteRequest,
  type WorkspaceUploadDraftDeleteResult,
} from "./workspace-resources-protocol";
import {
  claimWorkspaceResourceObjectRemoval,
  claimWorkspaceResourceSlug,
  createWorkspaceUploadDraft,
  deleteWorkspaceUploadDraft,
  disableWorkspaceResourceWatch,
  enableWorkspaceResourceWatch,
  listWorkspaceReapableResourceObjects,
  listWorkspaceResourcesAwaitingSlug,
  listWorkspaceResourceVersions,
  publishWorkspaceResourceHydration,
  reapWorkspaceExpiredDraftResources,
  recordWorkspaceResourceObjectCleanupFailure,
  refreshWorkspaceResourceHydration,
  renameWorkspaceResource,
  resolveWorkspaceConnectorResource,
  retireWorkspaceResourceObjectStaging,
  upsertWorkspaceDiscoveredResources,
  upsertWorkspaceInboundEmailResource,
  workspaceResourceDescriptors,
  workspaceResourceExists,
} from "./workspace-resources-storage";
import {
  executeWorkspaceRuntimeSql,
  WorkspaceRuntimeSqlRequestSchema,
  type WorkspaceRuntimeSqlRequest,
  type WorkspaceRuntimeSqlResult,
} from "./workspace-runtime-sql";
import {
  WorkspaceSlackIngressClaimRequestSchema,
  WorkspaceSlackIngressCompleteRequestSchema,
  WorkspaceSlackIngressEnqueueRequestSchema,
  WorkspaceSlackIngressFailRequestSchema,
  WorkspaceSlackIngressRecoverableRequestSchema,
  WorkspaceSlackIngressSweepRequestSchema,
  WorkspaceSlackPendingPromptClearRequestSchema,
  WorkspaceSlackPendingPromptRequestSchema,
  WorkspaceSlackPendingPromptStoreRequestSchema,
  WorkspaceSlackThreadClaimRequestSchema,
  WorkspaceSlackThreadReleaseRequestSchema,
  WorkspaceSlackThreadRoutableRequestSchema,
  type WorkspaceSlackIngressClaimRequest,
  type WorkspaceSlackIngressClaimResult,
  type WorkspaceSlackIngressCompleteRequest,
  type WorkspaceSlackIngressEnqueueRequest,
  type WorkspaceSlackIngressEnqueueResult,
  type WorkspaceSlackIngressFailRequest,
  type WorkspaceSlackIngressFailResult,
  type WorkspaceSlackIngressRecoverableRequest,
  type WorkspaceSlackIngressRecoverableResult,
  type WorkspaceSlackIngressSettleResult,
  type WorkspaceSlackIngressSweepRequest,
  type WorkspaceSlackIngressSweepResult,
  type WorkspaceSlackPendingPromptClearRequest,
  type WorkspaceSlackPendingPromptRequest,
  type WorkspaceSlackPendingPromptResult,
  type WorkspaceSlackPendingPromptStoreRequest,
  type WorkspaceSlackThreadClaimRequest,
  type WorkspaceSlackThreadClaimResult,
  type WorkspaceSlackThreadReleaseRequest,
  type WorkspaceSlackThreadRoutableRequest,
  type WorkspaceSlackThreadRoutableResult,
  WorkspaceSlackContextRequestSchema,
  WorkspaceSlackContextStoreRequestSchema,
  WorkspaceSlackFeedbackRequestSchema,
  WorkspaceSlackSessionAssignRequestSchema,
  WorkspaceSlackSessionByIdRequestSchema,
  WorkspaceSlackSessionByThreadRequestSchema,
  WorkspaceSlackSessionByWorkstreamRequestSchema,
  WorkspaceSlackSessionCreateRequestSchema,
  WorkspaceSlackSessionDeliveryKeyRequestSchema,
  WorkspaceSlackSessionExistsRequestSchema,
  WorkspaceSlackSessionReactionAnchorRequestSchema,
  WorkspaceSlackSessionReactionRequestSchema,
  WorkspaceSlackSessionStreamRequestSchema,
  type WorkspaceSlackContextRequest,
  type WorkspaceSlackContextResult,
  type WorkspaceSlackContextStoreRequest,
  type WorkspaceSlackFeedbackRequest,
  type WorkspaceSlackFeedbackResult,
  type WorkspaceSlackSessionAssignRequest,
  type WorkspaceSlackSessionAssignResult,
  type WorkspaceSlackSessionByIdRequest,
  type WorkspaceSlackSessionByThreadRequest,
  type WorkspaceSlackSessionByWorkstreamRequest,
  type WorkspaceSlackSessionCreateRequest,
  type WorkspaceSlackSessionDeliveryKeyRequest,
  type WorkspaceSlackSessionExistsRequest,
  type WorkspaceSlackSessionExistsResult,
  type WorkspaceSlackSessionReactionAnchorRequest,
  type WorkspaceSlackSessionReactionRequest,
  type WorkspaceSlackSessionReactionResult,
  type WorkspaceSlackSessionResult,
  type WorkspaceSlackSessionStreamRequest,
} from "./workspace-slack-protocol";
import {
  claimWorkspaceSlackIngressJob,
  claimWorkspaceSlackThread,
  clearWorkspaceSlackPendingPrompt,
  completeWorkspaceSlackIngressJob,
  enqueueSlackSourceJoins,
  enqueueWorkspaceSlackIngressJob,
  failWorkspaceSlackIngressJob,
  recoverableWorkspaceSlackIngressJobs,
  releaseWorkspaceSlackThreadClaim,
  rememberWorkspaceSlackPendingPrompt,
  sweepWorkspaceSlackIngress,
  workspaceSlackPendingPrompt,
  workspaceSlackThreadRoutable,
  assignWorkspaceSlackSessions,
  createWorkspaceSlackSession,
  recordWorkspaceSlackFeedback,
  setWorkspaceSlackSessionDeliveryKey,
  setWorkspaceSlackSessionStream,
  anchorWorkspaceSlackSessionReaction,
  settleWorkspaceSlackSessionReaction,
  storeWorkspaceSlackContext,
  workspaceSlackContext,
  workspaceSlackSessionById,
  workspaceSlackSessionByThread,
  workspaceSlackSessionByWorkstream,
  workspaceSlackSessionExists,
} from "./workspace-slack-storage";
import {
  ExternalBindingActivateResultSchema,
  ExternalConversationKeySchema,
  ExternalBindingLatestOutboundRequestSchema,
  ExternalBindingLatestOutboundResultSchema,
  ExternalBindingMoveRequestSchema,
  ExternalBindingMoveResultSchema,
  ExternalBindingOutboundRequestSchema,
  ExternalBindingOutboundResultSchema,
  ExternalBindingReactivateRequestSchema,
  ExternalBindingReadRequestSchema,
  ExternalBindingReadResultSchema,
  ExternalBindingReleaseResultSchema,
  ExternalBindingResolutionSchema,
  ExternalBindingResolveRequestSchema,
  ExternalBindingSettleRequestSchema,
  ExternalBindingSuspendRequestSchema,
  ExternalBindingSuspendResultSchema,
  type ExternalBindingResolution,
} from "./workspace-external-binding-protocol";
import {
  EXTERNAL_CONVERSATION_BINDINGS_MIGRATION,
  EXTERNAL_BINDING_SPACE_MATCHED_MIGRATION,
  ExternalConversationBindingStorage,
} from "./workspace-external-binding-storage";
import {
  WorkspaceTerminalNetworkSettingsRequestSchema,
  WorkspaceTerminalPolicyClaimRequestSchema,
  WorkspaceTerminalPolicyCommitRequestSchema,
  WorkspaceTerminalPolicyFailRequestSchema,
  WorkspaceTerminalPolicyPreviewRequestSchema,
  type WorkspaceTerminalNetworkMode,
  type WorkspaceTerminalNetworkSettings,
  type WorkspaceTerminalNetworkSettingsRequest,
  type WorkspaceTerminalPolicyClaimRequest,
  type WorkspaceTerminalPolicyClaimResult,
  type WorkspaceTerminalPolicyCommitRequest,
  type WorkspaceTerminalPolicyFailRequest,
  type WorkspaceTerminalPolicySettlementResult,
  type WorkspaceTerminalPolicyPreviewRequest,
} from "./workspace-terminal-network-protocol";
import {
  claimWorkspaceTerminalPolicyApplication,
  commitWorkspaceTerminalPolicyApplication,
  failWorkspaceTerminalPolicyApplication,
  recordWorkspaceTerminalPolicyPreview,
  workspaceTerminalNetworkMode,
  workspaceTerminalNetworkSettings,
} from "./workspace-terminal-network-storage";
import {
  WorkspaceTranscriptionAdmitRequestSchema,
  WorkspaceTranscriptionRenewRequestSchema,
  WorkspaceTranscriptionSessionRequestSchema,
  type WorkspaceTranscriptionAdmitRequest,
  type WorkspaceTranscriptionAdmitResult,
  type WorkspaceTranscriptionRenewRequest,
  type WorkspaceTranscriptionRenewResult,
  type WorkspaceTranscriptionSessionRequest,
} from "./workspace-transcription-protocol";
import {
  admitWorkspaceTranscriptionSession,
  releaseWorkspaceTranscriptionSession,
  renewWorkspaceTranscriptionSession,
} from "./workspace-transcription-storage";
import {
  SIDEKICK_CONVERSATION_ATTACHMENT_SCHEMA_STATEMENTS,
  attachSidekickConversation,
  canvasesTitled,
  canvasTitle,
  matchConversationReference,
  parseConversationId,
  scopeConversations,
  type ScopedConversation,
} from "./workspace-sidekick-conversation-storage";
import { CANVAS_ARTIFACTS_STATEMENTS, CANVAS_SCHEMA_STATEMENTS, CANVAS_SIDEKICK_PINS_STATEMENTS, SIDEKICK_ATTACHMENTS_ADMIT_CANVAS_STATEMENTS, RETIREMENT_GRAPH_CANVAS_MIGRATION } from "./canvas-schema";
import { canvasesWrittenBy, canvasReaderAllows, canvasSidebarRows, HostedCanvas, type CanvasRow, type HostedCanvasHost } from "./hosted-canvas";
import { HOSTED_SIDEKICK_SCHEMA_STATEMENTS, SIDEKICK_REVIEW_SCHEMA_STATEMENTS, SIDEKICK_RUN_ROW_SCHEMA_STATEMENTS, SIDEKICK_AUDIENCE_SCHEMA_STATEMENTS, SIDEKICK_RUN_REQUESTER_SCHEMA_STATEMENTS } from "./hosted-sidekick-schema";
import {
  HostedSidekick,
  hostedSidekickAlarmTarget,
  sidekickReaderAllows,
  skillSource,
  skillSummary,
  type HostedSidekickRow,
  type HostedSidekickHost,
} from "./hosted-sidekick";
import {
  SidekickBatchDetailRequestSchema,
  SidekickBatchSkillReadRequestSchema,
  type SidekickBatchDetailRequest,
  type SidekickBatchSkillReadRequest,
  SidekickRunProvisionQueueMessageSchema,
  SidekickReviewQueueMessageSchema,
} from "./automation-do-protocol";
import {
  ConversationToolAttachRequestSchema,
  ConversationToolResolveRequestSchema,
  ConversationToolScopeRequestSchema,
  type ConversationToolAttachResult,
  type ConversationToolEntry,
  type ConversationToolRefusal,
  type ConversationToolRefusalCode,
  type ConversationToolResolveResult,
  type ConversationToolScopeResult,
} from "./workspace-conversation-tool-protocol";

import { SIDEKICK_DELEGATION_SCHEMA_STATEMENTS, SidekickDelegationStorage } from "./sidekick-delegation-storage";

const WORKSPACE_TYPED_RPC_ONLY_TABLES = [
  "sidekick_delegations", "sidekick_delegation_receipts", "sidekick_delegation_preparations", "sidekick_claim_access",
  "scope_grant_directory",
  "connector_installations", "connector_installation_steps",
  ...AUTHORIZATION_STORAGE_TABLES,
  'search_authorization_push', 'search_authorization_keys', 'search_authorization_dependencies',
  "resource_search_versions",
  "onboarding_journeys",
  "workstream_notification_intents",
  "workspace_socket_unheard", // The first-frame watch's ledger.
  "conversation_view_headers", "conversation_view_turns",
  // Recorded by `memoryDigest`, marked by triggers and retractions, and read by
  // the alarm lane and the memory-digest-sync RPCs.
  "memory_digest_holders", "memory_digest_holder_facts", "memory_digest_sync", "memory_digest_sync_state",
  "memory_revision",
  // Converted to typed methods, so a generic statement naming one is a
  // mistake rather than a legacy caller. Refusing it here is what makes the
  // routing entries in `WORKSPACE_LOCAL_TABLES` more than a courtesy: the
  // statement reaches this object and is told why, instead of executing
  // against storage nobody meant to reach generically.
  "automation_directory",
  "sidekick_conversation_attachments",
  // A hosted Sidekick's own rows: `HostedSidekick` is their only writer.
  "sidekick_revisions", "sidekick_schedules", "sidekick_runs", "sidekick_email_receipts",
  "sidekick_children", "sidekick_child_projections", "sidekick_child_receipts", "sidekick_reviews",
  "sidekick_audience", "sidekick_viewer_reads",
  // A hosted Canvas's own rows: `HostedCanvas` is their only writer.
  // `canvas_artifacts` is deliberately absent: the expired-drafts due time
  // reads it through this object's local executor, the same predicate the
  // reap applies, as the Slack due times above are read.
  "canvas_directory", "canvas_participants",
  "realtime_transcription_sessions",
  "realtime_transcription_ticket_receipts",
  "workspace_impersonation_relationships",
  // Claims live on `claimWebhookReceipt`; the only generic statements left
  // naming this table are the connection service's pre-cutover branches, which
  // run only when WORKSPACE_DOS is unbound and so never reach this object.
  // `connector_oauth_attempts` is deliberately absent: the attempt-bind
  // statement batched with a connection mutation in
  // `persistConnectionMutation` still arrives generically, and refusing the
  // table here would break that atomic pair.
  "webhook_receipts",
  // The memory domain is typed methods now: the scopes and tables of
  // `rally_tables`, and the facts, receipts and sweep receipts of agent memory.
  "memory_scopes",
  "memory_facts",
  "memory_facts_fts",
  "memory_fact_receipts",
  "memory_sweep_receipts",
  "memory_tables",
  "memory_table_columns",
  "memory_table_rows",
  "memory_table_rows_fts",
  "memory_table_cells",
  "memory_table_mutations",
  // The Slack agent session, context, and feedback tables are typed methods
  // now. `slack_link_challenges`, `slack_agent_thread_claims`,
  // `slack_agent_pending_prompts`, and `slack_ingress_jobs` are deliberately
  // absent: the schedule's alarm-target derivation reads their due times
  // generically through this object's local executor, alongside the other
  // alarm sources.
  "slack_agent_sessions",
  "slack_agent_contexts",
  "slack_agent_feedback",
  // Bindings are typed methods from their first version.
  "external_conversation_bindings",
] as const;

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
]);

type SidebarList = "automations";

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
  /**
   * The Rally staff member behind a support session (`docs/impersonation.md`),
   * from the signed ticket. Such a socket never shows the person as present
   * and never records them opening a Channel.
   */
  impersonatorUserId: UserIdSchema.optional(),
});

type SocketIdentity = z.infer<typeof SocketIdentitySchema>;
interface WorkspaceSocketAttachment extends SocketIdentity {
  /**
   * The relationship this socket was admitted under.
   *
   * Pinned at accept time because nothing re-asks on the way out: an open
   * socket is closed by the access-revocation queue rather than by a publisher
   * querying D1 again (`docs/access-revocation.md`). It decides one thing here
   * — whether this socket is told about Spaces at all — and a guest is not,
   * because a guest holds explicit Channel and Breakout grants and no
   * Organization-wide discovery, so every Organization-wide Space would
   * otherwise arrive in their sidebar.
   *
   * Optional so a socket attached before this field existed keeps working
   * across a deploy; absent is read as `member`, which is what every such
   * socket was.
   */
  accessClass?: "member" | "guest";
  /**
   * Whether this socket's build reads a Space scoped `individual`, from its
   * signed ticket. Absent, as on every socket attached before it existed,
   * reads as no: such a build is shown a Personal Channel as `personal`.
   */
  readsIndividualSpaces?: boolean;
  connectionId: string;
  connectedAt: string;
  subscribed: boolean;
  firstFrameReported: boolean;
  lastWaterline: number;
  presenceRevision: number;
  applicationState: "foreground" | "background";
  foregroundWorkstreamId: string | null;
  /**
   * A Channel this window foregrounded before the directory listed it for the
   * viewer. Presence promotes it when a directory change makes it visible,
   * since the renderer does not resend for a route it has not left.
   */
  pendingForegroundWorkstreamId?: string | null;
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

const CONNECTOR_EVENT_INGRESS_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60_000;

/** The identity of a repeat ingest dropped, kept so it can be restored. */
interface DroppedConnectorEventIdentity {
  eventId: string;
  payloadHash: string;
  providerEventId: string;
  dedupeKey: string;
  occurredAt: number;
  receivedAt: number;
  payloadRef: string | null;
}

// Queue consumers have a 15-minute platform wall-time limit. This expiry is
// only for Queue claims. A retiring Workflow can retry multiple 15-minute
// processing attempts, so its claim remains exclusive until it settles.
const CONNECTOR_EVENT_PROCESSING_LEASE_MS = 15 * 60_000;
// Ninety days, set by the owner on 2026-09-26. Processed event bodies are the
// largest rows in the object: the busiest Organization adds about 0.26 GB a
// week, so the earlier 396 days held about 14.7 GB against the 10 GB object
// ceiling, and 90 days holds about 3.3 GB. Every reader of a processed event
// (a run's trigger context, a watched resource's event) reaches back well
// inside that. Only
// processed rows age out: their two unique keys are the replay fence, so a
// provider redelivering an event older than this would be processed again.
const CONNECTOR_EVENT_BODY_RETENTION_MS = 90 * 24 * 60 * 60_000;
/**
 * Processed event bodies deleted per alarm pass. The number the ingest path
 * used before the reap moved here; the alarm re-arms at once while any are
 * due, so a backlog drains a page at a time.
 */
const CONNECTOR_EVENT_REAP_PAGE = 50;
/** How often a workspace rechecks a region that is closed for maintenance. */
const MAINTENANCE_RECHECK_MS = 5 * 60_000;
/**
 * How long an accepted socket may go unheard, whether or not its client has
 * since given up on it, before the instance is treated as no longer receiving
 * socket events, and reset.
 *
 * Set 2026-09-24 by the team (two minutes), not derived here; see
 * docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: time from accepting a workspace socket to its first frame.
 * Without it: an object that stops delivering socket events stays stuck, and
 *   every desktop without a warm cache sits at "Opening channels…", until the
 *   next deploy (docs/realtime-sockets.md, "An instance that stops hearing its
 *   sockets").
 * Direction: upper bound.
 * Trips: when the object has also heard from no other socket since (see
 *   `socket-first-frame-watch.ts`), the socket counts as missed. Once
 *   `WORKSPACE_SOCKET_MISSED_SOCKETS_BEFORE_RESET` sockets are missed at once,
 *   the next alarm logs `workspace_socket_first_frame_missed` at error level
 *   and aborts the instance, which drops every socket; the platform starts a
 *   fresh one and clients reconnect on their own. Fewer are held and logged as
 *   `workspace_socket_first_frame_held` at warn level.
 * Derive from: the desktop sends `subscribe` the moment a socket opens, so a
 *   healthy object hears it within the round trip. Independent of the
 *   desktop's 65 s pong timeout, since the watch counts a socket from its
 *   ledger row rather than from the open socket.
 */
export const WORKSPACE_SOCKET_FIRST_FRAME_DEADLINE_MS = 2 * 60_000;
/**
 * How many sockets must be missed at once before WorkspaceDO resets itself.
 *
 * Set 2026-09-30 by the team (two), not derived here; see
 * docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: resets caused by one socket its client never spoke on.
 * Without it: a lone member whose client goes away between the upgrade and
 *   `subscribe` resets an object that was never stuck, and pages
 *   #firehose-alert (docs/realtime-sockets.md, "What a false positive looks
 *   like").
 * Direction: lower bound on missed sockets; the value that restores the
 *   earlier behavior is 1.
 * Trips: below it, each missed socket is logged once per instance as
 *   `workspace_socket_first_frame_held` at warn level and kept in the ledger,
 *   so a later silent socket counts with it.
 * Derive from: the 2026-09-24 wedge, where the client opened a new socket
 *   every 65 to 120 s and none was heard. Two costs one more retry, about one
 *   to two minutes, before a real wedge recovers.
 */
export const WORKSPACE_SOCKET_MISSED_SOCKETS_BEFORE_RESET = 2;
/** The one-shot entry a migrating object uses to reconcile itself once. */
const SCHEDULE_BOOTSTRAP_ALARM_KIND = "schedule_bootstrap";
/**
 * `_internal_durable_alarms` kinds whose work is retired, answered with
 * nothing to do: suggested work's scheduler (`product`), migration 103's
 * Personal Channel seating (`personal_channel_backfill`), and a Thread's or
 * Channel's participant handoff (plan step C-2).
 */
const RETIRED_ALARM_KINDS: ReadonlySet<string> = new Set([
  "product", "personal_channel_backfill", PARTICIPANT_PROJECTION_ALARM, PARTICIPANT_MIGRATION_ALARM,
]);

function isWorkspaceScheduleAlarmKind(kind: string): kind is WorkspaceScheduleTargetKind {
  return (WORKSPACE_SCHEDULE_ALARM_KINDS as readonly string[]).includes(kind);
}

/**
 * Every table emptied when `projects` is dropped: four cascade from it
 * directly, and two more cascade from `project_default_resources` beneath it.
 * Ordered parents-first so the list can be replayed as inserts.
 */

const PROJECT_CASCADE_DEPENDENTS = [
  "project_participants",
  "workspace_project_order",
  "project_workstream_memberships",
  "project_default_resources",
  "project_default_resource_targets",
  "project_default_resource_publications",
] as const;

/**
 * Retire Projects: settle every undelivered effect, then drop the tables.
 *
 * Two steps in one transaction, and the order is the whole point.
 *
 * **Invalidate.** Every unsettled default target becomes `terminal` with
 * `project_retired` on it, and every unaccepted publication is accepted. Those
 * rows are the durable half of an at-least-once delivery; a Queue message
 * naming one may still be in flight, and what stops it writing into a Channel
 * whose audience the cutover has just changed is that the consumer finds
 * nothing current. The consumer leg stays for the platform's retry window and
 * acknowledges every redelivery as a tombstone.
 *
 * **Drop.** Children before parents, because `PRAGMA foreign_keys = OFF` is
 * silently a no-op once anything in the same Durable Object event has touched
 * SQLite (`docs/durable-object-sqlite.md`), so a parent dropped first would
 * cascade its children away and hide whichever of them still held rows.
 *
 * **There is no barrier in between, and there cannot be one.** This shipped
 * with a scratch table whose CHECK asserted that no `pending` row was left —
 * counted after the statements above had just settled every one of them, so
 * the count was zero by construction and the assertion could only ever pass.
 * A barrier that reads its own writes is not a gate. The PRD's "zero unsettled
 * Project effects" is met by the invalidation plus the tombstone consumer
 * rather than by an assertion: an undelivered Project default is *dropped*,
 * which is what PRD non-goal 5 asks for — Projects are deleted rather than
 * converted, so a default that never reached a Channel is not owed to anybody.
 *
 * Applied Channel state is untouched. A resource a Project delivered is
 * attached to the Channel's own authority, and this deletes the Organization's
 * record of *why* it was delivered, never the attachment.
 */
const PROJECT_RETIREMENT_STATEMENTS: readonly string[] = [
  `UPDATE project_default_resource_targets
      SET state = 'terminal', last_error_code = 'project_retired',
          updated_at = unixepoch() * 1000
    WHERE state = 'pending'`,
  `UPDATE project_default_resource_publications
      SET state = 'accepted', accepted_at = unixepoch() * 1000,
          updated_at = unixepoch() * 1000
    WHERE state = 'pending'`,
  ...[...PROJECT_CASCADE_DEPENDENTS].reverse().map((table) => `DROP TABLE ${table}`),
  `DROP TABLE workspace_project_state`,
  `DROP TABLE projects`,
];

/**
 * Palette snapshots, frozen per migration.
 *
 * A CHECK vocabulary is baked into the text of the statement that created the
 * table, so interpolating a live constant here means editing already-shipped
 * SQL every time the palette moves: objects created before the edit keep the
 * old vocabulary, objects created after get the new one, and nothing records
 * that they diverged. Each migration therefore pins the list as it stood when
 * that migration shipped, and widening the vocabulary is a new migration.
 *
 * `workspace-project-palette.test.ts` asserts the newest snapshot still covers
 * `PROJECT_COLOR_KEYS_STORABLE`, so adding a colour without a migration fails
 * the build rather than the insert.
 */
const PROJECT_COLOR_KEYS_AT_V14 = [
  "gray", "brown", "red", "orange", "yellow", "green",
  "teal", "cyan", "blue", "indigo", "purple", "pink",
] as const;

/**
 * Icons as they stood at v14, which is also how they stand at v45 — the set has
 * never changed. Pinned for the same reason the colours are: a CHECK vocabulary
 * lives in shipped SQL text and must stop moving when the live constant does.
 */
const PROJECT_ICON_KEYS_FROZEN = [
  "briefcase", "target", "calendar-days", "list-checks", "clipboard-list",
  "file-text", "folder", "lightbulb", "star", "flag",
  "rocket", "chart-no-axes-combined", "calculator", "coins", "users",
  "user-search", "handshake", "megaphone", "palette", "image",
  "pen-tool", "package", "building-2", "globe-2", "heart",
] as const;

/**
 * The v14 twelve, plus the hue ring that replaced them and the `black` the
 * account accents took. This is what migration 45 builds its CHECK from; see
 * the snapshot rationale on `PROJECT_COLOR_KEYS_AT_V14`.
 */
const PROJECT_COLOR_KEYS_AT_V45 = [
  "black", "rose", "red", "orange", "amber", "lime", "green", "emerald",
  "cyan", "blue", "indigo", "violet", "purple", "fuchsia", "pink",
  "gray", "brown", "yellow", "teal",
] as const;

function projectRegistrySql(values: readonly string[]): string {
  return values.map((value) => `'${value.replaceAll("'", "''")}'`).join(", ");
}

/**
 * The workspace-identity guards on `automation_directory`.
 *
 * Shared with the v26 rebuild, which drops the table and drops these with it.
 * Recreating them there by hand is what left every upgraded object without the
 * guard while a fresh one kept it — two schemas in one fleet, and the only
 * thing standing between a cross-workspace directory row and the serving path
 * gone on every object that had ever run.
 *
 * Byte-identical to what the base migration shipped, because a migration
 * statement is hashed verbatim into `_sql_schema_migrations`: re-indenting them
 * here would make every deployed object refuse to boot.
 */
function automationDirectoryWorkspaceIdentityGuards(): string[] {
  return [
    `CREATE TRIGGER automation_directory_workspace_identity_insert
      BEFORE INSERT ON automation_directory
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER automation_directory_workspace_identity_update
      BEFORE UPDATE OF workspace_id ON automation_directory
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
  ];
}

/**
 * Frozen inventory through v53 of tables a `DROP TABLE connector_connections` would take with
 * it — twelve that cascade and `connector_oauth_attempts`, whose connection
 * pointer would be nulled. Migration 31 copies each one out and back around
 * the parent's replacement.
 *
 * A list rather than a query over `sqlite_schema`: a migration's statements are
 * hashed into every object's receipt, so what it does has to be decided in
 * source rather than by whatever an individual database happens to hold.
 * Do not extend this historical list: v54 adds connector_installations with
 * a non-cascading foreign key. A later parent rebuild must declare a new
 * inventory including it, without changing v31/v53 statement fingerprints.
 */
const CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V53 = [
  "connector_oauth_attempts",
  "slack_agent_contexts",
  "slack_agent_feedback",
  "slack_agent_pending_prompts",
  "slack_agent_policies",
  "slack_agent_sessions",
  "slack_agent_thread_claims",
  "slack_delivery_preferences",
  "slack_ingress_jobs",
  "slack_link_challenges",
  "slack_unfurled_links",
  "slack_user_links",
  "webhook_receipts",
] as const;

/**
 * The same inventory as of v55, which is the first parent rebuild after v54
 * added `connector_installations`.
 *
 * Two things make it a separate constant rather than an edit to the list above.
 * A migration's statements are hashed into every deployed object's receipt, so
 * changing v31's or v53's text would invalidate receipts that already committed.
 * And `connector_installations` behaves differently from the other thirteen:
 * its foreign key carries no `ON DELETE` action, so the implicit `DELETE` inside
 * `DROP TABLE connector_connections` does not empty it — it *aborts the drop*.
 * Migration 55 therefore empties every dependent explicitly before replacing the
 * parent, rather than letting the cascade do it, which is the one way the recipe
 * differs from 53's.
 *
 * A table missing from this list loses its rows. The next parent rebuild
 * declares its own inventory again, from the schema as of that version.
 */
export const CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55 = [
  ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V53,
  "connector_installations",
] as const;

/**
 * Every table that cascades from `memory_scopes`, parent-first, so a restore
 * in this order never inserts a child before its parent. The last three reach
 * the scope through `memory_tables` and `memory_table_rows` rather than
 * directly, and would be emptied all the same.
 */
const MEMORY_SCOPE_DEPENDENTS = [
  "memory_items",
  "memory_mutations",
  "memory_index_outbox",
  "memory_tables",
  "memory_table_columns",
  "memory_table_rows",
  "memory_table_cells",
  "memory_table_mutations",
] as const;

// Frozen v121 inventory: migrations 63–120 add no connector foreign keys.
const CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V121 = [
  ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55,
] as const;

// Frozen v62 inventory: migrations 56–61 add no connector foreign keys.
const CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V62 = [
  ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55,
] as const;

/**
 * The version-capture triggers as migration 112 left them, named so migration
 * 113 can drop and restore them around the cause columns it replaces: SQLite
 * refuses to drop a column a trigger reads.
 */
const RESOURCES_CREATE_INITIAL_VERSION_V112 = `CREATE TRIGGER resources_create_initial_version
       AFTER INSERT ON resources BEGIN
         INSERT INTO resource_versions
           (resource_id, workspace_id, version, connection_id, resource_type, provider,
            provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
            last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
            model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
            model_content_status, model_content_extractor_version, model_content_character_count,
            model_content_extracted_at, model_content_error_code, captured_at,
            author_kind, author_run_id, author_user_id, author_connection_id, cause,
            storage_kind, on_behalf_of_user_id)
         VALUES
           (NEW.id, NEW.workspace_id, NEW.current_version, NEW.connection_id, NEW.resource_type, NEW.provider,
            NEW.provider_resource_id, NEW.title, NEW.mime_type, NEW.content_ref, NEW.canonical_url, NEW.metadata_json,
            NEW.last_hydrated_at, NEW.uploaded_by_user_id, NEW.attachment_status, NEW.model_content_ref,
            NEW.model_mime_type, NEW.model_content_sha256, NEW.model_metadata_json, NEW.content_sha256,
            NEW.model_content_status, NEW.model_content_extractor_version, NEW.model_content_character_count,
            NEW.model_content_extracted_at, NEW.model_content_error_code, NEW.updated_at,
            NEW.revision_author_kind, NEW.revision_author_run_id, NEW.revision_author_user_id,
            NEW.revision_author_connection_id, NEW.revision_cause,
            NEW.revision_storage_kind, NEW.revision_on_behalf_of_user_id);
         UPDATE resources
            SET revision_author_kind = NULL, revision_author_run_id = NULL,
                revision_author_user_id = NULL, revision_author_connection_id = NULL,
                revision_cause = NULL, revision_storage_kind = 'object',
                revision_on_behalf_of_user_id = NULL
          WHERE id = NEW.id;
       END`;

const RESOURCES_CREATE_SEMANTIC_VERSION_V112 = `CREATE TRIGGER resources_create_semantic_version
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
            model_content_extracted_at, model_content_error_code, captured_at,
            author_kind, author_run_id, author_user_id, author_connection_id, cause,
            storage_kind, on_behalf_of_user_id)
         SELECT id, workspace_id, current_version, connection_id, resource_type, provider,
                provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
                last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
                model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
                model_content_status, model_content_extractor_version, model_content_character_count,
                model_content_extracted_at, model_content_error_code, updated_at,
                revision_author_kind, revision_author_run_id, revision_author_user_id,
                revision_author_connection_id, revision_cause, revision_storage_kind,
                revision_on_behalf_of_user_id
           FROM resources WHERE id = NEW.id;
         UPDATE resources
            SET revision_author_kind = NULL, revision_author_run_id = NULL,
                revision_author_user_id = NULL, revision_author_connection_id = NULL,
                revision_cause = NULL, revision_storage_kind = 'object',
                revision_on_behalf_of_user_id = NULL
          WHERE id = NEW.id;
       END`;

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
    // As in the AgentLoopDO's migration 11, version 1 still creates these
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
    // and editing them in place emits `workspace_do_schema_hash_mismatch:4`.
    // The warning no longer blocks construction, but an appended migration is
    // still the only way to make old and new object schemas converge.
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
    // and editing them in place emits `workspace_do_schema_hash_mismatch:1`
    // for every workspace that ran an earlier release. A new object therefore
    // creates the old shape and immediately rebuilds it,
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
}, {
  version: 14,
  description: "make WorkspaceDO authoritative for projects and per-person ordering",
  statements: [
    `CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      normalized_name TEXT NOT NULL CHECK (length(normalized_name) > 0),
      icon_key TEXT NOT NULL CHECK (icon_key IN (${projectRegistrySql(PROJECT_ICON_KEYS_FROZEN)})),
      icon_color_key TEXT NOT NULL CHECK (icon_color_key IN (${projectRegistrySql(PROJECT_COLOR_KEYS_AT_V14)})),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      status TEXT NOT NULL CHECK (status IN (
        'active', 'archiving', 'archived', 'restoring', 'cancelling_restore'
      )),
      creator_user_id TEXT NOT NULL,
      archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
      archived_by_user_id TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      presentation_revision INTEGER NOT NULL DEFAULT 1 CHECK (presentation_revision > 0),
      audience_generation INTEGER NOT NULL DEFAULT 1 CHECK (audience_generation > 0),
      lifecycle_generation INTEGER NOT NULL DEFAULT 1 CHECK (lifecycle_generation > 0),
      CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
      CHECK ((archived_at IS NULL) = (archived_by_user_id IS NULL))
    ) STRICT`,
    `CREATE TABLE project_participants (
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('adding', 'active', 'removing', 'removed')),
      generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY (project_id, user_id)
    ) STRICT`,
    `CREATE INDEX project_participants_user_state_idx
      ON project_participants(user_id, state, project_id)`,
    `CREATE TABLE workspace_project_order (
      user_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY (user_id, project_id)
    ) STRICT`,
    `CREATE INDEX workspace_project_order_user_position_idx
      ON workspace_project_order(user_id, position, project_id)`,
    `CREATE TABLE workspace_project_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      waterline INTEGER NOT NULL CHECK (waterline >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
    ) STRICT`,
    `INSERT INTO workspace_project_state (id, waterline, updated_at) VALUES (1, 0, 0)`,
  ],
}, {
  version: 15,
  description: "stage many-to-many project membership for work streams",
  statements: [
    `CREATE TABLE project_workstream_memberships (
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      workstream_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('joining', 'active', 'removing', 'removed')),
      generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
      joined_at INTEGER NOT NULL CHECK (joined_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      removed_at INTEGER CHECK (removed_at IS NULL OR removed_at >= 0),
      CHECK ((state = 'removed') = (removed_at IS NOT NULL)),
      PRIMARY KEY (project_id, workstream_id)
    ) STRICT`,
    `CREATE INDEX project_workstream_memberships_workstream_state_idx
      ON project_workstream_memberships(workstream_id, state, project_id)`,
    `CREATE INDEX project_workstream_memberships_project_state_idx
      ON project_workstream_memberships(project_id, state, workstream_id)`,
  ],
}, {
  version: 16,
  description: "store project defaults and their per-work-stream Queue targets",
  statements: [
    `CREATE TABLE project_default_resources (
      project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      resource_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
      generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      removed_at INTEGER CHECK (removed_at IS NULL OR removed_at >= 0),
      CHECK ((state = 'removed') = (removed_at IS NOT NULL)),
      PRIMARY KEY (project_id, resource_id)
    ) STRICT`,
    `CREATE TABLE project_default_resource_targets (
      project_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      default_generation INTEGER NOT NULL CHECK (default_generation > 0),
      workstream_id TEXT NOT NULL,
      membership_generation INTEGER NOT NULL CHECK (membership_generation > 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'terminal')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      applied_at INTEGER CHECK (applied_at IS NULL OR applied_at >= 0),
      last_error_code TEXT,
      PRIMARY KEY (project_id, resource_id, default_generation, workstream_id, membership_generation),
      FOREIGN KEY (project_id, resource_id) REFERENCES project_default_resources(project_id, resource_id)
        ON DELETE CASCADE
    ) STRICT`,
    `CREATE INDEX project_default_resource_targets_pending_idx
      ON project_default_resource_targets(state, project_id, resource_id, workstream_id)`,
  ],
}, {
  version: 17,
  description: "publish project default-resource targets through a durable outbox",
  statements: [
    `CREATE TABLE project_default_resource_publications (
      project_id TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      default_generation INTEGER NOT NULL CHECK (default_generation > 0),
      workstream_id TEXT NOT NULL,
      membership_generation INTEGER NOT NULL CHECK (membership_generation > 0),
      requested_by_user_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'accepted')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      accepted_at INTEGER CHECK (accepted_at IS NULL OR accepted_at >= 0),
      PRIMARY KEY (project_id, resource_id, default_generation, workstream_id, membership_generation),
      FOREIGN KEY (project_id, resource_id, default_generation, workstream_id, membership_generation)
        REFERENCES project_default_resource_targets(
          project_id, resource_id, default_generation, workstream_id, membership_generation
        ) ON DELETE CASCADE
    ) STRICT`,
    `CREATE INDEX project_default_resource_publications_due_idx
      ON project_default_resource_publications(state, next_attempt_at, project_id, resource_id)`,
    `INSERT INTO project_default_resource_publications (
       project_id, resource_id, default_generation, workstream_id, membership_generation,
       requested_by_user_id, state, attempts, next_attempt_at, created_at, updated_at, accepted_at
     )
     SELECT target.project_id, target.resource_id, target.default_generation, target.workstream_id,
            target.membership_generation, project.creator_user_id, 'pending', 0,
            target.updated_at, target.created_at, target.updated_at, NULL
       FROM project_default_resource_targets target
       JOIN projects project ON project.project_id = target.project_id
      WHERE target.state = 'pending'`,
  ],
}, {
  version: 18,
  description: "attribute every retained resource version to who moved its pointers and why",
  statements: [
    // Provenance is staged on the resource row rather than passed to capture,
    // because capture is a trigger: a swap that sets these columns in the same
    // UPDATE gives its version an author with nothing in between to go wrong.
    //
    // Staging is *consumed*: both capture triggers null these columns after
    // reading them, so they hold an author only for the one capture that swap
    // causes. Without that, every later writer of a captured column — the
    // derivative service healing a hash, a provider webhook renaming a page,
    // the origin backfill — mints a version wearing the previous swapper's
    // name, which is a confident lie where the honest answer is "not
    // recorded". None of these columns is in either trigger's `UPDATE OF`
    // list, so releasing them cannot re-enter capture.
    `ALTER TABLE resources ADD COLUMN revision_author_kind TEXT
       CHECK (revision_author_kind IS NULL
         OR revision_author_kind IN ('agent', 'member', 'connector', 'system'))`,
    `ALTER TABLE resources ADD COLUMN revision_author_run_id TEXT`,
    `ALTER TABLE resources ADD COLUMN revision_author_user_id TEXT`,
    `ALTER TABLE resources ADD COLUMN revision_author_connection_id TEXT`,
    `ALTER TABLE resources ADD COLUMN revision_cause TEXT
       CHECK (revision_cause IS NULL
         OR revision_cause IN ('created', 'published', 'refetched', 'replaced'))`,
    // Staged like the rest, so the shape a version records is chosen by the
    // swap that creates it. Without this, capture could only ever write the
    // default, and the seam below would be reachable solely by updating a
    // version row after the fact — the second statement this design avoids.
    `ALTER TABLE resources ADD COLUMN revision_storage_kind TEXT NOT NULL DEFAULT 'object'`,
    // NULL is the honest answer for history captured before this version: the
    // rows record which pointers a state held, and nothing recorded who moved
    // them. Every capture after this migration carries an author or none
    // because its producer has not been taught one yet.
    `ALTER TABLE resource_versions ADD COLUMN author_kind TEXT
       CHECK (author_kind IS NULL
         OR author_kind IN ('agent', 'member', 'connector', 'system'))`,
    `ALTER TABLE resource_versions ADD COLUMN author_run_id TEXT`,
    `ALTER TABLE resource_versions ADD COLUMN author_user_id TEXT`,
    `ALTER TABLE resource_versions ADD COLUMN author_connection_id TEXT`,
    `ALTER TABLE resource_versions ADD COLUMN cause TEXT
       CHECK (cause IS NULL
         OR cause IN ('created', 'published', 'refetched', 'replaced'))`,
    // What kind of thing the refs name. Every row says an immutable object in
    // the region's bucket, because every capture today is one — the value is
    // staged rather than assumed, so a later storage shape (the collaborative
    // editor's materialized snapshots) sets it the way an author is set. No
    // CHECK, so a new kind is a value its writer chooses rather than a
    // constraint SQLite would need the table rebuilt to alter.
    `ALTER TABLE resource_versions ADD COLUMN storage_kind TEXT NOT NULL DEFAULT 'object'`,
    // An identity that its kind cannot have is attribution the rail would
    // render as fact, so capture refuses it rather than storing it.
    `CREATE TRIGGER resource_versions_provenance_fence_insert
       BEFORE INSERT ON resource_versions
       WHEN (NEW.author_kind IS NULL AND (NEW.author_run_id IS NOT NULL
              OR NEW.author_user_id IS NOT NULL OR NEW.author_connection_id IS NOT NULL))
         OR (NEW.author_kind = 'agent' AND (NEW.author_run_id IS NULL
              OR NEW.author_user_id IS NOT NULL OR NEW.author_connection_id IS NOT NULL))
         OR (NEW.author_kind = 'member' AND (NEW.author_user_id IS NULL
              OR NEW.author_run_id IS NOT NULL OR NEW.author_connection_id IS NOT NULL))
         OR (NEW.author_kind = 'connector' AND (NEW.author_connection_id IS NULL
              OR NEW.author_run_id IS NOT NULL OR NEW.author_user_id IS NOT NULL))
         OR (NEW.author_kind = 'system' AND (NEW.author_run_id IS NOT NULL
              OR NEW.author_user_id IS NOT NULL OR NEW.author_connection_id IS NOT NULL))
       BEGIN SELECT RAISE(ABORT, 'resource_version_provenance_mismatch'); END`,
    `DROP TRIGGER resources_create_initial_version`,
    `CREATE TRIGGER resources_create_initial_version
       AFTER INSERT ON resources BEGIN
         INSERT INTO resource_versions
           (resource_id, workspace_id, version, connection_id, resource_type, provider,
            provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
            last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
            model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
            model_content_status, model_content_extractor_version, model_content_character_count,
            model_content_extracted_at, model_content_error_code, captured_at,
            author_kind, author_run_id, author_user_id, author_connection_id, cause,
            storage_kind)
         VALUES
           (NEW.id, NEW.workspace_id, NEW.current_version, NEW.connection_id, NEW.resource_type, NEW.provider,
            NEW.provider_resource_id, NEW.title, NEW.mime_type, NEW.content_ref, NEW.canonical_url, NEW.metadata_json,
            NEW.last_hydrated_at, NEW.uploaded_by_user_id, NEW.attachment_status, NEW.model_content_ref,
            NEW.model_mime_type, NEW.model_content_sha256, NEW.model_metadata_json, NEW.content_sha256,
            NEW.model_content_status, NEW.model_content_extractor_version, NEW.model_content_character_count,
            NEW.model_content_extracted_at, NEW.model_content_error_code, NEW.updated_at,
            NEW.revision_author_kind, NEW.revision_author_run_id, NEW.revision_author_user_id,
            NEW.revision_author_connection_id, NEW.revision_cause,
            NEW.revision_storage_kind);
         UPDATE resources
            SET revision_author_kind = NULL, revision_author_run_id = NULL,
                revision_author_user_id = NULL, revision_author_connection_id = NULL,
                revision_cause = NULL, revision_storage_kind = 'object'
          WHERE id = NEW.id;
       END`,
    `DROP TRIGGER resources_create_semantic_version`,
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
            model_content_extracted_at, model_content_error_code, captured_at,
            author_kind, author_run_id, author_user_id, author_connection_id, cause,
            storage_kind)
         SELECT id, workspace_id, current_version, connection_id, resource_type, provider,
                provider_resource_id, title, mime_type, content_ref, canonical_url, metadata_json,
                last_hydrated_at, uploaded_by_user_id, attachment_status, model_content_ref,
                model_mime_type, model_content_sha256, model_metadata_json, content_sha256,
                model_content_status, model_content_extractor_version, model_content_character_count,
                model_content_extracted_at, model_content_error_code, updated_at,
                revision_author_kind, revision_author_run_id, revision_author_user_id,
                revision_author_connection_id, revision_cause, revision_storage_kind
           FROM resources WHERE id = NEW.id;
         UPDATE resources
            SET revision_author_kind = NULL, revision_author_run_id = NULL,
                revision_author_user_id = NULL, revision_author_connection_id = NULL,
                revision_cause = NULL, revision_storage_kind = 'object'
          WHERE id = NEW.id;
       END`,
  ],
}, {
  version: 19,
  description: "give every resource a short token-friendly alias beside its UUID",
  statements: [
    // Nothing in SQL can mint one — the generator is an HMAC over the
    // resource's coordinates — so existing rows start without an alias and a
    // bounded maintenance pass fills them in. Null is not a placeholder here:
    // a resource without an alias is addressed by UUID, which every internal
    // reference, storage key, and receipt uses regardless.
    `ALTER TABLE resources ADD COLUMN slug TEXT`,
    // Partial, so the rows still waiting on the pass do not collide with each
    // other. The object is one workspace, so unique here is unique per
    // workspace; a collision costs the allocator one more attempt.
    `CREATE UNIQUE INDEX resources_slug_idx ON resources(slug) WHERE slug IS NOT NULL`,
  ],
}, {
  version: 20,
  description: "reserve upload drafts while work-stream inputs are pending",
  statements: [
    `CREATE TABLE pending_attachment_reservations (
      workspace_id TEXT NOT NULL CHECK (length(workspace_id) = 36),
      workstream_id TEXT NOT NULL CHECK (length(workstream_id) = 36),
      input_id TEXT NOT NULL CHECK (length(input_id) = 36),
      resource_id TEXT NOT NULL CHECK (length(resource_id) = 36)
        REFERENCES resources(id) ON DELETE RESTRICT,
      user_id TEXT NOT NULL CHECK (length(user_id) = 36),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      PRIMARY KEY (input_id, resource_id)
    ) STRICT`,
    `CREATE INDEX pending_attachment_reservations_resource_idx
      ON pending_attachment_reservations(resource_id, workstream_id, input_id)`,
    `CREATE TRIGGER pending_attachment_reservations_workspace_identity_insert
      BEFORE INSERT ON pending_attachment_reservations
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER pending_attachment_reservations_workspace_identity_update
      BEFORE UPDATE OF workspace_id ON pending_attachment_reservations
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
  ],
}, {
  version: 21,
  description: "fence in-flight resource objects from asynchronous cleanup",
  statements: [
    // Publication registers an object before its R2 write so a failed request
    // cannot orphan bytes. Until the writer either publishes a pointer or
    // releases that registration, cleanup must not interpret the absence of a
    // pointer as abandonment: the writer may be between the R2 put and its
    // WorkspaceDO commit.
    `ALTER TABLE resource_object_deletion_outbox
       ADD COLUMN cleanup_eligible INTEGER NOT NULL DEFAULT 1
       CHECK (cleanup_eligible IN (0, 1))`,
    // The pre-existing lifecycle triggers enqueue superseded and deleted
    // pointers with INSERT OR IGNORE. If the same object is still carrying a
    // staging row, that insert correctly preserves one ownership record but
    // must also hand it from the publisher to cleanup. Separate promotion
    // triggers keep the released trigger bodies immutable and are correct in
    // either SQLite trigger order: they update an existing staged row, while a
    // missing row is inserted eligible by the original trigger's default.
    `CREATE TRIGGER resources_promote_replaced_original_after_update
       AFTER UPDATE OF content_ref ON resources
       WHEN OLD.content_ref IS NOT NEW.content_ref AND OLD.content_ref IS NOT NULL BEGIN
         UPDATE resource_object_deletion_outbox
            SET cleanup_eligible = 1, updated_at = datetime('now')
          WHERE workspace_id = OLD.workspace_id AND object_ref = OLD.content_ref;
       END`,
    `CREATE TRIGGER resources_promote_replaced_model_after_update
       AFTER UPDATE OF model_content_ref ON resources
       WHEN OLD.model_content_ref IS NOT NEW.model_content_ref
        AND OLD.model_content_ref IS NOT NULL BEGIN
         UPDATE resource_object_deletion_outbox
            SET cleanup_eligible = 1, updated_at = datetime('now')
          WHERE workspace_id = OLD.workspace_id AND object_ref = OLD.model_content_ref;
       END`,
    `CREATE TRIGGER resources_promote_objects_after_delete
       AFTER DELETE ON resources BEGIN
         UPDATE resource_object_deletion_outbox
            SET cleanup_eligible = 1, updated_at = datetime('now')
          WHERE workspace_id = OLD.workspace_id
            AND (object_ref = OLD.content_ref OR object_ref = OLD.model_content_ref);
       END`,
    `CREATE TRIGGER resource_versions_promote_objects_after_delete
       AFTER DELETE ON resource_versions BEGIN
         UPDATE resource_object_deletion_outbox
            SET cleanup_eligible = 1, updated_at = datetime('now')
          WHERE workspace_id = OLD.workspace_id
            AND (object_ref = OLD.content_ref OR object_ref = OLD.model_content_ref);
       END`,
  ],
}, {
  version: 22,
  description: "index durable automations and typed external-event destinations",
  statements: [
    `CREATE TABLE automation_creation_claims (
      workspace_id TEXT NOT NULL,
      author_user_id TEXT NOT NULL,
      client_creation_key TEXT NOT NULL,
      automation_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      PRIMARY KEY(workspace_id, author_user_id, client_creation_key)
    ) STRICT`,
    `CREATE TABLE automation_directory (
      automation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      author_user_id TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      projection_version INTEGER NOT NULL CHECK (projection_version > 0),
      payload_hash TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'activating', 'active', 'paused', 'deleted')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      next_run_at INTEGER,
      attention_code TEXT,
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0)
    ) STRICT`,
    `CREATE INDEX automation_directory_sidebar_idx
      ON automation_directory(workspace_id, lifecycle, projected_at DESC, automation_id)`,
    `CREATE TABLE workspace_external_event_registrations (
      registration_id TEXT PRIMARY KEY,
      destination_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      projection_version INTEGER NOT NULL CHECK (projection_version > 0),
      source_hash TEXT NOT NULL,
      effective_after_event_sequence INTEGER NOT NULL CHECK (effective_after_event_sequence >= 0),
      connection_id TEXT NOT NULL,
      connector_type TEXT NOT NULL,
      event_type TEXT NOT NULL,
      resource_id TEXT,
      evaluator_json TEXT NOT NULL CHECK (json_valid(evaluator_json)),
      destination_kind TEXT NOT NULL CHECK (destination_kind IN ('automation', 'workstream_resource_update')),
      automation_id TEXT,
      workstream_id TEXT,
      substream_id TEXT,
      destination_resource_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('active', 'removed', 'integrity_failed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (destination_kind = 'automation' AND automation_id IS NOT NULL
          AND workstream_id IS NULL AND substream_id IS NULL AND destination_resource_id IS NULL)
        OR
        (destination_kind = 'workstream_resource_update' AND automation_id IS NULL
          AND workstream_id IS NOT NULL AND substream_id IS NOT NULL AND destination_resource_id IS NOT NULL)
      ),
      UNIQUE(registration_id, authority_generation, projection_version)
    ) STRICT`,
    `CREATE INDEX workspace_external_event_candidates_idx
      ON workspace_external_event_registrations(
        connection_id, event_type, resource_id, state, registration_id
      )`,
    `CREATE INDEX workspace_external_event_destination_idx
      ON workspace_external_event_registrations(
        destination_kind, destination_key, authority_generation, projection_version
      )`,
    `CREATE TABLE workspace_external_event_deliveries (
      delivery_id TEXT PRIMARY KEY,
      workspace_event_id TEXT NOT NULL REFERENCES workspace_connector_events(event_id) ON DELETE CASCADE,
      event_sequence INTEGER NOT NULL CHECK (event_sequence > 0),
      registration_id TEXT NOT NULL REFERENCES workspace_external_event_registrations(registration_id),
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      projection_version INTEGER NOT NULL CHECK (projection_version > 0),
      source_hash TEXT NOT NULL,
      destination_kind TEXT NOT NULL CHECK (destination_kind IN ('automation', 'workstream_resource_update')),
      destination_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('pending', 'delivering', 'delivered', 'not_delivered', 'failed')),
      outcome_code TEXT,
      lease_id TEXT,
      lease_expires_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(workspace_event_id, registration_id, authority_generation, destination_id)
    ) STRICT`,
    `CREATE INDEX workspace_external_event_deliveries_pending_idx
      ON workspace_external_event_deliveries(state, created_at, delivery_id)`,
    `CREATE TABLE automation_cutover_campaign (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      workspace_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('legacy', 'fenced', 'importing', 'cleaning', 'completed')),
      source_hash TEXT,
      source_witness_json TEXT CHECK (source_witness_json IS NULL OR json_valid(source_witness_json)),
      cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
      completed_at INTEGER,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `CREATE TRIGGER automation_creation_claims_workspace_identity_insert
      BEFORE INSERT ON automation_creation_claims
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER automation_creation_claims_workspace_identity_update
      BEFORE UPDATE OF workspace_id ON automation_creation_claims
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    ...automationDirectoryWorkspaceIdentityGuards(),
    `CREATE TRIGGER workspace_external_event_registrations_workspace_identity_insert
      BEFORE INSERT ON workspace_external_event_registrations
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER workspace_external_event_registrations_workspace_identity_update
      BEFORE UPDATE OF workspace_id ON workspace_external_event_registrations
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
  ],
}, {
  version: 23,
  description: "rebuild durable-memory vectors with the OpenRouter embedding space",
  statements: [
    // The existing 1,024-dimensional Vectorize indexes can store a reduced
    // Qwen3 Embedding 8B output, but the Workers AI 0.6B and OpenRouter 8B
    // coordinates are not comparable.
    // Requeue only each active item's current upsert; invalidated, expired, and
    // historical revisions stay retired. The projection writes a model-derived
    // namespace, so old vectors are unreachable throughout the rebuild.
    `UPDATE memory_index_outbox
        SET status = 'pending', attempt_count = 0,
            available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            lease_token = NULL, lease_expires_at = NULL, last_error = NULL,
            completed_at = NULL,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE operation = 'upsert'
        AND EXISTS (
          SELECT 1
            FROM memory_items item
           WHERE item.memory_item_id = memory_index_outbox.memory_item_id
             AND item.memory_scope_id = memory_index_outbox.memory_scope_id
             AND item.workspace_id = memory_index_outbox.workspace_id
             AND item.revision = memory_index_outbox.revision
             AND item.invalidated_at IS NULL
             AND (item.expires_at IS NULL OR item.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        )`,
    // Existing objects may otherwise have no reason to wake after the rows are
    // requeued. The one-shot bootstrap reconciles the memory maintenance target
    // into the shared alarm index; fresh objects have no identity and pay no
    // empty wake-up.
    `INSERT INTO _internal_durable_alarms
       (kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json,
        created_at, updated_at)
     SELECT 'schedule_bootstrap', 'workspace', unixepoch() * 1000, NULL, 0, 0, NULL,
            unixepoch() * 1000, unixepoch() * 1000
      WHERE EXISTS (SELECT 1 FROM workspace_identity WHERE id = 1)
     ON CONFLICT(kind, alarm_key) DO UPDATE SET
       due_at = MIN(due_at, excluded.due_at), retry_at = 0, attempt = 0,
       updated_at = excluded.updated_at`,
  ],
}, {
  version: 24,
  description: "store participant join time on the sidebar viewer overlay",
  statements: [
    // The facepile sorts by who joined, not by the last overlay rewrite.
    // `projected_at` moves on every unread and mention, and a message stamps
    // every participant with the same now(), so that column is UUID order.
    // Defaulted to NULL because every row already here predates the field;
    // NULL sorts last under DESC until the next directory_user effect lands.
    `ALTER TABLE workspace_workstream_viewers
       ADD COLUMN participant_added_at INTEGER
         CHECK (participant_added_at IS NULL OR participant_added_at >= 0)`,
  ],
}, {
  version: 25,
  description: "retire work-stream context suggestion feedback",
  statements: [
    `DROP TABLE workspace_workstream_suggestion_feedback`,
  ],
}, {
  version: 26,
  description: "freeze and receipt the note half of a generic batch",
  statements: [
    // NULL means the note archive has not been applied for this operation, and
    // is the state a fresh `mark_read` operation stays in, because `mark_read`
    // has nothing to do to a note.
    `ALTER TABLE workspace_batch_dispatches
       ADD COLUMN archived_note_count INTEGER
       CHECK (archived_note_count IS NULL OR archived_note_count >= 0)`,
    // Every row that predates this version belongs to an operation whose
    // confirmation named work streams and nothing else — the batch surface did
    // not reach notes at all. Zero is therefore the *true* receipt for it, and
    // writing it here is what stops a half-published operation that is retried
    // across this deploy from archiving notes its reader was never told about.
    // Left as NULL, that retry would read as "the note half has not run yet".
    `UPDATE workspace_batch_dispatches SET archived_note_count = 0`,
    // The note half's frozen target set, for the same reason the work-stream
    // half has one: the selection and the mutation are separate object calls,
    // and between them a note can enter the range — trivially so under an
    // open-ended heading like "Last hour". Without this the archive would take
    // rows the confirmation never counted, on the first attempt and not only on
    // a retry.
    //
    // No `dispatched_at` twin to the work-stream table: these are applied in
    // one statement here rather than published one message at a time, so there
    // is no partial progress through them to record.
    `CREATE TABLE workspace_batch_dispatch_note_targets (
      operation_id TEXT NOT NULL REFERENCES workspace_batch_dispatches(operation_id) ON DELETE CASCADE,
      note_id TEXT NOT NULL,
      PRIMARY KEY (operation_id, note_id)
    ) STRICT`,
  ],
}, {
  version: 27,
  description: "automations a work stream owns, and runs it has made visible",
  statements: [
    // A table rebuild, because SQLite cannot alter a CHECK in place and this
    // one has to admit a third scope. Copied whole and renamed, with the index
    // recreated after: the projection this table serves is read on every
    // sidebar open, and a rebuild that lost it would be a silent full scan.
    `CREATE TABLE automation_directory_v27 (
      automation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      author_user_id TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      projection_version INTEGER NOT NULL CHECK (projection_version > 0),
      payload_hash TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'activating', 'active', 'paused', 'deleted')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace', 'workstream')),
      -- Set exactly when the scope is 'workstream': the room that owns the
      -- automation, which is also the only room it can deliver into. The rail
      -- reads it; the sidebar excludes it.
      owning_workstream_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      next_run_at INTEGER,
      attention_code TEXT,
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0),
      CHECK ((scope = 'workstream') = (owning_workstream_id IS NOT NULL))
    ) STRICT`,
    `INSERT INTO automation_directory_v27
       (automation_id, workspace_id, author_user_id, authority_generation, projection_version,
        payload_hash, lifecycle, scope, owning_workstream_id, title, description,
        next_run_at, attention_code, projected_at)
     SELECT automation_id, workspace_id, author_user_id, authority_generation, projection_version,
            payload_hash, lifecycle, scope, NULL, title, description,
            next_run_at, attention_code, projected_at
       FROM automation_directory`,
    `DROP TABLE automation_directory`,
    `ALTER TABLE automation_directory_v27 RENAME TO automation_directory`,
    `CREATE INDEX automation_directory_sidebar_idx
      ON automation_directory(workspace_id, lifecycle, projected_at DESC, automation_id)`,
    // The rail's own read, which the sidebar index does not serve: it leads
    // with the workspace, and this one leads with the room.
    `CREATE INDEX automation_directory_workstream_idx
      ON automation_directory(owning_workstream_id, lifecycle, projected_at DESC)
      WHERE owning_workstream_id IS NOT NULL`,
    // Dropped with the table, so recreated with it. SQLite drops a table's
    // triggers when the table goes, and a rebuild that restores only the
    // indexes leaves the upgraded object without the one guard that stops a
    // row from another workspace reaching this directory.
    ...automationDirectoryWorkspaceIdentityGuards(),
    // What makes a run's own work stream visible. `origin_type` is never
    // rewritten — it is provenance, the run history still needs it, and an
    // exposed run is still a run.
    `ALTER TABLE workspace_workstream_directory ADD COLUMN automation_exposed INTEGER NOT NULL DEFAULT 0
       CHECK (automation_exposed IN (0, 1))`,
  ],
}, {
  // Renumbered from 26 during a rebase: `main` took 26 and 27 while this
  // branch was open, and a Durable Object migration is decided by its
  // number, so two 26s would diverge a fresh database from a hosted one.
  version: 28,
  description: "index live web artifacts beside the resource authority",
  statements: [
    // Beside `resources`, because an artifact *is* a resource with a serving
    // side: one row here per site resource, carrying what the resource row has
    // no column for. It is a per-workspace index for listing, revocation
    // fan-out, and cleanup — never the region-wide public-name authority. That
    // authority was added in platform D1 by its migration 0001; version 29 records
    // its already-reserved stub here. The UUID remains the supervisor name and
    // storage identity.
    `CREATE TABLE artifact_registry (
      artifact_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL,
      resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('static', 'active')),
      stateful INTEGER NOT NULL DEFAULT 0 CHECK (stateful IN (0, 1)),
      current_version INTEGER NOT NULL CHECK (current_version > 0),
      manifest_ref TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      UNIQUE(resource_id)
    ) STRICT`,
    // The revocation walk's workspace hop reads this: an artifact hangs off the
    // workspace, like an automation, because this table is what names them and
    // it lives here rather than in any work stream's own database.
    `CREATE INDEX artifact_registry_workspace_idx
      ON artifact_registry(workspace_id, updated_at DESC, artifact_id)`,
    `CREATE INDEX artifact_registry_workstream_idx
      ON artifact_registry(workstream_id, updated_at DESC, artifact_id)`,
    `CREATE TRIGGER artifact_registry_workspace_identity_insert
      BEFORE INSERT ON artifact_registry
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER artifact_registry_workspace_identity_update
      BEFORE UPDATE OF workspace_id ON artifact_registry
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
  ],
}, {
  version: 29,
  description: "give live artifacts public hostname stubs",
  statements: [
    // Nullable for artifacts published before stub-addressed origins shipped.
    // Their first authorized open allocates and materializes the immutable
    // regional route before filling this field.
    `ALTER TABLE artifact_registry ADD COLUMN hostname_stub TEXT`,
    `CREATE UNIQUE INDEX artifact_registry_hostname_stub_idx
      ON artifact_registry(hostname_stub) WHERE hostname_stub IS NOT NULL`,
    `CREATE TRIGGER artifact_registry_hostname_stub_shape_insert
      BEFORE INSERT ON artifact_registry
      WHEN NEW.hostname_stub IS NOT NULL AND (
        NEW.hostname_stub <> lower(NEW.hostname_stub)
        OR NEW.hostname_stub GLOB '*[^a-z-]*'
        OR NEW.hostname_stub GLOB '-*'
        OR NEW.hostname_stub GLOB '*-'
        OR NEW.hostname_stub GLOB '*--*'
        OR length(NEW.hostname_stub) - length(replace(NEW.hostname_stub, '-', '')) <> 3
      )
      BEGIN SELECT RAISE(ABORT, 'artifact_hostname_stub_invalid'); END`,
    `CREATE TRIGGER artifact_registry_hostname_stub_shape_update
      BEFORE UPDATE OF hostname_stub ON artifact_registry
      WHEN NEW.hostname_stub IS NOT NULL AND (
        NEW.hostname_stub <> lower(NEW.hostname_stub)
        OR NEW.hostname_stub GLOB '*[^a-z-]*'
        OR NEW.hostname_stub GLOB '-*'
        OR NEW.hostname_stub GLOB '*-'
        OR NEW.hostname_stub GLOB '*--*'
        OR length(NEW.hostname_stub) - length(replace(NEW.hostname_stub, '-', '')) <> 3
      )
      BEGIN SELECT RAISE(ABORT, 'artifact_hostname_stub_invalid'); END`,
    `CREATE TRIGGER artifact_registry_hostname_stub_immutable
      BEFORE UPDATE OF hostname_stub ON artifact_registry
      WHEN OLD.hostname_stub IS NOT NULL AND NEW.hostname_stub IS NOT OLD.hostname_stub
      BEGIN SELECT RAISE(ABORT, 'artifact_hostname_stub_immutable'); END`,
  ],
}, {
  version: 30,
  description: "park a ranking request that arrives while a pass is in flight",
  statements: [
    // Where a member's ranking request waits while a pass holds the lease.
    // `due_at` is that pass's own claim time until it settles, so a request
    // that took `MIN` against it inherited a time already past and ran the
    // moment the pass ended — under continuous admissions, back to back,
    // whatever the debounce said. `settleRanking` re-arms `due_at` from here.
    `ALTER TABLE suggested_work_sets ADD COLUMN pending_due_at INTEGER
      CHECK (pending_due_at IS NULL OR pending_due_at >= 0)`,
  ],
}, {
  version: 31,
  description: "connector connections and OAuth attempts admit a configured MCP server",
  statements: [
    // `connector_type` and `provider` are CHECK vocabularies, and SQLite cannot
    // widen one in place. `connector_connections` is the harder of the two:
    // thirteen tables cascade from it and one nulls, so the implicit delete
    // inside `DROP TABLE` would take a workspace's Slack sessions, unfurls,
    // ingress jobs and webhook receipts with it.
    //
    // The children are therefore *held* rather than rebuilt: each is copied to
    // a scratch table, the parent is replaced, and the rows are put back. That
    // keeps foreign keys enforced for the whole migration — `PRAGMA
    // foreign_keys = OFF` is silently a no-op once an object event has already
    // touched SQLite, so a rebuild that relies on it drops the children for
    // real — and it means this migration never restates a child's schema,
    // which is the other way a rebuild loses something: a column added by a
    // later migration, an index, a trigger, quietly not carried across.
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V53.map((table) => (
      `CREATE TABLE ${table}_v31_hold AS SELECT * FROM ${table}`
    )),
    `CREATE TABLE connector_connections_v31 (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connector_type TEXT NOT NULL CHECK (connector_type IN ('custom_mcp', 'google', 'generic_webhook', 'github', 'granola', 'linear', 'notion', 'slack', 'x')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      owner_user_id TEXT,
      provider_account_id TEXT,
      display_name TEXT NOT NULL,
      encrypted_credentials TEXT,
      credential_iv TEXT,
      credential_key_version INTEGER,
      credential_refresh_lease_id TEXT,
      credential_refresh_lease_expires_at TEXT,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(granted_scopes_json)),
      status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'needs_reconnect', 'error', 'disabled')),
      cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
      config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
      last_sync_at TEXT,
      next_poll_at TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      model_plugin_id TEXT NOT NULL,
      CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
    ) STRICT`,
    `INSERT INTO connector_connections_v31
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
        encrypted_credentials, credential_iv, credential_key_version,
        credential_refresh_lease_id, credential_refresh_lease_expires_at,
        granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
        error_json, created_at, updated_at, model_plugin_id)
     SELECT id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
            encrypted_credentials, credential_iv, credential_key_version,
            credential_refresh_lease_id, credential_refresh_lease_expires_at,
            granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
            error_json, created_at, updated_at, model_plugin_id
       FROM connector_connections`,
    // Empties every dependent, which is why they are held above. The rename
    // then puts the replacement under the name they all still reference.
    `DROP TABLE connector_connections`,
    `ALTER TABLE connector_connections_v31 RENAME TO connector_connections`,
    // Dropped with the old table, so recreated with it — the identity fences
    // included, since they are the only guard stopping a row from another
    // workspace reaching this object's connector table.
    `CREATE INDEX connector_connections_poll_idx
      ON connector_connections(status, next_poll_at, id)`,
    `CREATE INDEX connector_connections_provider_account_idx
      ON connector_connections(connector_type, provider_account_id, status)`,
    `CREATE UNIQUE INDEX connector_connections_active_model_plugin_id_uq
      ON connector_connections(model_plugin_id) WHERE status != 'disabled'`,
    ...workspaceIdentityFencesFor("connector_connections"),
    // Emptied first because the parent's replacement does not leave every
    // dependent empty: twelve cascade to nothing, while `connector_oauth_attempts`
    // nulls its pointer and keeps the row, which the hold would then duplicate.
    // Deleting makes the restore mean the same thing for both.
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V53.flatMap((table) => [
      `DELETE FROM ${table}`,
      `INSERT INTO ${table} SELECT * FROM ${table}_v31_hold`,
      `DROP TABLE ${table}_v31_hold`,
    ]),
    // The attempt vocabulary is the same widening one step earlier in the flow:
    // a custom MCP authorization writes its pending receipt here before the
    // person reaches the server's consent screen. Nothing references this
    // table, so it is an ordinary rebuild.
    `CREATE TABLE connector_oauth_attempts_v31 (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      provider TEXT NOT NULL CHECK (provider IN ('custom_mcp', 'google', 'github', 'granola', 'linear', 'notion', 'slack')),
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'denied', 'failed')),
      connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,
      error_code TEXT,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      telemetry_operation_id TEXT,
      telemetry_event_version INTEGER NOT NULL DEFAULT 1,
      telemetry_scope TEXT,
      telemetry_capability_count INTEGER,
      telemetry_reconnect INTEGER NOT NULL DEFAULT 0
    ) STRICT`,
    `INSERT INTO connector_oauth_attempts_v31
       (id, region, provider, user_id, workspace_id, status, connection_id, error_code,
        expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
        telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect)
     SELECT id, region, provider, user_id, workspace_id, status, connection_id, error_code,
            expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
            telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect
       FROM connector_oauth_attempts`,
    `DROP TABLE connector_oauth_attempts`,
    `ALTER TABLE connector_oauth_attempts_v31 RENAME TO connector_oauth_attempts`,
    `CREATE INDEX connector_oauth_attempts_expiry_idx
      ON connector_oauth_attempts(status, expires_at, id)`,
    `CREATE UNIQUE INDEX connector_oauth_attempts_telemetry_operation_idx
      ON connector_oauth_attempts(telemetry_operation_id)
      WHERE telemetry_operation_id IS NOT NULL`,
    ...workspaceIdentityFencesFor("connector_oauth_attempts"),
  ],
}, {
  version: 32,
  description: "automations become conversation parents: one directory row per automation, registrations without coordinates, no delivery ledger",
  statements: [
    // A run no longer has a work stream of its own; it is a child conversation
    // under its automation. Every directory row a run made is gone with the
    // class that made it, and the columns that described it stay as dead
    // columns: they sit inside CHECK constraints in the released table text,
    // and rebuilding the directory around them would cost more than leaving
    // `'ad_hoc'` and NULL in place. Nothing reads them.
    `DELETE FROM workspace_workstream_directory WHERE origin_type = 'automation'`,
    // Delivery is now one Queue message per matched registration, idempotent
    // where it lands, so there is no ledger of deliveries to lease or settle.
    `DROP TABLE IF EXISTS workspace_external_event_deliveries`,
    // The draft compiler, the August cutover, and the template gallery are all
    // retired; their tables hold nothing the new automation object reads.
    `DROP TABLE IF EXISTS automation_creation_claims`,
    `DROP TABLE IF EXISTS automation_cutover_campaign`,
    `DROP TABLE IF EXISTS automation_template_versions`,
    `DROP TABLE IF EXISTS automation_templates`,
    // The automation object was replaced, so its projection is rebuilt rather
    // than migrated: `AutomationDO` publishes its row through the same outbox
    // its children's aggregates travel through, versioned by `source_version`
    // alone. Recreated, not altered: the lifecycle CHECK loses `activating`.
    `DROP TABLE IF EXISTS automation_directory`,
    `CREATE TABLE automation_directory (
      automation_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      author_user_id TEXT NOT NULL,
      source_version INTEGER NOT NULL CHECK (source_version > 0),
      payload_hash TEXT NOT NULL,
      lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'active', 'paused', 'deleted')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace', 'workstream')),
      owning_workstream_id TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      next_run_at INTEGER,
      projected_at INTEGER NOT NULL CHECK (projected_at >= 0),
      CHECK ((scope = 'workstream') = (owning_workstream_id IS NOT NULL))
    ) STRICT`,
    `CREATE INDEX automation_directory_sidebar_idx
      ON automation_directory(workspace_id, lifecycle, projected_at DESC, automation_id)`,
    `CREATE INDEX automation_directory_workstream_idx
      ON automation_directory(owning_workstream_id, lifecycle, projected_at DESC)
      WHERE owning_workstream_id IS NOT NULL`,
    ...automationDirectoryWorkspaceIdentityGuards(),
    // Registrations are a complete replacement per destination, so the
    // generation, version and hash that ordered competing projections have no
    // job left. A work stream's watched-resource rows are kept; an
    // automation's belonged to the deleted class and are re-registered by the
    // new one when it is applied.
    `CREATE TABLE workspace_external_event_registrations_v32 (
      registration_id TEXT PRIMARY KEY,
      destination_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      effective_after_event_sequence INTEGER NOT NULL CHECK (effective_after_event_sequence >= 0),
      connection_id TEXT NOT NULL,
      connector_type TEXT NOT NULL,
      event_type TEXT NOT NULL,
      resource_id TEXT,
      evaluator_json TEXT NOT NULL CHECK (json_valid(evaluator_json)),
      destination_kind TEXT NOT NULL CHECK (destination_kind IN ('automation', 'workstream_resource_update')),
      automation_id TEXT,
      workstream_id TEXT,
      substream_id TEXT,
      destination_resource_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('active', 'removed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (destination_kind = 'automation' AND automation_id IS NOT NULL
          AND workstream_id IS NULL AND substream_id IS NULL AND destination_resource_id IS NULL)
        OR
        (destination_kind = 'workstream_resource_update' AND automation_id IS NULL
          AND workstream_id IS NOT NULL AND substream_id IS NOT NULL AND destination_resource_id IS NOT NULL)
      )
    ) STRICT`,
    `INSERT INTO workspace_external_event_registrations_v32
       (registration_id, destination_key, workspace_id, effective_after_event_sequence,
        connection_id, connector_type, event_type, resource_id, evaluator_json,
        destination_kind, automation_id, workstream_id, substream_id, destination_resource_id,
        state, created_at, updated_at)
     SELECT registration_id, destination_key, workspace_id, effective_after_event_sequence,
        connection_id, connector_type, event_type, resource_id, evaluator_json,
        destination_kind, automation_id, workstream_id, substream_id, destination_resource_id,
        state, created_at, updated_at
       FROM workspace_external_event_registrations
      WHERE destination_kind = 'workstream_resource_update' AND state IN ('active', 'removed')`,
    `DROP TABLE workspace_external_event_registrations`,
    `ALTER TABLE workspace_external_event_registrations_v32 RENAME TO workspace_external_event_registrations`,
    `CREATE INDEX workspace_external_event_candidates_idx
      ON workspace_external_event_registrations(
        connection_id, event_type, resource_id, state, registration_id
      )`,
    `CREATE INDEX workspace_external_event_destination_idx
      ON workspace_external_event_registrations(destination_kind, destination_key, state)`,
    `CREATE TRIGGER workspace_external_event_registrations_workspace_identity_insert
      BEFORE INSERT ON workspace_external_event_registrations
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
    `CREATE TRIGGER workspace_external_event_registrations_workspace_identity_update
      BEFORE UPDATE OF workspace_id ON workspace_external_event_registrations
      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)
      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END`,
  ],
}, {
  version: 33,
  description: "project resource text through Turbopuffer with durable revision watermarks and existing-content backfill",
  statements: RESOURCE_SEARCH_MIGRATION_STATEMENTS,
}, {
  version: 34,
  description: 'resumable new-user onboarding with scoped connector selections',
  statements: [ONBOARDING_JOURNEY_SQL],
}, {
  version: 35,
  description: "project the authoritative Sidekick loading capability",
  statements: [
    `ALTER TABLE automation_directory ADD COLUMN loadable INTEGER CHECK (loadable IN (0, 1))`,
  ],
}, {
  version: 36,
  description: "fence external evaluator replacements by owning object generation",
  statements: [`CREATE TABLE external_registration_generations (
    destination_key TEXT PRIMARY KEY, source_generation INTEGER NOT NULL,
    effective_after_event_sequence INTEGER NOT NULL
  ) STRICT`],
}, {
  version: 37,
  description: "persist each viewer's workstream access history",
  statements: [`CREATE TABLE workspace_workstream_access (
    user_id TEXT NOT NULL,
    workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
    last_accessed_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, workstream_id)
  ) STRICT`],
}, {
  version: 38,
  description: 'owner-backed authorization snapshots and exact conversation attachment discovery',
  statements: AUTHORIZATION_STORAGE_MIGRATION,
}, {
  version: 39,
  description: "index pending resource maintenance and search work without scanning completed resources",
  statements: [
    `CREATE INDEX resources_expired_drafts_idx ON resources(workspace_id, created_at, id)
      WHERE provider = 'avalon_upload' AND attachment_status = 'draft'`,
    `CREATE INDEX resources_missing_slug_idx ON resources(workspace_id, created_at, id)
      WHERE slug IS NULL`,
    `CREATE INDEX resource_search_pending_due_idx ON resource_search_versions(not_before, resource_id)
      WHERE pending = 1`,
  ],
}, { version: 40, description: "project shared workstream appearance", statements: [
  `ALTER TABLE workspace_workstream_directory ADD COLUMN appearance_json TEXT CHECK (appearance_json IS NULL OR json_valid(appearance_json))`,
] }, {
  version: 41,
  description: "record a permanent retirement tombstone",
  statements: [
    // A retired workspace never reopens, and the fence in front of every
    // method here reads this table. It lives in the object rather than D1
    // because the gate answers during constructor recovery, before anything
    // else this object could consult is admitted.
    ...OBJECT_RETIREMENT_SCHEMA_STATEMENTS,
  ],
}, {
  version: 42,
  description: "record the object graph retirement walks",
  statements: [
    // Captured before the tombstone and read after it. Once this workspace is
    // retired its directories refuse, so a walk that re-derived its descendants
    // from them would find nothing on the second pass and call itself finished.
    // `retired_at` is the receipt: completion is the absence of NULLs here
    // rather than a flag somebody sets, so a child that failed leaves the walk
    // visibly incomplete and resumable.
    `CREATE TABLE workspace_retirement_graph (
      parent_kind TEXT NOT NULL CHECK (parent_kind IN ('workstream', 'automation')),
      parent_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      retired_at INTEGER,
      PRIMARY KEY (parent_kind, parent_id)
    ) STRICT`,
  ],
}, {
  version: 43,
  description: 'invalidate resource search only for content and category changes',
  statements: RESOURCE_SEARCH_CONTENT_UPDATE_MIGRATION,
}, {
  version: 44,
  description: 'push search authorization decisions after source permission mutations',
  statements: SEARCH_AUTHORIZATION_PUSH_MIGRATION,
}, {
  version: 45,
  description: "the project palette becomes the hue ring",
  statements: [
    // `icon_color_key` is a CHECK vocabulary and SQLite cannot widen one in
    // place, so the table is replaced. Six tables cascade from `projects` —
    // four directly, and two more beneath `project_default_resources` — which
    // means the implicit delete inside `DROP TABLE` would take a workspace's
    // project membership, ordering and pending default-resource work with it.
    //
    // The children are held rather than rebuilt, exactly as v31 does: each is
    // copied wholesale, the parent is replaced, and the rows are put back
    // parents-first. Foreign keys stay enforced throughout — `PRAGMA
    // foreign_keys = OFF` is a silent no-op once the object event has touched
    // SQLite — and no child's schema, index or column is restated here, which
    // is the other way a rebuild quietly loses something.
    //
    // Nothing is remapped. `gray`, `brown`, `yellow` and `teal` left the picker
    // but stay in the vocabulary, so every existing project keeps the colour
    // its owner chose and this migration only ever widens what is accepted.
    ...PROJECT_CASCADE_DEPENDENTS.map((table) => (
      `CREATE TABLE ${table}_v45_hold AS SELECT * FROM ${table}`
    )),
    `CREATE TABLE projects_v45 (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL CHECK (length(trim(name)) > 0),
      normalized_name TEXT NOT NULL CHECK (length(normalized_name) > 0),
      icon_key TEXT NOT NULL CHECK (icon_key IN (${projectRegistrySql(PROJECT_ICON_KEYS_FROZEN)})),
      icon_color_key TEXT NOT NULL CHECK (icon_color_key IN (${projectRegistrySql(PROJECT_COLOR_KEYS_AT_V45)})),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      status TEXT NOT NULL CHECK (status IN (
        'active', 'archiving', 'archived', 'restoring', 'cancelling_restore'
      )),
      creator_user_id TEXT NOT NULL,
      archived_at INTEGER CHECK (archived_at IS NULL OR archived_at >= 0),
      archived_by_user_id TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      presentation_revision INTEGER NOT NULL DEFAULT 1 CHECK (presentation_revision > 0),
      audience_generation INTEGER NOT NULL DEFAULT 1 CHECK (audience_generation > 0),
      lifecycle_generation INTEGER NOT NULL DEFAULT 1 CHECK (lifecycle_generation > 0),
      CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
      CHECK ((archived_at IS NULL) = (archived_by_user_id IS NULL))
    ) STRICT`,
    `INSERT INTO projects_v45
       (project_id, name, normalized_name, icon_key, icon_color_key, scope, status,
        creator_user_id, archived_at, archived_by_user_id, created_at, updated_at,
        presentation_revision, audience_generation, lifecycle_generation)
     SELECT project_id, name, normalized_name, icon_key, icon_color_key, scope, status,
            creator_user_id, archived_at, archived_by_user_id, created_at, updated_at,
            presentation_revision, audience_generation, lifecycle_generation
       FROM projects`,
    // Empties every dependent, which is why they are held above.
    `DROP TABLE projects`,
    `ALTER TABLE projects_v45 RENAME TO projects`,
    // Parents before children, so each insert sees the rows its keys point at.
    ...PROJECT_CASCADE_DEPENDENTS.flatMap((table) => [
      `INSERT INTO ${table} SELECT * FROM ${table}_v45_hold`,
      `DROP TABLE ${table}_v45_hold`,
    ]),
  ],
}, {
  version: 46,
  description: 'persist initialization retry intent with pending search projections',
  statements: [
    `CREATE TRIGGER search_authz_pending_insert AFTER INSERT ON authorization_snapshots
      WHEN json_extract(NEW.snapshot_json, '$.decision.status') = 'unavailable'
      BEGIN INSERT OR IGNORE INTO search_authorization_push
        SELECT CASE WHEN resource_id IS NULL THEN 'parent' ELSE 'resource' END,
          COALESCE(resource_id, parent_id), 1, 0, NULL, 'cache_fill'
        FROM search_authorization_keys WHERE cache_key = NEW.cache_key; END`,
    `INSERT OR IGNORE INTO search_authorization_push
      SELECT CASE WHEN k.resource_id IS NULL THEN 'parent' ELSE 'resource' END,
        COALESCE(k.resource_id, k.parent_id), 1, 0, NULL, 'cache_fill'
      FROM search_authorization_keys k JOIN authorization_snapshots s USING(cache_key)
      WHERE json_extract(s.snapshot_json, '$.decision.status') = 'unavailable'`,
  ],
}, {
  version: 47,
  description: 'rewrite every indexed resource with its display attributes',
  // The index now serves a result's title, time and type beside its text.
  // Re-publishing at the current revision rewrites the lexical row in place
  // (an equal-revision upsert is admitted while the row is live) and leaves
  // completed embeddings alone. A row in backoff keeps its `not_before`: the
  // rewrite lands when that delay expires, and an upgrade never resets a
  // committed retry schedule.
  statements: ['UPDATE resource_search_versions SET pending = 1'],
}, {
  version: 48,
  description: 'register the search projection universe from the directories',
  // Search admission is complete only if every (member, conversation) pair
  // has a projected decision before the member's first search. The push job
  // now registers what its target reaches, so every live parent, every
  // connection and every attachment-admitted resource gets one push here.
  // Connector resources are admitted per connection and carry that key.
  statements: [
    'ALTER TABLE search_authorization_keys ADD COLUMN connection_id TEXT',
    'CREATE INDEX search_authorization_keys_connection ON search_authorization_keys(connection_id, cache_key)',
    `INSERT INTO search_authorization_push
     SELECT 'parent', workstream_id, 1, 0, NULL, 'workspace_mutation' FROM workspace_workstream_directory WHERE archived_at IS NULL
     UNION ALL SELECT 'parent', automation_id, 1, 0, NULL, 'workspace_mutation' FROM automation_directory WHERE lifecycle <> 'deleted'
     UNION ALL SELECT 'connection', id, 1, 0, NULL, 'workspace_mutation' FROM connector_connections
     UNION ALL SELECT 'resource', id, 1, 0, NULL, 'workspace_mutation' FROM resources WHERE connection_id IS NULL
     ON CONFLICT(kind, target_id) DO UPDATE SET revision = revision + 1`,
  ],
}, {
  version: 49,
  description: "project the Sidekick's chosen icon and colour",
  statements: [
    // Nullable and never backfilled: a Sidekick nobody has chosen for renders
    // the mark derived from its id, which is what every row here holds today.
    `ALTER TABLE automation_directory ADD COLUMN appearance_json TEXT
       CHECK (appearance_json IS NULL OR json_valid(appearance_json))`,
  ],
}, {
  version: 50,
  description: "memory scopes store a Sidekick's kind as sidekick",
  // `kind` is a CHECK vocabulary and the row is immutable by trigger, so the
  // stored `automation` cannot be renamed in place: the table is replaced, the
  // way migration 31 replaced `connector_connections`. Every dependent cascades
  // from it, so each is held in a scratch copy across the replacement and put
  // back afterwards, with foreign keys enforced the whole way — `PRAGMA
  // foreign_keys = OFF` is a no-op by the time a group runs. One step differs
  // from 31: the dependents are emptied child-first *before* the parent is
  // dropped rather than left to the drop's implicit delete. Two of them carry
  // FTS5 shadow tables whose triggers fire on every deleted row, and a cascade
  // reaching those from inside `DROP TABLE` locks the table being dropped
  // (`SQLITE_LOCKED`); an ordinary `DELETE` fires the same triggers cleanly.
  // The immutability trigger and the workspace identity fences go with the old
  // table and are recreated; no later migration added an index or a column to
  // this table, and no dependent's schema is restated here.
  statements: [
    ...MEMORY_SCOPE_DEPENDENTS.map((table) => `CREATE TABLE ${table}_v50_hold AS SELECT * FROM ${table}`),
    ...[...MEMORY_SCOPE_DEPENDENTS].reverse().map((table) => `DELETE FROM ${table}`),
    `CREATE TABLE memory_scopes_v50 (
      memory_scope_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('workstream', 'sidekick', 'user', 'workspace')),
      owner_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (workspace_id, kind, owner_id),
      CHECK (kind <> 'workspace' OR owner_id = workspace_id)
    ) STRICT`,
    `INSERT INTO memory_scopes_v50 (memory_scope_id, workspace_id, kind, owner_id, created_at)
     SELECT memory_scope_id, workspace_id,
            CASE kind WHEN 'automation' THEN 'sidekick' ELSE kind END,
            owner_id, created_at
       FROM memory_scopes`,
    // Childless by now, so nothing cascades. The rename then puts the
    // replacement under the name every dependent still references.
    `DROP TABLE memory_scopes`,
    `ALTER TABLE memory_scopes_v50 RENAME TO memory_scopes`,
    `CREATE TRIGGER memory_scopes_are_immutable BEFORE UPDATE ON memory_scopes
      BEGIN SELECT RAISE(ABORT, 'memory_scope_immutable'); END`,
    ...workspaceIdentityFencesFor("memory_scopes"),
    ...MEMORY_SCOPE_DEPENDENTS.flatMap((table) => [
      `INSERT INTO ${table} SELECT * FROM ${table}_v50_hold`,
      `DROP TABLE ${table}_v50_hold`,
    ]),
  ],
}, {
  version: 51,
  description: 'mark every resource pending after the 2026-09-10 consumer version skew dead-lettered rewrites',
  // The deploy that added display and connection attributes ran Durable
  // Objects on the new build while Queue consumers still ran the old one, and
  // the old consumer rejected the new document shape into the dead-letter
  // queue after `publishResourceSearch` had already cleared `pending`. The
  // retry log carries no resource id, so the stale rows cannot be listed;
  // this is migration 47's pass again, at its measured cost. A row in backoff
  // keeps its `not_before`, as in 47. See docs/text-search.md, "Version skew
  // between producers and the consumer".
  statements: ['UPDATE resource_search_versions SET pending = 1'],
}, {
  version: 52,
  description: 'unlist the Terminal recovery backups already attached',
  // Repository checkout has always attached its pre-replacement archive as an
  // ordinary generated resource, so every one made before this version is in
  // its work stream's artifacts rail and its model inventory. The producer now
  // marks new ones unlisted; these are the ones already written.
  //
  // Scoped by the identity the backup path derives rather than by title, which
  // carries a repository name. Idempotent, and no wider than the one producer:
  // `terminal-final-diff:` captures are the work's own output and stay listed.
  //
  // Two triggers on `resources` matter here, and they behave oppositely.
  //
  // `resources_search_update` will **not** fire: migration 43 narrowed it to
  // the columns search reads plus `metadata_json`'s `description` key, and
  // `listing` is neither. A backup indexed before this upgrade would therefore
  // never be re-projected, and would stay in search results forever while
  // absent from every other surface — so the second statement performs the
  // same upsert that trigger would have, over exactly the rows the first
  // marked.
  //
  // `resources_create_semantic_version` **will** fire, because it watches
  // `metadata_json` wholesale and this row's `current_version` is unchanged.
  // Each marked backup therefore gains a `resource_versions` row identical to
  // its predecessor but for the flag. That is accepted rather than suppressed:
  // making the trigger's `WHEN` false means bumping `current_version` in this
  // statement, which leaves the counter ahead of the history it indexes. The
  // version is attributed instead — the staging columns exist precisely so a
  // producer can say who moved the pointers, and `system` is the true answer.
  // `revision_cause` stays null because this is not `created`, `published`,
  // `refetched` or `replaced`, and null is what that column already means for
  // a capture whose producer has no cause to name.
  statements: [
    `UPDATE resources
        SET metadata_json = json_set(metadata_json, '$.listing', 'unlisted'),
            revision_author_kind = 'system'
      WHERE provider = 'avalon_generated'
        AND provider_resource_id LIKE 'terminal-workspace-backup:%'
        AND COALESCE(json_extract(metadata_json, '$.listing'), '') != 'unlisted'`,
    `INSERT INTO resource_search_versions (resource_id, revision, pending, not_before)
     SELECT id, 1, 1, 0 FROM resources
      WHERE provider = 'avalon_generated'
        AND provider_resource_id LIKE 'terminal-workspace-backup:%'
        AND json_extract(metadata_json, '$.listing') = 'unlisted'
     ON CONFLICT(resource_id)
       DO UPDATE SET revision = revision + 1, pending = 1, not_before = 0`,
  ],
}, {
  version: 53,
  description: "admit Ashby without losing connector dependents",
  statements: [
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V53.map((table) => (
      `CREATE TABLE ${table}_v53_hold AS SELECT * FROM ${table}`
    )),
    `CREATE TABLE connector_connections_v53 (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connector_type TEXT NOT NULL CHECK (connector_type IN ('ashby', 'custom_mcp', 'google', 'generic_webhook', 'github', 'granola', 'linear', 'notion', 'slack', 'x')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      owner_user_id TEXT,
      provider_account_id TEXT,
      display_name TEXT NOT NULL,
      encrypted_credentials TEXT,
      credential_iv TEXT,
      credential_key_version INTEGER,
      credential_refresh_lease_id TEXT,
      credential_refresh_lease_expires_at TEXT,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(granted_scopes_json)),
      status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'needs_reconnect', 'error', 'disabled')),
      cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
      config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
      last_sync_at TEXT,
      next_poll_at TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      model_plugin_id TEXT NOT NULL,
      CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
    ) STRICT`,
    `INSERT INTO connector_connections_v53
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
        encrypted_credentials, credential_iv, credential_key_version,
        credential_refresh_lease_id, credential_refresh_lease_expires_at,
        granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
        error_json, created_at, updated_at, model_plugin_id)
     SELECT id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
            encrypted_credentials, credential_iv, credential_key_version,
            credential_refresh_lease_id, credential_refresh_lease_expires_at,
            granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
            error_json, created_at, updated_at, model_plugin_id
       FROM connector_connections`,
    `DROP TABLE connector_connections`,
    `ALTER TABLE connector_connections_v53 RENAME TO connector_connections`,
    `CREATE INDEX connector_connections_poll_idx
      ON connector_connections(status, next_poll_at, id)`,
    `CREATE INDEX connector_connections_provider_account_idx
      ON connector_connections(connector_type, provider_account_id, status)`,
    `CREATE UNIQUE INDEX connector_connections_active_model_plugin_id_uq
      ON connector_connections(model_plugin_id) WHERE status != 'disabled'`,
    ...workspaceIdentityFencesFor("connector_connections"),
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V53.flatMap((table) => [
      `DELETE FROM ${table}`,
      `INSERT INTO ${table} SELECT * FROM ${table}_v53_hold`,
      `DROP TABLE ${table}_v53_hold`,
    ]),
    `CREATE TABLE connector_oauth_attempts_v53 (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      provider TEXT NOT NULL CHECK (provider IN ('ashby', 'custom_mcp', 'google', 'github', 'granola', 'linear', 'notion', 'slack')),
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'denied', 'failed')),
      connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,
      error_code TEXT,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      telemetry_operation_id TEXT,
      telemetry_event_version INTEGER NOT NULL DEFAULT 1,
      telemetry_scope TEXT,
      telemetry_capability_count INTEGER,
      telemetry_reconnect INTEGER NOT NULL DEFAULT 0
    ) STRICT`,
    `INSERT INTO connector_oauth_attempts_v53
       (id, region, provider, user_id, workspace_id, status, connection_id, error_code,
        expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
        telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect)
     SELECT id, region, provider, user_id, workspace_id, status, connection_id, error_code,
            expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
            telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect
       FROM connector_oauth_attempts`,
    `DROP TABLE connector_oauth_attempts`,
    `ALTER TABLE connector_oauth_attempts_v53 RENAME TO connector_oauth_attempts`,
    `CREATE INDEX connector_oauth_attempts_expiry_idx
      ON connector_oauth_attempts(status, expires_at, id)`,
    `CREATE UNIQUE INDEX connector_oauth_attempts_telemetry_operation_idx
      ON connector_oauth_attempts(telemetry_operation_id)
      WHERE telemetry_operation_id IS NOT NULL`,
    ...workspaceIdentityFencesFor("connector_oauth_attempts"),
  ],
}, { version: 54, description: "durable connector installation lifecycle", statements: [
  `CREATE TABLE connector_installations (
    connection_id TEXT PRIMARY KEY REFERENCES connector_connections(id),
    workspace_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    document_json TEXT NOT NULL CHECK (json_valid(document_json)),
    cleanup_ciphertext TEXT, cleanup_iv TEXT, cleanup_key_version INTEGER
  ) STRICT`,
  `CREATE TABLE connector_installation_steps (
    step_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, generation INTEGER NOT NULL,
    state TEXT NOT NULL, intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)), created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE INDEX connector_installation_steps_connection ON connector_installation_steps(connection_id, generation)`,
  `CREATE UNIQUE INDEX ashby_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
    WHERE connector_type = 'ashby' AND scope = 'personal' AND status <> 'disabled'`,
  `CREATE UNIQUE INDEX ashby_workspace_connection_unique ON connector_connections(workspace_id)
    WHERE connector_type = 'ashby' AND scope = 'workspace' AND status <> 'disabled'`,
]
}, {
  version: 55,
  description: "admit Fireflies without losing connector dependents",
  statements: [
    // Held before the parent is replaced, because dropping it would otherwise
    // cascade through every one of them. `connector_installations` is the
    // reason this list exists separately from v53's: its foreign key does not
    // cascade, so the parent's implicit DELETE would *abort* rather than empty
    // it — which is why every dependent is emptied here, before the drop,
    // rather than relying on the cascade to do it.
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55.map((table) => (
      `CREATE TABLE ${table}_v55_hold AS SELECT * FROM ${table}`
    )),
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55.map((table) => `DELETE FROM ${table}`),
    `CREATE TABLE connector_connections_v55 (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connector_type TEXT NOT NULL CHECK (connector_type IN ('ashby', 'custom_mcp', 'fireflies', 'google', 'generic_webhook', 'github', 'granola', 'linear', 'notion', 'slack', 'x')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      owner_user_id TEXT,
      provider_account_id TEXT,
      display_name TEXT NOT NULL,
      encrypted_credentials TEXT,
      credential_iv TEXT,
      credential_key_version INTEGER,
      credential_refresh_lease_id TEXT,
      credential_refresh_lease_expires_at TEXT,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(granted_scopes_json)),
      status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'needs_reconnect', 'error', 'disabled')),
      cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
      config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
      last_sync_at TEXT,
      next_poll_at TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      model_plugin_id TEXT NOT NULL,
      CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
    ) STRICT`,
    `INSERT INTO connector_connections_v55
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
        encrypted_credentials, credential_iv, credential_key_version,
        credential_refresh_lease_id, credential_refresh_lease_expires_at,
        granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
        error_json, created_at, updated_at, model_plugin_id)
     SELECT id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
            encrypted_credentials, credential_iv, credential_key_version,
            credential_refresh_lease_id, credential_refresh_lease_expires_at,
            granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
            error_json, created_at, updated_at, model_plugin_id
       FROM connector_connections`,
    `DROP TABLE connector_connections`,
    `ALTER TABLE connector_connections_v55 RENAME TO connector_connections`,
    `CREATE INDEX connector_connections_poll_idx
      ON connector_connections(status, next_poll_at, id)`,
    `CREATE INDEX connector_connections_provider_account_idx
      ON connector_connections(connector_type, provider_account_id, status)`,
    `CREATE UNIQUE INDEX connector_connections_active_model_plugin_id_uq
      ON connector_connections(model_plugin_id) WHERE status != 'disabled'`,
    // v54's cardinality indexes went with the table it just replaced. A rebuild
    // restores every index the parent carried, not only the ones the migration
    // that created the parent wrote.
    `CREATE UNIQUE INDEX ashby_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'ashby' AND scope = 'personal' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX ashby_workspace_connection_unique ON connector_connections(workspace_id)
      WHERE connector_type = 'ashby' AND scope = 'workspace' AND status <> 'disabled'`,
    // Fireflies' own cardinality, in Ashby's shape: one active workspace
    // connection per workspace and one active personal connection per member,
    // while a disabled row never blocks reconnecting.
    `CREATE UNIQUE INDEX fireflies_workspace_connection_unique ON connector_connections(workspace_id)
      WHERE connector_type = 'fireflies' AND scope = 'workspace' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX fireflies_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'fireflies' AND scope = 'personal' AND status <> 'disabled'`,
    ...workspaceIdentityFencesFor("connector_connections"),
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V55.flatMap((table) => [
      `INSERT INTO ${table} SELECT * FROM ${table}_v55_hold`,
      `DROP TABLE ${table}_v55_hold`,
    ]),
    `CREATE TABLE connector_oauth_attempts_v55 (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL CHECK (region IN ('global', 'eu')),
      provider TEXT NOT NULL CHECK (provider IN ('ashby', 'custom_mcp', 'fireflies', 'google', 'github', 'granola', 'linear', 'notion', 'slack')),
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'denied', 'failed')),
      connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,
      error_code TEXT,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      telemetry_operation_id TEXT,
      telemetry_event_version INTEGER NOT NULL DEFAULT 1,
      telemetry_scope TEXT,
      telemetry_capability_count INTEGER,
      telemetry_reconnect INTEGER NOT NULL DEFAULT 0
    ) STRICT`,
    `INSERT INTO connector_oauth_attempts_v55
       (id, region, provider, user_id, workspace_id, status, connection_id, error_code,
        expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
        telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect)
     SELECT id, region, provider, user_id, workspace_id, status, connection_id, error_code,
            expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
            telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect
       FROM connector_oauth_attempts`,
    `DROP TABLE connector_oauth_attempts`,
    `ALTER TABLE connector_oauth_attempts_v55 RENAME TO connector_oauth_attempts`,
    `CREATE INDEX connector_oauth_attempts_expiry_idx
      ON connector_oauth_attempts(status, expires_at, id)`,
    `CREATE UNIQUE INDEX connector_oauth_attempts_telemetry_operation_idx
      ON connector_oauth_attempts(telemetry_operation_id)
      WHERE telemetry_operation_id IS NOT NULL`,
    ...workspaceIdentityFencesFor("connector_oauth_attempts"),
  ],
}, { version: 56, description: "allow configured deployment identifiers", statements: [
  "PRAGMA defer_foreign_keys = ON",
  "CREATE TABLE \"_region_copy_workspace_identity\" AS SELECT * FROM \"workspace_identity\"",
  "CREATE TABLE \"_region_copy_connector_oauth_attempts\" AS SELECT * FROM \"connector_oauth_attempts\"",
  "DROP TRIGGER \"workspace_identity_placement_valid_insert\"",
  "DROP TRIGGER \"workspace_identity_placement_valid_update\"",
  "DROP TRIGGER \"workspace_identity_placement_immutable\"",
  "DROP TRIGGER \"connector_oauth_attempts_workspace_identity_insert\"",
  "DROP TRIGGER \"connector_oauth_attempts_workspace_identity_update\"",
  "DELETE FROM \"connector_oauth_attempts\"",
  "DELETE FROM \"workspace_identity\"",
  "DROP TABLE \"workspace_identity\"",
  "DROP TABLE \"connector_oauth_attempts\"",
  "CREATE TABLE workspace_identity (\n      id INTEGER PRIMARY KEY CHECK (id = 1),\n      workspace_id TEXT NOT NULL UNIQUE,\n      region TEXT NOT NULL,\n      placement_affinity TEXT NOT NULL CHECK (placement_affinity IN ('wnam', 'enam', 'weur', 'eeur')),\n      created_at INTEGER NOT NULL,\n      updated_at INTEGER NOT NULL\n    ) STRICT",
  "CREATE TABLE \"connector_oauth_attempts\" (\n      id TEXT PRIMARY KEY,\n      region TEXT NOT NULL,\n      provider TEXT NOT NULL CHECK (provider IN ('ashby', 'custom_mcp', 'fireflies', 'google', 'github', 'granola', 'linear', 'notion', 'slack')),\n      user_id TEXT NOT NULL,\n      workspace_id TEXT NOT NULL,\n      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'denied', 'failed')),\n      connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,\n      error_code TEXT,\n      expires_at TEXT NOT NULL,\n      completed_at TEXT,\n      created_at TEXT NOT NULL,\n      updated_at TEXT NOT NULL,\n      telemetry_operation_id TEXT,\n      telemetry_event_version INTEGER NOT NULL DEFAULT 1,\n      telemetry_scope TEXT,\n      telemetry_capability_count INTEGER,\n      telemetry_reconnect INTEGER NOT NULL DEFAULT 0\n    ) STRICT",
  "INSERT INTO \"workspace_identity\" SELECT * FROM \"_region_copy_workspace_identity\"",
  "INSERT INTO \"connector_oauth_attempts\" SELECT * FROM \"_region_copy_connector_oauth_attempts\"",
  "DROP TABLE \"_region_copy_workspace_identity\"",
  "DROP TABLE \"_region_copy_connector_oauth_attempts\"",
  "CREATE INDEX connector_oauth_attempts_expiry_idx\n      ON connector_oauth_attempts(status, expires_at, id)",
  "CREATE UNIQUE INDEX connector_oauth_attempts_telemetry_operation_idx\n      ON connector_oauth_attempts(telemetry_operation_id)\n      WHERE telemetry_operation_id IS NOT NULL",
  "CREATE TRIGGER workspace_identity_placement_valid_insert\n      BEFORE INSERT ON workspace_identity\n      WHEN NEW.placement_affinity IS NULL\n      BEGIN\n        SELECT RAISE(ABORT, 'workspace_placement_affinity_invalid');\n      END",
  "CREATE TRIGGER workspace_identity_placement_valid_update\n      BEFORE UPDATE OF placement_affinity ON workspace_identity\n      WHEN NEW.placement_affinity IS NULL\n      BEGIN\n        SELECT RAISE(ABORT, 'workspace_placement_affinity_invalid');\n      END",
  "CREATE TRIGGER workspace_identity_placement_immutable\n      BEFORE UPDATE OF placement_affinity ON workspace_identity\n      WHEN OLD.placement_affinity IS NOT NULL\n        AND NEW.placement_affinity <> OLD.placement_affinity\n      BEGIN\n        SELECT RAISE(ABORT, 'workspace_placement_affinity_immutable');\n      END",
  "CREATE TRIGGER connector_oauth_attempts_workspace_identity_insert\n      BEFORE INSERT ON connector_oauth_attempts\n      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)\n      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END",
  "CREATE TRIGGER connector_oauth_attempts_workspace_identity_update\n      BEFORE UPDATE OF workspace_id ON connector_oauth_attempts\n      WHEN NEW.workspace_id IS NOT (SELECT workspace_id FROM workspace_identity WHERE id = 1)\n      BEGIN SELECT RAISE(ABORT, 'workspace_identity_mismatch'); END",
  "PRAGMA defer_foreign_keys = OFF"
]
}, MEETING_NOTES_RETIREMENT_MIGRATION, MEETING_NOTES_FINALIZATION_MIGRATION, { version: 59, description: "implicit agent teams and message reply routes", statements: [...AGENT_TEAM_SCHEMA] }, { version: 60, description: "index explicit scope grants for guest discovery", statements: [...SCOPE_GRANT_DIRECTORY_SCHEMA] }, { version: 61, description: "protect connector resource access URLs separately from navigation metadata", statements: ["ALTER TABLE resources ADD COLUMN protected_access_json TEXT"] }, {
  version: 62,
  description: "admit Canva without losing connector dependents",
  statements: [
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V62.map((table) => (
      `CREATE TABLE ${table}_v62_hold AS SELECT * FROM ${table}`
    )),
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V62.map((table) => `DELETE FROM ${table}`),
    `CREATE TABLE connector_connections_v62 (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connector_type TEXT NOT NULL CHECK (connector_type IN ('ashby', 'canva', 'custom_mcp', 'fireflies', 'google', 'generic_webhook', 'github', 'granola', 'linear', 'notion', 'slack', 'x')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      owner_user_id TEXT,
      provider_account_id TEXT,
      display_name TEXT NOT NULL,
      encrypted_credentials TEXT,
      credential_iv TEXT,
      credential_key_version INTEGER,
      credential_refresh_lease_id TEXT,
      credential_refresh_lease_expires_at TEXT,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(granted_scopes_json)),
      status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'needs_reconnect', 'error', 'disabled')),
      cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
      config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
      last_sync_at TEXT,
      next_poll_at TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      model_plugin_id TEXT NOT NULL,
      CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
    ) STRICT`,
    `INSERT INTO connector_connections_v62
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
        encrypted_credentials, credential_iv, credential_key_version,
        credential_refresh_lease_id, credential_refresh_lease_expires_at,
        granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
        error_json, created_at, updated_at, model_plugin_id)
     SELECT id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
            encrypted_credentials, credential_iv, credential_key_version,
            credential_refresh_lease_id, credential_refresh_lease_expires_at,
            granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
            error_json, created_at, updated_at, model_plugin_id
       FROM connector_connections`,
    `DROP TABLE connector_connections`,
    `ALTER TABLE connector_connections_v62 RENAME TO connector_connections`,
    `CREATE INDEX connector_connections_poll_idx
      ON connector_connections(status, next_poll_at, id)`,
    `CREATE INDEX connector_connections_provider_account_idx
      ON connector_connections(connector_type, provider_account_id, status)`,
    `CREATE UNIQUE INDEX connector_connections_active_model_plugin_id_uq
      ON connector_connections(model_plugin_id) WHERE status != 'disabled'`,
    `CREATE UNIQUE INDEX ashby_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'ashby' AND scope = 'personal' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX ashby_workspace_connection_unique ON connector_connections(workspace_id)
      WHERE connector_type = 'ashby' AND scope = 'workspace' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX fireflies_workspace_connection_unique ON connector_connections(workspace_id)
      WHERE connector_type = 'fireflies' AND scope = 'workspace' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX fireflies_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'fireflies' AND scope = 'personal' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX canva_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'canva' AND scope = 'personal' AND status <> 'disabled'`,
    ...workspaceIdentityFencesFor("connector_connections"),
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V62.flatMap((table) => [
      `INSERT INTO ${table} SELECT * FROM ${table}_v62_hold`,
      `DROP TABLE ${table}_v62_hold`,
    ]),
    `CREATE TABLE connector_oauth_attempts_v62 (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('ashby', 'canva', 'custom_mcp', 'fireflies', 'google', 'github', 'granola', 'linear', 'notion', 'slack')),
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'denied', 'failed')),
      connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,
      error_code TEXT,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      telemetry_operation_id TEXT,
      telemetry_event_version INTEGER NOT NULL DEFAULT 1,
      telemetry_scope TEXT,
      telemetry_capability_count INTEGER,
      telemetry_reconnect INTEGER NOT NULL DEFAULT 0
    ) STRICT`,
    `INSERT INTO connector_oauth_attempts_v62
       (id, region, provider, user_id, workspace_id, status, connection_id, error_code,
        expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
        telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect)
     SELECT id, region, provider, user_id, workspace_id, status, connection_id, error_code,
            expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
            telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect
       FROM connector_oauth_attempts`,
    `DROP TABLE connector_oauth_attempts`,
    `ALTER TABLE connector_oauth_attempts_v62 RENAME TO connector_oauth_attempts`,
    `CREATE INDEX connector_oauth_attempts_expiry_idx
      ON connector_oauth_attempts(status, expires_at, id)`,
    `CREATE UNIQUE INDEX connector_oauth_attempts_telemetry_operation_idx
      ON connector_oauth_attempts(telemetry_operation_id)
      WHERE telemetry_operation_id IS NOT NULL`,
    ...workspaceIdentityFencesFor("connector_oauth_attempts"),
  ],
}, {
  version: 63,
  description: "spaces: directory, membership, general, defaults, bootstrap",
  statements: [...WORKSPACE_SPACE_SCHEMA_STATEMENTS],
}, {
  version: 64,
  description: "retire projects behind the space cutover",
  statements: [...PROJECT_RETIREMENT_STATEMENTS],
}, {
  version: 65,
  description: "breakout directory projections",
  statements: [...WORKSPACE_BREAKOUT_SCHEMA_STATEMENTS],
}, {
  version: 66,
  description: "scope channel pins to space placements and clear legacy pins",
  statements: [
    "DROP TABLE workspace_workstream_pins",
    `CREATE TABLE workspace_workstream_pins (
      user_id TEXT NOT NULL,
      space_id TEXT NOT NULL REFERENCES workspace_space_directory(space_id) ON DELETE CASCADE,
      workstream_id TEXT NOT NULL REFERENCES workspace_workstream_directory(workstream_id) ON DELETE CASCADE,
      position INTEGER NOT NULL CHECK (position >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY (user_id, space_id, workstream_id)
    ) STRICT`,
    `CREATE INDEX workspace_workstream_pins_order_idx
      ON workspace_workstream_pins(user_id, space_id, position, workstream_id)`,
  ],
}, {
  version: 67,
  description: "directed workspace impersonation relationships",
  statements: [
    `CREATE TABLE workspace_impersonation_relationships (
      workspace_id TEXT NOT NULL,
      impersonator_user_id TEXT NOT NULL,
      represented_user_id TEXT NOT NULL,
      authority_basis TEXT NOT NULL CHECK (length(authority_basis) BETWEEN 1 AND 180),
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      PRIMARY KEY (workspace_id, impersonator_user_id, represented_user_id, authority_basis)
    ) STRICT`,
    `CREATE INDEX workspace_impersonation_relationships_targets_idx
      ON workspace_impersonation_relationships(workspace_id, impersonator_user_id, revoked_at, represented_user_id)`,
    ...workspaceIdentityFencesFor("workspace_impersonation_relationships"),
  ],
}, {
  version: 68,
  description: "durable atomic moves between spaces",
  statements: [
    `CREATE TABLE space_intents_v68 (
      operation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN (
        'add', 'remove', 'move', 'audience', 'archive', 'restore'
      )),
      space_id TEXT NOT NULL,
      workstream_id TEXT,
      space_revision INTEGER NOT NULL CHECK (space_revision > 0),
      membership_generation INTEGER CHECK (membership_generation IS NULL OR membership_generation > 0),
      source_space_id TEXT,
      source_space_revision INTEGER CHECK (source_space_revision IS NULL OR source_space_revision > 0),
      source_membership_generation INTEGER CHECK (
        source_membership_generation IS NULL OR source_membership_generation > 0
      ),
      delivery_generation INTEGER CHECK (delivery_generation IS NULL OR delivery_generation > 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'applied', 'settled', 'cancelled')),
      cursor TEXT,
      last_error_code TEXT,
      receipts_json TEXT NOT NULL CHECK (json_valid(receipts_json)),
      requested_by_user_id TEXT NOT NULL,
      not_before INTEGER NOT NULL,
      attempts INTEGER NOT NULL CHECK (attempts >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (kind = 'move' AND source_space_id IS NOT NULL
          AND source_space_revision IS NOT NULL AND source_membership_generation IS NOT NULL)
        OR (kind <> 'move' AND source_space_id IS NULL
          AND source_space_revision IS NULL AND source_membership_generation IS NULL)
      )
    ) STRICT`,
    `INSERT INTO space_intents_v68 (
       operation_id, kind, space_id, workstream_id, space_revision,
       membership_generation, source_space_id, source_space_revision,
       source_membership_generation, delivery_generation, state, cursor,
       last_error_code, receipts_json, requested_by_user_id, not_before,
       attempts, created_at, updated_at
     )
     SELECT operation_id, kind, space_id, workstream_id, space_revision,
            membership_generation, NULL, NULL, NULL, delivery_generation, state,
            cursor, last_error_code, receipts_json, requested_by_user_id,
            not_before, attempts, created_at, updated_at
       FROM space_intents`,
    `DROP TABLE space_intents`,
    `ALTER TABLE space_intents_v68 RENAME TO space_intents`,
    `CREATE INDEX space_intents_unsettled_idx
      ON space_intents(state, not_before, operation_id)`,
  ],
}, {
  version: 69,
  description: "preserve breakout appearance in workspace projections",
  statements: [
    "ALTER TABLE workspace_breakout_directory ADD COLUMN appearance_json TEXT CHECK (appearance_json IS NULL OR json_valid(appearance_json))",
  ],
}, {
  version: 70,
  description: 'remember which search decision KV acknowledged',
  // A push re-derives every decision under its target, and most come out the
  // same. With the acknowledged fingerprint beside the key, an unchanged
  // decision skips its KV write. Existing keys start unknown and write once.
  statements: ['ALTER TABLE search_authorization_keys ADD COLUMN published_decision TEXT'],
}, {
  version: 71,
  description: "remember accepted workspace sockets until their first frame",
  statements: [
    // The first-frame watch's ledger; see docs/realtime-sockets.md.
    `CREATE TABLE workspace_socket_unheard (
      connection_id TEXT PRIMARY KEY NOT NULL,
      accepted_at INTEGER NOT NULL CHECK (accepted_at >= 0)
    ) STRICT`,
  ],
}, {
  version: 72,
  description: "host channel and space parents; name the directories channels, breakouts and spaces",
  statements: [...HOSTED_PARENT_SCHEMA_STATEMENTS],
}, {
  version: 73,
  description: "remember how many tools a discovered connection last exposed",
  // Read by `GET /connections` so Settings needs no per-row provider call; NULL
  // until the first discovery. The second column records that the list's
  // one-time background discovery was spent, so a failing one is not retried
  // on every list. See docs/connectors.md#settings-tool-counts.
  statements: [
    `ALTER TABLE connector_connections ADD COLUMN discovered_tool_count INTEGER
      CHECK (discovered_tool_count IS NULL OR discovered_tool_count >= 0)`,
    "ALTER TABLE connector_connections ADD COLUMN tool_count_backfill_attempted_at TEXT",
  ],
}, {
  version: 74,
  description: "give a workspace sync event an audience",
  // The people a per-person event is for (their digest, their connection),
  // so replay after a reconnect reaches the same sockets the live send did.
  // Null is the whole Organization, which every earlier event was.
  statements: [
    "ALTER TABLE workspace_sync_events ADD COLUMN audience_json TEXT CHECK (audience_json IS NULL OR json_valid(audience_json))",
  ],
}, {
  version: 75,
  description: "drop the legacy parent import ledger",
  // Every live Organization had imported every parent before WorkstreamDO and
  // SpaceDO were deleted, so nothing is left to import. A retired
  // Organization's pending rows were residue: retirement dropped their import.
  // See docs/hosted-conversation-parents.md.
  statements: [
    "DROP TABLE parent_imports",
  ],
}, {
  version: 76,
  description: "rewrite a resource's search rows when who may read it changes",
  // Search rows now carry their audience; see
  // docs/PRDs/2026-09-26_search-audience-filtering/design.md.
  statements: RESOURCE_SEARCH_AUDIENCE_MIGRATION,
}, {
  version: 77,
  description: 'rewrite every indexed resource with its audience',
  // Rows written before migration 76 carry no audience, and phase 3 of
  // docs/PRDs/2026-09-26_search-audience-filtering filters on it. This is
  // migration 47's pass again: an equal-revision upsert rewrites the lexical
  // row in place, and existing semantic chunks are left alone. A row in
  // backoff keeps its `not_before`, as in 47.
  statements: ['UPDATE resource_search_versions SET pending = 1'],
}, {
  version: 78,
  description: "index the stored object a resource or version points at",
  // The maintenance schedule asks, for each object waiting in
  // `resource_object_deletion_outbox`, whether a resource or an older version
  // still points at it. Nothing indexed those columns, so one waiting row
  // scanned every resource and every version (460,000 rows at Juno Labs) on
  // each refresh, and a Channel directory effect with links refreshes it:
  // most of `receiveChildEffects`' 700 ms of CPU. Connector resources store no
  // object, so the partial indexes hold only the few rows that do.
  statements: [
    "CREATE INDEX resources_content_ref_idx ON resources(content_ref) WHERE content_ref IS NOT NULL",
    "CREATE INDEX resources_model_content_ref_idx ON resources(model_content_ref) WHERE model_content_ref IS NOT NULL",
    "CREATE INDEX resource_versions_content_ref_idx ON resource_versions(content_ref) WHERE content_ref IS NOT NULL",
    "CREATE INDEX resource_versions_model_content_ref_idx ON resource_versions(model_content_ref) WHERE model_content_ref IS NOT NULL",
  ],
}, {
  version: 79,
  description: "narrow parent_metadata to a parent's identity",
  // A parent reads its presentation from its directory row (`channels`,
  // `spaces`) since the change before this one, so the 19 copied columns are
  // dead weight written on every Main effect. Nothing references this table,
  // so a plain rebuild keeps the rows. See docs/hosted-conversation-parents.md.
  statements: [
    `CREATE TABLE parent_metadata_v79 (
      parent_id TEXT PRIMARY KEY,
      parent_kind TEXT NOT NULL CHECK (parent_kind IN ('workstream', 'space')),
      workspace_id TEXT NOT NULL,
      region TEXT NOT NULL,
      authority_generation INTEGER NOT NULL CHECK (authority_generation > 0),
      revision INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT`,
    `INSERT INTO parent_metadata_v79
       (parent_id, parent_kind, workspace_id, region, authority_generation, revision, created_at, updated_at)
     SELECT parent_id, parent_kind, workspace_id, region, authority_generation, revision, created_at, updated_at
       FROM parent_metadata`,
    "DROP TABLE parent_metadata",
    "ALTER TABLE parent_metadata_v79 RENAME TO parent_metadata",
  ],
}, {
  version: 80,
  description: "remember what each resource's latest connector event said",
  // Ingest drops an event that says what the last one for the same resource
  // already said. A table of its own rather than a column on
  // `workspace_connector_events`, so the migration builds no index over the
  // rows already there. See docs/connectors.md#dropping-events-that-say-nothing-new.
  statements: [
    `CREATE TABLE workspace_connector_event_latest_content (
      connection_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      provider_resource_id TEXT NOT NULL,
      content_fingerprint TEXT NOT NULL CHECK (
        substr(content_fingerprint, 1, 7) = 'sha256:' AND length(content_fingerprint) = 71
      ),
      event_id TEXT NOT NULL REFERENCES workspace_connector_events(event_id) ON DELETE CASCADE,
      -- The newest occurrence this content stands for, stored or dropped.
      occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
      -- The newest repeat dropped against this row, kept so a different
      -- event arriving late can restore it as the state that followed.
      dropped_json TEXT CHECK (dropped_json IS NULL OR json_valid(dropped_json)),
      PRIMARY KEY (connection_id, event_type, provider_resource_id)
    ) STRICT`,
    // The retention reaper deletes events; the cascade looks them up here.
    `CREATE INDEX workspace_connector_event_latest_content_event_idx
      ON workspace_connector_event_latest_content(event_id)`,
    // A late delivery that restored a dropped repeat, so its redelivery can
    // still wake the restored event's processing.
    "ALTER TABLE workspace_connector_event_ingress_receipts ADD COLUMN restored_event_id TEXT",
  ],
}, {
  version: 81,
  description: "record who each Sidekick runs as",
  // Search's person side lists a Sidekick's conversations for its executor as
  // well as its author, as the canonical Sidekick check does, without reading
  // each SidekickDO. Null until the Sidekick next publishes its row; see
  // docs/PRDs/2026-09-26_search-audience-filtering/design.md.
  statements: ["ALTER TABLE automation_directory ADD COLUMN run_as_user_id TEXT"],
}, {
  version: 82,
  description: "advance a Channel's rail waterline when anything its rail lists moves",
  // The socket's `channel_rails` answer and the waterline on each Channel row
  // that says when to ask again. See docs/hosted-conversation-parents.md.
  statements: CHANNEL_RAIL_MIGRATION,
}, {
  version: 83,
  description: "index when authorization deliveries come due",
  // The alarm reads `MIN(not_before)` on every wake; see docs/durable-object-alarms.md.
  statements: [
    "CREATE INDEX authorization_delivery_due_idx ON authorization_delivery(not_before)",
  ],
}, {
  version: 84,
  description: "purge the search-authorization keys memory search registered per run",
  statements: MEMORY_SEARCH_KEY_PURGE_MIGRATION,
}, {
  version: 85,
  description: "bind external conversations to Rally addresses",
  // One record for provider rooms and threads, keyed by installation and path;
  // every Slack Agent session's thread key becomes an active thread binding.
  // See docs/external-conversation-bindings.md.
  statements: EXTERNAL_CONVERSATION_BINDINGS_MIGRATION,
}, {
  version: 86,
  description: "a Sidekick's home Breakout, and the conversations attached to it",
  // The home column sits beside `owning_workstream_id` so the directory's
  // CHECK on that column needs no rebuild; "0" is a Channel's Main
  // conversation, which is every existing Sidekick's home. The attachment
  // table is not `parent_sidekicks`: that one means "may load this Sidekick as
  // a skill". See docs/automation-lifecycle.md.
  statements: [
    `ALTER TABLE automation_directory ADD COLUMN owning_substream_id TEXT NOT NULL DEFAULT '0'`,
    ...SIDEKICK_CONVERSATION_ATTACHMENT_SCHEMA_STATEMENTS,
  ],
}, {
  version: 87,
  description: "let a person order the Pinned section under All",
  // A table of its own, not a new kind in `workspace_container_order`, so an
  // older Worker never reads a row it cannot parse; see docs/pinning.md.
  statements: WORKSPACE_PINNED_ORDER_MIGRATION,
}, {
  version: 88,
  description: "a member's personal system prompt",
  statements: WORKSPACE_PERSONAL_SYSTEM_PROMPT_MIGRATION,
}, {
  version: 89,
  description: "a member's display preferences",
  statements: WORKSPACE_MEMBER_PREFERENCES_MIGRATION,
}, {
  version: 90,
  description: "record whether a room's Space is one it joined by name",
  // Provenance the Slack Connect spawn check needs, which neither the room
  // id nor the Space's scope keeps; see docs/external-conversation-bindings.md.
  statements: EXTERNAL_BINDING_SPACE_MATCHED_MIGRATION,
}, {
  version: 91,
  description: "Sidekick parents move into the Organization object",
  // The directory row becomes the definition row, beside the revisions,
  // schedules, runs and children the Sidekick's own object held, and a ledger
  // of the Sidekicks still to import. See hosted-sidekick-schema.ts.
  statements: HOSTED_SIDEKICK_SCHEMA_STATEMENTS,
}, {
  version: 92,
  description: "drop the Sidekick import ledger",
  // Every Sidekick outside a retired Organization was imported before the
  // legacy class was deleted, so the ledger has nothing left to record.
  statements: [`DROP TABLE sidekick_imports`],
}, {
  version: 93,
  description: "index shares that were pending before shares were claimed at sign-in",
  // Signing in finds a share through D1's scope_share_recipients, which only
  // shares made after it existed have rows in. One alarm per parent with a
  // pending share writes its rows, once, with the alarm system's retries.
  statements: [`INSERT INTO _internal_durable_alarms
       (kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json, created_at, updated_at)
     SELECT 'parent_invitation_index', parent_id, unixepoch() * 1000, NULL, 0, 0, NULL,
            unixepoch() * 1000, unixepoch() * 1000
       FROM parent_invitations
      WHERE json_extract(summary_json, '$.status') = 'pending'
      GROUP BY parent_id
     ON CONFLICT(kind, alarm_key) DO NOTHING`],
}, {
  version: 94,
  description: "make every private Space Organization-wide",
  // Every Space is Organization-wide. A Space grants no reader to its
  // Channels, so no Channel changes; see docs/spaces.md#every-space-is-organization-wide.
  statements: SPACE_PUBLIC_ONLY_MIGRATION,
}, {
  version: 95,
  description: "requests to join a Channel or Breakout, addressed to an approver",
  statements: CONVERSATION_ACCESS_REQUESTS_MIGRATION,
}, {
  version: 96,
  description: "Organization invitees listed in a Space until they join",
  statements: SPACE_INVITEES_MIGRATION,
}, {
  version: 97,
  description: "one pin table for threads, Channels and breakouts, and the Threads and Channel feed indexes",
  // The old pin tables stay and are still written; see workspace-pin-storage.ts.
  statements: WORKSPACE_PINS_MIGRATION,
}, {
  version: 98,
  description: "a Channel's unread waterline and each person's read position in it",
  // Breakout-identical columns, advanced only by placing a thread; see
  // workspace-channel-read-storage.ts and docs/spaces.md#channel-read-state.
  statements: WORKSPACE_CHANNEL_READS_MIGRATION,
}, {
  version: 99,
  description: "threads and Breakouts store their Channel's colour, and every existing thread is marked to take it",
  // Triggers mark a thread whenever its colour can move; the lane that read them is retired.
  statements: CHANNEL_COLOR_SYNC_MIGRATION,
}, {
  version: 100,
  description: "a work list of one-off jobs over every thread, and every thread listed to have its description summarized",
  // The lane is channel colour sync's without triggers; retired with it.
  statements: THREAD_BACKFILL_MIGRATION,
}, {
  version: 101,
  description: "how far each person has read each thread, breakout and Channel, as the app reports it for Activity",
  // One waterline per person and subject, moved by app events; see workspace-activity-feed.ts.
  statements: WORKSPACE_ACTIVITY_READS_MIGRATION,
}, {
  version: 102,
  description: "a Space may be individual: each member's Personal Channel",
  // A rebuild, because SQLite cannot widen a CHECK; see
  // SPACE_INDIVIDUAL_SCOPE_MIGRATION and docs/spaces.md#the-personal-channel.
  statements: SPACE_INDIVIDUAL_SCOPE_MIGRATION,
}, {
  version: 103,
  description: "seat every existing member in General and give them a Personal Channel",
  // One alarm per Organization that has an identity; it walks the members and
  // takes the same steps a joining member's relationship change does. A fresh
  // object has no identity and no members, and pays nothing.
  statements: [`INSERT INTO _internal_durable_alarms
       (kind, alarm_key, due_at, repeat_every_ms, retry_at, attempt, payload_json, created_at, updated_at)
     SELECT 'personal_channel_backfill', 'workspace', unixepoch() * 1000, NULL, 0, 0, NULL,
            unixepoch() * 1000, unixepoch() * 1000
      WHERE EXISTS (SELECT 1 FROM workspace_identity WHERE id = 1)
     ON CONFLICT(kind, alarm_key) DO NOTHING`],
}, {
  version: 104,
  description: "messages in a Channel itself, outside any thread",
  // Existing Generals get what General opens with from migration 103's pass; see
  // SPACE_MESSAGES_MIGRATION and docs/spaces.md#channel-messages.
  statements: SPACE_MESSAGES_MIGRATION,
}, {
  version: 105,
  description: "which Activity rows have been pushed to whom, and when pushing them began",
  // Started threads and breakouts and finished runs push like mentions; see workspace-activity-push.ts.
  statements: WORKSPACE_ACTIVITY_PUSH_MIGRATION,
}, {
  version: 106,
  description: "which push notifications each person has turned off",
  // Read when a push is decided and again when it is sent; see member-preferences.ts.
  statements: WORKSPACE_MEMBER_PUSH_PREFERENCES_MIGRATION,
}, {
  version: 107,
  description: "how each kind of notification reaches each person",
  // Push, email or a connector's surface per kind; see member-preferences.ts.
  statements: WORKSPACE_MEMBER_NOTIFY_PREFERENCES_MIGRATION,
}, {
  version: 108,
  description: "every digest sends at the start of the day at 07:45",
  // Everyone moves, not only digests still on the old 09:00 default: a stored
  // 09:00 cannot say whether someone chose it. An evening time is kept, and a
  // digest with no days gets weekdays. Email and Personal Channel destinations
  // need the account address and the Space id, which this object cannot
  // derive, so each digest is marked and the reconciler adds whichever it
  // lacks and switches it on. The derived `schedules` rows are dropped rather
  // than rewritten, since their next instant needs the owner's timezone; the
  // reconciler rebuilds them on the same visit. (Digests are retired.)
  statements: [
    `ALTER TABLE digest_schedules ADD COLUMN default_destinations_pending INTEGER NOT NULL DEFAULT 0
       CHECK (default_destinations_pending IN (0, 1))`,
    `DELETE FROM digest_schedule_times WHERE minute_of_day < 720`,
    `INSERT INTO digest_schedule_times (digest_schedule_id, minute_of_day)
     SELECT id, 465 FROM digest_schedules`,
    `UPDATE digest_schedules
        SET day_mask = CASE WHEN day_mask = 0 THEN 62 ELSE day_mask END,
            default_destinations_pending = 1,
            version = version + 1,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    `DELETE FROM schedules WHERE digest_schedule_id IS NOT NULL`,
  ],
}, {
  version: 109,
  description: "a Channel message can be a thread's merged result and Channel news",
  // See SPACE_MESSAGE_MERGES_MIGRATION and docs/conversation-merge.md.
  statements: SPACE_MESSAGE_MERGES_MIGRATION,
}, {
  version: 110,
  description: "a pin can be an artifact, carrying the thread it was generated in",
  // See WORKSPACE_ARTIFACT_PINS_MIGRATION and docs/pinning.md.
  statements: WORKSPACE_ARTIFACT_PINS_MIGRATION,
}, {
  version: 111,
  description: "a ledger of new versions of pinned artifacts, for their Activity rows and pushes",
  // See WORKSPACE_ARTIFACT_UPDATES_MIGRATION and docs/pinning.md#artifact-pins.
  statements: WORKSPACE_ARTIFACT_UPDATES_MIGRATION,
}, {
  version: 112,
  description: "an agent's resource version names the person its run acted for",
  statements: [
    // An agent version names its run, and the run's person lives in the
    // thread's object, out of reach of anything here that asks whose change a
    // version was. Staged and consumed like the rest of the provenance, so a
    // later write by somebody else never inherits it. NULL is "not recorded":
    // a run nobody started, or a version from before this migration.
    `ALTER TABLE resources ADD COLUMN revision_on_behalf_of_user_id TEXT`,
    `ALTER TABLE resource_versions ADD COLUMN on_behalf_of_user_id TEXT`,
    `DROP TRIGGER resources_create_initial_version`,
    RESOURCES_CREATE_INITIAL_VERSION_V112,
    `DROP TRIGGER resources_create_semantic_version`,
    RESOURCES_CREATE_SEMANTIC_VERSION_V112,
  ],
}, {
  version: 113,
  description: "a person renaming an artifact is a version cause of its own",
  // A rename moves `title`, which the semantic-version trigger captures, so
  // every rename records a version whether or not it has a cause to name. A
  // cause of its own keeps it out of what a pin counts as news
  // (`artifactUpdateSql`) and lets history say what happened. SQLite cannot
  // widen a CHECK in place, and `resources` is a referenced parent, so each
  // cause column is replaced rather than its table rebuilt: a wider column is
  // added and filled, the triggers that read the old one are dropped so it
  // can be, and the new one takes its name. The triggers come back unchanged.
  statements: [
    `DROP TRIGGER resources_create_initial_version`,
    `DROP TRIGGER resources_create_semantic_version`,
    `DROP TRIGGER resource_versions_queue_artifact_update`,
    `ALTER TABLE resources ADD COLUMN revision_cause_v113 TEXT
       CHECK (revision_cause_v113 IS NULL
         OR revision_cause_v113 IN ('created', 'published', 'refetched', 'replaced', 'renamed'))`,
    `UPDATE resources SET revision_cause_v113 = revision_cause WHERE revision_cause IS NOT NULL`,
    `ALTER TABLE resources DROP COLUMN revision_cause`,
    `ALTER TABLE resources RENAME COLUMN revision_cause_v113 TO revision_cause`,
    `ALTER TABLE resource_versions ADD COLUMN cause_v113 TEXT
       CHECK (cause_v113 IS NULL
         OR cause_v113 IN ('created', 'published', 'refetched', 'replaced', 'renamed'))`,
    `UPDATE resource_versions SET cause_v113 = cause WHERE cause IS NOT NULL`,
    `ALTER TABLE resource_versions DROP COLUMN cause`,
    `ALTER TABLE resource_versions RENAME COLUMN cause_v113 TO cause`,
    RESOURCES_CREATE_INITIAL_VERSION_V112,
    RESOURCES_CREATE_SEMANTIC_VERSION_V112,
    RESOURCE_VERSIONS_QUEUE_ARTIFACT_UPDATE,
  ],
}, {
  version: 114,
  description: "one ledger of every new resource version, for open previews and pinned artifacts alike",
  // See WORKSPACE_RESOURCE_VERSION_CHANGES_MIGRATION and docs/websocket-architecture.md.
  statements: WORKSPACE_RESOURCE_VERSION_CHANGES_MIGRATION,
}, {
  version: 115,
  description: "every open thread listed for the suggestion backfill",
  // See SUGGESTION_BACKFILL_MIGRATION and docs/conversation-suggestions.md.
  statements: SUGGESTION_BACKFILL_MIGRATION,
}, {
  version: 116,
  description: "agent memory facts and sweep receipts, every live prose memory imported as a fact, and the item store dropped",
  // See MEMORY_FACTS_MIGRATION and docs/agent-memory.md.
  statements: MEMORY_FACTS_MIGRATION,
}, {
  version: 117,
  description: "conversations holding a memory digest copy and the facts each copy holds, marked for a refresh when a visibility input changes or a held fact is retracted, and the revision digest reads are ordered by",
  // The lane is channel colour sync's; see memory-digest-sync.ts.
  statements: MEMORY_DIGEST_SYNC_MIGRATION,
}, {
  version: 118,
  description: "every earlier Channel merge's embeds are linked to its Channel",
  // See SPACE_MERGE_EMBED_LINKS_MIGRATION and docs/authorization.md.
  statements: SPACE_MERGE_EMBED_LINKS_MIGRATION,
}, {
  version: 119,
  description: "a watch on every conversation import's reservation, archiving one whose thread has not opened an hour on",
  // See IMPORT_RESERVATION_RECLAIM_MIGRATION and docs/session-import.md.
  statements: IMPORT_RESERVATION_RECLAIM_MIGRATION,
}, {
  version: 120,
  description: "a Channel's own messages are projected into the search index, every existing one queued once",
  // See CHANNEL_MESSAGE_SEARCH_MIGRATION and docs/text-search.md.
  statements: CHANNEL_MESSAGE_SEARCH_MIGRATION,
}, {
  version: 121,
  description: "admit personal Apollo connections without losing connector dependents",
  statements: [
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V121.map((table) => (
      `CREATE TABLE ${table}_v121_hold AS SELECT * FROM ${table}`
    )),
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V121.map((table) => `DELETE FROM ${table}`),
    `CREATE TABLE connector_connections_v121 (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      connector_type TEXT NOT NULL CHECK (connector_type IN ('apollo', 'ashby', 'canva', 'custom_mcp', 'fireflies', 'google', 'generic_webhook', 'github', 'granola', 'linear', 'notion', 'slack', 'x')),
      scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
      owner_user_id TEXT,
      provider_account_id TEXT,
      display_name TEXT NOT NULL,
      encrypted_credentials TEXT,
      credential_iv TEXT,
      credential_key_version INTEGER,
      credential_refresh_lease_id TEXT,
      credential_refresh_lease_expires_at TEXT,
      granted_scopes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(granted_scopes_json)),
      status TEXT NOT NULL DEFAULT 'healthy' CHECK (status IN ('healthy', 'needs_reconnect', 'error', 'disabled')),
      cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json)),
      config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
      last_sync_at TEXT,
      next_poll_at TEXT,
      error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      model_plugin_id TEXT NOT NULL,
      discovered_tool_count INTEGER CHECK (discovered_tool_count IS NULL OR discovered_tool_count >= 0),
      tool_count_backfill_attempted_at TEXT,
      CHECK ((scope = 'personal' AND owner_user_id IS NOT NULL) OR (scope = 'workspace' AND owner_user_id IS NULL))
    ) STRICT`,
    `INSERT INTO connector_connections_v121
       (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
        encrypted_credentials, credential_iv, credential_key_version,
        credential_refresh_lease_id, credential_refresh_lease_expires_at,
        granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
        error_json, created_at, updated_at, model_plugin_id, discovered_tool_count, tool_count_backfill_attempted_at)
     SELECT id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
            encrypted_credentials, credential_iv, credential_key_version,
            credential_refresh_lease_id, credential_refresh_lease_expires_at,
            granted_scopes_json, status, cursor_json, config_json, last_sync_at, next_poll_at,
            error_json, created_at, updated_at, model_plugin_id, discovered_tool_count, tool_count_backfill_attempted_at
       FROM connector_connections`,
    `DROP TABLE connector_connections`,
    `ALTER TABLE connector_connections_v121 RENAME TO connector_connections`,
    `CREATE INDEX connector_connections_poll_idx
      ON connector_connections(status, next_poll_at, id)`,
    `CREATE INDEX connector_connections_provider_account_idx
      ON connector_connections(connector_type, provider_account_id, status)`,
    `CREATE UNIQUE INDEX connector_connections_active_model_plugin_id_uq
      ON connector_connections(model_plugin_id) WHERE status != 'disabled'`,
    `CREATE UNIQUE INDEX ashby_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'ashby' AND scope = 'personal' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX ashby_workspace_connection_unique ON connector_connections(workspace_id)
      WHERE connector_type = 'ashby' AND scope = 'workspace' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX fireflies_workspace_connection_unique ON connector_connections(workspace_id)
      WHERE connector_type = 'fireflies' AND scope = 'workspace' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX fireflies_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'fireflies' AND scope = 'personal' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX canva_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'canva' AND scope = 'personal' AND status <> 'disabled'`,
    `CREATE UNIQUE INDEX apollo_personal_connection_unique ON connector_connections(workspace_id, owner_user_id)
      WHERE connector_type = 'apollo' AND scope = 'personal' AND status <> 'disabled'`,
    ...workspaceIdentityFencesFor("connector_connections"),
    ...CONNECTOR_CONNECTION_DEPENDENTS_THROUGH_V121.flatMap((table) => [
      `INSERT INTO ${table} SELECT * FROM ${table}_v121_hold`,
      `DROP TABLE ${table}_v121_hold`,
    ]),
    `CREATE TABLE connector_oauth_attempts_v121 (
      id TEXT PRIMARY KEY,
      region TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('apollo', 'ashby', 'canva', 'custom_mcp', 'fireflies', 'google', 'github', 'granola', 'linear', 'notion', 'slack')),
      user_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'denied', 'failed')),
      connection_id TEXT REFERENCES connector_connections(id) ON DELETE SET NULL,
      error_code TEXT,
      expires_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      telemetry_operation_id TEXT,
      telemetry_event_version INTEGER NOT NULL DEFAULT 1,
      telemetry_scope TEXT,
      telemetry_capability_count INTEGER,
      telemetry_reconnect INTEGER NOT NULL DEFAULT 0
    ) STRICT`,
    `INSERT INTO connector_oauth_attempts_v121
       (id, region, provider, user_id, workspace_id, status, connection_id, error_code,
        expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
        telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect)
     SELECT id, region, provider, user_id, workspace_id, status, connection_id, error_code,
            expires_at, completed_at, created_at, updated_at, telemetry_operation_id,
            telemetry_event_version, telemetry_scope, telemetry_capability_count, telemetry_reconnect
       FROM connector_oauth_attempts`,
    `DROP TABLE connector_oauth_attempts`,
    `ALTER TABLE connector_oauth_attempts_v121 RENAME TO connector_oauth_attempts`,
    `CREATE INDEX connector_oauth_attempts_expiry_idx
      ON connector_oauth_attempts(status, expires_at, id)`,
    `CREATE UNIQUE INDEX connector_oauth_attempts_telemetry_operation_idx
      ON connector_oauth_attempts(telemetry_operation_id)
      WHERE telemetry_operation_id IS NOT NULL`,
    ...workspaceIdentityFencesFor("connector_oauth_attempts"),
  ],
}, {
  version: 122,
  description: "preserve up to 10,000 connector people as ordered rows rather than one bounded JSON cell",
  statements: CONNECTOR_EVENT_PEOPLE_MIGRATION,
}, {
  version: 123,
  description: "resolve merged conversations independently of execution and archive state",
  statements: [
    `ALTER TABLE parent_children ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0 CHECK (resolved IN (0, 1))`,
    `UPDATE parent_children SET resolved = 1
      WHERE (substream_id = '0' AND parent_id IN (
        SELECT source_workstream_id FROM space_messages WHERE source_workstream_id IS NOT NULL
      )) OR (parent_id, substream_id) IN (
        SELECT subject_id, json_extract(metadata_json, '$.mergedFrom.breakoutId')
          FROM workspace_activity_events
          WHERE event_type = 'workstream_message_created' AND subject_type = 'workstream'
            AND json_extract(metadata_json, '$.mergedFrom.breakoutId') IS NOT NULL
      )`,
  ],
}, {
  version: 124,
  description: "cache visible conversation turns and backfill every existing conversation",
  statements: WORKSPACE_CONVERSATION_VIEW_MIGRATION,
}, {
  version: 125,
  description: "index participating-conversation replies and distinguish queued batches from actual per-channel alerts",
  statements: WORKSPACE_REPLY_ALERT_MIGRATION,
}, {
  version: 126,
  description: "seek a person's authored messages for People ranking without scanning Organization history",
  statements: WORKSPACE_PEOPLE_RANKING_MIGRATION,
}, {
  version: 127,
  description: "make grants the sole participant authority and retire historical roster writers",
  statements: [
    `ALTER TABLE parent_participant_migrations ADD COLUMN import_roster INTEGER NOT NULL DEFAULT 1 CHECK (import_roster IN (0, 1))`,
    `INSERT OR IGNORE INTO _internal_durable_alarms(kind, alarm_key, due_at, created_at, updated_at)
       SELECT 'parent_participant_migration', child.parent_id || ':' || child.substream_id, 0, 0, 0
         FROM parent_children child JOIN parent_metadata parent ON parent.parent_id = child.parent_id
        WHERE parent.parent_kind = 'workstream' AND child.status = 'ready'
          AND NOT EXISTS (SELECT 1 FROM parent_participant_migrations migration
                           WHERE migration.parent_id = child.parent_id AND migration.substream_id = child.substream_id)
          AND (EXISTS (SELECT 1 FROM parent_child_projections source
                        WHERE source.parent_id = child.parent_id AND source.substream_id = child.substream_id)
            OR EXISTS (SELECT 1 FROM parent_breakout_members member
                        WHERE member.parent_id = child.parent_id AND member.substream_id = child.substream_id))
       UNION
       SELECT 'parent_participant_migration', source.parent_id || ':0', 0, 0, 0
         FROM parent_child_projections source JOIN parent_metadata parent ON parent.parent_id = source.parent_id
        WHERE source.substream_id = '0' AND parent.parent_kind = 'workstream'
          AND NOT EXISTS (SELECT 1 FROM parent_children child WHERE child.parent_id = source.parent_id AND child.substream_id = '0')
          AND NOT EXISTS (SELECT 1 FROM parent_participant_migrations migration WHERE migration.parent_id = source.parent_id AND migration.substream_id = '0')`,
  ],
}, {
  version: 128,
  description: "store Sidekick consent separately from human access and receipt prepared delegation changes",
  statements: SIDEKICK_DELEGATION_SCHEMA_STATEMENTS,
}, {
  version: 129,
  description: "separate run coordinators and legacy task accounts from Sidekick human access",
  statements: [
    `ALTER TABLE automation_directory ADD COLUMN legacy_account_user_id TEXT`,
    `ALTER TABLE automation_directory ADD COLUMN delegation_attention_code TEXT`,
    `ALTER TABLE automation_directory ADD COLUMN delegation_migrated INTEGER NOT NULL DEFAULT 0 CHECK(delegation_migrated IN (0,1))`,
    `UPDATE automation_directory SET legacy_account_user_id=COALESCE(run_as_user_id,author_user_id)`,
    `ALTER TABLE sidekick_runs ADD COLUMN coordinator_user_id TEXT`,
    `UPDATE sidekick_runs SET coordinator_user_id=run_as_user_id WHERE run_as_user_id IS NOT NULL`,
    `CREATE TABLE sidekick_claim_access(sidekick_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(sidekick_id,user_id)) STRICT`,
    `INSERT OR IGNORE INTO _internal_durable_alarms(kind,alarm_key,due_at,created_at,updated_at)
     SELECT 'sidekick_delegation_migration',automation_id || ':0',0,0,0 FROM automation_directory WHERE region IS NOT NULL`,
  ],
}, {
  version: 130,
  description: "reconcile configured Sidekick sources after connection authority changes",
  statements: SIDEKICK_SOURCE_CONNECTION_SCHEMA_STATEMENTS,
}, {
  version: 131,
  description: "automatically enroll existing Sidekick creators without replacing recorded withdrawals",
  statements: [
    `UPDATE automation_directory SET delegation_migrated=0
      WHERE region IS NOT NULL AND lifecycle<>'deleted'
        AND NOT EXISTS (SELECT 1 FROM sidekick_delegations grant
          WHERE grant.sidekick_id=automation_id AND grant.user_id=author_user_id)`,
    `INSERT OR IGNORE INTO _internal_durable_alarms(kind,alarm_key,due_at,created_at,updated_at)
     SELECT 'sidekick_delegation_migration',automation_id || ':0',0,0,0 FROM automation_directory
      WHERE region IS NOT NULL AND lifecycle<>'deleted' AND delegation_migrated=0`,
  ],
}, {
  version: 132,
  description: "count Sidekick run finishes toward a scheduled wizard review and record each review request",
  statements: SIDEKICK_REVIEW_SCHEMA_STATEMENTS,
}, {
  version: 133,
  description: "resume a stopped thread backfill where it stopped, and bound each pass to the conversations it started with",
  statements: THREAD_BACKFILL_RESUME_MIGRATION,
}, {
  version: 134,
  description: "record when a person became a Channel participant, so Activity tells them only what happened after",
  // See SPACE_VIEWER_JOINED_AT_MIGRATION.
  statements: SPACE_VIEWER_JOINED_AT_MIGRATION,
}, {
  version: 135,
  description: "receipt each conversation the retirement walk closes, so an interrupted pass keeps its progress",
  statements: [
    // Keyed by the conversation object's own identity: its name is derived
    // from the parent id and substream id alone, whatever kind the parent is.
    // A row means that object confirmed its tombstone; the parent's receipt in
    // `workspace_retirement_graph` still decides completion. See
    // docs/workspace-retirement.md#retiring-a-workspace.
    `CREATE TABLE workspace_retirement_children (
      parent_id TEXT NOT NULL,
      substream_id TEXT NOT NULL,
      retired_at INTEGER NOT NULL,
      PRIMARY KEY (parent_id, substream_id)
    ) STRICT`,
  ],
}, {
  version: 135,
  description: "count each Sidekick run's steps, and arm its row in the Sidekick's shared conversation whenever the run changes",
  // See SIDEKICK_RUN_ROW_SCHEMA_STATEMENTS and docs/automation-lifecycle.md#runs-in-the-shared-conversation.
  statements: SIDEKICK_RUN_ROW_SCHEMA_STATEMENTS,
}, {
  version: 136,
  description: "record who a Sidekick is shared with, and what each reader of its shared conversation has read",
  // See SIDEKICK_AUDIENCE_SCHEMA_STATEMENTS and docs/automation-lifecycle.md#who-a-sidekick-is-shared-with.
  statements: SIDEKICK_AUDIENCE_SCHEMA_STATEMENTS,
}, {
  version: 137,
  description: "retire the Thread-owned Sidekick scope: every one becomes an Organization Sidekick",
  // The Canvases and Sidekicks decision: a Thread no longer owns a Sidekick.
  // The owning columns stay as dead columns (released CHECKs name them), so
  // the row's home is cleared to satisfy the scope CHECK. A Sidekick a room
  // archive paused under the old rule is archived, as the current rule would
  // have left it. See docs/automation-lifecycle.md#creation-and-ownership.
  statements: [
    // It bumped only the owning room's rail, and no row has one after this;
    // dropped first so clearing the home bumps no owning room. The conversion
    // still bumps the rails of the rooms that recommend or attach a converted
    // Sidekick, through `channel_rail_sidekick_listed_update`.
    `DROP TRIGGER IF EXISTS channel_rail_sidekick_owner_update`,
    // The old rule read a room archive's marker as terminal whatever the
    // lifecycle, so a draft or active row that carries it is archived too
    // rather than becoming a live Organization Sidekick.
    `UPDATE automation_directory SET lifecycle = 'deleted', paused_by = NULL
      WHERE owning_room_archived_at IS NOT NULL AND lifecycle <> 'deleted'`,
    `UPDATE automation_directory SET scope = 'workspace', owning_workstream_id = NULL, owning_substream_id = '0'
      WHERE scope = 'workstream'`,
  ],
}, {
  version: 138,
  description: "record who started a Sidekick run under their own access",
  // See SIDEKICK_RUN_REQUESTER_SCHEMA_STATEMENTS and docs/automation-lifecycle.md#who-a-run-acts-as.
  statements: SIDEKICK_RUN_REQUESTER_SCHEMA_STATEMENTS,
}, {
  version: 139,
  description: "record each Canvas: its directory row and who besides its creator may open it",
  // See CANVAS_SCHEMA_STATEMENTS and docs/canvases.md#data-model.
  statements: CANVAS_SCHEMA_STATEMENTS,
}, {
  version: 140,
  description: "admit a Canvas's Chat among the conversations a Sidekick is attached to",
  // See SIDEKICK_ATTACHMENTS_ADMIT_CANVAS_STATEMENTS and docs/canvases.md#data-model.
  statements: SIDEKICK_ATTACHMENTS_ADMIT_CANVAS_STATEMENTS,
}, {
  version: 141,
  description: "pin a Canvas or a Sidekick in its list's Pinned group",
  // See CANVAS_SIDEKICK_PINS_STATEMENTS and docs/canvases.md#the-canvas-list.
  statements: CANVAS_SIDEKICK_PINS_STATEMENTS,
}, {
  version: 142,
  description: "record the artifacts each Canvas's conversation generated",
  // See CANVAS_ARTIFACTS_STATEMENTS and docs/canvases.md#artifacts-and-versions.
  statements: CANVAS_ARTIFACTS_STATEMENTS,
}, {
  version: 143,
  description: "admit a Canvas's Chat among the conversations that hold a memory digest copy",
  // See MEMORY_DIGEST_HOLDERS_ADMIT_CANVAS_MIGRATION.
  statements: MEMORY_DIGEST_HOLDERS_ADMIT_CANVAS_MIGRATION,
}, {
  version: 144,
  description: "refresh memory digest copies when who may open a Canvas or a Sidekick changes",
  // See MEMORY_DIGEST_CANVAS_SIDEKICK_TRIGGERS_MIGRATION and docs/agent-memory.md.
  statements: MEMORY_DIGEST_CANVAS_SIDEKICK_TRIGGERS_MIGRATION,
}, {
  version: 145,
  description: "admit a Sidekick run's needs-input and finished notices among the notification intents",
  // See NOTIFICATION_INTENTS_RUN_KINDS_MIGRATION and docs/push-notifications.md.
  statements: NOTIFICATION_INTENTS_RUN_KINDS_MIGRATION,
}, {
  version: 146,
  description: "admit a Canvas to the retirement graph",
  // See RETIREMENT_GRAPH_CANVAS_MIGRATION and docs/workspace-retirement.md.
  statements: RETIREMENT_GRAPH_CANVAS_MIGRATION,
}, {
  version: 147,
  description: "drop the Thread-era tables nothing reads, and the Thread rows of the shared tables",
  // See THREAD_ERA_TABLES_DROP_MIGRATION and docs/workspace-retirement.md.
  statements: THREAD_ERA_TABLES_DROP_MIGRATION,
}];

function conversationToolEntry(conversation: {
  conversationId: string; parentId: string; substreamId: string; kind: ConversationToolEntry["kind"];
  title: string; isOwn: boolean; isParent: boolean;
}): ConversationToolEntry {
  return {
    conversationId: conversation.conversationId,
    parentId: conversation.parentId,
    substreamId: asSubstreamId(conversation.substreamId),
    kind: conversation.kind,
    title: conversation.title,
    isOwn: conversation.isOwn,
    isParent: conversation.isParent,
  };
}

function conversationToolRefusal(
  code: ConversationToolRefusalCode,
  available: readonly string[],
  resourceId: string | null = null,
): ConversationToolRefusal {
  return { ok: false, code, available: [...available], resourceId };
}

function externalEventContext(
  metadata: Record<string, unknown>,
  textSnippet: string | null,
): Record<string, string | number | boolean | readonly string[]> {
  const context: Record<string, string | number | boolean | readonly string[]> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string" || typeof value === "boolean") context[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) context[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      context[key] = value;
    }
  }
  if (textSnippet !== null) context.messageText = textSnippet;
  return context;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** The viewer a workspace socket lists for: its person and their relationship. */
function viewerOf(attachment: WorkspaceSocketAttachment): Viewer {
  return { userId: attachment.userId, accessClass: attachment.accessClass ?? "member" };
}

function readAttachment(socket: WebSocket): WorkspaceSocketAttachment | null {
  try {
    const parsed = SocketIdentitySchema.extend({
      connectionId: z.string().uuid(),
      connectedAt: z.string().datetime({ offset: true }),
      subscribed: z.boolean(),
      // Older attached sockets have no diagnostic marker. Their first frame
      // after a deployment may emit this phase once.
      firstFrameReported: z.boolean().default(false),
      lastWaterline: z.number().int().nonnegative(),
      // Sockets accepted by the previous deployment carry none of these fields. They
      // resume safely as backgrounded and write the explicit shape on their
      // first presence event instead of being disconnected during rollout.
      presenceRevision: z.number().int().nonnegative().default(0),
      applicationState: z.enum(["foreground", "background"]).default("background"),
      foregroundWorkstreamId: WorkstreamIdSchema.nullable().default(null),
      pendingForegroundWorkstreamId: WorkstreamIdSchema.nullable().default(null),
      // Defaulted for the same reason, and to the reading that changes nothing
      // for a socket that predates it: `member` is what every attachment
      // written before Spaces existed meant.
      accessClass: z.enum(["member", "guest"]).default("member"),
      readsIndividualSpaces: z.boolean().default(false),
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
    && attachment.foregroundWorkstreamId !== null
    // Staff on a support session are not the person being present.
    && !attachment.impersonatorUserId;
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
  | "presence";

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

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function connectorEventFromRow(
  sql: SqlStorage,
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
      externalPeople: readConnectorEventPeople(sql, row.event_id),
    },
  });
}

/**
 * One breakout, in the same shape a Channel takes on a Space dashboard.
 *
 * The derivations are `directoryWorkstream`'s, against the breakout tables:
 * the unread waterline falls back to the conversation's own
 * `unread_tracking_start_ordinal` when this person has no viewer row, and a
 * mention counts only above that waterline. The unread derivation itself is
 * the shared `unreadState`, which a Channel container's read state uses too.
 * The rest is written out rather than shared with that function because the
 * two read different tables and the columns a Channel row has that a breakout
 * does not — a pin, a visit, an email address, a facepile, a wake-up — are
 * exactly the fields a breakout answers with their empty value. What *is*
 * shared is the decision that matters: which of these rows appears at all,
 * which the page query makes with one predicate rendered against both tables.
 *
 * `id` is the substream id, because that is this conversation's identity. The
 * parent's id, the substream id again and the parent's title travel in
 * `breakoutOf`, which is what the row's link and its second line are built
 * from.
 */

// Binding 1 is always the viewer user ID; the access join reuses it as ?1.
/**
 * Two `workstreamId` → user-id maps as one, mutating neither.
 *
 * A Channel and one of its breakouts can both move for the same person inside
 * one Queue batch, and what that person is owed is one nudge rather than two.
 */
/**
 * The sync topics a committed write still owes after its commit, recorded as a
 * row in the same transaction (`workspace_directory_followups`) so it survives
 * a crash. A row a Thread or Channel batch recorded before they were retired
 * also carries that batch's directory work; only its topics are read now, and
 * the rest describes rows nothing shows (plan step C-2).
 */
/**
 * Topics retired with Threads, Channels, meeting notes, Activity and the
 * Sidekick running count (plan step C-2) that a stored sync event or follow-up
 * written before then may still name. They are dropped on read: no client
 * reads them, and refusing the row would fail a resume or a follow-up for a
 * change that is already applied. Any other unknown topic still fails.
 */
const RETIRED_SYNC_TOPICS = new Set([
  "digest_schedule", "sidekick_activity", "notes", "projects", "activity", "work_opportunities", "workstream_directory",
]);
const StoredSyncTopicsSchema = z.array(z.string())
  .transform((topics) => topics.filter((topic) => !RETIRED_SYNC_TOPICS.has(topic)))
  .pipe(z.array(WorkspaceSyncTopicSchema));
/** The retired topics a stored row names, for the log line its drop writes. */
function retiredSyncTopics(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((topic): topic is string => typeof topic === "string" && RETIRED_SYNC_TOPICS.has(topic)) : [];
}
/** Workspace socket commands retired with Threads, Channels and the Sidekick running count (plan step C-2). */
const RETIRED_WORKSPACE_SOCKET_COMMANDS = new Set(["list_workstreams", "channel_rails", "space_channels", "sidekick_activity"]);

const SyncFollowUpSchema = z.object({
  workspaceId: z.string().min(1),
  syncTopics: StoredSyncTopicsSchema,
});
type SyncFollowUp = z.infer<typeof SyncFollowUpSchema>;

/** The audience half of `publishSync`'s detail; `memberUserIds` is read elsewhere. */
const SyncAudienceSchema = z.object({
  audienceUserIds: z.array(UserIdSchema).optional(),
  connectionId: z.string().min(1).optional(),
});

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
  /**
   * Which relationship this person holds, read here because the socket has to
   * remember it: a guest is excluded from Spaces by the PRD's non-goal 3, and
   * the snapshot publisher deliberately asks nobody anything on the way out
   * (`docs/access-revocation.md`). The answer therefore has to be taken on the
   * way in and carried on the attachment.
   *
   * Absent on the development path, which selects only the role.
   */
  access_class?: "member" | "guest" | null;
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

/** What a parent id this object hosts no Canvas or Sidekick for answers. */
const NO_HOSTED_PARENT_AUTHORITY: ConversationParentAuthorityResult = Object.freeze({
  exists: false, authorityGeneration: 0, archived: false,
});

export class WorkspaceDO extends ScheduledDurableObject<Env> {
  private readonly state: DurableObjectState;
  private readonly initialized: Promise<void>;
  /** This object's own `WORKSPACE_DOS` name; see {@link selfObjectName}. */
  private readonly searchPublications = new Map<string, Promise<void>>();
  private readonly resourceSearchPace: ResourceSearchPace = { nextBatchAt: 0 };
  private readonly channelMessageSearchPace: ResourceSearchPace = { nextBatchAt: 0 };
  private objectName: string | null = null;
  /**
   * When this instance last ran any socket callback: one of the signals the
   * first-frame watch reads as "still hearing sockets". In memory only, so a
   * hibernation wake forgets it; `socket-first-frame-watch.ts` names the two
   * signals that survive one.
   */
  private lastSocketEventAt: number | null = null;
  /** When the newest meter `publishUsage` sent was read. */
  private lastUsageReadAtMs: number | null = null;
  /**
   * `WORKSPACE_SOCKET_FIRST_FRAME_DEADLINE_MS`, held per instance so a runtime
   * test can shorten it and drive the real accept and alarm paths.
   */
  private socketFirstFrameDeadlineMs = WORKSPACE_SOCKET_FIRST_FRAME_DEADLINE_MS;
  /** `WORKSPACE_SOCKET_MISSED_SOCKETS_BEFORE_RESET`, per instance for the same reason. */
  private missedSocketsBeforeReset = WORKSPACE_SOCKET_MISSED_SOCKETS_BEFORE_RESET;
  /**
   * Ledger rows this instance judged missed and held below the reset
   * threshold: logged once, and left out of the alarm's candidates. In memory,
   * so a hibernation wake judges them again, once.
   */
  private heldUnheardSockets = new Set<string>();
  /**
   * Whether this object has the first-frame ledger (migration 71). An object
   * held at schema 57 for meeting-notes retirement does not, and the watch
   * stays off there until the operator finalizes it.
   */
  private unheardLedger = false;
  /** Whether this object has the pinned-artifact update ledger (migration 111). */
  private versionLedger = false;
  /**
   * Channels a directory batch drained from the rail ledger for its own
   * follow-up pass to send (`applyDirectoryBatch`). In memory: a pass that
   * never gets there leaves them for the next pass, and a reconnect reads the
   * waterline regardless.
   */
  private readonly railRowsHeld = new Set<string>();
  /** Content-free phase timings for the alarm invocation currently running. */
  private workspaceAlarmInstrumentation: WorkspaceAlarmInstrumentation | null = null;

  constructor(
    state: DurableObjectState,
    env: Env,
  ) {
    super(state, env);
    assertDurableObjectJurisdiction(state.id, env.AVALON_REGION, env.APP_ENV);
    // Every write, from any entry point, is followed by one drain of the
    // resource version ledger its triggers may have filled, as a microtask:
    // once the synchronous code that wrote, and any transaction around it, has
    // finished. A closure rather than a method, because methods sit behind the
    // retirement gate and a write made by a permitted retirement call must not
    // be refused on its way out; the drain itself is refused once the
    // workspace is retired, which is right.
    let versionDrainScheduled = false;
    this.state = observeSqlWrites(state, () => {
      if (!this.versionLedger || versionDrainScheduled) return;
      versionDrainScheduled = true;
      queueMicrotask(() => {
        try {
          // A new version of any resource, from whichever producer wrote it:
          // every open preview of it moves to the new head.
          const changes = drainResourceVersionChanges(this.state.storage.sql);
          if (changes.length > 0) {
            this.publishResourceVersions(readResourceHeads(this.state.storage.sql,
              changes.map((change) => change.resourceId)));
          }
        } catch (error) {
          // Nothing here may throw: this runs outside every entry point.
          if (!isRetirementRefusal(error)) {
            logWarn(this.env, "resource_version_drain_failed", {
              code: diagnosticErrorCode(error, "resource_version_drain_failed"),
            });
          }
        } finally {
          versionDrainScheduled = false;
        }
      });
    });
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
      await this.applyMigrations(() => applyMeetingRetirementMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: MIGRATION_COMPONENT,
        workerVersionId: env.APP_VERSION ?? "unknown",
      }));
      this.detectUnheardLedger();
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

  /** Generic platform writer. Producers supply the authority basis; no demo fact is read here. */
  async upsertImpersonationRelationships(input: unknown): Promise<{ active: number }> {
    await this.initialized;
    const request = UpsertImpersonationRelationshipsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = new WorkspaceImpersonationStorage(this.state.storage).upsert({
      ...request,
      now: new Date().toISOString(),
    });
    // Who an operator may act as is their reach too: a surface that lists the
    // people they may act as rereads on it. Each operator is told about themselves.
    return result;
  }

  /** Exact directed authorization read for an impersonation-aware surface. */
  async authorizeImpersonation(input: unknown) {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema,
      impersonatorUserId: UserIdSchema,
      representedUserId: UserIdSchema,
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return {
      relationship: new WorkspaceImpersonationStorage(this.state.storage).authorize(
        request.workspaceId,
        request.impersonatorUserId,
        request.representedUserId,
      ),
    };
  }

  /** Active targets only. Membership is deliberately rechecked by the regional service. */
  async listImpersonationRelationships(input: unknown) {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema,
      impersonatorUserId: UserIdSchema,
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return {
      relationships: new WorkspaceImpersonationStorage(this.state.storage)
        .list(request.workspaceId, request.impersonatorUserId),
    };
  }

  /** Revocation by exact pair or producer-owned authority basis. */
  async revokeImpersonationRelationships(input: unknown): Promise<{ revoked: number }> {
    await this.initialized;
    const request = RevokeImpersonationRelationshipsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const { revoked } = new WorkspaceImpersonationStorage(this.state.storage).revoke({
      workspaceId: request.workspaceId,
      ...(request.authorityBasis ? { authorityBasis: request.authorityBasis } : {}),
      ...(request.impersonatorUserId ? { impersonatorUserId: request.impersonatorUserId } : {}),
      ...(request.representedUserId ? { representedUserId: request.representedUserId } : {}),
      now: new Date().toISOString(),
    });
    return { revoked };
  }

  /** Internal host RPCs: callers resolve execution/resource authority before changing membership. */
  async ensureAgentTeam(input: { workspaceId: string; originAgentId: AgentId }): Promise<{ teamId: string }> {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, originAgentId: AgentIdSchema }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return { teamId: new AgentTeamStorage(this.state.storage).ensureTeam(request.originAgentId) };
  }

  async joinAgentTeam(input: { workspaceId: string; teamId: string; agentId: AgentId }): Promise<{ joined: true }> {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, teamId: AgentIdSchema, agentId: AgentIdSchema }).parse(input);
    this.assertWorkspace(request.workspaceId);
    new AgentTeamStorage(this.state.storage).addMember(request.teamId, request.agentId);
    return { joined: true };
  }

  async registerAgentDelegation(input: { workspaceId: string; teamId: string; ownerAgentId: AgentId; agentId: AgentId }): Promise<AgentTeamResult<{ registered: true }>> {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, teamId: AgentIdSchema, ownerAgentId: AgentIdSchema, agentId: AgentIdSchema }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return agentTeamResult(() => {
      new AgentTeamStorage(this.state.storage).recordDelegation(request.teamId, request.ownerAgentId, request.agentId);
      return { registered: true as const };
    });
  }

  async listAgentTeammates(input: { workspaceId: string; teamId: string; requesterAgentId: AgentId }): Promise<AgentTeamResult<{ agentIds: AgentId[] }>> {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, teamId: AgentIdSchema, requesterAgentId: AgentIdSchema }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return agentTeamResult(() => ({ agentIds: new AgentTeamStorage(this.state.storage).members(request.teamId, request.requesterAgentId) }));
  }

  async resolveAgentMessage(input: {
    workspaceId: string; messageId: string; senderAgentId: AgentId;
    recipientAgentId?: AgentId; replyToMessageId?: string; preferredTeamId?: string;
  }): Promise<AgentTeamResult<AgentMessageRoute>> {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema, messageId: IdSchema, senderAgentId: AgentIdSchema,
      recipientAgentId: AgentIdSchema.optional(), replyToMessageId: IdSchema.optional(),
      preferredTeamId: AgentIdSchema.optional(),
    }).refine((value) => (value.recipientAgentId === undefined) !== (value.replyToMessageId === undefined),
      "Specify a recipient or a received message, never both.").parse(input);
    this.assertWorkspace(request.workspaceId);
    return agentTeamResult(() => {
      const teams = new AgentTeamStorage(this.state.storage);
      const route = request.replyToMessageId !== undefined
        ? teams.replyRoute(request.replyToMessageId, request.senderAgentId)
        : {
            teamId: teams.sharedTeam(request.senderAgentId, AgentIdSchema.parse(request.recipientAgentId), request.preferredTeamId),
            senderAgentId: request.senderAgentId,
            recipientAgentId: AgentIdSchema.parse(request.recipientAgentId),
          };
      return teams.recordMessage({ messageId: request.messageId, ...route });
    });
  }

  async agentOwner(input: { workspaceId: string; agentId: AgentId }): Promise<{ agentId: AgentId | null }> {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, agentId: AgentIdSchema }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return { agentId: new AgentTeamStorage(this.state.storage).owner(request.agentId) };
  }

  async ownedAgentDescendants(input: { workspaceId: string; agentId: AgentId }): Promise<{ agentIds: AgentId[] }> {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, agentId: AgentIdSchema }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return { agentIds: new AgentTeamStorage(this.state.storage).ownedDescendants(request.agentId) };
  }

  // ---------------------------------------------------------------------------
  // Hosted conversation parents.
  //
  // Every Channel's and Space's parent authority lives in this object, keyed by
  // parent id; `hosted-parent.ts` holds the logic and
  // `docs/hosted-conversation-parents.md` owns the design. The methods below
  // keep the names and shapes the parent objects answered to, so a caller
  // changes which stub it holds and nothing else.
  //
  // A write applies its directory step in its own transaction, rather than
  // over a Queue and back; only work that leaves this object waits in the
  // parent outbox, which the alarm drains.
  // ---------------------------------------------------------------------------

  /**
   * Follow-ups recorded by hosted Canvas and Sidekick writes, run after their
   * commit. Each carries the row's JSON: a follow-up rolled back with an outer
   * transaction leaves an id a later row may reuse, and only the row it names
   * is run.
   */
  private readonly pendingSyncFollowUps: { id: number; json: string }[] = [];

  private static readonly LOCAL_PARENT_EFFECT_KINDS = new Set(["directory_common", "directory_user", "scope_grant_directory"]);

  // The conversation-parent contract.

  /**
   * Which kind of hosted parent an id names, with its authority, and, when a
   * viewer is named, that viewer's decision too: opening a conversation is
   * then one call to this object rather than a resolve and a check in turn.
   * `null` kind is an id this object hosts no Canvas or Sidekick for. A
   * Thread's or Channel's id is one of those: both are retired (plan step C-2).
   */
  async resolveHostedParent(input: {
    workspaceId: string;
    parentId: string;
    viewer?: Omit<ConversationParentAuthorizeViewerRequest, "workspaceId" | "parentId">;
  }): Promise<{
    kind: "automation" | "canvas" | null;
    authority: ConversationParentAuthorityResult;
    viewer?: ConversationParentAuthorizeViewerResult;
  }> {
    const request = z.object({ workspaceId: WorkspaceIdSchema, parentId: IdSchema }).parse(input);
    const hosted = await this.hostedConversationParent(request.parentId, request.workspaceId);
    if (!hosted) return { kind: null, authority: NO_HOSTED_PARENT_AUTHORITY };
    const authority = hosted.authority({ workspaceId: request.workspaceId, parentId: request.parentId });
    if (!input.viewer || !authority.exists) return { kind: authority.exists ? hosted.parentKind : null, authority };
    const viewer = await hosted.authorizeViewer({ ...input.viewer, workspaceId: request.workspaceId, parentId: request.parentId });
    return { kind: hosted.parentKind, authority, viewer };
  }

  async authority(input: ConversationParentAuthorityRequest): Promise<ConversationParentAuthorityResult> {
    const hosted = await this.hostedConversationParent(input.parentId, input.workspaceId);
    return hosted ? hosted.authority(input) : NO_HOSTED_PARENT_AUTHORITY;
  }

  async authorizeViewer(input: ConversationParentAuthorizeViewerRequest): Promise<ConversationParentAuthorizeViewerResult> {
    const hosted = await this.hostedConversationParent(input.parentId, input.workspaceId);
    return hosted ? hosted.authorizeViewer(input) : { authorized: false, archived: false };
  }

  async reserveChild(input: ConversationParentReserveChildRequest): Promise<ConversationParentReserveChildResult> {
    return (await this.requireHostedConversationParent(input.parentId, input.workspaceId)).reserveChild(input);
  }

  async reserveAgentChild(input: Parameters<HostedConversation["reserveAgentChild"]>[0]): Promise<ConversationParentReserveChildResult> {
    return (await this.requireHostedConversationParent(input.parentId, input.workspaceId)).reserveAgentChild(input);
  }

  async listChildren(input: ConversationParentListChildrenRequest): Promise<ConversationParentListChildrenResult> {
    const hosted = await this.hostedConversationParent(input.parentId, input.workspaceId);
    return hosted ? hosted.listChildren(input) : { children: [] };
  }

  async childTerminalDeadlines(input: ConversationParentTerminalDeadlinesRequest): Promise<ConversationParentTerminalDeadlinesResult> {
    const hosted = await this.hostedConversationParent(input.parentId, input.workspaceId);
    return hosted ? hosted.childTerminalDeadlines(input) : { items: [] };
  }

  /** A Canvas or Sidekick this object hosts, or a named refusal for any other id. */
  private async requireHostedConversationParent(parentId: string, workspaceId: string): Promise<HostedSidekick | HostedCanvas> {
    const hosted = await this.hostedConversationParent(parentId, workspaceId);
    if (!hosted) throw new ApiError(404, "conversation_parent_not_found", "This conversation's parent does not exist");
    return hosted;
  }

  /**
   * The children a hosted parent knows that the retirement walk has not yet
   * closed. A child receipted by `recordRetiredChild` is left out, so a pass
   * cut off partway through a large parent resumes at the next child rather
   * than waking every closed one again.
   */
  async childrenForRetirement(input: { workspaceId: string; parentId: string }) {
    const hosted = await this.hostedConversationParent(input.parentId, input.workspaceId);
    if (!hosted) return { status: "missing" as const };
    const listing = hosted.childrenForRetirement();
    return listing.status === "ok"
      ? { ...listing, children: this.unretiredChildren(input.parentId, listing.children) }
      : listing;
  }

  private unretiredChildren<T extends { substreamId: string }>(parentId: string, children: T[]): T[] {
    const retired = new Set(this.state.storage.sql.exec<{ substream_id: string }>(
      "SELECT substream_id FROM workspace_retirement_children WHERE parent_id = ?",
      parentId,
    ).toArray().map((row) => row.substream_id));
    return retired.size === 0 ? children : children.filter((child) => !retired.has(child.substreamId));
  }

  /**
   * Every Thread and Channel this Organization still holds, with each
   * conversation under it, for the Thread retirement walk
   * (`services/thread-retirement-service.ts`).
   *
   * A Thread is a `channels` row and a Channel is a `spaces` row; either can
   * also survive as parent state alone, so `parent_metadata` is read too. Its
   * conversations are Main `0` (always named, as `childRegistry` names it,
   * because a Space created before 2026-09-26 has a hidden one) and every
   * child the parent registry, its projections or the Breakout directory
   * knows. Canvases and Sidekicks are other parents, in other tables, and are
   * never named here.
   */
  async threadRetirementInventory(): Promise<{
    parents: { parentKind: "workstream" | "space"; parentId: string; substreamIds: string[] }[];
  }> {
    await this.initialized;
    const sql = this.state.storage.sql;
    const parents = sql.exec<{ parent_kind: "workstream" | "space"; parent_id: string }>(
      `SELECT 'workstream' AS parent_kind, workstream_id AS parent_id FROM channels
       UNION SELECT 'space', space_id FROM spaces
       UNION SELECT parent_kind, parent_id FROM parent_metadata
       ORDER BY parent_kind DESC, parent_id`,
    ).toArray();
    return {
      parents: parents.map((parent) => ({
        parentKind: parent.parent_kind,
        parentId: parent.parent_id,
        substreamIds: sql.exec<{ substream_id: string }>(
          `SELECT '0' AS substream_id
           UNION SELECT substream_id FROM parent_children WHERE parent_id = ?
           UNION SELECT substream_id FROM parent_child_projections WHERE parent_id = ?
           UNION SELECT substream_id FROM breakouts WHERE workstream_id = ?
           ORDER BY substream_id`,
          parent.parent_id, parent.parent_id, parent.parent_id,
        ).toArray().map((row) => row.substream_id),
      })),
    };
  }

  /**
   * Delete one Thread's or Channel's rows once every conversation under it is
   * retired: its directory row and viewer rows (and a Thread's Breakout
   * directory), and its parent state in every table
   * `HOSTED_PARENT_STATE_TABLES` names that the schema still holds, so a table
   * phase C drops first is skipped. The foreign keys that cascade from `channels` and `spaces`
   * (pins, resource links, access rows) go with them; the resources a link
   * names do not. Idempotent: a second call finds nothing to delete.
   */
  async deleteRetiredThreadParent(input: { parentKind: "workstream" | "space"; parentId: string }): Promise<void> {
    await this.initialized;
    const sql = this.state.storage.sql;
    const present = new Set(sql.exec<{ name: string }>(
      "SELECT name FROM sqlite_schema WHERE type = 'table'",
    ).toArray().map((row) => row.name));
    const parentTables = HOSTED_PARENT_STATE_TABLES.filter((table) => present.has(table));
    this.state.storage.transactionSync(() => {
      // Checked at commit, when every referencing row is gone too, so the
      // delete order among the parent tables does not matter: definition
      // order deletes `parent_invitation_operations` before the
      // `parent_invitations` rows whose foreign key names it with no ON
      // DELETE, which an immediate check refuses. The nuance: inside
      // `transactionSync` a deferred violation is not raised here but at the
      // commit of the whole event, after this method returns, so it would
      // surface as this RPC failing rather than inside the service's
      // try/catch. Only a row this sweep does not delete can cause one, and
      // every referencing table is in the list.
      sql.exec("PRAGMA defer_foreign_keys = ON");
      // First: while a participant migration row stands, a Breakout's member
      // rows refuse deletion (`parent_breakout_members_freeze_delete`).
      if (parentTables.includes("parent_participant_migrations")) {
        sql.exec("DELETE FROM parent_participant_migrations WHERE parent_id = ?", input.parentId);
      }
      for (const table of parentTables) sql.exec(`DELETE FROM "${table}" WHERE parent_id = ?`, input.parentId);
      if (input.parentKind === "workstream") {
        sql.exec("DELETE FROM breakout_viewers WHERE workstream_id = ?", input.parentId);
        sql.exec("DELETE FROM breakouts WHERE workstream_id = ?", input.parentId);
        sql.exec("DELETE FROM channel_viewers WHERE workstream_id = ?", input.parentId);
        sql.exec("DELETE FROM channels WHERE workstream_id = ?", input.parentId);
      } else {
        sql.exec("DELETE FROM space_viewers WHERE space_id = ?", input.parentId);
        sql.exec("DELETE FROM spaces WHERE space_id = ?", input.parentId);
      }
    });
  }

  /**
   * The parent step of a conversation's effects, delivered by the activity
   * Queue consumer. The directory step lands in the same transaction. The
   * people the effects name are learned before it, so the transaction does
   * not have to stop for D1.
   */
  async receiveChildEffects(input: ReceiveChildEffectsRequest) {
    // Parsed before anything is written: the first envelope decides which
    // parent is served and, on a new object, the object's own identity.
    const request = parseRpcInput(ReceiveChildEffectsRequestSchema, input, "receive_child_effects");
    const envelope = request.envelopes[0]!;
    if (envelope.parentKind === "automation") {
      return this.sidekickCall(envelope.parentId, envelope.workspaceId,
        (sidekick) => ({ accepted: sidekick.receiveChildEffects(request) }));
    }
    if (envelope.parentKind === "canvas") {
      const canvas = await this.hostedCanvas(envelope.parentId, envelope.workspaceId);
      return this.canvasWrite(() => ({ accepted: canvas.receiveChildEffects(request) }));
    }
    // A Thread's or Channel's conversation was retired with it (plan step
    // B-7); nothing here hosts its parent any more.
    throw new ApiError(409, "conversation_parent_kind_retired", "This conversation's parent kind is retired",
      undefined, `conversation_parent_kind_retired:${envelope.parentKind}`);
  }

  async listAuthorizationChildren(input: ConversationParentAuthorityRequest): Promise<{ substreamIds: string[] }> {
    const hosted = await this.hostedConversationParent(input.parentId, input.workspaceId);
    return hosted
      ? hosted.authorizationDiscoveryChildren({ workspaceId: asWorkspaceId(input.workspaceId), parentId: input.parentId })
      : { substreamIds: [] };
  }

  /** A Sidekick's authorization facts, which are shaped unlike a Channel's. */
  async sidekickReadAuthorizationFacts(input: Parameters<HostedSidekick["readAuthorizationFacts"]>[0]) {
    const sidekick = await this.sidekickParent(input.parentId, input.workspaceId);
    if (!sidekick) return { exists: false as const, validatedAt: Date.now() };
    return sidekick.readAuthorizationFacts(input);
  }

  /**
   * A hosted conversation's authorization facts, a Sidekick's or a Canvas's,
   * each tagged by kind, in one call; `exists: false` when the id is neither.
   */
  async hostedConversationAuthorizationFacts(input: Parameters<HostedSidekick["readAuthorizationFacts"]>[0]) {
    const hosted = await this.hostedConversationParent(input.parentId, input.workspaceId);
    if (hosted instanceof HostedCanvas) return { kind: "canvas" as const, ...await hosted.readAuthorizationFacts(input) };
    if (hosted instanceof HostedSidekick) return { kind: "automation" as const, ...hosted.readAuthorizationFacts(input) };
    return { kind: null, exists: false as const, validatedAt: Date.now() };
  }

  /** The hosted conversation an id names, a Sidekick or a Canvas; `null` for anything else. */
  private async hostedConversationParent(parentId: string, workspaceId?: string): Promise<HostedSidekick | HostedCanvas | null> {
    return await this.sidekickParent(parentId, workspaceId) ?? await this.canvasParent(parentId, workspaceId);
  }

  // ---------------------------------------------------------------------------
  // Hosted Sidekicks. `HostedSidekick` is the Sidekick's parent; these lend it
  // this object's storage and the Organization facts it reads. See
  // docs/hosted-conversation-parents.md and docs/automation-lifecycle.md.
  // ---------------------------------------------------------------------------

  /** Set by a hosted Sidekick write that moved a directory row; the sidebar list is published after it. */
  private sidekickDirectoryMoved = false;
  /** Readers whose read of a Sidekick's shared conversation moved; see `publishSidekickList`. */
  private readonly sidekickReadersMoved = new Set<string>();

  private queueSidekickSourcesForUsers(userIds: readonly string[]): boolean {
    if (userIds.length === 0) return false;
    const targets = this.state.storage.sql.exec<{ automation_id: string }>(
      `SELECT DISTINCT directory.automation_id FROM automation_directory directory
         JOIN sidekick_delegations consent ON consent.sidekick_id=directory.automation_id
        WHERE directory.lifecycle='active' AND directory.evaluator_projection_json<>'[]'
          AND consent.user_id IN (SELECT value FROM json_each(?)) AND json_extract(consent.grant_json,'$.allowed')=1`,
      JSON.stringify(userIds),
    ).toArray();
    const host = this.hostedSidekickHost();
    for (const target of targets) new HostedSidekick(host, target.automation_id).scheduleSourceReconciliation();
    return targets.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Hosted Canvases. `HostedCanvas` is a Canvas's parent; these lend it this
  // object's storage and relationships. See docs/canvases.md.
  // ---------------------------------------------------------------------------

  /** Set by a hosted Canvas write that moved a directory row; the Canvas list is published after it. */
  private canvasDirectoryMoved = false;
  /** Readers whose read of a Canvas's Chat moved; see `publishCanvasList`. */
  private readonly canvasReadersMoved = new Set<string>();

  /** Whether an id names a Canvas: its directory row. Asked before the Channel fallback. */
  private isCanvasParent(parentId: string): boolean {
    return this.state.storage.sql.exec(
      `SELECT 1 FROM canvas_directory WHERE canvas_id = ? LIMIT 1`, parentId,
    ).toArray().length > 0;
  }

  private hostedCanvasHost(): HostedCanvasHost {
    return {
      env: this.env,
      storage: this.state.storage,
      readRelationship: (workspaceId, userId) => this.readRelationship(workspaceId, userId),
      noteRelationship: (relationship) => this.noteRelationship(relationship),
      noteCanvasReadChanged: (userId) => {
        this.state.storage.sql.exec(
          `UPDATE workspace_sidebar_list_state SET waterline = waterline + 1 WHERE list = 'canvases'`,
        );
        this.canvasReadersMoved.add(userId);
      },
      noteCanvasDirectoryChanged: () => this.noteCanvasDirectoryMoved(),
    };
  }

  /**
   * Every viewer's Canvas list moved: a row, its participants, or who is in
   * one. The waterline advances, since a client applies only a newer one.
   */
  private noteCanvasDirectoryMoved(): void {
    this.state.storage.sql.exec(
      `UPDATE workspace_sidebar_list_state SET waterline = waterline + 1 WHERE list = 'canvases'`,
    );
    this.canvasDirectoryMoved = true;
  }

  /** The hosted parent for a Canvas id; `null` for an id that names no Canvas. */
  private async canvasParent(parentId: string, workspaceId?: string): Promise<HostedCanvas | null> {
    await this.initialized;
    if (!this.isCanvasParent(parentId)) return null;
    if (workspaceId !== undefined) await this.ensureParentWorkspace(workspaceId);
    return new HostedCanvas(this.hostedCanvasHost(), parentId);
  }

  /** A Canvas for a method that may also create it. */
  private async hostedCanvas(canvasId: string, workspaceId: string): Promise<HostedCanvas> {
    await this.initialized;
    await this.ensureParentWorkspace(workspaceId);
    return new HostedCanvas(this.hostedCanvasHost(), canvasId);
  }

  /** Run a hosted Canvas write, then publish what it moved and arm what it scheduled. */
  private async canvasWrite<T>(run: () => Promise<T> | T): Promise<T> {
    try {
      return await run();
    } finally {
      this.publishCanvasList();
      await this.afterHostedWrite();
    }
  }

  /** Create a Canvas's directory row; see `HostedCanvas.create`. */
  async canvasCreate(input: Parameters<HostedCanvas["create"]>[0]) {
    const canvas = await this.hostedCanvas(input.canvasId, input.workspaceId);
    return this.canvasWrite(() => canvas.create(input));
  }

  /**
   * One viewer's Canvas list as their socket's subscribe payload carries it,
   * without anyone present: the read a caller with no workspace socket makes
   * (the demo readiness barrier). See `canvasSidebarRows`.
   */
  async canvasListFor(input: { workspaceId: string; userId: string; member: boolean }) {
    this.assertWorkspace(input.workspaceId);
    return canvasSidebarRows(this.state.storage.sql, { userId: input.userId, member: input.member }, new Map(), SIDEBAR_LIST_LIMIT);
  }

  /** A Canvas as one reader sees it; see `HostedCanvas.detail`. */
  async canvasDetail(input: Parameters<HostedCanvas["detail"]>[0]) {
    return (await this.hostedCanvas(input.canvasId, input.workspaceId)).detail(input);
  }

  /** Record an artifact a publish attached to a Canvas; `noted: false` for an id that is no Canvas. See `HostedCanvas.noteArtifact`. */
  async canvasNoteArtifact(input: Parameters<HostedCanvas["noteArtifact"]>[0]) {
    const canvas = await this.canvasParent(input.canvasId, input.workspaceId);
    if (!canvas) return { noted: false };
    return this.canvasWrite(() => canvas.noteArtifact(input));
  }

  /**
   * Which Canvas a Sidekick run publishes into: the one named, which must be
   * one this Sidekick writes, or the one this run already made; `null` when
   * the run has made none yet, and its caller creates it.
   */
  async canvasForSidekickRun(input: { workspaceId: string; sidekickId: string; runId: string; canvasId: string | null }): Promise<{ canvasId: string | null }> {
    await this.initialized;
    this.assertWorkspace(input.workspaceId);
    if (input.canvasId !== null) {
      const row = this.state.storage.sql.exec<{ writer_sidekick_id: string | null }>(
        `SELECT writer_sidekick_id FROM canvas_directory WHERE canvas_id = ? AND workspace_id = ?`, input.canvasId, input.workspaceId,
      ).toArray()[0];
      if (row?.writer_sidekick_id !== input.sidekickId) {
        throw new ApiError(404, "canvas_not_written_by_sidekick", "This Sidekick does not write that Canvas");
      }
      return { canvasId: input.canvasId };
    }
    return { canvasId: this.state.storage.sql.exec<{ canvas_id: string }>(
      `SELECT canvas_id FROM canvas_directory WHERE writer_sidekick_id = ? AND writer_run_id = ?`, input.sidekickId, input.runId,
    ).toArray()[0]?.canvas_id ?? null };
  }

  /** The Canvases a Sidekick writes that this viewer may open; see `canvasesWrittenBy`. */
  async canvasesWrittenBySidekick(input: { workspaceId: string; sidekickId: string; actor: { userId: string; actorRole: "owner" | "admin" | "member" | null } }) {
    await this.initialized;
    this.assertWorkspace(input.workspaceId);
    return canvasesWrittenBy(this.state.storage.sql, input.sidekickId, input.actor);
  }

  /**
   * What Rally is told about the Canvas whose Chat it answers in: its title
   * and its artifacts at their current versions. A host read for a run the
   * conversation already admitted, so it names no viewer; `null` for an id
   * that is no Canvas.
   */
  async canvasContext(input: { workspaceId: string; canvasId: string }) {
    const canvas = await this.canvasParent(input.canvasId, input.workspaceId);
    const row = canvas?.row();
    if (!canvas || !row || row.workspace_id !== input.workspaceId) return null;
    return { canvasId: row.canvas_id, title: row.title, artifacts: canvas.artifacts() };
  }

  /** Retitle a Canvas; see `HostedCanvas.rename`. */
  async canvasRename(input: Parameters<HostedCanvas["rename"]>[0]) {
    const canvas = await this.hostedCanvas(input.canvasId, input.workspaceId);
    return this.canvasWrite(() => canvas.rename(input));
  }

  /** Change who can open a Canvas; see `HostedCanvas.setAudience`. */
  async canvasSetAudience(input: Parameters<HostedCanvas["setAudience"]>[0]) {
    const canvas = await this.hostedCanvas(input.canvasId, input.workspaceId);
    return this.canvasWrite(async () => {
      const detail = await canvas.setAudience(input);
      // Someone the Canvas no longer admits stops being shown in it, and the
      // people still in it are told who is left, before the one Canvas list
      // the write sends.
      this.broadcastPresence();
      return detail;
    });
  }

  /**
   * Send the Canvas list what moved since it was last sent: every socket for
   * a change to a Canvas's row or who is in one, or only the sockets of the
   * people whose read of a Chat moved. Read per socket, because the list is
   * scoped to what its viewer may open.
   */
  private publishCanvasList(): void {
    const everyone = this.canvasDirectoryMoved;
    const readers = new Set(this.canvasReadersMoved);
    this.canvasDirectoryMoved = false;
    this.canvasReadersMoved.clear();
    if (!everyone && readers.size === 0) return;
    const occurredAt = new Date().toISOString();
    const waterline = this.canvasListWaterline();
    const present = this.presentByCanvas();
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed || (!everyone && !readers.has(attachment.userId))) continue;
      try {
        socket.send(JSON.stringify(WorkspaceCanvasListEventSchema.parse({
          type: "workspace_canvas_list", occurredAt, waterline, items: this.canvasList(attachment, present),
        })));
      } catch {
        // A reconnect receives the whole list in the subscribe payload.
      }
    }
  }

  private canvasListWaterline(): number {
    return this.state.storage.sql.exec<{ waterline: number }>(
      `SELECT waterline FROM workspace_sidebar_list_state WHERE list = 'canvases'`,
    ).toArray()[0]?.waterline ?? 0;
  }

  /** One socket's Canvas list; see `canvasSidebarRows`. */
  private canvasList(attachment: WorkspaceSocketAttachment, present = this.presentByCanvas()) {
    return canvasSidebarRows(this.state.storage.sql,
      { userId: attachment.userId, member: viewerOf(attachment).accessClass === "member" }, present, SIDEBAR_LIST_LIMIT);
  }

  /** Who is in each Canvas now: the people whose foreground socket has it open. */
  private presentByCanvas(): Map<string, string[]> {
    const present = new Map<string, Set<string>>();
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!contributesPresence(attachment) || !this.isCanvasParent(attachment.foregroundWorkstreamId)) continue;
      const users = present.get(attachment.foregroundWorkstreamId) ?? new Set<string>();
      users.add(attachment.userId);
      present.set(attachment.foregroundWorkstreamId, users);
    }
    return new Map([...present].map(([canvasId, users]) => [canvasId, [...users].sort()]));
  }

  /** The Canvas presence last published, so a presence change that moves no Canvas sends no list. */
  private lastCanvasPresence = "[]";

  /** A Canvas the viewer may open is visible to presence, as a listed Channel is; `null` for an id that is no Canvas. */
  private canvasVisible(viewer: Viewer, canvasId: string): boolean | null {
    const row = this.state.storage.sql.exec<CanvasRow>(`SELECT * FROM canvas_directory WHERE canvas_id = ?`, canvasId).toArray()[0];
    if (!row) return null;
    return canvasReaderAllows(row, { userId: viewer.userId, actorRole: viewer.accessClass === "member" ? "member" : null },
      this.state.storage.sql);
  }

  /**
   * Pin or unpin a Canvas or a Sidekick in the viewer's Pinned group of that
   * list, or put that group in an order. The item must be one the viewer may
   * open; the change goes out as that list's rows, to that viewer.
   */
  async setSidebarPin(input: {
    workspaceId: string; userId: string; accessClass: "member" | "guest";
    kind: "canvas" | "sidekick"; itemId: string; pinned: boolean;
  }): Promise<{ ok: boolean }> {
    await this.initialized;
    this.assertWorkspace(input.workspaceId);
    const viewer: Viewer = { userId: input.userId, accessClass: input.accessClass };
    const visible = input.kind === "canvas"
      ? this.canvasVisible(viewer, input.itemId) === true
      : this.sidekickListed(input.workspaceId, input.userId, input.itemId);
    if (input.pinned && !visible) return { ok: false };
    const pins = new WorkspacePinStorage(this.state.storage);
    const now = Date.now();
    const changed = input.pinned ? pins.pin(input.userId, input.kind, input.itemId, now) : pins.unpin(input.userId, input.kind, input.itemId);
    if (changed) this.publishPinnedList(input.kind, input.userId);
    return { ok: true };
  }

  async reorderSidebarPins(input: { workspaceId: string; userId: string; kind: "canvas" | "sidekick"; itemIds: string[] }): Promise<void> {
    await this.initialized;
    this.assertWorkspace(input.workspaceId);
    new WorkspacePinStorage(this.state.storage).reorder(input.userId, input.kind, input.itemIds, Date.now());
    this.publishPinnedList(input.kind, input.userId);
  }

  /** A pin is one viewer's: only their list moves, at a new waterline. */
  private publishPinnedList(kind: "canvas" | "sidekick", userId: string): void {
    this.state.storage.sql.exec(`UPDATE workspace_sidebar_list_state SET waterline = waterline + 1 WHERE list = ?`,
      kind === "canvas" ? "canvases" : "automations");
    if (kind === "canvas") {
      this.canvasReadersMoved.add(userId);
      this.publishCanvasList();
    } else {
      this.publishSidebarList("automations", new Set([userId]));
    }
  }

  /**
   * Whether an id names a Sidekick: its directory row. Asked before the
   * Channel fallback, which would otherwise read a Sidekick as a Channel.
   */
  private isSidekickParent(parentId: string): boolean {
    return this.state.storage.sql.exec(
      `SELECT 1 FROM automation_directory WHERE automation_id = ? LIMIT 1`, parentId,
    ).toArray().length > 0;
  }

  private hostedSidekickHost(): HostedSidekickHost {
    return {
      env: this.env,
      storage: this.state.storage,
      alarms: this.scheduledAlarms,
      writeRegistrations: (automationId, evaluators) => this.writeSidekickRegistrations(automationId, evaluators),
      reconcileRegistrations: (automationId, evaluators) => {
        const request = ExternalEventRegistrationProjectionV1Schema.parse({ schemaVersion: 1, workspaceId: this.workspaceId(),
          destination: { kind: "automation", automationId }, sourceGeneration: 1, evaluators });
        this.replaceExternalEventRegistrationRows(request, `automation:${automationId}`, Date.now(), true);
      },
      afterRegistrations: (automationId, revision, evaluators) => this.afterSidekickRegistrations(automationId, revision, evaluators),
      noteDirectoryChanged: (automationId, deleted, now) => {
        this.state.storage.sql.exec(
          `UPDATE workspace_sidebar_list_state SET waterline = waterline + 1 WHERE list = 'automations'`,
        );
        // A deleted Sidekick's runs take no more input, so the threads its
        // sends opened stop routing to them; the rows stay, suspended.
        if (deleted) this.externalBindings().suspendDeletedSidekick(automationId, new Date(now).toISOString());
        this.sidekickDirectoryMoved = true;
      },
      noteViewerReadChanged: (userId) => {
        // The waterline is the list's, so it moves; only this reader is sent it.
        this.state.storage.sql.exec(
          `UPDATE workspace_sidebar_list_state SET waterline = waterline + 1 WHERE list = 'automations'`,
        );
        this.sidekickReadersMoved.add(userId);
      },
      readRelationship: (workspaceId, userId) => this.readRelationship(workspaceId, userId),
      sendRunProvision: async (message) => {
        await this.env.ACTIVITY_QUEUE.send(SidekickRunProvisionQueueMessageSchema.parse({
          kind: "sidekick_run_provision", region: this.env.AVALON_REGION, ...message,
        }));
      },
      sendReview: async (message) => {
        await this.env.ACTIVITY_QUEUE.send(SidekickReviewQueueMessageSchema.parse({
          kind: "sidekick_review", region: this.env.AVALON_REGION, ...message,
        }));
      },
    };
  }

  /** The hosted parent for a Sidekick id; `null` for an id that names no Sidekick. */
  private async sidekickParent(parentId: string, workspaceId?: string): Promise<HostedSidekick | null> {
    await this.initialized;
    if (!this.isSidekickParent(parentId)) return null;
    if (workspaceId !== undefined) await this.ensureParentWorkspace(workspaceId);
    return new HostedSidekick(this.hostedSidekickHost(), parentId);
  }

  /** A Sidekick for a method that may also create it. */
  private async hostedSidekick(automationId: string, workspaceId: string): Promise<HostedSidekick> {
    await this.initialized;
    await this.ensureParentWorkspace(workspaceId);
    return new HostedSidekick(this.hostedSidekickHost(), automationId);
  }

  /**
   * Record a write's sync topics in the transaction that committed the write,
   * so a crash between the commit and the publish leaves it for the alarm
   * rather than losing it. The row is not due until one retry delay has
   * passed: the write that recorded it runs it straight after the commit, and
   * the alarm only takes what that run did not finish.
   */
  private recordSyncFollowUp(followUp: SyncFollowUp): { id: number; json: string } {
    const now = Date.now();
    const json = JSON.stringify(followUp);
    const { id } = this.state.storage.sql.exec<{ id: number }>(
      `INSERT INTO workspace_directory_followups (followup_json, attempts, not_before, created_at)
       VALUES (?, 0, ?, ?) RETURNING id`,
      json, now + scheduledAlarmRetryDelay(1), now,
    ).one();
    return { id, json };
  }

  /**
   * Publish the topics of recorded follow-ups and delete each one that went
   * out. One whose publish throws is put off on the alarm's retry schedule and
   * logged with its reason; one that does not parse is kept as `failed` and
   * never run. A follow-up named with its JSON runs only if its row still
   * holds that JSON.
   */
  private async runSyncFollowUps(entries: readonly (number | { id: number; json: string })[]): Promise<void> {
    for (const entry of entries) {
      const id = typeof entry === "number" ? entry : entry.id;
      const row = this.state.storage.sql.exec<{ followup_json: string; attempts: number }>(
        `SELECT followup_json, attempts FROM workspace_directory_followups WHERE id = ? AND state = 'pending'`, id,
      ).toArray()[0];
      if (!row || (typeof entry !== "number" && row.followup_json !== entry.json)) continue;
      const stored: unknown = JSON.parse(row.followup_json);
      const parsed = SyncFollowUpSchema.safeParse(stored);
      const retired = retiredSyncTopics((stored as { syncTopics?: unknown } | null)?.syncTopics);
      if (retired.length > 0) {
        logInfo(this.env, "workspace_sync_retired_topics_dropped", {
          workspace_id: this.workspaceId(), followup_id: id, source: "sync_followup", topics: retired,
        });
      }
      if (!parsed.success) {
        const code = zodDiagnosticCode(parsed.error, "directory_followup") ?? "directory_followup_invalid";
        this.state.storage.sql.exec(
          `UPDATE workspace_directory_followups SET state = 'failed', last_error_code = ? WHERE id = ?`, code, id,
        );
        logError(this.env, "directory_followup_unreadable", { workspace_id: this.workspaceId(), followup_id: id, code });
        continue;
      }
      try {
        if (parsed.data.syncTopics.length > 0) {
          await this.publishSync(parsed.data.syncTopics, parsed.data.workspaceId,
            this.placementAffinity() ?? await workspacePlacementAffinity(this.env, parsed.data.workspaceId));
        }
        this.state.storage.sql.exec(`DELETE FROM workspace_directory_followups WHERE id = ?`, id);
      } catch (error) {
        const attempts = row.attempts + 1;
        this.state.storage.sql.exec(
          `UPDATE workspace_directory_followups SET attempts = ?, not_before = ?, last_error_code = ? WHERE id = ?`,
          attempts, Date.now() + scheduledAlarmRetryDelay(attempts),
          diagnosticErrorCode(error, "directory_followup_failed"), id,
        );
        logWarn(this.env, "directory_followup_deferred", {
          workspace_id: parsed.data.workspaceId, followup_id: id,
          code: diagnosticErrorCode(error, "directory_followup_failed"),
        });
      }
    }
  }

  private dueSyncFollowUps(now: number): number[] {
    return this.state.storage.sql.exec<{ id: number }>(
      `SELECT id FROM workspace_directory_followups WHERE state = 'pending' AND not_before <= ? ORDER BY id LIMIT ?`,
      now, SCHEDULED_ALARM_DRAIN_LIMIT,
    ).toArray().map((row) => row.id);
  }

  private syncFollowUpTablePresent(): boolean {
    const present = this.state.storage.sql.exec(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_directory_followups'",
    ).toArray().length > 0;
    // Named once per instance: an Organization held below migration 72 has no
    // follow-up lane, which is expected there and a defect anywhere else.
    if (!present && !this.followUpTableAbsenceLogged) {
      this.followUpTableAbsenceLogged = true;
      logInfo(this.env, "workspace_directory_followups_absent", { reason: "below_migration_72" });
    }
    return present;
  }

  private followUpTableAbsenceLogged = false;

  private nextSyncFollowUpDueAt(): number | null {
    return this.state.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(not_before) AS due_at FROM workspace_directory_followups WHERE state = 'pending'`,
    ).one().due_at;
  }

  /**
   * After a hosted Canvas or Sidekick write: publish the topics it recorded,
   * and arm what it scheduled.
   */
  private async afterHostedWrite(): Promise<void> {
    const followUps = this.pendingSyncFollowUps.splice(0);
    if (followUps.length > 0) await this.runSyncFollowUps(followUps);
    await this.armNextAlarm();
  }

  /**
   * An Organization object that has never been initialized learns its own id
   * from the first parent request. An id that disagrees is refused.
   */
  private async ensureParentWorkspace(workspaceId: string): Promise<void> {
    if (!this.workspaceId()) {
      this.ensureIdentity(workspaceId, await workspacePlacementAffinity(this.env, workspaceId));
    }
    this.assertWorkspace(workspaceId);
  }

  /** Run a hosted Sidekick call, then publish the sidebar list and arm what it scheduled. */
  private async sidekickCall<T>(automationId: string, workspaceId: string, run: (sidekick: HostedSidekick) => Promise<T> | T): Promise<T> {
    const sidekick = await this.hostedSidekick(automationId, workspaceId);
    try {
      return await run(sidekick);
    } finally {
      this.publishSidekickList();
      await this.afterHostedWrite();
    }
  }

  /**
   * Run a hosted Sidekick read. A read writes nothing, so it skips what a
   * write owes afterward: no sidebar publish and no alarm re-arm. A run asks
   * for its state before every provider write, so this is a hot path.
   */
  private async sidekickRead<T>(automationId: string, workspaceId: string, run: (sidekick: HostedSidekick) => T): Promise<T> {
    return run(await this.hostedSidekick(automationId, workspaceId));
  }

  /**
   * The Sidekicks a batch read covers, each with its accepted revision, in one
   * statement: the ids asked for, plus every one a Channel recommends or owns
   * when `channelId` is given, plus every active loadable one when
   * `allLoadable` is set. Order is the caller's, then the Channel's
   * recommendations, then what it owns, then the Organization's, with no
   * repeats; an id that names no Sidekick is skipped, and `onlyScope` keeps
   * one scope.
   */
  private selectSidekickRows(selection: {
    workspaceId: string;
    automationIds?: readonly string[] | undefined;
    channelId?: string | undefined;
    allLoadable?: boolean | undefined;
    onlyScope?: string | undefined;
  }): (HostedSidekickRow & { accepted_definition_json: string | null })[] {
    return this.state.storage.sql.exec<HostedSidekickRow & { accepted_definition_json: string | null }>(
      `WITH requested(automation_id, tier, position) AS (
         SELECT value, 0, key FROM json_each(?1)
         UNION ALL
         SELECT sidekick_id, 1, ROW_NUMBER() OVER (ORDER BY attached_at, sidekick_id)
           FROM parent_sidekicks WHERE ?2 IS NOT NULL AND parent_id = ?2
         UNION ALL
         SELECT automation_id, 3, ROW_NUMBER() OVER (ORDER BY automation_id)
           FROM automation_directory WHERE ?3 = 1 AND workspace_id = ?4 AND lifecycle = 'active' AND loadable = 1
       ), ranked AS (
         SELECT automation_id, ROW_NUMBER() OVER (ORDER BY tier, position) AS rank
           FROM (
             SELECT automation_id, tier, position,
                    ROW_NUMBER() OVER (PARTITION BY automation_id ORDER BY tier, position) AS occurrence
               FROM requested
           )
          WHERE occurrence = 1
       )
       SELECT directory.*, accepted.definition_json AS accepted_definition_json
         FROM ranked
         JOIN automation_directory directory
           ON directory.automation_id = ranked.automation_id
          AND directory.workspace_id = ?4 AND directory.region IS NOT NULL
         LEFT JOIN sidekick_revisions accepted
           ON accepted.sidekick_id = directory.automation_id
          AND accepted.definition_revision = directory.accepted_definition_revision
        WHERE ?5 IS NULL OR directory.scope = ?5
        ORDER BY ranked.rank`,
      JSON.stringify(selection.automationIds ?? []),
      selection.channelId ?? null,
      selection.allLoadable ? 1 : 0,
      selection.workspaceId,
      selection.onlyScope ?? null,
    ).toArray();
  }

  /**
   * Replace a hosted Sidekick's connector registrations inside the caller's
   * transaction, and return the event sequence they take effect after. No
   * generation fence: the Sidekick's own transaction orders its writes, and
   * the legacy fence row is removed so the legacy RPC path cannot reuse it.
   */
  private writeSidekickRegistrations(automationId: string, evaluators: readonly unknown[]): number {
    const workspaceId = this.workspaceId();
    if (!workspaceId) throw new Error("workspace_identity_unknown");
    // A source generation, though none is fenced on: with one, each row keeps
    // its evaluator's id, which is what an admitted event names.
    const request = ExternalEventRegistrationProjectionV1Schema.parse({
      schemaVersion: 1, workspaceId, destination: { kind: "automation", automationId }, sourceGeneration: 1, evaluators,
    });
    const destinationKey = `automation:${automationId}`;
    this.state.storage.sql.exec(`DELETE FROM external_registration_generations WHERE destination_key = ?`, destinationKey);
    return this.replaceExternalEventRegistrationRows(request, destinationKey, Date.now()).effectiveAfterEventSequence;
  }

  /**
   * After a hosted Sidekick's registrations committed: its Slack sources'
   * joins, keyed on its revision. Its schedule entries were written in the
   * change's own transaction, and the caller re-arms the native alarm.
   */
  private async afterSidekickRegistrations(automationId: string, revision: number | null, evaluators: readonly unknown[]): Promise<void> {
    const workspaceId = this.workspaceId();
    if (!workspaceId) return;
    if (revision !== null && evaluators.length > 0) await this.joinSidekickSlackSources(workspaceId, automationId, revision, evaluators);
  }

  /** A Sidekick's Slack sources' joins, keyed on the revision whose registrations named them. */
  private async joinSidekickSlackSources(
    workspaceId: string, automationId: string, revision: number, evaluators: readonly unknown[],
  ): Promise<void> {
    const parsed = ExternalEventRegistrationProjectionV1Schema.parse({
      schemaVersion: 1, workspaceId, destination: { kind: "automation", automationId }, evaluators,
    });
    await this.joinSlackSourceConversations(workspaceId, automationId, revision, parsed.evaluators);
  }

  // The Sidekick methods. Each calls the `HostedSidekick` method of the same
  // name, with the same request.

  async sidekickCreate(input: Parameters<HostedSidekick["create"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.create(input));
  }

  async sidekickSaveDefinition(input: Parameters<HostedSidekick["saveDefinition"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.saveDefinition(input));
  }

  async sidekickSubmitDefinition(input: Parameters<HostedSidekick["submitDefinition"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.submitDefinition(input));
  }

  async sidekickApply(input: Parameters<HostedSidekick["apply"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.apply(input));
  }

  async sidekickReconcileLoadable(input: Parameters<HostedSidekick["reconcileLoadable"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.reconcileLoadable(input));
  }

  async sidekickReadDetail(input: Parameters<HostedSidekick["readDetail"]>[0]): Promise<AutomationDetail> {
    const detail = await this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.readDetail(input));
    // "The Canvases it writes to": a query on the Canvas directory, in the same call.
    return { ...detail, canvases: canvasesWrittenBy(this.state.storage.sql, input.automationId,
      { userId: input.actor.userId, actorRole: input.actor.actorRole ?? null }) };
  }

  async sidekickSetAppearance(input: Parameters<HostedSidekick["setAppearance"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.setAppearance(input));
  }

  async sidekickSetAudience(input: Parameters<HostedSidekick["setAudience"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.setAudience(input));
  }

  async sidekickPause(input: Parameters<HostedSidekick["pause"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.pause(input));
  }

  async sidekickResume(input: Parameters<HostedSidekick["resume"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.resume(input));
  }

  async sidekickRemove(input: Parameters<HostedSidekick["remove"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.remove(input));
  }

  async sidekickRunNow(input: Parameters<HostedSidekick["runNow"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.runNow(input));
  }

  async sidekickRunSeeded(input: Parameters<HostedSidekick["runSeeded"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.runSeeded(input));
  }

  /** Rebuild a Sidekick's run rows in its shared conversation from its runs; see `HostedSidekick.replayRunRows`. */
  async sidekickReplayRunRows(input: Parameters<HostedSidekick["replayRunRows"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.replayRunRows(input));
  }

  /** Who answers a message in a Sidekick's shared conversation; see `HostedSidekick.admitConversationMessage`. */
  async sidekickAdmitConversationMessage(input: Parameters<HostedSidekick["admitConversationMessage"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.admitConversationMessage(input));
  }

  /** Whether a person manages a Sidekick; see `HostedSidekick.allowsManager`. */
  async sidekickAllowsManager(input: Parameters<HostedSidekick["allowsManager"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.allowsManager(input));
  }

  async sidekickListRuns(input: Parameters<HostedSidekick["listRuns"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.listRuns(input));
  }

  async sidekickListRunsPage(input: Parameters<HostedSidekick["listRunsPage"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.listRunsPage(input));
  }

  async sidekickReadRunForReview(input: Parameters<HostedSidekick["readRunForReview"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.readRunForReview(input));
  }

  async sidekickReviewRunsToRead(input: Parameters<HostedSidekick["reviewRunsToRead"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.reviewRunsToRead(input));
  }

  async sidekickClaimExecutionPrincipal(input: Parameters<HostedSidekick["claimExecutionPrincipal"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.claimExecutionPrincipal(input));
  }

  async sidekickPrepareMyDelegation(input: Parameters<HostedSidekick["prepareMyDelegation"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.prepareMyDelegation(input));
  }

  async sidekickSetDelegation(input: Parameters<HostedSidekick["setDelegation"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.setDelegation(input));
  }

  async sidekickReadMyDelegationReceipt(input: Parameters<HostedSidekick["readMyDelegationReceipt"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.readMyDelegationReceipt(input));
  }

  async sidekickReadDelegation(input: Parameters<HostedSidekick["readDelegation"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.readDelegation(input));
  }

  async sidekickReadExecutionDelegation(input: Parameters<HostedSidekick["readExecutionDelegation"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.readExecutionDelegation(input));
  }

  /** Own consent records remain readable without membership or Sidekick viewer access. */
  async sidekickReadMyDelegations(input: { workspaceId: string; userId: string }) {
    await this.initialized;
    const userId = asUserId(input.userId);
    asWorkspaceId(input.workspaceId);
    if (!this.workspaceId()) return { userId, delegations: [] };
    this.assertWorkspace(input.workspaceId);
    const grants = new SidekickDelegationStorage(this.state.storage).forUser(userId);
    return {
      userId,
      delegations: await Promise.all(grants.map(async (grant) => {
        const sidekick = await this.hostedSidekick(grant.sidekickId, input.workspaceId);
        return {
          sidekickId: grant.sidekickId, label: grant.label, allowed: grant.allowed,
          eligible: await sidekick.delegationEligible(grant),
        };
      })),
    };
  }

  async sidekickAdmitExternalEvent(input: Parameters<HostedSidekick["admitExternalEvent"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.admitExternalEvent(input));
  }

  async sidekickAdmitInboundEmail(input: Parameters<HostedSidekick["admitInboundEmail"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.admitInboundEmail(input));
  }

  async sidekickReadSkillSource(input: Parameters<HostedSidekick["readSkillSource"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.readSkillSource(input));
  }

  async sidekickReadSkillSummary(input: Parameters<HostedSidekick["readSkillSummary"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.readSkillSummary(input));
  }

  async sidekickReadRunDefinition(input: Parameters<HostedSidekick["readRunDefinition"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.readRunDefinition(input));
  }

  async sidekickReadRunState(input: Parameters<HostedSidekick["readRunState"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.readRunState(input));
  }

  async sidekickNotePermissionReportUnavailable(input: Parameters<HostedSidekick["notePermissionReportUnavailable"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.notePermissionReportUnavailable(input));
  }

  async sidekickContinueRun(input: Parameters<HostedSidekick["continueRun"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, async (sidekick) => {
      const result = await sidekick.continueRun(input);
      if (result.outcome === "refused" && result.code === "run_no_eligible_delegate") {
        sidekick.noteDelegationAttention("no_eligible_delegate");
      }
      return result;
    });
  }

  /** For the provisioning consumer: what to start, or `null` once the run is no longer pending. */
  async sidekickRunProvisioning(input: Parameters<HostedSidekick["runProvisioning"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.runProvisioning(input));
  }

  /** For the provisioning consumer: the run's loop started. */
  async sidekickRunProvisioned(input: Parameters<HostedSidekick["runProvisioned"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.runProvisioned(input));
  }

  /** For the review consumer: the notice to admit into the wizard's conversation, or `null`. */
  async sidekickReviewDelivery(input: Parameters<HostedSidekick["reviewDelivery"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.reviewDelivery(input));
  }

  /** For the review consumer: the notice reached the wizard. */
  async sidekickReviewDelivered(input: Parameters<HostedSidekick["reviewDelivered"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.reviewDelivered(input));
  }

  // Batch reads. Every Sidekick in an Organization is here, so a caller that
  // needs several asks once: one call, answered from local rows, instead of
  // one call per Sidekick queued behind each other on this object.

  /** Rail metadata for each selected Sidekick the audience may see, optionally only Organization ones. */
  async sidekickReadSkillSummaries(input: SidekickBatchSkillReadRequest): Promise<SidekickAttachment[]> {
    await this.initialized;
    const { automationIds, channelId, allLoadable, onlyScope, ...request } = SidekickBatchSkillReadRequestSchema.parse(input);
    await this.ensureParentWorkspace(request.workspaceId);
    return this.selectSidekickRows({ workspaceId: request.workspaceId, automationIds, channelId, allLoadable, onlyScope })
      .flatMap((row) => skillSummary(row, request) ?? []);
  }

  /** What each selected Sidekick lends a run as a skill; one entry per Sidekick that lends one. */
  async sidekickReadSkillSources(input: SidekickBatchSkillReadRequest): Promise<SidekickSkillSource[]> {
    await this.initialized;
    const { automationIds, channelId, allLoadable, onlyScope, ...request } = SidekickBatchSkillReadRequestSchema.parse(input);
    await this.ensureParentWorkspace(request.workspaceId);
    return this.selectSidekickRows({ workspaceId: request.workspaceId, automationIds, channelId, allLoadable, onlyScope })
      .flatMap((row) => skillSource(row, request) ?? []);
  }

  /** The detail of each selected Sidekick, for an actor who may read every one of them. */
  async sidekickReadDetails(input: SidekickBatchDetailRequest): Promise<AutomationDetail[]> {
    await this.initialized;
    const { automationIds, ...request } = SidekickBatchDetailRequestSchema.parse(input);
    const ids = [...new Set(automationIds ?? [])];
    await this.ensureParentWorkspace(request.workspaceId);
    const host = this.hostedSidekickHost();
    const details: AutomationDetail[] = [];
    // Each detail is an access decision for this actor, so each is its own read.
    for (const automationId of ids) {
      details.push(await new HostedSidekick(host, automationId).readDetail({ ...request, automationId }));
    }
    return details;
  }

  // Shares. A Canvas is the one parent left that shares by address.

  async createScopeInvitations(input: Parameters<HostedCanvas["createInvitations"]>[0]) {
    const canvas = await this.requireCanvasParent(input.parentId, input.workspaceId);
    return this.canvasWrite(() => canvas.createInvitations(input));
  }

  /**
   * A sign-in's claim of the shares addressed to it. A lookup row can still
   * name a retired Thread or Channel; that claims nothing rather than failing
   * the sign-in.
   */
  async claimScopeInvitations(input: Parameters<HostedCanvas["claimInvitations"]>[0]) {
    const canvas = await this.canvasParent(input.parentId, input.workspaceId);
    return canvas ? this.canvasWrite(() => canvas.claimInvitations(input)) : [];
  }

  async revokeScopeInvitation(input: Parameters<HostedCanvas["revokeInvitation"]>[0]) {
    const canvas = await this.requireCanvasParent(input.parentId, input.workspaceId);
    return this.canvasWrite(() => canvas.revokeInvitation(input));
  }

  private async requireCanvasParent(parentId: string, workspaceId: string): Promise<HostedCanvas> {
    const canvas = await this.canvasParent(parentId, workspaceId);
    if (!canvas) throw new ApiError(404, "conversation_parent_not_found", "This conversation's parent does not exist");
    return canvas;
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

  /** Callers must pass only IDs admitted by the authorization primitive; this snapshot query applies no visibility predicates. */
  async resourceSearchRecords(input: unknown): Promise<Array<Record<string, SqlStorageValue>>> {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, resourceIds: z.array(IdSchema) }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.state.storage.sql.exec<Record<string, SqlStorageValue>>(`SELECT r.*, v.revision AS search_revision,
      c.connector_type, CASE WHEN EXISTS (SELECT 1 FROM resource_watches rw
        WHERE rw.resource_id = r.id AND rw.workspace_id = r.workspace_id AND rw.enabled = 1)
        THEN 1 ELSE 0 END AS watch_enabled
      FROM resources r JOIN resource_search_versions v ON v.resource_id = r.id
      LEFT JOIN connector_connections c ON c.id = r.connection_id
      WHERE r.workspace_id = ? AND r.id IN (SELECT value FROM json_each(?))`,
    request.workspaceId, JSON.stringify(request.resourceIds)).toArray();
  }

  async resourceSearchRevision(input: unknown): Promise<number | null> {
    await this.initialized;
    const request = ResourceSearchRevisionRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return resourceSearchRevision(this.state.storage.sql, request.resourceId);
  }

  async prepareResourceSearch(input: unknown) {
    return this.prepareResourceSearchSource(input);
  }

  /** Fail/retry on an old instance instead of silently reading every category. */
  async prepareResourceSearchDocument(input: unknown, documentId: unknown) {
    return this.prepareResourceSearchSource(input, z.string().min(1).parse(documentId));
  }

  private async prepareResourceSearchSource(input: unknown, documentId?: string) {
    await this.initialized;
    const request = ResourceSearchProjectionSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (request.region !== this.env.AVALON_REGION) throw new Error("search_projection_region_mismatch");
    return prepareResourceSearch(this.state.storage.sql, this.env, request.workspaceId, request.resourceId, documentId);
  }

  /** Trusted Worker compatibility port for WorkspaceDO-owned relational state. */
  async executeRuntimeSql(input: WorkspaceRuntimeSqlRequest): Promise<DurableObjectRpcResult> {
    await this.initialized;
    try {
      const request = WorkspaceRuntimeSqlRequestSchema.parse(input);
      this.assertWorkspace(request.workspaceId);
      const results = this.runWorkspaceSql(request);
      if (request.statements.some((statement) => workspaceMutationTarget(statement.sql) === "connector_connections")
        && this.state.storage.sql.exec("SELECT 1 FROM _internal_durable_alarms WHERE kind='sidekick_delegation_sources' LIMIT 1").toArray().length > 0) {
        await this.armNextAlarm();
      }
      const kinds = new Set<WorkspaceScheduleTargetKind>();
      for (const statement of request.statements) {
        const target = workspaceMutationTarget(statement.sql);
        for (const kind of target === null ? [] : WORKSPACE_ALARM_SOURCE_KINDS.get(target) ?? []) {
          kinds.add(kind);
        }
      }
      if (kinds.size > 0) {
        this.state.waitUntil(this.refreshScheduleKinds(request.workspaceId, [...kinds]).catch((error: unknown) => {
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
    // A retired Channel control socket still hibernating here carries an
    // attachment the workspace reader refuses, and is closed below.
    // Record callback ingress before initialization can stall; parse the
    // attachment only once because this callback also handles presence frames.
    this.lastSocketEventAt = Date.now();
    const attachment = readAttachment(socket);
    if (attachment && !attachment.subscribed && !attachment.firstFrameReported) {
      socket.serializeAttachment({ ...attachment, firstFrameReported: true } satisfies WorkspaceSocketAttachment);
      // Safe before `initialized`: the constructor's migrations run under
      // `blockConcurrencyWhile`, which no socket callback can overtake.
      if (this.unheardLedger) {
        this.state.storage.sql.exec(`DELETE FROM workspace_socket_unheard WHERE connection_id = ?`, attachment.connectionId);
      }
      this.logWorkspaceSocketHandshake(attachment, "frame_received");
    }
    await this.initialized;
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
    if (isUnknownSocketEvent(decoded, WorkspaceSocketClientEventTypeSchema)) {
      // Ignored, not refused: a refusal is a permanent close. A retired
      // command is named so a pre-pivot desktop still sending one is visible.
      const type = (decoded as { type: string }).type;
      if (RETIRED_WORKSPACE_SOCKET_COMMANDS.has(type)) {
        logInfo(this.env, "workspace_socket_retired_command_ignored", {
          workspace_id: attachment?.workspaceId ?? null, connection_id: attachment?.connectionId ?? null, command: type,
        });
      }
      return;
    }
    const parsed = safeParseSocketEvent(WorkspaceSocketClientEventSchema, decoded);
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
      this.logWorkspaceSocketHandshake(attachment, "subscribe_received", parsed.data.diagnosticAttemptId);
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
      this.logWorkspaceSocketHandshake(attachment, "subscribe_authorized", parsed.data.diagnosticAttemptId);
      await this.subscribe(socket, attachment, parsed.data.afterWaterline, parsed.data.diagnosticAttemptId);
      return;
    }
    if (parsed.data.type === "conversation_view") {
      const request = parsed.data;
      const auth = await this.sessionAuth(attachment);
      if (!auth || !readAttachment(socket)?.subscribed) return;
      const admission = await this.conversationToolAdmission(attachment.workspaceId, request, attachment.userId);
      // Check the current relationship, including private-child and guest grants.
      // Directory visibility alone never admits a breakout.
      const { requestId, parentId, substreamId } = request;
      const answer = admission.authorized
        ? new WorkspaceConversationView(this.state.storage).opening({ requestId, parentId, substreamId })
        : { type: "workspace_conversation_view", requestId, parentId, substreamId, view: null };
      socket.send(JSON.stringify(answer));
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
      if (!currentAttachment.subscribed) {
        this.closeSocket(socket, currentAttachment, {
          code: WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
          reason: "Invalid workspace presence",
          cause: "presence_before_subscribe",
          operation: "presence",
        });
        return;
      }
      // A Canvas the viewer cannot see is recorded as no Canvas at all. The
      // renderer can route to one the list has not shown it yet (a Canvas
      // still being created, a link from elsewhere), and closing here would
      // end the whole Organization socket for good: 4400 is permanent to the
      // client. It is kept as pending so the change that lists it promotes it.
      const requestedWorkstreamId = parsed.data.foregroundWorkstreamId;
      const foregroundWorkstreamId = requestedWorkstreamId !== null
        && this.canvasVisible(viewerOf(currentAttachment), requestedWorkstreamId) === true
        ? requestedWorkstreamId
        : null;
      if (requestedWorkstreamId !== null && foregroundWorkstreamId === null) {
        logInfo(this.env, "workspace_presence_unlisted", {
          workspace_id: currentAttachment.workspaceId,
          user_id: currentAttachment.userId,
          connection_id: currentAttachment.connectionId,
        });
      }
      const presenceChanged = currentAttachment.applicationState !== parsed.data.applicationState
        || currentAttachment.foregroundWorkstreamId !== foregroundWorkstreamId;
      socket.serializeAttachment({
        ...currentAttachment,
        presenceRevision: parsed.data.revision,
        applicationState: parsed.data.applicationState,
        foregroundWorkstreamId,
        pendingForegroundWorkstreamId: parsed.data.applicationState === "foreground"
          && foregroundWorkstreamId === null ? requestedWorkstreamId : null,
      } satisfies WorkspaceSocketAttachment);
      if (presenceChanged) this.broadcastPresence();
      return;
    }
  }

  /** A Sidekick directory row whose stored appearance no longer parses is listed without one. */
  private invalidAppearanceReporter(workspaceId: string): InvalidAppearanceReport {
    return (automationId, code) => logWarn(this.env, "automation_directory_appearance_invalid", {
      workspace_id: workspaceId,
      automation_id: automationId,
      code,
    });
  }

  override webSocketClose(socket: WebSocket): void {
    this.lastSocketEventAt = Date.now();
    if (contributesPresence(readAttachment(socket))) this.broadcastPresence(socket);
  }

  override webSocketError(socket: WebSocket): void {
    this.lastSocketEventAt = Date.now();
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
   * Send each connection only the presence for the Canvas it currently
   * foregrounds. This both avoids leaking a private Canvas's identity and
   * keeps the frame equal to the one face pile the renderer can paint.
   */
  private broadcastPresence(excluding?: WebSocket): void {
    const sockets: Array<{ socket: WebSocket; attachment: WorkspaceSocketAttachment; inMain: boolean }> = [];
    for (const socket of this.state.getWebSockets()) {
      if (socket === excluding) continue;
      let attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      const pending = attachment.pendingForegroundWorkstreamId ?? null;
      if (pending !== null && attachment.applicationState === "foreground"
        && attachment.foregroundWorkstreamId === null
        && this.canvasVisible(viewerOf(attachment), pending) === true) {
        const promoted: WorkspaceSocketAttachment = {
          ...attachment,
          foregroundWorkstreamId: pending,
          pendingForegroundWorkstreamId: null,
        };
        try {
          socket.serializeAttachment(promoted);
          attachment = promoted;
        } catch {
          // Stays as no Canvas; the next focus change sends presence again.
        }
      }
      if (contributesPresence(attachment)
        && this.canvasVisible(viewerOf(attachment), attachment.foregroundWorkstreamId) !== true) {
        try {
          socket.serializeAttachment({
            ...attachment,
            applicationState: "background",
            foregroundWorkstreamId: null,
            pendingForegroundWorkstreamId: null,
          } satisfies WorkspaceSocketAttachment);
        } catch {
          // Fail closed: an attachment that cannot record lost visibility must
          // reconnect before it can contribute or receive presence again.
          disconnect(socket, WORKSPACE_SOCKET_INVALID_MESSAGE_CODE, "Invalid workspace presence");
        }
        continue;
      }
      sockets.push({
        socket,
        attachment,
        inMain: contributesPresence(attachment),
      });
    }
    const presentUsers = new Map<string, Set<string>>();
    for (const { attachment, inMain } of sockets) {
      if (!inMain || attachment.foregroundWorkstreamId === null) continue;
      const users = presentUsers.get(attachment.foregroundWorkstreamId) ?? new Set<string>();
      users.add(attachment.userId);
      presentUsers.set(attachment.foregroundWorkstreamId, users);
    }
    const occurredAt = new Date().toISOString();
    for (const { socket, attachment, inMain } of sockets) {
      if (!inMain || !contributesPresence(attachment)) continue;
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
    // Who is in each Canvas rides the Canvas list's rows; send it when that moved.
    const canvasPresence = JSON.stringify([...this.presentByCanvas()]);
    if (canvasPresence !== this.lastCanvasPresence) {
      this.lastCanvasPresence = canvasPresence;
      this.noteCanvasDirectoryMoved();
      this.publishCanvasList();
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
    // First, because a deferral returns before `runDueAlarmWork`: a region
    // closed for maintenance must not also hold a stuck object open.
    this.resetIfSocketsMissedFirstFrame(now);
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
   * Activity retention and project-default publication are derived from their
   * authoritative rows, and the first-frame watch from the socket attachments.
   * Product work, schedules, watches, maintenance passes, and Terminal
   * deadlines are stored entries with their own retry gates.
   */
  protected override nextDerivedAlarmCandidates(): readonly number[] {
    const lanes = this.derivedAlarmLanes();
    return [
      ...Object.values(lanes).map((dueAt) => dueAt()),
      nextFirstFrameDeadline(this.unheardSockets(), this.socketFirstFrameDeadlineMs, this.heldUnheardSockets),
    ].filter((dueAt): dueAt is number => dueAt !== null);
  }

  /**
   * When each derived lane of this object's alarm next has work, read on call.
   *
   * The one list both sides of the alarm read: `nextDerivedAlarmCandidates`
   * arms from every lane, and `runDueAlarmWork` runs a lane only when its
   * answer is at or before the wake's `now`. Read lazily, just before the lane
   * would run, so rows an earlier lane of the same wake wrote are seen. The
   * first-frame watch is not a lane: `scheduledAlarmDeferral` runs it before these.
   */
  private derivedAlarmLanes() {
    const sql = this.state.storage.sql;
    return {
      // An Organization below migration 72 (held by the meeting-notes cleanup)
      // has no follow-up table, so it has no due time.
      directory_followup: () => this.syncFollowUpTablePresent() ? this.nextSyncFollowUpDueAt() : null,
      authorization_delivery: () =>
        sql.exec<{ due: number | null }>("SELECT MIN(not_before) AS due FROM authorization_delivery").one().due,
      resource_search: () => nextResourceSearchDueAt(sql, this.env, this.resourceSearchPace),
      memory_digest_sync: () => nextMemoryDigestSyncAt(sql),
      connector_event_reap: () => {
        const oldest = sql.exec<{ received_at: number | null }>(
          "SELECT MIN(received_at) AS received_at FROM workspace_connector_events WHERE processing_status = 'processed'",
        ).one().received_at;
        return oldest === null ? null : Number(oldest) + CONNECTOR_EVENT_BODY_RETENTION_MS;
      },
    } satisfies Record<string, () => number | null>;
  }

  /**
   * What the first-frame watch reads about each socket whose attachment still
   * parses; a broken one has nothing to watch.
   */
  private watchedSockets(): Array<WorkspaceSocketAttachment & { lastAutoResponseAt: number | null }> {
    return this.state.getWebSockets().flatMap((socket) => {
      const attachment = readAttachment(socket);
      return attachment
        ? [{ ...attachment, lastAutoResponseAt: this.state.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? null }]
        : [];
    });
  }

  private detectUnheardLedger(): void {
    this.unheardLedger = this.state.storage.sql.exec(
      `SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workspace_socket_unheard'`,
    ).toArray().length > 0;
    this.versionLedger = resourceVersionLedgerReady(this.state.storage.sql);
  }

  /** Every socket accepted and not yet heard from, open or already gone. */
  private unheardSockets(): UnheardSocket[] {
    if (!this.unheardLedger) return [];
    return this.state.storage.sql.exec<{ connection_id: string; accepted_at: number }>(
      `SELECT connection_id, accepted_at FROM workspace_socket_unheard`,
    ).toArray().map((row) => ({ connectionId: row.connection_id, acceptedAt: row.accepted_at }));
  }

  /**
   * Reset this instance when it has stopped receiving socket events: enough
   * sockets have gone unheard past the first-frame deadline, and no socket at
   * all has been heard from since each was accepted. A socket may already be
   * gone; docs/realtime-sockets.md, "An instance that stops hearing its
   * sockets". Below `missedSocketsBeforeReset`, the missed ones are held.
   *
   * Runs from the alarm, the one path such an object still runs. The abort
   * drops every socket (`1006`) and clients reconnect; no close is sent first,
   * because the output gate breaks before a close frame could leave.
   */
  private resetIfSocketsMissedFirstFrame(now: number): void {
    const open = this.watchedSockets();
    const { missed, settled } = judgeUnheardSockets(
      this.unheardSockets(),
      open,
      now,
      this.socketFirstFrameDeadlineMs,
      this.lastSocketEventAt,
      now - this.instanceAgeMs(),
    );
    for (const socket of settled) {
      this.state.storage.sql.exec(`DELETE FROM workspace_socket_unheard WHERE connection_id = ?`, socket.connectionId);
    }
    const missedIds = new Set(missed.map((socket) => socket.connectionId));
    for (const id of this.heldUnheardSockets) {
      if (!missedIds.has(id)) this.heldUnheardSockets.delete(id);
    }
    if (missed.length === 0) return;
    const openIds = new Set(open.map((socket) => socket.connectionId));
    const fields = {
      workspace_id: this.workspaceId(),
      missed_sockets: missed.length,
      missed_closed_sockets: missed.filter((socket) => !openIds.has(socket.connectionId)).length,
      open_sockets: open.length,
      oldest_silent_ms: now - Math.min(...missed.map((socket) => socket.acceptedAt)),
      last_socket_event_ms: this.lastSocketEventAt === null ? null : now - this.lastSocketEventAt,
      instance_age_ms: this.instanceAgeMs(),
    };
    if (missed.length < this.missedSocketsBeforeReset) {
      // One silent socket is usually a client that went away mid-handshake.
      // Its row stays, so a second silent socket counts with it.
      const newlyHeld = missed.filter((socket) => !this.heldUnheardSockets.has(socket.connectionId));
      for (const socket of newlyHeld) this.heldUnheardSockets.add(socket.connectionId);
      if (newlyHeld.length > 0) {
        logWarn(this.env, "workspace_socket_first_frame_held", {
          ...fields,
          reset_at_missed_sockets: this.missedSocketsBeforeReset,
        });
      }
      return;
    }
    logError(this.env, "workspace_socket_first_frame_missed", fields);
    // Rows are left in place: the fresh instance settles them as older than itself.
    this.state.abort("workspace_socket_first_frame_missed");
  }

  /**
   * Everything this object's alarm does that no stored entry owns.
   *
   * Each derived lane runs only when its own due time, read from
   * `derivedAlarmLanes` just before it would run, is at or before `now`: the
   * object wakes for one lane, and the others' reads stay a single indexed
   * `MIN` rather than their full pass. Expired activity events and processed
   * connector bodies are lanes like any other — their due time is the oldest
   * row plus retention. The schedule reconcile has no due time and runs on
   * every wake, for the reason at the call.
   */
  protected override async runDueAlarmWork(now: number): Promise<void> {
    const workspaceId = this.workspaceId();
    // A phase that throws is logged and the rest still run; the first throw is
    // rethrown at the end, so the alarm fails and retries as it did before
    // rather than re-arming at once for rows the failed phase left due.
    const failures: unknown[] = [];
    const isolated = async (phase: WorkspaceScheduledAlarmPhase, run: () => Promise<void>) => {
      try {
        await this.instrumentWorkspaceAlarmPhase(phase, undefined, run);
      } catch (error) {
        failures.push(error);
        logWarn(this.env, "workspace_alarm_phase_failed", {
          workspace_id: workspaceId, phase, code: diagnosticErrorCode(error, `${phase}_failed`),
        });
      }
    };
    const lanes = this.derivedAlarmLanes();
    const due = (lane: keyof typeof lanes) => {
      const dueAt = lanes[lane]();
      return dueAt !== null && dueAt <= now;
    };
    if (workspaceId) {
      if (due("directory_followup")) {
        await isolated("directory_followup", () => this.runSyncFollowUps(this.dueSyncFollowUps(now)));
      }
      // The old search-authorization store is no longer pushed: search filters on
      // row audience (phase 3 of docs/PRDs/2026-09-26_search-audience-filtering).
      // Its triggers still record targets, one row each, which a rollback flushes.
      if (due("authorization_delivery")) {
        try { await flushAuthorizationDeliveries(this.state.storage.sql, this.env.ACTIVITY_QUEUE, now); }
        catch { logWarn(this.env, 'authorization_backfill_dispatch_deferred', { region: this.env.AVALON_REGION }); }
      }
      if (due("resource_search")) {
        try { await publishResourceSearch(this.state.storage.sql, this.env, workspaceId, this.resourceSearchPace); }
        catch { logWarn(this.env, "resource_search_dispatch_deferred", { workspace_id: workspaceId }); }
      }
      // Conversations whose memory digest copies may show a withdrawn fact; see memory-digest-sync.ts.
      if (due("memory_digest_sync")) await this.instrumentWorkspaceAlarmPhase("memory_digest_sync", undefined, async () => {
        try {
          await publishMemoryDigestSync({
            sql: this.state.storage.sql,
            queue: this.env.ACTIVITY_QUEUE,
            workspaceId,
            region: this.env.AVALON_REGION,
            now,
            retryAt: (attempt) => now + scheduledAlarmRetryDelay(attempt),
          });
        } catch (error) {
          logWarn(this.env, "memory_digest_sync_publication_failed", {
            workspace_id: workspaceId,
            reason: diagnosticErrorCode(error, "memory_digest_sync_publication_failed"),
          });
        }
      });
    }
    if (due("connector_event_reap")) {
      await isolated("connector_event_reap", async () => {
        this.reapExpiredConnectorEvents(now);
      });
    }
    // Re-derive the whole index before this alarm ends, exactly as the object
    // that used to own it did. A target that just fired has advanced its own
    // canonical row — `runSchedule` writes the next `next_run_at`,
    // `runResourceWatch` the next `next_poll_at`, a bounded maintenance pass
    // can leave rows behind — and it writes them through the local executor,
    // which does not pass the auto-refresh in `executeRuntimeSql`. Without
    // this, the drain settles the one-shot entry it just ran and nothing arms
    // the occurrence that replaced it: a recurring automation fires once and
    // then never again until an unrelated mutation happens to reconcile. It
    // is the one phase with no due time: what it repairs is a stored entry the
    // drain just settled, which no table here dates.
    if (workspaceId) {
      await isolated("schedule_reconcile", async () => {
        await this.refreshSchedule(workspaceId);
      });
    }
    if (failures.length > 0) throw failures[0];
  }

  protected override async runScheduledAlarm(alarm: ScheduledAlarm): Promise<ScheduledAlarmOutcome> {
    return this.instrumentWorkspaceAlarmPhase(
      "stored_target",
      observableWorkspaceScheduledAlarmKind(alarm.kind),
      async () => {
        const workspaceId = this.workspaceId();
        if (!workspaceId) return;
        const sidekickTarget = hostedSidekickAlarmTarget(alarm);
        if (sidekickTarget) {
          const sidekick = await this.sidekickParent(sidekickTarget.sidekickId);
          // A Sidekick deleted from the directory has nothing left to run.
          if (!sidekick) return;
          try {
            return await sidekick.runAlarm(alarm, sidekickTarget.key);
          } finally {
            this.publishSidekickList();
          }
        }
        // Suggested work's scheduler, the Personal Channel backfill and the
        // Thread and Channel parents' own alarms are gone (plan step C-2); an
        // entry an object armed before that deploy has nothing left to do.
        if (RETIRED_ALARM_KINDS.has(alarm.kind)) return;
        // A Canvas's share deliveries and lookup rows. One a retired Thread or
        // Channel armed has no parent left to deliver for.
        if (alarm.kind === SCOPE_INVITATION_INDEX_ALARM) {
          await (await this.canvasParent(alarm.key))?.indexPendingInvitations();
          return;
        }
        if (alarm.kind === SCOPE_INVITATION_DELIVERY_ALARM) {
          const [parentId, invitationId] = alarm.key.split(":");
          if (!parentId || !invitationId) throw new Error("parent_invitation_delivery_key_invalid");
          await (await this.canvasParent(parentId))?.deliverInvitation(invitationId);
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

  protected override onIdleAlarmHeld(attempt: number, heldUntil: number): void {
    reportScheduledAlarmAttempt(this.env, (promise) => this.state.waitUntil(promise), {
      event: "workspace_alarm_idle_held",
      summary: "A workspace alarm keeps asking to run again at once while its passes change nothing: one of its derived lanes reports work at now that the pass then declines. Find which.",
      attempt,
      fields: {
        workspace_id: this.workspaceId(),
        held_until: new Date(heldUntil).toISOString(),
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
    return this.refreshScheduleKinds(workspaceId, WORKSPACE_SCHEDULE_ALARM_KINDS);
  }

  /** Re-derive affected kinds without deleting another source's alarms or retry gates. */
  private async refreshScheduleKinds(
    workspaceId: string,
    kinds: readonly WorkspaceScheduleTargetKind[],
  ): Promise<{ alarmAt: string | null }> {
    await this.initialized;
    const parsed = WorkspaceIdSchema.parse(workspaceId);
    // No identity means no workspace rows: every write to this object asserts
    // its identity first, so there is nothing here that could be due.
    if (this.workspaceId() === null) return { alarmAt: null };
    this.assertWorkspace(parsed);
    const targets = await workspaceScheduleTargets(this.scheduleContext(parsed), kinds);
    const grouped = new Map<WorkspaceScheduleTargetKind, { key: string; dueAt: number }[]>(
      kinds.map((kind) => [kind, []]),
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
      // The directory row carries one deadline per parent; which
      // conversation it belongs to is the hosted parent's knowledge, read
      // from its rows in this object. A retired Thread has none.
      dueTerminalSubstreams: async (workstreamId, through) => {
        const parent = await this.hostedConversationParent(workstreamId, workspaceId);
        if (!parent) return [];
        const { items } = parent.childTerminalDeadlines({
          workspaceId: asWorkspaceId(workspaceId),
          parentId: workstreamId,
        });
        return items
          .filter((item) => Date.parse(item.nextTerminalActionAt) <= through.getTime())
          .map((item) => item.substreamId);
      },
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

  /** Per-person learning progress stays inside the workspace authority. */
  async onboardingJourney(input: { workspaceId: string; placementAffinity: WorkspacePlacementAffinity; userId: string; path: 'creator' | 'member'; update?: UpdateOnboardingJourney }): Promise<OnboardingJourney | null> {
    await this.initialized;
    this.ensureIdentity(input.workspaceId, input.placementAffinity);
    z.string().uuid().parse(input.userId);
    const path = z.enum(['creator', 'member']).parse(input.path);
    return this.state.storage.transactionSync(() => {
      const store = new OnboardingJourneyStore(this.state.storage.sql);
      return input.update ? store.update(input.userId, path, UpdateOnboardingJourneySchema.parse(input.update)) : store.get(input.userId, path);
    });
  }

  /**
   * Record and fan out a workspace-owned surface change. This RPC is called by
   * authenticated HTTP mutations and regional background consumers only; the
   * socket itself never lets a desktop manufacture an invalidation.
   *
   * An event is for the whole Organization unless it names an audience: the
   * people whose own settings moved (`audienceUserIds`), or the connection a
   * write changed (`connectionId`), whose audience is its owner when it is
   * personal and everyone when it is the Organization's. The connection's
   * scope is read here because the connection is this object's row, so
   * whoever publishes does not have to read it first. An audience-scoped
   * event goes only to its audience's sockets, now and on replay.
   */
  async publishSync(
    topics: WorkspaceSyncTopic[],
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
    detail?: {
      /** Members whose search decisions the change created or removed; each gets its own projection push. */
      memberUserIds?: string[];
      /** The only people the change is news to. */
      audienceUserIds?: string[];
      /** The connection the change was to; its audience decides who is told. */
      connectionId?: string;
    },
  ): Promise<number> {
    await this.initialized;
    this.ensureIdentity(workspaceId, placementAffinity);
    const parsed = z.array(WorkspaceSyncTopicSchema).min(1).safeParse(topics);
    if (!parsed.success) throw new Error("invalid_workspace_sync_topics");
    const audience = this.syncAudience(detail);
    const requested = new Set(parsed.data);
    const ordered = WORKSPACE_SYNC_TOPICS.filter((topic) => requested.has(topic));
    const occurredAtMs = Date.now();
    const occurredAt = new Date(occurredAtMs).toISOString();
    const eventId = uuidV7(occurredAtMs);
    const waterline = this.state.storage.transactionSync(() => {
      if (requested.has('member_directory')) this.state.storage.sql.exec(`INSERT INTO search_authorization_push
        SELECT CASE WHEN resource_id IS NULL THEN 'parent' ELSE 'resource' END,
          COALESCE(resource_id, parent_id), 1, 0, ?, 'workspace_mutation'
        FROM search_authorization_keys WHERE resource_id IS NOT NULL OR parent_id IS NOT NULL
        GROUP BY 1, 2
        ON CONFLICT(kind, target_id) DO UPDATE SET revision = revision + 1,
          first_mutated_at = COALESCE(first_mutated_at, excluded.first_mutated_at)`, occurredAtMs);
      for (const userId of new Set(z.array(UserIdSchema).optional().parse(detail?.memberUserIds) ?? [])) {
        this.state.storage.sql.exec(`INSERT INTO search_authorization_push VALUES ('member', ?, 1, 0, ?, 'workspace_mutation')
          ON CONFLICT(kind, target_id) DO UPDATE SET revision = revision + 1,
            first_mutated_at = COALESCE(first_mutated_at, excluded.first_mutated_at)`, userId, occurredAtMs);
      }
      const row = this.state.storage.sql.exec<{ waterline: number }>(
        `INSERT INTO workspace_sync_events(event_id, topics_json, audience_json, occurred_at)
         VALUES (?, ?, ?, ?) RETURNING waterline`,
        eventId,
        JSON.stringify(ordered),
        audience === null ? null : JSON.stringify([...audience]),
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
      if (audience !== null && !audience.has(attachment.userId)) continue;
      try {
        socket.send(payload);
        socket.serializeAttachment({ ...attachment, lastWaterline: waterline });
      } catch {
        // The hibernation runtime owns close cleanup. A reconnect receives a
        // full invalidation or replays the bounded SQL log.
      }
    }
    if (requested.has('member_directory')) await this.armNextAlarm();
    return waterline;
  }

  /** Who a sync event is for: `null` for the whole Organization. */
  private syncAudience(detail: { audienceUserIds?: string[]; connectionId?: string } | undefined): Set<string> | null {
    // Parsed here, not thrown raw: a `ZodError` reaches the RPC caller as a
    // bare `Error` with nothing in it (`docs/naming-a-schema-failure.md`).
    const parsed = SyncAudienceSchema.safeParse(detail ?? {});
    if (!parsed.success) {
      throw new Error(zodDiagnosticCode(parsed.error, "workspace_sync_audience") ?? "workspace_sync_audience_invalid");
    }
    const { audienceUserIds, connectionId } = parsed.data;
    if (connectionId !== undefined) {
      const connection = this.state.storage.sql.exec<{ scope: string; owner_user_id: string | null }>(
        `SELECT scope, owner_user_id FROM connector_connections WHERE id = ?`,
        connectionId,
      ).toArray()[0];
      // A connection this object does not hold is told to everyone, as every
      // connection change was before audiences existed: an invalidation names
      // topics, never the connection.
      return connection?.scope === "personal" && connection.owner_user_id !== null
        ? new Set([connection.owner_user_id]) : null;
    }
    return audienceUserIds === undefined ? null : new Set(audienceUserIds);
  }

  /**
   * Send the Organization's meter, as it reads after a plan change, to every
   * subscribed member socket. The meter is the same for every member, so the
   * caller reads it once and this object only fans it out. Not on the
   * waterline: a socket that was away rereads the meter when it subscribes
   * again.
   *
   * `readAt` is when the caller started reading the meter. Two quick changes
   * each publish, and the first can arrive last; a meter read before the last
   * one sent is dropped, so a late push cannot put back the earlier plan. The
   * mark lives in memory: after an eviction the next push is sent whatever
   * its time, which is right, because nothing older is still in flight for
   * long.
   */
  async publishUsage(
    usage: OrganizationUsage,
    readAt: string,
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
  ): Promise<number> {
    await this.initialized;
    this.ensureIdentity(workspaceId, placementAffinity);
    const readAtMs = Date.parse(readAt);
    if (this.lastUsageReadAtMs !== null && readAtMs < this.lastUsageReadAtMs) return 0;
    this.lastUsageReadAtMs = readAtMs;
    // The meter is our own reader's, one hop away; the desktop parses it.
    const payload = JSON.stringify({ type: "workspace_usage", occurredAt: readAt, usage } satisfies WorkspaceUsageEvent);
    let sent = 0;
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      // A guest is not a member: `GET /workspace/usage` refuses them, so the
      // plan and overage are not theirs to be sent either.
      if (!attachment?.subscribed || viewerOf(attachment).accessClass === "guest") continue;
      try {
        socket.send(payload);
        sent += 1;
      } catch {
        // Hibernation owns cleanup; a reconnect rereads the meter.
      }
    }
    return sent;
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

  async revokeSocketAccess(revocation: SocketAccessRevocation): Promise<{
    /**
     * Parents whose conversations the consumer reaches with a `workstream`
     * hop. Empty: that hop served Threads, which are retired. Kept so a
     * consumer from before this change still reads a list.
     */
    workstreamIds: string[];
    /** Every Canvas, with the conversations each names; each gets a `substream` hop. */
    channels: { workstreamId: string; substreamIds: string[] }[];
    automationIds: string[];
    artifactIds: string[];
  }> {
    await this.initialized;
    const request = SocketAccessRevocationSchema.parse(revocation);
    let closed = 0;
    let presenceChanged = false;
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      // A revoked session closes only the windows that presented it; an ended
      // membership closes only sessions bound to that incarnation. The rule lives in
      // one place because the four socket roles disagree about their own
      // attachments — see `revocationClosesSession`.
      if (!attachment || !(await revocationClosesSession(this.env, request, attachment))) continue;
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
    return {
      workstreamIds: [],
      // Every Canvas, unfiltered by person, for the reason automations are
      // below: who may read one moves with its audience, and a hop that finds
      // no socket to drop costs one call.
      channels: this.state.storage.sql.exec<{ canvas_id: string }>(
        `SELECT canvas_id FROM canvas_directory ORDER BY canvas_id`,
      ).toArray().map((row) => ({
        workstreamId: row.canvas_id,
        substreamIds: new HostedCanvas(this.hostedCanvasHost(), row.canvas_id).childRegistry()
          .map((child) => child.substreamId),
      })),
      // Every automation, unfiltered by person, for the same reason the
      // artifact list is: an automation's conversation admits its author and
      // its run-as principal, any member when it is workspace-scoped, and any
      // participant of the room that owns it, so this object cannot tell which
      // automations a given person holds a socket on. It once narrowed to the
      // author, and a member's sockets on every other readable automation
      // outlived their membership. A hop that finds nothing to drop costs one
      // call.
      automationIds: this.state.storage.sql.exec<{ automation_id: string }>(
        `SELECT automation_id FROM automation_directory
          WHERE lifecycle <> 'deleted' ORDER BY automation_id`,
      ).toArray().map((row) => row.automation_id),
      // Artifacts hang off the workspace for the same reason automations do:
      // `artifact_registry` lives here, beside the resource authority, and
      // `docs/access-revocation.md`'s rule is that only the object holding a
      // list can name its children. No work stream can name its artifacts —
      // that table is not in its database — so putting the hop there would
      // have meant a second copy of a fact this object already owns.
      //
      // The list is unfiltered by person, deliberately, and matches the
      // generosity the rest of this walk is built on: an artifact is readable
      // by anyone who can see its work stream, so this object cannot tell
      // which artifacts a given person holds a session on without asking every
      // work stream a question it would then have to cache. A hop that finds
      // no session to drop costs one call.
      artifactIds: this.state.storage.sql.exec<{ artifact_id: string }>(
        `SELECT artifact_id FROM artifact_registry ORDER BY artifact_id`,
      ).toArray().map((row) => row.artifact_id),
    };
  }

  /** Pin the workspace identity before any child object can be resolved. */
  async initializeWorkspace(workspaceId: string, placementAffinity: WorkspacePlacementAffinity): Promise<void> {
    await this.initialized;
    this.ensureIdentity(workspaceId, placementAffinity);
  }

  // ---------------------------------------------------------------------------
  // The conversation tools' scope: `rally:conversations` asks here, in one call
  // per tool call, which conversations a loop may reach and whether its acting
  // person can open the one it named. See docs/conversation-tools.md.
  // ---------------------------------------------------------------------------

  /**
   * The conversations in a scope this person can open now, archived ones
   * omitted. Re-admits on every call from the directories, so a person who
   * lost a Channel stops seeing it on the next list.
   */
  async conversationToolScope(input: unknown): Promise<ConversationToolScopeResult> {
    await this.initialized;
    const request = parseRpcInput(ConversationToolScopeRequestSchema, input, "conversation_tool_scope");
    this.assertWorkspace(request.workspaceId);
    const scoped = scopeConversations(this.state.storage.sql, request.scope);
    const conversations = await this.reachableConversations(request.workspaceId, scoped, request.userId);
    return { conversations: conversations.map(conversationToolEntry) };
  }

  /**
   * The conversations of a scope this person can read, each admitted as its
   * own transport admits it (`conversationToolAdmission`): a Canvas by
   * `canvasAdmits`, a Sidekick by `sidekickAdmits`.
   */
  private async reachableConversations<T extends { parentId: string; substreamId: string }>(
    workspaceId: string,
    scoped: readonly T[],
    userId: string,
  ): Promise<T[]> {
    const relationship = await this.readRelationship(workspaceId, userId);
    if (relationship?.status !== "active") return [];
    const reachable: T[] = [];
    for (const conversation of scoped) {
      const admission = await this.conversationToolAdmission(workspaceId, conversation, userId, relationship);
      if (admission.authorized && !admission.archived) reachable.push(conversation);
    }
    return reachable;
  }

  /**
   * One person's admission to one conversation, as its transport decides it:
   * an active relationship, then the hosted parent's `authorizeViewer`, which
   * for a guest consults only their grants (`ConversationService` does the
   * same through the role it reads from the session).
   */
  private async conversationToolAdmission(
    workspaceId: string,
    address: { parentId: string; substreamId: string },
    userId: string,
    /** The person's relationship when the caller already read it. */
    known?: WorkspaceRelationship | null,
  ): Promise<{ authorized: boolean; archived: boolean }> {
    const relationship = known ?? await this.readRelationship(workspaceId, userId);
    if (relationship?.status !== "active") return { authorized: false, archived: false };
    return this.authorizeViewer({
      workspaceId: asWorkspaceId(workspaceId),
      parentId: address.parentId,
      substreamId: asSubstreamId(address.substreamId),
      userId: asUserId(userId),
      ...(relationship.accessClass === "guest" ? { requireGrantAuthority: true } : {}),
    });
  }

  /**
   * One conversation a read or a post named, checked against the scope and
   * then admitted through the hosted parent's `authorizeViewer`, which is what
   * the conversation's own transport asks. The directory rows decide the
   * scope; the parent decides the person.
   */
  async resolveConversationToolTarget(input: unknown): Promise<ConversationToolResolveResult> {
    await this.initialized;
    const request = parseRpcInput(ConversationToolResolveRequestSchema, input, "conversation_tool_resolve");
    this.assertWorkspace(request.workspaceId);
    const scoped = scopeConversations(this.state.storage.sql, request.scope);
    // Only a refusal lists what the person can reach, so only a refusal pays for it.
    const available = async () => (await this.reachableConversations(request.workspaceId, scoped, request.userId))
      .map((conversation) => conversation.conversationId);
    let match = matchConversationReference<ScopedConversation>(scoped, request.reference);
    if (match.outcome === "ambiguous") {
      // Only name ids this person can actually open when disambiguating a title.
      const reachable = await this.reachableConversations(request.workspaceId, scoped, request.userId);
      match = matchConversationReference<ScopedConversation>(reachable, request.reference);
    }
    if (match.outcome === "missing") return conversationToolRefusal("conversation_not_in_scope", await available());
    if (match.outcome === "ambiguous") {
      return conversationToolRefusal("conversation_ambiguous", match.matches.map((conversation) => conversation.conversationId));
    }
    const target = match.conversation;
    const admission = await this.conversationToolAdmission(request.workspaceId, target, request.userId);
    if (!admission.authorized) return conversationToolRefusal("conversation_access_denied", [], target.parentId);
    if (admission.archived) return conversationToolRefusal("conversation_archived", [], target.parentId);
    const sidekickName = this.state.storage.sql.exec<{ title: string }>(
      `SELECT title FROM automation_directory WHERE automation_id = ?`, request.scope.automationId,
    ).toArray()[0]?.title || "New Sidekick";
    return { ok: true, conversation: conversationToolEntry(target), sidekickName };
  }

  /**
   * Attach a conversation to a Sidekick, from its configuration conversation.
   *
   * Attaching is the consent to publish there: whatever a run posts is read by
   * that conversation's audience. So the person attaching must be able to post
   * in it now, which is the parent's admission plus the conversation not being
   * archived, the rule `ConversationService.writableClient` applies to a write.
   */
  async attachSidekickConversation(input: unknown): Promise<ConversationToolAttachResult> {
    await this.initialized;
    const request = parseRpcInput(ConversationToolAttachRequestSchema, input, "conversation_tool_attach");
    this.assertWorkspace(request.workspaceId);
    const sql = this.state.storage.sql;
    // A Canvas named by id or link, or else by the title the person used,
    // among the Canvases they can open: a title never reveals one they cannot.
    const id = parseConversationId(request.reference);
    let target: ScopedConversation;
    if (id) {
      const title = canvasTitle(sql, id.parentId);
      if (title === null) return conversationToolRefusal("conversation_not_found", []);
      target = { parentKind: "canvas", parentId: id.parentId, substreamId: "0", conversationId: id.parentId,
        kind: "canvas", title, isOwn: false, isParent: false };
    } else {
      const titled = await this.reachableConversations(request.workspaceId, canvasesTitled(sql, request.reference), request.userId);
      if (titled.length === 0) return conversationToolRefusal("conversation_not_found", []);
      if (titled.length > 1) {
        return conversationToolRefusal("conversation_ambiguous", titled.map((conversation) => conversation.conversationId));
      }
      target = titled[0]!;
    }
    const admission = await this.conversationToolAdmission(request.workspaceId, target, request.userId);
    if (!admission.authorized) return conversationToolRefusal("conversation_access_denied", [], target.parentId);
    if (admission.archived) return conversationToolRefusal("conversation_archived", [], target.parentId);
    const attached = this.state.storage.transactionSync(() => {
      if (sql.exec(`SELECT 1 FROM automation_directory WHERE automation_id = ? AND lifecycle <> 'deleted'`,
        request.automationId).toArray().length === 0) return null;
      const result = attachSidekickConversation(sql, {
        automationId: request.automationId, address: { parentKind: "canvas", parentId: target.parentId, substreamId: "0" },
        userId: request.userId, now: Date.now(),
      });
      this.pendingSyncFollowUps.push(this.recordSyncFollowUp({
        workspaceId: request.workspaceId, syncTopics: ["automations"],
      }));
      return result;
    });
    if (!attached) throw new ApiError(404, "sidekick_not_found", "This Sidekick does not exist");
    // A notification failure must not turn a committed attachment into a
    // failed tool call. The normal post-commit lane retries the signal.
    await this.afterHostedWrite();
    return { ok: true, alreadyAttached: attached.alreadyAttached, conversation: conversationToolEntry(target) };
  }

  /**
   * The automations in a person's left sidebar, drafts included.
   *
   * A draft is a conversation in progress, and its row is how the person gets
   * back to it. A room's automation is listed in that room's rail and nowhere
   * else: in a personal list it would be an object somebody sees without the
   * context that explains it.
   */
  async listAutomationDirectory(input: unknown): Promise<{ items: AutomationSummary[] }> {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, userId: UserIdSchema }).parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      throw new ApiError(403, "sidekick_directory_access_denied", "You cannot list this workspace's Sidekicks");
    }
    return { items: this.listSidebarAutomations(request.workspaceId, request.userId, 250) };
  }

  /** Internal candidates only; every result must pass the Sidekick owner's read gate. */
  async sidekickSkillCandidates(input: unknown): Promise<string[]> {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.loadableSidekickIds(request.workspaceId);
  }

  private loadableSidekickIds(workspaceId: string): string[] {
    return this.state.storage.sql.exec<{ automation_id: string }>(
      `SELECT automation_id FROM automation_directory WHERE workspace_id = ? AND lifecycle = 'active' AND loadable = 1 ORDER BY automation_id`,
      workspaceId,
    ).toArray().map((row) => row.automation_id);
  }

  /**
   * For a caller that already proved active membership: Bind for its command,
   * and `AutomationService.listSidekicks` for an authenticated request. Scope
   * filtering remains local.
   */
  async listSidekickDirectoryForAuthorizedMember(input: {
    workspaceId: string;
    userId: string;
    /** What the caller's authentication already read; the object reads it only when absent. */
    accessClass?: "member" | "guest";
    role?: "owner" | "admin" | "member" | null;
  }): Promise<{ items: AutomationSummary[] }> {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema, userId: UserIdSchema,
      accessClass: z.enum(["member", "guest"]).optional(),
      role: z.enum(["owner", "admin", "member"]).nullable().optional(),
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    const candidates = this.state.storage.sql.exec<AutomationDirectoryRow & {
      author_user_id: string; run_as_user_id: string | null; owning_substream_id: string; workspace_id: string; last_run_at: number | null;
      shared_count: number; shared: number;
    }>(
      `SELECT directory.*, ${AUTOMATION_AUDIENCE_SQL},
              EXISTS (SELECT 1 FROM sidekick_audience audience
                       WHERE audience.sidekick_id = directory.automation_id AND audience.user_id = ?2) AS shared,
              (SELECT MAX(created_at) FROM sidekick_runs WHERE sidekick_id = directory.automation_id) AS last_run_at
         FROM automation_directory directory WHERE workspace_id = ?1 AND lifecycle <> 'deleted'
        ORDER BY title COLLATE NOCASE, automation_id`, request.workspaceId, request.userId,
    ).toArray();
    // The management read rule (`sidekickReaderAllows`), the same one the
    // detail screen applies: a guest is not listed Organization-scope
    // Sidekicks, and a personal one is listed to its author, the person it
    // runs as and the people it is shared with.
    // The role decides Organization-scope rows only, so it is read at most
    // once and only when such a row is not already the person's own.
    let actorRole: "owner" | "admin" | "member" | null | undefined = request.accessClass === undefined
      ? undefined
      : request.accessClass === "guest" ? null : request.role ?? null;
    const admitted: typeof candidates = [];
    for (const row of candidates) {
      const own = row.author_user_id === request.userId || row.run_as_user_id === request.userId;
      if (actorRole === undefined && row.scope === "workspace" && !own) {
        const relationship = await this.readRelationship(request.workspaceId, request.userId);
        actorRole = relationship?.accessClass === "guest" ? null : relationship?.role ?? null;
      }
      // `sidekickReaderAllows`' rule, with the list membership read above.
      if (sidekickAdmits({ scope: row.scope, author: row.author_user_id === request.userId,
        executor: row.run_as_user_id === request.userId, shared: row.shared === 1 }, (actorRole ?? null) !== null)) {
        admitted.push(row);
      }
    }
    const report = this.invalidAppearanceReporter(request.workspaceId);
    return { items: admitted.map((row) => automationSummary(row, report)) };
  }

  /**
   * Replace one destination's evaluators, completely.
   *
   * No coordinate and no hash: the caller is the destination's own authority
   * and this is whatever it says now. A repeat with the same set removes and
   * re-inserts the same rows, which is equivalent, and the cutoff sequence
   * means an event admitted before the call is never matched by a rule that
   * did not exist when it arrived.
   */
  async applyExternalEventRegistrations(input: unknown): Promise<{
    effectiveAfterEventSequence: number;
  }> {
    await this.initialized;
    const request = parseRpcInput(
      ExternalEventRegistrationProjectionV1Schema,
      input,
      "external_event_registration_projection",
    );
    this.assertWorkspace(request.workspaceId);
    const result = this.state.storage.transactionSync(() => {
      const destinationKind = request.destination.kind;
      const destinationKey = destinationKind === "automation"
        ? `automation:${request.destination.automationId}`
        : `workstream:${request.destination.workstreamId}:${request.destination.substreamId}:${request.destination.resourceId}`;
      const previous = this.state.storage.sql.exec<{ source_generation: number; effective_after_event_sequence: number }>(
        `SELECT source_generation, effective_after_event_sequence FROM external_registration_generations WHERE destination_key = ?`, destinationKey,
      ).toArray()[0];
      if (previous && (request.sourceGeneration === undefined || request.sourceGeneration <= previous.source_generation)) {
        return { effectiveAfterEventSequence: previous.effective_after_event_sequence, applied: false };
      }
      const replaced = this.replaceExternalEventRegistrationRows(request, destinationKey, Date.now());
      if (request.sourceGeneration !== undefined) this.state.storage.sql.exec(
        `INSERT INTO external_registration_generations VALUES (?, ?, ?)
         ON CONFLICT(destination_key) DO UPDATE SET source_generation = excluded.source_generation, effective_after_event_sequence = excluded.effective_after_event_sequence`,
        destinationKey, request.sourceGeneration, replaced.effectiveAfterEventSequence,
      );
      return replaced;
    });
    await this.refreshScheduleKinds(request.workspaceId, ["schedule"]);
    // A stale projection changed nothing, so it has nothing to join.
    if (result.applied && request.destination.kind === "automation") {
      await this.joinSlackSourceConversations(
        request.workspaceId,
        request.destination.automationId,
        request.sourceGeneration,
        request.evaluators,
      );
    }
    return { effectiveAfterEventSequence: result.effectiveAfterEventSequence };
  }

  /**
   * Replace one destination's registration rows, inside the caller's
   * transaction, and return the event sequence they take effect after: an
   * event admitted before the call is never matched by a rule that did not
   * exist when it arrived. The legacy RPC and a hosted Sidekick's own
   * transaction both write through here.
   */
  private replaceExternalEventRegistrationRows(
    request: z.infer<typeof ExternalEventRegistrationProjectionV1Schema>,
    destinationKey: string,
    now: number,
    preserveActive = false,
  ): { effectiveAfterEventSequence: number; applied: true } {
    const destinationKind = request.destination.kind;
    const cutoff = this.latestConnectorEventSequence();
    this.state.storage.sql.exec(
      `UPDATE workspace_external_event_registrations
          SET state = 'removed', updated_at = ?
        WHERE destination_kind = ? AND destination_key = ?
          AND state = 'active' AND (? = 0 OR registration_id NOT IN (SELECT value FROM json_each(?)))`,
      now,
      destinationKind,
      destinationKey,
      preserveActive ? 1 : 0,
      JSON.stringify(request.evaluators.map((evaluator) => evaluator.evaluatorId)),
    );
    this.state.storage.sql.exec(
      `UPDATE schedules SET enabled = 0, updated_at = ? WHERE id IN (
        SELECT registration_id FROM workspace_external_event_registrations
        WHERE destination_key = ? AND connector_type = 'canva' AND (? = 0 OR state='removed'))`,
      new Date(now).toISOString(), destinationKey, preserveActive ? 1 : 0,
    );
    const changed = [];
    for (const evaluator of request.evaluators) {
      if (preserveActive && this.state.storage.sql.exec(
        `SELECT 1 FROM workspace_external_event_registrations WHERE registration_id=? AND destination_key=?
          AND state='active' AND evaluator_json=?`, evaluator.evaluatorId, destinationKey, JSON.stringify(evaluator),
      ).toArray().length > 0) continue;
      changed.push(evaluator);
      this.state.storage.sql.exec(
        `INSERT INTO workspace_external_event_registrations
           (registration_id, destination_key, workspace_id, effective_after_event_sequence,
            connection_id, connector_type, event_type, resource_id, evaluator_json,
            destination_kind, automation_id, workstream_id, substream_id,
            destination_resource_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
         ON CONFLICT(registration_id) DO UPDATE SET state = 'active', effective_after_event_sequence = excluded.effective_after_event_sequence,
           connection_id = excluded.connection_id, connector_type = excluded.connector_type,
           event_type = excluded.event_type, resource_id = excluded.resource_id, evaluator_json = excluded.evaluator_json,
           updated_at = excluded.updated_at`,
        request.sourceGeneration === undefined && evaluator.source.connectorType !== "canva" ? uuidV7() : evaluator.evaluatorId,
        destinationKey,
        request.workspaceId,
        cutoff,
        evaluator.source.connectionId,
        evaluator.source.connectorType,
        evaluator.source.eventType,
        evaluator.source.resourceId ?? null,
        JSON.stringify(evaluator),
        destinationKind,
        destinationKind === "automation" ? request.destination.automationId : null,
        destinationKind === "workstream_resource_update" ? request.destination.workstreamId : null,
        destinationKind === "workstream_resource_update" ? request.destination.substreamId : null,
        destinationKind === "workstream_resource_update" ? request.destination.resourceId : null,
        now,
        now,
      );
    }
    for (const evaluator of changed) {
      if (evaluator.source.connectorType !== "canva" || destinationKind !== "automation") continue;
      if (!evaluator.source.resourceId) throw new Error("canva_trigger_requires_design");
      const resource = this.state.storage.sql.exec<{ id: string }>(
        "SELECT id FROM resources WHERE id = ? AND connection_id = ? AND provider = 'canva' AND resource_type = 'canva_design'",
        evaluator.source.resourceId, evaluator.source.connectionId,
      ).toArray()[0];
      if (!resource) throw new Error("canva_trigger_design_unavailable");
      const at = new Date(now).toISOString();
      this.state.storage.sql.exec(
        `INSERT INTO schedules (id, workspace_id, connector_connection_id, schedule_type,
           interval_seconds, timezone, next_run_at, enabled, version, created_at, updated_at)
         VALUES (?, ?, ?, 'interval', ?, 'UTC', ?, 1, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET enabled = 1, connector_connection_id = excluded.connector_connection_id, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at`,
        evaluator.evaluatorId, request.workspaceId, evaluator.source.connectionId,
        CANVA_POLL_SECONDS, new Date(now + CANVA_POLL_SECONDS * 1_000).toISOString(), at, at,
      );
    }
    // Rows removed long ago are noise in every candidate scan; keep the
    // table to what still matches.
    this.state.storage.sql.exec(
      `DELETE FROM workspace_external_event_registrations
        WHERE state = 'removed' AND updated_at < ?`,
      now - 24 * 60 * 60_000,
    );
    return { effectiveAfterEventSequence: cutoff, applied: true };
  }

  /**
   * Queue the joins a Sidekick's saved Slack sources need (the Slack storage
   * decides what they are; see `enqueueSlackSourceJoins`) and hand each to the
   * ingress queue. Best effort: the registration has committed, and a join
   * that failed to queue is logged and made again by the next save.
   */
  private async joinSlackSourceConversations(
    workspaceId: string,
    automationId: string,
    sourceGeneration: number | undefined,
    evaluators: readonly { source: { connectorType: string; connectionId: string }; when: unknown }[],
  ): Promise<void> {
    let jobs: Awaited<ReturnType<typeof enqueueSlackSourceJoins>>;
    try {
      jobs = await enqueueSlackSourceJoins(this.state.storage, {
        workspaceId, automationId, sourceGeneration, evaluators, appId: this.env.SLACK_APP_ID ?? null,
      });
    } catch (error) {
      logWarn(this.env, "slack_sidekick_source_join_enqueue_failed", {
        workspace_id: workspaceId,
        automation_id: automationId,
        reason: diagnosticErrorCode(error, "slack_sidekick_source_join_enqueue_failed"),
      });
      return;
    }
    if (jobs.length > 0) this.refreshScheduleAfterSlackWrite(workspaceId);
    for (const job of jobs) {
      try {
        await sendInteractive(this.env, SlackIngressQueueMessageSchema.parse({
          kind: "slack_ingress",
          region: this.env.AVALON_REGION,
          workspaceId,
          jobId: job.jobId,
        }));
      } catch (error) {
        logWarn(this.env, "slack_sidekick_source_join_enqueue_failed", {
          workspace_id: workspaceId,
          automation_id: automationId,
          connection_id: job.connectionId,
          reason: diagnosticErrorCode(error, "slack_sidekick_source_join_enqueue_failed"),
        });
      }
    }
  }

  /** Cheap connector-ingress admission check; matching still happens after normalization. */
  async hasActiveExternalEventRegistration(input: unknown): Promise<{ active: boolean }> {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema,
      connectionId: IdSchema,
      eventType: z.string().min(1).max(200),
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{ one: number }>(
      `SELECT 1 AS one
         FROM workspace_external_event_registrations
        WHERE workspace_id = ? AND connection_id = ? AND event_type = ? AND state = 'active'
        LIMIT 1`,
      request.workspaceId,
      request.connectionId,
      request.eventType,
    ).toArray()[0];
    return { active: row !== undefined };
  }

  /**
   * Every destination one accepted event reaches, each as a complete Queue
   * message.
   *
   * No ledger and no lease. Each delivery carries the registration, the
   * destination and the event, and the object it lands on is idempotent on
   * that pair: an automation keys its run on the event id, a watched work
   * stream keys its receipt on the event and registration ids. A redelivery
   * is therefore a no-op there, which is all a lease ever guaranteed.
   */
  async matchExternalEventDestinations(input: unknown) {
    await this.initialized;
    const request = parseRpcInput(z.strictObject({ workspaceId: WorkspaceIdSchema, eventId: IdSchema }), input, "match_external_event_destinations");
    this.assertWorkspace(request.workspaceId);
    const event = this.state.storage.sql.exec<{
      event_id: string;
      event_sequence: number;
      payload_hash: string;
      connection_id: string;
      connector_type: string;
      event_type: string;
      title: string;
      summary: string;
      occurred_at: number;
      text_snippet: string | null;
      metadata_json: string;
      connection_scope: string;
      connection_owner_user_id: string | null;
      target_user_ids_json: string;
      visibility_json: string;
    }>(`SELECT event_id, event_sequence, payload_hash, connection_id, connector_type,
              event_type, title, summary, occurred_at, text_snippet, metadata_json,
              connection_scope, connection_owner_user_id, target_user_ids_json, visibility_json
          FROM workspace_connector_events WHERE event_id = ?`, request.eventId).toArray()[0];
    if (!event) throw new Error("connector_event_not_found");
    const metadata = JSON.parse(event.metadata_json) as Record<string, unknown>;
    const context = externalEventContext(metadata, event.text_snippet);
    const resourceIds = Array.isArray(metadata.resourceIds)
      ? metadata.resourceIds.filter((value): value is string => typeof value === "string")
      : [];
    const registrations = this.state.storage.sql.exec<{
      registration_id: string;
      resource_id: string | null;
      evaluator_json: string;
      destination_kind: "automation" | "workstream_resource_update";
      automation_id: string | null;
      workstream_id: string | null;
      substream_id: string | null;
      destination_resource_id: string | null;
    }>(`SELECT registration_id, resource_id, evaluator_json, destination_kind, automation_id,
              workstream_id, substream_id, destination_resource_id
          FROM workspace_external_event_registrations
         WHERE state = 'active' AND connection_id = ? AND connector_type = ?
           AND event_type = ? AND effective_after_event_sequence < ?
         ORDER BY registration_id`,
    event.connection_id, event.connector_type, event.event_type, event.event_sequence).toArray();
    // Who this activity may reach, from the one implementation of that rule.
    // An automation is a reader like any other: a message in a private Slack
    // channel arrives on the *workspace* connection and carries its restriction
    // in `visibility`, so matching on connection and event type alone would let
    // a personal automation's evaluator probe content its author cannot see.
    const restrictedUserIds = restrictedActivityUserIds(event);
    // The host wrote the occurrence key beside the provider's metadata at
    // ingest; the destination gets it as its own field and dedupes on it.
    const { occurrenceKey, ...eventMetadata } = metadata;
    const workspaceEvent = {
      id: event.event_id,
      eventSequence: event.event_sequence,
      eventType: event.event_type,
      title: event.title,
      summary: event.summary,
      textSnippet: event.text_snippet ?? "",
      metadata: eventMetadata,
      ...(typeof occurrenceKey === "string" && occurrenceKey.length > 0 ? { occurrenceKey } : {}),
      occurredAt: event.occurred_at,
      audienceUserIds: restrictedUserIds ?? [],
      audienceKind: restrictedUserIds === null ? "workspace" as const : "restricted" as const,
      sourceConnectionId: event.connection_id,
      sourceConnectionScope: event.connection_scope === "personal" ? "personal" as const : "workspace" as const,
      sourceConnectionOwnerUserId: event.connection_owner_user_id,
    };
    // A message in a bound external conversation is claimed by its binding,
    // as a matched watch claims one. The adapter wrote the binding key beside the provider
    // metadata; any connector that writes one is resolved the same way.
    const boundKey = ExternalConversationKeySchema.safeParse({
      installationId: metadata.externalConversationInstallationId,
      path: metadata.externalConversationPath,
    });
    const binding = !boundKey.success ? null : this.externalBindings().resolve({
      installationId: boundKey.data.installationId,
      path: boundKey.data.path,
      addressed: false,
      claimKey: null,
      pendingStaleBefore: new Date(0).toISOString(),
    });
    // A reply bound to a Sidekick's run continues that run through the
    // binding. The same message is not also a new trigger for that Sidekick,
    // or one answer would start a second run beside the one it answers.
    const boundSidekickId = binding?.outcome === "deliver" && binding.target.parentKind === "automation"
      ? binding.target.parentId
      : null;
    const delegateEligibility = new Map<string, Promise<boolean>>();
    const matches = await Promise.all(registrations.map(async (registration) => {
      if (registration.resource_id && !resourceIds.includes(registration.resource_id)) return [];
      if (boundSidekickId !== null && registration.automation_id === boundSidekickId) return [];
      const evaluator = ExternalEventEvaluatorV1Schema.parse(JSON.parse(registration.evaluator_json));
      if (!evaluateExternalEventPredicate(evaluator.when, context)) return [];
      if (registration.destination_kind === "automation") {
        const sidekick = registration.automation_id === null ? null : await this.sidekickParent(registration.automation_id, request.workspaceId);
        if (!sidekick || await sidekick.eventCoordinator(workspaceEvent, registration.registration_id, delegateEligibility) === null) {
          if (sidekick && registration.automation_id) await this.sidekickCall(registration.automation_id, request.workspaceId,
            (target) => target.noteDelegationAttention("event_no_eligible_delegate"));
          logInfo(this.env, "external_event_delegation_refused", {
            workspace_id: request.workspaceId, event_id: request.eventId,
            automation_id: registration.automation_id, code: "sidekick_no_eligible_delegate",
          });
          return [];
        }
      }
      const destination = registration.destination_kind === "automation"
        ? { kind: "automation" as const, automationId: registration.automation_id! }
        : {
            kind: "workstream_resource_update" as const,
            workstreamId: registration.workstream_id!,
            substreamId: registration.substream_id!,
            resourceId: registration.destination_resource_id!,
          };
      return [WorkspaceExternalEventDeliveryQueueMessageSchema.parse({
        type: "workspace_external_event_delivery_v1",
        schemaVersion: 1,
        region: this.env.AVALON_REGION,
        workspaceId: request.workspaceId,
        registrationId: registration.registration_id,
        destination,
        event: workspaceEvent,
        payloadHash: event.payload_hash,
      })];
    }));
    const deliveries = matches.flat();
    // A silent non-match reads exactly like a lost event to the person whose
    // automation never fired; the count and the event are what they need.
    logInfo(this.env, "external_event_matched", {
      workspace_id: request.workspaceId,
      event_id: request.eventId,
      event_type: event.event_type,
      connector_type: event.connector_type,
      delivery_count: deliveries.length,
      destinations: deliveries.map((delivery) => `${delivery.destination.kind}:${delivery.registrationId}`).slice(0, 20),
    });
    return WorkspaceExternalEventMatchResultSchema.parse({
      matched: deliveries.length > 0 || binding?.outcome === "deliver",
      deliveries,
    });
  }

  private latestConnectorEventSequence(): number {
    return this.state.storage.sql.exec<{ sequence: number }>(
      `SELECT COALESCE(MAX(event_sequence), 0) AS sequence FROM workspace_connector_events`,
    ).one().sequence;
  }

  /**
   * The Organization's General Space with its hosted parent, created once.
   *
   * Two forms, because `SpaceService` writes the D1 anchor under General's id
   * before General exists and so has to learn first whether it does. Without
   * a `spaceId` this only answers: General, or `absent`; that is the whole
   * cost for every caller after the first. With one, General and its hosted
   * parent are written in one transaction, or the General a concurrent caller
   * made is the answer (`created: false`) and the unique partial index is
   * still what decided it.
   */

  /** This person's personal system prompt here; empty text and revision 0 for none. */
  async personalSystemPrompt(input: PersonalSystemPromptReadRequest): Promise<PersonalSystemPromptRecord> {
    await this.initialized;
    const request = parseRpcInput(PersonalSystemPromptReadRequestSchema, input, "personal_system_prompt");
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{ text: string; revision: number }>(
      `SELECT text, revision FROM member_personal_system_prompts WHERE user_id = ?`,
      request.userId,
    ).toArray()[0];
    return { personalSystemPrompt: row?.text ?? "", revision: row?.revision ?? 0 };
  }

  /** Replace this person's personal system prompt and answer with what was stored. */
  async savePersonalSystemPrompt(input: PersonalSystemPromptWriteRequest): Promise<PersonalSystemPromptRecord> {
    await this.initialized;
    const request = parseRpcInput(PersonalSystemPromptWriteRequestSchema, input, "save_personal_system_prompt");
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{ text: string; revision: number }>(
      `INSERT INTO member_personal_system_prompts (user_id, text, revision, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (user_id) DO UPDATE SET text = excluded.text, revision = revision + 1,
         updated_at = excluded.updated_at
       RETURNING text, revision`,
      request.userId,
      request.personalSystemPrompt,
      Date.now(),
    ).one();
    return { personalSystemPrompt: row.text, revision: row.revision };
  }

  async memberPreferences(input: MemberPreferencesReadRequest): Promise<MemberPreferences> {
    await this.initialized;
    const request = parseRpcInput(MemberPreferencesReadRequestSchema, input, "member_preferences");
    this.assertWorkspace(request.workspaceId);
    return this.readMemberPreferences(request.userId);
  }

  /**
   * Save what this person changed and answer with everything stored. A field,
   * kind or push switch the save leaves out keeps its stored value.
   */
  async saveMemberPreferences(input: MemberPreferencesWriteRequest): Promise<MemberPreferences> {
    await this.initialized;
    const request = parseRpcInput(MemberPreferencesWriteRequestSchema, input, "save_member_preferences");
    this.assertWorkspace(request.workspaceId);
    const row = this.memberPreferencesRow(request.userId);
    const current = storedMemberPreferences(row);
    const showAgentWork = request.preferences.showAgentWork ?? current.showAgentWork;
    const push = mergePushPreferences(storedPushPreferences(row?.push_json), request.preferences.push);
    const notify = savedNotify(row, current.notify, request.preferences);
    const stored = { show_agent_work: showAgentWork ? 1 : 0, push_json: JSON.stringify(push), notify_json: JSON.stringify(notify) };
    this.state.storage.sql.exec(
      `INSERT INTO member_preferences (user_id, show_agent_work, push_json, notify_json, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET show_agent_work = excluded.show_agent_work,
         push_json = excluded.push_json, notify_json = excluded.notify_json, updated_at = excluded.updated_at`,
      request.userId,
      stored.show_agent_work,
      stored.push_json,
      stored.notify_json,
      Date.now(),
    );
    return storedMemberPreferences(stored);
  }

  private memberPreferencesRow(userId: string) {
    return this.state.storage.sql.exec<{ show_agent_work: number; push_json: string; notify_json: string }>(
      `SELECT show_agent_work, push_json, notify_json FROM member_preferences WHERE user_id = ?`,
      userId,
    ).toArray()[0];
  }

  private readMemberPreferences(userId: string): MemberPreferences {
    return storedMemberPreferences(this.memberPreferencesRow(userId));
  }

  /** Whether this person's choices send a notification of this kind on this channel. */
  async notificationAllows(input: NotificationAllowsRequest): Promise<boolean> {
    await this.initialized;
    const request = parseRpcInput(NotificationAllowsRequestSchema, input, "notification_allows");
    this.assertWorkspace(request.workspaceId);
    return notificationAllows(this.readMemberPreferences(request.userId).notify, request.kind, request.channel);
  }

  /**
   * Tell each socket which of these resources have a new head, so a preview
   * open on one moves to it. A socket hears only the artifacts of a Canvas its
   * person may open (`canvas_artifacts`, written by the publish that attached
   * each one). Not on the waterline and never replayed: a client that was
   * away reads each head when it next opens the Canvas.
   *
   * The heads are built from bounded columns (`readResourceHeads`), so the
   * event is assembled rather than parsed again for every person.
   *
   * One visibility read per person, whatever the number of their sockets.
   */
  private publishResourceVersions(heads: readonly ResourceHead[]): void {
    if (heads.length === 0) return;
    const linkedTo = new Map<string, string[]>();
    for (const row of this.state.storage.sql.exec<{ resource_id: string; canvas_id: string }>(
      `SELECT resource_id, canvas_id FROM canvas_artifacts
        WHERE resource_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(heads.map((head) => head.resourceId)),
    )) {
      linkedTo.set(row.resource_id, [...linkedTo.get(row.resource_id) ?? [], row.canvas_id]);
    }
    if (linkedTo.size === 0) return;
    const occurredAt = new Date().toISOString();
    const payloads = new Map<string, string | null>();
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      const key = `${attachment.userId}:${attachment.accessClass ?? "member"}`;
      let payload = payloads.get(key);
      if (payload === undefined) {
        const viewer = viewerOf(attachment);
        const opened = new Map<string, boolean>();
        // An artifact belongs to the Canvas whose conversation made it; the
        // viewer is sent its head when they may open that Canvas.
        const opens = (canvasId: string): boolean => {
          let open = opened.get(canvasId);
          if (open === undefined) {
            open = this.canvasVisible(viewer, canvasId) === true;
            opened.set(canvasId, open);
          }
          return open;
        };
        const visible = heads.filter((head) => (linkedTo.get(head.resourceId) ?? []).some(opens));
        const event: WorkspaceResourceVersionsEvent = {
          type: "workspace_resource_versions",
          occurredAt,
          resources: visible,
        };
        payload = visible.length === 0 ? null : JSON.stringify(event);
        payloads.set(key, payload);
      }
      if (payload === null) continue;
      try {
        socket.send(payload);
      } catch {
        // Hibernation owns cleanup; a reconnecting client reads the heads it opens.
      }
    }
  }

  /**
   * The conversations one listed thread's job runs over, or `null` (settling
   * the row) when there is nothing to do. Server-to-server, like the
   * channel-colour RPCs above.
   */
  async applyConversationView(input: unknown): Promise<void> {
    await this.initialized;
    const value = parseRpcInput(ConversationViewProjectionSchema, input, "conversation_view_projection");
    this.assertWorkspace(value.workspaceId);
    if (value.region !== this.env.AVALON_REGION) throw new Error("conversation_view_region_mismatch");
    new WorkspaceConversationView(this.state.storage).apply(value);
  }

  /**
   * The conversation one marked row asks to refresh the digest copies of, or
   * `null` (settling the row when the holder is gone) when there is nothing to
   * do. Server-to-server, like the channel-colour RPCs above.
   */
  async memoryDigestSyncWork(input: MemoryDigestSyncMessage): Promise<MemoryDigestSyncWork> {
    await this.initialized;
    const request = parseRpcInput(MemoryDigestSyncMessageSchema, input, "memory_digest_sync_work");
    this.assertWorkspace(request.workspaceId);
    const work = MemoryDigestSyncWorkSchema.parse(this.state.storage.transactionSync(() => memoryDigestSyncWork(
      this.state.storage.sql, { conversation: request.conversation, revision: request.revision },
    )));
    // A settled row may be the last of its batch, which lets the next one go.
    if (work === null) await this.armNextAlarm();
    return work;
  }

  /** Settle a conversation whose digest copies were refreshed. */
  async completeMemoryDigestSync(input: MemoryDigestSyncMessage): Promise<boolean> {
    await this.initialized;
    const request = parseRpcInput(MemoryDigestSyncMessageSchema, input, "complete_memory_digest_sync");
    this.assertWorkspace(request.workspaceId);
    const completed = completeMemoryDigestSync(this.state.storage.sql, request.conversation, request.revision);
    await this.armNextAlarm();
    return completed;
  }

  /** A conversation the consumer could not refresh: it retries at its own gate and holds back nothing. */
  async releaseMemoryDigestSync(input: MemoryDigestSyncMessage): Promise<boolean> {
    await this.initialized;
    const request = parseRpcInput(MemoryDigestSyncMessageSchema, input, "release_memory_digest_sync");
    this.assertWorkspace(request.workspaceId);
    const released = releaseMemoryDigestSync(this.state.storage.sql, request.conversation, request.revision);
    await this.armNextAlarm();
    return released;
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
    const request = parseRpcInput(WorkspaceConnectorEventIngestRequestSchema, input, "ingest_connector_event");
    if (!this.workspaceId()) {
      this.ensureIdentity(
        request.workspaceId,
        await workspacePlacementAffinity(this.env, request.workspaceId),
      );
    }
    this.assertWorkspace(request.workspaceId);
    const activity = request.event.activity;
    // Evaluators address canonical Rally identities, never provider IDs. Resolve
    // provider relationships once before the canonical event commits so every
    // destination sees one closed context without per-evaluator provider work.
    const relatedResourceIds = resolveWorkspaceEventResources(this.state.storage.sql, {
      workspaceId: request.workspaceId,
      connectionId: activity.connectionId,
      provider: activity.provider,
      providerResourceId: activity.providerResourceId,
      entityKeys: activity.entityKeys,
    });
    const resolvedPeople = (activity.externalPeople ?? []).flatMap((person) => {
      // SQL equality with NULL cannot match an identity; Gmail addresses have
      // no provider user ID, so avoid a query per address on large messages.
      if (!person.providerUserId || !person.providerTenantId) return [];
      const row = this.state.storage.sql.exec<{ user_id: string }>(
        `SELECT user_id FROM external_user_identities
          WHERE workspace_id = ? AND provider = ?
            AND provider_tenant_id = ? AND provider_user_id = ?`,
        request.workspaceId,
        person.provider,
        person.providerTenantId,
        person.providerUserId,
      ).toArray()[0];
      return row ? [{ userId: row.user_id, role: person.role }] : [];
    });
    const participantPersonIds = [...new Set(resolvedPeople.map((person) => person.userId))];
    const authorPersonIds = [...new Set(resolvedPeople
      .filter((person) => person.role === "author" || person.role === "actor")
      .map((person) => person.userId))];
    // The occurrence key is the adapter's, never the provider payload's: a
    // same-named key in the activity's metadata is dropped here — the generic
    // webhook copies a caller's metadata whole — and the one the contract
    // carries is written under the host's name for the matcher to lift.
    const providerMetadata = Object.fromEntries(
      Object.entries(activity.metadata).filter(([key]) => key !== "occurrenceKey"),
    );
    const evaluatorMetadata = {
      ...providerMetadata,
      ...(activity.occurrenceKey ? { occurrenceKey: activity.occurrenceKey } : {}),
      ...(relatedResourceIds.length > 0 ? { resourceIds: relatedResourceIds } : {}),
      ...(participantPersonIds.length > 0 ? { participantPersonIds } : {}),
      ...(authorPersonIds.length > 0 ? { authorPersonIds } : {}),
      ...(authorPersonIds[0] ? { actorPersonId: authorPersonIds[0] } : {}),
    };
    const contentFingerprint = activity.providerResourceId
      ? await workspaceConnectorEventContentFingerprint(request.event)
      : null;
    // Hashing awaits outside the transaction. Recheck the exact snapshot hash
    // before using a compatibility result, because another ingest can interleave.
    const replayCandidates = activity.provider === "google" ? this.state.storage.sql.exec<WorkspaceConnectorEventRow>(
      `SELECT * FROM workspace_connector_events WHERE event_id = (
         SELECT connector_event_id FROM workspace_connector_event_ingress_receipts WHERE ingress_event_id = ?)
       OR (connection_id = ? AND (provider_event_id = ? AND event_type = ? OR dedupe_key = ?))`,
      request.ingressEventId, activity.connectionId, activity.providerEventId, activity.eventType, activity.dedupeKey,
    ).toArray() : [];
    const compatibleReplays = new Map<string, { hash: string; enrichment: { event: WorkspaceConnectorEvent; hash: string; fingerprint: string } | null }>();
    for (const candidate of replayCandidates) {
      if (candidate.payload_hash === request.payloadHash) continue;
      const compatibility = await googleConnectorReplayCompatibility(
        connectorEventFromRow(this.state.storage.sql, candidate, request.workspaceId, this.env.AVALON_REGION), request.event,
      );
      if (compatibility.compatible) {
        const event = compatibility.enrichedEvent;
        const enrichment = event ? {
          event,
          hash: await workspaceConnectorEventPayloadHash(event),
          fingerprint: await workspaceConnectorEventContentFingerprint(event),
        } : null;
        compatibleReplays.set(candidate.event_id, { hash: candidate.payload_hash, enrichment });
      }
    }
    const compatible = (eventId: string, hash: string) => {
      const snapshot = compatibleReplays.get(eventId);
      if (snapshot && snapshot.hash !== hash) throw new Error("connector_event_replay_raced");
      return Boolean(snapshot);
    };
    const enrichReplay = (eventId: string) => {
      const snapshot = compatibleReplays.get(eventId);
      const enrichment = snapshot?.enrichment;
      if (!enrichment) return;
      const row = this.state.storage.sql.exec<{ payload_hash: string; metadata_json: string }>(
        "SELECT payload_hash, metadata_json FROM workspace_connector_events WHERE event_id = ?", eventId).one();
      if (row.payload_hash !== snapshot.hash) throw new Error("connector_event_replay_raced");
      this.state.storage.sql.exec("DELETE FROM workspace_connector_event_people WHERE event_id = ?", eventId);
      writeConnectorEventPeople(this.state.storage.sql, eventId, enrichment.event.activity.externalPeople ?? []);
      // Keep host-derived evaluator identities while enriching provider context.
      const previousMetadata = JSON.parse(row.metadata_json);
      for (const key of ["resourceIds", "participantPersonIds", "authorPersonIds"] as const) {
        const combined = [...(previousMetadata[key] ?? []), ...(evaluatorMetadata[key] ?? [])];
        if (combined.length > 0) previousMetadata[key] = [...new Set(combined)];
      }
      previousMetadata.actorPersonId ??= evaluatorMetadata.actorPersonId;
      this.state.storage.sql.exec("UPDATE workspace_connector_events SET payload_hash = ?, metadata_json = ?, external_people_json = '[]' WHERE event_id = ?",
        enrichment.hash, JSON.stringify({ ...previousMetadata, ...enrichment.event.activity.metadata }), eventId);
      this.state.storage.sql.exec(
        "UPDATE workspace_connector_event_latest_content SET content_fingerprint = ? WHERE event_id = ?", enrichment.fingerprint, eventId);
    };
    let unchangedContent = false;
    const result = WorkspaceConnectorEventIngestResultSchema.parse(
      this.state.storage.transactionSync(() => {
        const receipt = this.state.storage.sql.exec<{
          payload_hash: string;
          canonical_payload_hash: string;
          connector_event_id: string;
          processing_status: WorkspaceConnectorEventRow["processing_status"];
          processing_attempt: number;
          provider_event_id: string;
          dedupe_key: string;
          restored_event_id: string | null;
        }>(
          `SELECT receipt.payload_hash, event.payload_hash AS canonical_payload_hash, receipt.connector_event_id, event.processing_status,
                  event.processing_attempt, event.provider_event_id, event.dedupe_key,
                  restored.event_id AS restored_event_id
             FROM workspace_connector_event_ingress_receipts receipt
             JOIN workspace_connector_events event ON event.event_id = receipt.connector_event_id
             LEFT JOIN workspace_connector_events restored
               ON restored.event_id = receipt.restored_event_id
              AND restored.processing_status = 'pending'
            WHERE receipt.ingress_event_id = ?`,
          request.ingressEventId,
        ).toArray()[0];
        if (receipt) {
          if (receipt.payload_hash !== request.payloadHash && receipt.canonical_payload_hash !== request.payloadHash
            && !compatible(receipt.connector_event_id, receipt.canonical_payload_hash)) {
            throw new Error("connector_event_ingress_idempotency_conflict");
          }
          enrichReplay(receipt.connector_event_id);
          // Only a content match receipts a delivery against an event with
          // neither its provider identity nor its dedupe key, so a redelivered
          // repeat is still answered as one.
          unchangedContent = receipt.provider_event_id !== activity.providerEventId
            && receipt.dedupe_key !== activity.dedupeKey;
          return {
            eventId: receipt.connector_event_id,
            duplicate: true,
            processingStatus: receipt.processing_status,
            processingAttempt: receipt.processing_attempt,
            ...(unchangedContent ? { unchangedContent: true as const } : {}),
            ...(receipt.restored_event_id ? { restoredEventId: receipt.restored_event_id } : {}),
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
        if (canonical && canonical.payload_hash !== request.payloadHash
          && !compatible(canonical.event_id, canonical.payload_hash)) {
          throw new Error("connector_event_identity_reused_with_different_content");
        }
        if (canonical) enrichReplay(canonical.event_id);

        const now = Date.now();
        const occurredAt = Date.parse(activity.occurredAt);
        // What this resource's latest content is, and the newest occurrence it
        // stands for. See docs/connectors.md#dropping-events-that-say-nothing-new.
        const latest = !canonical && contentFingerprint
          ? this.state.storage.sql.exec<{
            content_fingerprint: string;
            occurred_at: number;
            dropped_json: string | null;
            event_id: string;
            processing_status: WorkspaceConnectorEventRow["processing_status"];
            processing_attempt: number;
          }>(
            `SELECT latest.content_fingerprint, latest.occurred_at, latest.dropped_json,
                    event.event_id, event.processing_status, event.processing_attempt
               FROM workspace_connector_event_latest_content latest
               JOIN workspace_connector_events event ON event.event_id = latest.event_id
              WHERE latest.connection_id = ? AND latest.event_type = ?
                AND latest.provider_resource_id = ?`,
            activity.connectionId,
            activity.eventType,
            activity.providerResourceId,
          ).toArray()[0]
          : undefined;
        // Arriving no earlier than the latest occurrence, a repeat of its
        // content is that event again: receipted against it, and nothing new
        // is stored or processed. Its identity is kept on the row in case an
        // older, different event arrives after it. Never a failed event: its
        // content was never delivered, so a repeat of it is stored with a
        // fresh retry budget instead.
        const inOrder = !latest || occurredAt >= latest.occurred_at;
        const unchanged = latest && inOrder
          && latest.content_fingerprint === contentFingerprint
          && latest.processing_status !== "failed"
          ? latest
          : undefined;
        unchangedContent = Boolean(unchanged);
        const existing = canonical ?? unchanged;
        let eventId = existing?.event_id ?? activity.id;
        let processingStatus = existing?.processing_status ?? "pending";
        let restoredEventId: string | null = null;
        if (unchanged) {
          this.state.storage.sql.exec(
            `UPDATE workspace_connector_event_latest_content
                SET occurred_at = ?, dropped_json = ?
              WHERE connection_id = ? AND event_type = ? AND provider_resource_id = ?`,
            occurredAt,
            JSON.stringify({
              eventId: activity.id,
              payloadHash: request.payloadHash,
              providerEventId: activity.providerEventId,
              dedupeKey: activity.dedupeKey,
              occurredAt,
              receivedAt: Date.parse(activity.receivedAt),
              payloadRef: activity.payloadRef,
            } satisfies DroppedConnectorEventIdentity),
            activity.connectionId,
            activity.eventType,
            activity.providerResourceId,
          );
        }
        if (!existing) {
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
            occurredAt,
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
            JSON.stringify(evaluatorMetadata),
            '[]',
            now,
            now,
          );
          writeConnectorEventPeople(this.state.storage.sql, activity.id, activity.externalPeople ?? []);
          eventId = activity.id;
          processingStatus = "pending";
          if (contentFingerprint && inOrder) {
            this.state.storage.sql.exec(
              `INSERT INTO workspace_connector_event_latest_content
                 (connection_id, event_type, provider_resource_id, content_fingerprint, event_id,
                  occurred_at, dropped_json)
               VALUES (?, ?, ?, ?, ?, ?, NULL)
               ON CONFLICT (connection_id, event_type, provider_resource_id) DO UPDATE SET
                 content_fingerprint = excluded.content_fingerprint,
                 event_id = excluded.event_id,
                 occurred_at = excluded.occurred_at,
                 dropped_json = NULL`,
              activity.connectionId,
              activity.eventType,
              activity.providerResourceId,
              contentFingerprint,
              activity.id,
              occurredAt,
            );
          } else if (latest?.dropped_json && latest.content_fingerprint !== contentFingerprint) {
            // A different event older than a dropped repeat: that repeat was
            // news after all, the state this one changed back from. Restore it
            // from the event whose content it repeated, under its own identity.
            const dropped = JSON.parse(latest.dropped_json) as DroppedConnectorEventIdentity;
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
              )
              SELECT ?, ?, connection_id, connection_scope,
                     connection_owner_user_id, connector_type, provider,
                     ?, event_type, resource_type, provider_resource_id,
                     actor_json, subject_json, ?, ?, title, summary,
                     text_snippet, ?, visibility_json, target_user_ids_json,
                     entity_keys_json, ?, raw_content_hash, metadata_json,
                     external_people_json, 'pending', NULL, -1, NULL, NULL, NULL, ?, ?
                FROM workspace_connector_events WHERE event_id = ?`,
              dropped.eventId,
              dropped.payloadHash,
              dropped.providerEventId,
              dropped.occurredAt,
              dropped.receivedAt,
              dropped.payloadRef,
              dropped.dedupeKey,
              now,
              now,
              latest.event_id,
            );
            this.state.storage.sql.exec(
              `UPDATE workspace_connector_event_latest_content
                  SET event_id = ?, dropped_json = NULL
                WHERE connection_id = ? AND event_type = ? AND provider_resource_id = ?`,
              dropped.eventId,
              activity.connectionId,
              activity.eventType,
              activity.providerResourceId,
            );
            copyConnectorEventPeople(this.state.storage.sql, latest.event_id, dropped.eventId);
            restoredEventId = dropped.eventId;
          }
        }
        this.state.storage.sql.exec(
          `INSERT INTO workspace_connector_event_ingress_receipts
             (ingress_event_id, payload_hash, connector_event_id, received_at, restored_event_id)
           VALUES (?, ?, ?, ?, ?)`,
          request.ingressEventId,
          request.payloadHash,
          eventId,
          now,
          restoredEventId,
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
        return {
          eventId,
          duplicate: Boolean(existing),
          processingStatus,
          processingAttempt: existing?.processing_attempt ?? -1,
          ...(unchangedContent ? { unchangedContent: true as const } : {}),
          ...(restoredEventId ? { restoredEventId } : {}),
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
      unchanged_content: unchangedContent,
      restored_event_id: result.restoredEventId ?? null,
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
    return row ? connectorEventFromRow(this.state.storage.sql, row, request.workspaceId, this.env.AVALON_REGION) : null;
  }

  /** Delivery projection: avoid returning the entire roster when only context is needed. */
  async connectorEventContext(input: unknown) {
    await this.initialized;
    const request = parseRpcInput(z.strictObject({ workspaceId: WorkspaceIdSchema, eventId: IdSchema }), input, "connector_event_context");
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{ text_snippet: string | null; metadata_json: string }>(
      "SELECT text_snippet, metadata_json FROM workspace_connector_events WHERE event_id = ?", request.eventId,
    ).toArray()[0];
    if (!row) throw new Error("connector_event_not_found");
    const { occurrenceKey, ...metadata } = z.record(z.string(), z.unknown()).parse(JSON.parse(row.metadata_json));
    void occurrenceKey; // The delivery carries the host-owned occurrence field separately.
    return { textSnippet: row.text_snippet ?? "", metadata };
  }

  async claimConnectorEvent(
    input: WorkspaceConnectorEventClaimRpcRequest,
  ): Promise<WorkspaceConnectorEventClaimRpcResult> {
    await this.initialized;
    const rpcRequest = parseRpcInput(WorkspaceConnectorEventClaimRpcRequestSchema, input, "claim_connector_event");
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
          event: connectorEventFromRow(this.state.storage.sql, row, request.workspaceId, this.env.AVALON_REGION),
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
    const rpcRequest = parseRpcInput(WorkspaceConnectorEventSettleRpcRequestSchema, input, "settle_connector_event");
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
    const settledRow = this.state.storage.sql.exec<{ received_at: number }>(
      `UPDATE workspace_connector_events
          SET processing_status = ?, processed_at = CASE WHEN ? = 'processed' THEN ? ELSE NULL END,
              processing_error = ?, updated_at = ?
        WHERE event_id = ? AND workflow_instance_id = ? AND processing_status = 'processing'
        RETURNING received_at`,
      request.outcome,
      request.outcome,
      now,
      request.error,
      now,
      request.eventId,
      processingLeaseId,
    ).toArray()[0];
    if (settledRow !== undefined) {
      // A processed row is now due for `connector_event_reap`. Nothing else
      // may arm the alarm in a quiet Organization, so bring it forward here.
      if (request.outcome === "processed") {
        await this.ensureAlarmNoLaterThan(settledRow.received_at + CONNECTOR_EVENT_BODY_RETENTION_MS);
      }
      logInfo(this.env, "connector_event_authority_terminal", {
        workspace_id: request.workspaceId,
        connector_event_id: request.eventId,
        processing_owner_id: request.processingOwnerId,
        processing_lease_id: processingLeaseId,
        processing_rpc_contract: legacyWorkflowContract ? "legacy_workflow" : "current",
        outcome: request.outcome,
        reason: "settlement_committed",
        // `reason` says the write landed. What the settler was told went
        // wrong is `error`, persisted above and written for a person; the
        // code the settler derived from it is what the row indexes.
        ...(request.outcome === "failed" && "errorCode" in request && request.errorCode
          ? { error_code: request.errorCode }
          : {}),
      });
      return;
    }
    const settled = this.state.storage.sql.exec<{
      processing_status: WorkspaceConnectorEventRow["processing_status"];
      workflow_instance_id: string | null;
      received_at: number;
    }>(
      `SELECT processing_status, workflow_instance_id, received_at
         FROM workspace_connector_events WHERE event_id = ?`,
      request.eventId,
    ).toArray()[0];
    if (
      settled?.workflow_instance_id === processingLeaseId
      && settled.processing_status === request.outcome
    ) {
      // The first settle may have committed its row and died before arming.
      if (request.outcome === "processed") {
        await this.ensureAlarmNoLaterThan(settled.received_at + CONNECTOR_EVENT_BODY_RETENTION_MS);
      }
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

  /**
   * Freeze upload drafts for one pending work-stream input.
   *
   * The returned descriptors and the reservation commit are one WorkspaceDO
   * transaction. Product therefore never prepares bytes from a row that a
   * concurrent explicit delete or TTL pass can remove after admission.
   */
  async reserveDraftAttachments(
    input: WorkspaceReserveDraftAttachmentsRequest,
  ): Promise<WorkspaceReserveDraftAttachmentsResult> {
    await this.initialized;
    const request = WorkspaceReserveDraftAttachmentsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = this.state.storage.transactionSync(() => {
      const existing = this.state.storage.sql.exec<{
        workspace_id: string;
        workstream_id: string;
        input_id: string;
        resource_id: string;
        user_id: string;
      }>(
        `SELECT workspace_id, workstream_id, input_id, resource_id, user_id
           FROM pending_attachment_reservations
          WHERE input_id = ? ORDER BY resource_id`,
        request.inputId,
      ).toArray();
      const requestedIds = [...new Set(request.resourceIds)].sort();
      if (requestedIds.length !== request.resourceIds.length) {
        return WorkspaceReserveDraftAttachmentsResultSchema.parse({ outcome: "unavailable" });
      }
      if (existing.length > 0) {
        const existingIds = existing.map((row) => row.resource_id).sort();
        const identityMatches = existing.every((row) => (
          row.workspace_id === request.workspaceId
          && row.workstream_id === request.workstreamId
          && row.user_id === request.userId
        ));
        if (!identityMatches || JSON.stringify(existingIds) !== JSON.stringify(requestedIds)) {
          // This is an expected idempotency refusal, not an object failure. A
          // thrown Durable Object RPC error can break the input gate after the
          // caller has already handled the rejection, while the typed
          // unavailable outcome preserves the same fail-closed behavior.
          return WorkspaceReserveDraftAttachmentsResultSchema.parse({ outcome: "unavailable" });
        }
      }
      if (request.resourceIds.length === 0) {
        return WorkspaceReserveDraftAttachmentsResultSchema.parse({
          outcome: existing.length > 0 ? "replayed" : "reserved",
          resources: [],
        });
      }
      const rows = this.state.storage.sql.exec<{
        id: string;
        connection_id: string | null;
        resource_type: string;
        provider: string;
        provider_resource_id: string | null;
        title: string;
        mime_type: string | null;
        content_ref: string | null;
        content_sha256: string | null;
        canonical_url: string | null;
        metadata_json: string;
        model_content_ref: string | null;
        model_mime_type: string | null;
        model_content_sha256: string | null;
        model_metadata_json: string | null;
        model_content_status: "pending" | "processing" | "ready" | "failed" | "unsupported" | null;
        model_content_extractor_version: string | null;
        model_content_error_code: string | null;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT id, connection_id, resource_type, provider, provider_resource_id, title,
                mime_type, content_ref, content_sha256, canonical_url, metadata_json,
                model_content_ref, model_mime_type, model_content_sha256,
                model_metadata_json, model_content_status, model_content_extractor_version,
                model_content_error_code, created_at, updated_at
           FROM resources
          WHERE workspace_id = ? AND uploaded_by_user_id = ?
            AND attachment_status = 'draft'
            AND id IN (SELECT value FROM json_each(?))`,
        request.workspaceId,
        request.userId,
        JSON.stringify(request.resourceIds),
      ).toArray();
      if (rows.length !== request.resourceIds.length) {
        return WorkspaceReserveDraftAttachmentsResultSchema.parse({ outcome: "unavailable" });
      }
      if (existing.length === 0) {
        const now = Date.now();
        for (const resourceId of request.resourceIds) {
          this.state.storage.sql.exec(
            `INSERT INTO pending_attachment_reservations
               (workspace_id, workstream_id, input_id, resource_id, user_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            request.workspaceId,
            request.workstreamId,
            request.inputId,
            resourceId,
            request.userId,
            now,
          );
        }
      }
      const byId = new Map(rows.map((row) => [row.id, row]));
      return WorkspaceReserveDraftAttachmentsResultSchema.parse({
        outcome: existing.length > 0 ? "replayed" : "reserved",
        resources: request.resourceIds.map((resourceId) => {
          const row = byId.get(resourceId)!;
          return {
            id: row.id,
            connectionId: row.connection_id,
            resourceType: row.resource_type,
            provider: row.provider,
            providerResourceId: row.provider_resource_id,
            title: row.title,
            mimeType: row.mime_type,
            contentRef: row.content_ref,
            contentSha256: row.content_sha256,
            canonicalUrl: row.canonical_url,
            metadataJson: row.metadata_json,
            modelContentRef: row.model_content_ref,
            modelMimeType: row.model_mime_type,
            modelContentSha256: row.model_content_sha256,
            modelMetadataJson: row.model_metadata_json,
            modelContentStatus: row.model_content_status,
            modelContentExtractorVersion: row.model_content_extractor_version,
            modelContentErrorCode: row.model_content_error_code,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          };
        }),
      });
    });
    if (request.resourceIds.length > 0) {
      await this.refreshScheduleKinds(request.workspaceId, ["maintenance"]);
    }
    return result;
  }

  /**
   * Publish accepted upload reservations independently of the parent directory.
   * The Queue consumer calls this after parent admission; child resource state
   * must reach this owner even when the child's private directory does not.
   */
  async publishConversationAttachments(input: ConversationEffectEnvelope): Promise<void> {
    await this.initialized;
    const envelope = ConversationEffectEnvelopeSchema.parse(input);
    this.assertWorkspace(envelope.workspaceId);
    if (envelope.region !== this.env.AVALON_REGION) throw new Error("attachment_publication_region_mismatch");
    if (envelope.effect.kind !== "directory_common") return;
    const effect = envelope.effect;
    const linked = new Set((effect.resourceLinks ?? []).map((link) => link.resourceId));
    this.state.storage.transactionSync(() => {
      for (const release of effect.attachmentReservationReleases ?? []) {
        if (!linked.has(release.resourceId)) throw new Error("attachment_reservation_release_missing_resource_link");
        // A committed message owns this exact reservation. Replays after its
        // release cannot publish a different draft or consume another hold.
        this.state.storage.sql.exec(`UPDATE resources SET attachment_status = 'attached', updated_at = ?
          WHERE workspace_id = ? AND id = ? AND provider = 'avalon_upload' AND attachment_status = 'draft'
            AND EXISTS (SELECT 1 FROM pending_attachment_reservations
              WHERE workspace_id = ? AND workstream_id = ? AND input_id = ? AND resource_id = ?)`,
        new Date().toISOString(),envelope.workspaceId,release.resourceId,
        envelope.workspaceId,envelope.parentId,release.inputId,release.resourceId);
        this.state.storage.sql.exec(`DELETE FROM pending_attachment_reservations
          WHERE workspace_id = ? AND workstream_id = ? AND input_id = ? AND resource_id = ?`,
        envelope.workspaceId,envelope.parentId,release.inputId,release.resourceId);
      }
    });
    await this.refreshScheduleKinds(envelope.workspaceId,["maintenance"]);
  }

  /** Idempotently release one failed or discarded Product preparation. */
  async releaseDraftAttachments(
    input: WorkspaceReleaseDraftAttachmentsRequest,
  ): Promise<WorkspaceReleaseDraftAttachmentsResult> {
    await this.initialized;
    const request = WorkspaceReleaseDraftAttachmentsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const released = this.state.storage.sql.exec<{ resource_id: string }>(
      `DELETE FROM pending_attachment_reservations
        WHERE workspace_id = ? AND workstream_id = ? AND input_id = ?
        RETURNING resource_id`,
      request.workspaceId,
      request.workstreamId,
      request.inputId,
    ).toArray().length;
    // Always reconcile on replay: the preceding attempt may have committed the
    // delete and then lost the response while refreshing the single alarm.
    await this.refreshScheduleKinds(request.workspaceId, ["maintenance"]);
    return WorkspaceReleaseDraftAttachmentsResultSchema.parse({ released });
  }

  // ---------------------------------------------------------------------------
  // Workspace membership, as this object last heard it.
  // ---------------------------------------------------------------------------

  /** What the member table says about each viewer a batch names; absent means never heard of. */
  private memberStatuses(envelopes: readonly ParentEffectEnvelope[]): Map<string, boolean> {
    const userIds = [...new Set(envelopes.flatMap((envelope) => (
      envelope.effect.kind === "directory_user" ? [envelope.effect.userId] : []
    )))];
    if (userIds.length === 0) return new Map();
    return new Map(this.state.storage.sql.exec<{ user_id: string; active: number }>(
      `SELECT user_id, active FROM workspace_member_status WHERE user_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(userIds),
    ).toArray().map((row) => [row.user_id, row.active === 1]));
  }

  /**
   * A person's workspace relationship, answered from this object's table.
   *
   * The relationship change events keep the table current (the product
   * accepts that an answer may trail D1 by the time one takes to arrive; the
   * team set the tolerance at five minutes and chose to trust the events
   * rather than re-read on a timer). D1 is read once, for someone the table
   * has never heard of: a member from before the table existed.
   */
  private async readRelationship(workspaceId: string, userId: string): Promise<WorkspaceRelationship | null> {
    const known = this.knownRelationship(userId);
    if (known !== undefined) return known;
    const relationship = await readWorkspaceRelationship(this.env.DB, workspaceId, userId);
    if (relationship) {
      this.noteRelationship(relationship);
    } else {
      // Somebody with no relationship. A row that arrived during the read came
      // from an event or another read, and either is at least as new as this.
      this.state.storage.sql.exec(
        `INSERT INTO workspace_member_status (user_id, relationship_json, removed_incarnation, active, sequence, updated_at)
         VALUES (?, NULL, NULL, 0, 0, ?) ON CONFLICT (user_id) DO NOTHING`,
        userId, Date.now(),
      );
    }
    return relationship;
  }

  /** `activeSpaceMember` from the table alone, for a synchronous commit; unknown reads as no. */
  private knownActiveMember(userId: string): boolean {
    const known = this.knownRelationship(userId);
    return known?.status === "active" && known.accessClass === "member";
  }

  /** The table's answer, with no D1 read; `undefined` for somebody it has never heard of. */
  private knownRelationship(userId: string): WorkspaceRelationship | null | undefined {
    const row = this.state.storage.sql.exec<{ relationship_json: string | null }>(
      `SELECT relationship_json FROM workspace_member_status WHERE user_id = ?`, userId,
    ).toArray()[0];
    if (!row) return undefined;
    return row.relationship_json === null ? null : WorkspaceRelationshipSchema.parse(JSON.parse(row.relationship_json));
  }

  /**
   * A relationship this request just read from or wrote to D1. It replaces
   * the stored row only when it is provably newer: the stored relationship
   * was removed (or never existed) and this is a different incarnation, as
   * for a guest removed and invited again, or it is the same incarnation at a
   * higher revision. Anything else is left alone: an event may have landed
   * while the request waited on D1, and it is at least as new as the read. A
   * removed incarnation never comes back, and a live row of another
   * incarnation cannot be ordered against this one. The sequence is kept, so
   * every event after it still applies.
   */
  private noteRelationship(relationship: WorkspaceRelationship): void {
    this.state.storage.sql.exec(
      `INSERT INTO workspace_member_status (user_id, relationship_json, removed_incarnation, active, sequence, updated_at)
       VALUES (?, ?, NULL, ?, 0, ?)
       ON CONFLICT (user_id) DO UPDATE SET relationship_json = excluded.relationship_json,
         removed_incarnation = NULL, active = excluded.active, updated_at = excluded.updated_at
       WHERE (workspace_member_status.relationship_json IS NULL
               AND workspace_member_status.removed_incarnation IS NOT ?)
          OR (json_extract(workspace_member_status.relationship_json, '$.incarnation') = ?
               AND json_extract(workspace_member_status.relationship_json, '$.revision') < ?)`,
      relationship.userId,
      JSON.stringify(relationship),
      relationship.status === "active" ? 1 : 0,
      Date.now(),
      relationship.incarnation,
      relationship.incarnation,
      relationship.revision,
    );
  }

  /** The viewers a directory batch names that the member table has never heard of. */
  private unknownMembers(
    envelopes: readonly ParentEffectEnvelope[],
    known: ReadonlyMap<string, boolean> = this.memberStatuses(envelopes),
  ): string[] {
    return [...new Set(envelopes.flatMap((envelope) => (
      envelope.effect.kind === "directory_user" && !known.has(envelope.effect.userId) ? [envelope.effect.userId] : []
    )))];
  }

  /** Learn people the member table has never heard of: one D1 read each, recorded. */
  private async learnMembers(userIds: readonly string[]): Promise<void> {
    const workspaceId = this.workspaceId();
    if (!workspaceId || userIds.length === 0) return;
    const known = new Set(this.state.storage.sql.exec<{ user_id: string }>(
      `SELECT user_id FROM workspace_member_status WHERE user_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(userIds),
    ).toArray().map((row) => row.user_id));
    await Promise.all([...new Set(userIds)].filter((userId) => !known.has(userId))
      .map((userId) => this.readRelationship(workspaceId, userId)));
  }

  /**
   * A workspace relationship change event, applied in D1's order. Someone who
   * stops being an active member leaves every viewer directory in the same
   * transaction, so they drop out of other people's participant lists at once
   * rather than when their next projection arrives.
   */
  async applyMemberStatus(input: {
    workspaceId: string;
    sequence: number;
    removed: boolean;
    relationship: WorkspaceRelationship;
  }): Promise<{ applied: boolean }> {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema,
      sequence: z.number().int().positive(),
      removed: z.boolean(),
      relationship: WorkspaceRelationshipSchema,
    }).parse(input);
    // An object that has not learned its own identity yet still records the
    // relationship; refusing would block the revocation that follows it.
    if (this.workspaceId()) this.assertWorkspace(request.workspaceId);
    const userId = request.relationship.userId;
    const active = !request.removed && request.relationship.status === "active";
    const applied = this.state.storage.transactionSync(() => {
      const current = this.state.storage.sql.exec<{ sequence: number; incarnation: string | null; revision: number | null }>(
        `SELECT sequence, json_extract(relationship_json, '$.incarnation') AS incarnation,
                json_extract(relationship_json, '$.revision') AS revision
           FROM workspace_member_status WHERE user_id = ?`, userId,
      ).toArray()[0];
      if (current && current.sequence >= request.sequence) return false;
      if (!request.removed && current?.incarnation === request.relationship.incarnation
        && (current.revision ?? 0) > request.relationship.revision) {
        // A request already recorded a later revision it read from D1; this
        // event is an older step on the way there. Take its place in the order
        // without moving the answer backwards.
        this.state.storage.sql.exec(
          `UPDATE workspace_member_status SET sequence = ? WHERE user_id = ?`, request.sequence, userId,
        );
        return true;
      }
      this.state.storage.sql.exec(
        `INSERT INTO workspace_member_status (user_id, relationship_json, removed_incarnation, active, sequence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET relationship_json = excluded.relationship_json,
           removed_incarnation = excluded.removed_incarnation, active = excluded.active,
           sequence = excluded.sequence, updated_at = excluded.updated_at`,
        userId, request.removed ? null : JSON.stringify(request.relationship),
        request.removed ? request.relationship.incarnation : null, active ? 1 : 0,
        request.sequence, Date.now(),
      );
      this.queueSidekickSourcesForUsers([userId]);
      return true;
    });
    if (this.state.storage.sql.exec("SELECT 1 FROM _internal_durable_alarms WHERE kind='sidekick_delegation_sources' LIMIT 1").toArray().length > 0) await this.armNextAlarm();
    return { applied };
  }

  /**
   * Apply one Channel or Space parent's activity/mention effect and its replay receipt in a
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
    return WorkspaceRegionalEffectApplyResultSchema.parse(result);
  }

  async readNotificationIntentForDelivery(input: WorkspaceNotificationIntentRequest): Promise<WorkspaceNotificationIntentDelivery | null> {
    await this.initialized;
    const request = WorkspaceNotificationIntentRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return readStoredPushIntent(this.state.storage, request);
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
    if (result.outcome === "terminal") await this.refreshScheduleKinds(request.workspaceId, ["maintenance"]);
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
      await this.refreshScheduleKinds(request.workspaceId, ["maintenance"]);
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

  async applyScopeGrantDirectory(input: unknown): Promise<{ applied: boolean }> {
    await this.initialized;
    const envelope = ParentEffectEnvelopeSchema.parse(input);
    this.assertWorkspace(envelope.workspaceId);
    if (envelope.region !== this.env.AVALON_REGION) throw new Error("scope_grant_directory_region_mismatch");
    return { applied: applyScopeGrantDirectory(this.state.storage, envelope) };
  }

  async listScopeGrantCandidates(input: unknown): Promise<string[]> {
    await this.initialized;
    const request = ScopeGrantCandidatesRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.conversationCandidates(request.userId, request.membershipIncarnation);
  }

  /**
   * The Channels where this person may be able to read some conversation
   * without reaching the Channel through the member directory: an explicit
   * scope grant, or membership of one of its breakouts. Discovery only; every
   * Channel named here decides for itself which conversations it releases.
   */
  private conversationCandidates(userId: string, membershipIncarnation: string): string[] {
    return [...new Set(scopeGrantCandidates(this.state.storage, userId, membershipIncarnation))].sort();
  }

  /**
   * Member attention for the Organization badge and the push badge count.
   *
   * It summarized the Thread directory (`channels`, `channel_viewers`), which
   * no writer has reached since the Thread retirement (plan step C-7): what it
   * counted was frozen state from conversations nobody can open, so a retired
   * Thread's unread would hold the badge up forever. A Canvas's and a
   * Sidekick's unread state is read on their own sidebar rows and is not
   * summarized here yet, so the answer is "nothing waiting".
   */
  async attention(input: WorkspaceAttentionRequest): Promise<WorkspaceAttentionResult> {
    await this.initialized;
    const request = WorkspaceAttentionRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return WorkspaceAttentionSchema.parse({
      waitingForYou: 0,
      waitingReason: null,
      hasUnreadActivity: false,
      readerAttentionCount: 0,
    });
  }

  /**
   * The title to show as a generated work stream's origin label.
   *
   * The Channel's main conversation renders the summary and does not hold the automation's
   * directory row. It used to read it as SQL through the workspace runtime
   * facade, which routes by table name and sends an unrecognised one to the
   * regional database — which is how this read came to answer
   * `no such table: automation_directory` on every attempt to open an
   * automation's run work stream.
   *
   * A deleted automation answers `null` rather than its last title: the work
   * stream outlives the automation that made it, and the label should go quiet
   * rather than name something the workspace no longer has.
   */
  /**
   * Admit one realtime dictation socket: sweep, spend the ticket, take a slot.
   *
   * The service used to send these as separate statements through the
   * workspace runtime facade — three round trips, and three critical sections
   * rather than one. Here it is a single decision, and the concurrency caps
   * live beside the insert that enforces them rather than travelling from a
   * caller that could pass a larger number.
   *
   * A refusal comes back as an outcome rather than a throw: a replayed ticket
   * and a workspace at its cap are ordinary answers, and the sentence the
   * person reads is the service's to choose.
   */
  /**
   * Re-derive the alarm after a typed method moved an outbox due time.
   *
   * `executeRuntimeSql` does this for any facade statement that writes an
   * alarm-source table; a typed method that writes `note_privacy_change_outbox`
   * or `note_resource_deletion_outbox` owes the alarm the same refresh, or the
   * pass those rows are due for never wakes.
   */
  private refreshScheduleAfterWrite(workspaceId: string): void {
    this.state.waitUntil(this.refreshScheduleKinds(workspaceId, ["maintenance"]).catch((error: unknown) => {
      // Swallowed silently, a failed refresh here leaves a schedule dark until
      // something else reconciles; this line is how anyone finds out the
      // alarm's own end-of-drain backstop was needed.
      logWarn(this.env, "workspace_schedule_auto_refresh_failed", {
        workspace_id: workspaceId,
        code: error instanceof Error ? error.message : "unknown_error",
      });
    }));
  }

  /** Operator-only RPC, including closed workspaces; no product route exposes it. */
  async purgeMeetingNoteObjects(resourceId?: string) {
    await this.initialized;
    const workspaceId = this.workspaceId();
    if (!workspaceId) throw new Error("workspace_object_identity_missing");
    return purgeRetiredMeetingObjects(this.state.storage, this.env.PAYLOADS, this.env.AVALON_REGION, workspaceId, resourceId === undefined ? undefined : IdSchema.parse(resourceId));
  }

  /** Delete only decisions whose canonical resource has verified meeting provenance. */
  async purgeMeetingSearchAuthorization() {
    await this.initialized;
    const sql = this.state.storage.sql;
    const keys = sql.exec<{ cache_key: string }>(`SELECT cache_key FROM search_authorization_keys
      WHERE resource_id IN (SELECT resource_id FROM retired_meeting_resources)`).toArray();
    for (const { cache_key: key } of keys) {
      // The retirement check rejects new registrations and publications. Drain an
      // already admitted KV write before deleting its external copy.
      await this.searchPublications.get(key)?.catch(() => {});
      if (this.env.AUTHORIZATION_CACHE) await this.env.AUTHORIZATION_CACHE.delete(key);
      this.state.storage.transactionSync(() => {
        sql.exec('DELETE FROM search_authorization_dependencies WHERE cache_key = ?', key);
        sql.exec('DELETE FROM authorization_snapshots WHERE cache_key = ?', key);
        sql.exec('DELETE FROM search_authorization_keys WHERE cache_key = ?', key);
      });
    }
    sql.exec(`DELETE FROM search_authorization_push WHERE kind = 'resource'
      AND target_id IN (SELECT resource_id FROM retired_meeting_resources)`);
    return { deletedKeys: keys.length };
  }

  /** Operator calls after verifying external cleanup; pending cleanup is an error. */
  async finalizeMeetingRetirement() {
    await this.initialized;
    await this.applyMigrations(() => applyDurableObjectSqliteMigrations({
      storage: this.state.storage,
      migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
      component: MIGRATION_COMPONENT,
      workerVersionId: this.env.APP_VERSION ?? "unknown",
    }));
    this.detectUnheardLedger();
    return { schemaVersion: 58 };
  }

  private isRetiredMeetingResource(resource: z.infer<typeof AuthorizationResourceSchema>): boolean {
    return resource.kind === 'resource' && this.state.storage.sql.exec(
      'SELECT 1 FROM retired_meeting_resources WHERE resource_id = ?', resource.resourceId).toArray().length > 0;
  }

  async retiredMeetingInventory() {
    await this.initialized;
    const sql = this.state.storage.sql;
    const tables = sql.exec<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table'").toArray();
    const references: Array<{ table: string; count: number }> = [];
    for (const { name } of tables) {
      // Cloudflare's hidden KV tables are not accessible through SQL.
      if (name === 'retired_meeting_resources' || /^(?:_+cf_|sqlite_)/.test(name)) continue;
      const quoted = '"' + name.replaceAll('"', '""') + '"';
      if (!sql.exec<{ name: string }>(`PRAGMA table_info(${quoted})`).toArray().some(column => column.name === 'resource_id')) continue;
      const count = sql.exec<{ count: number }>(`SELECT COUNT(*) AS count FROM ${quoted} WHERE resource_id IN (SELECT resource_id FROM retired_meeting_resources)`).one().count;
      if (count) references.push({ table: name, count });
    }
    return {
      workspaceId: this.workspaceId(),
      schemaVersion: sql.exec<{ version: number }>('SELECT MAX(version) AS version FROM _sql_schema_migrations').one().version,
      featureTables: tables.map(row => row.name).filter(name => ['notes', 'note_transcript_segments', 'note_privacy_change_outbox', 'note_resource_deletion_outbox', 'workspace_batch_dispatch_note_targets'].includes(name)),
      references,
      resources: sql.exec<{
        resource_id: string; note_id: string | null; objects_deleted: number;
      }>('SELECT resource_id, note_id, objects_deleted FROM retired_meeting_resources ORDER BY resource_id').toArray(),
    };
  }

  async createConnectorInstallation(input: InstallationCreate) {
    await this.initialized; const request = InstallationCreateSchema.parse(input);
    this.assertWorkspace(request.installation.workspaceId);
    return createInstallation(this.state.storage, request);
  }
  async connectorInstallation(input: { workspaceId: string; connectionId: string }) {
    await this.initialized; const request = InstallationReadSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return readInstallation(this.state.storage, request.connectionId);
  }
  /** One hop for the connections list, which asks about every disabled row at once. */
  async connectorInstallations(input: InstallationBatchRead) {
    await this.initialized; const request = parseRpcInput(InstallationBatchReadSchema, input, "connector_installations_read");
    this.assertWorkspace(request.workspaceId);
    return readInstallations(this.state.storage, request.connectionIds);
  }
  async claimConnectorInstallationStep(input: InstallationClaim) {
    await this.initialized; const request = InstallationClaimSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return claimInstallation(this.state.storage, request);
  }
  async settleConnectorInstallationStep(input: InstallationSettle) {
    await this.initialized; const request = InstallationSettleSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return settleInstallation(this.state.storage, request);
  }
  async replaceConnectorInstallationCredentials(input: InstallationCredentialReplace) {
    await this.initialized;
    const request = InstallationCredentialReplaceSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return replaceInstallationCredentials(this.state.storage, request);
  }
  async prepareConnectorInstallationMaintenance(input: InstallationMaintenance) {
    await this.initialized;
    const request = InstallationMaintenanceSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return prepareInstallationMaintenance(this.state.storage, request);
  }
  async cancelConnectorInstallationMaintenance(input: InstallationMaintenanceCancel) {
    await this.initialized;
    const request = InstallationMaintenanceCancelSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return cancelInstallationMaintenance(this.state.storage, request);
  }
  async prepareConnectorInstallationRotation(input: InstallationRotationPrepare) {
    await this.initialized;
    const request = InstallationRotationPrepareSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return prepareInstallationRotation(this.state.storage, request);
  }

  async receiveConnectorInstallationEvent(input: InstallationDelivery) {
    await this.initialized;
    const request = InstallationDeliverySchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return recordInstallationDelivery(this.state.storage, request);
  }

  async connectorInstallationCleanup(input: InstallationClaim) {
    await this.initialized; const request = InstallationClaimSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const installation = readInstallation(this.state.storage, request.connectionId);
    const registration = installation?.registrations.find((item) => item.stepId === request.stepId);
    if (!installation || installation.generation !== request.generation || registration?.action !== "remove"
      || registration.state !== "dispatched" || !registration.providerId || !registration.providerIdVerified) throw new Error("connector_cleanup_not_authorized");
    const row = this.state.storage.sql.exec<{ cleanup_ciphertext: string | null; cleanup_iv: string | null; cleanup_key_version: number | null; granted_scopes_json: string; config_json: string }>(
      `SELECT i.cleanup_ciphertext, i.cleanup_iv, i.cleanup_key_version, c.granted_scopes_json, c.config_json
       FROM connector_installations i JOIN connector_connections c ON c.id = i.connection_id
       WHERE i.connection_id = ? AND c.status = 'disabled'`, request.connectionId).toArray()[0];
    if (!row?.cleanup_ciphertext || !row.cleanup_iv) throw new Error("connector_cleanup_credential_unavailable");
    return { providerId: registration.providerId, encrypted_credentials: row.cleanup_ciphertext,
      credential_iv: row.cleanup_iv, credential_key_version: row.cleanup_key_version,
      grantedScopes: z.array(z.string()).parse(JSON.parse(row.granted_scopes_json)) };
  }

  async changeConnectorInstallation(input: InstallationChange) {
    await this.initialized; const request = InstallationChangeSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return changeInstallation(this.state.storage, request);
  }

  /** Record a started connector OAuth handoff, pending until settled. */
  async startConnectorOAuthAttempt(
    input: WorkspaceConnectorOAuthAttemptStartRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceConnectorOAuthAttemptStartRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    startWorkspaceConnectorOAuthAttempt(this.state.storage, request);
  }

  /** Delete a pending start whose regional state receipt failed to write. */
  async abandonConnectorOAuthAttempt(
    input: WorkspaceConnectorOAuthAttemptAbandonRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceConnectorOAuthAttemptAbandonRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    abandonWorkspaceConnectorOAuthAttempt(this.state.storage, request);
  }

  /** Revive an attempt for GitHub's install-then-authorize second leg. */
  async extendConnectorOAuthAttempt(
    input: WorkspaceConnectorOAuthAttemptExtendRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceConnectorOAuthAttemptExtendRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    extendWorkspaceConnectorOAuthAttempt(this.state.storage, request);
  }

  /**
   * One attempt, optionally settling a due expiry in the same transaction.
   *
   * Through the facade the expiry sweep and the read were two round trips;
   * asked here they are one critical section, and a member-scoped request
   * cannot expire or observe another member's attempt.
   */
  async connectorOAuthAttempt(
    input: WorkspaceConnectorOAuthAttemptReadRequest,
  ): Promise<WorkspaceConnectorOAuthAttemptReadResult> {
    await this.initialized;
    const request = WorkspaceConnectorOAuthAttemptReadRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return readWorkspaceConnectorOAuthAttempt(this.state.storage, request);
  }

  /**
   * Settle an attempt on a returned witness, or report how it already ended.
   *
   * A replayed callback converges rather than erring; a genuinely different
   * settlement answers `conflict` as an outcome, keeping the service's 409 and
   * its sentence rather than losing both to a thrown RPC error.
   */
  async finishConnectorOAuthAttempt(
    input: WorkspaceConnectorOAuthAttemptFinishRequest,
  ): Promise<WorkspaceConnectorOAuthAttemptFinishResult> {
    await this.initialized;
    const request = WorkspaceConnectorOAuthAttemptFinishRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return finishWorkspaceConnectorOAuthAttempt(this.state.storage, request);
  }

  /** Attach the client's telemetry operation to an attempt, first writer wins. */
  async bindConnectorOAuthAttemptTelemetry(
    input: WorkspaceConnectorOAuthAttemptTelemetryBindRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceConnectorOAuthAttemptTelemetryBindRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    bindWorkspaceConnectorOAuthAttemptTelemetry(this.state.storage, request);
  }

  /**
   * Claim one webhook delivery and sweep the connection's expired receipts.
   *
   * The duplicate branch is decided by the insert's returned witness rather
   * than by the facade's physical `rowsWritten` counter, and the sweep —
   * which the granola path never had, so its receipts grew without bound —
   * runs in the same transaction as the claim it makes room for.
   */
  async claimWebhookReceipt(
    input: WorkspaceWebhookReceiptClaimRequest,
  ): Promise<WorkspaceWebhookReceiptClaimResult> {
    await this.initialized;
    const request = WorkspaceWebhookReceiptClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return claimWorkspaceWebhookReceipt(this.state.storage, request);
  }

  /** The Terminal network policy and its domains, creating the default if absent. */
  async terminalNetworkSettings(
    input: WorkspaceTerminalNetworkSettingsRequest,
  ): Promise<WorkspaceTerminalNetworkSettings> {
    await this.initialized;
    const request = WorkspaceTerminalNetworkSettingsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceTerminalNetworkSettings(this.state.storage, request);
  }

  /** The Terminal egress mode alone, for the agent path; writes nothing. */
  async terminalNetworkMode(
    input: { workspaceId: string },
  ): Promise<WorkspaceTerminalNetworkMode> {
    await this.initialized;
    const workspaceId = IdSchema.parse(input.workspaceId);
    this.assertWorkspace(workspaceId);
    return workspaceTerminalNetworkMode(this.state.storage, workspaceId);
  }

  /** Record a previewed policy change so confirming it can be checked against it. */
  async recordTerminalPolicyPreview(
    input: WorkspaceTerminalPolicyPreviewRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceTerminalPolicyPreviewRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    recordWorkspaceTerminalPolicyPreview(this.state.storage, request);
  }

  /**
   * Take the policy and its preview together, or take neither.
   *
   * The service used to claim them as two conditional updates over the runtime
   * facade, and carried a compensating restore for the window where the first
   * succeeded and the second did not. One transaction has no such window.
   */
  async claimTerminalPolicyApplication(
    input: WorkspaceTerminalPolicyClaimRequest,
  ): Promise<WorkspaceTerminalPolicyClaimResult> {
    await this.initialized;
    const request = WorkspaceTerminalPolicyClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return claimWorkspaceTerminalPolicyApplication(this.state.storage, request);
  }

  /**
   * Release a claim with a reason, keeping the last verified policy.
   *
   * Answers `stale` when the named application is no longer the pending one,
   * rather than releasing whichever claim happens to hold the revision.
   */
  async failTerminalPolicyApplication(
    input: WorkspaceTerminalPolicyFailRequest,
  ): Promise<WorkspaceTerminalPolicySettlementResult> {
    await this.initialized;
    const request = WorkspaceTerminalPolicyFailRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return failWorkspaceTerminalPolicyApplication(this.state.storage, request);
  }

  /**
   * Publish the applied policy: domains, the new revision, and the ledger.
   *
   * Answers `stale` for a replayed commit, having written nothing.
   */
  async commitTerminalPolicyApplication(
    input: WorkspaceTerminalPolicyCommitRequest,
  ): Promise<WorkspaceTerminalPolicySettlementResult> {
    await this.initialized;
    const request = WorkspaceTerminalPolicyCommitRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return commitWorkspaceTerminalPolicyApplication(this.state.storage, request);
  }

  /**
   * Admit one realtime dictation socket: sweep, spend the ticket, take a slot.
   *
   * The service used to send these as separate statements through the
   * workspace runtime facade — three round trips, and three critical sections
   * rather than one. Here it is a single decision, and the concurrency caps
   * live beside the insert that enforces them rather than travelling from a
   * caller that could pass a larger number.
   *
   * A refusal comes back as an outcome rather than a throw: a replayed ticket
   * and a workspace at its cap are ordinary answers, and the sentence the
   * person reads is the service's to choose.
   */
  async admitTranscriptionSession(
    input: WorkspaceTranscriptionAdmitRequest,
  ): Promise<WorkspaceTranscriptionAdmitResult> {
    await this.initialized;
    const request = WorkspaceTranscriptionAdmitRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return admitWorkspaceTranscriptionSession(this.state.storage, request);
  }

  /** Give a dictation slot back when its socket closes. */
  async releaseTranscriptionSession(
    input: WorkspaceTranscriptionSessionRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceTranscriptionSessionRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    releaseWorkspaceTranscriptionSession(this.state.storage, request);
  }

  /** Extend a live dictation lease, and say so when there was nothing to extend. */
  async renewTranscriptionSession(
    input: WorkspaceTranscriptionRenewRequest,
  ): Promise<WorkspaceTranscriptionRenewResult> {
    await this.initialized;
    const request = WorkspaceTranscriptionRenewRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return renewWorkspaceTranscriptionSession(this.state.storage, request);
  }

  /** The named resources, in the columns the cross-authority readers consume. */
  async resourceDescriptors(
    input: WorkspaceResourceDescriptorsRequest,
  ): Promise<WorkspaceResourceDescriptorList> {
    await this.initialized;
    const request = WorkspaceResourceDescriptorsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceResourceDescriptors(this.state.storage, request);
  }

  /** Whether any resource — draft or attached — already holds this id. */
  async resourceExists(
    input: WorkspaceResourceExistsRequest,
  ): Promise<WorkspaceResourceExistsResult> {
    await this.initialized;
    const request = WorkspaceResourceExistsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceResourceExists(this.state.storage, request.workspaceId, request.resourceId);
  }

  /**
   * Commit an upload draft and adopt its staged object, or write neither.
   *
   * A duplicate draft id is an outcome rather than a primary-key throw: the
   * separate existence check the service ran first could lose a race to a
   * concurrent upload of the same id, and the loser surfaced as a 500.
   */
  async createUploadDraftResource(
    input: WorkspaceUploadDraftCreateRequest,
  ): Promise<WorkspaceUploadDraftCreateResult> {
    await this.initialized;
    const request = WorkspaceUploadDraftCreateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return createWorkspaceUploadDraft(this.state.storage, request);
  }

  /** Delete an unsent, unreserved draft the caller uploaded, or say it is gone. */
  async deleteUploadDraftResource(
    input: WorkspaceUploadDraftDeleteRequest,
  ): Promise<WorkspaceUploadDraftDeleteResult> {
    await this.initialized;
    const request = WorkspaceUploadDraftDeleteRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return deleteWorkspaceUploadDraft(this.state.storage, request);
  }

  /**
   * The canonical row for a connector resource, created if absent.
   *
   * One critical section instead of the read, insert-or-ignore and re-read
   * round trips the service used to make through the runtime facade.
   */
  async resolveConnectorResource(
    input: WorkspaceConnectorResourceResolveRequest,
  ): Promise<WorkspaceConnectorResourceResolveResult> {
    await this.initialized;
    const request = WorkspaceConnectorResourceResolveRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return resolveWorkspaceConnectorResource(this.state.storage, request);
  }

  /** The resource's version history, newest first — or one version of it. */
  async listResourceVersions(
    input: WorkspaceResourceVersionListRequest,
  ): Promise<WorkspaceResourceVersionList> {
    await this.initialized;
    const request = WorkspaceResourceVersionListRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return listWorkspaceResourceVersions(this.state.storage, request);
  }

  /**
   * Rename a resource as a person. Its pinners' open windows get their pin
   * list again, since a pinned artifact's row shows its title; the thread that
   * asked tells its own room.
   */
  async renameResource(input: WorkspaceResourceRenameRequest): Promise<WorkspaceResourceRenameResult> {
    await this.initialized;
    const request = WorkspaceResourceRenameRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = renameWorkspaceResource(this.state.storage, request);
    return result;
  }

  /** Record a re-fetch that produced the content the row already holds. */
  async refreshResourceHydration(
    input: WorkspaceResourceHydrationRefreshRequest,
  ): Promise<WorkspaceResourceHydrationResult> {
    await this.initialized;
    const request = WorkspaceResourceHydrationRefreshRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return refreshWorkspaceResourceHydration(this.state.storage, request);
  }

  /**
   * Swap in newly hydrated content, fenced on the content the caller read.
   *
   * `updated: false` means the fence refused the write — a concurrent
   * hydration moved the row — and the caller releases the object it staged.
   */
  async publishResourceHydration(
    input: WorkspaceResourceHydrationPublishRequest,
  ): Promise<WorkspaceResourceHydrationResult> {
    await this.initialized;
    const request = WorkspaceResourceHydrationPublishRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return publishWorkspaceResourceHydration(this.state.storage, request);
  }

  /** Enable — or re-enable, keeping the row's identity — one attachment watch. */
  async enableResourceWatch(input: WorkspaceResourceWatchEnableRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceResourceWatchEnableRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    enableWorkspaceResourceWatch(this.state.storage, request);
  }

  /** Pause a watch, keeping its cursor for a later re-enable. */
  async disableResourceWatch(input: WorkspaceResourceWatchDisableRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceResourceWatchDisableRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    disableWorkspaceResourceWatch(this.state.storage, request);
  }

  /** Outbox rows the object-deletion reaper should look at, one bounded batch. */
  async listReapableResourceObjects(
    input: WorkspaceReapableResourceObjectListRequest,
  ): Promise<WorkspaceReapableResourceObjectList> {
    await this.initialized;
    const request = WorkspaceReapableResourceObjectListRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return listWorkspaceReapableResourceObjects(this.state.storage, request.workspaceId);
  }

  /**
   * Decide what one outbox row wants from the reaper, in one critical section.
   *
   * The reference check and the retirement used to be two round trips guarded
   * by re-stating the check inside the delete; one transaction has no window
   * for a deletion to promote the row between them.
   */
  async claimResourceObjectRemoval(
    input: WorkspaceResourceObjectRefRequest,
  ): Promise<WorkspaceResourceObjectRemovalResult> {
    await this.initialized;
    const request = WorkspaceResourceObjectRefRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return claimWorkspaceResourceObjectRemoval(
      this.state.storage,
      request.workspaceId,
      request.objectRef,
    );
  }

  /** Retire one staging row after its bytes were deleted from R2. */
  async retireResourceObjectStaging(
    input: WorkspaceResourceObjectRefRequest,
  ): Promise<WorkspaceResourceObjectRetireResult> {
    await this.initialized;
    const request = WorkspaceResourceObjectRefRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return retireWorkspaceResourceObjectStaging(
      this.state.storage,
      request.workspaceId,
      request.objectRef,
    );
  }

  /** Count a failed R2 delete against its outbox row. */
  async recordResourceObjectCleanupFailure(
    input: WorkspaceResourceObjectFailureRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceResourceObjectFailureRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    recordWorkspaceResourceObjectCleanupFailure(this.state.storage, request);
  }

  /**
   * Remove expired, unattached, unreserved upload drafts — the staleness
   * check and the delete as one statement, so a draft attached between a read
   * and a write cannot be lost.
   */
  async reapExpiredDraftResources(
    input: WorkspaceExpiredDraftReapRequest,
  ): Promise<WorkspaceExpiredDraftReapResult> {
    await this.initialized;
    const request = WorkspaceExpiredDraftReapRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return reapWorkspaceExpiredDraftResources(this.state.storage, request.workspaceId);
  }

  /** Give the resource the candidate alias, or say exactly why not. */
  async claimResourceSlug(
    input: WorkspaceResourceSlugClaimRequest,
  ): Promise<WorkspaceResourceSlugClaimResult> {
    await this.initialized;
    const request = WorkspaceResourceSlugClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return claimWorkspaceResourceSlug(this.state.storage, request);
  }

  /** Resources still waiting for an alias, oldest first, one bounded batch. */
  async listResourcesAwaitingSlug(
    input: WorkspaceResourceSlugBacklogRequest,
  ): Promise<WorkspaceResourceSlugBacklog> {
    await this.initialized;
    const request = WorkspaceResourceSlugBacklogRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return listWorkspaceResourcesAwaitingSlug(this.state.storage, request.workspaceId);
  }

  /**
   * The resource for one inbound email, created or refreshed in one critical
   * section — a fresh insert deliberately skips the follow-up refresh, which
   * used to fire the semantic-version trigger and record a phantom second
   * version of every newly ingested email.
   */
  async upsertInboundEmailResource(
    input: WorkspaceInboundEmailResourceRequest,
  ): Promise<WorkspaceInboundEmailResourceResult> {
    await this.initialized;
    const request = WorkspaceInboundEmailResourceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return upsertWorkspaceInboundEmailResource(this.state.storage, request);
  }

  /** Register the resources a provider webhook mentioned for one connection. */
  async upsertDiscoveredResources(
    input: WorkspaceDiscoveredResourcesRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceDiscoveredResourcesRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    upsertWorkspaceDiscoveredResources(this.state.storage, request);
  }

  /**
   * Admit one Slack ingress job, or say what already stands under its id.
   *
   * A replay of the same delivery converges; Slack reusing an event identity
   * with different content is a conflict the caller refuses. The decision is
   * the row's own witness inside one transaction, never an affected-row count.
   */
  async enqueueSlackIngressJob(
    input: WorkspaceSlackIngressEnqueueRequest,
  ): Promise<WorkspaceSlackIngressEnqueueResult> {
    await this.initialized;
    const request = WorkspaceSlackIngressEnqueueRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = enqueueWorkspaceSlackIngressJob(this.state.storage, request);
    if (result.outcome === "queued") this.refreshScheduleAfterSlackWrite(request.workspaceId);
    return result;
  }

  /**
   * Claim one ingress job for processing under a lease this object mints.
   *
   * A job at the attempt ceiling is unavailable; a `processing` job whose
   * lease has expired is reclaimed, because its worker died before recording
   * an outcome. The lease fences the completion and failure settlements.
   */
  async claimSlackIngressJob(
    input: WorkspaceSlackIngressClaimRequest,
  ): Promise<WorkspaceSlackIngressClaimResult> {
    await this.initialized;
    const request = WorkspaceSlackIngressClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = claimWorkspaceSlackIngressJob(this.state.storage, request);
    if (result.outcome === "claimed") this.refreshScheduleAfterSlackWrite(request.workspaceId);
    return result;
  }

  /** Settle a claimed ingress job as done, clearing its stored payload. */
  async completeSlackIngressJob(
    input: WorkspaceSlackIngressCompleteRequest,
  ): Promise<WorkspaceSlackIngressSettleResult> {
    await this.initialized;
    const request = WorkspaceSlackIngressCompleteRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = completeWorkspaceSlackIngressJob(this.state.storage, request);
    if (result.outcome === "settled") this.refreshScheduleAfterSlackWrite(request.workspaceId);
    return result;
  }

  /**
   * Record a claimed job's failure and decide the exhaustion notice with it,
   * in one transaction, so concurrent exhaustions produce one first report.
   */
  async failSlackIngressJob(
    input: WorkspaceSlackIngressFailRequest,
  ): Promise<WorkspaceSlackIngressFailResult> {
    await this.initialized;
    const request = WorkspaceSlackIngressFailRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = failWorkspaceSlackIngressJob(this.state.storage, request);
    if (result.outcome === "failed") this.refreshScheduleAfterSlackWrite(request.workspaceId);
    return result;
  }

  /** The ingress jobs whose payload survives and whose processing went quiet. */
  async recoverableSlackIngressJobs(
    input: WorkspaceSlackIngressRecoverableRequest,
  ): Promise<WorkspaceSlackIngressRecoverableResult> {
    await this.initialized;
    const request = WorkspaceSlackIngressRecoverableRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return recoverableWorkspaceSlackIngressJobs(this.state.storage, request);
  }

  /**
   * One maintenance pass over the Slack ingress spine, returning the standing
   * exhausted report the pass leaves behind. The workspace alarm's
   * `slack_ingress` arm counts with the same predicates these reaps apply.
   */
  async sweepSlackIngress(
    input: WorkspaceSlackIngressSweepRequest,
  ): Promise<WorkspaceSlackIngressSweepResult> {
    await this.initialized;
    const request = WorkspaceSlackIngressSweepRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    // Deliberately no `refreshScheduleAfterSlackWrite`. This method has one
    // caller, `SlackAgentService.maintainIngress`, reached only as the
    // `slack_ingress` maintenance target — always inside this object's own
    // alarm drain, whose statements go through the local executor rather than
    // `executeRuntimeSql` and so never carried that auto-refresh. Adding it
    // here would start a `waitUntil` reconcile from a target list read
    // mid-drain and let it land after `schedule_reconcile` has written the
    // correct one, which is exactly what the comment on that end-of-drain
    // refresh exists to prevent. The drain reconciles; this pass does not.
    return sweepWorkspaceSlackIngress(this.state.storage, request);
  }

  /**
   * Whether a bare Slack thread reply belongs to Rally: an existing agent
   * session, or this member's live pending prompt awaiting `try again`.
   */
  async slackThreadRoutable(
    input: WorkspaceSlackThreadRoutableRequest,
  ): Promise<WorkspaceSlackThreadRoutableResult> {
    await this.initialized;
    const request = WorkspaceSlackThreadRoutableRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceSlackThreadRoutable(this.state.storage, request);
  }

  /** The prompt this Slack member is still owed a retry of, if unexpired. */
  async pendingSlackPrompt(
    input: WorkspaceSlackPendingPromptRequest,
  ): Promise<WorkspaceSlackPendingPromptResult> {
    await this.initialized;
    const request = WorkspaceSlackPendingPromptRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceSlackPendingPrompt(this.state.storage, request);
  }

  /** Retain a denied prompt so `try again` can replay it once the cause is fixed. */
  async rememberSlackPendingPrompt(
    input: WorkspaceSlackPendingPromptStoreRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceSlackPendingPromptStoreRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    rememberWorkspaceSlackPendingPrompt(this.state.storage, request);
    this.refreshScheduleAfterSlackWrite(request.workspaceId);
  }

  /** Drop a retained prompt: the request it held has been taken or superseded. */
  async clearSlackPendingPrompt(
    input: WorkspaceSlackPendingPromptClearRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceSlackPendingPromptClearRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    clearWorkspaceSlackPendingPrompt(this.state.storage, request);
    this.refreshScheduleAfterSlackWrite(request.workspaceId);
  }

  /**
   * Take the right to initialize one Slack thread's session, under a lease
   * this object mints; a live claim by anyone else answers `held`.
   */
  async claimSlackThread(
    input: WorkspaceSlackThreadClaimRequest,
  ): Promise<WorkspaceSlackThreadClaimResult> {
    await this.initialized;
    const request = WorkspaceSlackThreadClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = claimWorkspaceSlackThread(this.state.storage, request);
    if (result.outcome === "claimed") this.refreshScheduleAfterSlackWrite(request.workspaceId);
    return result;
  }

  /** Give a thread-initialization claim back, if it is still the caller's. */
  async releaseSlackThreadClaim(
    input: WorkspaceSlackThreadReleaseRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceSlackThreadReleaseRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    releaseWorkspaceSlackThreadClaim(this.state.storage, request);
    this.refreshScheduleAfterSlackWrite(request.workspaceId);
  }

  /**
   * The Slack agent-session lifecycle.
   *
   * None of `slack_agent_sessions`, `slack_agent_contexts`, or
   * `slack_agent_feedback` is an alarm source — no schedule target derives a
   * due time from them — so these mutations deliberately do **not** call
   * `refreshScheduleAfterSlackWrite`. That is the one thing to re-check before
   * adding a method here: a table that gains an alarm target needs the refresh
   * back, and its absence is a decision rather than an omission.
   */
  async slackSessionById(
    input: WorkspaceSlackSessionByIdRequest,
  ): Promise<WorkspaceSlackSessionResult> {
    await this.initialized;
    const request = WorkspaceSlackSessionByIdRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceSlackSessionById(this.state.storage, request);
  }

  /** The session a Slack thread already has, if this thread is one Rally runs. */
  async slackSessionByThread(
    input: WorkspaceSlackSessionByThreadRequest,
  ): Promise<WorkspaceSlackSessionResult> {
    await this.initialized;
    const request = WorkspaceSlackSessionByThreadRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceSlackSessionByThread(this.state.storage, request);
  }

  /** The session behind a work stream, for delivering that run's outcome. */
  async slackSessionByWorkstream(
    input: WorkspaceSlackSessionByWorkstreamRequest,
  ): Promise<WorkspaceSlackSessionResult> {
    await this.initialized;
    const request = WorkspaceSlackSessionByWorkstreamRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceSlackSessionByWorkstream(this.state.storage, request);
  }

  /** The interaction preflight: has this work stream already been seated here? */
  async slackSessionExists(
    input: WorkspaceSlackSessionExistsRequest,
  ): Promise<WorkspaceSlackSessionExistsResult> {
    await this.initialized;
    const request = WorkspaceSlackSessionExistsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceSlackSessionExists(this.state.storage, request);
  }

  /** Store a new thread's session and answer with the row that was stored. */
  async createSlackSession(
    input: WorkspaceSlackSessionCreateRequest,
  ): Promise<WorkspaceSlackSessionResult> {
    await this.initialized;
    const request = WorkspaceSlackSessionCreateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return createWorkspaceSlackSession(this.state.storage, request);
  }

  /** Seat a member across this Slack user's workspace-scoped sessions. */
  async assignSlackSessions(
    input: WorkspaceSlackSessionAssignRequest,
  ): Promise<WorkspaceSlackSessionAssignResult> {
    await this.initialized;
    const request = WorkspaceSlackSessionAssignRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return assignWorkspaceSlackSessions(this.state.storage, request);
  }

  /** Stamp the delivery key a run's outcome was delivered under. */
  async setSlackSessionDeliveryKey(
    input: WorkspaceSlackSessionDeliveryKeyRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceSlackSessionDeliveryKeyRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    setWorkspaceSlackSessionDeliveryKey(this.state.storage, request);
  }

  /** Clear a response-stream pointer left by a pre-saved-turn-only deployment. */
  async setSlackSessionStream(
    input: WorkspaceSlackSessionStreamRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceSlackSessionStreamRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    setWorkspaceSlackSessionStream(this.state.storage, request);
  }

  /**
   * Settle the status reaction against the anchor the caller acted on and the
   * emoji it removed.
   *
   * Answers `raced` when another transition moved `reaction_current`, or a
   * follow-up moved the anchor, while the caller was talking to Slack. The
   * decision comes from the `RETURNING` witness, not a row count.
   */
  async settleSlackSessionReaction(
    input: WorkspaceSlackSessionReactionRequest,
  ): Promise<WorkspaceSlackSessionReactionResult> {
    await this.initialized;
    const request = WorkspaceSlackSessionReactionRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return settleWorkspaceSlackSessionReaction(this.state.storage, request);
  }

  /** Point the status reaction at the newest prompt's message. */
  async anchorSlackSessionReaction(
    input: WorkspaceSlackSessionReactionAnchorRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceSlackSessionReactionAnchorRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    anchorWorkspaceSlackSessionReaction(this.state.storage, request);
  }

  /** The App Home context Rally keeps for one Slack user on one connection. */
  async slackAppContext(
    input: WorkspaceSlackContextRequest,
  ): Promise<WorkspaceSlackContextResult> {
    await this.initialized;
    const request = WorkspaceSlackContextRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceSlackContext(this.state.storage, request);
  }

  /** Replace that context wholesale. */
  async storeSlackAppContext(
    input: WorkspaceSlackContextStoreRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceSlackContextStoreRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    storeWorkspaceSlackContext(this.state.storage, request);
  }

  /** Record one feedback submission, or report that its job already had one. */
  async recordSlackFeedback(
    input: WorkspaceSlackFeedbackRequest,
  ): Promise<WorkspaceSlackFeedbackResult> {
    await this.initialized;
    const request = WorkspaceSlackFeedbackRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return recordWorkspaceSlackFeedback(this.state.storage, request);
  }

  private externalBindings(): ExternalConversationBindingStorage {
    return new ExternalConversationBindingStorage(this.state.storage);
  }

  /**
   * Resolve one verified external message's path, in one read: deliver to a
   * bound conversation, hold behind a creation in flight, stop at a suspended
   * binding, or do nothing. See
   * `docs/external-conversation-bindings.md`.
   */
  async resolveExternalConversation(input: unknown): Promise<ExternalBindingResolution> {
    await this.initialized;
    const request = parseRpcInput(ExternalBindingResolveRequestSchema, input, "resolve_external_conversation");
    this.assertWorkspace(request.workspaceId);
    const resolution = this.externalBindings().resolve(request);
    return ExternalBindingResolutionSchema.parse(resolution);
  }

  /** One binding by its key, whatever its state. */
  async externalConversationBinding(input: unknown) {
    await this.initialized;
    const request = parseRpcInput(ExternalBindingReadRequestSchema, input, "external_conversation_binding");
    this.assertWorkspace(request.workspaceId);
    return ExternalBindingReadResultSchema.parse({
      binding: this.externalBindings().read(request.installationId, request.path),
    });
  }

  /** A creation finished: its pending thread binding becomes the thread's route. */
  async activateExternalConversationBinding(input: unknown) {
    await this.initialized;
    const request = parseRpcInput(ExternalBindingSettleRequestSchema, input, "activate_external_conversation_binding");
    this.assertWorkspace(request.workspaceId);
    return ExternalBindingActivateResultSchema.parse({
      outcome: this.externalBindings().activate(request.installationId, request.path, request.target, request.at),
    });
  }

  /** A creation failed: its pending claim goes, and nothing names the absent Channel. */
  async releaseExternalConversationBinding(input: unknown) {
    await this.initialized;
    const request = parseRpcInput(ExternalBindingSettleRequestSchema, input, "release_external_conversation_binding");
    this.assertWorkspace(request.workspaceId);
    return ExternalBindingReleaseResultSchema.parse({
      outcome: this.externalBindings().release(request.installationId, request.path, request.target)
        ? "released"
        : "absent",
    });
  }

  /**
   * Bind the reply thread of a message a Sidekick run sent to that run's child.
   * Delivered from the child's outbox, where it was committed with the tool
   * receipt; a redelivery is `already_bound`.
   */
  async recordOutboundExternalConversationBinding(input: unknown) {
    await this.initialized;
    const request = parseRpcInput(ExternalBindingOutboundRequestSchema, input, "record_outbound_external_conversation_binding");
    this.assertWorkspace(request.workspaceId);
    const outcome = this.externalBindings().recordOutbound(
      request.installationId, request.path, request.target, request.at,
    );
    if (outcome === "conflict") {
      logWarn(this.env, "external_binding_outbound_conflict", {
        workspace_id: request.workspaceId,
        installation_id: request.installationId,
        parent_kind: request.target.parentKind,
        parent_id: request.target.parentId,
        substream_id: request.target.substreamId,
      });
    }
    return ExternalBindingOutboundResultSchema.parse({ outcome });
  }

  /** The most recent active outbound binding under a room, for the one-to-one DM policy. */
  async latestOutboundExternalConversation(input: unknown) {
    await this.initialized;
    const request = parseRpcInput(ExternalBindingLatestOutboundRequestSchema, input, "latest_outbound_external_conversation");
    this.assertWorkspace(request.workspaceId);
    return ExternalBindingLatestOutboundResultSchema.parse({
      latest: this.externalBindings().latestOutboundUnder(request.installationId, request.prefix),
    });
  }

  /**
   * Suspend one binding (the bot left the room, the room was archived), or
   * every active binding of an installation (it disconnected). Rows and
   * targets stay, so a re-invitation or a reconnect brings them back.
   */
  async suspendExternalConversationBindings(input: unknown) {
    await this.initialized;
    const request = parseRpcInput(ExternalBindingSuspendRequestSchema, input, "suspend_external_conversation_bindings");
    this.assertWorkspace(request.workspaceId);
    return ExternalBindingSuspendResultSchema.parse({ suspended: this.externalBindings().suspend(request) });
  }

  /** Bring back the bindings a disconnect suspended, and only those. */
  async reactivateExternalConversationBindings(input: unknown) {
    await this.initialized;
    const request = parseRpcInput(ExternalBindingReactivateRequestSchema, input, "reactivate_external_conversation_bindings");
    this.assertWorkspace(request.workspaceId);
    return ExternalBindingSuspendResultSchema.parse({
      suspended: this.externalBindings().reactivate(request.installationId, request.at, request.path),
    });
  }

  /** A provider room changed its identifier: move it and every path beneath it. */
  async moveExternalConversationBindings(input: unknown) {
    await this.initialized;
    const request = parseRpcInput(ExternalBindingMoveRequestSchema, input, "move_external_conversation_bindings");
    this.assertWorkspace(request.workspaceId);
    return ExternalBindingMoveResultSchema.parse(
      this.externalBindings().move(request.installationId, request.from, request.to, request.at),
    );
  }

  /**
   * Re-derive the workspace alarm after a typed write to an alarm-source
   * Slack table, exactly as `executeRuntimeSql` does for a generic statement
   * naming one — without it, a job admitted or a prompt retained through a
   * typed method would wait for an unrelated write to arm the alarm that
   * recovers or reaps it. Failures are logged and swallowed for the same
   * reason as there: the alarm's own end-of-drain refresh is the backstop.
   *
   * Callers gate this on an outcome that moved a row. `executeRuntimeSql` could
   * not: it keys on the table names in the SQL text and has no idea whether the
   * statement matched anything, so a losing claim or a stale settlement paid for
   * a full reconcile there. A typed method can see its own refusal, and a
   * refusal changed no due time. Read-only methods never call this at all, and
   * neither does `sweepSlackIngress` — see the comment on it for why.
   */
  private refreshScheduleAfterSlackWrite(workspaceId: string): void {
    this.state.waitUntil(this.refreshScheduleKinds(workspaceId, ["maintenance"]).catch((error: unknown) => {
      logWarn(this.env, "workspace_schedule_auto_refresh_failed", {
        workspace_id: workspaceId,
        code: error instanceof Error ? error.message : "unknown_error",
      });
    }));
  }

  /** Create a memory scope if it is missing; answer with the stored row either way. */
  async ensureMemoryScope(input: WorkspaceMemoryScopeEnsureRequest): Promise<WorkspaceMemoryScope> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceMemoryScopeEnsureRequestSchema, input, "ensure_memory_scope");
    this.assertWorkspace(request.workspaceId);
    return ensureWorkspaceMemoryScope(this.state.storage, request);
  }

  /**
   * The facts this reader may use from inside this conversation, best match
   * first. Visibility is decided here from the facts' sources and subjects;
   * see `workspace-memory-facts-storage.ts`.
   */
  async recallMemoryFacts(input: unknown): Promise<WorkspaceMemoryRecallResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceMemoryRecallRequestSchema, input, "recall_memory_facts");
    this.assertWorkspace(request.workspaceId);
    return recallMemoryFacts(this.state.storage, request, await this.memoryReaderRelationship(request));
  }

  /** Record one fact a person asked Rally to remember; a replay answers from its receipt. */
  async rememberMemoryFact(input: unknown): Promise<WorkspaceMemoryRememberResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceMemoryRememberRequestSchema, input, "remember_memory_fact");
    this.assertWorkspace(request.workspaceId);
    return rememberMemoryFact(this.state.storage, request, await this.memoryReaderRelationship(request));
  }

  /** Retract one fact, when this reader may; seeing it is not the same question. */
  async forgetMemoryFact(input: unknown): Promise<WorkspaceMemoryForgetResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceMemoryForgetRequestSchema, input, "forget_memory_fact");
    this.assertWorkspace(request.workspaceId);
    const result = forgetMemoryFact(this.state.storage, request, await this.memoryReaderRelationship(request));
    // A retraction marked the digest holders that held the fact; the lane
    // sends them without waiting on an unrelated wake.
    if (result.outcome === "retracted") await this.armNextAlarm();
    return result;
  }

  /**
   * The facts one principal's digest copy in this conversation is refreshed
   * from, newest first, recording the conversation as a holder so the
   * copy-sync lane can reach it; see `memory-digest-sync.ts`.
   */
  async memoryDigest(input: unknown): Promise<WorkspaceMemoryDigestResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceMemoryDigestRequestSchema, input, "memory_digest");
    this.assertWorkspace(request.workspaceId);
    return memoryDigestFacts(this.state.storage, request, await this.memoryReaderRelationship(request));
  }

  /**
   * What Rally remembers in one scope, as one person reviews it: their own
   * facts, the Organization's, or one Thread's, Breakout's or Channel's.
   */
  async reviewMemoryFacts(input: unknown): Promise<WorkspaceMemoryReviewResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceMemoryReviewRequestSchema, input, "review_memory_facts");
    this.assertWorkspace(request.workspaceId);
    return reviewMemoryFacts(this.state.storage, request, await this.memoryReaderRelationship({
      workspaceId: request.workspaceId, reader: { kind: "person", userId: request.userId },
    }));
  }

  /** Remove one fact from a scope's review, when the person may; see `reviewMemoryFacts`. */
  async forgetReviewedMemoryFact(input: unknown): Promise<WorkspaceMemoryReviewForgetResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceMemoryReviewForgetRequestSchema, input, "forget_reviewed_memory_fact");
    this.assertWorkspace(request.workspaceId);
    const result = forgetReviewedMemoryFact(this.state.storage, request, await this.memoryReaderRelationship({
      workspaceId: request.workspaceId, reader: { kind: "person", userId: request.userId },
    }));
    // A retraction marked every digest holder; the lane sends them without
    // waiting on an unrelated wake.
    if (result.outcome === "retracted") await this.armNextAlarm();
    return result;
  }

  /** The facts a sweep of this conversation may read and revise, and where the conversation sits. */
  async memorySweepCandidates(input: unknown): Promise<WorkspaceMemorySweepCandidatesResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceMemorySweepCandidatesRequestSchema, input, "memory_sweep_candidates");
    this.assertWorkspace(request.workspaceId);
    return memorySweepCandidates(this.state.storage, request);
  }

  /** Apply one sweep's operations behind the conversation's cursor fence, in one transaction. */
  async applyMemorySweep(input: unknown): Promise<WorkspaceMemoryApplySweepResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceMemoryApplySweepRequestSchema, input, "apply_memory_sweep");
    this.assertWorkspace(request.workspaceId);
    const result = applyMemorySweep(this.state.storage, request);
    // A retraction marked the digest holders that held its fact; the lane
    // sends them without waiting on an unrelated wake.
    if (result.outcome === "applied" && result.markedHolders) await this.armNextAlarm();
    return result;
  }

  /** A person reader's Organization relationship, or nothing for a Sidekick reader. */
  private async memoryReaderRelationship(
    request: { workspaceId: string; reader: MemoryReader },
  ): Promise<WorkspaceRelationship | null> {
    if (request.reader.kind !== "person") return null;
    return this.readRelationship(request.workspaceId, request.reader.userId);
  }

  /** One durable table and its ordered columns, invalidated or not. */
  async memoryTableWithColumns(
    input: WorkspaceMemoryTableRequest,
  ): Promise<WorkspaceMemoryTableResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceMemoryTableRequestSchema, input, "memory_table_with_columns");
    this.assertWorkspace(request.workspaceId);
    return workspaceMemoryTableWithColumns(this.state.storage, request);
  }

  /** Live durable tables in the given scopes whose prose matches the pattern. */
  async searchMemoryTables(
    input: WorkspaceMemoryTableSearchRequest,
  ): Promise<WorkspaceMemoryTableSearchResult> {
    await this.initialized;
    const request = WorkspaceMemoryTableSearchRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return searchWorkspaceMemoryTables(this.state.storage, request);
  }

  /**
   * One page of rows and the revision they were read under, in one object
   * event. Through the facade the page and the stale-revision re-check were
   * separate round trips, so a mutation between them failed an innocent read
   * with `memory_table_query_changed_during_read`; here that window is gone.
   */
  async queryMemoryTableRows(
    input: WorkspaceMemoryTableQueryRequest,
  ): Promise<WorkspaceMemoryTableQueryResult> {
    await this.initialized;
    const request = WorkspaceMemoryTableQueryRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return queryWorkspaceMemoryTableRows(this.state.storage, request);
  }

  /** The rows a mutation names, in whatever state they currently hold. */
  async memoryTableRowsById(
    input: WorkspaceMemoryTableRowsByIdRequest,
  ): Promise<WorkspaceMemoryTableRowList> {
    await this.initialized;
    const request = WorkspaceMemoryTableRowsByIdRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceMemoryTableRowsById(this.state.storage, request);
  }

  /** A durable-table mutation receipt by idempotency key. */
  async memoryTableMutationReceipt(
    input: WorkspaceMemoryReceiptRequest,
  ): Promise<WorkspaceMemoryReceiptResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceMemoryReceiptRequestSchema, input, "memory_table_mutation_receipt");
    this.assertWorkspace(request.workspaceId);
    return workspaceMemoryTableMutationReceipt(this.state.storage, request);
  }

  /**
   * Create or reopen a typed durable table, reconciling metadata atomically.
   * A structural conflict returns its table id and incompatible field paths.
   */
  async createMemoryTable(
    input: WorkspaceMemoryTableCreateRequest,
  ): Promise<WorkspaceMemoryTableCreateResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceMemoryTableCreateRequestSchema, input, "create_memory_table");
    this.assertWorkspace(request.workspaceId);
    return createWorkspaceMemoryTable(this.state.storage, request);
  }

  /**
   * Insert rows by natural key as one decision: revision bump, rows, cells,
   * and the audit record commit together. The facade path retried a D1 batch
   * against its own revision counter and threw
   * `memory_table_insert_contention` after three losses; a single transaction
   * has nothing to contend with, so that failure mode no longer exists.
   */
  async insertMemoryTableRows(
    input: WorkspaceMemoryTableInsertRowsRequest,
  ): Promise<WorkspaceMemoryTableInsertRowsResult> {
    await this.initialized;
    const request = WorkspaceMemoryTableInsertRowsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return insertWorkspaceMemoryTableRows(this.state.storage, request);
  }

  /** Patch rows at expected revisions; one stale row refuses the whole batch. */
  async updateMemoryTableRows(
    input: WorkspaceMemoryTableUpdateRowsRequest,
  ): Promise<WorkspaceMemoryTableWriteResult> {
    await this.initialized;
    const request = WorkspaceMemoryTableUpdateRowsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return updateWorkspaceMemoryTableRows(this.state.storage, request);
  }

  /** Reversibly invalidate rows at expected revisions, all or nothing. */
  async invalidateMemoryTableRows(
    input: WorkspaceMemoryTableInvalidateRowsRequest,
  ): Promise<WorkspaceMemoryTableWriteResult> {
    await this.initialized;
    const request = WorkspaceMemoryTableInvalidateRowsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return invalidateWorkspaceMemoryTableRows(this.state.storage, request);
  }

  /**
   * Whether a notification about a conversation may still reach this person,
   * read where the parent lives: a Canvas's row and who it admits, or a
   * Sidekick's row and who it is shared with. Both are written in this object,
   * so there is no projection to wait for. `null` for any other id: a Thread
   * or Channel retired with the rest (plan step B-7) has nobody to tell.
   */
  async notificationDirectoryState(
    input: WorkspaceDirectoryNotificationRequest,
  ): Promise<WorkspaceDirectoryNotificationState | null> {
    await this.initialized;
    const request = WorkspaceDirectoryNotificationRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const sql = this.state.storage.sql;
    // The role beside the access class: an owner or administrator opens every
    // Canvas (`canvasReaderAllows`), so reading every member as `member`
    // withheld a mention from an administrator a creator-only Canvas admits.
    const relationship = sql.exec<{ access_class: string | null; role: string | null }>(
      `SELECT json_extract(relationship_json, '$.accessClass') AS access_class,
              json_extract(relationship_json, '$.role') AS role
         FROM workspace_member_status WHERE user_id = ? AND active = 1`, request.userId,
    ).toArray()[0];
    const actorRole = relationship?.access_class !== "member" ? null
      : relationship.role === "owner" || relationship.role === "admin" ? relationship.role : "member" as const;
    const canvas = sql.exec<CanvasRow>(`SELECT * FROM canvas_directory WHERE canvas_id = ?`, request.workstreamId).toArray()[0];
    if (canvas) {
      return WorkspaceDirectoryNotificationStateSchema.parse({
        authorityGeneration: canvas.authority_generation,
        listable: canvasReaderAllows(canvas, { userId: request.userId, actorRole }, sql),
        title: canvas.title, emailAddress: null,
      });
    }
    const sidekick = sql.exec<{ automation_id: string; scope: string; author_user_id: string; run_as_user_id: string | null;
      lifecycle: string; title: string; authority_generation: number }>(
      `SELECT automation_id, scope, author_user_id, run_as_user_id, lifecycle, title, authority_generation
         FROM automation_directory WHERE automation_id = ?`, request.workstreamId,
    ).toArray()[0];
    if (!sidekick) return null;
    return WorkspaceDirectoryNotificationStateSchema.parse({
      authorityGeneration: sidekick.authority_generation,
      listable: sidekickReaderAllows(sidekick, { userId: request.userId, actorRole }, sql),
      title: sidekick.title, emailAddress: null,
    });
  }

  /**
   * The title of whatever a shared link names, or null when nothing here has
   * that id. Holding the link is the permission: a link's title is shown to
   * anyone who has it, so this reads no viewer and checks no scope, except
   * that a Personal Channel is never named. A deleted
   * Sidekick is gone; an archived Channel, Breakout or Space keeps its name.
   */
  async linkTitle(input: unknown): Promise<{ title: string | null }> {
    await this.initialized;
    const { workspaceId, target } = parseRpcInput(WorkspaceLinkTitleRequestSchema, input, "link_title");
    // An object no Organization ever opened, reached only where placement
    // falls back outside production: it holds nothing to name.
    if (this.workspaceId() === null) return { title: null };
    this.assertWorkspace(workspaceId);
    const sql = this.state.storage.sql;
    const row = target.kind === "canvas"
      ? sql.exec<{ title: string }>(`SELECT title FROM canvas_directory WHERE canvas_id = ?`, target.canvasId).toArray()[0]
      : sql.exec<{ title: string }>(
        `SELECT title FROM automation_directory WHERE automation_id = ? AND lifecycle <> 'deleted'`,
        target.sidekickId,
      ).toArray()[0];
    return { title: row?.title.trim() || null };
  }

  /**
   * Every Canvas and Sidekick, the parents whose conversations may hold a
   * Terminal sandbox, for the Organization's network policy pass. Unfiltered
   * by person: the policy is the Organization's.
   */
  async terminalSandboxParents(input: { workspaceId: string }): Promise<{
    parentKind: "canvas" | "automation"; workstreamId: string; title: string;
  }[]> {
    await this.initialized;
    this.assertWorkspace(WorkspaceIdSchema.parse(input.workspaceId));
    return this.state.storage.sql.exec<{ kind: "canvas" | "automation"; id: string; title: string }>(
      `SELECT 'canvas' AS kind, canvas_id AS id, title FROM canvas_directory
       UNION ALL SELECT 'automation', automation_id, title FROM automation_directory WHERE lifecycle <> 'deleted'
       ORDER BY id`,
    ).toArray().map((row) => ({ parentKind: row.kind, workstreamId: row.id, title: row.title }));
  }

  async workstreamScheduleTargets(
    input: WorkspaceDirectoryScheduleTargetsRequest,
  ): Promise<WorkspaceDirectoryScheduleTargetsResult> {
    await this.initialized;
    const request = WorkspaceDirectoryScheduleTargetsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    // The only targets were a Thread's Terminal deadlines, read from its
    // `channels` row. Threads are retired (plan step C-7) and their objects
    // refuse to open, so nothing is due here. A Sidekick child's deadline
    // (`HostedConversation.childTerminalDeadlines`) was never enumerated by
    // this read, before or after; whether it should be is an open question
    // recorded in docs/workspace-retirement.md, not a change made here.
    return WorkspaceDirectoryScheduleTargetsResultSchema.parse({ items: [] });
  }

  async readSearchAuthorizationSnapshots(input: unknown) {
    await this.initialized;
    const request = z.strictObject({ subject: AuthorizationSubjectSchema, resources: z.array(AuthorizationResourceSchema) }).parse(input);
    this.assertWorkspace(request.subject.workspaceId);
    return Promise.all(request.resources.map(async (resource) => {
      this.assertWorkspace(resource.workspaceId);
      const key = await searchAuthorizationKey(request.subject, resource);
      const row = this.state.storage.sql.exec<{ snapshot_json: string }>(
        'SELECT snapshot_json FROM authorization_snapshots WHERE cache_key = ?', key).toArray()[0];
      return row ? SearchAuthorizationSnapshotSchema.parse(JSON.parse(row.snapshot_json)) : null;
    }));
  }

  async registerSearchAuthorization(input: unknown) {
    await this.initialized;
    const request = z.strictObject({ subject: AuthorizationSubjectSchema, resources: z.array(AuthorizationResourceSchema),
      unregisteredOnly: z.literal(true).optional() }).parse(input);
    this.assertWorkspace(request.subject.workspaceId);
    // Resolve async keys first, then validate the whole batch before any writes.
    const keys = await Promise.all(request.resources.map(resource => searchAuthorizationKey(request.subject, resource)));
    for (const resource of request.resources) {
      this.assertWorkspace(resource.workspaceId);
      if (this.isRetiredMeetingResource(resource)) throw new Error('meeting_notes_retired');
    }
    // A null generation is a key this caller did not claim: already registered, under `unregisteredOnly`.
    const generations: (number | null)[] = [];
    for (const [index, resource] of request.resources.entries()) {
      const key = keys[index]!;
      // Allocate before owner reads. A later attempt supersedes an earlier one even in the same millisecond.
      const generation = this.state.storage.sql.exec<{ generation: number }>(`INSERT INTO search_authorization_keys
        (cache_key, generation, resource_id, parent_id, connection_id) VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(cache_key) DO ${request.unregisteredOnly ? 'NOTHING' : 'UPDATE SET generation = generation + 1'} RETURNING generation`, key,
        resource.kind === 'resource' ? resource.resourceId : resource.kind === 'memory' ? resource.scopeId : null,
        resource.kind === 'conversation' || resource.kind === 'memory' ? resource.parentId : null,
        resource.kind === 'connection' ? resource.connectionId : null).toArray()[0]?.generation ?? null;
      generations.push(generation);
      if (generation === null) continue;
      const pending = { version: 1, generation, subject: request.subject, resource, observedAt: 0,
        decision: { status: 'unavailable', reason: 'projection_incomplete', retryable: true } };
      this.state.storage.sql.exec('INSERT INTO authorization_snapshots VALUES (?, ?, 0) ON CONFLICT(cache_key) DO NOTHING',
        key, JSON.stringify(pending));
      // Retain dependencies before owner reads, including an attachment removed while a first fill is in flight.
      if (resource.kind === 'resource') this.state.storage.sql.exec(`INSERT OR IGNORE INTO search_authorization_dependencies
        SELECT parent_id, ? FROM authorization_locations WHERE resource_id = ?`, key, resource.resourceId);
      if (resource.kind === 'memory') this.state.storage.sql.exec(`INSERT OR IGNORE INTO search_authorization_dependencies
        SELECT owner_id, ? FROM memory_scopes WHERE memory_scope_id = ?`, key, resource.scopeId);
    }
    // No re-arm: nothing written here is a lane of this object's alarm. The
    // pending snapshot's trigger still records a `search_authorization_push`
    // row, but that store has not been flushed or armed for since search
    // began filtering on row audience (#1007).
    return generations;
  }

  async listSearchAuthorizationSnapshots(input: { workspaceId: string; target?: z.infer<typeof SearchAuthorizationTargetSchema> }) {
    await this.initialized;
    this.assertWorkspace(WorkspaceIdSchema.parse(input.workspaceId));
    const target = input.target ? SearchAuthorizationTargetSchema.parse(input.target) : undefined;
    let keys: string;
    let bindings: string[];
    if (!target) { keys = 'SELECT cache_key FROM search_authorization_keys'; bindings = []; }
    else if (target.kind === 'resource') {
      keys = 'SELECT cache_key FROM search_authorization_keys WHERE resource_id = ?'; bindings = [target.id];
    } else if (target.kind === 'connection') {
      keys = `SELECT k.cache_key FROM resources r JOIN search_authorization_keys k ON k.resource_id = r.id WHERE r.connection_id = ?
        UNION SELECT cache_key FROM search_authorization_keys WHERE connection_id = ?`;
      bindings = [target.id, target.id];
    } else if (target.kind === 'member') {
      keys = `SELECT cache_key FROM authorization_snapshots WHERE json_extract(snapshot_json, '$.subject.userId') = ?`;
      bindings = [target.id];
    } else {
      // Indexed prior owners reach removed grants; current locations reach newly attached resources.
      keys = `SELECT cache_key FROM search_authorization_keys WHERE parent_id = ?
        UNION SELECT cache_key FROM search_authorization_dependencies WHERE parent_id = ?
        UNION SELECT k.cache_key FROM authorization_locations l JOIN search_authorization_keys k ON k.resource_id = l.resource_id WHERE l.parent_id = ?`;
      bindings = Array.from({ length: 3 }, () => target.id);
    }
    return this.state.storage.sql.exec<{ snapshot_json: string }>(
      `SELECT snapshot_json FROM authorization_snapshots WHERE cache_key IN (${keys})`, ...bindings).toArray()
      .map((row) => SearchAuthorizationSnapshotSchema.parse(JSON.parse(row.snapshot_json)));
  }

  /** `republish` is for a KV miss: KV lacks the decision whatever this object last recorded. */
  async writeSearchAuthorizationSnapshots(input: unknown, options?: unknown) {
    await this.initialized;
    const snapshots = z.array(SearchAuthorizationSnapshotSchema).parse(input);
    const { republish = false } = z.strictObject({ republish: z.boolean().optional() }).optional().parse(options) ?? {};
    const stats = { written: 0, unchanged: 0, superseded: 0, kvWriteMs: 0 };
    const results = await Promise.allSettled(snapshots.map(async (snapshot) => {
      this.assertWorkspace(snapshot.subject.workspaceId);
      this.assertWorkspace(snapshot.resource.workspaceId);
      const key = await searchAuthorizationKey(snapshot.subject, snapshot.resource);
      const previous = this.searchPublications.get(key) ?? Promise.resolve();
      // Serialize only this key's network writes; unrelated WorkspaceDO events stay runnable.
      const publication = previous.catch(() => {}).then(async () => {
        if (this.isRetiredMeetingResource(snapshot.resource)) { stats.superseded++; return; }
        const current = this.state.storage.sql.exec<{ generation: number; published_decision: string | null }>(
          'SELECT generation, published_decision FROM search_authorization_keys WHERE cache_key = ?', key).toArray()[0];
        if (current?.generation !== snapshot.generation) { stats.superseded++; return; }
        const fingerprint = searchDecisionFingerprint(snapshot.decision);
        this.state.storage.transactionSync(() => {
          this.state.storage.sql.exec(`INSERT INTO authorization_snapshots(cache_key, snapshot_json, validated_at) VALUES (?, ?, ?)
            ON CONFLICT(cache_key) DO UPDATE SET snapshot_json = excluded.snapshot_json, validated_at = excluded.validated_at`,
            key, JSON.stringify(snapshot), snapshot.observedAt);
          this.state.storage.sql.exec('DELETE FROM search_authorization_dependencies WHERE cache_key = ?', key);
          if (snapshot.decision.status !== 'unavailable') for (const evidence of snapshot.decision.evidence) {
            this.state.storage.sql.exec('INSERT OR IGNORE INTO search_authorization_dependencies VALUES (?, ?)', evidence.owner.split('/')[0]!, key);
          }
        });
        if (this.env.AVALON_REGION === 'global' && this.env.AUTHORIZATION_CACHE) {
          // Readers act only on the fingerprinted part, so KV already serves this decision.
          if (!republish && current.published_decision === fingerprint) { stats.unchanged++; stats.written++; return; }
          const startedAt = Date.now();
          // A put that fails may or may not have landed; forget what KV holds until one is acknowledged.
          this.state.storage.sql.exec('UPDATE search_authorization_keys SET published_decision = NULL WHERE cache_key = ?', key);
          try {
            await this.env.AUTHORIZATION_CACHE.put(key, JSON.stringify(snapshot));
            // Writes to one key are serialized above, so this is what KV now holds.
            this.state.storage.sql.exec('UPDATE search_authorization_keys SET published_decision = ? WHERE cache_key = ?', fingerprint, key);
          } catch (error) {
            this.state.storage.sql.exec(`INSERT INTO search_authorization_push VALUES (?, ?, 1, 0, ?, ?)
              ON CONFLICT(kind, target_id) DO UPDATE SET revision = revision + 1,
                timing_origin = CASE WHEN first_mutated_at IS NULL OR excluded.first_mutated_at < first_mutated_at THEN excluded.timing_origin ELSE timing_origin END,
                first_mutated_at = CASE WHEN first_mutated_at IS NULL THEN excluded.first_mutated_at
                  WHEN excluded.first_mutated_at IS NULL THEN first_mutated_at ELSE MIN(first_mutated_at, excluded.first_mutated_at) END`,
              snapshot.resource.kind === 'conversation' ? 'parent' : snapshot.resource.kind === 'connection' ? 'connection' : 'resource',
              snapshot.resource.kind === 'resource' ? snapshot.resource.resourceId : snapshot.resource.kind === 'conversation' ? snapshot.resource.parentId
                : snapshot.resource.kind === 'connection' ? snapshot.resource.connectionId : snapshot.resource.scopeId,
              snapshot.timing?.mutationAt ?? null, snapshot.timing?.origin ?? (snapshot.timing ? 'workspace_mutation' : 'cache_fill'));
            throw error;
          } finally { stats.kvWriteMs += Date.now() - startedAt; }
        }
        stats.written++;
      });
      this.searchPublications.set(key, publication);
      try { await publication; }
      finally { if (this.searchPublications.get(key) === publication) this.searchPublications.delete(key); }
    }));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return stats;
  }

  async readAuthorizationSnapshots(input: unknown) {
    await this.initialized;
    const request = z.strictObject({ subject: AuthorizationSubjectSchema, resources: z.array(AuthorizationResourceSchema) }).parse(input);
    this.assertWorkspace(request.subject.workspaceId);
    return request.resources.map((resource) => {
      this.assertWorkspace(resource.workspaceId);
      // Legacy RPC: old snapshots have no mutation invalidation and cannot authorize reads.
      return null;
    });
  }

  async writeAuthorizationSnapshots(input: unknown) {
    await this.initialized;
    const snapshots = z.array(AuthorizationSnapshotSchema).parse(input);
    for (const snapshot of snapshots) {
      this.assertWorkspace(snapshot.subject.workspaceId);
      this.assertWorkspace(snapshot.resource.workspaceId);
    }
    // Compatibility during rollout: accept the old wire shape without persisting grants.
  }

  async applyAuthorizationLocations(input: unknown) {
    await this.initialized;
    const request = AuthorizationLocationSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    this.state.storage.transactionSync(() => {
      new AuthorizationStorage(this.state.storage).replaceLocations(request);
      if (request.mutationAt !== undefined) this.state.storage.sql.exec(
        "UPDATE search_authorization_push SET timing_origin = CASE WHEN first_mutated_at IS NULL OR ? <= first_mutated_at THEN 'source_mutation' ELSE timing_origin END, first_mutated_at = COALESCE(MIN(first_mutated_at, ?), ?) WHERE kind = 'parent' AND target_id = ?",
        request.mutationAt, request.mutationAt, request.mutationAt, request.parentId);
      this.state.storage.sql.exec('UPDATE authorization_backfill_children SET completed = 1 WHERE parent_id = ? AND substream_id = ?', request.parentId, request.substreamId);
    });
    await this.armNextAlarm();
  }

  /** Internal migration control; source permissions remain in their original objects. */
  async beginAuthorizationBackfill(input: { workspaceId: string; refresh?: boolean }) {
    await this.initialized;
    this.assertWorkspace(WorkspaceIdSchema.parse(input.workspaceId));
    const queued = this.state.storage.transactionSync(() => {
      let queued = 0;
      const parents = this.state.storage.sql.exec<{ parent_id: string; parent_kind: 'workstream' | 'automation' }>(
        `SELECT workstream_id AS parent_id, 'workstream' AS parent_kind FROM channels
         UNION SELECT automation_id AS parent_id, 'automation' AS parent_kind FROM automation_directory`,
      ).toArray();
      const workspaceId = asWorkspaceId(input.workspaceId);
      for (const parent of parents) {
        const parentId = IdSchema.parse(parent.parent_id);
        if (input.refresh !== false) {
          this.state.storage.sql.exec(`INSERT INTO authorization_backfill(parent_id, parent_kind) VALUES (?, ?)
            ON CONFLICT(parent_id) DO UPDATE SET completed = 0`, parent.parent_id, parent.parent_kind);
          queued += this.enqueueAuthorizationDiscovery({ type: 'authorization_projection_v1', region: this.env.AVALON_REGION,
            workspaceId, parentId });
          continue;
        }
        // The unavailable-read path repairs only discovery that is missing, never work that finished
        // or is already scheduled: a retryable 503 must not reset a workspace or amplify into writes.
        const tracked = this.state.storage.sql.exec<{ completed: number }>(
          'SELECT completed FROM authorization_backfill WHERE parent_id = ?', parent.parent_id).toArray()[0];
        if (!tracked) {
          this.state.storage.sql.exec('INSERT INTO authorization_backfill(parent_id, parent_kind) VALUES (?, ?)',
            parent.parent_id, parent.parent_kind);
        }
        if (!tracked || !tracked.completed) {
          if (!this.authorizationDeliveryScheduled(parent.parent_id, null)) {
            queued += this.enqueueAuthorizationDiscovery({ type: 'authorization_projection_v1', region: this.env.AVALON_REGION,
              workspaceId, parentId });
          }
          continue;
        }
        // A parent completes when its children are registered, so a child whose own discovery died
        // leaves the parent complete. Re-queue that child directly: re-running the parent would
        // reset its siblings' finished receipts and widen the very outage being repaired.
        for (const child of this.state.storage.sql.exec<{ substream_id: string }>(
          'SELECT substream_id FROM authorization_backfill_children WHERE parent_id = ? AND completed = 0',
          parent.parent_id).toArray()) {
          if (this.authorizationDeliveryScheduled(parent.parent_id, child.substream_id)) continue;
          queued += this.enqueueAuthorizationDiscovery({ type: 'authorization_projection_v1', region: this.env.AVALON_REGION,
            workspaceId, parentId, substreamId: SubstreamIdSchema.parse(child.substream_id) });
        }
      }
      return queued;
    });
    // A repair that found everything finished or already scheduled queued no
    // delivery, and nothing else it writes is an alarm lane.
    if (queued > 0) await this.armNextAlarm();
    return this.authorizationBackfillStatus(input);
  }

  /** Work already queued (including one waiting out a delivery backoff) needs no second request. */
  private authorizationDeliveryScheduled(parentId: string, substreamId: string | null): boolean {
    return this.state.storage.sql.exec('SELECT 1 FROM authorization_delivery WHERE job_key = ?',
      JSON.stringify([parentId, substreamId])).toArray().length > 0;
  }

  /**
   * Discovery for one parent or one conversation.
   *
   * A parent job for a Channel hosted here is answered in place: its children
   * are `parent_children` rows in this database, so registering them is a few
   * statements in the caller's transaction rather than a Queue hop to a Worker
   * that would call straight back into this object for the list and the
   * registration. A conversation job and a Sidekick parent (its children are
   * `sidekick_children` rows, which this path does not read) still go through
   * the Queue.
   *
   * Returns how many `authorization_delivery` rows it wrote, from the rows the
   * write returned: the caller's only reason to re-arm the alarm.
   */
  private enqueueAuthorizationDiscovery(job: AuthorizationProjectionJob): number {
    if (job.substreamId === undefined) {
      const hostedChannel = this.state.storage.sql.exec(
        `SELECT 1 FROM parent_metadata parent
          WHERE parent.parent_id = ? AND parent.parent_kind = 'workstream'`,
        job.parentId,
      ).toArray().length > 0;
      if (hostedChannel) {
        this.state.storage.sql.exec('DELETE FROM authorization_delivery WHERE job_key = ?',
          JSON.stringify([job.parentId, null]));
        return this.registerAuthorizationChildrenInPlace({
          workspaceId: job.workspaceId, parentId: job.parentId,
          // The same rows `HostedParent.listAuthorizationChildren` answers.
          substreamIds: this.state.storage.sql.exec<{ substream_id: string }>(
            `SELECT substream_id FROM parent_children WHERE parent_id = ? AND (kind = 'main' OR status = 'ready')
              ORDER BY substream_id`,
            job.parentId,
          ).toArray().map((row) => SubstreamIdSchema.parse(row.substream_id)),
          ...(job.mutationAt === undefined ? {} : { mutationAt: job.mutationAt }),
        });
      }
    }
    return this.state.storage.sql.exec(`INSERT INTO authorization_delivery(job_key, payload_json, not_before) VALUES (?, ?, 0)
      ON CONFLICT(job_key) DO UPDATE SET payload_json = CASE
        WHEN json_extract(authorization_delivery.payload_json, '$.mutationAt') IS NULL THEN excluded.payload_json
        WHEN json_extract(excluded.payload_json, '$.mutationAt') IS NULL THEN json_set(excluded.payload_json, '$.mutationAt', json_extract(authorization_delivery.payload_json, '$.mutationAt'))
        ELSE json_set(excluded.payload_json, '$.mutationAt', MIN(json_extract(authorization_delivery.payload_json, '$.mutationAt'), json_extract(excluded.payload_json, '$.mutationAt'))) END,
      revision = authorization_delivery.revision + 1
      RETURNING job_key`,
    JSON.stringify([job.parentId, job.substreamId ?? null]), JSON.stringify(job)).toArray().length;
  }

  async registerAuthorizationChildren(input: { workspaceId: string; parentId: string; substreamIds: string[]; refreshExisting?: boolean; mutationAt?: number }) {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, parentId: IdSchema, substreamIds: z.array(SubstreamIdSchema), refreshExisting: z.boolean().optional(), mutationAt: z.number().int().nonnegative().optional() }).parse(input);
    this.assertWorkspace(request.workspaceId);
    const queued = this.state.storage.transactionSync(() => this.registerAuthorizationChildrenInPlace(request));
    // Only a queued delivery moves this object's alarm. A registration that
    // skipped every child already known (`refreshExisting: false`) or only
    // dropped children queued nothing: a removed delivery can leave the alarm
    // early, never late, and an early wake finds nothing due and re-arms.
    if (queued > 0) await this.armNextAlarm();
  }

  /**
   * The registration itself, in the caller's transaction. Returns how many
   * deliveries it queued.
   */
  private registerAuthorizationChildrenInPlace(request: {
    workspaceId: AuthorizationProjectionJob["workspaceId"]; parentId: string;
    substreamIds: NonNullable<AuthorizationProjectionJob["substreamId"]>[];
    refreshExisting?: boolean | undefined; mutationAt?: number | undefined;
  }): number {
    let queued = 0;
    // Reconcile the exact registry: deleted/failed children must not leave immortal pending receipts.
    const expected = new Set(request.substreamIds);
    const old = this.state.storage.sql.exec<{ substream_id: string }>(
      'SELECT substream_id FROM authorization_backfill_children WHERE parent_id = ? UNION SELECT substream_id FROM authorization_inventories WHERE parent_id = ?',
      request.parentId, request.parentId,
    ).toArray();
    for (const child of old) if (!expected.has(SubstreamIdSchema.parse(child.substream_id))) {
      for (const table of ['authorization_backfill_children', 'authorization_inventories', 'authorization_locations']) {
        this.state.storage.sql.exec(`DELETE FROM ${table} WHERE parent_id = ? AND substream_id = ?`, request.parentId, child.substream_id);
      }
      this.state.storage.sql.exec('DELETE FROM authorization_delivery WHERE job_key = ?', JSON.stringify([request.parentId, child.substream_id]));
    }
    for (const substreamId of request.substreamIds) {
      if (request.refreshExisting === false && this.state.storage.sql.exec(
        'SELECT 1 FROM authorization_backfill_children WHERE parent_id = ? AND substream_id = ?', request.parentId, substreamId,
      ).toArray().length) continue;
      this.state.storage.sql.exec(`INSERT INTO authorization_backfill_children(parent_id, substream_id) VALUES (?, ?)
        ON CONFLICT(parent_id, substream_id) DO UPDATE SET completed = 0`, request.parentId, substreamId);
      queued += this.enqueueAuthorizationDiscovery({ type: 'authorization_projection_v1', region: this.env.AVALON_REGION,
        workspaceId: request.workspaceId, parentId: request.parentId, substreamId,
        ...(request.mutationAt === undefined ? {} : { mutationAt: request.mutationAt }) });
    }
    this.state.storage.sql.exec('UPDATE authorization_backfill SET completed = 1 WHERE parent_id = ?', request.parentId);
    if (request.mutationAt !== undefined) this.state.storage.sql.exec(
      "UPDATE search_authorization_push SET timing_origin = CASE WHEN first_mutated_at IS NULL OR ? <= first_mutated_at THEN 'source_mutation' ELSE timing_origin END, first_mutated_at = COALESCE(MIN(first_mutated_at, ?), ?) WHERE kind = 'parent' AND target_id = ?",
      request.mutationAt, request.mutationAt, request.mutationAt, request.parentId);
    return queued;
  }

  async authorizationBackfillStatus(input: { workspaceId: string }) {
    await this.initialized;
    this.assertWorkspace(WorkspaceIdSchema.parse(input.workspaceId));
    return this.authorizationCoverage();
  }

  private authorizationCoverage() {
    const parents = this.state.storage.sql.exec<{ pending: number }>('SELECT COUNT(*) AS pending FROM authorization_backfill WHERE completed = 0').one().pending;
    const children = this.state.storage.sql.exec<{ pending: number }>('SELECT COUNT(*) AS pending FROM authorization_backfill_children WHERE completed = 0').one().pending;
    const undiscovered = this.state.storage.sql.exec<{ pending: number }>(`SELECT COUNT(*) AS pending FROM (
      SELECT workstream_id AS parent_id FROM channels
      UNION SELECT automation_id AS parent_id FROM automation_directory
    ) directory LEFT JOIN authorization_backfill tracked USING(parent_id) WHERE tracked.parent_id IS NULL`).one().pending;
    return { pendingParents: parents + undiscovered, pendingChildren: children,
      complete: parents === 0 && children === 0 && undiscovered === 0 };
  }

  /** A connection's resources are readable exactly when the connection is; one observation decides them all. */
  async authorizationConnectionFacts(input: { workspaceId: string; userId: string; connectionIds: string[] }) {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, userId: UserIdSchema, connectionIds: z.array(IdSchema) }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return request.connectionIds.map((connectionId) => {
      const row = this.state.storage.sql.exec<{ scope: string; owner_user_id: string | null; status: string; updated_at: string }>(
        'SELECT scope, owner_user_id, status, updated_at FROM connector_connections WHERE id = ? AND workspace_id = ?', connectionId, request.workspaceId,
      ).toArray()[0];
      if (!row) return { connectionId, exists: false as const, validatedAt: Date.now() };
      return { connectionId, exists: true as const, validatedAt: Date.now(), revision: row.updated_at,
        allowed: connectionAdmits({ status: row.status, scope: row.scope, ownerUserId: row.owner_user_id }, request.userId) };
    });
  }

  /**
   * The search audience groups a person holds, as group UUIDs: the person side
   * of docs/PRDs/2026-09-26_search-audience-filtering/design.md, read on every
   * search. A search returns a row only when its `audience` shares a group
   * with this list.
   *
   * Everything is read from this object's own tables. A Canvas's Chat is
   * decided by `canvasReaderAllows`; a Sidekick and a connection by the predicates canonical
   * authorization shares (`sidekickAdmits`, `connectionAdmits`), and a
   * Canvas's Chat by `canvasReaderAllows`, the rule opening the Canvas
   * applies. One narrowing is search's own, from the PRD: a guest never holds
   * a workspace connection. A person who is not an active member of the
   * Organization holds no groups.
   */
  async readSearchAudience(input: unknown): Promise<string[]> {
    await this.initialized;
    const request = parseRpcInput(z.strictObject({ workspaceId: WorkspaceIdSchema, userId: UserIdSchema }),
      input, "read_search_audience");
    this.assertWorkspace(request.workspaceId);
    const relationship = await this.readRelationship(request.workspaceId, request.userId);
    if (relationship?.status !== "active") return [];
    const member = relationship.accessClass === "member";
    const sql = this.state.storage.sql;
    const groups = [searchAudienceGroup.user(request.userId)];
    // The members group is the audience of Organization-wide rows.
    if (admitsOrganizationWide(relationship.accessClass)) groups.push(searchAudienceGroup.members(request.workspaceId));
    for (const sidekick of sql.exec<{
      automation_id: string; scope: string; author_user_id: string; run_as_user_id: string | null; shared: number;
    }>(`SELECT automation_id, scope, author_user_id, run_as_user_id,
               EXISTS (SELECT 1 FROM sidekick_audience audience
                        WHERE audience.sidekick_id = automation_id AND audience.user_id = ?) AS shared
          FROM automation_directory WHERE lifecycle <> 'deleted'`, request.userId).toArray()) {
      // Whoever the Sidekick is shared with, the rule its canonical reads apply.
      const readable = sidekickAdmits({ scope: sidekick.scope, author: sidekick.author_user_id === request.userId,
        executor: sidekick.run_as_user_id === request.userId, shared: sidekick.shared === 1 }, member);
      if (readable) groups.push(searchAudienceGroup.sidekick(sidekick.automation_id));
    }
    // A Canvas's Chat is its conversation `0`, read by whoever opens the Canvas.
    const actorRole = member ? relationship.role ?? "member" : null;
    for (const canvas of sql.exec<CanvasRow>(`SELECT * FROM canvas_directory`).toArray()) {
      if (canvasReaderAllows(canvas, { userId: request.userId, actorRole }, sql)) {
        groups.push(searchAudienceGroup.conversation(canvas.canvas_id, "0"));
      }
    }
    // A guest never gets a workspace connection (the PRD's decision 7); every
    // other reader is who `authorizationConnectionFacts` allows.
    for (const connection of sql.exec<{ id: string; scope: string; owner_user_id: string | null; status: string }>(
      "SELECT id, scope, owner_user_id, status FROM connector_connections WHERE workspace_id = ?",
      request.workspaceId).toArray()) {
      if (connectionAdmits({ status: connection.status, scope: connection.scope, ownerUserId: connection.owner_user_id }, request.userId)
        && (member || connection.scope !== "workspace")) {
        groups.push(searchAudienceGroup.connection(connection.id));
      }
    }
    return searchAudienceGroupIds(groups);
  }

  /**
   * The subjects and resources a push target reaches, from this object's
   * directories and the regional member list. Discovery for registration
   * only: every pair is still decided by its canonical owner.
   */
  async enumerateSearchAuthorization(input: { workspaceId: string; target: SearchAuthorizationTarget }) {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, target: SearchAuthorizationTargetSchema }).parse(input);
    this.assertWorkspace(request.workspaceId);
    const members = await this.env.DB.prepare(
      `SELECT user_id, role FROM workspace_members WHERE workspace_id = ? AND status = 'active'`,
    ).bind(request.workspaceId).all<{ user_id: string; role: string | null }>();
    return enumerateSearchAuthorizationUniverse(this.state.storage.sql, request.workspaceId,
      members.results.map((row) => row.user_id),
      members.results.filter((row) => row.role === "owner" || row.role === "admin").map((row) => row.user_id),
      request.target);
  }

  async authorizationResourceFacts(input: {
    workspaceId: string; userId: string; resourceIds: string[];
    /** The reader's access class, which decides the Channels they read. */
    accessClass: "member" | "guest";
    includeReadMetadata?: boolean;
  }) {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema, userId: UserIdSchema, resourceIds: z.array(IdSchema),
      accessClass: z.enum(["member", "guest"]),
      includeReadMetadata: z.boolean().optional(),
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    const locations = new AuthorizationStorage(this.state.storage);
    const coverage = this.authorizationCoverage();
    // Absence is evidence only as old as the oldest source observation, never today's projection read.
    const discoveryAt = this.state.storage.sql.exec<{ validated_at: number | null }>(
      'SELECT MIN(validated_at) AS validated_at FROM authorization_inventories').one().validated_at ?? Date.now();
    return request.resourceIds.map((resourceId) => {
      const row = this.state.storage.sql.exec<{
        provider: string; resource_type: string; uploaded_by_user_id: string | null;
        attachment_status: string | null; updated_at: string; connection_id: string | null;
      }>('SELECT provider, resource_type, uploaded_by_user_id, attachment_status, updated_at, connection_id FROM resources WHERE id = ? AND workspace_id = ?',
      resourceId, request.workspaceId).toArray()[0];
      if (!row) return { resourceId, exists: false as const, validatedAt: Date.now() };
      const connection = row.connection_id ? this.state.storage.sql.exec<{ scope: string; owner_user_id: string | null; status: string }>(
        'SELECT scope, owner_user_id, status FROM connector_connections WHERE id = ?', row.connection_id,
      ).toArray()[0] : null;

      const owned = row.uploaded_by_user_id === request.userId;
      const placed = locations.locations(resourceId);
      // A merge once shared a resource with a Channel; Channels are retired
      // (plan step C-2), so none admits a reader through one now.
      const sharedThrough = null;
      // These rows are already local to the authority deciding the resource.
      // The caller discloses them only after composing the complete decision.
      const readMetadata = request.includeReadMetadata ? {
        placementAffinity: this.placementAffinity(),
        resource: this.state.storage.sql.exec<Record<string, SqlStorageValue>>(`${RESOURCE_READ_PROJECTION_SQL}
          WHERE r.id = ? AND r.workspace_id = ?`, resourceId, request.workspaceId).one(),
        artifact: this.state.storage.sql.exec<{
          artifact_id: string; workstream_id: string; mode: string; stateful: number; hostname_stub: string | null;
        }>(`SELECT artifact_id, workstream_id, mode, stateful, hostname_stub FROM artifact_registry
          WHERE workspace_id = ? AND resource_id = ?`, request.workspaceId, resourceId).toArray()[0] ?? null,
      } : null;
      return { resourceId, exists: true as const, validatedAt: Date.now(), revision: row.updated_at, owned, sharedThrough,
        connectionAllowed: !row.connection_id || Boolean(connection && connection.status !== 'disabled'
          && (connection.scope === 'workspace' || connection.owner_user_id === request.userId)),
        noteAllowed: row.provider !== 'avalon_note',
        draftAllowed: !isDraftUpload(row) || owned,
        requiresAttachment: requiresAttachment(row, owned),
        locations: placed.filter((location) => location.parentKind !== "space"), projectionComplete: coverage.complete, discoveryAt,
        readMetadata,
      };
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
      impersonatorUserId: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_IMPERSONATOR_ID),
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

    // The first-frame watch runs on the alarm, and a quiet workspace may have
    // none armed. Lowering-only, so a sooner wake reason keeps its slot. Armed
    // before the accept: a failure here must not leave an accepted socket that
    // no client holds, which the watch would later read as a silent one.
    const connectedAt = Date.now();
    await this.ensureAlarmNoLaterThan(connectedAt + this.socketFirstFrameDeadlineMs);
    const [client, server] = Object.values(new WebSocketPair());
    if (!client || !server) return json({ error: "websocket_unavailable" }, 500);
    const attachment: WorkspaceSocketAttachment = {
      ...identity.data,
      accessClass: auth.accessClass ?? "member",
      readsIndividualSpaces: readRallyHeader(request.headers, RALLY_HEADERS.SOCKET_READS_INDIVIDUAL_SPACES) === "1",
      connectionId: uuidV7(),
      connectedAt: new Date(connectedAt).toISOString(),
      subscribed: false,
      firstFrameReported: false,
      lastWaterline: 0,
      presenceRevision: 0,
      applicationState: "background",
      foregroundWorkstreamId: null,
    };
    // Before the accept: an accepted socket without a row could never be counted once its client gave up.
    if (this.unheardLedger) {
      this.state.storage.sql.exec(
        `INSERT INTO workspace_socket_unheard (connection_id, accepted_at) VALUES (?, ?)`,
        attachment.connectionId,
        connectedAt,
      );
    }
    this.state.acceptWebSocket(server, [attachment.workspaceId, attachment.userId]);
    // Register the server end with the hibernation API before attaching the
    // state that handlers will recover after an isolate wake. Both operations
    // are synchronous, so no client event can interleave between them.
    server.serializeAttachment(attachment);
    this.logWorkspaceSocketHandshake(attachment, "accepted");
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Apply one directory effect a Channel published *about one of its
   * breakouts*.
   *
   * The Channel branch's structure against the breakout tables, and
   * deliberately none of the rest of it: a breakout has no resource links, no
   * attachment reservations, no watch registrations, no Terminal schedule of
   * its own (the Channel's row already carries the earliest of them) and no
   * sidebar row. What it has is a title, an activity time, a state and a
   * per-person read state, which is exactly what one line of a Space dashboard
   * is made of.
   *
   * The receipt is the Channel's existing one, keyed by the envelope's message
   * id, so a redelivery is a no-op through the same table that makes a
   * redelivered Channel projection one. A second receipt table would have been
   * a second thing to expire and a second way for the two to disagree about
   * whether a message had been seen.
   *
   * Returns whether the row moved, which is what decides whether the sockets
   * that can see this breakout's parent Channel are nudged. Nothing durable is
   * written outside the receipt's own transaction — there is no durable
   * dashboard signal at all.
   */

  /**
   * The automations a person's left sidebar lists: their own and the
   * workspace's, drafts included, never a room's.
   */
  /**
   * The Sidekick library a socket's sidebar carries. It is the Organization's
   * catalog rather than part of the Space/Channel/Breakout hierarchy, and its
   * routes are a member's, so a guest's socket carries none; a guest reaches a
   * Sidekick through the conversation it is attached to.
   */
  private sidekickLibrary(attachment: WorkspaceSocketAttachment): AutomationSummary[] {
    return viewerOf(attachment).accessClass === "member"
      ? this.listSidebarAutomations(attachment.workspaceId, attachment.userId)
      : [];
  }

  /** Whether {@link listSidebarAutomations} lists this Sidekick to this viewer, asked of its one row. */
  private sidekickListed(workspaceId: string, userId: string, automationId: string): boolean {
    return this.state.storage.sql.exec(
      `SELECT 1 FROM automation_directory directory
        WHERE directory.automation_id = ?3 AND ${SIDEBAR_SIDEKICK_LISTED_SQL} LIMIT 1`,
      userId, workspaceId, automationId,
    ).toArray().length > 0;
  }

  private listSidebarAutomations(workspaceId: string, userId: string, limit = SIDEBAR_LIST_LIMIT): AutomationSummary[] {
    // The viewer's own Sidekicks, the Organization's, and those shared with
    // them, each with what they have not read in its shared conversation.
    return this.state.storage.sql.exec<AutomationDirectoryRow & { shared_count: number; unread: number; needs_input: number; pinned_position: number | null }>(
      `SELECT directory.automation_id, directory.loadable, directory.appearance_json, directory.lifecycle,
              directory.scope, directory.title, directory.description,
              directory.next_run_at, directory.projected_at, ${AUTOMATION_AUDIENCE_SQL}, ${AUTOMATION_VIEWER_SQL},
              pin.position AS pinned_position
         FROM automation_directory directory
         ${AUTOMATION_VIEWER_JOINS}
         LEFT JOIN workspace_pins pin ON pin.user_id = ?1 AND pin.item_kind = 'sidekick' AND pin.item_id = directory.automation_id
        WHERE ${SIDEBAR_SIDEKICK_LISTED_SQL}
        ORDER BY directory.title COLLATE NOCASE, directory.automation_id
        LIMIT ?3`,
      userId,
      workspaceId,
      limit,
    ).toArray().map((row) => ({ ...automationSummary(row, this.invalidAppearanceReporter(workspaceId)),
      pinnedPosition: row.pinned_position }));
  }

  /**
   * The whole sidebar for one viewer: the Sidekick and Canvas lists, from local
   * reads with no `await` between them, so it is one consistent snapshot rather
   * than two answers a concurrent write could land between.
   */
  private sidebarPayload(attachment: WorkspaceSocketAttachment): WorkspaceSidebar {
    return WorkspaceSidebarSchema.parse({
      automations: {
        waterline: this.sidebarListWaterline("automations"),
        items: this.sidekickLibrary(attachment),
      },
      canvases: { waterline: this.canvasListWaterline(), items: this.canvasList(attachment) },
      // One release of compatibility for a pre-pivot desktop; see the schema.
      workstreams: { directoryWaterline: 0, items: [], stateVersions: [], nextCursor: null },
      notes: { waterline: 0, items: [], nextCursor: null },
    });
  }

  private sidebarListWaterline(list: SidebarList): number {
    return this.state.storage.sql.exec<{ waterline: number }>(
      `SELECT waterline FROM workspace_sidebar_list_state WHERE list = ?`,
      list,
    ).one().waterline;
  }

  /**
   * Send the Sidekick list what moved since it was last sent: every socket for
   * a change to a Sidekick's row, or only the sockets of the people whose read
   * of a shared conversation moved.
   */
  private publishSidekickList(): void {
    if (this.sidekickDirectoryMoved) {
      this.sidekickDirectoryMoved = false;
      this.sidekickReadersMoved.clear();
      this.publishSidebarList("automations");
    } else if (this.sidekickReadersMoved.size > 0) {
      const readers = new Set(this.sidekickReadersMoved);
      this.sidekickReadersMoved.clear();
      this.publishSidebarList("automations", readers);
    }
  }

  /**
   * Re-send one sidebar list to every subscribed socket, per viewer.
   *
   * Read once per socket rather than once per workspace because the list is
   * scoped — a personal automation belongs to its owner, and sending
   * one reader's list to another would leak it.
   *
   * The event carries the list's waterline, read once here so every socket is
   * told the same version of the same read. Transport ordering is not relied on
   * for that: `WorkspaceSidebarListEventSchema` carries the number because the
   * connect payload sends these lists too, and two producers cannot be ordered
   * by one of their transports.
   */
  private publishSidebarList(list: SidebarList, onlyUserIds?: ReadonlySet<string>): void {
    const occurredAt = new Date().toISOString();
    const waterline = this.sidebarListWaterline(list);
    // No authorization re-check on the way out. An open socket is closed by the
    // access-revocation queue, never by a publisher asking again — see
    // `docs/access-revocation.md`, which names that as the mechanism it
    // replaced and asks for it not to come back.
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed || (onlyUserIds && !onlyUserIds.has(attachment.userId))) continue;
      const page = { items: this.sidekickLibrary(attachment) };
      try {
        socket.send(JSON.stringify(WorkspaceSidebarListEventSchema.parse({
          type: "workspace_sidebar_list",
          occurredAt,
          list,
          waterline,
          ...page,
        })));
      } catch {
        // Hibernation owns close cleanup, and a reconnect asks for the whole
        // sidebar again, so a socket that missed this list is not left stale.
      }
    }
  }

  private async activeWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
    return (await this.readRelationship(workspaceId, userId))?.status === "active";
  }

  /**
   * Delete one page of processed connector event bodies past retention, on
   * the alarm rather than inside each ingest, so ingest stays short and an
   * Organization that stops receiving events still ages its old ones out.
   * Pending, processing and failed rows are never deleted.
   */
  private reapExpiredConnectorEvents(now: number): void {
    this.state.storage.sql.exec(
      `DELETE FROM workspace_connector_events
        WHERE event_id IN (
          SELECT event_id FROM workspace_connector_events
           WHERE processing_status = 'processed' AND received_at < ?
           ORDER BY received_at, event_sequence LIMIT ?
        )`,
      now - CONNECTOR_EVENT_BODY_RETENTION_MS,
      CONNECTOR_EVENT_REAP_PAGE,
    );
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
    diagnosticAttemptId?: string,
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
    this.logWorkspaceSocketHandshake(attachment, "sidebar_built", diagnosticAttemptId);
    const viewerPreferences = this.readMemberPreferences(attachment.userId);
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
      // An event with an audience replays only to it, as it was sent only to it.
      const rows = this.state.storage.sql.exec<{
        waterline: number;
        event_id: string;
        topics_json: string;
        occurred_at: number;
      }>(
        `SELECT waterline, event_id, topics_json, occurred_at FROM workspace_sync_events
          WHERE waterline > ?
            AND (audience_json IS NULL
                 OR EXISTS (SELECT 1 FROM json_each(audience_json) WHERE value = ?))
          ORDER BY waterline`,
        afterWaterline,
        attachment.userId,
      ).toArray();
      const newest = rows.at(-1);
      const changedTopics = new Set<WorkspaceSyncTopic>();
      for (const row of rows) {
        const stored: unknown = JSON.parse(row.topics_json);
        const retired = retiredSyncTopics(stored);
        if (retired.length > 0) {
          logInfo(this.env, "workspace_sync_retired_topics_dropped", {
            workspace_id: attachment.workspaceId, waterline: row.waterline, source: "sync_event", topics: retired,
          });
        }
        for (const topic of StoredSyncTopicsSchema.parse(stored)) {
          changedTopics.add(topic);
        }
      }
      events = [WorkspaceSocketSyncEventSchema.parse(newest ? {
        type: "workspace_sync",
        eventId: newest.event_id,
        // The log's waterline, not this person's newest event's: events for
        // other people after it are skipped, not pending, and a cursor left
        // behind them would fall out of the pruning window and cost a
        // `history_unavailable` refetch of everything.
        waterline: latest,
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
    this.logWorkspaceSocketHandshake(attachment, "flags_resolved", diagnosticAttemptId);
    for (const event of events) {
      socket.send(JSON.stringify(WorkspaceSocketSyncEventSchema.parse({
        ...event, conversationViews: true, featureFlags, viewerPreferences,
      })));
    }
    this.logWorkspaceSocketHandshake(attachment, "sync_sent", diagnosticAttemptId);
    socket.serializeAttachment({
      ...attachment,
      subscribed: true,
      lastWaterline: events.at(-1)?.waterline ?? Math.max(afterWaterline, latest),
    });
  }

  private logWorkspaceSocketHandshake(
    attachment: WorkspaceSocketAttachment,
    phase: "accepted" | "frame_received" | "subscribe_received" | "subscribe_authorized" | "sidebar_built" | "flags_resolved" | "sync_sent",
    diagnosticAttemptId?: string,
  ): void {
    logInfo(this.env, "workspace_socket_handshake", {
      phase,
      workspace_id: attachment.workspaceId,
      user_id: attachment.userId,
      connection_id: attachment.connectionId,
      ...(diagnosticAttemptId ? { diagnostic_attempt_id: diagnosticAttemptId } : {}),
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
        `SELECT member.role, member.access_class
           FROM workspace_members member
           JOIN workspaces workspace ON workspace.id = member.workspace_id
          WHERE member.workspace_id = ? AND member.user_id = ?
            AND member.status = 'active' AND workspace.region = ?
            AND workspace.abandoned_at IS NULL`,
      ).bind(identity.workspaceId, identity.userId, this.env.AVALON_REGION)
        .first<WorkspaceAuthRoleRow>()
      : await this.env.DB.prepare(
        // The workspace surrogate rides this query rather than being looked
        // up: a command socket authorizes itself on every frame anyway, and
        // `workspaces` is already joined. The person surrogate is not fetched
        // here — see `docs/performance-tracing.md` for where it comes from.
        `SELECT member.role, member.access_class, workspace.analytics_workspace_id
           FROM sessions session
           JOIN workspace_members member
             ON member.workspace_id = session.workspace_id
            AND member.user_id = session.user_id AND member.incarnation = session.workspace_incarnation
            AND member.status = 'active'
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
      ).first<WorkspaceAuthRoleRow>();
    if (role) await this.readRelationship(identity.workspaceId, identity.userId);
    return role ? {
      sessionId: identity.sessionId,
      userId: identity.userId,
      workspaceId: identity.workspaceId,
      region: this.env.AVALON_REGION,
      role: role.role,
      // Read as `member` when absent rather than as `guest`: the column is
      // `NOT NULL DEFAULT 'member'` in D1 and is left out only by the
      // development query above, so the other reading would hide every Space
      // from a developer's own sidebar.
      accessClass: role.access_class ?? "member",
      analyticsWorkspaceId: role.analytics_workspace_id ?? null,
    } : null;
  }

  /**
   * Close this workspace and record what closing it has to reach.
   *
   * Order is the whole point. The enumeration happens first, while the
   * directories still answer, and the tombstone lands in the same call — so
   * there is no window in which a caller writes into a workspace that is half
   * closed, and no second pass that reads an empty directory and concludes
   * there was nothing to retire.
   *
   * Idempotent by the same table. A resumed operation re-enters here and gets
   * the graph the first pass recorded, receipts included, rather than a fresh
   * and emptier one.
   */
  async beginWorkspaceRetirement(input: {
    retiredAt: number;
    operationId: string;
    actorUserId: string | null;
    reason: string;
    impersonationRevocation?: { workspaceId: string; authorityBasis: string };
  }): Promise<{ nodes: RetirementGraphNode[] }> {
    await this.initialized;
    const sql = this.state.storage.sql;
    // `INSERT OR IGNORE` rather than a replace: a node already receipted keeps
    // its receipt, so resuming never un-retires what the last pass finished.
    this.state.storage.transactionSync(() => {
      const now = Date.now();
      for (const row of sql.exec<{ workstream_id: string }>(
        "SELECT workstream_id FROM channels",
      ).toArray()) {
        sql.exec(
          `INSERT OR IGNORE INTO workspace_retirement_graph
             (parent_kind, parent_id, recorded_at, retired_at)
           VALUES ('workstream', ?, ?, NULL)`,
          row.workstream_id,
          now,
        );
      }
      // A Canvas's Chat is its own conversation object, closed with its Canvas.
      for (const { canvas_id: canvasId } of sql.exec<{ canvas_id: string }>("SELECT canvas_id FROM canvas_directory").toArray()) {
        sql.exec(
          `INSERT OR IGNORE INTO workspace_retirement_graph
             (parent_kind, parent_id, recorded_at, retired_at)
           VALUES ('canvas', ?, ?, NULL)`,
          canvasId,
          now,
        );
      }
      for (const row of sql.exec<{ automation_id: string }>(
        "SELECT automation_id FROM automation_directory",
      ).toArray()) {
        sql.exec(
          `INSERT OR IGNORE INTO workspace_retirement_graph
             (parent_kind, parent_id, recorded_at, retired_at)
           VALUES ('automation', ?, ?, NULL)`,
          row.automation_id,
          now,
        );
      }
      // Archived Spaces too. What is being closed is an object, not a product
      // surface: a Space created before 2026-09-26 still has a hidden main
      // conversation, and a graph that skipped it would report the
      // Organization retired with one of its objects still open. The walk
      // retires child `0` before the Space, the way it does for a Channel; for
      // a newer Space that object never existed and holds only the tombstone.
      for (const { space_id: spaceId } of sql.exec<{ space_id: string }>("SELECT space_id FROM spaces").toArray()) {
        sql.exec(
          `INSERT OR IGNORE INTO workspace_retirement_graph
             (parent_kind, parent_id, recorded_at, retired_at)
           VALUES ('space', ?, ?, NULL)`,
          spaceId,
          now,
        );
      }
    });
    if (input.impersonationRevocation) {
      this.assertWorkspace(input.impersonationRevocation.workspaceId);
      new WorkspaceImpersonationStorage(this.state.storage).revoke({
        workspaceId: input.impersonationRevocation.workspaceId,
        authorityBasis: input.impersonationRevocation.authorityBasis,
        now: new Date(input.retiredAt).toISOString(),
      });
    }
    await this.retireObject(input);
    return { nodes: this.retirementGraphNodes() };
  }

  /** One descendant confirmed retired. Terminal: a replay does not reopen it. */
  async recordRetiredNode(input: RetirementGraphNode): Promise<{ remaining: number; complete: boolean }> {
    await this.initialized;
    this.state.storage.sql.exec(
      `UPDATE workspace_retirement_graph
          SET retired_at = ?
        WHERE parent_kind = ? AND parent_id = ? AND retired_at IS NULL`,
      Date.now(),
      input.parentKind,
      input.parentId,
    );
    return this.retirementProgress();
  }

  /**
   * One conversation confirmed retired. Terminal and idempotent. It only lets
   * a later pass skip the child; the parent's receipt still decides completion.
   */
  async recordRetiredChild(input: { parentId: string; substreamId: string }): Promise<void> {
    await this.initialized;
    this.state.storage.sql.exec(
      `INSERT OR IGNORE INTO workspace_retirement_children (parent_id, substream_id, retired_at)
       VALUES (?, ?, ?)`,
      input.parentId,
      input.substreamId,
      Date.now(),
    );
  }

  /**
   * What the walk has left.
   *
   * Read after the tombstone, which is why it is permitted: an operator asking
   * why a retirement is stuck, and the walk itself deciding whether to keep
   * going, both need an answer from an object that refuses everything else.
   */
  async workspaceRetirementProgress(): Promise<{
    remaining: number;
    complete: boolean;
    nodes: (RetirementGraphNode & { retired: boolean })[];
  }> {
    await this.initialized;
    const progress = this.retirementProgress();
    const nodes = this.state.storage.sql.exec<{
      parent_kind: ConversationParentKind;
      parent_id: string;
      retired_at: number | null;
    }>(
      `SELECT parent_kind, parent_id, retired_at FROM workspace_retirement_graph
        ORDER BY parent_kind, parent_id`,
    ).toArray();
    return {
      ...progress,
      nodes: nodes.map((node) => ({
        parentKind: node.parent_kind,
        parentId: node.parent_id,
        retired: node.retired_at !== null,
      })),
    };
  }

  private retirementGraphNodes(): RetirementGraphNode[] {
    return this.state.storage.sql.exec<{
      parent_kind: ConversationParentKind;
      parent_id: string;
    }>(
      `SELECT parent_kind, parent_id FROM workspace_retirement_graph
        ORDER BY parent_kind, parent_id`,
    ).toArray().map((row) => ({ parentKind: row.parent_kind, parentId: row.parent_id }));
  }

  private retirementProgress(): { remaining: number; complete: boolean } {
    const rows = this.state.storage.sql.exec<{ remaining: number; total: number }>(
      `SELECT COUNT(*) FILTER (WHERE retired_at IS NULL) AS remaining,
              COUNT(*) AS total
         FROM workspace_retirement_graph`,
    ).toArray();
    const remaining = rows[0]?.remaining ?? 0;
    // Completeness is "this workspace was enumerated and nothing is left", and
    // the tombstone is what says the enumeration happened —
    // `beginWorkspaceRetirement` writes it in the same call that records the
    // graph. Reading it from the row count instead confused "nothing recorded
    // yet" with "nothing to record", so a demo with no work streams and no
    // automations reported incomplete on the first pass and on every pass
    // after it, and its register row could never be marked retired.
    const enumerated = readObjectRetirement(this.state.storage.sql) !== null;
    return { remaining, complete: enumerated && remaining === 0 };
  }

}

applyRetirementGate(WorkspaceDO, {
  permit: [
    // Retirement's own walk. These read and write the recorded graph, which
    // only exists to be usable once the tombstone has closed everything else,
    // so refusing them would leave the walk unable to find its descendants or
    // report that it had reached them.
    // Only the entry points. A permit carries the whole call beneath it, so the
    // private helpers these reach need no entry of their own.
    "purgeMeetingNoteObjects",
    "purgeMeetingSearchAuthorization",
    "finalizeMeetingRetirement",
    "retiredMeetingInventory",
    "beginWorkspaceRetirement",
    "recordRetiredNode",
    "recordRetiredChild",
    "workspaceRetirementProgress",
    // The walk's read of a hosted parent's children. The parent is closed
    // with this object; its conversations are still separate objects the walk
    // has to find and close.
    "childrenForRetirement",
  ],
  drop: {
    // A conversation's effects for a hosted parent, handed to the Queue before
    // the tombstone landed. Acknowledged as the legacy parents did, so the
    // message stops redelivering an effect nothing will apply.
    receiveChildEffects: ([input]) => ({ accepted: droppedEnvelopeReceipts(input) }),
    // `replayed` is this receiver's terminal answer — it already means "this
    // changed nothing, do not send it again", which is exactly true here.
    applyWorkstreamRegionalEffect: () => ({ replayed: true, notificationIntentId: null }),
    // An HTTP door refuses in the protocol it speaks rather than by throwing,
    // so a caller reads a status instead of a 500 it has to guess about.
    fetch: () => retiredObjectResponse(),
    // Hibernated socket callbacks. The socket is already dead to the product;
    // throwing here would only turn a quiet close into an error nobody reads.
    webSocketMessage: () => Promise.resolve(),
    webSocketClose: () => Promise.resolve(),
    webSocketError: () => Promise.resolve(),
    // The platform retries an alarm that throws. A retired object answers the
    // wake by doing nothing and arming nothing, which is what quiet means.
    alarm: () => Promise.resolve(),
  },
});
