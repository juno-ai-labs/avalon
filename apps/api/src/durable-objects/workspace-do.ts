import { CONNECTOR_EVENT_PEOPLE_MIGRATION, writeConnectorEventPeople, readConnectorEventPeople, copyConnectorEventPeople } from "./connector-event-people";
import { CANVA_POLL_SECONDS } from "@rally/connectors";
import { SCOPE_GRANT_DIRECTORY_SCHEMA, applyScopeGrantDirectory, scopeGrantCandidates, ScopeGrantCandidatesRequestSchema } from "./scope-grant-directory";
import {
  SharedNavigationSpaceSchema,
  SharedNavigationSpacesRequestSchema,
} from "@rally/contracts/scope-grants";
import { EFFECT_QUEUE_MESSAGE_MAX_BYTES, isPersonNotificationEffect, ParentEffectEnvelopeSchema } from "@rally/contracts/conversation-effects";
import { ConversationEffectEnvelopeSchema, type ConversationEffectEnvelope } from "@rally/contracts/conversation-effects";
import type { ConversationParentKind, ListVisiblePrivateChildrenRequest } from "@rally/contracts/conversation-parent";

/**
 * One object the retirement walk has to close before this workspace can report
 * complete.
 *
 * Typed as the full conversation-parent vocabulary while
 * `workspace_retirement_graph`'s own CHECK still admits only two of the three:
 * a Space is enumerated into this graph by the WorkspaceDO migration that
 * introduces the Space directory, and the CHECK widens in that same migration.
 * Widening the type first is what lets the walk's third arm — the one that
 * addresses `SPACE_DOS` — be written and reviewed beside the other two rather
 * than arriving as an untyped afterthought with the migration.
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
  type ActivityItem,
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
  readNotificationIntentForDelivery as readStoredPushIntent,
} from "./workspace-notification-intent-storage";

import {
  ExternalEventEvaluatorV1Schema,
  ExternalEventRegistrationProjectionV1Schema,
  WorkspaceExternalEventDeliveryQueueMessageSchema,
  WorkspaceExternalEventMatchResultSchema,
  asSpaceId,
  asWorkstreamId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  automationTriggersAdmitResourceType,
  IdSchema,
  SpaceConversationSchema,
  type ArtifactPin,
  type ChannelStats,
  type Pin,
  type PinKind,
  type SpaceConversation,
  UserIdSchema,
  SubstreamIdSchema,
  WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WORKSPACE_SYNC_TOPICS,
  WORKSTREAM_DESCRIPTION_MAX_CHARACTERS,
  MAX_WORKSTREAM_PIN_PLACEMENTS_PER_USER,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  workstreamParticipantPreview,
  WorkspaceIdSchema,
  WorkspaceAttentionSchema,
  WorkspaceSpaceConversationsEventSchema,
  WorkspaceSpaceSnapshotEventSchema,
  WorkspaceNavigationStateEventSchema,
  WorkspaceSidebarListEventSchema,
  WorkspaceWorkstreamRecencyEventSchema,
  WorkspaceSidebarSchema,
  WorkspaceWorkstreamPageEventSchema,
  WorkspaceSpaceChannelsEventSchema,
  ChannelRailSchema,
  type ChannelRail,
  WORKSTREAM_REALTIME_MAX_FRAME_BYTES,
  CHANNEL_RAILS_NAMED_LIMIT,
  type WorkspaceSocketClientEvent,
  WorkspaceWorkstreamStateEventSchema,
  WorkspaceSocketClientEventSchema,
  WorkspaceFeatureFlagsEventSchema,
  WorkspacePresenceEventSchema,
  WorkspaceReachChangedEventSchema,
  type ResourceHead,
  type WorkspaceResourceVersionsEvent,
  WorkspaceSocketSyncEventSchema,
  type MemberPreferences,
  WorkspaceSyncTopicSchema,
  WORKSTREAM_NAMING_GRACE_MS,
  WorkstreamIdSchema,
  WorkstreamSchema,
  type AutomationSummary,
  type WorkstreamAutomationSummary,
  type WorkspaceSidebar,
  type PersonalOrder,
  type SpaceErrorCode,
  type SpaceId,
  type SpaceColorKey,
  type SpaceDirectory,
  type SpaceSummary,
  spaceScopeForClient,
  type SpaceSnapshot,
  type Workstream,
  type WorkstreamId,
  type WorkspaceSocketSyncEvent,
  type WorkspaceSyncTopic,
  type WorkstreamBatchFilter,
  ProductFeatureFlagKeySchema,
  type ProductFeatureFlagKey,
  UpdateOnboardingJourneySchema,
  WorkstreamAppearanceSchema,
  type OnboardingJourney,
  type UpdateOnboardingJourney,
} from "@rally/contracts";
import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import type { OrganizationUsage, WorkspaceUsageEvent } from "@rally/contracts/usage";
import { WorkspaceAccessRequestsEventSchema } from "@rally/contracts";
import {
  AccessRequestRefSchema, AccessRequestSubjectRequestSchema, AccessRequestSubjectSchema, CONVERSATION_ACCESS_REQUESTS_MIGRATION,
  ConversationAccessRequestStorage, conversationMark, RecordAccessRequestSchema, ResolveAccessRequestSchema,
  type StoredAccessRequest,
} from "./conversation-access-request-storage";
import { truncateUtf16Safe } from "@rally/contracts/text";
import { listedResourceVisibilitySql } from "../services/resource-listing";
import { z } from "zod";
import {
  RevokeImpersonationRelationshipsRequestSchema,
  UpsertImpersonationRelationshipsRequestSchema,
} from "@rally/contracts";
import { WorkspaceImpersonationStorage } from "./workspace-impersonation-storage";
import {
  AuthorizationSnapshotSchema, AuthorizationSubjectSchema, AuthorizationResourceSchema,
  connectionAdmits, owningChannelAdmitsMember, sidekickAdmitsMember,
} from '../services/authorization-policy';
import { SearchAuthorizationSnapshotSchema, SearchAuthorizationTargetSchema, searchAuthorizationKey, searchDecisionFingerprint } from '../services/search-authorization';
import { flushAuthorizationDeliveries, type AuthorizationProjectionJob } from './authorization-projection';
import { AuthorizationStorage, AUTHORIZATION_STORAGE_MIGRATION, AUTHORIZATION_STORAGE_TABLES, AuthorizationLocationSchema, SPACE_MERGE_EMBED_LINKS_MIGRATION } from './authorization-storage';
import { ONBOARDING_JOURNEY_SQL, OnboardingJourneyStore } from './onboarding-journey';
import { RESOURCE_SEARCH_MIGRATION_STATEMENTS, RESOURCE_SEARCH_CONTENT_UPDATE_MIGRATION, RESOURCE_SEARCH_AUDIENCE_MIGRATION, ResourceSearchProjectionSchema, ResourceSearchRevisionRequestSchema,
  resourceSearchRevision, nextResourceSearchDueAt, publishResourceSearch, prepareResourceSearch, type ResourceSearchPace } from './resource-search-projection';
import {
  CHANNEL_MESSAGE_SEARCH_MIGRATION,
  ChannelMessageSearchProjectionSchema,
  ChannelMessageSearchRevisionRequestSchema,
  channelMessageSearchRevision,
  nextChannelMessageSearchDueAt,
  prepareChannelMessageSearch,
  publishChannelMessageSearch,
} from "./channel-message-search-projection";
import { isDraftUpload, requiresAttachment } from '../services/resource-read-rules';
import { searchAudienceGroup, searchAudienceGroupIds } from '../services/search-audience';
import { MEMORY_SEARCH_KEY_PURGE_MIGRATION, SEARCH_AUTHORIZATION_PUSH_MIGRATION } from './search-authorization-projection';
import {
  applyReportedSidekickAttachments,
  automationSummary,
  bumpChannelRail,
  CHANNEL_RAIL_MIGRATION,
  channelParticipantIds,
  ChannelRailFrames,
  channelRails,
  drainChannelRailChanges,
  mainAttachmentsUnreported,
  mainResourceLinksChanged,
  ownedAutomationSummaries,
  owningThreads,
  visibleSpaceChannelIdsAfter,
  type AutomationDirectoryRow,
  type InvalidAppearanceReport,
  type InvalidThreadAppearanceReport,
} from './channel-rails';
import { observeSqlWrites } from './sql-write-observer';
import { enumerateSearchAuthorizationUniverse, type SearchAuthorizationTarget } from './search-authorization-universe';
import { resolveWorkspaceEventResources } from "./workspace-event-resources";

import type { ParentEffectEnvelope } from "@rally/contracts/conversation-effects";
import type { AuthContext, Env } from "../env";
import { restrictedActivityUserIds } from "../lib/activity-visibility";
import { ApiError } from "../lib/api-error";
import { connectorRegistryForEnv } from "../lib/connector-registry";
import {
  assertDurableObjectJurisdiction,
  durableObjectStubForWorkspace,
  isWorkspacePlacementAffinityForRegion,
  workspacePlacementAffinity,
  type WorkspacePlacementAffinity,
} from "../lib/durable-object-namespace";
import { withDurableObjectSelf } from "../lib/durable-object-self";
import { judgeUnheardSockets, nextFirstFrameDeadline, type UnheardSocket } from "./socket-first-frame-watch";
import { parseRpcInput } from "../lib/rpc-input";
import { uuidV7 } from "../lib/uuid-v7";
import { resolveSpaceWorkstreamStart } from "../lib/channel-audience";
import { diagnosticErrorCode, logError, logInfo, logWarn } from "../observability/logger";
import {
  descendantRevocation,
  publishDescendantRevocations,
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
import { enqueueActivityDelivery, enqueuePushDelivery } from "../services/push-delivery-service";
import type { PushNotificationData } from "@rally/contracts/push-notifications";
import { activeMembersForActivity } from "../services/push-device-service";
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
import { claimParentAnchor } from "../services/workstream-runtime-database";
import { GENERAL_CHANNEL, PERSONAL_CHANNEL } from "./system-channels";
import { boundParameterChunks } from "./bound-parameters";
import { isBreakoutActivityEvent } from "./breakout-activity";
import { projectionSupersedes, type StoredProjection } from "./projection-fence";
import type { DurableObjectMigrationPlan } from "./migratable-durable-object";
import { conversationObjectName, workspaceDOName } from "./names";
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
  WorkspaceActivityEventInputSchema,
  WorkspaceActivityEventSourceRequestSchema,
  WorkspaceActivityEventSourceSchema,
  type WorkspaceActivityEventInput,
  type WorkspaceActivityEventSourceRequest,
} from "./workspace-activity-event-protocol";
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
  WorkspaceDigestClaimRequestSchema,
  WorkspaceDigestDefaultRequestSchema,
  WorkspaceDigestDeliveryContextRequestSchema,
  WorkspaceDigestDeliveryTargetsRequestSchema,
  WorkspaceDigestFireScheduleRequestSchema,
  WorkspaceDigestReplaceRequestSchema,
  WorkspaceDigestReplaceRowsRequestSchema,
  WorkspaceDigestRowStateRequestSchema,
  WorkspaceDigestSettingsRequestSchema,
  WorkspaceDigestSettleRequestSchema,
  WorkspaceDigestTargetDeliveredRequestSchema,
  WorkspaceDigestTargetFailedRequestSchema,
  WorkspaceDigestTerminalContextRequestSchema,
  type WorkspaceDigestClaimRequest,
  type WorkspaceDigestClaimResult,
  type WorkspaceDigestDefaultRequest,
  type WorkspaceDigestDefaultResult,
  type WorkspaceDigestDeliveryContext,
  type WorkspaceDigestDeliveryContextRequest,
  type WorkspaceDigestDeliveryTargets,
  type WorkspaceDigestDeliveryTargetsRequest,
  type WorkspaceDigestFireSchedule,
  type WorkspaceDigestFireScheduleRequest,
  type WorkspaceDigestReplaceRequest,
  type WorkspaceDigestReplaceResult,
  type WorkspaceDigestReplaceRowsRequest,
  type WorkspaceDigestRowState,
  type WorkspaceDigestRowStateRequest,
  type WorkspaceDigestSettings,
  type WorkspaceDigestSettingsRequest,
  type WorkspaceDigestSettleRequest,
  type WorkspaceDigestSettleResult,
  type WorkspaceDigestTargetDeliveredRequest,
  type WorkspaceDigestTargetFailedRequest,
  type WorkspaceDigestTargetOutcomeResult,
  type WorkspaceDigestTerminalContext,
  type WorkspaceDigestTerminalContextRequest,
} from "./workspace-digests-protocol";
import {
  claimWorkspaceDigestDelivery,
  ensureDefaultWorkspaceDigestSchedule,
  markWorkspaceDigestTargetDelivered,
  markWorkspaceDigestTargetFailed,
  replaceWorkspaceDigestSchedule,
  replaceWorkspaceDigestScheduleRows,
  settleWorkspaceDigestDelivery,
  workspaceDigestDeliveryContext,
  workspaceDigestDeliveryTargets,
  workspaceDigestScheduleForFire,
  workspaceDigestScheduleRowState,
  workspaceDigestSettings,
  workspaceDigestTerminalContext,
} from "./workspace-digests-storage";
import {
  WorkspaceDirectoryApplyRequestSchema,
  WorkspaceAttentionRequestSchema,
  WorkspaceDirectoryBatchTargetsRequestSchema,
  WorkspaceDirectoryBatchTargetsResultSchema,
  WorkspaceBatchDispatchAdvanceRequestSchema,
  WorkspaceBatchDispatchAdvanceResultSchema,
  WorkspaceBatchDispatchBeginRequestSchema,
  WorkspaceBatchDispatchBeginResultSchema,
  WorkspaceDirectoryApplyResultSchema,
  WorkspaceDirectoryDueRequestSchema,
  WorkspaceDirectoryListRequestSchema,
  WorkspaceDirectoryLookupRequestSchema,
  WorkspaceLinkTitleRequestSchema,
  WorkspaceDirectoryLookupResultSchema,
  WorkspaceDirectoryRecentRequestSchema,
  WorkspaceDirectoryReadableIdsRequestSchema,
  WorkspaceDirectoryReadableIdsResultSchema,
  WorkspaceDirectorySearchableIdsResultSchema,
  WorkspaceDirectoryNotificationRequestSchema,
  WorkspaceDirectoryNotificationStateSchema,
  WorkspaceDirectoryPageSchema,
  WorkspaceDirectoryPinRequestSchema,
  WorkspaceDirectoryReorderPinsRequestSchema,
  WorkspaceDirectoryResourceAccessRequestSchema,
  WorkspaceDirectoryResourceAccessResultSchema,
  WorkspaceDirectoryResourceRequestSchema,
  WorkspaceDirectoryResourceResultSchema,
  WorkspaceDirectoryScheduleTargetsRequestSchema,
  WorkspaceDirectoryScheduleTargetsResultSchema,
  WorkspaceDirectoryVisibilityRequestSchema,
  WorkspaceDirectoryVisibleIdsRequestSchema,
  WorkspaceDirectoryVisibleIdsPageSchema,
  WorkspaceRegionalEffectApplyRequestSchema,
  WorkspaceRegionalEffectApplyResultSchema,
  type WorkspaceDirectoryApplyRequest,
  type WorkspaceAttentionRequest,
  type WorkspaceAttentionResult,
  type WorkspaceDirectoryBatchTargetsRequest,
  type WorkspaceBatchDispatchAdvanceRequest,
  type WorkspaceBatchDispatchBeginRequest,
  type WorkspaceDirectoryApplyResult,
  type WorkspaceDirectoryDueRequest,
  type WorkspaceDirectoryListRequest,
  type WorkspaceDirectoryLookupRequest,
  type WorkspaceDirectoryLookupResult,
  type WorkspaceDirectoryRecentRequest,
  type WorkspaceDirectoryReadableIdsRequest,
  type WorkspaceDirectoryReadableIdsResult,
  type WorkspaceDirectoryPage,
  type WorkspaceDirectoryPinRequest,
  type WorkspaceDirectoryReorderPinsRequest,
  type WorkspaceDirectoryResourceAccessRequest,
  type WorkspaceDirectoryResourceAccessResult,
  type WorkspaceDirectoryNotificationRequest,
  type WorkspaceDirectoryNotificationState,
  type WorkspaceDirectoryResourceRequest,
  type WorkspaceDirectoryResourceResult,
  type WorkspaceDirectoryScheduleTargetsRequest,
  type WorkspaceDirectoryScheduleTargetsResult,
  type WorkspaceDirectoryVisibilityRequest,
  type WorkspaceDirectoryVisibleIdsRequest,
  type WorkspaceDirectoryVisibleIdsPage,
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
  WorkspaceMemoryTableOpenReceiptRequestSchema,
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
  type WorkspaceMemoryTableOpenReceiptRequest,
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
  recordWorkspaceMemoryTableOpenReceipt,
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
import { WORKSPACE_PRODUCT_SCHEMA_STATEMENTS } from "./workspace-product-schema";
import { WorkspaceProductStorage } from "./workspace-product-storage";
import {
  publishSpaceBootstrapWork,
  publishSpaceDefaultTargets,
} from "./workspace-space-default-publication";
import {
  SpaceDefaultQueueMessageSchema,
  SpaceDefaultTargetFailureRequestSchema,
  WorkspaceChannelSpacesRequestSchema,
  WorkspaceChannelSpacesResultSchema,
  WorkspaceCanonicalChannelSpaceRequestSchema,
  WorkspaceCanonicalChannelSpaceResultSchema,
  WorkspaceSpaceAudienceNoteRequestSchema,
  WorkspaceSpaceInviteesRequestSchema,
  WorkspaceSpaceSeatInviteeRequestSchema,
  WorkspaceSpaceBootstrapStatusSchema,
  WorkspaceSpaceChannelPageRequestSchema,
  WorkspaceSpaceChannelPageResultSchema,
  WorkspaceChannelFeedResultSchema,
  WorkspaceActivityPushReadRequestSchema,
  WorkspaceActivityPushReadResultSchema,
  WorkspaceActivityRequestSchema,
  WorkspaceActivityResultSchema,
  WorkspaceActivitySeenRequestSchema,
  WorkspaceActivityEventsRequestSchema,
  type WorkspaceActivityPushReadRequest,
  type WorkspaceActivityRequest,
  type WorkspaceActivityResult,
  type WorkspaceActivitySeenRequest,
  type WorkspaceActivityEventsRequest,
  WorkspaceMyThreadsRequestSchema,
  WorkspaceMyThreadsResultSchema,
  WorkspacePinChangeRequestSchema,
  WorkspacePinOrderRequestSchema,
  WorkspacePinResultSchema,
  WorkspaceArtifactPinChangeRequestSchema,
  WorkspaceArtifactPinOrderRequestSchema,
  WorkspaceArtifactPinResultSchema,
  type WorkspaceArtifactPinChangeRequest,
  type WorkspaceArtifactPinOrderRequest,
  type WorkspaceArtifactPinResult,
  WorkspaceChannelStatsResultSchema,
  WorkspaceSpaceReadRequestSchema,
  type WorkspaceSpaceReadRequest,
  WorkspaceSpaceReadResultSchema,
  type WorkspaceSpaceReadResult,
  type WorkspaceChannelStatsResult,
  type WorkspaceChannelFeedResult,
  type WorkspaceMyThreadsRequest,
  type WorkspaceMyThreadsResult,
  type WorkspacePinChangeRequest,
  type WorkspacePinOrderRequest,
  type WorkspacePinResult,
  WorkspaceSpaceDefaultRequestSchema,
  WorkspaceSpaceDefaultResultSchema,
  WorkspaceSpaceBootstrapPageSchema,
  WorkspaceSpaceBootstrapFinalizeResultSchema,
  WorkspaceSpaceBootstrapSettleRequestSchema,
  WorkspaceContainerOrderResultSchema,
  WorkspacePinnedOrderRequestSchema,
  WorkspacePinnedOrderResultSchema,
  type WorkspacePinnedOrderRequest,
  type WorkspacePinnedOrderResult,
  WorkspaceSpaceListRequestSchema,
  WorkspaceSpaceGeneralOpenResultSchema,
  WorkspaceSpaceGeneralRequestSchema,
  WorkspaceGeneralOpeningSchema,
  WorkspaceSeatMemberRequestSchema,
  personalSpaceIdFor,
  type WorkspaceSeatMemberRequest,
  type WorkspaceSeatMemberResult,
  type WorkspaceGeneralOpening,
  WorkspaceSpaceMembershipMoveOutcomeSchema,
  WorkspaceSpaceMembershipMoveRequestSchema,
  WorkspaceSpaceMutationResultSchema,
  WorkspaceSpaceAudienceResultSchema,
  WorkspaceSpaceReserveResultSchema,
  WorkspaceSpacePresentationRequestSchema,
  WorkspaceContainerOrderRequestSchema,
  WorkspaceSpaceRequestSchema,
  WorkspaceSpaceIntentFailureRequestSchema,
  WorkspaceSpaceIntentReceiptRequestSchema,
  WorkspaceSpaceReserveRequestSchema,
  WorkspaceChannelReservationRequestSchema,
  WorkspaceChannelReservationResultSchema,
  WorkspaceSpaceChannelChangeRequestSchema,
  WorkspaceChannelMergeRequestSchema,
  WorkspaceChannelMergeResultSchema,
  WorkspaceChannelMergeTargetRequestSchema,
  WorkspaceChannelMergeTargetResultSchema,
  WorkspaceThreadMergePlacementRequestSchema,
  WorkspaceThreadMergePlacementResultSchema,
  type WorkspaceThreadMergePlacementRequest,
  type WorkspaceThreadMergePlacementResult,
  WorkspaceChannelMessageRemoveRequestSchema,
  type WorkspaceChannelMergeRequest,
  type WorkspaceChannelMergeResult,
  type WorkspaceChannelMergeTargetRequest,
  type WorkspaceChannelMergeTargetResult,
  type WorkspaceChannelMessageRemoveRequest,
  type WorkspaceChannelMessageRemoveResult,
  WorkspaceGeneralPlacementRequestSchema,
  WorkspaceSpaceIntentResumeRequestSchema,
  type SpaceChannelRefusal,
  type WorkspaceSpaceChannelChangeRequest,
  type WorkspaceGeneralPlacementRequest,
  type WorkspaceSpaceChannelChangeResult,
  type WorkspaceSpaceIntentResumeRequest,
  type WorkspaceSpaceIntentResumeResult,
  type WorkspaceChannelReservationRequest,
  type WorkspaceChannelReservationResult,
  type SpaceDefaultQueueMessage,
  type SpaceDefaultTargetFailureRequest,
  type WorkspaceChannelSpacesRequest,
  type WorkspaceChannelSpacesResult,
  type WorkspaceCanonicalChannelSpaceRequest,
  type WorkspaceCanonicalChannelSpaceResult,
  type WorkspaceSpaceAudienceNoteRequest,
  type WorkspaceSpaceInviteesRequest,
  type WorkspaceSpaceSeatInviteeRequest,
  type WorkspaceSpaceBootstrapStatus,
  type WorkspaceSpaceChannelPageRequest,
  type WorkspaceSpaceChannelPageResult,
  type WorkspaceSpaceDefaultRequest,
  type WorkspaceSpaceDefaultResult,
  type WorkspaceSpaceBootstrapFinalizeResult,
  type WorkspaceSpaceBootstrapPage,
  type WorkspaceSpaceBootstrapSettleRequest,
  type WorkspaceContainerOrderResult,
  type WorkspaceSpaceListRequest,
  type WorkspaceSpaceGeneralOpenResult,
  type WorkspaceSpaceGeneralRequest,
  type WorkspaceSpaceMembershipMoveOutcome,
  type WorkspaceSpaceMembershipMoveRequest,
  type WorkspaceSpaceMutationResult,
  type WorkspaceSpaceAudienceResult,
  type WorkspaceSpaceReserveResult,
  type WorkspaceSpacePresentationRequest,
  type WorkspaceContainerOrderRequest,
  type WorkspaceSpaceRequest,
  type WorkspaceSpaceIntentFailureRequest,
  type WorkspaceSpaceIntentReceiptRequest,
  type WorkspaceSpaceReserveRequest,
} from "./workspace-space-protocol";
import {
  breakoutListedSql,
  channelListed,
  channelListedSql,
  mainOpenableSql,
  member,
  admitsOrganizationWide,
  organizationWide as organizationWideAdmits,
  organizationWideSql,
  spaceListedSql,
  type AccessClass,
  type Viewer,
} from "./listing-rules";
import {
  SPACE_BOOTSTRAP_PAGE_SIZE,
  WORKSPACE_SPACE_SCHEMA_STATEMENTS,
  WORKSPACE_PINNED_ORDER_MIGRATION,
  SPACE_PUBLIC_ONLY_MIGRATION,
  SPACE_INDIVIDUAL_SCOPE_MIGRATION,
  SPACE_MESSAGES_MIGRATION,
  SPACE_MESSAGE_MERGES_MIGRATION,
  SPACE_INVITEES_MIGRATION,
  WorkspaceSpaceStorage,
  type WorkspaceSpaceIntentClaim,
  type SpaceConversationKey,
} from "./workspace-space-storage";
import {
  artifactSubjectKeySql,
  artifactUpdateSql,
  isArtifactNewsCause,
  WorkspacePinStorage,
  WORKSPACE_ARTIFACT_PINS_MIGRATION,
  RESOURCE_VERSIONS_QUEUE_ARTIFACT_UPDATE,
  WORKSPACE_ARTIFACT_UPDATES_MIGRATION,
  WORKSPACE_PINS_MIGRATION,
} from "./workspace-pin-storage";
import { type ChannelReadState, WORKSPACE_CHANNEL_READS_MIGRATION } from "./workspace-channel-read-storage";
import {
  drainResourceVersionChanges,
  readResourceHeads,
  resourceVersionLedgerReady,
  type ResourceVersionChange,
  WORKSPACE_RESOURCE_VERSION_CHANGES_MIGRATION,
} from "./workspace-resource-versions";
import {
  CHANNEL_COLOR_SYNC_MIGRATION,
  ChannelColorSyncMessageSchema,
  ChannelColorWorkSchema,
  channelColorWork,
  completeChannelColorSync,
  nextChannelColorSyncAt,
  publishChannelColorSync,
  releaseChannelColorSync,
  type ChannelColorSyncMessage,
  type ChannelColorWork,
} from "./channel-color-sync";
import {
  IMPORT_RESERVATION_RECLAIM_MIGRATION,
  armImportReservationReclaim,
  nextImportReservationReclaimAt,
  reclaimDueImportReservations,
} from "./import-reservation-reclaim";
import { retireUnopenedImportKey } from "../services/session-import-reclaim";
import {
  SUGGESTION_BACKFILL_MIGRATION,
  THREAD_BACKFILL_MIGRATION,
  ThreadBackfillMessageSchema,
  completeThreadBackfill,
  nextThreadBackfillAt,
  publishThreadBackfill,
  releaseThreadBackfill,
  threadBackfillWork,
  type ThreadBackfillMessage,
  type ThreadBackfillWork,
} from "./thread-backfill";
import { unreadState } from "./unread-state";
import { artifactActivityId, WorkspaceActivityFeed, WORKSPACE_ACTIVITY_READS_MIGRATION } from "./workspace-activity-feed";
import { ACTIVITY_PUSH_KINDS, WorkspaceActivityPushes, WORKSPACE_ACTIVITY_PUSH_MIGRATION, type ActivityPushSubject } from "./workspace-activity-push";
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
  NOTIFICATION_KIND_FOR_PUSH,
  notificationAllows,
  savedNotify,
  storedMemberPreferences,
  storedPushPreferences,
  type NotificationAllowsRequest,
  type MemberPreferencesReadRequest,
  type MemberPreferencesWriteRequest,
} from "./member-preferences";
import {
  SELECT_WORKSPACE_BREAKOUT,
  WORKSPACE_BREAKOUT_SCHEMA_STATEMENTS,
  WorkspaceBreakoutStorage,
  type WorkspaceBreakoutRow,
} from "./workspace-breakout-storage";
import { HOSTED_PARENT_SCHEMA_STATEMENTS } from "./hosted-parent-schema";
import {
  HOSTED_CHANNEL_ROLE,
  HOSTED_SPACE_ROLE,
  HostedParent,
  channelViewerStates,
  parentControlSocketTag,
  readControlSocketAttachment,
  runningBackgroundAgents,
  visiblePrivateChildren,
  type ChannelViewerState,
  type HostedParentHost,
} from "./hosted-parent";
import { planParentEffectBatches, ReceiveChildEffectsRequestSchema } from "./conversation-parent-object";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import {
  HostedParticipantProjectionAlarmSchema,
  PARTICIPANT_MIGRATION_ALARM,
  PARTICIPANT_PROJECTION_ALARM,
} from "./scope-grant-storage";
import { SCOPE_INVITATION_DELIVERY_ALARM, SCOPE_INVITATION_INDEX_ALARM } from "./scope-invitation-storage";
import {
  applyWorkstreamRegionalEnvelope,
  insertWorkstreamEffectReceipt,
} from "./workspace-regional-effect-storage";
import {
  WorkspaceConnectorResourceResolveRequestSchema,
  WorkspaceDiscoveredResourcesRequestSchema,
  WorkspaceExpiredDraftReapRequestSchema,
  WorkspaceInboundEmailClaimRequestSchema,
  WorkspaceInboundEmailFailureRequestSchema,
  WorkspaceInboundEmailLeaseRequestSchema,
  WorkspaceInboundEmailResourceRequestSchema,
  WorkspaceInboundEmailSettleRequestSchema,
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
  type WorkspaceInboundEmailClaimRequest,
  type WorkspaceInboundEmailClaimResult,
  type WorkspaceInboundEmailFailureRequest,
  type WorkspaceInboundEmailLeaseRequest,
  type WorkspaceInboundEmailLeaseResult,
  type WorkspaceInboundEmailResourceRequest,
  type WorkspaceInboundEmailResourceResult,
  type WorkspaceInboundEmailSettleRequest,
  type WorkspaceInboundEmailSettleResult,
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
  claimWorkspaceInboundEmailReceipt,
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
  recordWorkspaceInboundEmailFailure,
  recordWorkspaceResourceObjectCleanupFailure,
  refreshWorkspaceResourceHydration,
  renameWorkspaceResource,
  renewWorkspaceInboundEmailLease,
  resolveWorkspaceConnectorResource,
  retireWorkspaceResourceObjectStaging,
  settleWorkspaceInboundEmailProcessed,
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
  ExternalRoomLinkRequestSchema,
  ExternalRoomSpaceMatchRequestSchema,
  type ExternalRoomSpaceMatchResult,
  type ExternalBindingResolution,
  type ExternalRoomLinkResult,
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
  admissionAddress,
  attachSidekickConversation,
  conversationIdOf,
  conversationsTitled,
  describeConversation,
  matchConversationReference,
  parseConversationId,
  scopeConversations,
  type ScopedConversation,
} from "./workspace-sidekick-conversation-storage";
import { HOSTED_SIDEKICK_SCHEMA_STATEMENTS } from "./hosted-sidekick-schema";
import {
  HostedSidekick,
  hostedSidekickAlarmTarget,
  skillSource,
  skillSummary,
  type HostedSidekickRow,
  sidekickReaderAllows,
  type HostedSidekickHost,
} from "./hosted-sidekick";
import {
  SidekickBatchDetailRequestSchema,
  SidekickBatchSkillReadRequestSchema,
  type SidekickBatchDetailRequest,
  type SidekickBatchSkillReadRequest,
  SidekickRunProvisionQueueMessageSchema,
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
  type ConversationToolScope,
  type ConversationToolScopeResult,
} from "./workspace-conversation-tool-protocol";

const WORKSPACE_TYPED_RPC_ONLY_TABLES = [
  "scope_grant_directory",
  "connector_installations", "connector_installation_steps",
  ...AUTHORIZATION_STORAGE_TABLES,
  'search_authorization_push', 'search_authorization_keys', 'search_authorization_dependencies',
  "resource_search_versions",
  "channel_message_search_versions", // Its triggers, the alarm lane and the Channel message search RPCs.
  "onboarding_journeys",
  "conversation_access_requests",
  "workstream_notification_intents",
  "workspace_socket_unheard", // The first-frame watch's ledger.
  "channel_color_sync", "channel_color_sync_state", // Its triggers, the alarm lane and the channel-colour RPCs.
  "thread_backfill", // The alarm lane and the thread-backfill RPCs.
  "import_reservation_reclaim", // Armed by the import reservation, read by its alarm lane.
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
  "sidekick_children", "sidekick_child_projections", "sidekick_child_receipts",
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

/** One person's subscribed sockets, under the relationship they were admitted with. */
interface WorkspaceChannelRowReader {
  userId: string;
  workspaceId: string;
  accessClass: "member" | "guest";
  sockets: WebSocket[];
}

/** What every person's Channel rows in one send share. */
interface ChannelRowShared {
  occurredAt: string;
  previews: Map<string, ReturnType<typeof workstreamParticipantPreview>>;
  background: Map<string, Map<string, number>>;
}

interface WorkspaceDirectoryRow extends Record<string, SqlStorageValue> {
  resolved: number;
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
  created_by_user_id: string | null;
  title_status: "naming" | "automatic" | "settled";
  appearance_json: string | null;
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
  last_accessed_at: number | null;
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
// (opportunity windows, reaped 30 days after they finish; a run's trigger
// context; an opportunity's origin) reaches back well inside that. Only
// processed rows age out: their two unique keys are the replay fence, so a
// provider redelivering an event older than this would be processed again.
const CONNECTOR_EVENT_BODY_RETENTION_MS = 90 * 24 * 60 * 60_000;
/**
 * Processed event bodies deleted per alarm pass. The number the ingest path
 * used before the reap moved here; the alarm re-arms at once while any are
 * due, so a backlog drains a page at a time.
 */
const CONNECTOR_EVENT_REAP_PAGE = 50;
const ACTIVITY_EVENT_RETENTION_MS = 90 * 24 * 60 * 60_000;
const PRODUCT_ALARM_BATCH = 6;
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
/** `_internal_durable_alarms` identity for this workspace's opportunity and ranking work. */
const PRODUCT_ALARM_KIND = "product";
const PRODUCT_ALARM_KEY = "workspace";
/** The one-shot entry a migrating object uses to reconcile itself once. */
const SCHEDULE_BOOTSTRAP_ALARM_KIND = "schedule_bootstrap";
/** One-shot, written by migration 103: seat every existing member. See docs/spaces.md#the-personal-channel. */
const PERSONAL_CHANNEL_BACKFILL_ALARM_KIND = "personal_channel_backfill";
/** The kinds `refreshSchedule` reconciles, each dispatched to the schedule runner. */


function isWorkspaceScheduleAlarmKind(kind: string): kind is WorkspaceScheduleTargetKind {
  return (WORKSPACE_SCHEDULE_ALARM_KINDS as readonly string[]).includes(kind);
}

/**
 * Every table emptied when `projects` is dropped: four cascade from it
 * directly, and two more cascade from `project_default_resources` beneath it.
 * Ordered parents-first so the list can be replayed as inserts.
 */
/**
 * A hosted-parent transaction met somebody the member table has never heard
 * of. It rolls the transaction back; the caller learns them with one D1 read
 * each and runs the operation again (`withMembersLearned`).
 */
class UnknownMembersError extends Error {
  constructor(readonly userIds: readonly string[]) {
    super("workspace_member_unknown");
  }
}

/** A refusal raised inside `reserveChannelInSpaces`'s transaction, so it rolls back. */
class ChannelReservationRefused extends Error {
  constructor(readonly code: SpaceErrorCode, readonly spaceId: string) {
    super(code);
  }
}

/** The external thread a reservation named could not be claimed; it rolls back too. */
class ChannelBindingRefused extends Error {
  constructor(readonly outcome: "held" | "bound") {
    super(`external_binding_${outcome}`);
  }
}

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
  // older Worker never reads a row it cannot parse; see docs/workstream-pinning.md.
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
  // Triggers mark a thread whenever its colour can move; see channel-color-sync.ts.
  statements: CHANNEL_COLOR_SYNC_MIGRATION,
}, {
  version: 100,
  description: "a work list of one-off jobs over every thread, and every thread listed to have its description summarized",
  // The lane is channel colour sync's without triggers; see thread-backfill.ts.
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
  // reconciler rebuilds them on the same visit. See docs/digests.md.
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
  // See WORKSPACE_ARTIFACT_PINS_MIGRATION and docs/workstream-pinning.md.
  statements: WORKSPACE_ARTIFACT_PINS_MIGRATION,
}, {
  version: 111,
  description: "a ledger of new versions of pinned artifacts, for their Activity rows and pushes",
  // See WORKSPACE_ARTIFACT_UPDATES_MIGRATION and docs/workstream-pinning.md#artifact-pins.
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
}];

function conversationToolEntry(conversation: {
  conversationId: string; parentId: string; substreamId: string; kind: ConversationToolEntry["kind"];
  title: string; isHome: boolean; isOwn: boolean; isParent: boolean;
}): ConversationToolEntry {
  return {
    conversationId: conversation.conversationId,
    parentId: conversation.parentId,
    substreamId: asSubstreamId(conversation.substreamId),
    kind: conversation.kind,
    title: conversation.title,
    isHome: conversation.isHome,
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
  | "presence"
  | "list_workstreams"
  | "channel_rails"
  | "space_channels";

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

function loadParticipantPreviews(
  sql: DurableObjectState["storage"]["sql"],
  workstreamIds: readonly string[],
): Map<string, ReturnType<typeof workstreamParticipantPreview>> {
  const previews = new Map<string, ReturnType<typeof workstreamParticipantPreview>>();
  for (const [workstreamId, userIds] of channelParticipantIds(sql, workstreamIds)) {
    previews.set(workstreamId, workstreamParticipantPreview(userIds));
  }
  return previews;
}

function directoryWorkstream(
  row: WorkspaceDirectoryRow,
  workspaceId: string,
  preview: ReturnType<typeof workstreamParticipantPreview> = {
    participantUserIds: [],
    participantExtraCount: 0,
  },
  spaceIds: readonly string[] = [],
  spacePins: readonly { spaceId: string; position: number }[] = [],
  breakoutAttentionCount = 0,
  mainOpen = true,
): Workstream {
  const latest = Number(row.latest_attention_ordinal);
  const manual = row.manual_unread_from_ordinal === null
    ? null
    : Number(row.manual_unread_from_ordinal);
  const { readThrough: seen, firstUnread, hasUnread } = unreadState({
    latest,
    seen: row.seen_attention_ordinal === null ? null : Number(row.seen_attention_ordinal),
    trackingStart: Number(row.unread_tracking_start_ordinal),
    manual,
  });
  const titleStatus = settledTitleStatus(row.title_status, row.source_created_at);
  const participantPreview = row.scope === "personal"
    ? preview
    : { participantUserIds: [], participantExtraCount: 0 };
  return WorkstreamSchema.parse({
    id: row.workstream_id,
    workspaceId,
    title: truncateUtf16Safe(row.title, 180),
    titleStatus,
    appearance: row.appearance_json ? WorkstreamAppearanceSchema.parse(JSON.parse(row.appearance_json)) : undefined,
    objective: truncateUtf16Safe(row.description, WORKSTREAM_DESCRIPTION_MAX_CHARACTERS),
    emailAddress: row.email_address,
    createdByUserId: row.created_by_user_id,
    harnessStatus: workstreamHarnessStatus(row.exact_state),
    latestAttentionSequenceNumber: latest,
    readThroughSequenceNumber: seen,
    manualUnreadFromSequenceNumber: manual,
    manualUnreadGeneration: Number(row.manual_unread_generation ?? 0),
    hasUnread,
    youAreMentioned: Number(row.latest_mention_attention_ordinal ?? 0) > seen,
    unseen: row.unseen === 1,
    isParticipant: row.is_participant === 1,
    firstUnreadSequenceNumber: firstUnread,
    lastActivityAt: iso(row.last_activity_at),
    createdAt: iso(row.source_created_at),
    updatedAt: iso(row.source_updated_at),
    archivedAt: iso(row.archived_at),
    ...(row.resolved === 1 ? { resolved: true } : {}),
    scope: row.scope,
    systemKind: row.system_kind,
    nextPendingWakeup: row.next_wakeup_due_at !== null && row.next_wakeup_prompt
      ? {
          dueAt: iso(row.next_wakeup_due_at),
          promptPreview: truncateUtf16Safe(row.next_wakeup_prompt.replace(/\s+/gu, " ").trim(), 40),
        }
      : null,
    pinPosition: row.pin_position,
    spacePins,
    lastAccessedAt: iso(row.last_accessed_at),
    spaceIds,
    breakoutAttentionCount,
    ...participantPreview,
    ...(mainOpen ? {} : mainWithheld(row)),
  });
}

/**
 * The fields of a Channel row that are its Main's, emptied for somebody the
 * Channel is listed to only through a Breakout (`docs/listing-rules.md`).
 *
 * Listing names the Channel so its Breakouts have a place to sit; it is not
 * Main's authority. Main's description, email address, author, run state,
 * unread position, activity time, wake-up and roster stay with Main. What is
 * left is the name, the appearance, the scope and this person's own
 * placement, pins and Breakout counts.
 */
function mainWithheld(row: WorkspaceDirectoryRow): Partial<Workstream> {
  return {
    objective: "",
    emailAddress: null,
    createdByUserId: null,
    harnessStatus: "idle",
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    youAreMentioned: false,
    unseen: false,
    firstUnreadSequenceNumber: null,
    lastActivityAt: new Date(row.source_created_at).toISOString(),
    nextPendingWakeup: null,
    participantUserIds: [],
    participantExtraCount: 0,
    mainWithheld: true,
  };
}

/** Whether this viewer may open a directory row's Main: {@link mainOpenableSql} for a row already read. */
function mainOpenFor(row: WorkspaceDirectoryRow, accessClass: Viewer["accessClass"]): boolean {
  return organizationWideAdmits(row.scope, accessClass) || row.is_participant === 1;
}

/** A Channel's per-viewer state without Main's part: its agents and its rail. */
function withoutMainState(state: ChannelViewerState | undefined): Partial<ChannelViewerState> | undefined {
  if (!state) return undefined;
  const backgroundAgentCounts = Object.fromEntries(
    Object.entries(state.backgroundAgentCounts).filter(([substreamId]) => substreamId !== "0"),
  );
  return { ...state, backgroundAgentCounts, railWaterline: 0 };
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
/**
 * A title status with the naming grace applied.
 *
 * `naming` is a promise that a name is on its way, and the skeleton a client
 * draws for it is only honest while that is true. A naming pass that died —
 * the model refused, the object was evicted mid-run — leaves the status behind
 * it forever, so past {@link WORKSTREAM_NAMING_GRACE_MS} from the
 * conversation's own creation the row reads as `automatic` and the client
 * draws the title it actually has.
 *
 * Here rather than inline in each projection because a Channel and one of its
 * breakouts sit in the same dashboard list: a breakout that kept its skeleton
 * while the Channel beside it had stopped showing one would read as a
 * difference between the two kinds rather than as the bug it is.
 */
function settledTitleStatus(
  titleStatus: "naming" | "automatic" | "settled",
  sourceCreatedAt: number,
): "naming" | "automatic" | "settled" {
  return titleStatus === "naming" && Date.now() - sourceCreatedAt > WORKSTREAM_NAMING_GRACE_MS
    ? "automatic"
    : titleStatus;
}

function breakoutConversation(
  row: WorkspaceBreakoutRow,
  workspaceId: string,
  spaceIds: readonly string[],
): SpaceConversation {
  const latest = Number(row.latest_attention_ordinal);
  const manual = row.manual_unread_from_ordinal === null
    ? null
    : Number(row.manual_unread_from_ordinal);
  const { readThrough: seen, firstUnread, hasUnread } = unreadState({
    latest,
    seen: row.seen_attention_ordinal === null ? null : Number(row.seen_attention_ordinal),
    trackingStart: Number(row.unread_tracking_start_ordinal),
    manual,
  });
  return SpaceConversationSchema.parse({
    id: row.substream_id,
    workspaceId,
    title: truncateUtf16Safe(row.title, 180),
    ...(row.appearance_json
      ? { appearance: WorkstreamAppearanceSchema.parse(JSON.parse(row.appearance_json)) }
      : {}),
    titleStatus: settledTitleStatus(row.title_status, row.source_created_at),
    objective: truncateUtf16Safe(row.description, WORKSTREAM_DESCRIPTION_MAX_CHARACTERS),
    emailAddress: null,
    createdByUserId: row.created_by_user_id,
    harnessStatus: workstreamHarnessStatus(row.exact_state),
    latestAttentionSequenceNumber: latest,
    readThroughSequenceNumber: seen,
    manualUnreadFromSequenceNumber: manual,
    manualUnreadGeneration: Number(row.manual_unread_generation ?? 0),
    hasUnread,
    youAreMentioned: Number(row.latest_mention_attention_ordinal ?? 0) > seen,
    unseen: row.unseen === 1,
    firstUnreadSequenceNumber: firstUnread,
    lastActivityAt: iso(row.last_activity_at),
    createdAt: iso(row.source_created_at),
    updatedAt: iso(row.source_updated_at),
    archivedAt: iso(row.archived_at),
    ...(row.resolved === 1 ? { resolved: true } : {}),
    scope: row.scope,
    systemKind: null,
    nextPendingWakeup: null,
    pinPosition: null,
    lastAccessedAt: null,
    spaceIds: [...spaceIds],
    participantUserIds: [],
    participantExtraCount: 0,
    kind: "breakout",
    breakoutOf: {
      workstreamId: row.workstream_id,
      substreamId: row.substream_id,
      title: truncateUtf16Safe(row.parent_title, 180),
      ...(row.parent_appearance_json
        ? { appearance: WorkstreamAppearanceSchema.parse(JSON.parse(row.parent_appearance_json)) }
        : {}),
    },
  });
}

function mapDirectoryWorkstreams(
  sql: DurableObjectState["storage"]["sql"],
  rows: readonly WorkspaceDirectoryRow[],
  workspaceId: string,
  spaces: WorkspaceSpaceStorage,
  viewer: Viewer,
  /**
   * Add each row's breakouts and background agents for this viewer. Only the
   * workspace socket asks: it is the one reader that keeps a Channel's rail
   * current, and a REST answer has no way to be told when the list moves.
   */
  withViewerState = false,
): Workstream[] {
  const personalIds = [...new Set(
    rows.filter((row) => row.scope === "personal").map((row) => row.workstream_id),
  )];
  const previews = loadParticipantPreviews(sql, personalIds);
  const spaceIds = spaces.spaceIdsByChannel(viewer, rows.map((row) => row.workstream_id));
  const pins = spaces.ready()
    ? loadSpacePins(sql, viewer, spaces.breakoutsReady(), rows.map((row) => row.workstream_id))
    : new Map<string, { spaceId: string; position: number }[]>();
  const breakoutAttentionCounts = spaces.breakoutAttentionCounts(viewer, rows.map((row) => row.workstream_id));
  const viewerStates = withViewerState
    ? channelViewerStates(sql, viewer.userId, rows.map((row) => row.workstream_id))
    : new Map<string, ChannelViewerState>();
  return rows.map((row) => {
    const mainOpen = mainOpenFor(row, viewer.accessClass);
    const state = viewerStates.get(row.workstream_id);
    return {
      ...directoryWorkstream(
        row, workspaceId, previews.get(row.workstream_id), spaceIds.get(row.workstream_id) ?? [],
        pins.get(row.workstream_id) ?? [], breakoutAttentionCounts.get(row.workstream_id) ?? 0, mainOpen,
      ),
      ...(mainOpen ? state : withoutMainState(state)),
    };
  });
}

function loadSpacePins(
  sql: DurableObjectState["storage"]["sql"],
  viewer: Viewer,
  breakouts: boolean,
  workstreamIds: readonly string[],
): Map<string, { spaceId: string; position: number }[]> {
  const userId = viewer.userId;
  const result = new Map<string, { spaceId: string; position: number }[]>();
  for (const ids of boundParameterChunks([...new Set(workstreamIds)])) {
    const rows = sql.exec<{
      workstream_id: string;
      space_id: string;
      position: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT pin.workstream_id, pin.space_id, pin.position
         FROM workspace_workstream_pins pin
         JOIN space_channel_memberships membership
           ON membership.space_id = pin.space_id
          AND membership.workstream_id = pin.workstream_id
          AND membership.state = 'active'
         JOIN spaces space ON space.space_id = pin.space_id
         LEFT JOIN space_viewers viewer
           ON viewer.space_id = space.space_id
          AND viewer.user_id = ? AND viewer.is_participant = 1
        WHERE pin.user_id = ? AND space.archived_at IS NULL
          AND ${spaceListedSql("space", "viewer", viewer.accessClass, { breakouts })}
          AND pin.workstream_id IN (${ids.map(() => "?").join(", ")})
        ORDER BY pin.workstream_id, pin.space_id, pin.position`,
      userId,
      userId,
      userId,
      ...(breakouts ? [userId] : []),
      ...ids,
    ).toArray();
    for (const row of rows) {
      const pins = result.get(row.workstream_id) ?? [];
      pins.push({ spaceId: row.space_id, position: row.position });
      result.set(row.workstream_id, pins);
    }
  }
  return result;
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
    createdByUserId: row.created_by_user_id,
  };
}

/** What a conversation's directory row says to Activity; see `WorkspaceDO.activityMoment`. */
interface ActivityMoment {
  started: boolean;
  finished: boolean;
}

interface ActivityMomentRow extends Record<string, SqlStorageValue> {
  created_by_user_id: string | null;
  system_kind: string | null;
  exact_state: string;
  completed_at: number | null;
  archived_at: number | null;
}

// Binding 1 is always the viewer user ID; the access join reuses it as ?1.
/**
 * Two `workstreamId` → user-id maps as one, mutating neither.
 *
 * A Channel and one of its breakouts can both move for the same person inside
 * one Queue batch, and what that person is owed is one nudge rather than two.
 */
/**
 * What one committed directory batch still owes after its commit: the socket
 * sends, reconciliations and schedule re-arms. Recorded as a row in the same
 * transaction (`workspace_directory_followups`), so it survives a crash, and
 * parsed when it is read back.
 */
const DirectoryFollowUpSchema = z.strictObject({
  workspaceId: z.string().min(1),
  publishSnapshotAll: z.boolean(),
  snapshotUsers: z.array(z.string()),
  reachChangedUsers: z.array(z.string()),
  commonChanges: z.array(z.string()),
  viewerChanges: z.array(z.tuple([z.string(), z.array(z.string())])),
  breakoutChanges: z.array(z.string()),
  breakoutViewerChanges: z.array(z.tuple([z.string(), z.array(z.string())])),
  reopenBootstrap: z.boolean(),
  watchReconciliations: z.array(z.string()),
  archivalChanges: z.array(z.string()),
  /**
   * Breakouts (`<channelId>/<breakoutId>`) whose archive state this batch
   * moved, so a Sidekick whose home is one of them hears of it. Absent from a
   * follow-up recorded before the field existed.
   */
  breakoutArchivalChanges: z.array(z.string()).default([]),
  refreshTerminal: z.boolean(),
  refreshWatchKinds: z.boolean(),
  directoryChanged: z.boolean(),
  /** Workspace sync topics an activity or notification record moved. */
  syncTopics: z.array(WorkspaceSyncTopicSchema),
  refreshProductAlarm: z.boolean(),
  /**
   * Per Channel, the people this batch may have taken it from, named inside
   * the batch's transaction from the rows as they were before it. Each is owed
   * the Channel's row if they still see it and its tombstone if they do not;
   * nobody else who cannot see it is sent anything.
   */
  channelLosses: z.array(z.tuple([z.string(), z.array(z.string())])),
  /**
   * Threads and breakouts this batch started or finished a run in, each an
   * Activity row somebody may be pushed. Absent from a follow-up recorded
   * before the field existed.
   */
  activityPushSubjects: z.array(z.strictObject({
    threadId: z.string(),
    substreamId: z.string().nullable(),
    kind: z.enum(["start", "finish", "joined", "merge", "artifact"]),
    userId: z.string().optional(),
    itemId: z.string().optional(),
  })).default([]),
});
type DirectoryFollowUp = z.infer<typeof DirectoryFollowUpSchema>;

/** The audience half of `publishSync`'s detail; `memberUserIds` is read elsewhere. */
const SyncAudienceSchema = z.object({
  audienceUserIds: z.array(UserIdSchema).optional(),
  connectionId: z.string().min(1).optional(),
});

/**
 * Who one Channel's workspace-socket row is owed to after a post-commit pass.
 *
 * `readers` is everybody who can see the Channel now; `users` are people whose
 * own row moved, sent it only if they can see it; `lost` are people who may no
 * longer see it, sent the row if they still do and the `workstream: null`
 * tombstone if they do not. A person who cannot see the Channel and is not in
 * `lost` is sent nothing: a null row names a private Channel and says when it
 * moved, which is not theirs to know.
 */
interface ChannelRowAudience {
  readers: boolean;
  users: Set<string>;
  lost: Set<string>;
}

/**
 * The Channel rows a post-commit pass owes, collected so each Channel goes out
 * once per socket however many writes in the pass touched it, and each
 * person's row is built once for all of their sockets
 * (`WorkspaceDO.publishChannelRows`). A directory batch also collects its
 * `channelLosses` in one before recording them.
 */
class ChannelRowPlan {
  readonly channels = new Map<string, ChannelRowAudience>();

  private audience(channelId: string): ChannelRowAudience {
    let audience = this.channels.get(channelId);
    if (!audience) {
      audience = { readers: false, users: new Set(), lost: new Set() };
      this.channels.set(channelId, audience);
    }
    return audience;
  }

  readers(channelId: string): void {
    this.audience(channelId).readers = true;
  }

  users(channelId: string, userIds: Iterable<string>): void {
    const audience = this.audience(channelId);
    for (const userId of userIds) audience.users.add(userId);
  }

  lost(channelId: string, userIds: Iterable<string>): void {
    const audience = this.audience(channelId);
    for (const userId of userIds) audience.lost.add(userId);
  }
}

function mergeViewerChanges(
  first: ReadonlyMap<string, ReadonlySet<string>>,
  second: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, Set<string>> {
  const merged = new Map<string, Set<string>>();
  for (const source of [first, second]) {
    for (const [workstreamId, users] of source) {
      const existing = merged.get(workstreamId) ?? new Set<string>();
      for (const userId of users) existing.add(userId);
      merged.set(workstreamId, existing);
    }
  }
  return merged;
}

const SELECT_WORKSPACE_DIRECTORY = `SELECT directory.workstream_id,
    EXISTS (SELECT 1 FROM parent_children resolved_child
      WHERE resolved_child.parent_id = directory.workstream_id AND resolved_child.substream_id = '0'
        AND resolved_child.resolved = 1) AS resolved,
    directory.authority_generation, directory.waterline AS common_waterline,
    directory.source_event_id AS common_event_id, directory.title,
    directory.description, directory.scope, directory.exact_state,
    directory.system_kind, directory.last_activity_at, directory.completed_at,
    directory.archived_at, directory.email_address, directory.created_by_user_id,
    directory.title_status, directory.appearance_json,
    directory.latest_attention_ordinal, directory.unread_tracking_start_ordinal,
    directory.next_wakeup_due_at, directory.next_wakeup_prompt,
    directory.source_created_at, directory.source_updated_at,
    viewer.seen_attention_ordinal, viewer.manual_unread_from_ordinal,
    viewer.manual_unread_generation, viewer.latest_mention_attention_ordinal,
    viewer.is_participant, viewer.unseen, viewer.waterline AS viewer_waterline,
    viewer.source_event_id AS viewer_event_id,
    NULL AS pin_position,
    access.last_accessed_at
  FROM channels directory
  LEFT JOIN channel_viewers viewer
    ON viewer.workstream_id = directory.workstream_id
   AND viewer.user_id = ?
   AND viewer.authority_generation = directory.authority_generation
  LEFT JOIN workspace_workstream_access access
    ON access.workstream_id = directory.workstream_id AND access.user_id = ?2`;

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
   * `WORKSTREAM_REALTIME_MAX_FRAME_BYTES` for `channel_rails` answers, held
   * per instance so a runtime test can pack frames without megabytes of rows.
   */
  private channelRailFrameBytes = WORKSTREAM_REALTIME_MAX_FRAME_BYTES;
  /**
   * Whether this object has the first-frame ledger (migration 71). An object
   * held at schema 57 for meeting-notes retirement does not, and the watch
   * stays off there until the operator finalizes it.
   */
  private unheardLedger = false;
  /**
   * Whether this object has the rail change ledger (migration 82). An object
   * held at schema 57 has no Channels, and so no rails to push.
   */
  private railLedger = false;
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
    // Channel rail ledger its triggers may have filled, as a microtask: once
    // the synchronous code that wrote, and any transaction around it, has
    // finished. A writer that builds its own row plan in that same run
    // (`collectRailChanges`) takes its Channels first, and the drain's own
    // writes find it already scheduled. A closure rather than a method,
    // because methods sit behind the retirement gate and a write made by a
    // permitted retirement call must not be refused on its way out; the drain
    // itself is refused once the workspace is retired, which is right.
    let railDrainScheduled = false;
    this.state = observeSqlWrites(state, () => {
      if ((!this.railLedger && !this.versionLedger) || railDrainScheduled) return;
      railDrainScheduled = true;
      queueMicrotask(() => {
        try {
          // The ledger only: what a directory batch holds is its pass's to send.
          if (this.railLedger) {
            const rows = new ChannelRowPlan();
            for (const workstreamId of drainChannelRailChanges(this.state.storage.sql)) rows.readers(workstreamId);
            this.publishChannelRows(rows);
          }
          // A new version of any resource, from whichever producer wrote it.
          const changes = this.versionLedger ? drainResourceVersionChanges(this.state.storage.sql) : [];
          if (changes.length > 0) {
            // Every open preview of it moves to the new head.
            this.publishResourceVersions(readResourceHeads(this.state.storage.sql,
              changes.map((change) => change.resourceId)));
            // A pinner hears only some causes as news. The announcement leaves
            // the object, so it runs on its own, held to the object's
            // lifetime. It is best effort, as every Activity push is: a
            // failure is logged and the Activity row, the pin's unread state
            // and the digest stand regardless.
            const news = changes.filter((change) => isArtifactNewsCause(change.cause));
            if (news.length > 0) {
              this.state.waitUntil(this.announceArtifactUpdates(news).catch((error: unknown) => logWarn(this.env, "artifact_update_announce_failed", {
                code: diagnosticErrorCode(error, "artifact_update_announce_failed"),
              })));
            }
          }
        } catch (error) {
          // Nothing here may throw: this runs outside every entry point.
          if (!isRetirementRefusal(error)) {
            logWarn(this.env, "channel_rail_drain_failed", {
              code: diagnosticErrorCode(error, "channel_rail_drain_failed"),
            });
          }
        } finally {
          railDrainScheduled = false;
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
    // Who an operator may act as is their reach too: their Sideline catalog
    // lists these people. Each operator is told about themselves.
    this.publishReachChanged(new Set(request.relationships.map((relationship) => relationship.impersonatorUserId)));
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
    const { revoked, impersonatorUserIds } = new WorkspaceImpersonationStorage(this.state.storage).revoke({
      workspaceId: request.workspaceId,
      ...(request.authorityBasis ? { authorityBasis: request.authorityBasis } : {}),
      ...(request.impersonatorUserId ? { impersonatorUserId: request.impersonatorUserId } : {}),
      ...(request.representedUserId ? { representedUserId: request.representedUserId } : {}),
      now: new Date().toISOString(),
    });
    this.publishReachChanged(new Set(impersonatorUserIds));
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
   * Start a Channel's Main conversation warming when someone opens the
   * Channel, without waiting for it. The legacy parent did this on its own
   * wake; the Organization object never sleeps for a Channel, so the socket
   * open is the moment a person is about to read Main.
   *
   * Nothing here is awaited or retried. A conversation that fails to wake is
   * woken by the request that needs it; this only removes latency and must
   * never add a failure.
   */
  private wakeMainConversation(parentId: string): void {
    const workspaceId = this.workspaceId();
    if (!workspaceId) return;
    // A Main that has never reported its Sidekick attachments is asked to,
    // so the Channel a reader opens has its rail's `attached` list. Every
    // other Main reports on its own directory effects.
    const reportAttachments = this.railLedger && mainAttachmentsUnreported(this.state.storage.sql, parentId);
    this.state.waitUntil((async () => {
      try {
        const stub = await durableObjectStubForWorkspace(this.env, this.env.SUBSTREAM_AGENTS, workspaceId,
          conversationObjectName(this.env.AVALON_REGION, asWorkspaceId(workspaceId), parentId));
        await stub.wake(reportAttachments ? { reportAttachments: true } : {});
      } catch {
        // Warming is best effort by construction.
      }
    })());
  }

  private hostedParentHost(rows?: ChannelRowPlan): HostedParentHost {
    return {
      env: this.env,
      storage: this.state.storage,
      alarms: this.scheduledAlarms,
      armNextAlarm: async () => { await this.armNextAlarm(); },
      controlSockets: (parentId) => this.state.getWebSockets(parentControlSocketTag(parentId)),
      acceptControlSocket: (server, parentId, userId) => {
        this.state.acceptWebSocket(server, [parentControlSocketTag(parentId), userId]);
      },
      // Into the caller's plan when it is coalescing a pass (a batch of child
      // effects), otherwise sent now.
      publishChannelRow: (parentId, userId) => {
        const plan = rows ?? new ChannelRowPlan();
        if (userId === undefined) plan.readers(parentId);
        else plan.users(parentId, [userId]);
        if (!rows) this.publishChannelRows(plan);
        return Promise.resolve();
      },
      applyLocalEffects: (envelopes) => this.applyLocalEffects(envelopes),
      readRelationship: (workspaceId, userId) => this.readRelationship(workspaceId, userId),
      noteRelationship: (relationship) => this.noteRelationship(relationship),
    };
  }

  /**
   * Follow-ups recorded by hosted-parent writes, run after their commit. Each
   * carries the row's JSON: a follow-up rolled back with an outer transaction
   * leaves an id a later row may reuse, and only the row it names is run.
   */
  private readonly pendingParentFollowUps: { id: number; json: string }[] = [];
  /** Space intents a request, a Queue delivery or the alarm is running now, by operation id. */

  /**
   * Apply what a hosted parent just published, inside the parent's own
   * transaction: the directory rows, the grant directory, the activity row
   * and the notification record all commit with the change that caused them,
   * or none of them do. A failure throws; somebody the member table has never
   * heard of throws `UnknownMembersError` for the caller to learn and retry.
   * Returns the envelopes whose remaining work leaves the object: a
   * notification to deliver, a mention to snapshot, a revoked Channel grant's
   * Sidekick revocation.
   */
  private applyLocalEffects(envelopes: readonly ParentEffectEnvelope[]): { outbox: ParentEffectEnvelope[] } {
    const workspaceId = this.workspaceId();
    if (!workspaceId) throw new Error("workspace_identity_unknown");
    const outbox: ParentEffectEnvelope[] = [];
    const directory = envelopes.filter((envelope) => (
      envelope.effect.kind === "directory_common" || envelope.effect.kind === "directory_user"
    ));
    const followUp = directory.length > 0
      ? this.applyDirectoryBatch({ workspaceId, envelopes: directory }).followUp
      : WorkspaceDO.emptyDirectoryFollowUp(workspaceId);
    for (const envelope of envelopes) {
      const effect = envelope.effect;
      if (effect.kind === "directory_common" || effect.kind === "directory_user") continue;
      if (effect.kind === "scope_grant_directory") {
        applyScopeGrantDirectory(this.state.storage, envelope);
        // A revoked Channel grant also has to reach the Channel's Sidekick
        // conversations, which is a Queue send; the drain does it.
        if (!effect.grant.active && effect.grant.target.kind === "workstream") outbox.push(envelope);
        continue;
      }
      const applied = applyWorkstreamRegionalEnvelope(
        this.state.storage,
        WorkspaceRegionalEffectApplyRequestSchema.parse({
          workspaceId,
          envelope,
          actorUserId: effect.kind === "activity_event" ? effect.actorUserId ?? null : null,
          targetUserIds: effect.kind === "activity_event" ? effect.targets.map((target) => target.userId) : [],
          // Delivery checks membership again when it sends; a person this
          // object has not heard of gets the record and is checked there.
          recipientIsActiveMember: isPersonNotificationEffect(effect)
            ? this.memberActiveOrUnknown(effect.recipientUserId) : false,
        }),
        Date.now(),
      );
      followUp.syncTopics.push(...(effect.kind === "activity_event"
        ? ["activity", "work_opportunities"] as const : ["activity", "workstream_directory"] as const));
      if (effect.kind === "activity_event" && !applied.replayed) followUp.refreshProductAlarm = true;
      // A Breakout's merge into its thread is a `merged` Activity row, pushed
      // like a start once this batch commits.
      if (effect.kind === "activity_event" && !applied.replayed && mergedBreakoutId(effect.metadata) !== null) {
        followUp.activityPushSubjects.push({
          threadId: envelope.parentId, substreamId: null, kind: "merge", itemId: `merged:${effect.eventId}`,
        });
      }
      if (isPersonNotificationEffect(effect)) {
        if (applied.notificationIntentId) outbox.push(envelope);
      } else if (effect.kind === "activity_event" && effect.sourceKind === "workstream_message"
        && effect.sourceId && effect.targets.length > 0 && !isBreakoutActivityEvent(effect)) {
        outbox.push(envelope);
      }
    }
    followUp.syncTopics = [...new Set(followUp.syncTopics)];
    const recorded = this.recordDirectoryFollowUp(followUp);
    if (recorded !== null) this.pendingParentFollowUps.push(recorded);
    return { outbox };
  }

  private static emptyDirectoryFollowUp(workspaceId: string): DirectoryFollowUp {
    return {
      workspaceId, publishSnapshotAll: false, snapshotUsers: [], reachChangedUsers: [], commonChanges: [],
      viewerChanges: [], breakoutChanges: [], breakoutViewerChanges: [], reopenBootstrap: false,
      watchReconciliations: [], archivalChanges: [], breakoutArchivalChanges: [], refreshTerminal: false,
      refreshWatchKinds: false, directoryChanged: false, syncTopics: [], refreshProductAlarm: false, channelLosses: [],
      activityPushSubjects: [],
    };
  }

  private memberActiveOrUnknown(userId: string): boolean {
    const row = this.state.storage.sql.exec<{ active: number }>(
      `SELECT active FROM workspace_member_status WHERE user_id = ?`, userId,
    ).toArray()[0];
    return row === undefined || row.active === 1;
  }

  /**
   * Which kind of parent an id names. The row says once it exists; before
   * that a Space is the id the Space directory reserved, and anything else is
   * a Channel.
   */
  private hostedParentKind(parentId: string): "workstream" | "space" {
    const known = this.state.storage.sql.exec<{ parent_kind: "workstream" | "space" }>(
      "SELECT parent_kind FROM parent_metadata WHERE parent_id = ?", parentId,
    ).toArray()[0]?.parent_kind;
    if (known) return known;
    return this.state.storage.sql.exec("SELECT 1 FROM spaces WHERE space_id = ?", parentId).toArray().length > 0
      ? "space" : "workstream";
  }

  private async hostedParent(parentId: string, workspaceId?: string, rows?: ChannelRowPlan): Promise<HostedParent> {
    await this.initialized;
    if (workspaceId !== undefined) await this.ensureParentWorkspace(workspaceId);
    const kind = this.hostedParentKind(parentId);
    return new HostedParent(this.hostedParentHost(rows), parentId, kind === "space" ? HOSTED_SPACE_ROLE : HOSTED_CHANNEL_ROLE);
  }

  /**
   * A parent for a method only a Channel has: grants, invitations, sharing
   * and conversation seats. A Space id reaches this facade through the same
   * routes (the sharing routes take any parent id), and the Space role does
   * not refuse those writes itself, so the facade does.
   */
  private async channelParent(parentId: string, workspaceId?: string): Promise<HostedParent> {
    const parent = await this.hostedParent(parentId, workspaceId);
    if (parent.role.kind !== "workstream") throw new Error("channel_parent_required");
    return parent;
  }

  /**
   * An Organization object that has never been initialized learns its own id
   * from the first parent request, as it did from the first directory effect
   * when the parents were other objects. An id that disagrees is refused.
   */
  private async ensureParentWorkspace(workspaceId: string): Promise<void> {
    if (!this.workspaceId()) {
      this.ensureIdentity(workspaceId, await workspacePlacementAffinity(this.env, workspaceId));
    }
    this.assertWorkspace(workspaceId);
  }

  /**
   * After a parent write: run the follow-ups it recorded, and arm what it
   * scheduled. Outbox rows are work that leaves the object (a Queue send
   * nobody who made the write is waiting on), due at once, and the alarm
   * sends them; a failed send never fails the write that committed them.
   *
   * `rows` is a plan the caller has already put Channel rows into; they go
   * out with the follow-ups' own, once per Channel.
   */
  private async afterParentWrite(rows?: ChannelRowPlan): Promise<void> {
    const followUps = this.pendingParentFollowUps.splice(0);
    if (followUps.length > 0) {
      await this.runDirectoryFollowUps(followUps, rows);
      return;
    }
    this.publishChannelRows(this.collectRailChanges(rows ?? new ChannelRowPlan()));
    await this.armNextAlarm();
  }

  /**
   * Run a hosted-parent write, learning anybody its transaction met that the
   * member table had never heard of and running it once more. The first run
   * rolled back whole, so the second starts from the same state.
   */
  private async withMembersLearned<T>(run: () => Promise<T> | T): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof UnknownMembersError)) throw error;
      await this.learnMembers(error.userIds);
      return await run();
    }
  }

  /** A hosted-parent write from a request: learn, retry once, then the post-commit work. */
  private async parentWrite<T>(run: () => Promise<T> | T): Promise<T> {
    const result = await this.withMembersLearned(run);
    await this.afterParentWrite();
    return result;
  }

  /**
   * Deliver every due `parent_outbox` row: a notification or mention on the
   * activity Queue, whose consumer delivers it in a Worker, and a revoked
   * Channel grant's Sidekick revocation. A row is deleted only once
   * its destination has it; a failure puts it off on the alarm's retry
   * schedule, and a row that does not parse is kept as `failed` and never
   * retried. Rows are not claimed: the alarm is the only drain, and an alarm
   * never runs beside another.
   */
  private async drainParentOutbox(): Promise<void> {
    const workspaceId = this.workspaceId();
    if (!workspaceId) return;
    const rows = this.state.storage.sql.exec<{
      parent_id: string; message_id: string; payload_json: string; attempts: number;
    }>(
      `SELECT parent_id, message_id, payload_json, attempts FROM parent_outbox
        WHERE state IN ('pending', 'inflight') AND not_before <= ?
        ORDER BY CASE effect_kind WHEN 'directory_common' THEN 0 WHEN 'directory_user' THEN 1 ELSE 2 END,
                 created_at, message_id
        LIMIT 100`,
      Date.now(),
    ).toArray();
    if (rows.length === 0) return;
    const envelopes: { envelope: ParentEffectEnvelope; attempts: number }[] = [];
    for (const row of rows) {
      const parsed = ParentEffectEnvelopeSchema.safeParse(JSON.parse(row.payload_json));
      if (parsed.success) {
        envelopes.push({ envelope: parsed.data, attempts: row.attempts });
        continue;
      }
      // Reading it again cannot succeed, and leaving it due would make it the
      // first row of every pass. Kept, with its code, for an operator.
      this.failParentOutboxRow(workspaceId, row.parent_id, row.message_id,
        zodDiagnosticCode(parsed.error, "parent_outbox_row") ?? "parent_outbox_row_invalid");
    }
    const deliver = async (batch: { envelope: ParentEffectEnvelope; attempts: number }[], send: () => Promise<void>) => {
      if (batch.length === 0) return;
      try {
        await send();
        this.deleteParentOutboxRows(batch.map((entry) => entry.envelope));
      } catch (error) {
        // A destination that refuses the row's shape refuses it on every
        // attempt.
        if (error instanceof z.ZodError) {
          const code = zodDiagnosticCode(error, "parent_outbox_row") ?? "parent_outbox_row_invalid";
          for (const { envelope } of batch) this.failParentOutboxRow(workspaceId, envelope.parentId, envelope.messageId, code);
          return;
        }
        const code = diagnosticErrorCode(error, "parent_effect_delivery_failed");
        this.deferParentOutboxRows(batch, code);
        logWarn(this.env, "parent_effect_delivery_deferred", {
          workspace_id: workspaceId,
          message_ids: batch.map((entry) => entry.envelope.messageId),
          effect_kinds: batch.map((entry) => entry.envelope.effect.kind),
          code,
        });
      }
    };
    // A directory row applies in its parent's own transaction and is never
    // written here; one found here was never going to land.
    for (const { envelope } of envelopes) {
      if (envelope.effect.kind !== "directory_common" && envelope.effect.kind !== "directory_user") continue;
      this.failParentOutboxRow(workspaceId, envelope.parentId, envelope.messageId, "parent_outbox_directory_row");
    }
    for (const entry of envelopes) {
      if (entry.envelope.effect.kind !== "scope_grant_directory") continue;
      await deliver([entry], () => this.deliverRevokedGrant(workspaceId, entry.envelope));
    }
    const queued = envelopes.filter(({ envelope }) => !WorkspaceDO.LOCAL_PARENT_EFFECT_KINDS.has(envelope.effect.kind));
    const attempts = new Map(queued.map((entry) => [entry.envelope.messageId, entry.attempts]));
    const plan = planParentEffectBatches(queued.map((entry) => entry.envelope));
    if (plan.oversized.length > 0) {
      this.deleteParentOutboxRows(plan.oversized.map((entry) => entry.effect));
      for (const { effect, bytes } of plan.oversized) {
        logWarn(this.env, "parent_effect_oversized", {
          workspace_id: workspaceId,
          workstream_id: effect.parentId,
          message_id: effect.messageId,
          effect_kind: effect.effect.kind,
          bytes,
          limit_bytes: EFFECT_QUEUE_MESSAGE_MAX_BYTES,
          outcome: "dropped",
        });
      }
    }
    for (const batch of plan.batches) {
      await deliver(batch.map((envelope) => ({ envelope, attempts: attempts.get(envelope.messageId) ?? 0 })), async () => {
        await this.env.ACTIVITY_QUEUE.sendBatch(batch.map((envelope) => ({ body: envelope })));
      });
    }
  }

  private static readonly LOCAL_PARENT_EFFECT_KINDS = new Set(["directory_common", "directory_user", "scope_grant_directory"]);

  /**
   * A grant row in the outbox: applied (a replay of the parent's own
   * transaction, answered by its receipt, or a legacy row carried over at
   * import) and, for a revoked Channel grant, sent on to the Channel's
   * Sidekick conversations, which sit outside its participant projection.
   * The Sidekicks the Channel owns are this object's rows, so their
   * `automation` hops are published directly.
   */
  private async deliverRevokedGrant(workspaceId: string, envelope: ParentEffectEnvelope): Promise<void> {
    if (envelope.effect.kind !== "scope_grant_directory") return;
    this.state.storage.transactionSync(() => applyScopeGrantDirectory(this.state.storage, envelope));
    const { grant } = envelope.effect;
    if (grant.active || grant.target.kind !== "workstream") return;
    const automationIds = this.automationIdsOwnedBy(grant.target.parentId);
    if (automationIds.length === 0) return;
    const revocation: SocketAccessRevocation = {
      reason: "workstream_participant_removed", workspaceId: asWorkspaceId(workspaceId),
      userId: grant.userId, sessionId: null,
      ...(grant.membershipIncarnation ? { membershipIncarnation: grant.membershipIncarnation } : {}),
    };
    try {
      await publishDescendantRevocations(this.env, automationIds.map((automationId) =>
        descendantRevocation(revocation, { scope: "automation", automationId })));
    } catch (error) {
      throw new Error("scope_grant_sidekick_revocation_publish_failed", { cause: error });
    }
  }

  /** Keep a row no attempt can deliver as `failed`, never due again, and say why. */
  private failParentOutboxRow(workspaceId: string, parentId: string, messageId: string, code: string): void {
    this.state.storage.sql.exec(
      `UPDATE parent_outbox SET state = 'failed', last_error_code = ? WHERE parent_id = ? AND message_id = ?`,
      code, parentId, messageId,
    );
    logError(this.env, "parent_outbox_row_unreadable", {
      workspace_id: workspaceId, workstream_id: parentId, message_id: messageId, code,
    });
  }

  private deleteParentOutboxRows(envelopes: readonly ParentEffectEnvelope[]): void {
    this.state.storage.transactionSync(() => {
      for (const envelope of envelopes) {
        this.state.storage.sql.exec(
          `DELETE FROM parent_outbox WHERE parent_id = ? AND message_id = ? AND payload_hash = ?`,
          envelope.parentId, envelope.messageId, envelope.payloadHash,
        );
      }
    });
  }

  /** Put rows off on the alarm's retry schedule, each by its own attempt count. */
  private deferParentOutboxRows(rows: readonly { envelope: ParentEffectEnvelope; attempts: number }[], code: string): void {
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      for (const { envelope, attempts } of rows) {
        this.state.storage.sql.exec(
          `UPDATE parent_outbox SET state = 'pending', attempts = attempts + 1, not_before = ?, last_error_code = ?
            WHERE parent_id = ? AND message_id = ? AND payload_hash = ?`,
          now + scheduledAlarmRetryDelay(attempts + 1), code, envelope.parentId, envelope.messageId, envelope.payloadHash,
        );
      }
    });
  }

  /**
   * Whether migration 72 has run. An Organization held below schema 58 by the
   * meeting-notes cleanup has no `parent_*` tables, and its cold start and
   * alarm must still work so the operator retirement RPCs can finish it.
   */
  private hostedParentSchemaPresent(): boolean {
    return this.state.storage.sql.exec(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'parent_outbox'",
    ).toArray().length > 0;
  }

  private nextParentOutboxDueAt(): number | null {
    return this.state.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(not_before) AS due_at FROM parent_outbox WHERE state IN ('pending', 'inflight')`,
    ).toArray()[0]?.due_at ?? null;
  }

  private async drainDueParentBreakouts(now: number): Promise<void> {
    for (const parentId of HostedParent.dueParentIds(this.state.storage.sql, now)) {
      const parent = await this.hostedParent(parentId);
      await this.withMembersLearned(() => parent.drainPrivateChildMembershipEffects()).catch(() => undefined);
      await this.withMembersLearned(() => parent.drainPrivateChildLifecycleEffects());
    }
    await this.afterParentWrite();
  }

  private async runHostedParentAlarm(alarm: ScheduledAlarm): Promise<boolean> {
    if (alarm.kind === PARTICIPANT_PROJECTION_ALARM) {
      const payload = HostedParticipantProjectionAlarmSchema.parse(JSON.parse(alarm.payload ?? "null"));
      const parent = await this.hostedParent(payload.parentId);
      await parent.deliverParticipantProjection(payload.delivery.substreamId, payload.delivery.projection.userId,
        payload.delivery.projection.revision);
      return true;
    }
    if (alarm.kind === PARTICIPANT_MIGRATION_ALARM) {
      const [parentId, substreamId] = alarm.key.split(":");
      if (!parentId || !substreamId) throw new Error("parent_participant_migration_key_invalid");
      await this.parentWrite(async () => (await this.hostedParent(parentId)).runParticipantMigration(asSubstreamId(substreamId)));
      return true;
    }
    if (alarm.kind === SCOPE_INVITATION_INDEX_ALARM) {
      await (await this.hostedParent(alarm.key)).indexPendingInvitations();
      return true;
    }
    if (alarm.kind === SCOPE_INVITATION_DELIVERY_ALARM) {
      const [parentId, invitationId] = alarm.key.split(":");
      if (!parentId || !invitationId) throw new Error("parent_invitation_delivery_key_invalid");
      await (await this.hostedParent(parentId)).deliverInvitation(invitationId);
      return true;
    }
    return false;
  }

  // The conversation-parent contract.

  /**
   * Which kind of hosted parent an id names, with its authority, and, when a
   * viewer is named, that viewer's decision too: opening a Channel
   * conversation is then one call to this object rather than a resolve and a
   * check in turn. `null` kind is an id this object hosts no parent for (a
   * Sidekick, or nothing), which the caller then asks its own object about.
   */
  async resolveHostedParent(input: {
    workspaceId: string;
    parentId: string;
    viewer?: Omit<Parameters<HostedParent["authorizeViewer"]>[0], "workspaceId" | "parentId">;
  }): Promise<{
    kind: "workstream" | "space" | "automation" | null;
    authority: Awaited<ReturnType<HostedParent["authority"]>>;
    viewer?: Awaited<ReturnType<HostedParent["authorizeViewer"]>>;
  }> {
    const request = z.object({ workspaceId: WorkspaceIdSchema, parentId: IdSchema }).parse(input);
    const sidekick = await this.sidekickParent(request.parentId, request.workspaceId);
    if (sidekick) {
      const authority = sidekick.authority({ workspaceId: request.workspaceId, parentId: request.parentId });
      if (!input.viewer || !authority.exists) return { kind: authority.exists ? "automation" : null, authority };
      const viewer = await sidekick.authorizeViewer({ ...input.viewer, workspaceId: request.workspaceId, parentId: request.parentId });
      return { kind: "automation", authority, viewer };
    }
    const parent = await this.hostedParent(request.parentId, request.workspaceId);
    const authority = await parent.authority({ workspaceId: request.workspaceId, parentId: request.parentId });
    const kind = authority.exists ? parent.role.kind : null;
    if (!input.viewer || kind === null) return { kind, authority };
    const viewer = await parent.authorizeViewer({
      ...input.viewer, workspaceId: request.workspaceId, parentId: request.parentId,
    });
    return { kind, authority, viewer };
  }

  async authority(input: Parameters<HostedParent["authority"]>[0]) {
    const sidekick = await this.sidekickParent(input.parentId, input.workspaceId);
    if (sidekick) return sidekick.authority(input);
    return (await this.hostedParent(input.parentId, input.workspaceId)).authority(input);
  }

  async authorizeViewer(input: Parameters<HostedParent["authorizeViewer"]>[0]) {
    const sidekick = await this.sidekickParent(input.parentId, input.workspaceId);
    if (sidekick) return sidekick.authorizeViewer(input);
    return (await this.hostedParent(input.parentId, input.workspaceId)).authorizeViewer(input);
  }

  async reserveChild(input: Parameters<HostedParent["reserveChild"]>[0]) {
    const sidekick = await this.sidekickParent(input.parentId, input.workspaceId);
    if (sidekick) return sidekick.reserveChild(input);
    return this.parentWrite(async () => (await this.hostedParent(input.parentId, input.workspaceId)).reserveChild(input));
  }

  async hiddenChildren(input: Parameters<HostedParent["hiddenChildren"]>[0] & { workspaceId: string }) {
    return (await this.hostedParent(input.parentId, input.workspaceId)).hiddenChildren(input);
  }

  async ownsHiddenChild(input: Parameters<HostedParent["ownsHiddenChild"]>[0] & { workspaceId: string }) {
    return (await this.hostedParent(input.parentId, input.workspaceId)).ownsHiddenChild(input);
  }

  async reserveHiddenChild(input: Parameters<HostedParent["reserveHiddenChild"]>[0]) {
    return this.parentWrite(async () => (await this.hostedParent(input.parentId, input.workspaceId)).reserveHiddenChild(input));
  }

  async discardReservedMain(input: Parameters<HostedParent["discardReservedMain"]>[0]) {
    return this.parentWrite(async () => (await this.hostedParent(input.parentId, input.workspaceId)).discardReservedMain(input));
  }

  async reserveAgentChild(input: Parameters<HostedParent["reserveAgentChild"]>[0]) {
    const sidekick = await this.sidekickParent(input.parentId, input.workspaceId);
    if (sidekick) return sidekick.reserveAgentChild(input);
    return this.parentWrite(async () => (await this.hostedParent(input.parentId, input.workspaceId)).reserveAgentChild(input));
  }

  /**
   * The provisional row is applied by `reserveChild` itself, in its
   * transaction; nothing is left for this to finish. Kept for callers
   * deployed before that.
   */
  async flushProvisionalDirectory(input: { workspaceId: string; parentId: string }): Promise<void> {
    await this.hostedParent(input.parentId, input.workspaceId);
  }

  async listChildren(input: Parameters<HostedParent["listChildren"]>[0]) {
    const sidekick = await this.sidekickParent(input.parentId, input.workspaceId);
    if (sidekick) return sidekick.listChildren(input);
    return (await this.hostedParent(input.parentId, input.workspaceId)).listChildren(input);
  }

  async childTerminalDeadlines(input: Parameters<HostedParent["childTerminalDeadlines"]>[0]) {
    const sidekick = await this.sidekickParent(input.parentId, input.workspaceId);
    if (sidekick) return sidekick.childTerminalDeadlines(input);
    return (await this.hostedParent(input.parentId, input.workspaceId)).childTerminalDeadlines(input);
  }

  /** The children a hosted parent knows, for the retirement walk. */
  async childrenForRetirement(input: { workspaceId: string; parentId: string }) {
    const sidekick = await this.sidekickParent(input.parentId, input.workspaceId);
    if (sidekick) return sidekick.childrenForRetirement();
    const parent = await this.hostedParent(input.parentId, input.workspaceId);
    if (!parent.metadataRow()) return { status: "missing" as const };
    return { status: "ok" as const, children: parent.childrenForRetirement() };
  }

  /**
   * The parent step of a conversation's effects, delivered by the activity
   * Queue consumer. The directory step lands in the same transaction. The
   * people the effects name are learned before it, so the transaction does
   * not have to stop for D1.
   */
  async receiveChildEffects(input: Parameters<HostedParent["receiveChildEffects"]>[0]) {
    // Parsed before anything is written: the first envelope decides which
    // parent is served and, on a new object, the object's own identity.
    const request = parseRpcInput(ReceiveChildEffectsRequestSchema, input, "receive_child_effects");
    const envelope = request.envelopes[0]!;
    if (envelope.parentKind === "automation") {
      const sidekick = await this.sidekickParent(envelope.parentId, envelope.workspaceId);
      if (!sidekick) throw new Error("sidekick_missing");
      return { accepted: sidekick.receiveChildEffects(request) };
    }
    if (envelope.parentKind !== "workstream" && envelope.parentKind !== "space") {
      throw new Error("conversation_effect_parent_kind_unhosted");
    }
    await this.initialized;
    // One plan for the whole batch: every envelope is its own transaction and
    // records its own follow-up, and a turn's burst of them owes each Channel
    // one row per socket, not one per envelope. The parent's own republish
    // (a breakout roster or the running agents moving) joins the same plan.
    const rows = new ChannelRowPlan();
    const parent = await this.hostedParent(envelope.parentId, envelope.workspaceId, rows);
    await this.learnMembers([...new Set(request.envelopes.flatMap(({ effect }) => (
      effect.kind === "directory_user" ? [effect.userId]
        : isPersonNotificationEffect(effect) ? [effect.recipientUserId] : []
    )))]);
    const accepted = await this.withMembersLearned(() => parent.receiveChildEffects(request));
    try {
      await parent.afterChildEffects();
    } finally {
      await this.afterParentWrite(rows);
    }
    return { accepted };
  }

  async listAuthorizationChildren(input: Parameters<HostedParent["listAuthorizationChildren"]>[0]) {
    const sidekick = await this.sidekickParent(input.parentId, input.workspaceId);
    if (sidekick) {
      return sidekick.authorizationDiscoveryChildren({ workspaceId: asWorkspaceId(input.workspaceId), parentId: input.parentId });
    }
    return (await this.hostedParent(input.parentId, input.workspaceId)).listAuthorizationChildren(input);
  }

  async readAuthorizationFacts(input: Parameters<HostedParent["readAuthorizationFacts"]>[0]) {
    return (await this.hostedParent(input.parentId, input.workspaceId)).readAuthorizationFacts(input);
  }

  /** A Sidekick's authorization facts, which are shaped unlike a Channel's. */
  async sidekickReadAuthorizationFacts(input: Parameters<HostedSidekick["readAuthorizationFacts"]>[0]) {
    const sidekick = await this.sidekickParent(input.parentId, input.workspaceId);
    if (!sidekick) return { exists: false as const, validatedAt: Date.now() };
    return sidekick.readAuthorizationFacts(input);
  }

  // ---------------------------------------------------------------------------
  // Hosted Sidekicks. `HostedSidekick` is the Sidekick's parent; these lend it
  // this object's storage and the Organization facts it reads. See
  // docs/hosted-conversation-parents.md and docs/automation-lifecycle.md.
  // ---------------------------------------------------------------------------

  /** Set by a hosted Sidekick write that moved a directory row; the sidebar list is published after it. */
  private sidekickDirectoryMoved = false;

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
      isChannelParticipant: (workstreamId, userId) => this.isWorkstreamParticipant(workstreamId, userId),
      // A Sidekick's home is a Channel or one of its Breakouts, never another
      // Sidekick, so this asks the hosted Channel parent directly.
      channelViewer: async (input) => (await this.hostedParent(input.parentId, input.workspaceId)).authorizeViewer({
        workspaceId: asWorkspaceId(input.workspaceId),
        parentId: input.parentId,
        substreamId: asSubstreamId(input.substreamId),
        userId: asUserId(input.userId),
        ...(input.requireGrantAuthority ? { requireGrantAuthority: true } : {}),
      }),
      readManagementAccess: async (input) => {
        const access = await this.readManagementAccess(input);
        return { allowed: access.allowed, writable: access.allowed ? access.writable : false };
      },
      readRelationship: (workspaceId, userId) => this.readRelationship(workspaceId, userId),
      sendRunProvision: async (message) => {
        await this.env.ACTIVITY_QUEUE.send(SidekickRunProvisionQueueMessageSchema.parse({
          kind: "sidekick_run_provision", region: this.env.AVALON_REGION, ...message,
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

  /** Run a hosted Sidekick call, then publish the sidebar list and arm what it scheduled. */
  private async sidekickCall<T>(automationId: string, workspaceId: string, run: (sidekick: HostedSidekick) => Promise<T> | T): Promise<T> {
    const sidekick = await this.hostedSidekick(automationId, workspaceId);
    try {
      return await run(sidekick);
    } finally {
      if (this.sidekickDirectoryMoved) {
        this.sidekickDirectoryMoved = false;
        this.publishSidebarList("automations");
      }
      await this.armNextAlarm();
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
         SELECT automation_id, 2, ROW_NUMBER() OVER (ORDER BY automation_id)
           FROM automation_directory WHERE ?2 IS NOT NULL AND owning_workstream_id = ?2 AND lifecycle <> 'deleted'
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

  async sidekickReadDetail(input: Parameters<HostedSidekick["readDetail"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.readDetail(input));
  }

  async sidekickSetAppearance(input: Parameters<HostedSidekick["setAppearance"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.setAppearance(input));
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

  async sidekickListRuns(input: Parameters<HostedSidekick["listRuns"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.listRuns(input));
  }

  async sidekickClaimExecutionPrincipal(input: Parameters<HostedSidekick["claimExecutionPrincipal"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.claimExecutionPrincipal(input));
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

  async sidekickContinueRun(input: Parameters<HostedSidekick["continueRun"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.continueRun(input));
  }

  /** For the provisioning consumer: what to start, or `null` once the run is no longer pending. */
  async sidekickRunProvisioning(input: Parameters<HostedSidekick["runProvisioning"]>[0]) {
    return this.sidekickRead(input.automationId, input.workspaceId, (sidekick) => sidekick.runProvisioning(input));
  }

  /** For the provisioning consumer: the run's loop started. */
  async sidekickRunProvisioned(input: Parameters<HostedSidekick["runProvisioned"]>[0]) {
    return this.sidekickCall(input.automationId, input.workspaceId, (sidekick) => sidekick.runProvisioned(input));
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
    const { automationIds, channelOwnedBy, ...request } = SidekickBatchDetailRequestSchema.parse(input);
    const ids = [...new Set([...(automationIds ?? []), ...(channelOwnedBy === undefined ? [] : this.automationIdsOwnedBy(channelOwnedBy))])];
    await this.ensureParentWorkspace(request.workspaceId);
    const host = this.hostedSidekickHost();
    const details: AutomationDetail[] = [];
    // Each detail is an access decision for this actor, so each is its own read.
    for (const automationId of ids) {
      details.push(await new HostedSidekick(host, automationId).readDetail({ ...request, automationId }));
    }
    return details;
  }

  /**
   * A Sidekick a Channel or Space may recommend: one that exists and belongs
   * to the Organization. Read from the directory row, which carries its scope
   * before an import too, so the check costs no call of its own.
   */
  private assertRecommendableSidekick(sidekickId: string): void {
    const row = this.state.storage.sql.exec<{ scope: string; lifecycle: string }>(
      `SELECT scope, lifecycle FROM automation_directory WHERE automation_id = ?`, sidekickId,
    ).toArray()[0];
    if (!row || row.lifecycle === "deleted") throw new Error("sidekick_not_found");
    if (row.scope !== "workspace") throw new Error("sidekick_attachment_scope_invalid");
  }

  // Sidekick recommendations.

  async recommendedSidekickIds(input: Parameters<HostedParent["recommendedSidekickIds"]>[0]) {
    return (await this.hostedParent(input.parentId, input.workspaceId)).recommendedSidekickIds(input);
  }

  async readManagementAccess(input: Parameters<HostedParent["readManagementAccess"]>[0]) {
    return (await this.hostedParent(input.parentId, input.workspaceId)).readManagementAccess(input);
  }

  async setSidekickRecommendation(input: Parameters<HostedParent["setSidekickRecommendation"]>[0]) {
    // The Sidekick is checked after the caller's access, so a refusal does
    // not say whether an id names a Sidekick.
    return (await this.hostedParent(input.parentId, input.workspaceId))
      .setSidekickRecommendation(input, (sidekickId) => this.assertRecommendableSidekick(sidekickId));
  }

  // Grants, invitations and the participant handoff.

  async scopeSharingOptions(input: Parameters<HostedParent["scopeSharingOptions"]>[0]) {
    return (await this.channelParent(input.parentId, input.workspaceId)).scopeSharingOptions(input);
  }

  async listManagedScopeGrants(input: Parameters<HostedParent["listManagedScopeGrants"]>[0]) {
    return (await this.channelParent(input.target.parentId, input.target.workspaceId)).listManagedScopeGrants(input);
  }

  async listScopeInvitations(input: Parameters<HostedParent["listScopeInvitations"]>[0]) {
    return (await this.channelParent(input.target.parentId, input.target.workspaceId)).listScopeInvitations(input);
  }

  async createScopeInvitations(input: Parameters<HostedParent["createScopeInvitations"]>[0]) {
    return this.parentWrite(async () => (await this.channelParent(input.parentId, input.workspaceId)).createScopeInvitations(input));
  }

  async claimScopeInvitations(input: Parameters<HostedParent["claimScopeInvitations"]>[0]) {
    return this.parentWrite(async () => (await this.channelParent(input.parentId, input.workspaceId)).claimScopeInvitations(input));
  }

  async revokeScopeInvitation(input: Parameters<HostedParent["revokeScopeInvitation"]>[0]) {
    return (await this.channelParent(input.parentId, input.workspaceId)).revokeScopeInvitation(input);
  }

  async readScopeAccess(input: Parameters<HostedParent["readScopeAccess"]>[0]) {
    return (await this.hostedParent(input.target.parentId, input.target.workspaceId)).readScopeAccess(input);
  }

  /**
   * `readSharedWorkstream` for every named Channel in one round trip, in the
   * order named, each Channel still deciding for itself what it releases. The
   * Channels are hosted here, so the fan-out a caller would otherwise make one
   * RPC per Channel is a loop over local parents.
   */
  async readSharedWorkstreams(
    input: Omit<Parameters<HostedParent["readSharedWorkstream"]>[0], "parentId"> & { parentIds: string[] },
  ) {
    const { parentIds, ...request } = input;
    const items = [];
    for (const parentId of parentIds) {
      items.push(await (await this.channelParent(parentId, request.workspaceId)).readSharedWorkstream({ ...request, parentId }));
    }
    return items;
  }

  async mutateScopeGrant(input: Parameters<HostedParent["mutateScopeGrant"]>[0]) {
    return this.parentWrite(async () => (await this.channelParent(input.target.parentId, input.target.workspaceId)).mutateScopeGrant(input));
  }

  async mutateParticipantGrant(input: Parameters<HostedParent["mutateParticipantGrant"]>[0]) {
    return this.parentWrite(async () => (await this.channelParent(input.target.parentId, input.target.workspaceId))
      .mutateParticipantGrant(input));
  }

  async admitConnectorParticipants(input: Parameters<HostedParent["admitConnectorParticipants"]>[0]) {
    return this.parentWrite(async () => (await this.channelParent(input.parentId, input.workspaceId)).admitConnectorParticipants(input));
  }

  async joinConversation(input: Parameters<HostedParent["joinConversation"]>[0]) {
    return this.parentWrite(async () => (await this.channelParent(input.target.parentId, input.target.workspaceId)).joinConversation(input));
  }

  async beginMainParticipantMigration(input: Parameters<HostedParent["beginMainParticipantMigration"]>[0]) {
    return this.parentWrite(async () => (await this.hostedParent(input.parentId, input.workspaceId)).beginMainParticipantMigration(input));
  }

  async beginChildParticipantMigration(input: Parameters<HostedParent["beginChildParticipantMigration"]>[0]) {
    return this.parentWrite(async () => (await this.hostedParent(input.parentId, input.workspaceId)).beginChildParticipantMigration(input));
  }

  // Private breakouts.

  async beginPrivateChildPreparation(input: Parameters<HostedParent["beginPrivateChildPreparation"]>[0]) {
    return this.parentWrite(async () => (await this.hostedParent(input.parentId, input.workspaceId)).beginPrivateChildPreparation(input));
  }

  async readPrivateChildPreparation(input: Parameters<HostedParent["readPrivateChildPreparation"]>[0]) {
    return (await this.hostedParent(input.parentId, input.workspaceId)).readPrivateChildPreparation(input);
  }

  async claimPrivateChildConfirmation(input: Parameters<HostedParent["claimPrivateChildConfirmation"]>[0]) {
    return (await this.hostedParent(input.parentId, input.workspaceId)).claimPrivateChildConfirmation(input);
  }

  async savePrivateChildCapture(input: Parameters<HostedParent["savePrivateChildCapture"]>[0]) {
    return (await this.hostedParent(input.parentId, input.workspaceId)).savePrivateChildCapture(input);
  }

  async savePrivateChildPart(input: Parameters<HostedParent["savePrivateChildPart"]>[0]) {
    return (await this.hostedParent(input.parentId, input.workspaceId)).savePrivateChildPart(input);
  }

  async savePreparedPrivateChildContext(input: Parameters<HostedParent["savePreparedPrivateChildContext"]>[0]) {
    return (await this.hostedParent(input.parentId, input.workspaceId)).savePreparedPrivateChildContext(input);
  }

  async setPrivateChildTerminalStatus(input: Parameters<HostedParent["setPrivateChildTerminalStatus"]>[0]) {
    return this.parentWrite(async () => (await this.hostedParent(input.parentId, input.workspaceId)).setPrivateChildTerminalStatus(input));
  }

  /**
   * The Breakouts one person may open under each named parent, in the order
   * named, from one statement. A parent this object does not host answers no
   * Breakouts, as it does on the sidebar's control socket.
   */
  async listVisiblePrivateChildrenForParents(
    input: Omit<ListVisiblePrivateChildrenRequest, "parentId"> & { parentIds: string[] },
  ) {
    await this.initialized;
    await this.ensureParentWorkspace(input.workspaceId);
    const children = visiblePrivateChildren(this.state.storage.sql, input.userId, input.parentIds);
    return { parents: input.parentIds.map((parentId) => ({ parentId, children: children.get(parentId) ?? [] })) };
  }

  async addPrivateChildParticipant(input: Parameters<HostedParent["addPrivateChildParticipant"]>[0]) {
    return this.parentWrite(async () => (await this.hostedParent(input.parentId, input.workspaceId)).addPrivateChildParticipant(input));
  }

  async removePrivateChildParticipant(input: Parameters<HostedParent["removePrivateChildParticipant"]>[0]) {
    return this.parentWrite(async () => (await this.hostedParent(input.parentId, input.workspaceId)).removePrivateChildParticipant(input));
  }

  async setPrivateChildArchived(input: Parameters<HostedParent["setPrivateChildArchived"]>[0]) {
    return this.parentWrite(async () => (await this.hostedParent(input.parentId, input.workspaceId)).setPrivateChildArchived(input));
  }

  // Socket revocation for a parent's Channel control sockets.

  /**
   * The `workstream_audience_narrowed` hop, parent step included.
   *
   * Closes the Channel's control sockets it can no longer admit, then, for each
   * person whose socket that was, runs the per-user parent step here too: the
   * conversations the revocation continues to, and the Sidekicks the Channel
   * owns. Both lists are this object's rows, so the consumer publishes only
   * the leaves instead of a `workstream` and a `workstream_automations` hop per
   * person that each came straight back here.
   *
   * The per-user step carries `workstream_participant_removed`, the reason a
   * narrowing is published with: losing the Channel keeps any breakout the
   * person can still read. `closedUserIds` stays in the answer so a consumer
   * from before this change still publishes its two hops per person.
   */
  async revokeNarrowedAudienceAccess(input: Parameters<HostedParent["revokeNarrowedAudienceAccess"]>[0]): Promise<{
    closedUserIds: string[];
    substreams: { userId: string; substreamIds: string[] }[];
    automationIds: string[];
  }> {
    const parent = await this.hostedParent(input.parentId, input.workspaceId);
    const { closedUserIds } = await parent.revokeNarrowedAudienceAccess(input);
    const substreams: { userId: string; substreamIds: string[] }[] = [];
    for (const userId of closedUserIds) {
      const { substreamIds } = await parent.revokeSocketAccess({
        reason: "workstream_participant_removed", workspaceId: asWorkspaceId(input.workspaceId), userId, sessionId: null,
      });
      substreams.push({ userId, substreamIds });
    }
    return {
      closedUserIds,
      substreams,
      automationIds: closedUserIds.length ? this.automationIdsOwnedBy(input.parentId) : [],
    };
  }

  /** The `workstream` revocation hop: close this Channel's control sockets and name its conversations. */
  async revokeParentSocketAccess(input: { parentId: string; revocation: SocketAccessRevocation }) {
    const parentId = IdSchema.parse(input.parentId);
    return (await this.hostedParent(parentId)).revokeSocketAccess(input.revocation);
  }

  override async fetch(request: Request): Promise<Response> {
    await this.initialized;
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && (path === "/socket" || path === "/")) {
      return this.acceptSocket(request);
    }
    // The retired Channel control socket, for clients released before a
    // Channel's state moved onto its workspace-socket row.
    if (request.method === "GET" && path === "/parent-socket") {
      const parentId = WorkstreamIdSchema.safeParse(readRallyHeader(request.headers, RALLY_HEADERS.WORKSTREAM_ID));
      if (!parentId.success) return json({ error: "invalid_socket_identity" }, 400);
      const response = await (await this.hostedParent(parentId.data)).acceptSocket(request);
      if (response.status === 101) this.wakeMainConversation(parentId.data);
      return response;
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

  /** A Channel message's search watermark, without reading the message. */
  async channelMessageSearchRevision(input: unknown): Promise<number | null> {
    await this.initialized;
    const request = parseRpcInput(ChannelMessageSearchRevisionRequestSchema, input, "channel_message_search_revision");
    this.assertWorkspace(request.workspaceId);
    return channelMessageSearchRevision(this.state.storage.sql, request.messageId);
  }

  /** A Channel message's search document, or its deletion watermark; see channel-message-search-projection.ts. */
  async prepareChannelMessageSearch(input: unknown) {
    await this.initialized;
    const request = parseRpcInput(ChannelMessageSearchProjectionSchema, input, "prepare_channel_message_search");
    this.assertWorkspace(request.workspaceId);
    if (request.region !== this.env.AVALON_REGION) throw new Error("search_projection_region_mismatch");
    return prepareChannelMessageSearch(this.state.storage.sql, request.messageId);
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
    // A Channel control socket belongs to its hosted parent. Its attachment is
    // one the workspace reader refuses, so it is recognized first.
    const control = readControlSocketAttachment(socket);
    if (control) {
      const parent = await this.hostedParent(control.workstreamId);
      await parent.onSocketMessage(socket, control, message);
      return;
    }
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
    if (isUnknownSocketEvent(decoded, WorkspaceSocketClientEventTypeSchema)) return;
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
      // A Channel the viewer cannot see is recorded as no Channel at all. The
      // renderer can route to one the directory has not listed for it yet (a
      // Channel still being created, a link from elsewhere), and closing here
      // ended the whole Organization socket for good: 4400 is permanent to the
      // client, so the sidebar stayed stale until a restart. It is kept as
      // pending so the directory change that lists it promotes it.
      const requestedWorkstreamId = parsed.data.foregroundWorkstreamId;
      const foregroundWorkstreamId = requestedWorkstreamId !== null
        && this.directoryVisible(viewerOf(currentAttachment), requestedWorkstreamId)
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
      if (presenceChanged && parsed.data.applicationState === "foreground"
        && foregroundWorkstreamId !== null) {
        this.recordChannelOpened(currentAttachment, foregroundWorkstreamId);
      }
      return;
    }
    if (parsed.data.type === "space_channels") {
      const auth = await this.sessionAuth(attachment);
      if (!auth) {
        this.closeSocket(socket, attachment, {
          code: WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
          reason: "Session no longer active",
          cause: "session_inactive",
          operation: "space_channels",
        });
        return;
      }
      this.answerSpaceChannels(socket, {
        workspaceId: attachment.workspaceId, userId: attachment.userId, accessClass: auth.accessClass ?? "member",
      }, parsed.data);
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
      }, viewerOf(attachment).accessClass, true);
      socket.send(JSON.stringify(WorkspaceWorkstreamPageEventSchema.parse({
        type: "workspace_workstream_page",
        requestId: parsed.data.requestId,
        ...page,
      })));
      return;
    }
    if (parsed.data.type === "channel_rails") {
      const auth = await this.sessionAuth(attachment);
      if (!auth) {
        this.closeSocket(socket, attachment, {
          code: WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
          reason: "Session no longer active",
          cause: "session_inactive",
          operation: "channel_rails",
        });
        return;
      }
      this.answerChannelRails(socket, {
        workspaceId: attachment.workspaceId, userId: attachment.userId, accessClass: auth.accessClass ?? "member",
      }, parsed.data);
      return;
    }
  }

  /**
   * Answer `channel_rails` from local reads, as `workspace_channel_rails`
   * frames; the answer always ends with a `final` one.
   *
   * Named Channels are answered whole, over as many frames as they take. The
   * retired Space target, still sent by desktops 1.467.0 and 1.468.0, is
   * answered with one empty final frame: refusing it would close their socket
   * on every reconnect, and a Space's rails now arrive with its rows.
   *
   * A rail that fails its schema is sent as `oversized`, so the client paints
   * that Channel from its snapshot, and the log names the field.
   */
  private answerChannelRails(
    socket: WebSocket,
    identity: { workspaceId: string; userId: string; accessClass: "member" | "guest" },
    request: Extract<WorkspaceSocketClientEvent, { type: "channel_rails" }>,
  ): void {
    const sql = this.state.storage.sql;
    const frames = new ChannelRailFrames(request.requestId, this.channelRailFrameBytes);
    const rails = (workstreamIds: readonly string[]) => channelRails(sql, {
      userId: identity.userId,
      accessClass: identity.accessClass,
      workspaceId: identity.workspaceId,
      workstreamIds,
      onInvalidAppearance: this.invalidAppearanceReporter(identity.workspaceId),
    });
    const pack = (rail: ChannelRail) => {
      const parsed = ChannelRailSchema.safeParse(rail);
      if (parsed.success) return frames.add(parsed.data);
      logError(this.env, "channel_rail_invalid", {
        workspace_id: identity.workspaceId,
        workstream_id: rail.workstreamId,
        code: zodDiagnosticCode(parsed.error, "channel_rail") ?? "channel_rail_invalid",
      });
      return frames.addOversized(rail);
    };
    if (!request.workstreamIds) {
      // The retired Space target: nothing to answer.
    } else if (!this.railLedger) {
      frames.addUnavailable(request.workstreamIds);
    } else {
      const answer = rails(request.workstreamIds);
      frames.addUnavailable(answer.unavailable);
      for (const rail of answer.rails) {
        if (pack(rail) !== "full") continue;
        frames.roll();
        pack(rail);
      }
    }
    for (const oversized of frames.oversizedRails) {
      logWarn(this.env, "channel_rail_oversized", {
        workspace_id: identity.workspaceId,
        workstream_id: oversized.workstreamId,
        bytes: oversized.bytes,
      });
    }
    for (const frame of frames.finish()) {
      try {
        socket.send(JSON.stringify(frame));
      } catch {
        // A closed socket asks again when it reconnects.
        return;
      }
    }
  }

  /**
   * Answer `space_channels` with one `workspace_space_channels` frame: a page
   * of the Space's Channels this viewer may see, as directory rows, and as
   * many of their rails as fit beside them.
   *
   * The page is the one `channel_rails` reads for a Space, so a hidden Channel
   * is never on it and `nextAfter` never names one. A Space the viewer cannot
   * see is answered with an empty page. The page leaves out
   * system Channels, as the connect page does.
   *
   * Rails are an extra: one that does not fit, or fails its schema, is left
   * out, and the client asks for it by name.
   */
  private answerSpaceChannels(
    socket: WebSocket,
    identity: { workspaceId: string; userId: string; accessClass: "member" | "guest" },
    request: Extract<WorkspaceSocketClientEvent, { type: "space_channels" }>,
  ): void {
    const sql = this.state.storage.sql;
    const spaces = this.spaceStorage();
    const viewer: Viewer = { userId: identity.userId, accessClass: identity.accessClass };
    const page = spaces.reach(viewer, request.spaceId) !== null
      ? visibleSpaceChannelIdsAfter(sql, {
        spaceId: request.spaceId,
        userId: identity.userId,
        accessClass: identity.accessClass,
        breakouts: spaces.breakoutsReady(),
        after: request.after ?? null,
        limit: CHANNEL_RAILS_NAMED_LIMIT,
      })
      : [];
    const byId = new Map(boundParameterChunks(page).flatMap((chunk) => sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
        WHERE directory.workstream_id IN (${chunk.map(() => "?").join(", ")})`,
      identity.userId, identity.userId, ...chunk,
    ).toArray()).map((row) => [row.workstream_id, row]));
    const rows = page.flatMap((id) => byId.get(id) ?? []);
    const frame = WorkspaceSpaceChannelsEventSchema.parse({
      type: "workspace_space_channels",
      requestId: request.requestId,
      directoryWaterline: this.directoryWaterline(),
      items: mapDirectoryWorkstreams(sql, rows, identity.workspaceId, spaces, viewer, true),
      stateVersions: rows.map(directoryStateVersion),
      rails: [],
      nextAfter: page.length === CHANNEL_RAILS_NAMED_LIMIT ? page.at(-1)! : null,
    });
    if (request.rails && this.railLedger && rows.length > 0) {
      const encoder = new TextEncoder();
      let used = encoder.encode(JSON.stringify(frame)).byteLength;
      const answer = channelRails(sql, {
        userId: identity.userId,
        accessClass: identity.accessClass,
        workspaceId: identity.workspaceId,
        workstreamIds: rows.map((row) => row.workstream_id),
        onInvalidAppearance: this.invalidAppearanceReporter(identity.workspaceId),
      });
      for (const rail of answer.rails) {
        const parsed = ChannelRailSchema.safeParse(rail);
        if (!parsed.success) {
          logError(this.env, "channel_rail_invalid", {
            workspace_id: identity.workspaceId,
            workstream_id: rail.workstreamId,
            code: zodDiagnosticCode(parsed.error, "channel_rail") ?? "channel_rail_invalid",
          });
          continue;
        }
        const cost = encoder.encode(JSON.stringify(parsed.data)).byteLength + (frame.rails.length > 0 ? 1 : 0);
        if (used + cost > this.channelRailFrameBytes) break;
        frame.rails.push(parsed.data);
        used += cost;
      }
    }
    try {
      socket.send(JSON.stringify(frame));
    } catch {
      // A closed socket asks again when it reconnects.
    }
  }

  /** A Thread whose stored appearance no longer parses is named on its Sidekicks without one. */
  private invalidThreadAppearanceReporter(workspaceId: string): InvalidThreadAppearanceReport {
    return (workstreamId, code) => logWarn(this.env, "owning_thread_appearance_invalid", {
      workspace_id: workspaceId,
      workstream_id: workstreamId,
      code,
    });
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
   * The person in this window just opened a Channel listed for them: wake its
   * Main and record when they opened it.
   */
  private recordChannelOpened(attachment: WorkspaceSocketAttachment, workstreamId: string): void {
    const now = Date.now();
    // Opening a Channel is the moment its Main is about to be read. The
    // Channel control socket used to start this wake; a desktop that no
    // longer opens one says it here instead, ahead of its feed ticket.
    // Somebody listed the Channel only through a Breakout opens that
    // Breakout, not Main, so Main is not theirs to wake.
    if (this.mainOpenable(viewerOf(attachment), workstreamId)) this.wakeMainConversation(workstreamId);
    // A support session reads without becoming the person's recent history
    // (`docs/impersonation.md`); the wake above is only about speed.
    if (attachment.impersonatorUserId) return;
    this.state.storage.transactionSync(() => {
      this.state.storage.sql.exec(
        `INSERT INTO workspace_workstream_access(user_id, workstream_id, last_accessed_at)
         VALUES (?, ?, ?) ON CONFLICT(user_id, workstream_id)
         DO UPDATE SET last_accessed_at = excluded.last_accessed_at`,
        attachment.userId, workstreamId, now,
      );
      this.advanceDirectoryVersion(now);
    });
    // Every caller has already found this Channel listed for this viewer, so
    // its row is theirs to be sent.
    const row = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY} WHERE directory.workstream_id = ?`,
      attachment.userId, attachment.userId, workstreamId,
    ).one();
    const payload = JSON.stringify(WorkspaceWorkstreamRecencyEventSchema.parse({
      type: "workspace_workstream_recency",
      directoryWaterline: this.directoryWaterline(),
      workstream: mapDirectoryWorkstreams(
        this.state.storage.sql, [row], attachment.workspaceId,
        this.spaceStorage(), viewerOf(attachment), true,
      )[0],
      stateVersion: directoryStateVersion(row),
    }));
    for (const peer of this.state.getWebSockets()) {
      const peerAttachment = readAttachment(peer);
      if (!peerAttachment?.subscribed || peerAttachment.userId !== attachment.userId) continue;
      try {
        peer.send(payload);
      } catch {
        // Reconnecting reconstructs the saved order from SQLite.
      }
    }
  }

  /**
   * Send each connection only the presence for the work stream it currently
   * foregrounds. This both avoids leaking personal work-stream identities and
   * keeps the frame equal to the one face pile the renderer can paint.
   */
  private broadcastPresence(excluding?: WebSocket): void {
    const sockets: Array<{ socket: WebSocket; attachment: WorkspaceSocketAttachment; inMain: boolean }> = [];
    const opened: Array<{ attachment: WorkspaceSocketAttachment; workstreamId: string }> = [];
    for (const socket of this.state.getWebSockets()) {
      if (socket === excluding) continue;
      let attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      const pending = attachment.pendingForegroundWorkstreamId ?? null;
      if (pending !== null && attachment.applicationState === "foreground"
        && attachment.foregroundWorkstreamId === null
        && this.directoryVisible(viewerOf(attachment), pending)) {
        const promoted: WorkspaceSocketAttachment = {
          ...attachment,
          foregroundWorkstreamId: pending,
          pendingForegroundWorkstreamId: null,
        };
        try {
          socket.serializeAttachment(promoted);
          attachment = promoted;
          opened.push({ attachment, workstreamId: pending });
        } catch {
          // Stays as no Channel; the next focus change sends presence again.
        }
      }
      if (contributesPresence(attachment)
        && !this.directoryVisible(viewerOf(attachment), attachment.foregroundWorkstreamId)) {
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
        // Somebody listed the Channel only through a Breakout is not in Main's
        // audience: they neither join its face pile nor see who is in it.
        inMain: contributesPresence(attachment)
          && this.mainOpenable(viewerOf(attachment), attachment.foregroundWorkstreamId),
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
    for (const { attachment, workstreamId } of opened) this.recordChannelOpened(attachment, workstreamId);
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
    // An Organization held below the parent schema has no `parent_*` tables.
    const hosted = this.hostedParentSchemaPresent();
    return {
      parent_outbox: () => hosted ? this.nextParentOutboxDueAt() : null,
      parent_breakouts: () => hosted ? HostedParent.nextDueAt(sql) : null,
      directory_followup: () => hosted ? this.nextDirectoryFollowUpDueAt() : null,
      authorization_delivery: () =>
        sql.exec<{ due: number | null }>("SELECT MIN(not_before) AS due FROM authorization_delivery").one().due,
      resource_search: () => nextResourceSearchDueAt(sql, this.env, this.resourceSearchPace),
      channel_message_search: () => nextChannelMessageSearchDueAt(sql, this.env, this.channelMessageSearchPace),
      space_default_publish: () => this.spaceStorage().nextDefaultPublicationDueAt(),
      space_bootstrap: () => this.spaceStorage().nextBootstrapDueAt(),
      channel_color_sync: () => nextChannelColorSyncAt(sql),
      thread_backfill: () => nextThreadBackfillAt(sql),
      import_reservation_reclaim: () => nextImportReservationReclaimAt(sql),
      memory_digest_sync: () => nextMemoryDigestSyncAt(sql),
      activity_reap: () => {
        const oldest = sql.exec<{ created_at: number | null }>(
          "SELECT MIN(created_at) AS created_at FROM workspace_activity_events",
        ).one().created_at;
        return oldest === null ? null : Number(oldest) + ACTIVITY_EVENT_RETENTION_MS;
      },
      connector_event_reap: () => {
        const oldest = sql.exec<{ received_at: number | null }>(
          "SELECT MIN(received_at) AS received_at FROM workspace_connector_events WHERE processing_status = 'processed'",
        ).one().received_at;
        return oldest === null ? null : Number(oldest) + CONNECTOR_EVENT_BODY_RETENTION_MS;
      },
      space_intent_resume: () => this.spaceStorage().nextIntentResumeDueAt(),
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
    this.railLedger = this.state.storage.sql.exec(
      `SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'channel_rail_changes'`,
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
      // Hosted parents first: an outbox row is a directory update somebody is
      // waiting to see. An Organization below the parent schema has no due
      // time for any of the three.
      if (due("parent_outbox")) await isolated("parent_outbox", () => this.drainParentOutbox());
      if (due("parent_breakouts")) await isolated("parent_breakouts", () => this.drainDueParentBreakouts(now));
      if (due("directory_followup")) {
        await isolated("directory_followup", () => this.runDirectoryFollowUps(this.dueDirectoryFollowUps(now)));
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
      if (due("channel_message_search")) {
        try { await publishChannelMessageSearch(this.state.storage.sql, this.env, workspaceId, this.channelMessageSearchPace); }
        catch { logWarn(this.env, "channel_message_search_dispatch_deferred", { workspace_id: workspaceId }); }
      }
      if (due("space_default_publish")) await this.instrumentWorkspaceAlarmPhase("space_default_publish", undefined, async () => {
        try {
          await publishSpaceDefaultTargets({
            storage: this.spaceStorage(),
            queue: this.env.ACTIVITY_QUEUE,
            workspaceId,
            region: this.env.AVALON_REGION,
            now,
            retryAt: (attempt) => now + scheduledAlarmRetryDelay(attempt),
          });
        } catch (error) {
          logWarn(this.env, "space_default_publication_failed", {
            workspace_id: workspaceId,
            reason: error instanceof Error ? error.message : "unknown",
          });
        }
      });
      // The one-time cutover. It is here rather than on first access because
      // the PRD's fleet migration must finish without relying on anybody
      // signing in: the tracker's forced migration wakes every Organization,
      // the alarm armed by construction claims a page, and the Queue carries
      // it to a consumer that can act as one of the Channel's own people.
      if (due("space_bootstrap")) await this.instrumentWorkspaceAlarmPhase("space_bootstrap", undefined, async () => {
        try {
          await publishSpaceBootstrapWork({
            storage: this.spaceStorage(),
            queue: this.env.ACTIVITY_QUEUE,
            workspaceId,
            region: this.env.AVALON_REGION,
            now,
            retryAt: (attempt) => now + scheduledAlarmRetryDelay(attempt),
          });
        } catch (error) {
          logWarn(this.env, "space_bootstrap_publication_failed", {
            workspace_id: workspaceId,
            reason: error instanceof Error ? error.message : "unknown",
          });
        }
      });
      // Threads whose colour can have moved; see channel-color-sync.ts.
      if (due("channel_color_sync")) await this.instrumentWorkspaceAlarmPhase("channel_color_sync", undefined, async () => {
        try {
          await publishChannelColorSync({
            sql: this.state.storage.sql,
            queue: this.env.ACTIVITY_QUEUE,
            workspaceId,
            region: this.env.AVALON_REGION,
            now,
            retryAt: (attempt) => now + scheduledAlarmRetryDelay(attempt),
          });
        } catch (error) {
          logWarn(this.env, "channel_color_sync_publication_failed", {
            workspace_id: workspaceId,
            reason: diagnosticErrorCode(error, "channel_color_sync_publication_failed"),
          });
        }
      });
      // One-off jobs over every thread; see thread-backfill.ts.
      if (due("thread_backfill")) await this.instrumentWorkspaceAlarmPhase("thread_backfill", undefined, async () => {
        try {
          await publishThreadBackfill({
            sql: this.state.storage.sql,
            queue: this.env.ACTIVITY_QUEUE,
            workspaceId,
            region: this.env.AVALON_REGION,
            now,
            retryAt: (attempt) => now + scheduledAlarmRetryDelay(attempt),
          });
        } catch (error) {
          logWarn(this.env, "thread_backfill_publication_failed", {
            workspace_id: workspaceId,
            reason: diagnosticErrorCode(error, "thread_backfill_publication_failed"),
          });
        }
      });
      // Import reservations whose thread never opened; see import-reservation-reclaim.ts.
      if (due("import_reservation_reclaim")) await isolated("import_reservation_reclaim", () => reclaimDueImportReservations({
        sql: this.state.storage.sql,
        now,
        reclaim: async ({ parentId, userId }) => {
          if (!await retireUnopenedImportKey(this.env.DB, { workspaceId, workstreamId: parentId, userId })) return;
          const result = await this.discardReservedMain({ workspaceId, parentId, userId });
          if (result.status === "refused") {
            logWarn(this.env, "import_reservation_reclaim_refused", {
              workspace_id: workspaceId, workstream_id: parentId, code: result.code,
            });
          }
        },
        retryAt: (attempt) => now + scheduledAlarmRetryDelay(attempt),
        onFailure: ({ parentId }, error) => logWarn(this.env, "import_reservation_reclaim_failed", {
          workspace_id: workspaceId,
          workstream_id: parentId,
          reason: diagnosticErrorCode(error, "import_reservation_reclaim_failed"),
        }),
      }));
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
    if (due("activity_reap")) {
      await isolated("activity_reap", async () => {
        this.reapExpiredActivityEvents(now);
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
      // An interrupted Space operation finishes here. Nothing else would: the
      // request that staged the intent is gone, and the Channel it was about to
      // reach was never told the operation existed. Last, because each step
      // waits on a Channel's conversation and the phases above do not.
      if (due("space_intent_resume")) await this.instrumentWorkspaceAlarmPhase("space_intent_resume", undefined, async () => {
        try {
          const claimed = this.spaceStorage().claimIntentResumes(now, (attempt) => now + scheduledAlarmRetryDelay(attempt));
          await this.resumeSpaceIntentsInPlace(workspaceId, claimed);
        } catch (error) {
          logWarn(this.env, "space_intent_resume_claim_failed", {
            workspace_id: workspaceId,
            reason: diagnosticErrorCode(error, "space_intent_resume_claim_failed"),
          });
        }
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
            if (this.sidekickDirectoryMoved) {
              this.sidekickDirectoryMoved = false;
              this.publishSidebarList("automations");
            }
          }
        }
        if (await this.runHostedParentAlarm(alarm)) return;
        if (alarm.kind === PRODUCT_ALARM_KIND) {
          await this.runProductAlarm(workspaceId);
          return;
        }
        if (alarm.kind === PERSONAL_CHANNEL_BACKFILL_ALARM_KIND) {
          await this.backfillPersonalChannels(workspaceId);
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
      // The directory row carries one deadline per Channel; which
      // conversation it belongs to is the Channel's hosted parent's knowledge,
      // read from its rows in this object.
      dueTerminalSubstreams: async (workstreamId, through) => {
        const parent = await this.hostedParent(workstreamId);
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
  /**
   * The automations a work stream owns, for the revocation walk.
   *
   * A room-owned automation admits the room's participants, and removing one
   * of them is a write the room makes locally, which no membership revocation
   * follows. The room's writer publishes a `workstream_automations` hop, and
   * this is how the consumer turns it into one `automation` hop per owned
   * automation; unlike `listWorkstreamAutomations` it asks nothing about the
   * caller, since the consumer is not a participant of anything.
   */
  async automationIdsOwnedByWorkstream(input: unknown): Promise<{ automationIds: string[] }> {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, workstreamId: IdSchema }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return { automationIds: this.automationIdsOwnedBy(request.workstreamId) };
  }

  /** The live Sidekicks a Channel owns, each an `automation` revocation hop. */
  private automationIdsOwnedBy(workstreamId: string): string[] {
    return this.state.storage.sql.exec<{ automation_id: string }>(
      `SELECT automation_id FROM automation_directory
        WHERE owning_workstream_id = ? AND lifecycle <> 'deleted' ORDER BY automation_id`,
      workstreamId,
    ).toArray().map((row) => row.automation_id);
  }

  /**
   * The `workstream` hop for every hosted Channel a person could hold a socket
   * on, run here in the same call as the workspace hop.
   *
   * A Channel's control sockets are this object's sockets and its children are
   * this object's rows, so publishing a `workstream` message per Channel only
   * for it to come back here was a Queue round trip per Channel before any
   * conversation heard.
   */
  private async revokeHostedChannelAccess(
    workstreamIds: readonly string[],
    revocation: SocketAccessRevocation,
  ): Promise<{ workstreamId: string; substreamIds: string[] }[]> {
    const channels: { workstreamId: string; substreamIds: string[] }[] = [];
    for (const workstreamId of workstreamIds) {
      const { substreamIds } = await (await this.hostedParent(workstreamId)).revokeSocketAccess(revocation);
      channels.push({ workstreamId, substreamIds });
    }
    return channels;
  }

  async revokeSocketAccess(revocation: SocketAccessRevocation): Promise<{
    /**
     * Every Channel the person could hold a socket on. A Channel also named in
     * `channels` has had its hop run here; a consumer publishes a `workstream`
     * hop only for the rest. Kept whole so a consumer from before `channels`
     * still reaches every Channel.
     */
    workstreamIds: string[];
    /** The Channels whose `workstream` hop this call ran, with the conversations each names. */
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
    const workstreamIds = this.revocableWorkstreamIds(request.userId);
    return {
      workstreamIds,
      channels: await this.revokeHostedChannelAccess(workstreamIds, request),
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
         FROM channels directory
         LEFT JOIN channel_viewers viewer
           ON viewer.workstream_id = directory.workstream_id AND viewer.user_id = ?
        WHERE viewer.user_id IS NOT NULL OR directory.scope = 'workspace'
        ORDER BY directory.workstream_id`,
      userId,
    ).toArray().map((row) => row.workstream_id);
  }

  /**
   * Pin the workspace identity before any child object can be resolved, and
   * answer whether the Organization's Spaces are ready to draw. With
   * `general` (whose D1 anchor the caller wrote), a new Organization's General
   * is made and its cutover closed here. See docs/spaces.md#general.
   */
  async initializeWorkspace(
    workspaceId: string,
    placementAffinity: WorkspacePlacementAffinity,
    general?: WorkspaceGeneralOpening,
  ): Promise<{ spacesReady: boolean }> {
    await this.initialized;
    this.ensureIdentity(workspaceId, placementAffinity);
    // The identity above is the call's contract; the Spaces are best effort, as
    // `openGeneralSpaceForNewWorkspace` is, so a failure there answers not
    // ready and the caller's slower path (and the alarm behind it) takes over
    // rather than failing an Organization whose rows are already committed.
    try {
      return { spacesReady: await this.openSpaces(workspaceId, general) };
    } catch (error) {
      logWarn(this.env, "space_general_open_failed", {
        workspace_id: workspaceId,
        reason: diagnosticErrorCode(error, "space_general_open_failed"),
      });
      return { spacesReady: false };
    }
  }

  private async openSpaces(workspaceId: string, general: WorkspaceGeneralOpening | undefined): Promise<boolean> {
    const storage = this.spaceStorage();
    if (!storage.ready()) return false;
    if (storage.bootstrapStatus().ready) return true;
    if (storage.generalSpaceId() === null) {
      if (general === undefined) return false;
      const opening = parseRpcInput(WorkspaceGeneralOpeningSchema, general, "initialize_workspace_general");
      const refusal = await this.spaceRefusalCode(workspaceId, opening.creatorUserId, "write");
      const opened = refusal === null
        ? await this.reserveGeneral(
          { workspaceId, userId: opening.creatorUserId },
          opening.spaceId,
          opening.authorityGeneration,
        )
        : { ok: false as const, code: refusal };
      if (!opened.ok) {
        logWarn(this.env, "space_general_open_refused", { workspace_id: workspaceId, reason: opened.code });
        return false;
      }
    }
    // The creator's Personal Channel, outside General's branch so a replayed
    // creation whose General committed but whose Personal Channel did not
    // tries it again. A refusal is logged by the reservation; the creator's
    // own relationship delivery seats them as well.
    if (general?.personalSpaceId !== undefined && storage.personalSpaceId(general.creatorUserId) === null) {
      await this.reservePersonalSpace(workspaceId, general.creatorUserId, general.personalSpaceId, general.authorityGeneration);
    }
    if (storage.completeBootstrap() !== "complete") return false;
    this.publishSpaceSnapshot();
    return true;
  }

  /**
   * Queue the one seating pass migration 103 runs (`backfillPersonalChannels`)
   * when the cutover closes. A member who joined while it was open was
   * answered `spaces_not_open` and is seated here, as is anybody a backfill
   * pass skipped for the same reason, so no relationship delivery or alarm
   * waits on a cutover that may never close. Idempotent: the pass seats nobody
   * twice. Not called when a new Organization opens: its creator is seated in
   * that same call, and it has nobody else yet.
   */
  private async seatEveryoneOnceSpacesOpen(): Promise<void> {
    if (!this.hasUnseatedMember()) return;
    this.scheduledAlarms.schedule({ kind: PERSONAL_CHANNEL_BACKFILL_ALARM_KIND, key: "workspace", dueAt: Date.now() });
    await this.armNextAlarm();
  }

  /**
   * Whether this object knows an active non-guest member who is not in
   * General or has no Personal Channel: one read of its own tables, so a
   * cutover with nobody to seat queues nothing.
   */
  private hasUnseatedMember(): boolean {
    const generalSpaceId = this.spaceStorage().generalSpaceId();
    return this.state.storage.sql.exec(
      `SELECT 1 FROM workspace_member_status status
        WHERE status.active = 1
          AND json_extract(status.relationship_json, '$.accessClass') = 'member'
          AND (NOT EXISTS (SELECT 1 FROM space_viewers viewer
                            WHERE viewer.space_id = ? AND viewer.user_id = status.user_id AND viewer.is_participant = 1)
               OR NOT EXISTS (SELECT 1 FROM spaces space
                               WHERE space.scope = 'individual' AND space.created_by_user_id = status.user_id))
        LIMIT 1`,
      generalSpaceId,
    ).toArray().length > 0;
  }

  /**
   * Put a member who just became active in General and give them their
   * Personal Channel; see docs/spaces.md#the-personal-channel. Server-to-server,
   * from the relationship change, and idempotent: a redelivery seats nobody
   * twice and finds the Personal Channel present.
   *
   * Two calls, the way `openGeneralSpace` is: the Personal Channel needs its
   * D1 anchor before it exists, and only this object knows whether it does.
   * The first answers `absent`; the caller writes the anchor under
   * `personalSpaceId` and asks again with the generation it wrote it at.
   */
  async seatOrganizationMember(input: WorkspaceSeatMemberRequest): Promise<WorkspaceSeatMemberResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSeatMemberRequestSchema, input, "seat_organization_member");
    this.assertWorkspace(request.workspaceId);
    const storage = this.spaceStorage();
    if (!storage.ready() || !storage.bootstrapStatus().ready) return { seated: false, reason: "spaces_not_open" };
    if (!await this.activeSpaceMember(request.workspaceId, request.userId)) return { seated: false, reason: "not_member" };
    if (storage.seatMember(request.userId)) this.publishSpaceSnapshot();
    if (storage.personalSpaceId(request.userId) !== null) return { seated: true, personalSpace: "present" };
    if (request.authorityGeneration === undefined) return { seated: true, personalSpace: "absent" };
    const refusal = await this.reservePersonalSpace(
      request.workspaceId, request.userId, request.personalSpaceId, request.authorityGeneration,
    );
    // Thrown so the relationship delivery retries; the code names why.
    if (refusal !== null) throw new Error(refusal);
    return { seated: true, personalSpace: "present" };
  }

  /**
   * Migration 103's one pass: every active non-guest member of an Organization
   * that existed before Personal Channels is seated in General and given one,
   * anchoring each in D1 here as `seatOrganizationMember`'s caller does. Each
   * member's steps are idempotent, so a pass that throws part way is retried
   * by the alarm from the top and redoes nothing.
   *
   * Settles without seating anybody while the Organization's Spaces are not
   * open: closing the cutover queues this pass again
   * (`seatEveryoneOnceSpacesOpen`), and a cutover blocked for good would
   * otherwise retry this alarm for ever.
   */
  private async backfillPersonalChannels(workspaceId: string): Promise<void> {
    const storage = this.spaceStorage();
    if (!storage.ready() || !storage.bootstrapStatus().ready) return;
    const members = await this.env.DB.prepare(
      `SELECT user_id FROM workspace_members
        WHERE workspace_id = ? AND status = 'active' AND access_class = 'member'
        ORDER BY user_id`,
    ).bind(workspaceId).all<{ user_id: string }>();
    let seated = false;
    for (const { user_id: userId } of members.results) {
      // The object's own copy decides, as it does for every other seating.
      if (!await this.activeSpaceMember(workspaceId, userId)) continue;
      if (storage.seatMember(userId)) seated = true;
      if (storage.personalSpaceId(userId) !== null) continue;
      const spaceId = await personalSpaceIdFor(workspaceId, userId);
      const { generation } = await claimParentAnchor(this.env, workspaceId, spaceId, "space");
      const refusal = await this.reservePersonalSpace(workspaceId, userId, spaceId, generation);
      if (refusal !== null) throw new Error(refusal);
    }
    // An Organization from before Channel messages: what General opens with,
    // dated when General was made, so it is still the first thing there.
    const generalSpaceId = storage.generalSpaceId();
    if (generalSpaceId !== null) storage.postStartingMessages(generalSpaceId, GENERAL_CHANNEL.messages);
    if (seated) this.publishSpaceSnapshot();
  }

  /**
   * Write a member's Personal Channel and its hosted parent under `spaceId`,
   * whose D1 anchor the caller has written, in one transaction; or seat them
   * in the one they already have. Answers why not when the id names
   * something other than a Space, or the authority generation is unusable.
   */
  private async reservePersonalSpace(
    workspaceId: string,
    userId: string,
    spaceId: string,
    authorityGeneration: number,
  ): Promise<SpaceErrorCode | null> {
    const storage = this.spaceStorage();
    const parent = await this.spaceParentReservation(spaceId, authorityGeneration);
    if (!parent.ok) {
      logWarn(this.env, "space_personal_reserve_refused", { workspace_id: workspaceId, reason: parent.code });
      return parent.code;
    }
    const personal = await this.withMembersLearned(() => this.state.storage.transactionSync(() => {
      const reserved = storage.reservePersonal(workspaceId, userId, spaceId, PERSONAL_CHANNEL);
      if (reserved.created) parent.reserve(userId, reserved.space);
      return reserved;
    }));
    this.publishSpaceSnapshot();
    if (personal.created) await this.afterParentWrite();
    return null;
  }

  /** Which room owns an automation, and which of its conversations is home, for a caller resolving participation. */
  async automationOwner(input: unknown): Promise<{ owningWorkstreamId: string | null; owningSubstreamId: string }> {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, automationId: IdSchema }).parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{ owning_workstream_id: string | null; owning_substream_id: string }>(
      `SELECT owning_workstream_id, owning_substream_id FROM automation_directory
        WHERE automation_id = ? AND lifecycle <> 'deleted'`,
      request.automationId,
    ).toArray()[0];
    return { owningWorkstreamId: row?.owning_workstream_id ?? null, owningSubstreamId: row?.owning_substream_id ?? "0" };
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
    const scoped = scopeConversations(this.state.storage.sql, request.scope, request.userId);
    const conversations = await this.reachableConversations(request.workspaceId, request.scope, scoped, request.userId);
    const channels = await this.conversationToolChannels(request.workspaceId, request.scope, request.userId);
    return { conversations: [...conversations.map(conversationToolEntry), ...channels] };
  }

  /**
   * For a Thread or Breakout loop, the Channels its Thread is in that this
   * person may list today, unarchived, Organization-wide ones first. Each is a
   * conversation whose messages are the Channel's feed: its threads and the
   * results merged into it. The id is the Space's own, a UUID no Thread
   * shares. Listing is not admission: a read goes through `listChannelFeed`,
   * which asks the person's reach again, so this never widens what they see.
   */
  private async conversationToolChannels(
    workspaceId: string,
    scope: ConversationToolScope,
    userId: string,
  ): Promise<ConversationToolEntry[]> {
    if (scope.kind !== "conversation") return [];
    const viewer = await this.spaceReader(workspaceId, userId);
    if (!viewer) return [];
    const spaces = this.spaceStorage();
    return spaces.channelSpaceIds(viewer, scope.parentId).flatMap((spaceId) => {
      const space = spaces.readable(viewer, spaceId);
      return space ? [conversationToolEntry({ conversationId: spaceId, parentId: spaceId, substreamId: "0",
        kind: "space", title: space.name, isHome: false, isOwn: false, isParent: true })] : [];
    });
  }

  /**
   * The unarchived conversations of a scope this person can read, as each
   * Channel's own authority answers it (`readableSubstreams`, the rule its
   * canonical reads and search's audience apply) for this person's
   * relationship, each through its `admissionAddress`. Asked once per Channel,
   * inside this object.
   */
  private async reachableConversations<T extends { parentId: string; substreamId: string; readable: boolean; archived: boolean }>(
    workspaceId: string,
    scope: ConversationToolScope,
    scoped: readonly T[],
    userId: string,
  ): Promise<T[]> {
    const relationship = await this.readRelationship(workspaceId, userId);
    if (relationship?.status !== "active") return [];
    const unarchived = scoped.filter((conversation) => !conversation.archived);
    if (!this.hostedParentSchemaPresent()) return [];
    const readable = new Map<string, ReadonlySet<string>>();
    for (const parentId of new Set(unarchived.map((conversation) => conversation.parentId))) {
      readable.set(parentId, new Set((await this.hostedParent(parentId)).readableSubstreams(asUserId(userId), relationship)));
    }
    return unarchived.filter((conversation) => {
      const admitted = admissionAddress(scope, conversation);
      return readable.get(admitted.parentId)?.has(admitted.substreamId) === true;
    });
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
  ): Promise<{ authorized: boolean; archived: boolean }> {
    const relationship = await this.readRelationship(workspaceId, userId);
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
    const scoped = scopeConversations(this.state.storage.sql, request.scope, request.userId);
    const channels = await this.conversationToolChannels(request.workspaceId, request.scope, request.userId);
    // Only a refusal lists what the person can reach, so only a refusal pays for it.
    const available = async () => [
      ...(await this.reachableConversations(request.workspaceId, request.scope, scoped, request.userId))
        .map((conversation) => conversation.conversationId),
      ...channels.map((channel) => channel.conversationId),
    ];
    let target: ScopedConversation | undefined;
    if (request.reference === null) {
      target = scoped.find((conversation) => conversation.isHome);
      if (!target) return conversationToolRefusal("conversation_home_missing", await available());
    } else {
      const match = matchConversationReference<ScopedConversation | ConversationToolEntry>(
        [...scoped, ...channels], request.reference);
      if (match.outcome === "missing") return conversationToolRefusal("conversation_not_in_scope", await available());
      if (match.outcome === "ambiguous") {
        return conversationToolRefusal("conversation_ambiguous", match.matches.map((conversation) => conversation.conversationId));
      }
      // A Channel was listed for this person just now; its feed read admits them again.
      if (match.conversation.kind === "space") return { ok: true, conversation: match.conversation, sidekickName: null };
      target = match.conversation as ScopedConversation;
    }
    const resourceId = target.substreamId === "0" ? target.parentId : target.substreamId;
    if (target.archived) return conversationToolRefusal("conversation_archived", [], resourceId);
    const admission = await this.conversationToolAdmission(
      request.workspaceId, admissionAddress(request.scope, target), request.userId,
    );
    if (!admission.authorized) return conversationToolRefusal("conversation_access_denied", [], resourceId);
    if (admission.archived) return conversationToolRefusal("conversation_archived", [], resourceId);
    const sidekickName = request.scope.kind !== "sidekick" ? null
      : this.state.storage.sql.exec<{ title: string }>(
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
    let address = parseConversationId(request.reference);
    if (!address) {
      const titled = conversationsTitled(sql, request.reference, request.userId);
      if (titled.length === 0) return conversationToolRefusal("conversation_not_found", []);
      if (titled.length > 1) {
        return conversationToolRefusal("conversation_ambiguous", titled.map((conversation) => conversation.conversationId));
      }
      address = titled[0]!;
    }
    const facts = describeConversation(sql, address, request.userId);
    if (!facts) return conversationToolRefusal("conversation_not_found", []);
    const resourceId = address.substreamId === "0" ? address.parentId : address.substreamId;
    if (facts.archived) return conversationToolRefusal("conversation_archived", [], resourceId);
    const admission = await this.conversationToolAdmission(request.workspaceId, address, request.userId);
    if (!admission.authorized) return conversationToolRefusal("conversation_access_denied", [], resourceId);
    if (admission.archived) return conversationToolRefusal("conversation_archived", [], resourceId);
    const attached = this.state.storage.transactionSync(() => {
      if (sql.exec(`SELECT 1 FROM automation_directory WHERE automation_id = ? AND lifecycle <> 'deleted'`,
        request.automationId).toArray().length === 0) return null;
      return attachSidekickConversation(sql, {
        automationId: request.automationId, address: address!, userId: request.userId, now: Date.now(),
      });
    });
    if (!attached) throw new ApiError(404, "sidekick_not_found", "This Sidekick does not exist");
    const scoped = scopeConversations(sql, { kind: "sidekick", automationId: request.automationId }, request.userId)
      .find((conversation) => conversation.parentId === address!.parentId && conversation.substreamId === address!.substreamId);
    return {
      ok: true,
      alreadyAttached: attached.alreadyAttached,
      conversation: conversationToolEntry(scoped ?? {
        ...address, conversationId: conversationIdOf(address), kind: facts.kind, title: facts.title,
        isHome: false, isOwn: false, isParent: false,
      }),
    };
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
      author_user_id: string; run_as_user_id: string | null; owning_substream_id: string; workspace_id: string;
    }>(
      `SELECT * FROM automation_directory WHERE workspace_id = ? AND lifecycle <> 'deleted'
       ORDER BY title COLLATE NOCASE, automation_id`, request.workspaceId,
    ).toArray();
    // The management read rule (`sidekickReaderAllows`), the same one the
    // detail screen applies: a guest is not listed Organization-scope
    // Sidekicks, a Breakout-homed one is listed to that Breakout's members,
    // and a personal one to the person it runs as.
    // The role decides Organization-scope rows only, so it is read at most
    // once and only when such a row is not already the person's own.
    let actorRole: "owner" | "admin" | "member" | null | undefined = request.accessClass === undefined
      ? undefined
      : request.accessClass === "guest" ? null : request.role ?? null;
    const host = this.hostedSidekickHost();
    const admitted: typeof candidates = [];
    for (const row of candidates) {
      const own = row.author_user_id === request.userId || row.run_as_user_id === request.userId;
      if (actorRole === undefined && row.scope === "workspace" && !own) {
        const relationship = await this.readRelationship(request.workspaceId, request.userId);
        actorRole = relationship?.accessClass === "guest" ? null : relationship?.role ?? null;
      }
      const actor = { userId: request.userId, actorRole: actorRole ?? null };
      // A Main-homed Channel Sidekick asks `isWorkstreamParticipant`, a local
      // read; only a Breakout-homed one asks the Breakout's viewer rule.
      if (await sidekickReaderAllows({ ...row, run_as_user_id: row.run_as_user_id ?? null }, actor, host)) {
        admitted.push(row);
      }
    }
    // Each Thread-owned row names its Thread to a reader who is in it, in one
    // read for the whole list. An author who has left the Thread still reads
    // the Sidekick, and sees "Thread" rather than the name of a room they are
    // no longer in.
    const threadIds = admitted.flatMap((row) => row.scope === "workstream" && row.owning_workstream_id !== null
      && this.isWorkstreamParticipant(row.owning_workstream_id, request.userId) ? [row.owning_workstream_id] : []);
    const threads = owningThreads(this.state.storage.sql, threadIds, this.invalidThreadAppearanceReporter(request.workspaceId));
    const report = this.invalidAppearanceReporter(request.workspaceId);
    return {
      items: admitted.map((row) => automationSummary(row, report,
        row.owning_workstream_id === null ? null : threads.get(row.owning_workstream_id) ?? null)),
    };
  }

  /**
   * The automations one work stream owns, for that work stream's rail.
   *
   * The counterpart to the sidebar's list, which excludes exactly these rows.
   * A room's automation is managed by the room's participants, so the gate is
   * participation rather than authorship: the person who created it may be
   * gone, and the automation is still theirs to pause. Participation, not
   * listability: a workspace-scoped room is listable to every member, and
   * gating on that would hand its automations to people who are not in it.
   */
  async listWorkstreamAutomations(input: unknown): Promise<{ items: WorkstreamAutomationSummary[] }> {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema,
      workstreamId: IdSchema,
      userId: UserIdSchema,
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      throw new ApiError(403, "sidekick_directory_access_denied", "You cannot list this room's Sidekicks");
    }
    // An archived room's rail still renders, and its automations are paused
    // rather than gone, so a participant of the archived room may list them.
    if (!this.isWorkstreamParticipant(request.workstreamId, request.userId, { includeArchived: true })) {
      throw new ApiError(403, "sidekick_directory_access_denied", "You cannot list this room's Sidekicks");
    }
    return {
      items: ownedAutomationSummaries(this.state.storage.sql, [request.workstreamId],
        this.invalidAppearanceReporter(request.workspaceId)).get(request.workstreamId) ?? [],
    };
  }

  /**
   * Whether this person is an active participant of this work stream.
   *
   * The one predicate every "does the room let you" decision here is built on,
   * so the answer cannot drift between the list, the details, and acceptance.
   */
  private isWorkstreamParticipant(
    workstreamId: string,
    userId: string,
    options: { includeArchived?: boolean } = {},
  ): boolean {
    return this.state.storage.sql.exec<{ is_participant: number }>(
      `SELECT viewer.is_participant
         FROM channel_viewers viewer
         JOIN channels directory
           ON directory.workstream_id = viewer.workstream_id
          AND directory.authority_generation = viewer.authority_generation
        WHERE viewer.workstream_id = ? AND viewer.user_id = ?
          AND (? = 1 OR directory.archived_at IS NULL)`,
      workstreamId,
      userId,
      options.includeArchived ? 1 : 0,
    ).toArray()[0]?.is_participant === 1;
  }

  /**
   * Whether somebody may act on a work stream, asked by the object that has
   * to know and cannot see this directory: an automation owned by a room
   * answers its viewer question with this.
   */
  async workstreamParticipant(input: unknown): Promise<{ participant: boolean }> {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema,
      workstreamId: IdSchema,
      userId: UserIdSchema,
      /** An archived room's participants still manage what the room owns. */
      includeArchived: z.boolean().optional(),
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return {
      participant: this.isWorkstreamParticipant(request.workstreamId, request.userId, {
        includeArchived: request.includeArchived === true,
      }),
    };
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
  ): { effectiveAfterEventSequence: number; applied: true } {
    const destinationKind = request.destination.kind;
    const cutoff = this.latestConnectorEventSequence();
    this.state.storage.sql.exec(
      `UPDATE workspace_external_event_registrations
          SET state = 'removed', updated_at = ?
        WHERE destination_kind = ? AND destination_key = ?
          AND state = 'active'`,
      now,
      destinationKind,
      destinationKey,
    );
    this.state.storage.sql.exec(
      `UPDATE schedules SET enabled = 0, updated_at = ? WHERE id IN (
        SELECT registration_id FROM workspace_external_event_registrations
        WHERE destination_key = ? AND connector_type = 'canva')`,
      new Date(now).toISOString(), destinationKey,
    );
    for (const evaluator of request.evaluators) {
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
    for (const evaluator of request.evaluators) {
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
        await this.env.ACTIVITY_QUEUE.send(SlackIngressQueueMessageSchema.parse({
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
    const visibility = JSON.parse(event.visibility_json) as { kind?: unknown; scope?: unknown };
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
      audienceUserIds: JSON.parse(event.target_user_ids_json) as string[],
      audienceKind: visibility.kind === "workspace" || visibility.scope === "workspace"
        ? "workspace" as const
        : "restricted" as const,
    };
    // A message in a bound external conversation is claimed by its binding,
    // as a matched watch claims one, so a bound reply never also becomes
    // Suggested Work. The adapter wrote the binding key beside the provider
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
    const deliveries = registrations.flatMap((registration) => {
      if (registration.resource_id && !resourceIds.includes(registration.resource_id)) return [];
      if (boundSidekickId !== null && registration.automation_id === boundSidekickId) return [];
      if (restrictedUserIds !== null && registration.destination_kind === "automation") {
        // A workspace automation is readable by every member, so a restricted
        // activity can never reach one. A personal automation may see it only
        // when its own author is inside the audience.
        const audience = registration.automation_id === null ? null : this.state.storage.sql.exec<{
          scope: string;
          author_user_id: string;
        }>(`SELECT scope, author_user_id FROM automation_directory WHERE automation_id = ?`,
          registration.automation_id).toArray()[0];
        if (!audience || audience.scope !== "personal") return [];
        if (!restrictedUserIds.includes(audience.author_user_id)) return [];
      }
      const evaluator = ExternalEventEvaluatorV1Schema.parse(JSON.parse(registration.evaluator_json));
      if (!evaluateExternalEventPredicate(evaluator.when, context)) return [];
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
    });
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
   * Every Space write, and the member walk, starts here: an active
   * Organization membership that is not a guest relationship. A guest sees the
   * Spaces the listing rules give them (`spaceReader`), and changes none.
   */
  private async activeSpaceMember(workspaceId: string, userId: string): Promise<boolean> {
    const relationship = await this.readRelationship(workspaceId, userId);
    return relationship?.status === "active" && relationship.accessClass === "member";
  }

  /**
   * The viewer a Space read lists for, or null without an active relationship.
   * A read admits a guest as well as a member: what each may be told is the
   * listing rules' answer, not this gate's.
   */
  private async spaceReader(workspaceId: string, userId: string): Promise<Viewer | null> {
    const relationship = await this.readRelationship(workspaceId, userId);
    return relationship?.status === "active" ? { userId, accessClass: relationship.accessClass } : null;
  }

  /**
   * The gate every Space RPC passes, and the one place all three halves are
   * decided.
   *
   * An active non-guest Organization membership; for anything that writes,
   * Space tables that exist; and, for a write *named against a Space*, a
   * relationship with that Space stronger than having read a Channel in it.
   * The second half is why this is a function rather than two lines at each
   * call site: an Organization held at schema 57 by the meeting-notes
   * retirement has no Space tables at all, and a write that reached storage
   * would abort with `no such table` instead of a code a route can render. A
   * *read* needs no entry here: every Space read answers its own empty state
   * through `WorkspaceSpaceStorage.ready`, so a client on a pending
   * Organization sees no Spaces rather than a failed connect.
   *
   * The third half is what a Space's reach costs. A person who can read one
   * Channel placed in a participants-only Space is now told that Space's mark
   * and name, so the Channel has somewhere to be drawn — and every storage
   * predicate that decides *may I see this* admits them. Each of those used to
   * be the whole of the check on a write, so the write is named here instead,
   * with the code that already means "you may not edit this Space":
   * `space_access_denied`. `space_not_found` would be the lie — they are
   * looking at the row.
   *
   * `spaceId` is deliberately omitted by two writes. A creation has no Space
   * to name yet, and `reorderContainer` is a person arranging *their own*
   * view of a list — the Organization's Spaces, a Space's Channels, a
   * Channel's Breakouts — which is theirs to arrange whatever their reach is.
   *
   * Returns the code to refuse with, or null to proceed. The result shapes
   * differ across these RPCs — some failures carry `unreachableUserIds` and
   * some are strict without it — so the caller writes the object and this
   * decides the word.
   */
  private async spaceRefusalCode(
    workspaceId: string,
    userId: string,
    intent: "read" | "write",
    spaceId?: string,
  ): Promise<SpaceErrorCode | null> {
    if (!await this.activeSpaceMember(workspaceId, userId)) return "space_access_denied";
    if (intent !== "write") return null;
    const storage = this.spaceStorage();
    if (!storage.ready()) return "space_bootstrap_pending";
    if (spaceId !== undefined && storage.reach(member(userId), spaceId) === "through_channel") {
      return "space_access_denied";
    }
    return null;
  }

  /**
   * Whether this person may create a Space, asked before anything is written.
   *
   * `SpaceService.create` writes the D1 anchor before `reserveSpace`, so the
   * gate has to be answered first: otherwise every refused attempt leaves an
   * anchor behind. The same gate `reserveSpace` applies again.
   */
  async admitSpaceCreation(input: WorkspaceSpaceListRequest): Promise<{ ok: true } | { ok: false; code: SpaceErrorCode }> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceListRequestSchema, input, "admit_space_creation");
    this.assertWorkspace(request.workspaceId);
    const refusal = await this.spaceRefusalCode(request.workspaceId, request.userId, "write");
    return refusal ? { ok: false, code: refusal } : { ok: true };
  }

  /**
   * Allocate a Space and answer with it.
   *
   * The Space's row and its hosted parent (metadata, main child and
   * provisional directory projection) are written in one transaction.
   * `SpaceService.create` has already asked `admitSpaceCreation` and written
   * the D1 anchor under this id. A replay of an existing, readable id reserves
   * the parent again, which is idempotent.
   */
  async reserveSpace(input: WorkspaceSpaceReserveRequest): Promise<WorkspaceSpaceReserveResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceReserveRequestSchema, input, "reserve_space");
    this.assertWorkspace(request.workspaceId);
    const refusal = await this.spaceRefusalCode(request.workspaceId, request.userId, "write");
    if (refusal) return { ok: false, code: refusal, unreachableUserIds: [], blockedWorkstreamIds: [] };
    const spaceId = request.spaceId ?? uuidV7();
    const parent = await this.spaceParentReservation(spaceId);
    if (!parent.ok) return { ok: false, code: parent.code, unreachableUserIds: [], blockedWorkstreamIds: [] };
    const reserved = await this.withMembersLearned(() => this.state.storage.transactionSync(() => {
      const result = this.spaceStorage().reserveForCreation(request, spaceId);
      if (result.space) parent.reserve(request.userId, result.space);
      return result;
    }));
    if (!reserved.space) return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
    await this.afterParentWrite();
    return WorkspaceSpaceReserveResultSchema.parse({ ok: true, ...reserved });
  }

  /**
   * What reserving a Space's hosted parent needs from outside the transaction:
   * the regional authority generation the parent is born at. An id this object already hosts as a Channel is refused as
   * `space_not_found`, the answer an identity the caller cannot use as a Space
   * always gets; a generation D1 cannot supply is `space_authority_unreachable`.
   */
  private async spaceParentReservation(spaceId: string, authorityGeneration?: number): Promise<
    | { ok: false; code: "space_not_found" | "space_authority_unreachable" }
    | { ok: true; reserve: (userId: string, space: SpaceSummary) => void }
  > {
    const known = this.state.storage.sql.exec<{ parent_kind: string }>(
      "SELECT parent_kind FROM parent_metadata WHERE parent_id = ?", spaceId,
    ).toArray()[0]?.parent_kind;
    if (known !== undefined && known !== "space") return { ok: false, code: "space_not_found" };
    const authority = authorityGeneration === undefined
      ? await readWorkstreamAuthorityControl(this.env)
      : { generation: authorityGeneration };
    if (authority.generation < 1) return { ok: false, code: "space_authority_unreachable" };
    const workspaceId = this.workspaceId();
    if (!workspaceId) throw new Error("workspace_identity_unknown");
    return {
      ok: true,
      reserve: (userId, space) => {
        new HostedParent(this.hostedParentHost(), space.id, HOSTED_SPACE_ROLE).reserveChild({
          workspaceId: asWorkspaceId(workspaceId),
          parentId: space.id,
          substreamId: asSubstreamId("0"),
          kind: "main",
          createdByUserId: asUserId(userId),
          authorityGeneration: authority.generation,
          directory: {
            title: space.name,
            description: "",
            // A conversation parent's scope is a thread's: the participants,
            // or everyone. A Personal Channel's participants are its owner.
            scope: space.scope === "individual" ? "personal" : space.scope,
            systemKind: null,
            emailAddress: null,
            titleStatus: "settled",
            createdAt: space.createdAt,
          },
        });
      },
    };
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
  /**
   * General as this caller may read it, or `null` while there is none.
   * Writes nothing, unlike `openGeneralSpace`, which records General on the
   * cutover's row: for a reader that polls, such as demo readiness.
   */
  async readGeneralSpace(input: WorkspaceSpaceGeneralRequest): Promise<{ ok: true; space: SpaceSummary | null } | { ok: false; code: SpaceErrorCode }> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceGeneralRequestSchema, input, "read_general_space");
    this.assertWorkspace(request.workspaceId);
    const refusal = await this.spaceRefusalCode(request.workspaceId, request.userId, "read");
    if (refusal) return { ok: false, code: refusal };
    const storage = this.spaceStorage();
    const generalSpaceId = storage.generalSpaceId();
    if (generalSpaceId === null) return { ok: true, space: null };
    const space = storage.readable(member(request.userId), generalSpaceId);
    return space === false ? { ok: false, code: "space_not_found" } : { ok: true, space };
  }

  async openGeneralSpace(input: WorkspaceSpaceGeneralRequest): Promise<WorkspaceSpaceGeneralOpenResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceGeneralRequestSchema, input, "open_general_space");
    this.assertWorkspace(request.workspaceId);
    const refusal = await this.spaceRefusalCode(request.workspaceId, request.userId, "write");
    if (refusal) return { ok: false, code: refusal };
    const storage = this.spaceStorage();
    const existing = storage.generalSpaceId();
    if (existing !== null) {
      const space = storage.readable(member(request.userId), existing);
      if (space === false) return { ok: false, code: "space_not_found" };
      storage.noteGeneralSpace(space.id);
      return WorkspaceSpaceGeneralOpenResultSchema.parse({ ok: true, space, created: false });
    }
    if (request.spaceId === undefined) return { ok: true, absent: true };
    const general = await this.reserveGeneral(request, request.spaceId);
    if (!general.ok) return general;
    return WorkspaceSpaceGeneralOpenResultSchema.parse({ ok: true, space: general.space, created: general.created });
  }

  /**
   * Write General and its hosted parent under `spaceId`, whose D1 anchor the
   * caller has written, or answer with the General a concurrent caller made.
   * The caller has passed `spaceRefusalCode`. `authorityGeneration` is the
   * generation that anchor was written at, when the caller already read it.
   */
  private async reserveGeneral(
    request: { workspaceId: string; userId: string },
    spaceId: string,
    authorityGeneration?: number,
  ): Promise<{ ok: true; space: SpaceSummary; created: boolean } | { ok: false; code: SpaceErrorCode }> {
    const storage = this.spaceStorage();
    const parent = await this.spaceParentReservation(spaceId, authorityGeneration);
    if (!parent.ok) return { ok: false, code: parent.code };
    const general = await this.withMembersLearned(() => this.state.storage.transactionSync(() => {
      const ensured = storage.ensureGeneral(WorkspaceDO.generalReservation(request), spaceId, GENERAL_CHANNEL.messages);
      if (ensured.created) parent.reserve(request.userId, ensured.space);
      return ensured;
    }));
    if (!general.created && storage.readable(member(request.userId), general.space.id) === false) {
      return { ok: false, code: "space_not_found" };
    }
    storage.noteGeneralSpace(general.space.id);
    if (general.created) {
      this.publishSpaceSnapshot();
      await this.afterParentWrite();
    }
    return { ok: true, ...general };
  }

  private static generalReservation(request: { workspaceId: string; userId: string }): WorkspaceSpaceReserveRequest {
    return {
      workspaceId: asWorkspaceId(request.workspaceId),
      userId: asUserId(request.userId),
      space: { name: GENERAL_CHANNEL.name, iconKey: GENERAL_CHANNEL.iconKey, colorKey: GENERAL_CHANNEL.colorKey, scope: "workspace" },
    };
  }

  /**
   * Put one container's items in the order this person asked for.
   *
   * One RPC for the Organization's Spaces, a Space's Channels and a Channel's
   * Breakouts, because the authority's job is identical for all three — check
   * who is asking, keep the items that belong in that container, write the
   * positions — and only the middle step differs by kind. Three RPCs would have
   * been three membership rechecks and three republications to keep in step.
   *
   * The refusal is the one every Space write takes: an active non-guest member
   * of this Organization. A Breakout's order is not a Space fact, but it is
   * kept behind the same gate on purpose — the rows live in this object, they
   * ride the Space snapshot, and a second authorization rule for one of three
   * kinds is a second thing to get wrong.
   *
   * It is the one write that does **not** name its Space to that gate. An
   * arrangement is this person's own view preference, read by nobody else, so
   * a Space they reach only through a Channel in it is theirs to arrange
   * exactly like any other row in their sidebar — and the Channels under it
   * are the Channels they can already read. What may be in each list is still
   * filtered per kind, by the same reads that decide what they are shown.
   *
   * The republication is what makes the order the *person's* rather than the
   * window's: every socket this member holds is re-sent their whole ordering,
   * so a second window follows a drag made in the first without a reload. It
   * goes to those sockets and no others. An arrangement is one person's view
   * preference and no part of it is visible to anybody else, while a snapshot
   * costs a `list()` transaction and a full directory serialization per socket
   * — so an Organization-wide fan-out would charge every member for it, and a
   * held Alt+Arrow would charge them once per step.
   *
   * The Organization-wide waterline still advances, because there is one and
   * these rows are behind it. That is what the actor's *other* sessions test
   * the snapshot against, and a snapshot they had already passed is one they
   * would drop. Everybody else re-applies a directory that did not change for
   * them the next time anything at all republishes — which is a comparison,
   * not a redraw, and is the price of one waterline rather than one per person.
   */
  async reorderContainer(input: WorkspaceContainerOrderRequest): Promise<WorkspaceContainerOrderResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceContainerOrderRequestSchema, input, "reorder_container");
    this.assertWorkspace(request.workspaceId);
    const refusal = await this.spaceRefusalCode(request.workspaceId, request.userId, "write");
    if (refusal) return { ok: false, code: refusal };
    const storage = this.spaceStorage();
    if (!storage.canArrange(request.userId, request.order.container)) {
      return { ok: false, code: "space_not_found" };
    }
    const result = WorkspaceContainerOrderResultSchema.parse({
      ok: true,
      order: storage.writeOrder(request.workspaceId, request.userId, request.order),
    });
    this.publishSpaceSnapshot(request.userId);
    return result;
  }

  /**
   * Save this person's order for **All**'s Pinned section and answer with what
   * was stored, republishing it to their other sessions as `reorderContainer`
   * does. Anyone who may arrange their own lists may arrange this one.
   */
  async reorderAllPinned(input: WorkspacePinnedOrderRequest): Promise<WorkspacePinnedOrderResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspacePinnedOrderRequestSchema, input, "reorder_all_pinned");
    this.assertWorkspace(request.workspaceId);
    const refusal = await this.spaceRefusalCode(request.workspaceId, request.userId, "write");
    if (refusal) return { ok: false, code: refusal };
    const result = WorkspacePinnedOrderResultSchema.parse({
      ok: true,
      itemIds: this.spaceStorage().writePinnedOrder(request.userId, request.itemIds, Date.now()),
    });
    this.publishSpaceSnapshot(request.userId);
    return result;
  }

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

  async spaceSummary(input: WorkspaceSpaceRequest): Promise<WorkspaceSpaceMutationResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceRequestSchema, input, "space_summary");
    this.assertWorkspace(request.workspaceId);
    const viewer = await this.spaceReader(request.workspaceId, request.userId);
    if (!viewer) return { ok: false, code: "space_access_denied", unreachableUserIds: [], blockedWorkstreamIds: [] };
    const space = this.spaceStorage().readable(viewer, request.spaceId);
    return WorkspaceSpaceMutationResultSchema.parse(space === false
      ? { ok: false, code: "space_not_found" }
      : { ok: true, space });
  }

  /**
   * What each keyed conversation looks like to this viewer, in the order the
   * keys came in: the projection the dashboard, the Threads tab and anything
   * else listing a mix of threads and breakouts answer with.
   *
   * Two reads rather than one join, because the two kinds live in two tables
   * on purpose (`workspace-breakout-storage.ts` says why). A key the second
   * read cannot find — a thread this viewer may not open after all, which is
   * the directory's fact rather than the caller's — is dropped.
   */
  private conversationRows(
    viewer: Viewer,
    workspaceId: string,
    keys: readonly SpaceConversationKey[],
  ): SpaceConversation[] {
    const channelIds = keys.flatMap((item) => (
      item.kind === "channel" ? [item.workstreamId] : []
    ));
    const breakoutIds = keys.flatMap((item) => (
      item.kind === "breakout" && item.substreamId !== null ? [item.substreamId] : []
    ));
    // Chunked, because a page is up to `SPACE_CHANNEL_PAGE_SIZE` ids and one
    // statement binds at most a hundred parameters.
    const channelRows = boundParameterChunks(channelIds).flatMap((chunk) =>
      this.state.storage.sql.exec<WorkspaceDirectoryRow>(
        `${SELECT_WORKSPACE_DIRECTORY}
         WHERE directory.workstream_id IN (${chunk.map(() => "?").join(", ")})
           AND ${mainOpenableSql("directory", "viewer", viewer.accessClass)}
         ORDER BY directory.workstream_id`,
        viewer.userId,
        viewer.userId,
        ...chunk,
      ).toArray());
    const breakoutRows = boundParameterChunks(breakoutIds).flatMap((chunk) =>
      this.state.storage.sql.exec<WorkspaceBreakoutRow>(
        `${SELECT_WORKSPACE_BREAKOUT}
         WHERE breakout.substream_id IN (${chunk.map(() => "?").join(", ")})
         ORDER BY breakout.substream_id`,
        viewer.userId,
        ...chunk,
      ).toArray());
    const spaceStorage = this.spaceStorage();
    const channels = new Map(mapDirectoryWorkstreams(
      this.state.storage.sql, channelRows, workspaceId, spaceStorage, viewer,
    ).map((workstream) => [workstream.id as string, workstream]));
    // A breakout's Spaces are its parent Channel's: a breakout has no
    // membership of its own, and the field is what a client uses to decide
    // which Space a row belongs under.
    const spaceIdsByChannel = spaceStorage.spaceIdsByChannel(
      viewer, [...new Set(breakoutRows.map((row) => row.workstream_id))],
    );
    const breakouts = new Map(breakoutRows.map((row) => [
      row.substream_id,
      breakoutConversation(row, workspaceId, spaceIdsByChannel.get(row.workstream_id) ?? []),
    ]));
    return keys.flatMap((item) => {
      if (item.kind === "channel") {
        const channel = channels.get(item.workstreamId);
        return channel ? [{ ...channel, kind: "channel" as const, breakoutOf: null }] : [];
      }
      const breakout = item.substreamId === null ? undefined : breakouts.get(item.substreamId);
      return breakout ? [breakout] : [];
    });
  }

  /**
   * One page of the conversations in a Space that currently need this viewer.
   *
   * The route is still `/spaces/:id/channels` and the RPC still carries that
   * word, but what it answers is the Space's member Channels *and their
   * breakouts* in one activity-ordered list, with everything that is stale for
   * this viewer left out. The Space authority decides which conversations the
   * page is about and in what order; this method decides what each of them
   * looks like to this viewer, through the same projection `listDirectory`
   * answers a sidebar page with for a Channel and its breakout equivalent for
   * a breakout.
   *
   * Two reads rather than one join, because the two kinds live in two tables
   * on purpose (`workspace-breakout-storage.ts` says why) and the page's order
   * has already been decided. The rows come back keyed and are put back into
   * the page's order here; a row whose key the second read cannot find — a
   * Channel this viewer may not read after all, which is the directory's fact
   * rather than the membership's — is dropped, so a page can come back shorter
   * than its cursor suggests and the cursor still continues from the
   * conversation it was taken at.
   */
  async listSpaceChannels(input: WorkspaceSpaceChannelPageRequest): Promise<WorkspaceSpaceChannelPageResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceChannelPageRequestSchema, input, "list_space_channels");
    this.assertWorkspace(request.workspaceId);
    const viewer = await this.spaceReader(request.workspaceId, request.userId);
    if (!viewer) return { ok: false, code: "space_access_denied" };
    const page = this.spaceStorage().conversationPage(viewer, request.spaceId, request.cursor);
    if (page === "invalid_cursor") return { ok: false, code: "space_cursor_invalid" };
    if (page === false) return { ok: false, code: "space_not_found" };
    const items = this.conversationRows(viewer, request.workspaceId, page.items);
    return WorkspaceSpaceChannelPageResultSchema.parse({
      ok: true,
      page: { items, nextCursor: page.nextCursor },
    });
  }

  /**
   * One page of a Channel's feed (the storage Space's threads, newest placement
   * first): the threads this viewer may open, each whole. One they may not open
   * is not on the page at all.
   */
  async listChannelFeed(input: WorkspaceSpaceChannelPageRequest): Promise<WorkspaceChannelFeedResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceChannelPageRequestSchema, input, "list_channel_feed");
    this.assertWorkspace(request.workspaceId);
    const viewer = await this.spaceReader(request.workspaceId, request.userId);
    if (!viewer) return { ok: false, code: "space_access_denied" };
    const page = this.spaceStorage().feedPage(viewer, request.spaceId, request.cursor);
    if (page === "invalid_cursor") return { ok: false, code: "space_cursor_invalid" };
    if (page === false) return { ok: false, code: "space_not_found" };
    const threads = new Map(this.conversationRows(
      viewer,
      request.workspaceId,
      page.items.flatMap((item) => (item.kind === "thread"
        ? [{ kind: "channel" as const, workstreamId: item.workstreamId, substreamId: null }]
        : [])),
    ).map((thread) => [thread.id as string, thread]));
    return WorkspaceChannelFeedResultSchema.parse({
      ok: true,
      page: {
        // Checked by the result schema below.
        items: page.items.flatMap((item): unknown[] => {
          const placedAt = iso(item.placedAt);
          if (item.kind === "message") {
            return [{
              kind: "message",
              placedAt,
              message: item.message,
              // Zero for a message that is not news, as a placement before migration 98.
              ...(item.attentionOrdinal > 0 ? { attentionSequenceNumber: item.attentionOrdinal } : {}),
            }];
          }
          // A row the directory no longer resolves is dropped, as on every Space page.
          const thread = threads.get(item.workstreamId);
          if (!thread) return [];
          return [{
            kind: "thread",
            placedAt,
            attentionSequenceNumber: item.attentionOrdinal,
            thread: WorkstreamSchema.parse(thread),
          }];
        }),
        nextCursor: page.nextCursor,
        latestAttentionSequenceNumber: page.latestAttentionOrdinal,
      },
    });
  }

  /** One page of the Threads tab: the threads and breakouts this person takes part in or pinned. */
  async listMyThreads(input: WorkspaceMyThreadsRequest): Promise<WorkspaceMyThreadsResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceMyThreadsRequestSchema, input, "list_my_threads");
    this.assertWorkspace(request.workspaceId);
    const viewer = await this.spaceReader(request.workspaceId, request.userId);
    if (!viewer) return { ok: false, code: "space_access_denied" };
    const page = this.spaceStorage().participatingPage(viewer, request.cursor);
    if (page === "invalid_cursor") return { ok: false, code: "space_cursor_invalid" };
    const pinnedPage = request.cursor !== null ? null
      : this.spaceStorage().participatingPage(viewer, null, { pinnedOnly: true });
    const pinned = pinnedPage === null || pinnedPage === "invalid_cursor" ? [] : pinnedPage.items;
    return WorkspaceMyThreadsResultSchema.parse({
      ok: true,
      page: {
        items: this.conversationRows(viewer, request.workspaceId, page.items),
        nextCursor: page.nextCursor,
        pinned: this.conversationRows(viewer, request.workspaceId, pinned),
      },
    });
  }

  /** One page of the Activity tab; see `workspace-activity-feed.ts`. */
  async listActivity(input: WorkspaceActivityRequest): Promise<WorkspaceActivityResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceActivityRequestSchema, input, "list_activity");
    this.assertWorkspace(request.workspaceId);
    const viewer = await this.spaceReader(request.workspaceId, request.userId);
    if (!viewer) return { ok: false, code: "space_access_denied" };
    const page = new WorkspaceActivityFeed(this.state.storage, this.spaceStorage()).page(viewer, request.cursor, request.only);
    if (page === "invalid_cursor") return { ok: false, code: "space_cursor_invalid" };
    return WorkspaceActivityResultSchema.parse({ ok: true, page });
  }

  /**
   * One Activity row a push names, as this person would see it now: unread,
   * still listed and of a pushed kind, or null. See `workspace-activity-push.ts`.
   */
  async readActivityItemForPush(input: WorkspaceActivityPushReadRequest): Promise<ActivityItem | null> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceActivityPushReadRequestSchema, input, "read_activity_item_for_push");
    this.assertWorkspace(request.workspaceId);
    const viewer = await this.spaceReader(request.workspaceId, request.userId);
    if (!viewer) return null;
    const pushes = new WorkspaceActivityPushes(
      this.state.storage,
      new WorkspaceActivityFeed(this.state.storage, this.spaceStorage()),
    );
    return WorkspaceActivityPushReadResultSchema.parse(pushes.item(viewer, request.itemId));
  }

  /** Mark the Activity tab read through a time, for this person's other windows too. */
  async markActivitySeen(input: WorkspaceActivitySeenRequest): Promise<void> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceActivitySeenRequestSchema, input, "mark_activity_seen");
    this.assertWorkspace(request.workspaceId);
    const feed = new WorkspaceActivityFeed(this.state.storage, this.spaceStorage());
    if (!feed.ready()) return;
    feed.markSeen(request.userId, request.seenThrough, Date.now());
    // The artifact pins' unread state honours the same mark.
    if (this.versionLedger) {
      try {
        this.publishArtifactPins(request.userId, request.workspaceId);
      } catch (error) {
        logWarn(this.env, "artifact_pins_publish_failed", {
          workspace_id: request.workspaceId, code: diagnosticErrorCode(error, "artifact_pins_publish_failed"),
        });
      }
    }
    // The mark is this person's alone, so only their sockets re-read Activity:
    // another window, and the menu bar, which lists the unread rows.
    try {
      await this.publishSync(["activity"], request.workspaceId,
        this.placementAffinity() ?? await workspacePlacementAffinity(this.env, request.workspaceId),
        { audienceUserIds: [request.userId] });
    } catch (error) {
      logWarn(this.env, "activity_seen_sync_failed", {
        workspace_id: request.workspaceId,
        reason: diagnosticErrorCode(error, "activity_seen_sync_failed"),
      });
    }
  }

  /** Settle the Activity rows these events cover; see `workspace-activity-feed.ts`. */
  async recordActivityEvents(input: WorkspaceActivityEventsRequest): Promise<void> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceActivityEventsRequestSchema, input, "record_activity_events");
    this.assertWorkspace(request.workspaceId);
    const feed = new WorkspaceActivityFeed(this.state.storage, this.spaceStorage());
    if (!feed.activityReadsReady()) return;
    // A waterline that is new or rose can clear rows, so this person's other
    // windows and the menu bar re-read Activity, as they do after Mark all
    // read. A read that moved nothing tells nobody: the sending window already
    // re-reads Activity itself when it holds a row the read could clear.
    if (!feed.record(request.userId, request.events, Date.now())) return;
    // A read of an artifact settles its pin's unread state as well as its row.
    if (request.events.some((event) => event.subject.kind === "artifact")) {
      this.publishArtifactPins(request.userId, request.workspaceId);
    }
    try {
      await this.publishSync(["activity"], request.workspaceId,
        this.placementAffinity() ?? await workspacePlacementAffinity(this.env, request.workspaceId),
        { audienceUserIds: [request.userId] });
    } catch (error) {
      logWarn(this.env, "activity_events_sync_failed", {
        workspace_id: request.workspaceId,
        reason: diagnosticErrorCode(error, "activity_events_sync_failed"),
      });
    }
  }

  /** This person's pins, every kind. */
  async listPins(input: WorkspaceSpaceListRequest): Promise<WorkspacePinResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceListRequestSchema, input, "list_pins");
    this.assertWorkspace(request.workspaceId);
    return WorkspacePinResultSchema.parse({ ok: true, pins: new WorkspacePinStorage(this.state.storage).list(request.userId) });
  }

  /**
   * The Channels tab's second lines on their own, read again when a thread is
   * placed or moves, so the counts follow without a whole Space snapshot.
   */
  async listChannelStats(input: WorkspaceSpaceListRequest): Promise<WorkspaceChannelStatsResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceListRequestSchema, input, "list_channel_stats");
    this.assertWorkspace(request.workspaceId);
    const viewer = await this.spaceReader(request.workspaceId, request.userId);
    if (!viewer) return { ok: false, code: "space_access_denied" };
    return WorkspaceChannelStatsResultSchema.parse({ ok: true, stats: this.channelStatsFor(viewer) });
  }

  /**
   * Acknowledge a Channel read through a placement, for this person alone.
   *
   * Answers the person's whole `ChannelStats` row for that Channel, and sends
   * their other sockets the snapshot that carries the same row, the path a pin
   * already takes, so a second window's dot clears without a new event kind.
   */
  async acknowledgeSpaceRead(input: WorkspaceSpaceReadRequest): Promise<WorkspaceSpaceReadResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceReadRequestSchema, input, "acknowledge_space_read");
    this.assertWorkspace(request.workspaceId);
    const viewer = await this.spaceReader(request.workspaceId, request.userId);
    if (!viewer) return { ok: false, code: "space_access_denied" };
    const read = this.spaceStorage().acknowledgeRead(
      viewer,
      request.spaceId,
      request.readThroughSequenceNumber,
    );
    return this.spaceReadAnswer(viewer, request.spaceId, read);
  }

  private spaceReadAnswer(viewer: Viewer, spaceId: string, read: ChannelReadState | false): WorkspaceSpaceReadResult {
    if (read === false) return { ok: false, code: "space_not_found" };
    const stats = this.channelStatsFor(viewer, spaceId)[0];
    if (!stats) return { ok: false, code: "space_not_found" };
    this.publishNavigationState(viewer.userId, { channelStats: [stats] });
    return WorkspaceSpaceReadResultSchema.parse({ ok: true, stats });
  }

  /**
   * Tell one person's other windows what a write of their own changed: the
   * pin list, or one Channel's read state. Only what changed is sent, so a
   * read or a pin never rebuilds the Space snapshot.
   */
  private publishNavigationState(
    userId: string,
    state: { pins?: Pin[]; artifactPins?: ArtifactPin[]; channelStats?: ChannelStats[] },
  ): void {
    const message = JSON.stringify(WorkspaceNavigationStateEventSchema.parse({
      type: "workspace_navigation_state",
      occurredAt: new Date().toISOString(),
      ...state,
    }));
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed || attachment.userId !== userId) continue;
      try {
        socket.send(message);
      } catch {
        // Reconnect receives the same state in the subscribe payload.
      }
    }
  }

  /**
   * Pin or unpin a thread, a Channel or a breakout.
   *
   * A pin is refused for an item this person may not list, so a pin can never
   * be how somebody learns a thread exists. An unpin is never refused: taking
   * away a pin to something you can no longer see is how you tidy it up.
   */
  async changePin(input: WorkspacePinChangeRequest): Promise<WorkspacePinResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspacePinChangeRequestSchema, input, "change_pin");
    this.assertWorkspace(request.workspaceId);
    const pins = new WorkspacePinStorage(this.state.storage);
    if (request.pinned) {
      const viewer = await this.spaceReader(request.workspaceId, request.userId);
      if (!viewer || !this.pinTargetListed(viewer, request.kind, request.itemId, request.parentId)) {
        return { ok: false, code: "pin_target_not_found" };
      }
    }
    const now = Date.now();
    const outcome = this.state.storage.transactionSync((): "changed" | "unchanged" | "limit" => {
      if (!request.pinned) return pins.unpin(request.userId, request.kind, request.itemId) ? "changed" : "unchanged";
      if (pins.count(request.userId) >= MAX_WORKSTREAM_PIN_PLACEMENTS_PER_USER) return "limit";
      return pins.pin(request.userId, request.kind, request.itemId, request.parentId, now) ? "changed" : "unchanged";
    });
    if (outcome === "limit") return { ok: false, code: "pin_limit_reached" };
    const list = pins.list(request.userId);
    if (outcome === "changed") this.publishNavigationState(request.userId, { pins: list });
    return WorkspacePinResultSchema.parse({ ok: true, pins: list });
  }

  /** Put one kind of pin in this person's order. */
  async reorderPins(input: WorkspacePinOrderRequest): Promise<WorkspacePinResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspacePinOrderRequestSchema, input, "reorder_pins");
    this.assertWorkspace(request.workspaceId);
    const pins = new WorkspacePinStorage(this.state.storage);
    const now = Date.now();
    this.state.storage.transactionSync(() => pins.reorder(request.userId, request.kind, request.ids, now));
    const list = pins.list(request.userId);
    this.publishNavigationState(request.userId, { pins: list });
    return WorkspacePinResultSchema.parse({ ok: true, pins: list });
  }

  /** This person's pinned artifacts that they can still see. */
  async listArtifactPins(input: WorkspaceSpaceListRequest): Promise<WorkspaceArtifactPinResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceListRequestSchema, input, "list_artifact_pins");
    this.assertWorkspace(request.workspaceId);
    const viewer = await this.spaceReader(request.workspaceId, request.userId);
    if (!viewer) return { ok: false, code: "space_access_denied" };
    return WorkspaceArtifactPinResultSchema.parse({ ok: true, artifactPins: this.artifactPinsFor(viewer, request.workspaceId) });
  }

  /**
   * Pin or unpin an artifact. A pin is refused unless the artifact was
   * generated in the named thread's Main and this person may open that Main,
   * so, as with the other kinds, a pin cannot tell anybody an artifact exists.
   * Only Main's links are projected here, which is why a breakout's artifact
   * cannot be pinned until it is attached to its thread. An unpin is never
   * refused.
   */
  async changeArtifactPin(input: WorkspaceArtifactPinChangeRequest): Promise<WorkspaceArtifactPinResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceArtifactPinChangeRequestSchema, input, "change_artifact_pin");
    this.assertWorkspace(request.workspaceId);
    const pins = new WorkspacePinStorage(this.state.storage);
    const viewer = await this.spaceReader(request.workspaceId, request.userId);
    if (request.pinned && (!viewer || request.threadId === null
      || !this.artifactPinTargetListed(viewer, request.itemId, request.threadId))) {
      return { ok: false, code: "pin_target_not_found" };
    }
    const now = Date.now();
    const outcome = this.state.storage.transactionSync((): "changed" | "unchanged" | "limit" => {
      if (!request.pinned) return pins.unpin(request.userId, "artifact", request.itemId) ? "changed" : "unchanged";
      if (pins.count(request.userId) >= MAX_WORKSTREAM_PIN_PLACEMENTS_PER_USER) return "limit";
      return pins.pin(request.userId, "artifact", request.itemId, request.threadId, now) ? "changed" : "unchanged";
    });
    if (outcome === "limit") return { ok: false, code: "pin_limit_reached" };
    const list = viewer ? this.artifactPinsFor(viewer, request.workspaceId) : [];
    if (outcome === "changed") {
      this.publishNavigationState(request.userId, { artifactPins: list });
      // An artifact's Activity rows are read through its pin, so an unpin
      // takes them away; this person's windows read Activity again.
      if (!request.pinned) {
        await this.publishSync(["activity"], request.workspaceId,
          this.placementAffinity() ?? await workspacePlacementAffinity(this.env, request.workspaceId),
          { audienceUserIds: [request.userId] }).catch((error: unknown) => logWarn(this.env, "artifact_unpin_sync_failed", {
          workspace_id: request.workspaceId, code: diagnosticErrorCode(error, "artifact_unpin_sync_failed"),
        }));
      }
    }
    return WorkspaceArtifactPinResultSchema.parse({ ok: true, artifactPins: list });
  }

  /** Put this person's artifact pins in their order. */
  async reorderArtifactPins(input: WorkspaceArtifactPinOrderRequest): Promise<WorkspaceArtifactPinResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceArtifactPinOrderRequestSchema, input, "reorder_artifact_pins");
    this.assertWorkspace(request.workspaceId);
    const viewer = await this.spaceReader(request.workspaceId, request.userId);
    if (!viewer) return { ok: false, code: "space_access_denied" };
    const pins = new WorkspacePinStorage(this.state.storage);
    const now = Date.now();
    this.state.storage.transactionSync(() => pins.reorder(request.userId, "artifact", request.ids, now));
    const list = this.artifactPinsFor(viewer, request.workspaceId);
    this.publishNavigationState(request.userId, { artifactPins: list });
    return WorkspaceArtifactPinResultSchema.parse({ ok: true, artifactPins: list });
  }

  /**
   * The stored artifact pins as the Artifacts list draws them. A pin whose
   * artifact is gone, unlisted, no longer linked as generated in its thread's
   * Main, or whose Main this person can no longer open is left out, not
   * deleted: it comes back if access does, and an unpin tidies it.
   */
  private artifactPinsFor(viewer: Viewer, workspaceId: string): ArtifactPin[] {
    const stored = new WorkspacePinStorage(this.state.storage).listArtifacts(viewer.userId);
    if (stored.length === 0) return [];
    const updatesReady = this.versionLedger;
    const resources = new Map(this.state.storage.sql.exec<{
      item_id: string; title: string; resource_type: string; mime_type: string | null; updated_at: string;
      current_version: number; unread: number;
    }>(
      `SELECT pin.item_id, r.title, r.resource_type, r.mime_type, r.updated_at, r.current_version,
              ${updatesReady ? `EXISTS (SELECT 1 FROM resource_versions version
                 WHERE version.resource_id = pin.item_id
                   AND ${artifactUpdateSql("version", "pin")}
                   AND version.version > COALESCE((SELECT reads.read_through FROM workspace_activity_reads reads
                     WHERE reads.user_id = pin.user_id AND reads.subject_key = ${artifactSubjectKeySql("pin.item_id")}), 0)
                   -- Mark all read covers it as it covers the Activity row.
                   AND CAST(unixepoch(version.captured_at, 'subsec') * 1000 AS INTEGER) > COALESCE((SELECT seen.seen_through
                     FROM workspace_activity_seen seen WHERE seen.user_id = pin.user_id), 0))`
                : "0"} AS unread
         FROM workspace_pins pin
         JOIN workspace_workstream_resource_links link
           ON link.workstream_id = pin.parent_id
          AND link.resource_id = pin.item_id
          AND link.relationship_type = 'generated'
         JOIN resources r ON r.id = pin.item_id AND r.workspace_id = ?
        WHERE pin.user_id = ? AND pin.item_kind = 'artifact'
          AND ${listedResourceVisibilitySql("r")}`,
      workspaceId,
      viewer.userId,
    ).toArray().map((row) => [row.item_id, row]));
    const threadIds = [...new Set(stored.map((pin) => pin.threadId))];
    const threads = new Map(this.conversationRows(viewer, workspaceId, threadIds.map((workstreamId) => ({
      kind: "channel" as const, workstreamId, substreamId: null,
    }))).map((thread) => [thread.id as string, thread]));
    return stored.flatMap((pin) => {
      const resource = resources.get(pin.itemId);
      const thread = threads.get(pin.threadId);
      if (!resource || !thread) return [];
      return [{
        id: pin.itemId,
        // Read back from the row a pin wrote after checking it named a thread.
        threadId: asWorkstreamId(pin.threadId),
        title: truncateUtf16Safe(resource.title, 300),
        resourceType: resource.resource_type,
        mimeType: resource.mime_type === null ? null : truncateUtf16Safe(resource.mime_type, 160),
        updatedAt: new Date(resource.updated_at).toISOString(),
        currentVersion: Math.max(1, Number(resource.current_version)),
        unread: Number(resource.unread) === 1,
        thread: { title: thread.title, appearance: thread.appearance ?? null, spaceIds: thread.spaceIds },
      }];
    });
  }

  /**
   * Tell the people who pinned an artifact that it has new versions: their
   * windows get the pin list with its new unread state and re-read Activity,
   * and each version is pushed through the Activity path, which decides per
   * person whether it is a row they may see and have not been sent.
   */
  private async announceArtifactUpdates(updates: readonly ResourceVersionChange[]): Promise<void> {
    const workspaceId = this.workspaceId();
    if (!workspaceId) return;
    const pins = new WorkspacePinStorage(this.state.storage);
    const subjects: ActivityPushSubject[] = [];
    const pinners = new Set<string>();
    for (const update of updates) {
      for (const pinner of pins.artifactPinners(update.resourceId)) {
        pinners.add(pinner.userId);
        subjects.push({
          kind: "artifact",
          threadId: pinner.threadId,
          substreamId: null,
          userId: pinner.userId,
          itemId: artifactActivityId(update.resourceId, update.version),
        });
      }
    }
    if (pinners.size === 0) return;
    this.publishArtifactPinsTo(pinners, workspaceId);
    try {
      await this.publishSync(["activity"], workspaceId,
        this.placementAffinity() ?? await workspacePlacementAffinity(this.env, workspaceId),
        { audienceUserIds: [...pinners] });
    } catch (error) {
      logWarn(this.env, "artifact_update_sync_failed", {
        workspace_id: workspaceId, code: diagnosticErrorCode(error, "artifact_update_sync_failed"),
      });
    }
    await this.pushActivity(workspaceId, subjects).catch((error: unknown) => logWarn(this.env, "activity_push_failed", {
      workspace_id: workspaceId, code: diagnosticErrorCode(error, "activity_push_failed"),
    }));
  }

  /**
   * Send one person's windows their artifact pins as they stand, read under
   * the relationship one of their sockets was admitted with. Nobody connected
   * is nobody to tell: the connect payload carries the list.
   */
  /** {@link publishArtifactPins} for each of several people. */
  private publishArtifactPinsTo(userIds: Iterable<string>, workspaceId: string): void {
    // One pinner's list failing to build must not cost the others theirs, or
    // anyone their push.
    for (const userId of userIds) {
      try {
        this.publishArtifactPins(userId, workspaceId);
      } catch (error) {
        logWarn(this.env, "artifact_pins_publish_failed", {
          workspace_id: workspaceId, code: diagnosticErrorCode(error, "artifact_pins_publish_failed"),
        });
      }
    }
  }

  private publishArtifactPins(userId: string, workspaceId: string): void {
    const socket = this.state.getWebSockets().map(readAttachment)
      .find((attachment) => attachment?.subscribed && attachment.userId === userId);
    if (!socket) return;
    this.publishNavigationState(userId, { artifactPins: this.artifactPinsFor(viewerOf(socket), workspaceId) });
  }

  /**
   * Tell each socket which of these resources have a new head, so a preview
   * open on one moves to it. A socket hears only the resources linked to a
   * thread whose Main its person may open, the gate an artifact pin reads
   * under (only a thread's directory projection writes those links), or
   * shared with a Channel its person reads, the gate the resource read check
   * applies to a merge's embeds (docs/authorization.md). Not on
   * the waterline and never replayed: a client that was away reads each head
   * when it next opens the conversation.
   *
   * The heads are built from bounded columns (`readResourceHeads`), so the
   * event is assembled rather than parsed again for every person.
   *
   * One visibility read per person, whatever the number of their sockets.
   */
  private publishResourceVersions(heads: readonly ResourceHead[]): void {
    if (heads.length === 0) return;
    const linkedTo = new Map<string, string[]>();
    for (const row of this.state.storage.sql.exec<{ resource_id: string; workstream_id: string }>(
      `SELECT resource_id, workstream_id FROM workspace_workstream_resource_links
        WHERE resource_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(heads.map((head) => head.resourceId)),
    )) {
      linkedTo.set(row.resource_id, [...linkedTo.get(row.resource_id) ?? [], row.workstream_id]);
    }
    const sharedWith = new Map<string, string[]>();
    for (const row of this.state.storage.sql.exec<{ resource_id: string; parent_id: string }>(
      `SELECT resource_id, parent_id FROM authorization_locations
        WHERE parent_kind = 'space' AND resource_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(heads.map((head) => head.resourceId)),
    )) {
      sharedWith.set(row.resource_id, [...sharedWith.get(row.resource_id) ?? [], row.parent_id]);
    }
    if (linkedTo.size === 0 && sharedWith.size === 0) return;
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
        const opens = (conversationId: string): boolean => {
          let open = opened.get(conversationId);
          if (open === undefined) {
            open = this.mainOpenable(viewer, conversationId);
            opened.set(conversationId, open);
          }
          return open;
        };
        const reached = new Map<string, boolean>();
        const reads = (spaceId: string): boolean => {
          let read = reached.get(spaceId);
          if (read === undefined) {
            read = this.spaceStorage().reach(viewer, spaceId) !== null;
            reached.set(spaceId, read);
          }
          return read;
        };
        const visible = heads.filter((head) => (linkedTo.get(head.resourceId) ?? []).some(opens)
          || (sharedWith.get(head.resourceId) ?? []).some(reads));
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

  private artifactPinTargetListed(viewer: Viewer, itemId: string, threadId: string): boolean {
    if (!this.mainOpenable(viewer, threadId)) return false;
    return this.state.storage.sql.exec(
      `SELECT 1 AS one FROM workspace_workstream_resource_links link
         JOIN resources r ON r.id = link.resource_id
        WHERE link.workstream_id = ? AND link.resource_id = ? AND link.relationship_type = 'generated'
          AND ${listedResourceVisibilitySql("r")}`,
      threadId,
      itemId,
    ).toArray().length === 1;
  }

  private pinTargetListed(viewer: Viewer, kind: PinKind, itemId: string, parentId: string | null): boolean {
    if (kind === "thread") return parentId === null && this.directoryVisible(viewer, itemId);
    if (kind === "channel") return parentId === null && this.spaceStorage().reach(viewer, itemId, true) !== null;
    if (parentId === null || !this.spaceStorage().breakoutsReady()) return false;
    // The conversation page's two gates: the thread is listed, then the breakout is.
    return this.state.storage.sql.exec(
      `SELECT 1 AS one FROM breakouts breakout
         JOIN channels directory ON directory.workstream_id = breakout.workstream_id
         LEFT JOIN channel_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?1
          AND viewer.authority_generation = directory.authority_generation
         LEFT JOIN breakout_viewers breakout_viewer
           ON breakout_viewer.workstream_id = breakout.workstream_id
          AND breakout_viewer.substream_id = breakout.substream_id
          AND breakout_viewer.user_id = ?1
          AND breakout_viewer.authority_generation = breakout.authority_generation
        WHERE breakout.workstream_id = ?2 AND breakout.substream_id = ?3
          AND breakout.archived_at IS NULL AND directory.archived_at IS NULL
          AND ${channelListedSql("directory", "viewer", viewer.accessClass, { breakouts: true, userId: "?1" })}
          AND ${breakoutListedSql("breakout", "breakout_viewer", viewer.accessClass)}`,
      viewer.userId,
      parentId,
      itemId,
    ).toArray().length === 1;
  }

  /** The active Spaces one Channel currently sits in. */
  async channelSpaces(input: WorkspaceChannelSpacesRequest): Promise<WorkspaceChannelSpacesResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceChannelSpacesRequestSchema, input, "channel_spaces");
    this.assertWorkspace(request.workspaceId);
    const viewer = await this.spaceReader(request.workspaceId, request.userId);
    if (!viewer) return WorkspaceChannelSpacesResultSchema.parse({ spaceIds: [] });
    return WorkspaceChannelSpacesResultSchema.parse({
      spaceIds: this.spaceStorage().channelSpaceIds(viewer, request.workstreamId),
    });
  }

  /** Resolve the stable Space coordinate for a server-minted Channel URL. */
  async canonicalChannelSpace(
    input: WorkspaceCanonicalChannelSpaceRequest,
  ): Promise<WorkspaceCanonicalChannelSpaceResult> {
    await this.initialized;
    const request = parseRpcInput(
      WorkspaceCanonicalChannelSpaceRequestSchema,
      input,
      "canonical_channel_space",
    );
    this.assertWorkspace(request.workspaceId);
    return WorkspaceCanonicalChannelSpaceResultSchema.parse({
      spaceId: this.spaceStorage().canonicalChannelSpaceId(request.workstreamId),
    });
  }

  /**
   * The content-free Channel audience projection used when the conversation is
   * archived and its product read intentionally answers 404.
   *
   * This is not a second authority: the rows are the same directory effects
   * the Channel published for sidebar and authorization reads. Active Channels
   * still go through their canonical product detail; the access coordinator
   * only accepts this observation for an archived row.
   */
  async channelAccessObservation(input: { workspaceId: string; workstreamId: string }): Promise<
    | { found: false }
    | { found: true; archived: boolean; title: string; channel: {
      readers: { scope: "workspace" } | { scope: "personal"; userIds: string[] };
      participantUserIds: string[];
    } }
  > {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema,
      workstreamId: WorkstreamIdSchema,
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.channelDirectoryObservation(request.workstreamId);
  }

  private channelDirectoryObservation(workstreamId: string):
    | { found: false }
    | { found: true; archived: boolean; title: string; channel: {
      readers: { scope: "workspace" } | { scope: "personal"; userIds: string[] };
      participantUserIds: string[];
    } } {
    const request = { workstreamId };
    const row = this.state.storage.sql.exec<{
      title: string;
      scope: "personal" | "workspace";
      archived_at: number | null;
      authority_generation: number;
    }>(
      `SELECT title, scope, archived_at, authority_generation
         FROM channels WHERE workstream_id = ?`,
      request.workstreamId,
    ).toArray()[0];
    if (!row) return { found: false };
    const participantUserIds = this.state.storage.sql.exec<{ user_id: string }>(
      `SELECT user_id FROM channel_viewers
        WHERE workstream_id = ? AND authority_generation = ? AND is_participant = 1
        ORDER BY user_id`,
      request.workstreamId,
      row.authority_generation,
    ).toArray().map((participant) => participant.user_id);
    return {
      found: true,
      archived: row.archived_at !== null,
      title: row.title,
      channel: {
        readers: row.scope === "workspace"
          ? { scope: "workspace" }
          : { scope: "personal", userIds: participantUserIds },
        participantUserIds,
      },
    };
  }

  /** Record presentation the Space's own authority accepted. */
  async noteSpacePresentation(input: WorkspaceSpacePresentationRequest): Promise<WorkspaceSpaceMutationResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpacePresentationRequestSchema, input, "note_space_presentation");
    this.assertWorkspace(request.workspaceId);
    const refusal = await this.spaceRefusalCode(request.workspaceId, request.userId, "write", request.spaceId);
    if (refusal) return { ok: false, code: refusal, unreachableUserIds: [], blockedWorkstreamIds: [] };
    const space = this.spaceStorage().applyPresentation(request);
    if (space === "stale") return { ok: false, code: "space_revision_conflict", unreachableUserIds: [], blockedWorkstreamIds: [] };
    if (space !== false) {
      this.publishSpaceSnapshot();
      // A new colour marks the Channel's threads (channel-color-sync.ts).
      await this.armNextAlarm();
    }
    return WorkspaceSpaceMutationResultSchema.parse(space === false
      ? { ok: false, code: "space_not_found" }
      : { ok: true, space });
  }

  /**
   * Record a Space's scope and participants. A Space grants no reader to its
   * Channels, so this is the whole change: no intent, no walk. The actor may
   * leave a private Space this way, and is answered `left`.
   */
  async noteSpaceAudience(input: WorkspaceSpaceAudienceNoteRequest): Promise<WorkspaceSpaceAudienceResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceAudienceNoteRequestSchema, input, "note_space_audience");
    this.assertWorkspace(request.workspaceId);
    const refusal = await this.spaceRefusalCode(request.workspaceId, request.userId, "write", request.spaceId);
    if (refusal) return { ok: false, code: refusal, unreachableUserIds: [], blockedWorkstreamIds: [] };
    // General is every thread's fallback home, so it stays Organization-wide:
    // a private General would hide every unplaced thread's Channel. A
    // Personal Channel's audience is its owner, always.
    const storage = this.spaceStorage();
    if ((request.audience.scope === "personal" && storage.generalSpaceId() === request.spaceId)
      || storage.isPersonalSpace(request.spaceId)) {
      return { ok: false, code: "space_protected", unreachableUserIds: [], blockedWorkstreamIds: [] };
    }
    const activeMembers = await Promise.all(request.audience.participantUserIds.map((userId) => (
      this.activeSpaceMember(request.workspaceId, userId)
    )));
    if (activeMembers.some((active) => !active)) {
      return { ok: false, code: "space_access_denied", unreachableUserIds: [], blockedWorkstreamIds: [] };
    }
    const space = this.spaceStorage().applyAudience(request);
    if (space === false) return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
    this.publishSpaceSnapshot();
    // A new scope can change which Channel decides a thread's colour.
    await this.armNextAlarm();
    return WorkspaceSpaceAudienceResultSchema.parse(space === "left" ? { ok: true, left: true } : { ok: true, space });
  }

  /**
   * The addresses a Space lists for people invited to the Organization, to
   * whoever may edit it. Not on the Space summary, which shipped clients parse
   * strictly.
   */
  async listSpaceInvitees(input: WorkspaceSpaceInviteesRequest): Promise<{ ok: true; emails: string[] } | { ok: false; code: SpaceErrorCode }> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceInviteesRequestSchema, input, "list_space_invitees");
    this.assertWorkspace(request.workspaceId);
    const refusal = await this.spaceRefusalCode(request.workspaceId, request.userId, "write", request.spaceId);
    if (refusal) return { ok: false, code: refusal };
    return { ok: true, emails: this.spaceStorage().invitees(request.spaceId) };
  }

  /**
   * Seat someone who just accepted an Organization invitation in every Space
   * that listed the address it was sent to. Server-to-server, from the
   * acceptance, so the membership is read from D1 rather than this object's
   * copy: the copy may still say guest, or nothing, until the relationship
   * delivery lands.
   */
  async seatSpaceInvitee(input: WorkspaceSpaceSeatInviteeRequest): Promise<{ seatedSpaceIds: string[] }> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceSeatInviteeRequestSchema, input, "seat_space_invitee");
    this.assertWorkspace(request.workspaceId);
    const relationship = await readWorkspaceRelationship(this.env.DB, request.workspaceId, request.userId);
    if (relationship?.status !== "active" || relationship.accessClass !== "member") return { seatedSpaceIds: [] };
    const storage = this.spaceStorage();
    if (!storage.ready()) return { seatedSpaceIds: [] };
    const seatedSpaceIds = storage.seatInvitees(request.userId, request.email);
    if (seatedSpaceIds.length > 0) this.publishSpaceSnapshot();
    return { seatedSpaceIds };
  }

  /**
   * Record one step of a staged Space operation against its intent.
   *
   * Server-to-server, like the default-target settlement RPCs beside it, and
   * deliberately without the membership recheck every *product* Space RPC
   * carries. The operations this settles are re-run by the activity consumer
   * long after the request that staged them is gone, and the person who started
   * one may by then have left the Organization — refusing the receipt there
   * would leave the intent pending forever and the alarm republishing it
   * forever. It grants nothing and reads nothing: the operation id is the whole
   * address, and every step it settles was already authorized when it was
   * staged.
   */
  async recordSpaceIntentReceipt(input: WorkspaceSpaceIntentReceiptRequest): Promise<{ recorded: boolean }> {
    await this.initialized;
    const request = parseRpcInput(
      WorkspaceSpaceIntentReceiptRequestSchema, input, "record_space_intent_receipt",
    );
    this.assertWorkspace(request.workspaceId);
    this.spaceStorage().settleIntent(
      request.operationId, request.receipt, request.settled, Date.now(), request.cursor,
    );
    await this.armNextAlarm();
    return { recorded: true };
  }

  /**
   * Record why a resume did not finish; server-to-server, like the receipt.
   *
   * Same reasoning as `recordSpaceIntentReceipt`: the consumer runs long after
   * the request that staged the intent is gone, so there is no membership to
   * recheck, and refusing this would only cost the reason.
   */
  async recordSpaceIntentFailure(input: WorkspaceSpaceIntentFailureRequest): Promise<{ recorded: boolean }> {
    await this.initialized;
    const request = parseRpcInput(
      WorkspaceSpaceIntentFailureRequestSchema, input, "record_space_intent_failure",
    );
    this.assertWorkspace(request.workspaceId);
    this.spaceStorage().recordIntentFailure(request.operationId, request.errorCode);
    return { recorded: true };
  }


  /**
   * Refresh every open Sidekick rail after a Space wrote Sidekick defaults
   * onto member Channels in its own transaction, as the Queue path's
   * `setSidekickRecommendation` does. The write has committed, so a failed
   * refresh is logged rather than failing the request that made it.
   */
  private async afterSidekickDefaultsApplied(storage: WorkspaceSpaceStorage, workspaceId: string): Promise<void> {
    if (storage.sidekickDefaultsApplied === 0) return;
    try {
      await this.publishSync(["automations"], workspaceId,
        this.placementAffinity() ?? await workspacePlacementAffinity(this.env, workspaceId));
    } catch (error) {
      logWarn(this.env, "space_sidekick_default_refresh_failed", {
        workspace_id: workspaceId,
        reason: diagnosticErrorCode(error, "space_sidekick_default_refresh_failed"),
      });
    }
  }

  /**
   * A new Channel's Organization-side birth: its Space memberships, the
   * defaults those Spaces hand a new member, and its parent row with the
   * provisional directory row, in one transaction. A Space adds no reader:
   * the Channel starts with its creator and whoever the creator named.
   *
   * Every row a creation needs from this object is in this database, so there
   * is no staged membership, intent or cancellation; adding a Channel that
   * already exists is `addSpaceChannel`.
   *
   * Idempotent for a retry of the same create: an active membership keeps its
   * generation and the reservation finds its child registered.
   */
  async reserveChannelInSpaces(input: WorkspaceChannelReservationRequest): Promise<WorkspaceChannelReservationResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceChannelReservationRequestSchema, input, "reserve_channel_in_spaces");
    this.assertWorkspace(request.workspaceId);
    const refused = (code: SpaceErrorCode, spaceId: string | null): WorkspaceChannelReservationResult =>
      WorkspaceChannelReservationResultSchema.parse({ status: "refused", code, spaceId });
    const refusal = await this.spaceRefusalCode(request.workspaceId, request.userId, "write");
    if (refusal) return refused(refusal, null);
    const storage = this.spaceStorage();
    const generalSpaceId = request.spaceIds.length > 0 ? null : storage.generalSpaceId();
    if (request.spaceIds.length === 0 && generalSpaceId === null) return { status: "general_missing" };
    const spaceIds = request.spaceIds.length > 0 ? [...new Set<string>(request.spaceIds)] : [generalSpaceId ?? ""];
    // The same per-Space gate every Space write takes: reaching a Space only
    // through a Channel in it is not enough to put another Channel there.
    const throughChannel = spaceIds.find((spaceId) => storage.reach(member(request.userId), spaceId) === "through_channel");
    if (throughChannel) return refused("space_access_denied", throughChannel);
    const parent = await this.hostedParent(request.workstreamId, request.workspaceId);
    const workstreamId = request.workstreamId;
    const followUpMark = this.pendingParentFollowUps.length;
    let reserved: { authorityGeneration: number; spaces: SpaceSummary[]; color: SpaceColorKey | null };
    try {
      reserved = await this.withMembersLearned(() => this.state.storage.transactionSync(() => {
        const placed: { space: SpaceSummary; membershipGeneration: number }[] = [];
        for (const spaceId of spaceIds) {
          const entered = storage.enterMembershipAtBirth({
            workspaceId: request.workspaceId, userId: request.userId, spaceId: asSpaceId(spaceId), workstreamId,
          });
          if (!entered.ok) throw new ChannelReservationRefused("space_not_found", spaceId);
          storage.stageDefaultsForMember(spaceId, workstreamId, entered.membershipGeneration, request.userId);
          placed.push(entered);
        }
        const spaces = placed.map((entry) => entry.space);
        const start = resolveSpaceWorkstreamStart({
          spaces, scope: request.requestedScope, requestedParticipantUserIds: request.requestedParticipantUserIds,
          narrowInPrivateSpaces: request.narrowInPrivateSpaces === true,
        });
        // The colour the sync lane would write, read now so the thread is
        // born in it. The lane still runs for this thread (its first
        // projection marks it) and writes nothing when the colour matches.
        const color = storage.channelColor(workstreamId);
        const child = parent.reserveChild({
          workspaceId: request.workspaceId,
          parentId: workstreamId,
          substreamId: asSubstreamId("0"),
          kind: "main",
          createdByUserId: request.createdByUserId === undefined ? request.userId : request.createdByUserId,
          authorityGeneration: request.authorityGeneration,
          directory: {
            ...request.directory,
            scope: start.scope,
            systemKind: null,
            ...(color ? { appearance: { icon: null, color } } : {}),
          },
        });
        if (request.reclaimUnopened) {
          armImportReservationReclaim(this.state.storage.sql, { parentId: workstreamId, userId: request.userId, now: Date.now() });
        }
        if (request.externalBinding) {
          const claimed = this.externalBindings().claim(request.externalBinding, {
            kind: "conversation", parentKind: "workstream", parentId: workstreamId, substreamId: "0",
          }, new Date().toISOString());
          if (claimed.outcome !== "claimed") throw new ChannelBindingRefused(claimed.outcome);
        }
        return { authorityGeneration: child.authorityGeneration, spaces, color };
      }));
    } catch (error) {
      // The directory follow-ups the reservation recorded were rolled back
      // with it; forget their ids so nothing runs a row that never committed.
      this.pendingParentFollowUps.splice(followUpMark);
      if (error instanceof ChannelReservationRefused) return refused(error.code, error.spaceId);
      if (error instanceof ChannelBindingRefused) return { status: "binding_refused", outcome: error.outcome };
      throw error;
    }
    // After the commit, what the staged calls did after theirs: the Space
    // snapshot, the dashboards the Channel entered, the directory follow-ups,
    // and the alarm that delivers the staged defaults.
    this.publishSpaceSnapshot();
    this.publishSpaceConversationsChanged({ spaceIdsThroughChannel: new Map([[workstreamId, spaceIds]]) });
    await this.afterParentWrite();
    this.deferSpaceMembershipConvergence(request.workspaceId, workstreamId, false);
    return WorkspaceChannelReservationResultSchema.parse({ status: "reserved", ...reserved });
  }

  /**
   * Move a Channel between two Spaces in one transaction of this object. A
   * Space grants no reader, so nothing outside it takes part. `moved: false`
   * only for a target already staged `joining` before migration 94, which the
   * caller finishes as an add then a removal.
   */
  async moveSpaceMembership(
    input: WorkspaceSpaceMembershipMoveRequest,
  ): Promise<WorkspaceSpaceMembershipMoveOutcome> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceMembershipMoveRequestSchema, input, "move_space_membership");
    this.assertWorkspace(request.workspaceId);
    const refusal = await this.spaceMoveRefusal(request);
    if (refusal) return { ok: false, code: refusal, unreachableUserIds: [], blockedWorkstreamIds: [] };
    const result = WorkspaceSpaceMembershipMoveOutcomeSchema.parse(await this.withMembersLearned(() => (
      this.spaceStorage().moveMembership(request)
    )));
    if (result.ok && result.moved) {
      this.publishSpaceSnapshot();
      this.publishSpaceConversationsChanged({
        spaceIdsThroughChannel: new Map([[
          request.workstreamId,
          [request.sourceSpaceId, request.targetSpaceId],
        ]]),
      });
      this.deferSpaceMembershipConvergence(request.workspaceId, request.workstreamId, true);
    }
    return result;
  }

  /** Who may move a Channel between two Spaces; null to proceed. */
  private async spaceMoveRefusal(request: WorkspaceSpaceMembershipMoveRequest): Promise<SpaceErrorCode | null> {
    if (!await this.activeSpaceMember(request.workspaceId, request.userId)) return "space_access_denied";
    const storage = this.spaceStorage();
    if (!storage.ready()) return "space_bootstrap_pending";
    if (storage.reach(member(request.userId), request.sourceSpaceId) === "through_channel"
      || storage.reach(member(request.userId), request.targetSpaceId) === "through_channel") {
      return "space_access_denied";
    }
    if (!this.directoryVisible(member(request.userId), request.workstreamId)) return "space_not_found";
    return null;
  }

  /** Put an existing Channel in a Space: one transaction of this object. */
  async addSpaceChannel(input: WorkspaceSpaceChannelChangeRequest): Promise<WorkspaceSpaceChannelChangeResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceChannelChangeRequestSchema, input, "add_space_channel");
    this.assertWorkspace(request.auth.workspaceId);
    const refusal = await this.spaceRefusalCode(
      request.auth.workspaceId, request.auth.userId, "write", request.spaceId,
    );
    if (refusal) return this.spaceChannelRefusal(refusal);
    if (!this.directoryVisible(member(request.auth.userId), request.workstreamId)) {
      return {
        ok: false,
        refusal: { about: "conversation", status: 404, code: "workstream_not_found", message: "Thread not found" },
      };
    }
    return this.addChannelToSpace(request.auth.workspaceId, request.auth.userId, request.spaceId, request.workstreamId);
  }

  /**
   * The Breakout's and its Thread's titles for a merge. The caller has
   * already authorized the person on both; this reads the projection only.
   */
  async breakoutMergeTitles(input: {
    workspaceId: string;
    workstreamId: string;
    substreamId: string;
  }): Promise<{ breakout: string; thread: string }> {
    await this.initialized;
    const request = parseRpcInput(z.strictObject({
      workspaceId: WorkspaceIdSchema,
      workstreamId: WorkstreamIdSchema,
      substreamId: SubstreamIdSchema,
    }), input, "breakout_merge_titles");
    this.assertWorkspace(request.workspaceId);
    return this.spaceStorage().breakoutMergeTitles(request.workstreamId, request.substreamId);
  }

  /**
   * Where this thread's merge would go for this person, and the Channels they
   * could pick instead; see `WorkspaceSpaceStorage.channelMergeTarget`. The
   * merge service asks it before attaching anything.
   */
  async channelMergeTarget(input: WorkspaceChannelMergeTargetRequest): Promise<WorkspaceChannelMergeTargetResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceChannelMergeTargetRequestSchema, input, "channel_merge_target");
    this.assertWorkspace(request.auth.workspaceId);
    if (!await this.activeSpaceMember(request.auth.workspaceId, request.auth.userId)) {
      return { ok: false, code: "space_access_denied", channels: [] };
    }
    return WorkspaceChannelMergeTargetResultSchema.parse(
      this.spaceStorage().channelMergeTarget(member(request.auth.userId), request.workstreamId, request.spaceId),
    );
  }

  /**
   * Where a thread's merge would land with nobody asking: its earliest active
   * placement, the Channel `channelMergeTarget` picks for a person who can
   * post there. The turn-disposition observer reads it from a thread's object
   * to name the parent for the classifier and on the suggestion it writes; the
   * merge itself still asks `channelMergeTarget` for the person who merges.
   */
  async threadMergePlacement(input: WorkspaceThreadMergePlacementRequest): Promise<WorkspaceThreadMergePlacementResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceThreadMergePlacementRequestSchema, input, "thread_merge_placement");
    this.assertWorkspace(request.workspaceId);
    return WorkspaceThreadMergePlacementResultSchema.parse(this.spaceStorage().threadMergePlacement(request.workstreamId));
  }

  /**
   * Merge a thread into one of its Channels (docs/conversation-merge.md): one
   * Channel message keyed by the thread, at the bottom of the feed, and news
   * on the Channel's waterline. A replay of the same operation writes nothing
   * and publishes nothing.
   */
  async mergeThreadIntoChannel(input: WorkspaceChannelMergeRequest): Promise<WorkspaceChannelMergeResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceChannelMergeRequestSchema, input, "merge_thread_into_channel");
    this.assertWorkspace(request.auth.workspaceId);
    if (!await this.activeSpaceMember(request.auth.workspaceId, request.auth.userId)) {
      return { ok: false, code: "space_access_denied", channels: [] };
    }
    const now = Date.now();
    const result = this.spaceStorage().mergeThreadIntoChannel(member(request.auth.userId), {
      workstreamId: request.workstreamId,
      spaceId: request.spaceId,
      body: request.body,
      embeds: request.embeds,
      operationId: request.operationId,
    }, now);
    if (result.ok && !result.replayed) {
      this.publishChannelRowToReaders(request.workstreamId);
      this.publishSpaceConversationsChanged({ spaceIds: [result.spaceId] });
      // The merge queued its search projection; publish it now rather than at the next wake.
      await this.armNextAlarm();
      // Best effort, as every Activity push is: the row is in Activity either way.
      await this.pushActivity(request.auth.workspaceId, [{
        threadId: request.workstreamId, substreamId: null, kind: "merge", itemId: `merged:${result.messageId}:${now}`,
        channelId: result.spaceId,
      }]).catch((error: unknown) => logWarn(this.env, "activity_push_failed", {
        workspace_id: request.auth.workspaceId, code: diagnosticErrorCode(error, "activity_push_failed"),
      }));
    }
    return WorkspaceChannelMergeResultSchema.parse(result);
  }

  /**
   * Delete one Channel message: its author's, or any for an Organization
   * owner or admin. A Channel merge's **Remove**; the attachments it made stay.
   */
  async removeChannelMessage(input: WorkspaceChannelMessageRemoveRequest): Promise<WorkspaceChannelMessageRemoveResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceChannelMessageRemoveRequestSchema, input, "remove_channel_message");
    this.assertWorkspace(request.auth.workspaceId);
    if (!await this.activeSpaceMember(request.auth.workspaceId, request.auth.userId)) {
      return { ok: false, code: "space_access_denied" };
    }
    const storage = this.spaceStorage();
    if (storage.reach(member(request.auth.userId), request.spaceId) === null) return { ok: false, code: "space_not_found" };
    const admin = request.auth.role === "owner" || request.auth.role === "admin";
    const removed = storage.removeMessage(request.spaceId, request.messageId, ({ author }) =>
      admin || (author.kind === "member" && author.userId === request.auth.userId));
    if (removed === "not_found") return { ok: false, code: "channel_message_not_found" };
    if (removed === "forbidden") return { ok: false, code: "space_access_denied" };
    this.publishSpaceConversationsChanged({ spaceIds: [request.spaceId] });
    // The removal queued its deletion watermark.
    await this.armNextAlarm();
    return { ok: true };
  }

  /** Take a Channel out of a Space that is not its last: one transaction. */
  async removeSpaceChannel(input: WorkspaceSpaceChannelChangeRequest): Promise<WorkspaceSpaceChannelChangeResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceChannelChangeRequestSchema, input, "remove_space_channel");
    this.assertWorkspace(request.auth.workspaceId);
    const refusal = await this.spaceRefusalCode(
      request.auth.workspaceId, request.auth.userId, "write", request.spaceId,
    );
    if (refusal) return this.spaceChannelRefusal(refusal);
    const storage = this.spaceStorage();
    const result = storage.removeMembership({
      workspaceId: request.auth.workspaceId, userId: request.auth.userId,
      spaceId: request.spaceId, workstreamId: request.workstreamId,
    });
    if (!result.ok) return this.spaceMutationRefusal(result);
    this.publishSpaceSnapshot();
    // The Space is named alongside the Channel: the membership is `removed`
    // by now, so the Channel no longer resolves to the Space it just left.
    this.publishSpaceConversationsChanged({
      spaceIdsThroughChannel: new Map([[request.workstreamId, [request.spaceId]]]),
    });
    this.deferSpaceMembershipConvergence(request.auth.workspaceId, request.workstreamId, true);
    return { ok: true, space: result.space };
  }

  /**
   * Place one Channel in General for the cutover, as one of the people who
   * may act on it: `addSpaceChannel` without the sidebar-visibility gate, so
   * it can place an archived Channel, which the cutover has to home too.
   */
  async placeChannelInGeneral(input: WorkspaceGeneralPlacementRequest): Promise<WorkspaceSpaceChannelChangeResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceGeneralPlacementRequestSchema, input, "place_channel_in_general");
    this.assertWorkspace(request.auth.workspaceId);
    const generalSpaceId = this.spaceStorage().generalSpaceId();
    if (generalSpaceId === null) return this.spaceChannelRefusal("space_bootstrap_pending");
    const refusal = await this.spaceRefusalCode(request.auth.workspaceId, request.auth.userId, "write", generalSpaceId);
    if (refusal) return this.spaceChannelRefusal(refusal);
    return this.addChannelToSpace(
      request.auth.workspaceId, request.auth.userId, asSpaceId(generalSpaceId), request.workstreamId,
    );
  }

  /** The membership write an add or a placement shares, and what it publishes. */
  private async addChannelToSpace(
    workspaceId: string,
    userId: string,
    spaceId: SpaceId,
    workstreamId: WorkstreamId,
  ): Promise<WorkspaceSpaceChannelChangeResult> {
    const storage = this.spaceStorage();
    const result = await this.withMembersLearned(() => storage.addMembership({
      workspaceId: asWorkspaceId(workspaceId), userId: asUserId(userId), spaceId, workstreamId,
    }));
    if (!result.ok) return this.spaceMutationRefusal(result);
    this.publishSpaceSnapshot();
    // Through the Channel: the people whose Space dashboard changed are the
    // people who can list it.
    this.publishSpaceConversationsChanged({ spaceIdsThroughChannel: new Map([[workstreamId, [spaceId]]]) });
    this.deferSpaceMembershipConvergence(workspaceId, workstreamId, false);
    await this.afterSidekickDefaultsApplied(storage, workspaceId);
    return { ok: true, space: result.space };
  }

  private spaceMutationRefusal(
    result: Extract<WorkspaceSpaceMutationResult, { ok: false }>,
  ): { ok: false; refusal: SpaceChannelRefusal } {
    return {
      ok: false,
      refusal: {
        about: "space", code: result.code, subject: "",
        unreachableUserIds: [...result.unreachableUserIds], blockedWorkstreamIds: [...result.blockedWorkstreamIds],
      },
    };
  }

  /**
   * Finish one intent staged before migration 94, for a `space_intent_resume`
   * message already on the Queue. Nothing stages new ones; the alarm finishes
   * the rest in place.
   */
  async resumeSpaceIntent(input: WorkspaceSpaceIntentResumeRequest): Promise<WorkspaceSpaceIntentResumeResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceIntentResumeRequestSchema, input, "resume_space_intent");
    this.assertWorkspace(request.auth.workspaceId);
    const intent = this.spaceStorage().unsettledIntent(request.operationId);
    // Settled or cancelled already, by the alarm or an earlier delivery.
    if (intent) await this.finishLegacyIntent(request.auth.workspaceId, intent);
    return { ok: true, outcome: "settled" };
  }

  /** Finish each staged intent the alarm claimed. */
  private async resumeSpaceIntentsInPlace(workspaceId: string, intents: readonly WorkspaceSpaceIntentClaim[]): Promise<void> {
    for (const intent of intents) {
      try {
        await this.finishLegacyIntent(workspaceId, intent);
      } catch (error) {
        const reason = diagnosticErrorCode(error, "space_intent_resume_failed");
        this.spaceStorage().recordIntentFailure(intent.operationId, reason);
        logWarn(this.env, "space_intent_resume_failed", {
          workspace_id: workspaceId, space_id: intent.spaceId, operation_id: intent.operationId,
          kind: intent.kind, reason,
        });
      }
    }
    await this.armNextAlarm();
  }

  /**
   * One intent staged before every Space was Organization-wide, finished in a
   * single transaction (`resumeLegacyIntent`), then published. A Space grants
   * no reader, so no Channel is asked.
   *
   * The intent runs as its requester, so somebody who has left the
   * Organization has nothing run as them: the row keeps
   * `space_intent_requester_inactive`, as the Queue consumer writes it.
   */
  private async finishLegacyIntent(workspaceId: string, intent: WorkspaceSpaceIntentClaim): Promise<void> {
    const storage = this.spaceStorage();
    if (!this.knownActiveMember(intent.requestedByUserId)) {
      storage.recordIntentFailure(intent.operationId, "space_intent_requester_inactive");
      logWarn(this.env, "space_intent_resume_failed", {
        workspace_id: workspaceId, space_id: intent.spaceId, operation_id: intent.operationId,
        kind: intent.kind, reason: "space_intent_requester_inactive",
      });
      return;
    }
    const finished = storage.resumeLegacyIntent(intent);
    this.publishSpaceSnapshot();
    if (finished.spaceChanged) this.publishSpaceConversationsChanged({ spaceIds: finished.spaceIds });
    if (finished.membershipChanged && finished.workstreamId) {
      this.publishSpaceConversationsChanged({
        spaceIdsThroughChannel: new Map([[finished.workstreamId, finished.spaceIds]]),
      });
      this.deferSpaceMembershipConvergence(workspaceId, finished.workstreamId, true);
      await this.afterSidekickDefaultsApplied(storage, workspaceId);
    }
  }

  private spaceChannelRefusal(code: SpaceErrorCode): { ok: false; refusal: SpaceChannelRefusal } {
    return { ok: false, refusal: { about: "space", code, subject: "", unreachableUserIds: [], blockedWorkstreamIds: [] } };
  }

  /** Archive a Space that strands no live Channel: one transaction. */
  async archiveSpace(input: WorkspaceSpaceRequest): Promise<WorkspaceSpaceMutationResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceRequestSchema, input, "archive_space");
    this.assertWorkspace(request.workspaceId);
    const refusal = await this.spaceRefusalCode(request.workspaceId, request.userId, "write", request.spaceId);
    if (refusal) return { ok: false, code: refusal, unreachableUserIds: [], blockedWorkstreamIds: [] };
    const storage = this.spaceStorage();
    const archived = storage.archive(request.workspaceId, request.userId, request.spaceId);
    const result = WorkspaceSpaceMutationResultSchema.parse(archived.result);
    if (!result.ok) return result;
    this.publishSpaceSnapshot();
    if (archived.rehomed.length > 0) {
      const general = asSpaceId(storage.generalSpaceId()!);
      this.publishSpaceConversationsChanged({
        spaceIdsThroughChannel: new Map(archived.rehomed.map((workstreamId) => [asWorkstreamId(workstreamId), [general]])),
      });
      for (const workstreamId of archived.rehomed) {
        this.deferSpaceMembershipConvergence(request.workspaceId, asWorkstreamId(workstreamId), false);
      }
      await this.afterSidekickDefaultsApplied(storage, request.workspaceId);
    }
    // An archive takes every member Channel off this Space's dashboard and a
    // restore puts them back. `spaceIds`, which names the Space to everybody
    // who reaches it, is right here: the Space's own disappearance and return
    // are visible to all of them anyway.
    this.publishSpaceConversationsChanged({ spaceIds: [request.spaceId] });
    await this.armNextAlarm();
    return result;
  }

  /** Bring an archived Space back with the memberships the archive took out: one transaction. */
  async restoreSpace(input: WorkspaceSpaceRequest): Promise<WorkspaceSpaceMutationResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceRequestSchema, input, "restore_space");
    this.assertWorkspace(request.workspaceId);
    const refusal = await this.spaceRefusalCode(request.workspaceId, request.userId, "write", request.spaceId);
    if (refusal) return { ok: false, code: refusal, unreachableUserIds: [], blockedWorkstreamIds: [] };
    const space = this.spaceStorage().restore(request.workspaceId, request.userId, request.spaceId);
    if (space === false) {
      return { ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [] };
    }
    this.publishSpaceSnapshot();
    this.publishSpaceConversationsChanged({ spaceIds: [request.spaceId] });
    // Its threads were marked for their colour as their placements came back.
    await this.armNextAlarm();
    return WorkspaceSpaceMutationResultSchema.parse({ ok: true, space });
  }

  async addSpaceDefault(input: WorkspaceSpaceDefaultRequest): Promise<WorkspaceSpaceDefaultResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceDefaultRequestSchema, input, "add_space_default");
    this.assertWorkspace(request.workspaceId);
    const refusal = await this.spaceRefusalCode(request.workspaceId, request.userId, "write", request.spaceId);
    if (refusal) return { ok: false, code: refusal, unreachableUserIds: [], blockedWorkstreamIds: [] };
    if (request.kind === "sidekick") this.assertRecommendableSidekick(request.targetId);
    const storage = this.spaceStorage();
    // A Sidekick default is also the Space's recommendation, which a Channel
    // created in the Space reads from its hosted parent. Written right after
    // the default with nothing awaited between them, so both land or neither.
    const parent = request.kind === "sidekick" ? await this.hostedParent(request.spaceId, request.workspaceId) : null;
    const result = WorkspaceSpaceDefaultResultSchema.parse(storage.addDefault(request));
    if (result.ok) parent?.writeSidekickRecommendation(request.targetId, true);
    if (result.ok) this.publishSpaceSnapshot();
    if (result.ok && result.targets.length > 0) await this.armNextAlarm();
    await this.afterSidekickDefaultsApplied(storage, request.workspaceId);
    return result;
  }

  async removeSpaceDefault(input: WorkspaceSpaceDefaultRequest): Promise<WorkspaceSpaceMutationResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceSpaceDefaultRequestSchema, input, "remove_space_default");
    this.assertWorkspace(request.workspaceId);
    const refusal = await this.spaceRefusalCode(request.workspaceId, request.userId, "write", request.spaceId);
    if (refusal) return { ok: false, code: refusal, unreachableUserIds: [], blockedWorkstreamIds: [] };
    const parent = request.kind === "sidekick" ? await this.hostedParent(request.spaceId, request.workspaceId) : null;
    const space = this.spaceStorage().removeDefault(request);
    if (space !== false) parent?.writeSidekickRecommendation(request.targetId, false);
    if (space !== false) this.publishSpaceSnapshot();
    return WorkspaceSpaceMutationResultSchema.parse(space === false
      ? { ok: false, code: "space_not_found" }
      : { ok: true, space });
  }

  async spaceDefaultTargetCurrent(input: SpaceDefaultQueueMessage): Promise<boolean> {
    await this.initialized;
    const request = parseRpcInput(SpaceDefaultQueueMessageSchema, input, "space_default_target_current");
    this.assertWorkspace(request.workspaceId);
    return this.spaceStorage().defaultTargetCurrent(request);
  }

  async completeSpaceDefaultTarget(input: SpaceDefaultQueueMessage): Promise<boolean> {
    await this.initialized;
    const request = parseRpcInput(SpaceDefaultQueueMessageSchema, input, "complete_space_default_target");
    this.assertWorkspace(request.workspaceId);
    const completed = this.spaceStorage().completeDefaultTarget(request);
    if (completed) this.publishSpaceSnapshot();
    return completed;
  }

  async recordSpaceDefaultTargetFailure(input: SpaceDefaultTargetFailureRequest): Promise<boolean> {
    await this.initialized;
    const request = parseRpcInput(
      SpaceDefaultTargetFailureRequestSchema, input, "record_space_default_target_failure",
    );
    this.assertWorkspace(request.workspaceId);
    return this.spaceStorage().recordDefaultTargetFailure(request, request.errorCode);
  }

  /**
   * The colour one marked thread should carry and the conversations to write
   * it into, or `null` (settling the row) when there is nothing to write.
   * Server-to-server, like the default-target RPCs: there is no person on it.
   */
  async channelColorWork(input: ChannelColorSyncMessage): Promise<ChannelColorWork> {
    await this.initialized;
    const request = parseRpcInput(ChannelColorSyncMessageSchema, input, "channel_color_work");
    this.assertWorkspace(request.workspaceId);
    const work = ChannelColorWorkSchema.parse(this.state.storage.transactionSync(() => channelColorWork(this.state.storage.sql, {
      workstreamId: request.workstreamId,
      revision: request.revision,
      color: this.spaceStorage().channelColor(request.workstreamId),
    })));
    // A settled row may be the last of its batch, which lets the next one go.
    if (work === null) await this.armNextAlarm();
    return work;
  }

  /** Settle a thread every conversation of which now carries its colour. */
  async completeChannelColorSync(input: ChannelColorSyncMessage): Promise<boolean> {
    await this.initialized;
    const request = parseRpcInput(ChannelColorSyncMessageSchema, input, "complete_channel_color_sync");
    this.assertWorkspace(request.workspaceId);
    const completed = completeChannelColorSync(this.state.storage.sql, request.workstreamId, request.revision);
    await this.armNextAlarm();
    return completed;
  }

  /** A thread the consumer could not finish: it retries at its own gate and holds back nothing. */
  async releaseChannelColorSync(input: ChannelColorSyncMessage): Promise<boolean> {
    await this.initialized;
    const request = parseRpcInput(ChannelColorSyncMessageSchema, input, "release_channel_color_sync");
    this.assertWorkspace(request.workspaceId);
    const released = releaseChannelColorSync(this.state.storage.sql, request.workstreamId, request.revision);
    await this.armNextAlarm();
    return released;
  }

  /**
   * The conversations one listed thread's job runs over, or `null` (settling
   * the row) when there is nothing to do. Server-to-server, like the
   * channel-colour RPCs above.
   */
  async threadBackfillWork(input: ThreadBackfillMessage): Promise<ThreadBackfillWork> {
    await this.initialized;
    const request = parseRpcInput(ThreadBackfillMessageSchema, input, "thread_backfill_work");
    this.assertWorkspace(request.workspaceId);
    const work = this.state.storage.transactionSync(() => threadBackfillWork(
      this.state.storage.sql, { job: request.job, workstreamId: request.workstreamId },
    ));
    // A settled row may be the last of its batch, which lets the next one go.
    if (work === null) await this.armNextAlarm();
    return work;
  }

  /** Settle a thread whose job has run over every conversation. */
  async completeThreadBackfill(input: ThreadBackfillMessage): Promise<boolean> {
    await this.initialized;
    const request = parseRpcInput(ThreadBackfillMessageSchema, input, "complete_thread_backfill");
    this.assertWorkspace(request.workspaceId);
    const completed = completeThreadBackfill(this.state.storage.sql, request.job, request.workstreamId);
    await this.armNextAlarm();
    return completed;
  }

  /** A thread the consumer could not finish: it retries at its own gate and holds back nothing. */
  async releaseThreadBackfill(input: ThreadBackfillMessage): Promise<boolean> {
    await this.initialized;
    const request = parseRpcInput(ThreadBackfillMessageSchema, input, "release_thread_backfill");
    this.assertWorkspace(request.workspaceId);
    const released = releaseThreadBackfill(this.state.storage.sql, request.job, request.workstreamId, request.attempt);
    await this.armNextAlarm();
    return released;
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

  async failSpaceDefaultTarget(input: SpaceDefaultQueueMessage): Promise<boolean> {
    await this.initialized;
    const request = parseRpcInput(SpaceDefaultQueueMessageSchema, input, "fail_space_default_target");
    this.assertWorkspace(request.workspaceId);
    return this.spaceStorage().failDefaultTarget(request, "space_default_requester_inactive");
  }

  /**
   * Where the Organization is in its one-time Space cutover.
   *
   * Server-to-server, like `recordSpaceIntentReceipt` and the default-target
   * settlement RPCs beside it, and deliberately without the membership recheck
   * every *product* Space RPC carries: there is no person on the request to
   * recheck. The cutover runs without anybody signed in, and the workspace id
   * is the whole address. What it answers — a phase, General's id, and the
   * Channels the cutover is stuck on — is the cutover's own state; the
   * `spacesReady` a client sees comes off the socket, shaped for that viewer.
   */
  async spaceBootstrapStatus(input: { workspaceId: string }): Promise<WorkspaceSpaceBootstrapStatus> {
    await this.initialized;
    const request = parseRpcInput(
      z.strictObject({ workspaceId: IdSchema }), input, "space_bootstrap_status",
    );
    this.assertWorkspace(request.workspaceId);
    return WorkspaceSpaceBootstrapStatusSchema.parse(this.spaceStorage().bootstrapStatus());
  }

  /**
   * One page of the Channels the cutover still has to place.
   *
   * Server-to-server, for the reason `spaceBootstrapStatus` is: there is no
   * person on the request. The cutover runs with nobody signed in, and the
   * workspace id is the whole address. It grants nothing — the actor each
   * placement runs as is chosen from the `participantUserIds` it answers with,
   * and every write that follows is authorized as that person.
   */
  async spaceBootstrapPage(input: {
    workspaceId: string;
    cursor: string | null;
  }): Promise<WorkspaceSpaceBootstrapPage> {
    await this.initialized;
    const request = parseRpcInput(
      z.strictObject({ workspaceId: IdSchema, cursor: IdSchema.nullable() }),
      input,
      "space_bootstrap_page",
    );
    this.assertWorkspace(request.workspaceId);
    const storage = this.spaceStorage();
    const page = storage.bootstrapPage(request.cursor);
    return WorkspaceSpaceBootstrapPageSchema.parse({
      generalSpaceId: storage.generalSpaceId(),
      items: page.items,
      nextCursor: page.nextCursor,
    });
  }

  /**
   * Record what one page of cutover work finished, and move the pass on.
   *
   * Blockers land in the same call as the phase advance, so a redelivery of the
   * page reports the same blockers once. What a redelivery skips is decided by
   * the membership row itself rather than by a receipt: it is the state a
   * placement actually produces, and it cannot disagree with one.
   *
   * `clearedWorkstreamIds` is what the page settled *for*, and clearing those
   * Channels' blockers is what lets a remediated Channel close the
   * Organization: a pass that places it, or a preflight that now finds it safe,
   * takes it off the row.
   */
  async settleSpaceBootstrapPage(
    input: WorkspaceSpaceBootstrapSettleRequest,
  ): Promise<{ settled: true }> {
    await this.initialized;
    const request = parseRpcInput(
      WorkspaceSpaceBootstrapSettleRequestSchema, input, "settle_space_bootstrap_page",
    );
    this.assertWorkspace(request.workspaceId);
    const storage = this.spaceStorage();
    storage.clearBootstrapBlocked(request.clearedWorkstreamIds);
    storage.recordBootstrapBlocked(request.blocked);
    // Where the pass goes next. A walk with another page stays where it is; a
    // walk that finished moves on — except that `memberships` is only entered
    // from a `preflight` that found nothing, which is what keeps the first
    // Channel from being widened in an Organization the cutover is going to
    // refuse. A preflight that found something goes to `finalize`, which is the
    // pass that reports.
    storage.advanceBootstrap(
      request.phase === "general" ? "preflight"
        : request.cursor !== null ? request.phase
        : request.phase === "preflight" && storage.blockedEntries().length === 0 ? "memberships"
        : "finalize",
      request.cursor,
    );
    await this.armNextAlarm();
    return { settled: true };
  }

  /**
   * Put a settled cutover back on the walk.
   *
   * Server-to-server, for the reason the rest of the cutover's RPCs are: there
   * is no person on the request. Two callers, both saying the same thing —
   * something about this Organization's hierarchy is not true yet, so the walk
   * has to run again. `runFinalize` says it when a blocker is still recorded,
   * because the pass that clears one is the pass this re-arms; and a connector
   * placement that was refused says it because the Channel it just opened is in
   * no Space at all.
   *
   * Idempotent, and it keeps the claim's retry gate rather than zeroing it, so
   * an Organization nobody remediates re-walks on the ordinary interval instead
   * of spinning the alarm.
   */
  async reopenSpaceBootstrap(input: { workspaceId: string }): Promise<{ reopened: boolean }> {
    await this.initialized;
    const request = parseRpcInput(
      z.strictObject({ workspaceId: IdSchema }), input, "reopen_space_bootstrap",
    );
    this.assertWorkspace(request.workspaceId);
    return { reopened: await this.reopenSpaceBootstrapWalk() };
  }

  /**
   * Put this Organization back on the cutover's walk, and do the two things
   * that have to follow it.
   *
   * The RPC above and the directory handoff's unplaced-Channel guard both need
   * all three steps, and they are not independent: `reopenBootstrap` advancing
   * the Space waterline is what makes the snapshot newer than the one a client
   * holds, so a reopen that did not publish would leave every sidebar rendering
   * a hierarchy the Organization no longer claims is complete, and one that did
   * not arm would leave the walk it just scheduled waiting for an unrelated
   * wake. A copy of this at the second call site is a copy that can lose one of
   * them.
   *
   * The answer is whether this took the Organization out of `complete`, which
   * is the one transition a client can see: `spacesReady` goes false and the
   * sidebar goes back to the Organization-opening state.
   */
  private async reopenSpaceBootstrapWalk(): Promise<boolean> {
    const reopened = this.spaceStorage().reopenBootstrap();
    if (reopened) this.publishSpaceSnapshot();
    await this.armNextAlarm();
    return reopened;
  }

  /**
   * Which of these Channels the Organization's directory already holds.
   *
   * The other half of the guard above: it is a Channel the Organization was
   * *already* holding that says the invariant is broken, so this has to be
   * asked before the batch commits, when the answer is still available.
   *
   * `json_each` rather than a placeholder list for the reason
   * `unplacedChannelExists` uses one: the statement stays a single text
   * whatever a batch carries, and this one runs on the ordinary projection
   * path.
   */
  private directoryChannelsPresent(workstreamIds: readonly string[]): string[] {
    return this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT workstream_id FROM channels
        WHERE workstream_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify([...workstreamIds]),
    ).toArray().map((row) => row.workstream_id);
  }

  /**
   * Close the cutover, or say why it cannot close yet.
   *
   * Two gates: no Channel outside every Space, and no Channel the cutover is
   * blocked on. There was a third — no Project effect still queued — and it
   * could not fire: migration 62 runs in the constructor, so by the time any
   * caller reaches this the Project tables are gone and the question has no
   * rows to ask. What actually retires those effects is the invalidation
   * inside that migration and the tombstone consumer that acknowledges a
   * redelivery, both of which happen without this being consulted.
   */
  async finalizeSpaceBootstrap(input: { workspaceId: string }): Promise<WorkspaceSpaceBootstrapFinalizeResult> {
    await this.initialized;
    const request = parseRpcInput(
      z.strictObject({ workspaceId: IdSchema }), input, "finalize_space_bootstrap",
    );
    this.assertWorkspace(request.workspaceId);
    const outcome = this.spaceStorage().completeBootstrap();
    if (outcome === "complete") {
      this.publishSpaceSnapshot();
      await this.seatEveryoneOnceSpacesOpen();
    }
    return WorkspaceSpaceBootstrapFinalizeResultSchema.parse({ outcome });
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
        ? [connectorEventFromRow(this.state.storage.sql, row, request.workspaceId, this.env.AVALON_REGION)]
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


  /**
   * Commit directory effects from outside a hosted parent's own transaction.
   * No production path calls this since the legacy parent objects were
   * deleted: every hosted parent applies its directory step in its own
   * transaction (`applyLocalEffects`). Tests use it to seed the directory the
   * way a parent's publish would, learning unknown members first.
   */
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
    await this.learnMembers(this.unknownMembers(request.envelopes));
    const batch = this.state.storage.transactionSync(() => {
      const applied = this.applyDirectoryBatch(request);
      return { ...applied, recorded: this.recordDirectoryFollowUp(applied.followUp) };
    });
    await this.runDirectoryFollowUps(batch.recorded === null ? [] : [batch.recorded]);
    return WorkspaceDirectoryApplyResultSchema.parse({
      accepted: batch.accepted,
      directoryChanged: batch.followUp.directoryChanged,
    });
  }

  /**
   * The directory write itself: synchronous, so it can run inside a hosted
   * parent's transaction and land with the parent change that caused it.
   * Returns what it accepted and the post-commit work the batch owes. An
   * envelope that cannot be applied (a viewer row whose Channel row is not
   * here yet) throws and takes the caller's transaction with it, and a viewer
   * the member table has never heard of throws `UnknownMembersError`.
   */
  private applyDirectoryBatch(request: WorkspaceDirectoryApplyRequest): {
    accepted: WorkspaceDirectoryApplyResult["accepted"];
    followUp: DirectoryFollowUp;
  } {
    // A Space publishes the same `directory_common` and `directory_user`
    // effects a Channel does, and both land here. They are kept apart from this
    // line on: a Space in `channels` would be a Space in
    // the Channel sidebar, and the two directories answer different questions.
    // Membership is answered from this object's member table. Somebody it
    // has never heard of is learned from D1 before the transaction, so
    // meeting one here rolls it back for the caller to learn and retry.
    const members = this.memberStatuses(request.envelopes);
    const unknown = this.unknownMembers(request.envelopes, members);
    if (unknown.length > 0) throw new UnknownMembersError(unknown);
    const envelopes = request.envelopes;
    const activeUsers = new Set([...members].flatMap(([userId, active]) => (active ? [userId] : [])));
    const spaceEnvelopes = envelopes.filter((envelope) => envelope.parentKind === "space");
    // A breakout's own projection is a third destination. It names itself on
    // the envelope; a Channel's aggregate names nothing, so the absence of the
    // id is what keeps every existing envelope on the Channel path unchanged.
    const breakoutEnvelopes = envelopes.filter((envelope) => (
      envelope.parentKind !== "space" && envelope.substreamId !== undefined
    ));
    const channelEnvelopes = envelopes.filter((envelope) => (
      envelope.parentKind !== "space" && envelope.substreamId === undefined
    ));
    // Read before the loop commits anything, because which of these Channels
    // the Organization was *already* holding is the question the unplaced
    // guard at the foot of this method turns on, and by then every one of them
    // has a row. Skipped entirely on an Organization whose cutover has not
    // closed, which is the only state the guard has nothing to say about.
    // A breakout is deliberately not asked: it has no membership of its own,
    // and the Channel it belongs to is what the hierarchy invariant is about.
    const commonChannelIds = [...new Set(channelEnvelopes.flatMap((envelope) => (
      envelope.effect.kind === "directory_common" ? [envelope.parentId] : []
    )))];
    const settledChannelIds = commonChannelIds.length > 0
      && this.spaceStorage().bootstrapStatus().ready
      ? this.directoryChannelsPresent(commonChannelIds)
      : [];
    let directoryChanged = false;
    const commonChanges = new Set<string>();
    const archivalChanges = new Set<string>();
    const watchReconciliations = new Set<string>();
    const viewerChanges = new Map<string, Set<string>>();
    // The two halves of "somebody's reach into a Space moved in this batch":
    // the Channels whose viewer participation changed, and the people it
    // changed for. Participation and nothing else, because the Channel half of
    // the Space visibility predicate is `scope = 'workspace' OR is_participant`
    // — an unread count or a mention arrives on every message and moves no
    // Space at all.
    const reachChannels = new Set<string>();
    const reachViewers = new Set<string>();
    const accepted: WorkspaceDirectoryApplyResult["accepted"] = [];
    let spaceDirectoryChanged = false;
    // A breakout's move is a Space dashboard's move and nothing else's. It is
    // kept apart from `commonChanges` and `viewerChanges` because those two
    // also drive the Channel row push, the Terminal schedule and the watch
    // reconciliation, none of which a breakout has or wants.
    const breakoutChanges = new Set<string>();
    const breakoutViewerChanges = new Map<string, Set<string>>();
    const breakoutArchivalChanges = new Set<string>();
    // Everyone who joined or left a Channel or a Breakout in this batch. Wider
    // than `reachViewers`, which is Channels only because a breakout moves no
    // Space; this set feeds `publishReachChanged`, which is about the person.
    const reachChangedUsers = new Set<string>();
    // Who may have lost each Channel in this batch, decided here against the
    // rows as they were before it: once the batch commits, "who could see it
    // a moment ago" is no longer answerable.
    const channelLosses = new ChannelRowPlan();
    const breakoutDirectoryReady = breakoutEnvelopes.length === 0
      || this.breakoutStorage().ready();
    // Conversations this batch started or finished a run in: the Activity
    // rows that push, decided from each row either side of its common effect.
    // A finish is the state arriving at `completed`, not `completed_at`
    // moving: a parent stamps a completed thread's finish with its latest
    // activity, so ordinary traffic after a run moves it with no new run.
    const activityPushSubjects: ActivityPushSubject[] = [];
    const noteActivity = (
      conversation: { threadId: string; substreamId: string | null },
      before: ActivityMoment | null,
    ) => {
      const after = this.activityMoment(conversation);
      if (!after) return;
      if (before === null && after.started) activityPushSubjects.push({ ...conversation, kind: "start" });
      if (after.finished && before?.finished !== true) activityPushSubjects.push({ ...conversation, kind: "finish" });
    };
    for (const envelope of spaceEnvelopes) {
      const changed = this.applySpaceDirectoryEnvelope(envelope, activeUsers);
      spaceDirectoryChanged = changed || spaceDirectoryChanged;
      accepted.push({ messageId: envelope.messageId, payloadHash: envelope.payloadHash });
    }
    for (const envelope of breakoutEnvelopes) {
      // The deleted WorkstreamDO's migration 19 replayed quiet stored
      // projections only once. An Organization held at schema 57 has no breakout tables yet,
      // so do not receipt or acknowledge that delivery: the activity Queue's
      // existing incomplete-acceptance path keeps it retryable until migration
      // 63 creates the destination.
      if (!breakoutDirectoryReady) continue;
      // Read before and after, because a Sidekick whose home is this breakout
      // is told only when its archive state actually moves: every message
      // moves a breakout's row, and a call per message to each homed
      // Sidekick would buy nothing.
      const archivedBefore = envelope.effect.kind === "directory_common" && envelope.substreamId !== undefined
        ? this.breakoutArchivedAt(envelope.parentId, envelope.substreamId) : undefined;
      const breakoutSubject = envelope.effect.kind === "directory_common" && envelope.substreamId !== undefined
        ? { threadId: envelope.parentId, substreamId: envelope.substreamId } : null;
      const activityBefore = breakoutSubject ? this.activityMoment(breakoutSubject) : null;
      const breakout = this.applyBreakoutDirectoryEnvelope(envelope, activeUsers);
      if (breakout.moved && breakoutSubject) noteActivity(breakoutSubject, activityBefore);
      if (breakout.moved && envelope.substreamId !== undefined && archivedBefore !== undefined
        && this.breakoutArchivedAt(envelope.parentId, envelope.substreamId) !== archivedBefore) {
        breakoutArchivalChanges.add(`${envelope.parentId}/${envelope.substreamId}`);
      }
      if (breakout.moved) {
        if (envelope.effect.kind === "directory_common") breakoutChanges.add(envelope.parentId);
        else if (envelope.effect.kind === "directory_user") {
          const users = breakoutViewerChanges.get(envelope.parentId) ?? new Set<string>();
          users.add(envelope.effect.userId);
          breakoutViewerChanges.set(envelope.parentId, users);
          if (breakout.participationChanged) reachChangedUsers.add(envelope.effect.userId);
          if (breakout.participationChanged && envelope.effect.isParticipant && envelope.substreamId !== undefined) {
            activityPushSubjects.push({ threadId: envelope.parentId, substreamId: envelope.substreamId,
              kind: "joined", userId: envelope.effect.userId });
          }
        }
      }
      accepted.push({ messageId: envelope.messageId, payloadHash: envelope.payloadHash });
    }
    for (const envelope of channelEnvelopes) {
      const threadSubject = envelope.effect.kind === "directory_common"
        ? { threadId: envelope.parentId, substreamId: null } : null;
      const activityBefore = threadSubject ? this.activityMoment(threadSubject) : null;
      const applied = this.applyDirectoryEnvelope(envelope, activeUsers);
      if (applied.changed && threadSubject) noteActivity(threadSubject, activityBefore);
      directoryChanged = directoryChanged || applied.changed;
      if (applied.lost !== null) channelLosses.lost(envelope.parentId, applied.lost);
      // A replay reconciles as well as a first application, the way the watch
      // registrations below do. The row and its receipt commit inside the call
      // above, while the publications happen after the awaits that follow this
      // loop — so a redelivery caused by any of those rejecting arrives with
      // the archival already recorded and nothing left to compare against. It
      // cannot tell a replayed archival from a replayed ordinary edit, so it
      // treats every replayed common effect as one; the membership test below
      // is what keeps that off the sockets, and a replay only happens on the
      // retry path.
      if (applied.archivalChanged
        || (applied.replayed && envelope.effect.kind === "directory_common")) {
        archivalChanges.add(envelope.parentId);
      }
      if (applied.changed && envelope.effect.kind === "directory_common") {
        commonChanges.add(envelope.parentId);
      } else if (applied.changed && envelope.effect.kind === "directory_user") {
        if (applied.participantMembershipChanged) {
          // The facepile is the whole participant set. A join or leave that
          // only reached the affected viewer's socket would leave everyone
          // else's pile stale until reconnect.
          commonChanges.add(envelope.parentId);
          reachChannels.add(envelope.parentId);
          reachViewers.add(envelope.effect.userId);
          reachChangedUsers.add(envelope.effect.userId);
          if (envelope.effect.isParticipant) {
            activityPushSubjects.push({ threadId: envelope.parentId, substreamId: null,
              kind: "joined", userId: envelope.effect.userId });
          }
        } else {
          const users = viewerChanges.get(envelope.parentId) ?? new Set<string>();
          users.add(envelope.effect.userId);
          viewerChanges.set(envelope.parentId, users);
        }
      }
      if (envelope.effect.kind === "directory_common") {
        const current = this.state.storage.sql.exec<{
          authority_generation: number;
          waterline: number;
          payload_hash: string;
        }>(`SELECT authority_generation, waterline, payload_hash
              FROM channels WHERE workstream_id = ?`,
        envelope.parentId).toArray()[0];
        // Reconcile on an exact replay as well as the first application. The
        // directory row and registration replacement are separate durable
        // transactions, so a failed connector lookup must be recoverable by
        // replaying the same outbox envelope.
        if (current
          && current.authority_generation === envelope.generation
          && current.waterline === envelope.sourceVersion
          && current.payload_hash === envelope.payloadHash) {
          watchReconciliations.add(envelope.parentId);
        }
      }
      accepted.push({ messageId: envelope.messageId, payloadHash: envelope.payloadHash });
    }
    // Space snapshots and the unplaced-Channel check read and advance this
    // object's own rows, so they are decided here, in the transaction; only
    // the sends they lead to wait for the commit.
    //
    // A Space counts the members it can show, so a Channel arriving in or
    // leaving the archive changes what its Spaces say about themselves, and a
    // Space directory at a waterline a client already holds is dropped as a
    // replay. A person's reach into a Space moving (their participation in one
    // of its Channels) republishes to exactly those people. Both advance the
    // Space waterline only when one of these Channels is in a Space.
    const spaceStorage = this.spaceStorage();
    let publishSnapshotAll = false;
    let snapshotUsers: string[] = [];
    if (spaceDirectoryChanged
      || (archivalChanges.size > 0
        && spaceStorage.noteMemberDirectoryChange([...archivalChanges]))) {
      publishSnapshotAll = true;
    } else if (reachViewers.size > 0 && spaceStorage.noteMemberDirectoryChange([...reachChannels])) {
      snapshotUsers = [...reachViewers];
    }
    // The backstop for the hierarchy invariant: a Channel the Organization
    // was already holding that is still in no Space is a broken invariant
    // rather than an unfinished creation, and nothing else will fix it.
    const reopenBootstrap = settledChannelIds.length > 0
      && spaceStorage.unplacedChannelExists(settledChannelIds);
    const common = (envelope: ParentEffectEnvelope) => envelope.effect.kind === "directory_common";
    // The follow-up pass sends these Channels' rows once it has run; taken
    // from the ledger now, so the drain after this write does not send them
    // first and the pass again.
    if (this.railLedger) {
      for (const workstreamId of drainChannelRailChanges(this.state.storage.sql)) this.railRowsHeld.add(workstreamId);
    }
    return {
      accepted,
      followUp: {
        workspaceId: request.workspaceId,
        publishSnapshotAll,
        snapshotUsers,
        reachChangedUsers: [...reachChangedUsers],
        commonChanges: [...commonChanges],
        viewerChanges: [...viewerChanges].map(([id, users]) => [id, [...users]]),
        breakoutChanges: [...breakoutChanges],
        breakoutViewerChanges: [...breakoutViewerChanges].map(([id, users]) => [id, [...users]]),
        reopenBootstrap,
        watchReconciliations: [...watchReconciliations],
        archivalChanges: [...archivalChanges],
        breakoutArchivalChanges: [...breakoutArchivalChanges],
        // Replays repair an arm lost after the directory commit, so any common
        // effect re-derives the Terminal schedule from current rows.
        refreshTerminal: commonChanges.size > 0 || channelEnvelopes.some(common),
        refreshWatchKinds: channelEnvelopes.some((envelope) => (
          envelope.effect.kind === "directory_common" && (envelope.effect.resourceLinks?.length ?? 0) > 0
        )),
        directoryChanged,
        syncTopics: [],
        refreshProductAlarm: false,
        channelLosses: [...channelLosses.channels].map(([id, { lost }]) => [id, [...lost]]),
        activityPushSubjects,
      },
    };
  }

  /**
   * What a conversation's directory row says to Activity: whether it reads as
   * started by somebody, and whether its run has finished. Compared either
   * side of a common effect, so a start (no row before, a started row after)
   * and a finish (not finished before, finished after) stand out from the rest
   * of a conversation's traffic. Null when there is no row.
   */
  private activityMoment(subject: { threadId: string; substreamId: string | null }): ActivityMoment | null {
    const row = subject.substreamId === null
      ? this.state.storage.sql.exec<ActivityMomentRow>(
        `SELECT created_by_user_id, system_kind, exact_state, completed_at, archived_at
           FROM channels WHERE workstream_id = ?`,
        subject.threadId,
      ).toArray()[0]
      : this.state.storage.sql.exec<ActivityMomentRow>(
        `SELECT created_by_user_id, NULL AS system_kind, exact_state, completed_at, archived_at
           FROM breakouts WHERE workstream_id = ? AND substream_id = ?`,
        subject.threadId, subject.substreamId,
      ).toArray()[0];
    if (!row) return null;
    return {
      started: row.created_by_user_id !== null && row.system_kind === null && row.archived_at === null,
      finished: row.exact_state === "completed" && row.completed_at !== null,
    };
  }

  /**
   * Push the Activity rows a committed batch made: see
   * `workspace-activity-push.ts`. Each row is recorded once it has been handed
   * to delivery, so a later batch about the same conversation sends only what
   * is left.
   */
  private async pushActivity(workspaceId: string, subjects: readonly ActivityPushSubject[]): Promise<void> {
    if (subjects.length === 0) return;
    const pushes = new WorkspaceActivityPushes(
      this.state.storage,
      new WorkspaceActivityFeed(this.state.storage, this.spaceStorage()),
    );
    if (!pushes.ready()) return;
    const audience = pushes.audience(subjects);
    if (!audience.everyone && audience.userIds.length === 0) return;
    const recipients = await activeMembersForActivity(
      this.env, workspaceId, audience.everyone ? null : audience.userIds,
    );
    for (const recipient of recipients) {
      // One person's failure leaves the others' deliveries standing.
      try {
        // The channels this person chose for a kind; push only with a device.
        const notify = this.readMemberPreferences(recipient.userId).notify;
        const channels = (kind: PushNotificationData["kind"]) => notify[NOTIFICATION_KIND_FOR_PUSH[kind]]
          .filter((channel) => channel !== "push" || recipient.hasDevice);
        // Someone with a device is decided even with every channel off, so a
        // kind turned back on later never sends an old row; someone with no
        // device and nothing else chosen is not asked at all, as before.
        if (!recipient.hasDevice && !ACTIVITY_PUSH_KINDS.some((kind) => channels(kind).length > 0)) continue;
        const items = pushes.pending(
          { userId: recipient.userId, accessClass: recipient.accessClass },
          subjects,
          this.threadsOnScreen(recipient.userId),
        );
        for (const item of items) {
          // Recorded whether or not it was queued: a row not queued (no
          // channel chosen, no transport in this deployment) would not be
          // queued by a later batch either. The consumer checks the choice
          // again when it sends, so one changed since never sends an old
          // row late.
          for (const channel of channels(item.kind as PushNotificationData["kind"])) {
            const address = { region: this.env.AVALON_REGION, workspaceId, recipientUserId: recipient.userId, activityItemId: item.id };
            if (channel === "push") await enqueuePushDelivery(this.env, address);
            else await enqueueActivityDelivery(this.env, { ...address, channel });
          }
          pushes.record(recipient.userId, item.id, Date.now());
        }
      } catch (error) {
        logWarn(this.env, "activity_push_failed", {
          workspace_id: workspaceId,
          recipient_user_id: recipient.userId,
          code: diagnosticErrorCode(error, "activity_push_failed"),
        });
      }
    }
  }

  /** The threads this person has in front of them in a foreground window. */
  private threadsOnScreen(userId: string): Set<string> {
    const threads = new Set<string>();
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (attachment?.userId === userId && contributesPresence(attachment)) {
        threads.add(attachment.foregroundWorkstreamId);
      }
    }
    return threads;
  }

  /** True when a follow-up has nothing to send, reconcile or re-arm. */
  private static directoryFollowUpEmpty(followUp: DirectoryFollowUp): boolean {
    return !followUp.publishSnapshotAll && followUp.snapshotUsers.length === 0
      && followUp.reachChangedUsers.length === 0 && followUp.commonChanges.length === 0
      && followUp.viewerChanges.length === 0 && followUp.breakoutChanges.length === 0
      && followUp.breakoutViewerChanges.length === 0 && !followUp.reopenBootstrap
      && followUp.watchReconciliations.length === 0 && followUp.archivalChanges.length === 0
      && followUp.breakoutArchivalChanges.length === 0
      && !followUp.refreshTerminal && !followUp.refreshWatchKinds && !followUp.directoryChanged
      && followUp.syncTopics.length === 0 && !followUp.refreshProductAlarm
      && followUp.channelLosses.length === 0 && followUp.activityPushSubjects.length === 0;
  }

  /**
   * Record a batch's post-commit work in the transaction that committed the
   * batch, so a crash between the commit and the sends leaves it for the
   * alarm rather than losing it. The row is not due until one retry delay has
   * passed: the write that recorded it runs it straight after the commit, and
   * the alarm only takes what that run did not finish.
   */
  private recordDirectoryFollowUp(followUp: DirectoryFollowUp): { id: number; json: string } | null {
    if (WorkspaceDO.directoryFollowUpEmpty(followUp)) return null;
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
   * Run recorded follow-ups and delete each one that finished. One that throws
   * is put off on the alarm's retry schedule and logged with its reason; one
   * that does not parse is kept as `failed` and never run. A follow-up named
   * with its JSON runs only if its row still holds that JSON.
   *
   * The Channel rows and sync topics every follow-up in the pass owes are
   * collected and sent once, after the last one ran: a turn's burst of child
   * effects records one follow-up per envelope, and each used to push the same
   * Channel's row to every socket again.
   *
   * A finished follow-up is deleted whatever those sends do. The rows are
   * best effort (`publishChannelRows` never throws, and a socket that missed
   * one gets the current row when it reconnects), so a failed send is not a
   * reason to re-run every follow-up's reconciliations and notices on the
   * alarm. The topics are durable: if publishing them throws, they are
   * recorded as a follow-up of their own, and only they are retried.
   */
  private async runDirectoryFollowUps(
    entries: readonly (number | { id: number; json: string })[],
    rows = new ChannelRowPlan(),
  ): Promise<void> {
    const topics = new Set<WorkspaceSyncTopic>();
    let topicsWorkspaceId: string | null = null;
    for (const entry of entries) {
      const id = typeof entry === "number" ? entry : entry.id;
      const row = this.state.storage.sql.exec<{ followup_json: string; attempts: number }>(
        `SELECT followup_json, attempts FROM workspace_directory_followups WHERE id = ? AND state = 'pending'`, id,
      ).toArray()[0];
      if (!row || (typeof entry !== "number" && row.followup_json !== entry.json)) continue;
      const parsed = DirectoryFollowUpSchema.safeParse(JSON.parse(row.followup_json));
      if (!parsed.success) {
        const code = zodDiagnosticCode(parsed.error, "directory_followup") ?? "directory_followup_invalid";
        this.state.storage.sql.exec(
          `UPDATE workspace_directory_followups SET state = 'failed', last_error_code = ? WHERE id = ?`, code, id,
        );
        logError(this.env, "directory_followup_unreadable", {
          workspace_id: this.workspaceId(), followup_id: id, code,
        });
        continue;
      }
      const followUp = parsed.data;
      try {
        await this.runDirectoryFollowUp(followUp, rows);
        for (const topic of followUp.syncTopics) topics.add(topic);
        if (followUp.syncTopics.length > 0) topicsWorkspaceId = followUp.workspaceId;
        this.state.storage.sql.exec(`DELETE FROM workspace_directory_followups WHERE id = ?`, id);
      } catch (error) {
        this.state.storage.sql.exec(
          `UPDATE workspace_directory_followups SET attempts = attempts + 1, not_before = ? WHERE id = ?`,
          Date.now() + scheduledAlarmRetryDelay(row.attempts + 1), id,
        );
        logWarn(this.env, "directory_followup_deferred", {
          workspace_id: followUp.workspaceId,
          followup_id: id,
          attempts: row.attempts + 1,
          code: diagnosticErrorCode(error, "directory_followup_failed"),
        });
      }
    }
    this.publishChannelRows(this.collectRailChanges(rows));
    // A Channel archive pauses the Sidekicks it owns during the pass; their
    // list goes out with nothing awaited after the Channel's row.
    if (this.sidekickDirectoryMoved) {
      this.sidekickDirectoryMoved = false;
      this.publishSidebarList("automations");
    }
    if (topicsWorkspaceId !== null) {
      try {
        await this.publishSync([...topics], topicsWorkspaceId,
          this.placementAffinity() ?? await workspacePlacementAffinity(this.env, topicsWorkspaceId));
      } catch (error) {
        const followUp = WorkspaceDO.emptyDirectoryFollowUp(topicsWorkspaceId);
        followUp.syncTopics = [...topics];
        this.recordDirectoryFollowUp(followUp);
        logWarn(this.env, "directory_followup_sync_deferred", {
          workspace_id: topicsWorkspaceId,
          code: diagnosticErrorCode(error, "directory_followup_sync_failed"),
        });
      }
    }
    await this.armNextAlarm();
  }

  private dueDirectoryFollowUps(now: number): number[] {
    return this.state.storage.sql.exec<{ id: number }>(
      `SELECT id FROM workspace_directory_followups WHERE state = 'pending' AND not_before <= ? ORDER BY id LIMIT ?`,
      now, SPACE_BOOTSTRAP_PAGE_SIZE,
    ).toArray().map((row) => row.id);
  }

  private nextDirectoryFollowUpDueAt(): number | null {
    return this.state.storage.sql.exec<{ due_at: number | null }>(
      `SELECT MIN(not_before) AS due_at FROM workspace_directory_followups WHERE state = 'pending'`,
    ).one().due_at;
  }

  /**
   * The sends, reconciliations and re-arms one committed directory batch owes.
   * Its Channel rows go into `rows`, and its sync topics are read by the
   * caller, which sends both once for the whole pass.
   */
  private async runDirectoryFollowUp(followUp: DirectoryFollowUp, rows: ChannelRowPlan): Promise<void> {
    const commonChanges = new Set(followUp.commonChanges);
    const viewerChanges = new Map(followUp.viewerChanges.map(([id, users]) => [id, new Set(users)]));
    const breakoutChanges = new Set(followUp.breakoutChanges);
    const breakoutViewerChanges = new Map(followUp.breakoutViewerChanges.map(([id, users]) => [id, new Set(users)]));
    if (followUp.publishSnapshotAll) this.publishSpaceSnapshot();
    else for (const userId of followUp.snapshotUsers) this.publishSpaceSnapshot(userId);
    this.publishReachChanged(new Set(followUp.reachChangedUsers));
    // The Space dashboard's list is ordered by activity and filtered by each
    // conversation's state for the reader, so a member conversation's row
    // moving is that page moving. It goes out as a nudge of its own rather
    // than as a Space snapshot, which rebuilds both directories per socket.
    this.publishSpaceConversationsChanged({
      channelIds: [...commonChanges, ...breakoutChanges],
      viewerChannelIds: mergeViewerChanges(viewerChanges, breakoutViewerChanges),
    });
    // An access request names its conversation as it is now, and leaves out
    // one since archived; its approver's list moves with the conversation.
    for (const approverUserId of this.accessRequestStorage().approversFor([...commonChanges, ...breakoutChanges])) {
      this.publishAccessRequests(approverUserId);
    }
    // A Channel row carries its live Breakout total. A child projection does
    // not advance the parent's directory waterline, so republish the parent
    // row; the receiver may accept this aggregate from a duplicate version.
    for (const workstreamId of breakoutChanges) rows.readers(workstreamId);
    for (const [workstreamId, users] of breakoutViewerChanges) {
      if (!breakoutChanges.has(workstreamId)) rows.users(workstreamId, users);
    }
    if (followUp.reopenBootstrap) await this.reopenSpaceBootstrapWalk();
    await Promise.all(followUp.watchReconciliations.map((workstreamId) => (
      this.reconcileWorkstreamResourceRegistrations({ workspaceId: followUp.workspaceId, workstreamId })
    )));
    // Archiving a room is a decision about the room, and the automations it
    // owns follow it. Each is its own object and is told on its own.
    if (followUp.archivalChanges.length > 0 || followUp.breakoutArchivalChanges.length > 0) {
      await this.notifyOwningRoomArchival(followUp.workspaceId, followUp.archivalChanges,
        followUp.breakoutArchivalChanges);
    }
    // A `directory_common` effect is the only writer of
    // `next_terminal_action_at`, so a deadline created or moved here would
    // otherwise wait for an unrelated target to reconcile before anything
    // armed it.
    if (followUp.refreshTerminal) await this.refreshTerminalSchedule();
    if (followUp.refreshWatchKinds) {
      await this.refreshScheduleKinds(followUp.workspaceId, ["maintenance", "watch"]);
    }
    if (followUp.directoryChanged) {
      // Scope, participant, generation, and archival effects can invalidate a
      // foreground attachment without another client focus event. Rebuild now,
      // before the async state publications yield, so removed viewers neither
      // contribute to nor receive the next presence snapshot.
      this.broadcastPresence();
      for (const workstreamId of commonChanges) rows.readers(workstreamId);
      for (const [workstreamId, users] of viewerChanges) {
        if (!commonChanges.has(workstreamId)) rows.users(workstreamId, users);
      }
    }
    for (const [workstreamId, lost] of followUp.channelLosses) rows.lost(workstreamId, lost);
    if (followUp.refreshProductAlarm) await this.refreshProductAlarm();
    // Best effort, as the Channel rows are: the row is in Activity whatever
    // happens here, and a failed push must not re-run the batch's other work.
    try {
      await this.pushActivity(followUp.workspaceId, followUp.activityPushSubjects);
    } catch (error) {
      logWarn(this.env, "activity_push_failed", {
        workspace_id: followUp.workspaceId,
        code: diagnosticErrorCode(error, "activity_push_failed"),
      });
    }
  }

  /**
   * Who could have a Channel on screen just before the write being applied
   * may take it from them, read inside that write's transaction: its
   * participants at `generation`, and for an Organization-wide Channel every
   * member socket subscribed now. The sockets stand in for "every member"
   * because they are exactly who holds the Channel: a member with no socket is
   * answered with a sidebar that already reflects this write when they
   * connect, and the member table cannot list everyone anyway, since it learns
   * a member from before it existed only when something asks about them.
   * Somebody who joins or connects after this read is owed nothing, however
   * late the follow-up runs.
   */
  private channelReadersBefore(workstreamId: string, generation: number, organizationWide: boolean): string[] {
    const readers = new Set(this.state.storage.sql.exec<{ user_id: string }>(
      `SELECT user_id FROM channel_viewers
        WHERE workstream_id = ? AND authority_generation = ? AND is_participant = 1`,
      workstreamId, generation,
    ).toArray().map((row) => row.user_id));
    if (!organizationWide) return [...readers];
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (attachment?.subscribed && organizationWideAdmits("workspace", viewerOf(attachment).accessClass)) readers.add(attachment.userId);
    }
    return [...readers];
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
    let followUpId: { id: number; json: string } | null = null;
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
      if (!active) {
        // Leaving a Channel's participants changes its facepile for everyone,
        // leaving any row changes this person's reach, and leaving a Space's
        // viewers changes that Space's snapshot: the same sends a directory
        // batch that dropped these rows would owe.
        const channels = this.state.storage.sql.exec<{ workstream_id: string; is_participant: number }>(
          `DELETE FROM channel_viewers WHERE user_id = ? RETURNING workstream_id, is_participant`, userId,
        ).toArray();
        const breakouts = this.state.storage.sql.exec<{ workstream_id: string }>(
          `DELETE FROM breakout_viewers WHERE user_id = ? RETURNING workstream_id`, userId,
        ).toArray();
        const spaces = this.state.storage.sql.exec(
          `DELETE FROM space_viewers WHERE user_id = ? RETURNING space_id`, userId,
        ).toArray();
        if (channels.length + breakouts.length + spaces.length > 0) {
          const followUp = WorkspaceDO.emptyDirectoryFollowUp(request.workspaceId);
          followUp.reachChangedUsers = [userId];
          followUp.commonChanges = [...new Set(channels.flatMap((row) => (row.is_participant === 1 ? [row.workstream_id] : [])))];
          // The person who left may still hold a socket until the revocation
          // walk closes it; each Channel they sat in is owed its tombstone.
          followUp.channelLosses = followUp.commonChanges.map((workstreamId) => [workstreamId, [userId]]);
          followUp.breakoutChanges = [...new Set(breakouts.map((row) => row.workstream_id))];
          followUp.publishSnapshotAll = spaces.length > 0
            || this.spaceStorage().noteMemberDirectoryChange(channels.map((row) => row.workstream_id));
          followUp.directoryChanged = true;
          followUpId = this.recordDirectoryFollowUp(followUp);
        }
      }
      return true;
    });
    if (followUpId !== null) await this.runDirectoryFollowUps([followUpId]);
    return { applied };
  }

  /**
   * Turn authoritative watched links into exact typed registrations. The work
   * stream projects only the link intent; WorkspaceDO resolves resource and
   * connector facts and uses the same replacement engine as automations.
   */
  /**
   * Tell each automation a room owns that the room's archive state changed.
   *
   * Read from the directory rather than assumed from the effect: a replayed
   * common effect reaches here too, and the row is what the archive is now.
   * A Sidekick whose home is a Breakout counts as archived when the Breakout
   * or its Channel is, so archiving either one tells it; `breakoutKeys` names
   * the Breakouts (`<channelId>/<breakoutId>`) whose own archive moved.
   */
  private async notifyOwningRoomArchival(
    workspaceId: string,
    workstreamIds: readonly string[],
    breakoutKeys: readonly string[] = [],
    onlyAutomationId: string | null = null,
  ): Promise<void> {
    const owned = this.state.storage.sql.exec<{
      automation_id: string;
      workstream_id: string;
      archived_at: number | null;
      breakout_archived_at: number | null;
    }>(
      `SELECT automation.automation_id, directory.workstream_id, directory.archived_at,
              breakout.archived_at AS breakout_archived_at
         FROM automation_directory automation
         JOIN channels directory
           ON directory.workstream_id = automation.owning_workstream_id
         LEFT JOIN breakouts breakout
           ON automation.owning_substream_id <> '0'
          AND breakout.workstream_id = automation.owning_workstream_id
          AND breakout.substream_id = automation.owning_substream_id
        WHERE automation.lifecycle <> 'deleted'
          AND (?3 IS NULL OR automation.automation_id = ?3)
          AND (automation.owning_workstream_id IN (SELECT value FROM json_each(?1))
            OR (automation.owning_substream_id <> '0'
              AND automation.owning_workstream_id || '/' || automation.owning_substream_id
                IN (SELECT value FROM json_each(?2))))
        ORDER BY automation.automation_id`,
      JSON.stringify(workstreamIds),
      JSON.stringify(breakoutKeys),
      onlyAutomationId,
    ).toArray();
    if (owned.length === 0) return;
    await this.ensureParentWorkspace(workspaceId);
    const host = this.hostedSidekickHost();
    // Each Sidekick's pause or resume, its registrations and its alarm entries
    // commit in one local transaction per Sidekick, right after the archive
    // that caused them, so one that fails leaves the others moved.
    for (const row of owned) {
      try {
        const sidekick = new HostedSidekick(host, row.automation_id);
        const now = Date.now();
        const outcome = this.state.storage.transactionSync(() => sidekick.setOwningRoomArchived({
          workspaceId: asWorkspaceId(workspaceId),
          automationId: row.automation_id,
          workstreamId: row.workstream_id,
          archived: row.archived_at !== null || row.breakout_archived_at !== null,
        }, now));
        if (outcome.outcomeCode === "sidekick_resumed") {
          const resumed = sidekick.row();
          const evaluators = resumed ? JSON.parse(resumed.evaluator_projection_json) as unknown[] : [];
          if (resumed?.accepted_definition_revision != null && evaluators.length > 0) {
            await this.joinSidekickSlackSources(workspaceId, row.automation_id, resumed.accepted_definition_revision, evaluators);
          }
        }
      } catch (error) {
        logWarn(this.env, "sidekick_owning_room_archival_failed", {
          workspace_id: workspaceId,
          automation_id: row.automation_id,
          workstream_id: row.workstream_id,
          code: diagnosticErrorCode(error, "sidekick_owning_room_archival_failed"),
        });
      }
    }
    // The automations list is not published here: the pass that ran this
    // sends it right after the archived Channel's row, in the same turn, so
    // a client sees the archive and its pauses together.
    await this.armNextAlarm();
  }

  private async reconcileWorkstreamResourceRegistrations(input: {
    workspaceId: string;
    workstreamId: string;
  }): Promise<void> {
    const linkedResources = this.state.storage.sql.exec<{
      resource_id: string;
      watch_enabled: number;
      connection_id: string | null;
      resource_type: string | null;
    }>(`SELECT link.resource_id, link.watch_enabled, resource.connection_id, resource.resource_type
          FROM workspace_workstream_resource_links link
          LEFT JOIN resources resource ON resource.id = link.resource_id
         WHERE link.workstream_id = ?
         ORDER BY link.resource_id`, input.workstreamId).toArray();
    const linkedById = new Map(linkedResources.map((resource) => [resource.resource_id, resource]));
    const destinationResourceIds = new Set([
      ...linkedById.keys(),
      ...this.state.storage.sql.exec<{ destination_resource_id: string }>(
        `SELECT DISTINCT destination_resource_id
           FROM workspace_external_event_registrations
          WHERE destination_kind = 'workstream_resource_update'
            AND workstream_id = ? AND destination_resource_id IS NOT NULL`,
        input.workstreamId,
      ).toArray().map((row) => row.destination_resource_id),
    ]);
    if (destinationResourceIds.size === 0) return;
    const connections = this.state.storage.sql.exec<{
      id: string;
      connector_type: string;
      status: string;
    }>(`SELECT id, connector_type, status FROM connector_connections WHERE workspace_id = ?`, input.workspaceId)
      .toArray();
    const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
    const manifests = new Map(connectorRegistryForEnv(this.env).list().map((manifest) => [manifest.type, manifest]));

    for (const resourceId of destinationResourceIds) {
      const resource = linkedById.get(resourceId);
      const connection = resource?.connection_id ? connectionsById.get(resource.connection_id) : undefined;
      const manifest = connection ? manifests.get(connection.connector_type) : undefined;
      const descriptors = resource?.watch_enabled === 1
        && resource.resource_type
        && (connection?.status === "healthy" || connection?.status === "active")
        && manifest?.supportsWatches
        ? manifest.activityTriggers.filter(
            (descriptor) => automationTriggersAdmitResourceType([descriptor], resource.resource_type!),
          )
        : [];
      await this.applyExternalEventRegistrations({
        schemaVersion: 1,
        workspaceId: input.workspaceId,
        destination: {
          kind: "workstream_resource_update",
          workstreamId: input.workstreamId,
          substreamId: "0",
          resourceId,
        },
        evaluators: descriptors.map((descriptor) => ({
          evaluatorId: uuidV7(),
          source: {
            connectorType: connection!.connector_type,
            connectionId: connection!.id,
            eventType: descriptor.eventType,
            resourceId,
          },
          when: { kind: "always" },
        })),
      });
    }
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
    if (!result.replayed && request.envelope.effect.kind === "activity_event") {
      await this.refreshProductAlarm();
    }
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
    return this.conversationCandidates(request.userId, request.membershipIncarnation, request.accessClass);
  }

  /**
   * The Channels where this person may be able to read some conversation
   * without reaching the Channel through the member directory: an explicit
   * scope grant, or membership of one of its breakouts. Discovery only; every
   * Channel named here decides for itself which conversations it releases.
   */
  private conversationCandidates(userId: string, membershipIncarnation: string, accessClass: AccessClass): string[] {
    return [...new Set([
      ...scopeGrantCandidates(this.state.storage, userId, membershipIncarnation),
      ...this.spaceStorage().channelsReachedOnlyThroughBreakouts({ userId, accessClass }),
    ])].sort();
  }

  async listSharedNavigationSpaces(input: unknown) {
    await this.initialized;
    const request = SharedNavigationSpacesRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const candidates = new Set(this.conversationCandidates(request.userId, request.membershipIncarnation, request.accessClass));
    const admittedIds = request.workstreamIds.filter((workstreamId) => candidates.has(workstreamId));
    return this.spaceStorage().sharedNavigationSpaces(admittedIds).map((space) =>
      SharedNavigationSpaceSchema.parse(space));
  }

  async listWorkstreams(input: WorkspaceDirectoryListRequest): Promise<WorkspaceDirectoryPage> {
    await this.initialized;
    const request = WorkspaceDirectoryListRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return WorkspaceDirectoryPageSchema.parse(this.listDirectory(request));
  }

  /**
   * Summarize member attention from the authoritative workspace directory.
   * Each work stream contributes at most once even when several reasons apply.
   */
  async attention(input: WorkspaceAttentionRequest): Promise<WorkspaceAttentionResult> {
    await this.initialized;
    const request = WorkspaceAttentionRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{
      waiting_for_you: number;
      waiting_priority: number;
      has_unread_activity: number;
    }>(
      `SELECT
         COALESCE(SUM(CASE
           WHEN viewer.is_participant = 1 AND (
             viewer.latest_mention_attention_ordinal > viewer.seen_attention_ordinal
             OR viewer.unseen = 1
             OR directory.exact_state = 'needs_input'
           ) THEN 1 ELSE 0 END), 0) AS waiting_for_you,
         COALESCE(MAX(CASE
           WHEN viewer.is_participant = 1
            AND viewer.latest_mention_attention_ordinal > viewer.seen_attention_ordinal THEN 3
           WHEN viewer.is_participant = 1 AND directory.exact_state = 'needs_input' THEN 2
           WHEN viewer.is_participant = 1 AND viewer.unseen = 1 THEN 1
           ELSE 0 END), 0) AS waiting_priority,
         COALESCE(MAX(CASE
           WHEN (directory.scope = 'workspace' OR viewer.is_participant = 1) AND (
             directory.latest_attention_ordinal > COALESCE(
               viewer.seen_attention_ordinal,
               directory.unread_tracking_start_ordinal
             )
             OR viewer.manual_unread_from_ordinal IS NOT NULL
             OR viewer.unseen = 1
           ) THEN 1 ELSE 0 END), 0) AS has_unread_activity
       FROM channels directory
       LEFT JOIN channel_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE directory.archived_at IS NULL
         AND directory.system_kind IS NULL`,
      request.userId,
    ).one();
    const waitingReason = row.waiting_priority === 3
      ? "mentioned"
      : row.waiting_priority === 2
        ? "needs_input"
        : row.waiting_priority === 1
          ? "unseen"
          : null;
    return WorkspaceAttentionSchema.parse({
      waitingForYou: row.waiting_for_you,
      waitingReason,
      hasUnreadActivity: row.has_unread_activity === 1,
      readerAttentionCount: this.spaceStorage().readerAttentionCount({ userId: request.userId, accessClass: request.accessClass ?? "member" }),
    });
  }

  /**
   * Resolve a generic member-visible filter once, inside the object that owns
   * the cross-work-stream index. The caller turns each returned work-stream id
   * into one Queue event; it never probes child objects to rediscover this
   * list.
   */
  async batchUpdateTargets(input: WorkspaceDirectoryBatchTargetsRequest) {
    await this.initialized;
    const request = WorkspaceDirectoryBatchTargetsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return WorkspaceDirectoryBatchTargetsResultSchema.parse({
      items: this.batchTargetIds(request.userId, request.filter),
      noteIds: [],
    });
  }

  /**
   * The rows one grouping's action reaches, under exactly the rules the sidebar
   * showed that grouping by.
   *
   * `origin_type <> 'automation'` is not a new opinion here — it is the same
   * clause the paged recent list, the pinned rows, the running rows and the
   * per-row socket push all carry, because an automation's run work stream is
   * deliberately kept out of the sidebar and reached from the automation's own
   * screen instead. This read is the fifth on that table and used to be the one
   * that did not carry it, which meant a heading's **Archive all** irreversibly
   * archived run history — a *planned* run's work stream included — that the
   * reader had never been shown under that heading, while the confirmation
   * counted it as one of the "work streams in This month".
   *
   * A row this omits for pagination is a different matter and stays in: the
   * confirmation exists precisely to name the complete server-side total rather
   * than the page the client happens to hold. Hidden is not the same as not yet
   * loaded.
   */
  private batchTargetIds(userId: string, filter: WorkstreamBatchFilter): string[] {
    const atOrAfter = filter.lastActivityAt?.atOrAfter;
    const before = filter.lastActivityAt?.before;
    const pinned = filter.pinned;
    const recency = filter.recency === "access"
      ? "COALESCE(access.last_accessed_at, directory.source_created_at)"
      : "directory.last_activity_at";
    return this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT directory.workstream_id
         FROM channels directory
         LEFT JOIN channel_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?
          AND viewer.authority_generation = directory.authority_generation
         LEFT JOIN workspace_workstream_access access
           ON access.workstream_id = directory.workstream_id AND access.user_id = ?1
        WHERE directory.archived_at IS NULL
          AND (? = 1 OR directory.system_kind IS NULL)
          AND ${this.channelListedFor("member")}
          AND (? IS NULL OR ${recency} >= ?)
          AND (? IS NULL OR ${recency} < ?)
          AND (? IS NULL OR EXISTS (
            SELECT 1
              FROM space_channel_memberships membership
              JOIN spaces space ON space.space_id = membership.space_id
              LEFT JOIN space_viewers space_viewer
                ON space_viewer.space_id = space.space_id
               AND space_viewer.user_id = ?1 AND space_viewer.is_participant = 1
             WHERE membership.space_id = ?
               AND membership.workstream_id = directory.workstream_id
               AND membership.state = 'active'
               AND space.archived_at IS NULL
               AND ${spaceListedSql("space", "space_viewer", "member", {
                 breakouts: this.spaceStorage().breakoutsReady(),
                 userId: "?1",
               })}
          ))
          AND (? IS NULL
            OR (? = 1 AND EXISTS (
              SELECT 1 FROM workspace_workstream_pins pin
               WHERE pin.user_id = ?1 AND pin.space_id = ? AND pin.workstream_id = directory.workstream_id
            ))
            OR (? = 0 AND NOT EXISTS (
              SELECT 1 FROM workspace_workstream_pins pin
               WHERE pin.user_id = ?1 AND pin.space_id = ? AND pin.workstream_id = directory.workstream_id
            )))
        ORDER BY directory.workstream_id`,
      userId,
      filter.includeSystem ? 1 : 0,
      atOrAfter ?? null,
      atOrAfter ? Date.parse(atOrAfter) : 0,
      before ?? null,
      before ? Date.parse(before) : 0,
      filter.spaceId ?? null,
      filter.spaceId ?? "",
      pinned === undefined ? null : Number(pinned),
      Number(pinned ?? false),
      filter.spaceId ?? "",
      Number(pinned ?? false),
      filter.spaceId ?? "",
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
      const now = Date.now();
      this.state.storage.sql.exec(
        `UPDATE workspace_batch_dispatch_targets SET dispatched_at = COALESCE(dispatched_at, ?)
          WHERE operation_id = ?
            AND workstream_id IN (SELECT value FROM json_each(?))`,
        now,
        request.operationId,
        JSON.stringify(request.workstreamIds),
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
    if (result.outcome !== "renamed") return result;
    this.publishArtifactPinsTo(new Set(new WorkspacePinStorage(this.state.storage).artifactPinners(request.resourceId)
      .map((pinner) => pinner.userId)), request.workspaceId);
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
   * Claim — or reclaim after an expired lease — one inbound email's
   * processing. The insert, the duplicate read and the expired-lease takeover
   * used to be three separate round trips through the runtime facade.
   */
  async claimInboundEmailReceipt(
    input: WorkspaceInboundEmailClaimRequest,
  ): Promise<WorkspaceInboundEmailClaimResult> {
    await this.initialized;
    const request = WorkspaceInboundEmailClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return claimWorkspaceInboundEmailReceipt(this.state.storage, request);
  }

  /** Extend a held inbound-email lease, or report that it was lost. */
  async renewInboundEmailLease(
    input: WorkspaceInboundEmailLeaseRequest,
  ): Promise<WorkspaceInboundEmailLeaseResult> {
    await this.initialized;
    const request = WorkspaceInboundEmailLeaseRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return renewWorkspaceInboundEmailLease(this.state.storage, request);
  }

  /** Settle a processed inbound email under its lease, releasing the lease. */
  async settleInboundEmailProcessed(
    input: WorkspaceInboundEmailSettleRequest,
  ): Promise<WorkspaceInboundEmailSettleResult> {
    await this.initialized;
    const request = WorkspaceInboundEmailSettleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return settleWorkspaceInboundEmailProcessed(this.state.storage, request);
  }

  /** Record an inbound-email processing failure and release its lease. */
  async recordInboundEmailFailure(
    input: WorkspaceInboundEmailFailureRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceInboundEmailFailureRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    recordWorkspaceInboundEmailFailure(this.state.storage, request);
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
   * bound conversation, hold behind a creation in flight, spawn a Channel in
   * the room's Space, stop at a suspended binding, or do nothing. See
   * `docs/external-conversation-bindings.md`.
   */
  async resolveExternalConversation(input: unknown): Promise<ExternalBindingResolution> {
    await this.initialized;
    const request = parseRpcInput(ExternalBindingResolveRequestSchema, input, "resolve_external_conversation");
    this.assertWorkspace(request.workspaceId);
    const resolution = this.externalBindings().resolve(request);
    if (resolution.outcome !== "spawn") return ExternalBindingResolutionSchema.parse(resolution);
    // Only a spawn reads further, and only this object's own Space row.
    const space = this.state.storage.sql.exec<{
      scope: "personal" | "workspace"; created_by_user_id: string | null; archived_at: number | null;
    }>(
      "SELECT scope, created_by_user_id, archived_at FROM spaces WHERE space_id = ?",
      resolution.spaceId,
    ).toArray()[0];
    return ExternalBindingResolutionSchema.parse({
      ...resolution,
      ...(space ? {
        space: {
          scope: space.scope,
          createdByUserId: space.created_by_user_id,
          archived: space.archived_at !== null,
        },
      } : {}),
    });
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
   * The Organization-wide Space a public room should join instead of making
   * its own. A Space whose creator is no longer an active member is not
   * offered: an unlinked sender's Channel is placed as that creator.
   */
  async externalRoomSpaceMatch(input: unknown): Promise<ExternalRoomSpaceMatchResult> {
    await this.initialized;
    const request = parseRpcInput(ExternalRoomSpaceMatchRequestSchema, input, "external_room_space_match");
    this.assertWorkspace(request.workspaceId);
    return { spaceId: (await this.roomSpaceMatch(request.workspaceId, request.name)).usable };
  }

  /** The Space `name` matches (`found`), and that Space if it may be offered (`usable`). */
  private async roomSpaceMatch(workspaceId: string, name: string): Promise<{ found: string | null; usable: string | null }> {
    const match = this.spaceStorage().organizationSpaceNamed(name);
    const usable = match?.createdByUserId != null && await this.activeSpaceMember(workspaceId, match.createdByUserId);
    return { found: match?.spaceId ?? null, usable: usable ? match.spaceId : null };
  }

  /**
   * Link a shared provider room: its Space and its room binding in one
   * transaction, or the Space an existing binding already names.
   *
   * `reserveSpace`'s steps, with the binding decided inside the transaction
   * that would write the Space, so an invitation and a first mention racing
   * each other cannot make two Spaces: the second finds the first's binding.
   * A suspended room binding is reactivated with its Space, which is what a
   * re-invitation after the bot was removed means. A private room's Space is
   * `personal` and seats the room's known Rally members; nothing here widens
   * it by member count.
   *
   * There is no pending state for a room: a Space has no conversation to
   * provision since Spaces stopped opening one, so the reservation is the
   * whole Space and the binding is written active beside it.
   */
  async linkExternalRoom(input: unknown): Promise<ExternalRoomLinkResult> {
    await this.initialized;
    const request = parseRpcInput(ExternalRoomLinkRequestSchema, input, "link_external_room");
    this.assertWorkspace(request.workspaceId);
    const bindings = this.externalBindings();
    const known = bindings.read(request.installationId, request.path);
    if (known && known.target.kind !== "space") {
      return { ok: false, code: "external_room_path_bound_to_conversation" };
    }
    if (known) {
      const existing = bindings.linkRoom(request.installationId, request.path, request.at, () => null);
      return existing
        ? { ok: true, outcome: existing.outcome, spaceId: existing.spaceId }
        : { ok: false, code: "external_room_link_failed" };
    }
    const refusal = await this.spaceRefusalCode(request.workspaceId, request.userId, "write");
    if (refusal) return { ok: false, code: refusal };
    // This link decides the match, whatever the caller's earlier ask answered:
    // a Space that now matches is joined, and a `matched` id that no longer
    // does is refused, since it has no anchor of its own to be created under.
    const match = request.spaceMatch ? await this.roomSpaceMatch(request.workspaceId, request.space.name) : null;
    if (request.spaceMatch === "matched" && match?.usable !== request.spaceId) return { ok: false, code: "space_not_found" };
    const spaceId = match?.usable ?? request.spaceId;
    const parent = await this.spaceParentReservation(spaceId);
    if (!parent.ok) return { ok: false, code: parent.code };
    const storage = this.spaceStorage();
    const reservation: WorkspaceSpaceReserveRequest = {
      workspaceId: asWorkspaceId(request.workspaceId),
      userId: asUserId(request.userId),
      spaceId: asSpaceId(spaceId),
      space: { name: request.space.name, iconKey: "users", colorKey: "blue", scope: "workspace" },
    };
    const linked = await this.withMembersLearned(() => this.state.storage.transactionSync(() => (
      bindings.linkRoom(request.installationId, request.path, request.at, () => {
        // The awaits above let a Space edit or a departure in; the match, and
        // whether its creator may still be offered, must be the ones decided.
        if (match) {
          const current = storage.organizationSpaceNamed(request.space.name);
          const usable = current?.createdByUserId != null && this.knownActiveMember(current.createdByUserId)
            ? current.spaceId
            : null;
          if ((current?.spaceId ?? null) !== match.found || usable !== match.usable) return null;
        }
        const reserved = storage.reserveForCreation(reservation, spaceId);
        if (!reserved.space) return null;
        if (reserved.created) parent.reserve(request.userId, reserved.space);
        return { spaceId, matched: match?.usable != null };
      })
    )));
    if (!linked) return { ok: false, code: "space_not_found" };
    if (linked.outcome === "linked") {
      this.publishSpaceSnapshot();
      await this.afterParentWrite();
    }
    return { ok: true, outcome: linked.outcome, spaceId: linked.spaceId };
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
   * Create a typed durable table, or answer with the standing table's id so
   * the service can decide whether the caller reopened it or collided with it.
   */
  async createMemoryTable(
    input: WorkspaceMemoryTableCreateRequest,
  ): Promise<WorkspaceMemoryTableCreateResult> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceMemoryTableCreateRequestSchema, input, "create_memory_table");
    this.assertWorkspace(request.workspaceId);
    return createWorkspaceMemoryTable(this.state.storage, request);
  }

  /** Record the create receipt for an idempotent reopen of a standing table. */
  async recordMemoryTableOpenReceipt(
    input: WorkspaceMemoryTableOpenReceiptRequest,
  ): Promise<void> {
    await this.initialized;
    const request = parseRpcInput(WorkspaceMemoryTableOpenReceiptRequestSchema, input, "record_memory_table_open_receipt");
    this.assertWorkspace(request.workspaceId);
    recordWorkspaceMemoryTableOpenReceipt(this.state.storage, request);
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

  /** A person's digest configuration, minus the connector-joined delivery targets. */
  async digestSettings(input: WorkspaceDigestSettingsRequest): Promise<WorkspaceDigestSettings> {
    await this.initialized;
    const request = WorkspaceDigestSettingsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceDigestSettings(this.state.storage, request);
  }

  /**
   * Replace a person's digest wholesale, in one transaction.
   *
   * The create-or-update decision lives inside it: as a read through the
   * runtime facade followed by a batch, two first saves both read "nothing
   * yet" and `UNIQUE (workspace_id, user_id)` refused whichever landed second.
   */
  async replaceDigestSchedule(
    input: WorkspaceDigestReplaceRequest,
  ): Promise<WorkspaceDigestReplaceResult> {
    await this.initialized;
    const request = WorkspaceDigestReplaceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = replaceWorkspaceDigestSchedule(this.state.storage, request);
    this.refreshScheduleAfterDigestWrite(request.workspaceId);
    return result;
  }

  /** The reconciler's default: created on absence, otherwise what already exists. */
  async ensureDefaultDigestSchedule(
    input: WorkspaceDigestDefaultRequest,
  ): Promise<WorkspaceDigestDefaultResult> {
    await this.initialized;
    const request = WorkspaceDigestDefaultRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return ensureDefaultWorkspaceDigestSchedule(this.state.storage, request);
  }

  /** How a digest's derived rows stand against the account timezone. */
  async digestScheduleRowState(
    input: WorkspaceDigestRowStateRequest,
  ): Promise<WorkspaceDigestRowState> {
    await this.initialized;
    const request = WorkspaceDigestRowStateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceDigestScheduleRowState(this.state.storage, request);
  }

  /** Rebuild one digest's derived `schedules` rows — a timezone move, or a repair. */
  async replaceDigestScheduleRows(input: WorkspaceDigestReplaceRowsRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceDigestReplaceRowsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    replaceWorkspaceDigestScheduleRows(this.state.storage, request);
    this.refreshScheduleAfterDigestWrite(request.workspaceId);
  }

  /** What the scheduler must re-validate before firing an occurrence. */
  async digestScheduleForFire(
    input: WorkspaceDigestFireScheduleRequest,
  ): Promise<WorkspaceDigestFireSchedule> {
    await this.initialized;
    const request = WorkspaceDigestFireScheduleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceDigestScheduleForFire(this.state.storage, request);
  }

  /** Claim one occurrence; a retried alarm learns the first attempt already has it. */
  async claimDigestDelivery(
    input: WorkspaceDigestClaimRequest,
  ): Promise<WorkspaceDigestClaimResult> {
    await this.initialized;
    const request = WorkspaceDigestClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return claimWorkspaceDigestDelivery(this.state.storage, request);
  }

  /** One occurrence, as settlement and the run's trigger context read it. */
  async digestDeliveryContext(
    input: WorkspaceDigestDeliveryContextRequest,
  ): Promise<WorkspaceDigestDeliveryContext> {
    await this.initialized;
    const request = WorkspaceDigestDeliveryContextRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceDigestDeliveryContext(this.state.storage, request);
  }


  /**
   * Settle one occurrence, exactly once.
   *
   * The witness is the point: two settlement attempts of one retried workflow
   * step can overlap, and the loser must learn it lost rather than emit the
   * terminal telemetry and the delivery note a second time.
   */
  async settleDigestDelivery(
    input: WorkspaceDigestSettleRequest,
  ): Promise<WorkspaceDigestSettleResult> {
    await this.initialized;
    const request = WorkspaceDigestSettleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return settleWorkspaceDigestDelivery(this.state.storage, request);
  }

  /** What the terminal telemetry event says about destinations and history. */
  async digestTerminalTelemetryContext(
    input: WorkspaceDigestTerminalContextRequest,
  ): Promise<WorkspaceDigestTerminalContext> {
    await this.initialized;
    const request = WorkspaceDigestTerminalContextRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceDigestTerminalContext(this.state.storage, request);
  }

  /** The frozen destinations one occurrence goes to. */
  async digestDeliveryTargets(
    input: WorkspaceDigestDeliveryTargetsRequest,
  ): Promise<WorkspaceDigestDeliveryTargets> {
    await this.initialized;
    const request = WorkspaceDigestDeliveryTargetsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceDigestDeliveryTargets(this.state.storage, request);
  }

  /** One destination received this digest. */
  async markDigestTargetDelivered(
    input: WorkspaceDigestTargetDeliveredRequest,
  ): Promise<WorkspaceDigestTargetOutcomeResult> {
    await this.initialized;
    const request = WorkspaceDigestTargetDeliveredRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return markWorkspaceDigestTargetDelivered(this.state.storage, request);
  }

  /** Record why a destination did not receive this digest. */
  async markDigestTargetFailed(
    input: WorkspaceDigestTargetFailedRequest,
  ): Promise<WorkspaceDigestTargetOutcomeResult> {
    await this.initialized;
    const request = WorkspaceDigestTargetFailedRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return markWorkspaceDigestTargetFailed(this.state.storage, request);
  }

  /**
   * The alarm backstop the generic SQL path gives every `schedules` write.
   *
   * `executeRuntimeSql` re-arms the alarm whenever a routed statement mutates
   * an alarm-source table, because a generic writer has no request to hang the
   * reconcile off. The typed digest writers above would otherwise lose that
   * net: their callers all refresh explicitly today, but a future caller that
   * forgets would leave a schedule row dark until an unrelated wake.
   */
  private refreshScheduleAfterDigestWrite(workspaceId: string): void {
    this.state.waitUntil(this.refreshScheduleKinds(workspaceId, ["schedule"]).catch((error: unknown) => {
      logWarn(this.env, "workspace_schedule_auto_refresh_failed", {
        workspace_id: workspaceId,
        code: error instanceof Error ? error.message : "unknown_error",
      });
    }));
  }

  async canReadWorkstream(input: WorkspaceDirectoryVisibilityRequest): Promise<boolean> {
    await this.initialized;
    const request = WorkspaceDirectoryVisibilityRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.directoryVisible(member(request.userId), request.workstreamId);
  }

  /** Search includes archived and system conversations; final parent checks remain authoritative. */
  async searchableWorkstreamIds(input: { workspaceId: string; userId: string }) {
    await this.initialized;
    const request = z.strictObject({ workspaceId: z.string().uuid(), userId: z.string().uuid() }).parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT directory.workstream_id FROM channels directory
       LEFT JOIN channel_viewers viewer
         ON viewer.workstream_id = directory.workstream_id AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE ${this.channelListedFor("member")}
       ORDER BY directory.workstream_id`, request.userId,
    ).toArray();
    return WorkspaceDirectorySearchableIdsResultSchema.parse({ items: rows.map((row) => row.workstream_id) });
  }

  async readableWorkstreamIds(
    input: WorkspaceDirectoryReadableIdsRequest,
  ): Promise<WorkspaceDirectoryReadableIdsResult> {
    await this.initialized;
    const request = WorkspaceDirectoryReadableIdsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT directory.workstream_id FROM channels directory
       LEFT JOIN channel_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE directory.workstream_id IN (SELECT value FROM json_each(?))
         AND ${mainOpenableSql("directory", "viewer", "member")}
       ORDER BY directory.workstream_id`,
      request.userId,
      JSON.stringify(request.workstreamIds),
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
      `SELECT directory.workstream_id FROM channels directory
       LEFT JOIN channel_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE directory.archived_at IS NULL
         AND (? = 1 OR directory.system_kind IS NULL)
         AND ((? = 0 AND ${organizationWideSql("directory.scope", "member")})
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

  async pinWorkstream(input: WorkspaceDirectoryPinRequest): Promise<{ items: Workstream[] }> {
    await this.initialized;
    const request = WorkspaceDirectoryPinRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!this.directoryVisible(member(request.userId), request.workstreamId)
      || !this.spaceStorage().channelSpaceIds(member(request.userId), request.workstreamId).includes(request.spaceId)) {
      throw new Error("workstream_not_found");
    }
    const now = Date.now();
    const pinStorage = new WorkspacePinStorage(this.state.storage);
    const changed = this.state.storage.transactionSync(() => {
      const alreadyPinned = this.state.storage.sql.exec<{ one: number }>(
        `SELECT 1 AS one FROM workspace_workstream_pins
          WHERE user_id = ? AND space_id = ? AND workstream_id = ?`,
        request.userId,
        request.spaceId,
        request.workstreamId,
      ).toArray().length === 1;
      if (!alreadyPinned) {
        const count = this.state.storage.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM workspace_workstream_pins WHERE user_id = ?`,
          request.userId,
        ).one().count;
        if (count >= MAX_WORKSTREAM_PIN_PLACEMENTS_PER_USER) throw new Error("workstream_pin_limit_reached");
      }
      const inserted = this.state.storage.sql.exec<{ workstream_id: string }>(
        `INSERT OR IGNORE INTO workspace_workstream_pins
           (user_id, space_id, workstream_id, position, created_at, updated_at)
         VALUES (?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM workspace_workstream_pins
                                     WHERE user_id = ? AND space_id = ?), 0), ?, ?)
         RETURNING workstream_id`,
        request.userId,
        request.spaceId,
        request.workstreamId,
        request.userId,
        request.spaceId,
        now,
        now,
      ).toArray().length === 1;
      // Mirrored into the one pin table the new client reads, so a pin made on
      // an older desktop shows there too; see workspace-pin-storage.ts.
      if (inserted && pinStorage.ready()) pinStorage.pin(request.userId, "thread", request.workstreamId, null, now);
      if (inserted) this.advanceDirectoryVersion(now);
      return inserted;
    });
    if (changed) await this.publishDirectorySync(request.workspaceId);
    return { items: mapDirectoryWorkstreams(
      this.state.storage.sql,
      this.pinnedDirectoryRows(member(request.userId), true, request.spaceId),
      request.workspaceId,
      this.spaceStorage(),
      member(request.userId),
    ) };
  }

  async unpinWorkstream(input: WorkspaceDirectoryPinRequest): Promise<{ items: Workstream[] }> {
    await this.initialized;
    const request = WorkspaceDirectoryPinRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const now = Date.now();
    const changed = this.state.storage.transactionSync(() => {
      const removed = this.state.storage.sql.exec<{ workstream_id: string }>(
        `DELETE FROM workspace_workstream_pins
          WHERE user_id = ? AND space_id = ? AND workstream_id = ? RETURNING workstream_id`,
        request.userId,
        request.spaceId,
        request.workstreamId,
      ).toArray().length === 1;
      if (removed) {
        this.rewritePinOrder(request.userId, request.spaceId, [], now);
        // The thread stays pinned while any Space still pins it, as it did
        // under All; see workspace-pin-storage.ts.
        const stillPinned = this.state.storage.sql.exec(
          `SELECT 1 FROM workspace_workstream_pins WHERE user_id = ? AND workstream_id = ?`,
          request.userId,
          request.workstreamId,
        ).toArray().length > 0;
        const pinStorage = new WorkspacePinStorage(this.state.storage);
        if (!stillPinned && pinStorage.ready()) pinStorage.unpin(request.userId, "thread", request.workstreamId);
        this.advanceDirectoryVersion(now);
      }
      return removed;
    });
    if (changed) await this.publishDirectorySync(request.workspaceId);
    return { items: mapDirectoryWorkstreams(
      this.state.storage.sql,
      this.pinnedDirectoryRows(member(request.userId), true, request.spaceId),
      request.workspaceId,
      this.spaceStorage(),
      member(request.userId),
    ) };
  }

  async reorderWorkstreamPins(
    input: WorkspaceDirectoryReorderPinsRequest,
  ): Promise<{ items: Workstream[] }> {
    await this.initialized;
    const request = WorkspaceDirectoryReorderPinsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const now = Date.now();
    this.state.storage.transactionSync(() => {
      this.rewritePinOrder(request.userId, request.spaceId, request.workstreamIds, now);
      this.advanceDirectoryVersion(now);
    });
    await this.publishDirectorySync(request.workspaceId);
    return { items: mapDirectoryWorkstreams(
      this.state.storage.sql,
      this.pinnedDirectoryRows(member(request.userId), true, request.spaceId),
      request.workspaceId,
      this.spaceStorage(),
      member(request.userId),
    ) };
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
         FROM channels directory
         JOIN channel_viewers viewer
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
       JOIN channels directory
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
    const rows = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.workstream_id IN (SELECT value FROM json_each(?))
       ORDER BY directory.last_activity_at DESC, directory.workstream_id`,
      "",
      "",
      JSON.stringify(request.workstreamIds),
    ).toArray();
    return WorkspaceDirectoryLookupResultSchema.parse({
      items: rows.map(internalDirectoryItem),
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
    const row = target.kind === "channel"
      ? sql.exec<{ title: string }>(`SELECT title FROM channels WHERE workstream_id = ?`, target.workstreamId).toArray()[0]
      : target.kind === "breakout"
        ? sql.exec<{ title: string }>(
          `SELECT title FROM breakouts WHERE workstream_id = ? AND substream_id = ?`,
          target.workstreamId, target.substreamId,
        ).toArray()[0]
        : target.kind === "space"
          // A Personal Channel is its owner's alone, so a link to it names
          // nothing: its owner may have renamed it.
          ? sql.exec<{ title: string }>(
            `SELECT title FROM spaces WHERE space_id = ? AND scope <> 'individual'`,
            target.spaceId,
          ).toArray()[0]
          : sql.exec<{ title: string }>(
            `SELECT title FROM automation_directory WHERE automation_id = ? AND lifecycle <> 'deleted'`,
            target.sidekickId,
          ).toArray()[0];
    return { title: row?.title.trim() || null };
  }

  /**
   * The name, mark and creator of one unarchived Channel or Breakout, for an
   * access request. Asks nothing of the viewer: the caller has already proved
   * an active member and holds the id, and this names only what a Channel
   * reached through a Breakout already names (`docs/channel-access-requests.md`).
   */
  async accessRequestSubject(input: { workspaceId: string; parentId: string; substreamId: string }): Promise<{
    kind: "channel" | "breakout";
    title: string;
    appearance: z.infer<typeof WorkstreamAppearanceSchema> | null;
    markId: string;
    createdByUserId: string | null;
  } | null> {
    await this.initialized;
    const request = parseRpcInput(AccessRequestSubjectRequestSchema, input, "access_request_subject");
    this.assertWorkspace(request.workspaceId);
    const breakout = request.substreamId !== "0";
    const row = this.state.storage.sql.exec<{
      title: string; appearance_json: string | null; created_by_user_id: string | null; parent_appearance_json?: string | null;
    }>(
      breakout
        ? `SELECT breakout.title, breakout.appearance_json, breakout.created_by_user_id,
              parent.appearance_json AS parent_appearance_json
             FROM breakouts breakout JOIN channels parent ON parent.workstream_id = breakout.workstream_id
            WHERE breakout.workstream_id = ? AND breakout.substream_id = ?
              AND breakout.archived_at IS NULL AND parent.archived_at IS NULL`
        : `SELECT title, appearance_json, created_by_user_id FROM channels
            WHERE workstream_id = ? AND archived_at IS NULL`,
      ...(breakout ? [request.parentId, request.substreamId] : [request.parentId]),
    ).toArray()[0];
    if (!row) return null;
    return AccessRequestSubjectSchema.parse({
      kind: breakout ? "breakout" : "channel",
      title: row.title,
      ...conversationMark({
        parentId: request.parentId, substreamId: request.substreamId,
        appearanceJson: row.appearance_json, parentAppearanceJson: row.parent_appearance_json ?? null,
      }),
      createdByUserId: row.created_by_user_id,
    });
  }

  private accessRequestStorage(): ConversationAccessRequestStorage {
    return new ConversationAccessRequestStorage(this.state.storage.sql);
  }

  /** Record a request, or return the one already pending; the approver's sockets get their new list. */
  async recordConversationAccessRequest(input: {
    workspaceId: string; parentId: string; substreamId: string; requesterUserId: string;
    requesterName: string; approverUserId: string;
  }): Promise<{ request: StoredAccessRequest; created: boolean }> {
    await this.initialized;
    const request = parseRpcInput(RecordAccessRequestSchema, input, "record_conversation_access_request");
    this.assertWorkspace(request.workspaceId);
    const recorded = this.accessRequestStorage().record({ ...request, id: uuidV7(), now: Date.now() });
    if (recorded.created) this.publishAccessRequests(request.approverUserId);
    return recorded;
  }

  async conversationAccessRequest(input: { workspaceId: string; id: string }): Promise<StoredAccessRequest | null> {
    await this.initialized;
    const request = parseRpcInput(AccessRequestRefSchema, input, "conversation_access_request");
    this.assertWorkspace(request.workspaceId);
    return this.accessRequestStorage().get(request.id);
  }

  /** Settle a pending request; null when it was already settled. The approver's sockets get their new list. */
  async resolveConversationAccessRequest(input: {
    workspaceId: string; id: string; status: "approved" | "declined";
  }): Promise<StoredAccessRequest | null> {
    await this.initialized;
    const request = parseRpcInput(ResolveAccessRequestSchema, input, "resolve_conversation_access_request");
    this.assertWorkspace(request.workspaceId);
    const resolved = this.accessRequestStorage().resolve(request.id, request.status, Date.now());
    if (resolved) this.publishAccessRequests(resolved.approverUserId);
    return resolved;
  }

  /** The approver's email for this request went out. */
  async markConversationAccessRequestEmailed(input: { workspaceId: string; id: string }): Promise<void> {
    await this.initialized;
    const request = parseRpcInput(AccessRequestRefSchema, input, "mark_conversation_access_request_emailed");
    this.assertWorkspace(request.workspaceId);
    this.accessRequestStorage().markEmailed(request.id, Date.now());
  }

  /** An approval whose grant failed goes back to pending; the approver's sockets get it back. */
  async reopenConversationAccessRequest(input: { workspaceId: string; id: string }): Promise<StoredAccessRequest | null> {
    await this.initialized;
    const request = parseRpcInput(AccessRequestRefSchema, input, "reopen_conversation_access_request");
    this.assertWorkspace(request.workspaceId);
    const reopened = this.accessRequestStorage().reopen(request.id);
    if (reopened) this.publishAccessRequests(reopened.approverUserId);
    return reopened;
  }

  /**
   * The approver's whole pending list, to their sockets only. Outside the
   * waterline: the subscribe answer carries it again on every connect.
   */
  private publishAccessRequests(approverUserId: string): void {
    let payload: string | null = null;
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed || attachment.userId !== approverUserId) continue;
      payload ??= JSON.stringify(WorkspaceAccessRequestsEventSchema.parse({
        type: "workspace_access_requests",
        requests: this.accessRequestStorage().pendingFor(approverUserId, this.spaceStorage().breakoutsReady()),
      }));
      try {
        socket.send(payload);
      } catch {
        // Hibernation owns cleanup; a reconnecting client is sent the list again.
      }
    }
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
      `SELECT workstream_id FROM channels
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
         FROM channels
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
      is_participant: number;
    }>(
      `SELECT directory.workstream_id, directory.scope, directory.created_by_user_id,
              COALESCE(viewer.is_participant, 0) AS is_participant
         FROM workspace_workstream_resource_links link
         JOIN channels directory
           ON directory.workstream_id = link.workstream_id
         LEFT JOIN channel_viewers viewer
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
        isParticipant: row.is_participant === 1,
      })),
    });
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
      if (resource.kind === 'conversation') this.state.storage.sql.exec(`INSERT OR IGNORE INTO search_authorization_dependencies
        SELECT owning_workstream_id, ? FROM automation_directory WHERE automation_id = ? AND owning_workstream_id IS NOT NULL`, key, resource.parentId);
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
        UNION SELECT k.cache_key FROM authorization_locations l JOIN search_authorization_keys k ON k.resource_id = l.resource_id WHERE l.parent_id = ?
        UNION SELECT k.cache_key FROM automation_directory a JOIN search_authorization_keys k ON k.parent_id = a.automation_id WHERE a.owning_workstream_id = ?
        UNION SELECT k.cache_key FROM automation_directory a JOIN authorization_locations l ON l.parent_id = a.automation_id
          JOIN search_authorization_keys k ON k.resource_id = l.resource_id WHERE a.owning_workstream_id = ?`;
      bindings = Array.from({ length: 5 }, () => target.id);
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
   * Everything is read from this object's own tables. A conversation is
   * decided by its parent's own `readableSubstreams`, the rule its canonical
   * reads apply; a Sidekick and a connection by the predicates canonical
   * authorization shares (`sidekickAdmitsMember`, `owningChannelAdmitsMember`,
   * `connectionAdmits`). Two narrowings are search's own, from the PRD: a guest
   * never holds a workspace connection, and reaches a Channel-owned Sidekick
   * only through management access on that Channel. Archived Channels and
   * Spaces are skipped: member search never returns an archived row. A person
   * who is not an active member of the Organization holds no groups.
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
    const parents = new Map<string, HostedParent>();
    const parent = async (parentId: string) => {
      const known = parents.get(parentId);
      if (known) return known;
      const loaded = await this.hostedParent(parentId);
      parents.set(parentId, loaded);
      return loaded;
    };
    // An Organization held below the parent schema (meeting-notes retirement)
    // hosts no parents yet, so it has no conversations or Channel-owned Sidekicks to read.
    const hosted = this.hostedParentSchemaPresent();
    if (hosted) {
      for (const { parent_id: parentId } of sql.exec<{ parent_id: string }>(
        `SELECT m.parent_id FROM parent_metadata m
           LEFT JOIN channels c ON c.workstream_id = m.parent_id
           LEFT JOIN spaces s ON s.space_id = m.parent_id
          WHERE c.archived_at IS NULL AND s.archived_at IS NULL`).toArray()) {
        for (const substreamId of (await parent(parentId)).readableSubstreams(request.userId, relationship)) {
          groups.push(searchAudienceGroup.conversation(parentId, substreamId));
        }
      }
    }
    for (const sidekick of sql.exec<{
      automation_id: string; scope: string; author_user_id: string; run_as_user_id: string | null;
      owning_workstream_id: string | null; owning_substream_id: string;
    }>(`SELECT automation_id, scope, author_user_id, run_as_user_id, owning_workstream_id, owning_substream_id
          FROM automation_directory WHERE lifecycle <> 'deleted'`).toArray()) {
      // A guest reads a Sidekick only through management access on the Channel
      // that owns it; a member through its scope, authorship, execution, or
      // participation in that Channel while it is not archived. A Breakout home
      // narrows both to whoever reads that Breakout, as viewer admission does.
      let readable = member && sidekickAdmitsMember({ scope: sidekick.scope,
        author: sidekick.author_user_id === request.userId, executor: sidekick.run_as_user_id === request.userId });
      if (!readable && hosted && sidekick.scope === "workstream" && sidekick.owning_workstream_id) {
        const owner = await parent(sidekick.owning_workstream_id);
        const metadata = owner.metadataRow();
        const home = sidekick.owning_substream_id;
        readable = metadata !== null && (home !== "0"
          ? metadata.archived_at === null && owner.readableSubstreams(request.userId, relationship).includes(asSubstreamId(home))
          : member
          ? owningChannelAdmitsMember({ archived: metadata.archived_at !== null, participant: owner.isParticipant(request.userId) })
          : owner.managementAccess({ workspaceId: request.workspaceId, parentId: sidekick.owning_workstream_id,
            userId: request.userId }, relationship).allowed);
      }
      if (readable) groups.push(searchAudienceGroup.sidekick(sidekick.automation_id));
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
    // Each unarchived Channel this person reads, in one listing query, for
    // the resources merges shared with it. A Channel with none costs only a
    // group that matches no row.
    for (const spaceId of this.spaceStorage().visibleSpaceIds({ userId: request.userId, accessClass: relationship.accessClass })) {
      groups.push(searchAudienceGroup.space(spaceId));
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
      `SELECT user_id FROM workspace_members WHERE workspace_id = ? AND status = 'active'`,
    ).bind(request.workspaceId).all<{ user_id: string }>();
    return enumerateSearchAuthorizationUniverse(this.state.storage.sql, request.workspaceId,
      members.results.map((row) => row.user_id), request.target);
  }

  async authorizationResourceFacts(input: {
    workspaceId: string; userId: string; resourceIds: string[];
    /** The reader's access class, which decides the Channels they read. */
    accessClass: "member" | "guest";
  }) {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema, userId: UserIdSchema, resourceIds: z.array(IdSchema),
      accessClass: z.enum(["member", "guest"]),
    }).parse(input);
    const reader = { userId: request.userId, accessClass: request.accessClass };
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
      // A Channel a merge shared this with admits whoever reads that Channel
      // today, decided here because this object owns the Channel.
      const sharedThrough = placed.find((location) => location.parentKind === "space"
        && this.spaceStorage().reach(reader, location.parentId) !== null)?.parentId ?? null;
      return { resourceId, exists: true as const, validatedAt: Date.now(), revision: row.updated_at, owned, sharedThrough,
        connectionAllowed: !row.connection_id || Boolean(connection && connection.status !== 'disabled'
          && (connection.scope === 'workspace' || connection.owner_user_id === request.userId)),
        noteAllowed: row.provider !== 'avalon_note',
        draftAllowed: !isDraftUpload(row) || owned,
        requiresAttachment: requiresAttachment(row, owned),
        locations: placed.filter((location) => location.parentKind !== "space"), projectionComplete: coverage.complete, discoveryAt,
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
   * Apply one directory effect a Space published.
   *
   * The Channel branch's structure, against the Space tables: the receipt is
   * checked first so a redelivery is a no-op rather than a second application,
   * the row is fenced on generation-then-version, and a second payload claiming
   * one version is a conflict rather than a silent overwrite.
   *
   * What it deliberately does *not* do is everything the Channel branch does
   * besides the row — resource links, attachment reservations, watch
   * reconciliation, terminal schedules. A Space has no feed, its resource
   * defaults live in `space_defaults`, and nothing here is a sidebar row for it.
   */
  private applySpaceDirectoryEnvelope(
    envelope: ParentEffectEnvelope,
    activeUsers: ReadonlySet<string>,
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
      const storage = this.spaceStorage();
      let changed = false;
      if (envelope.effect.kind === "directory_common") {
        const effect = envelope.effect;
        changed = storage.applyDirectoryProjection({
          spaceId: envelope.parentId,
          authorityGeneration: envelope.generation,
          sourceVersion: envelope.sourceVersion,
          payloadHash: envelope.payloadHash,
          title: effect.title,
          scope: effect.scope,
          appearance: effect.appearance
            ? { iconKey: effect.appearance.icon, colorKey: effect.appearance.color }
            : null,
          createdByUserId: effect.createdByUserId ?? null,
          sourceCreatedAt: epoch(effect.createdAt ?? effect.lastActivityAt) ?? now,
          sourceUpdatedAt: epoch(effect.updatedAt ?? effect.lastActivityAt) ?? now,
        }, now);
      } else if (envelope.effect.kind === "directory_user") {
        const effect = envelope.effect;
        changed = storage.applyViewerProjection({
          spaceId: envelope.parentId,
          userId: effect.userId,
          authorityGeneration: envelope.generation,
          sourceVersion: envelope.sourceVersion,
          payloadHash: envelope.payloadHash,
          isParticipant: effect.isParticipant,
        }, activeUsers.has(effect.userId), now);
      }
      insertWorkstreamEffectReceipt(
        this.state.storage,
        envelope.messageId,
        envelope.parentId,
        envelope.payloadHash,
        now,
      );
      return changed;
    });
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
  /** A breakout row's archive time; null when unarchived or when the Organization holds no row for it. */
  private breakoutArchivedAt(workstreamId: string, substreamId: string): number | null {
    return this.state.storage.sql.exec<{ archived_at: number | null }>(
      `SELECT archived_at FROM breakouts WHERE workstream_id = ? AND substream_id = ?`,
      workstreamId, substreamId,
    ).toArray()[0]?.archived_at ?? null;
  }

  private applyBreakoutDirectoryEnvelope(
    envelope: ParentEffectEnvelope,
    activeUsers: ReadonlySet<string>,
  ): { moved: boolean; participationChanged: boolean } {
    return this.state.storage.transactionSync(() => {
      const receipt = this.state.storage.sql.exec<{ payload_hash: string }>(
        `SELECT payload_hash FROM workspace_workstream_effect_receipts WHERE message_id = ?`,
        envelope.messageId,
      ).toArray()[0];
      if (receipt) {
        if (receipt.payload_hash !== envelope.payloadHash) {
          throw new Error("workspace_directory_effect_idempotency_conflict");
        }
        return { moved: false, participationChanged: false };
      }
      const now = Date.now();
      const breakouts = this.breakoutStorage();
      let result = { moved: false, participationChanged: false };
      if (envelope.effect.kind === "directory_common") {
        // Shared: a breakout's title, state and activity reorder or remove the
        // row on every reader's page at once.
        result = { moved: breakouts.applyCommon(envelope, now), participationChanged: false };
      } else if (envelope.effect.kind === "directory_user") {
        // Personal: one person's unread, mention or first open, which only
        // they are nudged about — or their joining or leaving it.
        result = breakouts.applyViewer(envelope, activeUsers.has(envelope.effect.userId), now);
      }
      insertWorkstreamEffectReceipt(
        this.state.storage,
        envelope.messageId,
        envelope.parentId,
        envelope.payloadHash,
        now,
      );
      return result;
    });
  }

  private applyDirectoryEnvelope(
    envelope: ParentEffectEnvelope,
    activeUsers: ReadonlySet<string>,
  ): {
    changed: boolean;
    participantMembershipChanged: boolean;
    archivalChanged: boolean;
    replayed: boolean;
    /**
     * Who may have stopped seeing the Channel: the viewer whose participation
     * moved, or, when the Channel was archived, narrowed or re-generated,
     * everyone who could see it just before (`channelReadersBefore`). Null
     * when nobody could have lost it.
     */
    lost: readonly string[] | null;
  } {
    return this.state.storage.transactionSync(() => {
      const receipt = this.state.storage.sql.exec<{ payload_hash: string }>(
        `SELECT payload_hash FROM workspace_workstream_effect_receipts WHERE message_id = ?`,
        envelope.messageId,
      ).toArray()[0];
      if (receipt) {
        if (receipt.payload_hash !== envelope.payloadHash) {
          throw new Error("workspace_directory_effect_idempotency_conflict");
        }
        return {
          changed: false,
          participantMembershipChanged: false,
          archivalChanged: false,
          replayed: true,
          lost: null,
        };
      }

      const now = Date.now();
      let changed = false;
      let participantMembershipChanged = false;
      let archivalChanged = false;
      let lost: readonly string[] | null = null;
      if (envelope.effect.kind === "directory_common") {
        const current = this.state.storage.sql.exec<StoredProjection & {
          archived_at: number | null;
          scope: string;
        } & Record<string, SqlStorageValue>>(
          `SELECT authority_generation, waterline, payload_hash, archived_at, scope
             FROM channels WHERE workstream_id = ?`,
          envelope.parentId,
        ).toArray()[0];
        if (projectionSupersedes(
          envelope, current, "workspace_directory_projection_version_conflict",
        )) {
          const effect = envelope.effect;
          this.state.storage.sql.exec(
            `INSERT INTO channels
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
            envelope.parentId,
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
            "ad_hoc",
            null,
            effect.createdByUserId ?? null,
            null,
            null,
            null,
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
          this.state.storage.sql.exec(`UPDATE channels SET appearance_json = ? WHERE workstream_id = ?`, effect.appearance ? JSON.stringify(effect.appearance) : null, envelope.parentId);
          // The rail lists Main's links and attachments. Both are compared
          // here rather than watched by a trigger, because every Main effect
          // rewrites them and most say what the last one said.
          if (mainResourceLinksChanged(this.state.storage.sql, envelope.parentId, effect.resourceLinks ?? [])) {
            bumpChannelRail(this.state.storage.sql, envelope.parentId);
          }
          // Absent is an envelope from before the field: nothing reported.
          if (effect.sidekickAttachmentIds !== undefined) {
            applyReportedSidekickAttachments(this.state.storage.sql, envelope.parentId, effect.sidekickAttachmentIds);
          }
          this.state.storage.sql.exec(
            `DELETE FROM workspace_workstream_resource_links WHERE workstream_id = ?`,
            envelope.parentId,
          );
          for (const link of effect.resourceLinks ?? []) {
            this.state.storage.sql.exec(
              `INSERT INTO workspace_workstream_resource_links
                 (workstream_id, resource_id, watch_enabled, relationship_type,
                  authority_generation, waterline, source_event_id, projected_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              envelope.parentId,
              link.resourceId,
              link.watchEnabled ? 1 : 0,
              link.relationshipType,
              envelope.generation,
              envelope.sourceVersion,
              envelope.messageId,
              now,
            );
            // This projection is the first workspace-authoritative proof that
            // the resource became canonical. Reservation release below is
            // separately fenced by its exact pending-input identity.
            this.state.storage.sql.exec(
              `UPDATE resources
                  SET attachment_status = 'attached', updated_at = ?
                WHERE workspace_id = ? AND id = ?
                  AND provider = 'avalon_upload' AND attachment_status = 'draft'`,
              new Date(now).toISOString(),
              envelope.workspaceId,
              link.resourceId,
            );
          }
          const projectedResourceIds = new Set(
            (effect.resourceLinks ?? []).map((link) => link.resourceId),
          );
          for (const release of effect.attachmentReservationReleases ?? []) {
            if (!projectedResourceIds.has(release.resourceId)) {
              throw new Error("attachment_reservation_release_missing_resource_link");
            }
            this.state.storage.sql.exec(
              `DELETE FROM pending_attachment_reservations
                WHERE workspace_id = ? AND workstream_id = ?
                  AND input_id = ? AND resource_id = ?`,
              envelope.workspaceId,
              envelope.parentId,
              release.inputId,
              release.resourceId,
            );
          }
          changed = true;
          // A project counts the members it can show, so a work stream
          // arriving or leaving the archive changes what its projects say
          // about themselves. Compared rather than assumed: this effect is
          // written on ordinary activity too, and republishing every project
          // to every socket on each of those would cost the sidebar far more
          // than the count is worth.
          archivalChanged = (current?.archived_at ?? null) !== epoch(effect.archivedAt);
          // Who could see the row before this one replaced it and may not now.
          // A viewer row joins its Channel only at the Channel's generation,
          // so a new generation hides a personal Channel from its participants
          // until their rows arrive at it.
          if (current && current.archived_at === null && (
            effect.archivedAt != null
            || (current.scope === "workspace" && effect.scope !== "workspace")
            || current.authority_generation !== envelope.generation
          )) {
            lost = this.channelReadersBefore(
              envelope.parentId, current.authority_generation, current.scope === "workspace",
            );
          }
        }
      } else if (envelope.effect.kind === "directory_user") {
        const effect = envelope.effect;
        const current = this.state.storage.sql.exec<StoredProjection & {
          is_participant: number;
        } & Record<string, SqlStorageValue>>(
          `SELECT authority_generation, waterline, payload_hash, is_participant
             FROM channel_viewers WHERE workstream_id = ? AND user_id = ?`,
          envelope.parentId,
          effect.userId,
        ).toArray()[0];
        if (!activeUsers.has(effect.userId)) {
          const deleted = this.state.storage.sql.exec<{ is_participant: number }>(
            `DELETE FROM channel_viewers
              WHERE workstream_id = ? AND user_id = ? RETURNING is_participant`,
            envelope.parentId,
            effect.userId,
          ).toArray()[0];
          changed = deleted !== undefined;
          participantMembershipChanged = deleted?.is_participant === 1;
        } else {
          if (projectionSupersedes(
            envelope, current, "workspace_directory_viewer_version_conflict",
          )) {
            const wasParticipant = current?.is_participant === 1;
            this.state.storage.sql.exec(
              `INSERT INTO channel_viewers
                 (workstream_id, user_id, authority_generation, waterline,
                  source_event_id, payload_hash, is_participant, participant_added_at,
                  unread_count, you_are_mentioned,
                  unseen, listable, seen_attention_ordinal, manual_unread_from_ordinal,
                  manual_unread_generation, latest_mention_attention_ordinal,
                  projected_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(workstream_id, user_id) DO UPDATE SET
                 authority_generation = excluded.authority_generation,
                 waterline = excluded.waterline,
                 source_event_id = excluded.source_event_id,
                 payload_hash = excluded.payload_hash,
                 is_participant = excluded.is_participant,
                 participant_added_at = CASE
                   WHEN excluded.is_participant = 0 THEN NULL
                   ELSE COALESCE(
                     excluded.participant_added_at,
                     channel_viewers.participant_added_at
                   )
                 END,
                 unread_count = excluded.unread_count,
                 you_are_mentioned = excluded.you_are_mentioned,
                 unseen = excluded.unseen,
                 listable = excluded.listable,
                 seen_attention_ordinal = excluded.seen_attention_ordinal,
                 manual_unread_from_ordinal = excluded.manual_unread_from_ordinal,
                 manual_unread_generation = excluded.manual_unread_generation,
                 latest_mention_attention_ordinal = excluded.latest_mention_attention_ordinal,
                 projected_at = excluded.projected_at`,
              envelope.parentId,
              effect.userId,
              envelope.generation,
              envelope.sourceVersion,
              envelope.messageId,
              envelope.payloadHash,
              effect.isParticipant ? 1 : 0,
              effect.isParticipant ? epoch(effect.participantAddedAt) : null,
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
            participantMembershipChanged = wasParticipant !== effect.isParticipant;
          }
        }
      }

      insertWorkstreamEffectReceipt(
        this.state.storage,
        envelope.messageId,
        envelope.parentId,
        envelope.payloadHash,
        now,
      );
      if (changed) this.advanceDirectoryVersion(now);
      // Leaving a personal Channel's participants is losing it; joining costs
      // nothing here, since whoever can see the Channel is sent its row.
      if (participantMembershipChanged && envelope.effect.kind === "directory_user") lost = [envelope.effect.userId];
      return { changed, participantMembershipChanged, archivalChanged, replayed: false, lost };
    });
  }

  private listDirectory(
    request: WorkspaceDirectoryListRequest,
    accessClass: "member" | "guest" = "member",
    withViewerState = false,
  ): WorkspaceDirectoryPage {
    const listed = this.channelListedFor(accessClass);
    let cursor = request.before ? directoryCursor(request.before) : null;
    if (cursor) {
      const anchor = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
        `${SELECT_WORKSPACE_DIRECTORY} WHERE directory.workstream_id = ?`,
        request.userId, request.userId, cursor.workstreamId,
      ).toArray()[0];
      // A pre-upgrade activity cursor (or a row visited since paging) no longer
      // describes this order. Restart the walk rather than skip unseen rows.
      if (!anchor || (anchor.last_accessed_at ?? anchor.source_created_at) !== cursor.lastActivityAt) cursor = null;
    }
    const rows = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.archived_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM workspace_workstream_pins pin
            WHERE pin.user_id = ?2 AND pin.workstream_id = directory.workstream_id
         )
         AND directory.exact_state NOT IN ('running', 'interrupting', 'preparing_context',
                                           'waiting_capacity')
         AND (? = 1 OR directory.system_kind IS NULL)
         AND ${listed}
         AND (? IS NULL OR COALESCE(access.last_accessed_at, directory.source_created_at) < ?
              OR (COALESCE(access.last_accessed_at, directory.source_created_at) = ? AND directory.workstream_id > ?))
       ORDER BY COALESCE(access.last_accessed_at, directory.source_created_at) DESC, directory.workstream_id LIMIT ?`,
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
      ? `${last.last_accessed_at ?? last.source_created_at}:${last.workstream_id}`
      : null;
    if (!cursor) {
      const selected = new Set(rows.map((row) => row.workstream_id));
      const supplemental = [
        ...this.pinnedDirectoryRows({ userId: request.userId, accessClass }, request.includeSystem),
        ...this.runningDirectoryRows({ userId: request.userId, accessClass }, request.includeSystem),
      ];
      for (const row of supplemental) {
        if (selected.has(row.workstream_id)) continue;
        selected.add(row.workstream_id);
        rows.push(row);
      }
    }
    return {
      items: mapDirectoryWorkstreams(
        this.state.storage.sql, rows, request.workspaceId, this.spaceStorage(),
        { userId: request.userId, accessClass }, withViewerState,
      ),
      stateVersions: rows.map(directoryStateVersion),
      nextCursor,
      directoryWaterline: this.directoryWaterline(),
    };
  }

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

  private listSidebarAutomations(workspaceId: string, userId: string, limit = SIDEBAR_LIST_LIMIT): AutomationSummary[] {
    return this.state.storage.sql.exec<AutomationDirectoryRow>(
      `SELECT automation_id, loadable, appearance_json, lifecycle, scope, owning_workstream_id, title,
              description, next_run_at, projected_at
         FROM automation_directory
        WHERE workspace_id = ? AND lifecycle <> 'deleted'
          AND owning_workstream_id IS NULL
          AND (scope = 'workspace' OR author_user_id = ?)
        ORDER BY title COLLATE NOCASE, automation_id
        LIMIT ?`,
      workspaceId,
      userId,
      limit,
    ).toArray().map((row) => automationSummary(row, this.invalidAppearanceReporter(workspaceId)));
  }

  private pinnedDirectoryRows(viewer: Viewer, includeSystem: boolean, spaceId?: string): WorkspaceDirectoryRow[] {
    return this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.archived_at IS NULL
         AND EXISTS (
           SELECT 1 FROM workspace_workstream_pins pin
            WHERE pin.user_id = ?2 AND pin.workstream_id = directory.workstream_id
              AND (?3 IS NULL OR pin.space_id = ?3)
         )
         AND (? = 1 OR directory.system_kind IS NULL)
         -- A pin is kept through a change of relationship, so a pinned Channel
         -- is listed by this viewer's rule as it is now, not when it was pinned.
         AND ${this.channelListedFor(viewer.accessClass)}
       ORDER BY (
         SELECT MIN(pin.position) FROM workspace_workstream_pins pin
          WHERE pin.user_id = ?2 AND pin.workstream_id = directory.workstream_id
            AND (?3 IS NULL OR pin.space_id = ?3)
       ), directory.workstream_id`,
      viewer.userId,
      viewer.userId,
      spaceId ?? null,
      includeSystem ? 1 : 0,
    ).toArray();
  }

  /**
   * Running work streams are connection targets, not merely directory rows.
   * Return every visible one with the first page so an old active stream is
   * not hidden behind the recent-work cursor and omitted from socket prewarm.
   */
  private runningDirectoryRows(viewer: Viewer, includeSystem: boolean): WorkspaceDirectoryRow[] {
    return this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.archived_at IS NULL
         AND directory.exact_state IN ('running', 'interrupting', 'preparing_context',
                                       'waiting_capacity')
         AND (? = 1 OR directory.system_kind IS NULL)
         AND ${this.channelListedFor(viewer.accessClass)}
       ORDER BY directory.last_activity_at DESC, directory.workstream_id`,
      viewer.userId,
      viewer.userId,
      includeSystem ? 1 : 0,
    ).toArray();
  }

  /**
   * The Channel listing rule against `directory`/`viewer` in a statement whose
   * first parameter is the viewer's user id, as every directory read here is.
   */
  private channelListedFor(accessClass: AccessClass): string {
    return channelListedSql("directory", "viewer", accessClass, {
      breakouts: this.spaceStorage().breakoutsReady(),
      userId: "?1",
    });
  }

  private directoryVisible(viewer: Viewer, workstreamId: string): boolean {
    return this.state.storage.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM channels directory
       LEFT JOIN channel_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE directory.workstream_id = ? AND directory.archived_at IS NULL
         AND ${this.channelListedFor(viewer.accessClass)}`,
      viewer.userId,
      workstreamId,
    ).toArray().length === 1;
  }

  /**
   * Whether this viewer may open a Channel's Main. A Channel's face pile is
   * Main's audience, so presence asks this rather than whether it is listed.
   */
  private mainOpenable(viewer: Viewer, workstreamId: string): boolean {
    return this.state.storage.sql.exec<{ one: number }>(
      `SELECT 1 AS one FROM channels directory
       LEFT JOIN channel_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE directory.workstream_id = ? AND directory.archived_at IS NULL
         AND ${mainOpenableSql("directory", "viewer", viewer.accessClass)}`,
      viewer.userId,
      workstreamId,
    ).toArray().length === 1;
  }

  private rewritePinOrder(userId: string, spaceId: string, requestedIds: string[], now: number): void {
    const current = this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT workstream_id FROM workspace_workstream_pins
        WHERE user_id = ? AND space_id = ? ORDER BY position, workstream_id`,
      userId,
      spaceId,
    ).toArray().map((row) => row.workstream_id);
    const pinned = new Set(current);
    const requested = [...new Set(requestedIds)].filter((id) => pinned.has(id));
    const requestedSet = new Set(requested);
    const ordered = [...requested, ...current.filter((id) => !requestedSet.has(id))];
    for (const [position, workstreamId] of ordered.entries()) {
      this.state.storage.sql.exec(
        `UPDATE workspace_workstream_pins SET position = ?, updated_at = ?
          WHERE user_id = ? AND space_id = ? AND workstream_id = ?`,
        position,
        now,
        userId,
        spaceId,
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

  /**
   * Owe every Channel whose rail moved since the last drain its row, to all
   * of its readers: the row carries the new `railWaterline`, which is how a
   * client holding the rail learns to ask for it again. The ledger is emptied
   * in the same call, so a drain that never reaches a socket is not retried:
   * rows are best effort, and a reconnect reads the current waterline.
   */
  private collectRailChanges(rows: ChannelRowPlan): ChannelRowPlan {
    if (!this.railLedger) return rows;
    for (const workstreamId of drainChannelRailChanges(this.state.storage.sql)) rows.readers(workstreamId);
    for (const workstreamId of this.railRowsHeld) rows.readers(workstreamId);
    this.railRowsHeld.clear();
    return rows;
  }

  /** Send one Channel's current row to everybody who can see it now. */
  private publishChannelRowToReaders(workstreamId: string): void {
    const plan = new ChannelRowPlan();
    plan.readers(workstreamId);
    this.publishChannelRows(plan);
  }

  /**
   * Send each planned Channel's current row to the people it is owed to
   * (`ChannelRowAudience`), built once per person and sent to every socket
   * they hold. Missed intermediate rows are intentionally irrelevant: a row is
   * the Channel as it stands, and a reconnect reloads the sidebar.
   *
   * Who can see a Channel is decided from two reads for every planned Channel
   * together, so a person who cannot see it costs nothing; each person owed a
   * row then costs one set of reads for all of their Channels, not one per
   * socket per Channel.
   *
   * Never throws. Every caller has already committed the change the rows
   * describe, and a row is best effort: a person whose row cannot be built is
   * logged with the reason and skipped, and everybody else is still sent
   * theirs.
   */
  private publishChannelRows(plan: ChannelRowPlan): void {
    if (plan.channels.size === 0) return;
    try {
      this.sendChannelRows(plan);
    } catch (error) {
      logWarn(this.env, "channel_rows_publish_failed", {
        workspace_id: this.workspaceId(),
        code: diagnosticErrorCode(error, "channel_rows_publish_failed"),
      });
    }
  }

  private sendChannelRows(plan: ChannelRowPlan): void {
    // No authorization re-check on the way out: an open socket is closed by
    // the access-revocation queue, never by a publisher asking again
    // (`docs/access-revocation.md`). The relationship a socket was admitted
    // under decides what it may be told (`listing-rules.ts`), so two sockets
    // of one person under different relationships are two readers.
    const people = new Map<string, WorkspaceChannelRowReader>();
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      const accessClass = attachment.accessClass ?? "member";
      const key = `${attachment.userId}:${accessClass}`;
      const person = people.get(key);
      if (person) person.sockets.push(socket);
      else people.set(key, { userId: attachment.userId, workspaceId: attachment.workspaceId, accessClass, sockets: [socket] });
    }
    if (people.size === 0) return;
    const channelIds = [...plan.channels.keys()];
    const channels = new Map(this.state.storage.sql.exec<{ workstream_id: string; scope: string; archived_at: number | null }>(
      `SELECT workstream_id, scope, archived_at FROM channels
        WHERE workstream_id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(channelIds),
    ).toArray().map((row) => [row.workstream_id, row]));
    // The two facts the Channel rule composes, read once for every planned
    // Channel: who takes part in Main (at the Channel's own generation, as the
    // directory's join has it), and who opens a Breakout in it.
    const participants = this.peopleByChannel(
      `SELECT viewer.workstream_id, viewer.user_id FROM channel_viewers viewer
         JOIN channels directory
           ON directory.workstream_id = viewer.workstream_id
          AND directory.authority_generation = viewer.authority_generation
        WHERE viewer.workstream_id IN (SELECT value FROM json_each(?))
          AND viewer.is_participant = 1 AND directory.archived_at IS NULL`,
      channelIds,
    );
    const breakoutReach = this.spaceStorage().breakoutsReady()
      ? this.peopleByChannel(
        `SELECT DISTINCT breakout.workstream_id, breakout_viewer.user_id
           FROM breakouts breakout
           JOIN breakout_viewers breakout_viewer
             ON breakout_viewer.workstream_id = breakout.workstream_id
            AND breakout_viewer.substream_id = breakout.substream_id
            AND breakout_viewer.authority_generation = breakout.authority_generation
          WHERE breakout.workstream_id IN (SELECT value FROM json_each(?))
            AND breakout.archived_at IS NULL AND breakout_viewer.listable = 1`,
        channelIds,
      )
      : new Map<string, Set<string>>();
    const owed = new Map<string, string[]>();
    for (const [workstreamId, audience] of plan.channels) {
      const channel = channels.get(workstreamId);
      if (!channel) continue;
      for (const [key, person] of people) {
        const sees = channel.archived_at === null && channelListed({
          scope: channel.scope,
          accessClass: person.accessClass,
          mainParticipant: participants.get(workstreamId)?.has(person.userId) === true,
          reachedThroughBreakout: breakoutReach.get(workstreamId)?.has(person.userId) === true,
        });
        const lost = audience.lost.has(person.userId);
        if (!lost && !(sees && (audience.readers || audience.users.has(person.userId)))) continue;
        const ids = owed.get(key);
        if (ids) ids.push(workstreamId);
        else owed.set(key, [workstreamId]);
      }
    }
    if (owed.size === 0) return;
    const shared: ChannelRowShared = {
      occurredAt: new Date().toISOString(),
      // Viewer-independent: read once for every person.
      previews: loadParticipantPreviews(this.state.storage.sql, channelIds),
      background: runningBackgroundAgents(this.state.storage.sql, channelIds),
    };
    for (const [key, workstreamIds] of owed) {
      const person = people.get(key)!;
      let payloads: string[];
      try {
        payloads = this.channelRowPayloads(person, workstreamIds, shared);
      } catch (error) {
        logWarn(this.env, "channel_row_publish_failed", {
          workspace_id: person.workspaceId,
          user_id: person.userId,
          code: diagnosticErrorCode(error, "channel_row_publish_failed"),
        });
        continue;
      }
      for (const payload of payloads) {
        for (const socket of person.sockets) {
          try {
            socket.send(payload);
          } catch {
            // Hibernation owns close cleanup; reconnect loads the current page and
            // does not need the state rows missed while this socket was unhealthy.
          }
        }
      }
    }
  }

  /**
   * One person's `workspace_workstream_state` frames for these Channels, from
   * one set of reads for all of them: the row, or `workstream: null` where the
   * person no longer sees it. Per person rather than once: the Spaces a
   * Channel is in are the ones *this* viewer may see (a personal Space's id on
   * somebody else's row is the existence of a private Space leaking through a
   * shared Channel), and the breakouts and agents are theirs.
   */
  /** `workstream_id, user_id` rows for these Channels, grouped by Channel. */
  private peopleByChannel(sql: string, channelIds: readonly string[]): Map<string, Set<string>> {
    const people = new Map<string, Set<string>>();
    for (const row of this.state.storage.sql.exec<{ workstream_id: string; user_id: string }>(
      sql, JSON.stringify(channelIds),
    ).toArray()) {
      const users = people.get(row.workstream_id) ?? new Set<string>();
      users.add(row.user_id);
      people.set(row.workstream_id, users);
    }
    return people;
  }

  private channelRowPayloads(
    person: WorkspaceChannelRowReader,
    workstreamIds: readonly string[],
    shared: ChannelRowShared,
  ): string[] {
    const viewer: Viewer = { userId: person.userId, accessClass: person.accessClass };
    const rows = this.state.storage.sql.exec<WorkspaceDirectoryRow>(
      `${SELECT_WORKSPACE_DIRECTORY}
       WHERE directory.workstream_id IN (SELECT value FROM json_each(?))`,
      person.userId,
      person.userId,
      JSON.stringify(workstreamIds),
    ).toArray();
    const spaces = this.spaceStorage();
    const listed = new Set(spaces.listableChannelIds(viewer, rows
      .filter((row) => row.archived_at === null)
      .map((row) => row.workstream_id)));
    const visibleIds = rows.filter((row) => listed.has(row.workstream_id)).map((row) => row.workstream_id);
    const spaceIds = visibleIds.length === 0
      ? new Map<string, string[]>()
      : spaces.spaceIdsByChannel(viewer, visibleIds);
    const attention = visibleIds.length === 0
      ? new Map<string, number>()
      : spaces.breakoutAttentionCounts(viewer, visibleIds);
    const viewerStates = channelViewerStates(this.state.storage.sql, person.userId, visibleIds, shared.background);
    const shown = new Set(visibleIds);
    return rows.map((row) => {
      const stateVersion = directoryStateVersion(row);
      return JSON.stringify(WorkspaceWorkstreamStateEventSchema.parse({
        type: "workspace_workstream_state",
        occurredAt: shared.occurredAt,
        workstreamId: row.workstream_id,
        stateVersion: {
          commonEventId: stateVersion.commonEventId,
          viewerEventId: stateVersion.viewerEventId,
          authorityGeneration: stateVersion.authorityGeneration,
          commonWaterline: stateVersion.commonWaterline,
          viewerWaterline: stateVersion.viewerWaterline,
        },
        workstream: shown.has(row.workstream_id)
          ? {
            ...directoryWorkstream(
              row, person.workspaceId, shared.previews.get(row.workstream_id),
              spaceIds.get(row.workstream_id) ?? [], [], attention.get(row.workstream_id) ?? 0,
              mainOpenFor(row, person.accessClass),
            ),
            ...(mainOpenFor(row, person.accessClass)
              ? viewerStates.get(row.workstream_id)
              : withoutMainState(viewerStates.get(row.workstream_id))),
          }
          : null,
      }));
    });
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
    const spaces = this.spacesFor(attachment);
    // Nobody is sent Channel rows once the Space hierarchy is whole: each
    // viewer walks the Spaces the listing rules give them for those. Before
    // that, a Channel can sit in no Space, and the page is the only way it
    // reaches the sidebar.
    if (spaces.spacesReady) {
      return WorkspaceSidebarSchema.parse({
        workstreams: { directoryWaterline: this.directoryWaterline(), items: [], stateVersions: [], nextCursor: null },
        automations: {
          waterline: this.sidebarListWaterline("automations"),
          items: this.sidekickLibrary(attachment),
        },
        notes: { waterline: 0, items: [], nextCursor: null },
        ...spaces,
        channelsBySpace: true,
      });
    }
    const workstreams = this.listDirectory({
      workspaceId: attachment.workspaceId,
      userId: attachment.userId,
      limit: SIDEBAR_LIST_LIMIT,
      includeSystem: false,
    }, attachment.accessClass, true);
    return WorkspaceSidebarSchema.parse({
      workstreams,
      automations: {
        waterline: this.sidebarListWaterline("automations"),
        items: this.sidekickLibrary(attachment),
      },
      notes: {
        waterline: 0, items: [], nextCursor: null,
      },
      ...spaces,
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
   * Read once per socket rather than once per workspace because the list is
   * scoped — a personal automation belongs to its owner, and sending
   * one reader's list to another would leak it. This mirrors
   * `channelRowPayloads`, which reads its row per viewer for the same
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

  /**
   * Tell each socket whose reach includes a person that the person's reach
   * moved: they joined or left a Channel or Breakout, or the people they may
   * act as changed.
   *
   * Addressed to the person and to whoever can act as them — the authority the
   * Sideline catalog reads the person's destinations under. It names people and
   * no conversation, so it discloses no membership the receiver could not
   * already list; the receiver rereads its own view. Not on the waterline and
   * never replayed: a client that was away rereads when it subscribes.
   *
   * One relationship read per publish, whatever the number of sockets.
   */
  private publishReachChanged(userIds: ReadonlySet<string>): void {
    if (userIds.size === 0) return;
    const workspaceId = this.workspaceId();
    if (!workspaceId) return;
    const actsFor = new WorkspaceImpersonationStorage(this.state.storage)
      .impersonatorsOf(workspaceId, [...userIds]);
    const occurredAt = new Date().toISOString();
    const payloads = new Map<string, string | null>();
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      let payload = payloads.get(attachment.userId);
      if (payload === undefined) {
        const named = [...new Set([
          ...(userIds.has(attachment.userId) ? [attachment.userId] : []),
          ...(actsFor.get(attachment.userId) ?? []),
        ])];
        payload = named.length === 0 ? null : JSON.stringify(WorkspaceReachChangedEventSchema.parse({
          type: "workspace_reach_changed",
          occurredAt,
          userIds: named,
        }));
        payloads.set(attachment.userId, payload);
      }
      if (payload === null) continue;
      try {
        socket.send(payload);
      } catch {
        // Hibernation owns cleanup; a reconnecting client rereads.
      }
    }
  }

  /**
   * Re-send both Space directories to every subscribed socket, shaped for its
   * user.
   *
   * The mechanism the Project snapshot used, kept because the reasons are
   * unchanged: every Space write shares one waterline, personal-Space
   * visibility and order are per viewer, and sending the complete pair means a
   * participant removal is represented by *absence* for the person removed
   * rather than by an event they have to interpret.
   *
   * `spacesReady` rides along because a Space write can be the write that
   * finishes the cutover — a client holding `false` would otherwise keep
   * showing the Organization-opening state until it reconnected.
   *
   * `onlyUserId` narrows the audience to one person's own sessions, for a write
   * that changed nothing anybody else can see. Everything here is per viewer
   * and costs a `list()` transaction plus a full directory serialization per
   * socket, so a change to one person's view preference published to all of
   * them is that work times the Organization — for a snapshot identical to the
   * one every other person already holds.
   */
  /**
   * Tell each socket which of its Space dashboards to read again.
   *
   * **Nothing durable stands behind this, deliberately.** The dashboard's page
   * is re-read on mount, on socket reconnect and on this event, so a nudge
   * lost to a closing socket costs one stale view until the next change or the
   * next reconnect. What it replaced is why: a per-(Space, person) counter
   * written on every message in the Organization, carried on the Space
   * snapshot — a write on the hottest path this object has, a full per-socket
   * rebuild of both Space directories to deliver it, and discarded by every
   * client anyway because the snapshot's own waterline had not moved.
   * `docs/spaces.md` records the trade and what would reverse it.
   *
   * **Addressed, not broadcast.** A socket hears about a Channel only if its
   * viewer can list that Channel, and about a Space only if its viewer can see
   * that Space. A personal Space's id on somebody else's socket is the
   * existence of that Space leaking through a shared Channel, and a Channel's
   * id never leaves this method at all — only the Spaces it is placed in do.
   *
   * **`spaceIds` names a Space to everybody who reaches it, including through
   * a Channel in it, and that is only right when the Space *itself* moved.**
   * A Channel entering or leaving a Space is not that: somebody who reaches
   * the Space through a different Channel sees the same page before and after,
   * so the nudge is the whole of the signal — *something was just put into or
   * taken out of this Space* — and repeated it is a live feed of a
   * participants-only Space's membership to a person who is told only its
   * name. `spaceIdsThroughChannel` is the arm for that case: the Space is
   * named, but only to the viewers who can list the Channel that moved, which
   * is exactly the set whose page changed. An archive and a restore do use
   * `spaceIds`, because the Space's own disappearance or return is already
   * visible to everyone who reaches it by any clause.
   *
   * The addressed sets take bounded local reads per socket and no write. The
   * final attention totals are one grouped read for every Space named to that
   * socket, rather than one aggregate query per Space.
   */
  private publishSpaceConversationsChanged(moved: {
    /** Channels whose shared row moved: everyone who can list them. */
    readonly channelIds?: readonly string[];
    /** Channels whose row moved for named people only. */
    readonly viewerChannelIds?: ReadonlyMap<string, ReadonlySet<string>>;
    /** Spaces whose own membership moved: everyone who can see them. */
    readonly spaceIds?: readonly string[];
    /**
     * Spaces a Channel entered or left, keyed by that Channel: named only to
     * the viewers who can list it.
     *
     * Keyed by the Channel rather than the Space because the Channel is what
     * decides the audience, and a removal is why the Space has to be named
     * here at all — once the membership is `removed` the Channel arm no longer
     * resolves to the Space it just left, and the dashboards still holding its
     * row would never hear.
     */
    readonly spaceIdsThroughChannel?: ReadonlyMap<string, readonly string[]>;
  }): void {
    const sharedChannelIds = moved.channelIds ?? [];
    const viewerChannelIds = moved.viewerChannelIds ?? new Map<string, ReadonlySet<string>>();
    const namedSpaceIds = moved.spaceIds ?? [];
    const spaceIdsThroughChannel = moved.spaceIdsThroughChannel ?? new Map<string, readonly string[]>();
    if (
      sharedChannelIds.length === 0 && viewerChannelIds.size === 0
      && namedSpaceIds.length === 0 && spaceIdsThroughChannel.size === 0
    ) return;
    const occurredAt = new Date().toISOString();
    // The `spaceIds` and `spaceIdsThroughChannel` arms are a thread entering
    // or leaving a Channel, or the Channel itself moving; the Channel arms are
    // a row already in one changing.
    const placementChanged = namedSpaceIds.length > 0 || spaceIdsThroughChannel.size > 0;
    const spaces = this.spaceStorage();
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      const viewer = viewerOf(attachment);
      const channelIds = [...new Set([
        ...sharedChannelIds,
        ...[...viewerChannelIds].flatMap(([workstreamId, users]) => (
          users.has(attachment.userId) ? [workstreamId] : []
        )),
      ])];
      const spaceIds = new Set(spaces.visibleSpaceIdsAmong(viewer, namedSpaceIds));
      for (const [workstreamId, named] of spaceIdsThroughChannel) {
        // Both halves: can this person list the Channel that moved, and may
        // they see the Space it moved into or out of. The second is not
        // implied by the first — a Channel they can read leaving somebody's
        // personal Space takes their whole reach into it with it.
        if (spaces.listableChannelIds(viewer, [workstreamId]).length === 0) continue;
        for (const spaceId of spaces.visibleSpaceIdsAmong(viewer, named)) {
          spaceIds.add(spaceId);
        }
      }
      if (channelIds.length > 0) {
        for (const ids of spaces.spaceIdsByChannel(
          viewer,
          spaces.listableChannelIds(viewer, channelIds),
        ).values()) {
          for (const spaceId of ids) spaceIds.add(spaceId);
        }
      }
      if (spaceIds.size === 0) continue;
      const sortedSpaceIds = [...spaceIds].sort();
      const attentionCounts = spaces.attentionCounts(viewer, sortedSpaceIds);
      try {
        socket.send(JSON.stringify(WorkspaceSpaceConversationsEventSchema.parse({
          type: "space_conversations_changed",
          occurredAt,
          placementChanged,
          spaceIds: sortedSpaceIds,
          attentionCounts: sortedSpaceIds.map((spaceId) => ({
            spaceId,
            count: attentionCounts.get(spaceId) ?? 0,
          })),
        })));
      } catch {
        // Hibernation owns close cleanup, and a reconnect re-reads the page.
        // That is the whole reason this event carries no state to lose.
      }
    }
  }

  private publishSpaceSnapshot(onlyUserId?: string): void {
    const occurredAt = new Date().toISOString();
    // An open workspace socket is the authorization. Access revocation closes
    // it through the one shared revocation path; do not add a D1 read here.
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      if (onlyUserId !== undefined && attachment.userId !== onlyUserId) continue;
      try {
        // No `channelStats`: they are a grouped read over every placement,
        // per socket, and a snapshot goes to every socket in the
        // Organization. A client reads them again over REST
        // (`/navigation/channel-stats`) when a snapshot arrives without them.
        socket.send(JSON.stringify(WorkspaceSpaceSnapshotEventSchema.parse({
          type: "workspace_space_snapshot",
          occurredAt,
          ...this.spacesFor(attachment, { channelStats: false }),
        })));
      } catch {
        // Reconnect receives this same snapshot in the subscribe payload.
      }
    }
  }

  /**
   * The Space half of what one socket is told, connect payload and snapshot
   * alike: the Spaces the listing rules give this viewer, member or guest.
   * A guest is not Organization-wide, so a Space reaches them only through a
   * Channel they may list, with the `through_channel` summary.
   */
  private spacesFor(attachment: WorkspaceSocketAttachment, options: { channelStats: boolean } = { channelStats: true }): {
    spaces: SpaceSnapshot;
    ordering: PersonalOrder;
    pinnedOrder: string[];
    pins: Pin[];
    artifactPins?: ArtifactPin[];
    channelStats?: ChannelStats[];
    spacesReady: boolean;
  } {
    const spaces = this.spaceStorage();
    const viewer = viewerOf(attachment);
    // `list` first, and not for tidiness: it is the read that gives a newly
    // visible Space its row in the Organization's order, so a read of the
    // orders taken ahead of it would answer without the Space the directory
    // beside it is about to carry.
    const active = spaces.list(attachment.workspaceId, viewer);
    const readable = (directory: SpaceDirectory): SpaceDirectory => attachment.readsIndividualSpaces ? directory : {
      ...directory,
      items: directory.items.map((space) => ({ ...space, scope: spaceScopeForClient(space.scope, false) })),
    };
    return {
      spaces: { active: readable(active), inactive: readable(spaces.listInactive(viewer)) },
      ordering: spaces.readOrders(attachment.workspaceId, viewer),
      pinnedOrder: spaces.readPinnedOrder(viewer),
      pins: new WorkspacePinStorage(this.state.storage).list(viewer.userId),
      // With the Channel stats, for the same reason: the Space snapshot goes
      // to every socket in the Organization, and a pinned artifact does not
      // change with a Space. The connect payload carries them, and a pin write
      // sends that person's sockets the new list.
      ...(options.channelStats ? {
        artifactPins: this.artifactPinsFor(viewer, attachment.workspaceId),
        channelStats: this.channelStatsFor(viewer),
      } : {}),
      spacesReady: spaces.bootstrapStatus().ready,
    };
  }

  private channelStatsFor(viewer: Viewer, onlySpaceId?: string): ChannelStats[] {
    return this.spaceStorage().channelStats(viewer, onlySpaceId).map((stats) => ({
      channelId: stats.spaceId,
      threadCount: stats.threadCount,
      newThreadCount: stats.newThreadCount,
      lastActivityAt: iso(stats.lastActivityAt),
      ...stats.read,
    }));
  }

  private async publishDirectorySync(workspaceId: string): Promise<void> {
    const placementAffinity = this.placementAffinity();
    if (!placementAffinity) throw new Error("workspace_object_placement_affinity_missing");
    await this.publishSync(["workstream_directory"], workspaceId, placementAffinity);
  }

  /** Finish non-authoritative move convergence after the mutation has answered. */
  private deferSpaceMembershipConvergence(
    workspaceId: string,
    workstreamId: string,
    includeDirectory: boolean,
  ): void {
    this.state.waitUntil(Promise.all([
      ...(includeDirectory ? [this.publishDirectorySync(workspaceId)] : []),
      // Deferred into the chain so nothing it throws can fail the committed write.
      Promise.resolve().then(() => this.publishChannelRowToReaders(workstreamId)),
      this.armNextAlarm(),
    ]).then(() => undefined).catch((error: unknown) => {
      logWarn(this.env, "space_membership_convergence_deferred", {
        workspace_id: workspaceId,
        workstream_id: workstreamId,
        error_code: diagnosticErrorCode(error, "space_membership_convergence_failed"),
      });
    }));
  }

  private productStorage(): WorkspaceProductStorage {
    return new WorkspaceProductStorage(this.state.storage);
  }

  private spaceStorage(): WorkspaceSpaceStorage {
    return new WorkspaceSpaceStorage(this.state.storage, (workstreamId, userId) => this.canManageChannelNow(workstreamId, userId));
  }

  /**
   * Channel management, from this object's own tables: the relationship
   * table and the Channel's grants. False for somebody the table has never
   * heard of, since learning them takes a D1 read; the caller sends that
   * case the long way round.
   */
  private canManageChannelNow(workstreamId: string, userId: string): boolean {
    const workspaceId = this.workspaceId();
    const relationship = this.knownRelationship(userId);
    if (!workspaceId || relationship?.status !== "active" || relationship.accessClass !== "member") return false;
    const access = new HostedParent(this.hostedParentHost(), workstreamId, HOSTED_CHANNEL_ROLE).managementAccess(
      { workspaceId: asWorkspaceId(workspaceId), parentId: workstreamId, userId: asUserId(userId) }, relationship,
    );
    return access.allowed && access.writable;
  }

  private breakoutStorage(): WorkspaceBreakoutStorage {
    return new WorkspaceBreakoutStorage(this.state.storage);
  }

  private async activeWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
    return Boolean(await this.env.DB.prepare(
      `SELECT 1 FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
    ).bind(workspaceId, userId).first());
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
    // Only a member is ever an approver; a guest's answer carries no list.
    const accessRequests = attachment.accessClass === "guest"
      ? undefined : this.accessRequestStorage().pendingFor(attachment.userId, this.spaceStorage().breakoutsReady());
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
        for (const topic of z.array(WorkspaceSyncTopicSchema).parse(JSON.parse(row.topics_json))) {
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
        ...event, featureFlags, viewerPreferences, ...(accessRequests ? { accessRequests } : {}),
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
      for (const spaceId of this.spaceStorage().allSpaceIds()) {
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
    "workspaceRetirementProgress",
    // The walk's read of a hosted Channel's or Space's children. The parent is
    // closed with this object; its conversations are still separate objects
    // the walk has to find and close.
    "childrenForRetirement",
    // The `workstream` revocation hop, permitted for the reason
    // `revokeSocketAccess` is on every gated class: it closes a hosted
    // Channel's control sockets and names the conversations whose sockets the
    // consumer revokes next, which a retired workspace still has to reach.
    "revokeParentSocketAccess",
  ],
  drop: {
    // A conversation's effects for a hosted parent, handed to the Queue before
    // the tombstone landed. Acknowledged as the legacy parents did, so the
    // message stops redelivering an effect nothing will apply.
    receiveChildEffects: ([input]) => ({ accepted: droppedEnvelopeReceipts(input) }),
    // Already handed to the Queue before the tombstone landed. The consumer
    // parses `accepted` to decide the message is done; anything else leaves it
    // redelivering an effect no object will ever apply.
    applyWorkstreamDirectoryEffects: ([input]) => ({
      accepted: droppedEnvelopeReceipts(input),
      directoryChanged: false,
    }),
    // `replayed` is this receiver's terminal answer — it already means "this
    // changed nothing, do not send it again", which is exactly true here.
    applyWorkstreamRegionalEffect: () => ({ replayed: true, notificationIntentId: null }),
    // A visibility question answered rather than refused, as the deleted `WorkstreamDO` did:
    // nobody can read anything in a retired workspace, and a caller that asks
    // can act on `false` where it cannot act on a throw.
    canReadWorkstream: () => false,
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

/** The breakout a merge message's activity event names, or null for any other event. */
function mergedBreakoutId(metadata: Record<string, unknown> | undefined): string | null {
  const merged = metadata?.mergedFrom;
  return merged !== null && typeof merged === "object" && typeof (merged as { breakoutId?: unknown }).breakoutId === "string"
    ? (merged as { breakoutId: string }).breakoutId
    : null;
}
