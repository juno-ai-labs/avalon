import { RALLY_HEADERS, readRallyHeader } from "@rally/contracts/http-headers";
import {
  AutomationAttentionReasonSchema,
  AutomationDraftCreationClaimRequestSchema,
  AutomationDraftCreationClaimResultSchema,
  ExternalEventRegistrationProjectionV1Schema,
  WorkspaceExternalEventDeliveryClaimRequestSchema,
  WorkspaceExternalEventDeliverySettleRequestSchema,
  AutomationIdSchema,
  asAutomationId,
  asWorkspaceId,
  IdSchema,
  MESSAGE_TOO_LONG_MESSAGE,
  UserIdSchema,
  WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
  WORKSPACE_SOCKET_SESSION_INACTIVE_CODE,
  WORKSPACE_SYNC_TOPICS,
  WORKSTREAM_SOCKET_ACCESS_REVOKED_CODE,
  WorkspaceIdSchema,
  WorkspaceAttentionSchema,
  WorkspaceProjectSnapshotEventSchema,
  WorkspaceSidebarListEventSchema,
  WorkspaceSidebarSchema,
  WorkspaceWorkstreamPageEventSchema,
  WorkspaceWorkstreamStateEventSchema,
  WorkspaceSocketClientEventSchema,
  WorkspaceFeatureFlagsEventSchema,
  WorkspacePresenceEventSchema,
  WorkspaceSocketSyncEventSchema,
  WorkspaceSyncTopicSchema,
  WorkstreamSocketCommandResultSchema,
  type AutomationAttentionReason,
  type AutomationSummary,
  type WorkstreamAutomationSummary,
  type AutomationDraftCreationClaimRequest,
  type AutomationDraftCreationClaimResult,
  type WorkspaceSidebar,
  type NoteSummary,
  type ProjectSnapshot,
  type Workstream,
  type WorkspaceSocketSyncEvent,
  type WorkspaceSyncTopic,
  ProductFeatureFlagKeySchema,
  type ProductFeatureFlagKey,
} from "@rally/contracts";
import { truncateUtf16Safe } from "@rally/contracts/text";
import { z } from "zod";

import type { AuthContext, Env } from "../env";
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
import { uuidV7 } from "../lib/uuid-v7";
import { diagnosticErrorCode, logInfo, logWarn } from "../observability/logger";
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
import { SIDEBAR_LIST_LIMIT } from "../services/sidebar-reads";
import { applyDurableObjectSqliteMigrations } from "./sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "./workspace-do-migrations";
import {
  SIDEBAR_LIST_SOURCE_TABLES,
  WORKSPACE_ALARM_SOURCE_TABLES,
  typedRpcOnlyWorkspaceTable,
  workspaceMutationTarget,
  type SidebarList,
} from "./workspace-runtime-sql-guards";
import {
  SocketIdentitySchema,
  closeWorkspaceSocket,
  contributesPresence,
  disconnect,
  overLongCreateMessageCommand,
  readAttachment,
  type CreateMessageCommand,
  type SocketIdentity,
  type WorkspaceSocketAttachment,
  type WorkspaceSocketCloseInput,
} from "./workspace-socket-session";
import {
  SELECT_WORKSPACE_DIRECTORY,
  advanceWorkspaceDirectoryVersion,
  applyWorkspaceDirectoryEnvelope,
  directoryStateVersion,
  directoryWorkstream,
  internalDirectoryItem,
  listWorkspaceDirectory,
  loadParticipantPreviews,
  mapDirectoryWorkstream,
  mapDirectoryWorkstreams,
  pinnedWorkspaceDirectoryRows,
  rewriteWorkspacePinOrder,
  workspaceDirectoryVisible,
  type WorkspaceDirectoryRow,
} from "./workspace-directory-storage";
import {
  claimWorkspaceConnectorEvent,
  connectorEventFromRow,
  ingestWorkspaceConnectorEvent,
  settleWorkspaceConnectorEvent,
  workspaceConnectorEvent,
  type WorkspaceConnectorEventRow,
} from "./workspace-connector-event-storage";
import {
  applyWorkspaceExternalEventRegistrations,
  claimWorkspaceExternalEventDelivery,
  hasActiveWorkspaceExternalEventRegistration,
  matchWorkspaceExternalEventDestinations,
  settleWorkspaceExternalEventDelivery,
} from "./workspace-external-event-storage";
import {
  ACTIVITY_EVENT_RETENTION_MS,
  latestWorkspaceActivityEventCursor,
  listWorkspaceActivityEvents,
  reapExpiredWorkspaceActivityEvents,
  recordWorkspaceActivityEvent,
  workspaceActivityEventSource,
} from "./workspace-activity-event-storage";
import {
  advanceWorkspaceBatchDispatch,
  archiveWorkspaceNotesForBatch,
  beginWorkspaceBatchDispatch,
  workspaceBatchTargetIds,
} from "./workspace-batch-dispatch-storage";
import {
  releaseWorkspaceDraftAttachments,
  reserveWorkspaceDraftAttachments,
} from "./workspace-draft-attachment-storage";
import { compareProjectionCoordinate, epoch, iso } from "./workspace-projection";
import {
  ScheduledDurableObject,
  scheduledAlarmRetryDelay,
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
import { automationAgentName, workspaceDOName } from "./names";
import {
  automationCutoverWitness as readAutomationCutoverWitness,
  cutoverWorkspaceAutomations,
  removeLegacyAutomationSchema,
} from "./automation-cutover";
import { reportScheduledAlarmAttempt } from "./scheduled-alarm-report";
import {
  WorkspaceDirectoryApplyRequestSchema,
  WorkspaceAttentionRequestSchema,
  WorkspaceDirectoryBatchTargetsRequestSchema,
  WorkspaceDirectoryBatchTargetsResultSchema,
  WorkspaceBatchDispatchAdvanceRequestSchema,
  WorkspaceBatchDispatchBeginRequestSchema,
  WorkspaceBatchNoteArchiveRequestSchema,
  WorkspaceDirectoryExistsRequestSchema,
  WorkspaceDirectoryApplyResultSchema,
  WorkspaceDirectoryDueRequestSchema,
  WorkspaceDirectoryListRequestSchema,
  WorkspaceDirectoryLookupRequestSchema,
  WorkspaceDirectoryLookupResultSchema,
  WorkspaceDirectoryRecentRequestSchema,
  WorkspaceDirectoryReadableIdsRequestSchema,
  WorkspaceDirectoryReadableIdsResultSchema,
  WorkspaceDirectoryDeliveryAuthorityRequestSchema,
  WorkspaceDirectoryExposeRunRequestSchema,
  WorkspaceDirectoryOwnedAutomationsRequestSchema,
  WorkspaceDirectoryOwnedAutomationsSchema,
  WorkspaceDirectoryDeliveryAuthoritySchema,
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
  WorkspaceDirectoryScheduleTargetsRequestSchema,
  WorkspaceDirectoryScheduleTargetsResultSchema,
  WorkspaceDirectoryVisibilityRequestSchema,
  WorkspaceAutomationOriginLabelRequestSchema,
  WorkspaceAutomationOriginLabelSchema,
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
  type WorkspaceBatchNoteArchiveRequest,
  type WorkspaceBatchNoteArchiveResult,
  type WorkspaceDirectoryApplyResult,
  type WorkspaceDirectoryDueRequest,
  type WorkspaceDirectoryExistsRequest,
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
  type WorkspaceDirectoryScheduleTargetsRequest,
  type WorkspaceDirectoryScheduleTargetsResult,
  type WorkspaceDirectoryVisibilityRequest,
  type WorkspaceAutomationOriginLabel,
  type WorkspaceAutomationOriginLabelRequest,
  type WorkspaceDirectoryVisibleIdsRequest,
  type WorkspaceDirectoryVisibleIdsPage,
  type WorkspaceRegionalEffectApplyRequest,
  type WorkspaceRegionalEffectApplyResult,
} from "./workspace-directory-protocol";
import {
  addWorkspaceAutomationTemplateVersion,
  listWorkspaceAutomationTemplates,
  publishWorkspaceAutomationTemplate,
  workspaceAutomationTemplateOwnership,
} from "./workspace-automation-template-storage";
import {
  WorkspaceAutomationTemplateOwnershipRequestSchema,
  WorkspaceAutomationTemplatePublishRequestSchema,
  WorkspaceAutomationTemplateVersionRequestSchema,
  type WorkspaceAutomationTemplateList,
  type WorkspaceAutomationTemplateOwnership,
  type WorkspaceAutomationTemplateOwnershipRequest,
  type WorkspaceAutomationTemplatePublishRequest,
  type WorkspaceAutomationTemplateVersionRequest,
  type WorkspaceAutomationTemplateVersionResult,
} from "./workspace-automation-template-protocol";
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
  addWorkspaceMemoryItem,
  canonicalWorkspaceMemoryItems,
  claimWorkspaceMemoryIndexOutboxRow,
  completeWorkspaceMemoryIndexOutboxRow,
  createWorkspaceMemoryTable,
  dueWorkspaceMemoryIndexOutbox,
  ensureWorkspaceMemoryScope,
  insertWorkspaceMemoryTableRows,
  invalidateWorkspaceMemoryItem,
  invalidateWorkspaceMemoryTableRows,
  queryWorkspaceMemoryTableRows,
  recordWorkspaceMemoryItemAccess,
  recordWorkspaceMemoryTableOpenReceipt,
  retryWorkspaceMemoryIndexOutboxRow,
  searchWorkspaceMemoryItemsFts,
  searchWorkspaceMemoryTables,
  updateWorkspaceMemoryItem,
  updateWorkspaceMemoryTableRows,
  workspaceMemoryIndexProjectionSource,
  workspaceMemoryItemForWrite,
  workspaceMemoryMutationReceipt,
  workspaceMemoryTableMutationReceipt,
  workspaceMemoryTableRowsById,
  workspaceMemoryTableWithColumns,
} from "./workspace-memory-storage";
import {
  WorkspaceMemoryAccessRecordRequestSchema,
  WorkspaceMemoryAddRequestSchema,
  WorkspaceMemoryCanonicalItemsRequestSchema,
  WorkspaceMemoryFtsSearchRequestSchema,
  WorkspaceMemoryInvalidateRequestSchema,
  WorkspaceMemoryItemForWriteRequestSchema,
  WorkspaceMemoryOutboxClaimRequestSchema,
  WorkspaceMemoryOutboxCompleteRequestSchema,
  WorkspaceMemoryOutboxDueRequestSchema,
  WorkspaceMemoryOutboxRetryRequestSchema,
  WorkspaceMemoryProjectionSourceRequestSchema,
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
  WorkspaceMemoryUpdateRequestSchema,
  type WorkspaceMemoryAddRequest,
  type WorkspaceMemoryAddResult,
  type WorkspaceMemoryAccessRecordRequest,
  type WorkspaceMemoryCandidateList,
  type WorkspaceMemoryCanonicalItemsRequest,
  type WorkspaceMemoryFtsSearchRequest,
  type WorkspaceMemoryInvalidateRequest,
  type WorkspaceMemoryItemForWriteRequest,
  type WorkspaceMemoryItemForWriteResult,
  type WorkspaceMemoryItemList,
  type WorkspaceMemoryOutboxClaimRequest,
  type WorkspaceMemoryOutboxClaimResult,
  type WorkspaceMemoryOutboxCompleteRequest,
  type WorkspaceMemoryOutboxDueList,
  type WorkspaceMemoryOutboxDueRequest,
  type WorkspaceMemoryOutboxRetryRequest,
  type WorkspaceMemoryProjectionSourceRequest,
  type WorkspaceMemoryProjectionSourceResult,
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
  type WorkspaceMemoryUpdateRequest,
  type WorkspaceMemoryWriteResult,
} from "./workspace-memory-protocol";
import {
  claimWorkspaceTerminalPolicyApplication,
  commitWorkspaceTerminalPolicyApplication,
  failWorkspaceTerminalPolicyApplication,
  recordWorkspaceTerminalPolicyPreview,
  workspaceTerminalNetworkMode,
  workspaceTerminalNetworkSettings,
} from "./workspace-terminal-network-storage";
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
  claimWorkspaceSlackIngressJob,
  claimWorkspaceSlackThread,
  clearWorkspaceSlackPendingPrompt,
  completeWorkspaceSlackIngressJob,
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
  appendWorkspaceNoteSegment,
  archiveWorkspaceNote,
  commitWorkspaceNoteGeneration,
  markWorkspaceNotePrivacyTransitionProcessed,
  pendingWorkspaceNotePrivacyTransitions,
  retireWorkspaceNoteResourceDeletion,
  updateWorkspaceNote,
  visibleWorkspaceNoteResourceIds,
  workspaceNoteBatchTargets,
  workspaceNoteResourceDeletionOutbox,
  workspaceNoteSidebar,
  workspaceNoteState,
} from "./workspace-notes-storage";
import {
  WorkspaceNoteArchiveRequestSchema,
  WorkspaceNoteDeletionOutboxRequestSchema,
  WorkspaceNoteDeletionRetireRequestSchema,
  WorkspaceNoteGenerationCommitRequestSchema,
  WorkspaceNotePrivacyMarkRequestSchema,
  WorkspaceNotePrivacyPendingRequestSchema,
  WorkspaceNoteSegmentAppendRequestSchema,
  WorkspaceNoteSidebarRequestSchema,
  WorkspaceNoteStateRequestSchema,
  WorkspaceNoteUpdateRequestSchema,
  WorkspaceNoteVisibilityRequestSchema,
  type WorkspaceNoteArchiveRequest,
  type WorkspaceNoteArchiveResult,
  type WorkspaceNoteDeletionOutbox,
  type WorkspaceNoteDeletionOutboxRequest,
  type WorkspaceNoteDeletionRetireRequest,
  type WorkspaceNoteDeletionRetireResult,
  type WorkspaceNoteGenerationCommitRequest,
  type WorkspaceNoteGenerationCommitResult,
  type WorkspaceNotePrivacyMarkRequest,
  type WorkspaceNotePrivacyMarkResult,
  type WorkspaceNotePrivacyPendingRequest,
  type WorkspaceNotePrivacyPendingResult,
  type WorkspaceNoteSegmentAppendRequest,
  type WorkspaceNoteSegmentAppendResult,
  type WorkspaceNoteSidebarList,
  type WorkspaceNoteSidebarRequest,
  type WorkspaceNoteState,
  type WorkspaceNoteStateRequest,
  type WorkspaceNoteUpdateRequest,
  type WorkspaceNoteUpdateResult,
  type WorkspaceNoteVisibilityRequest,
  type WorkspaceNoteVisibilityResult,
} from "./workspace-notes-protocol";
import {
  claimWorkspaceDigestDelivery,
  ensureDefaultWorkspaceDigestSchedule,
  latestWorkspaceDigestCursor,
  markWorkspaceDigestDeliveryRunning,
  markWorkspaceDigestTargetDelivered,
  markWorkspaceDigestTargetFailed,
  recordWorkspaceDigestDeliveryWorkstream,
  recordWorkspaceDigestSummary,
  releaseWorkspaceDigestDeliveryClaim,
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
  WorkspaceDigestClaimRequestSchema,
  WorkspaceDigestCursorRequestSchema,
  WorkspaceDigestDefaultRequestSchema,
  WorkspaceDigestDeliveryContextRequestSchema,
  WorkspaceDigestDeliveryRunningRequestSchema,
  WorkspaceDigestDeliveryTargetsRequestSchema,
  WorkspaceDigestDeliveryWorkstreamRequestSchema,
  WorkspaceDigestFireScheduleRequestSchema,
  WorkspaceDigestReleaseClaimRequestSchema,
  WorkspaceDigestReplaceRequestSchema,
  WorkspaceDigestReplaceRowsRequestSchema,
  WorkspaceDigestRowStateRequestSchema,
  WorkspaceDigestSettingsRequestSchema,
  WorkspaceDigestSettleRequestSchema,
  WorkspaceDigestSummaryRequestSchema,
  WorkspaceDigestTargetDeliveredRequestSchema,
  WorkspaceDigestTargetFailedRequestSchema,
  WorkspaceDigestTerminalContextRequestSchema,
  type WorkspaceDigestClaimRequest,
  type WorkspaceDigestClaimResult,
  type WorkspaceDigestCursor,
  type WorkspaceDigestCursorRequest,
  type WorkspaceDigestDefaultRequest,
  type WorkspaceDigestDefaultResult,
  type WorkspaceDigestDeliveryContext,
  type WorkspaceDigestDeliveryContextRequest,
  type WorkspaceDigestDeliveryRunningRequest,
  type WorkspaceDigestDeliveryTargets,
  type WorkspaceDigestDeliveryTargetsRequest,
  type WorkspaceDigestDeliveryWorkstreamRequest,
  type WorkspaceDigestFireSchedule,
  type WorkspaceDigestFireScheduleRequest,
  type WorkspaceDigestReleaseClaimRequest,
  type WorkspaceDigestReleaseClaimResult,
  type WorkspaceDigestReplaceRequest,
  type WorkspaceDigestReplaceResult,
  type WorkspaceDigestReplaceRowsRequest,
  type WorkspaceDigestRowState,
  type WorkspaceDigestRowStateRequest,
  type WorkspaceDigestRunningResult,
  type WorkspaceDigestSettings,
  type WorkspaceDigestSettingsRequest,
  type WorkspaceDigestSettleRequest,
  type WorkspaceDigestSettleResult,
  type WorkspaceDigestSummaryRequest,
  type WorkspaceDigestTargetDeliveredRequest,
  type WorkspaceDigestTargetFailedRequest,
  type WorkspaceDigestTargetOutcomeResult,
  type WorkspaceDigestTerminalContext,
  type WorkspaceDigestTerminalContextRequest,
} from "./workspace-digests-protocol";
import {
  admitWorkspaceTranscriptionSession,
  releaseWorkspaceTranscriptionSession,
  renewWorkspaceTranscriptionSession,
} from "./workspace-transcription-storage";
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
  WorkspaceReleaseDraftAttachmentsRequestSchema,
  WorkspaceReleaseDraftAttachmentsResultSchema,
  WorkspaceReserveDraftAttachmentsRequestSchema,
  type WorkspaceReleaseDraftAttachmentsRequest,
  type WorkspaceReleaseDraftAttachmentsResult,
  type WorkspaceReserveDraftAttachmentsRequest,
  type WorkspaceReserveDraftAttachmentsResult,
} from "./workspace-draft-attachment-protocol";
import {
  WorkspaceConnectorEventClaimRpcRequestSchema,
  WorkspaceConnectorEventClaimRequestSchema,
  WorkspaceConnectorEventIngestRequestSchema,
  WorkspaceConnectorEventRequestSchema,
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
  WorkspaceActivityEventCursorRequestSchema,
  WorkspaceActivityEventInputSchema,
  WorkspaceActivityEventListRequestSchema,
  WorkspaceActivityEventSourceRequestSchema,
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
  WorkspaceProjectCreateRequestSchema,
  WorkspaceProjectAudienceRequestSchema,
  ProjectDefaultResourceQueueMessageSchema,
  WorkspaceProjectDefaultResourceRequestSchema,
  WorkspaceProjectDefaultResultSchema,
  WorkspaceProjectDirectoryResultSchema,
  WorkspaceProjectListRequestSchema,
  WorkspaceProjectLifecycleRequestSchema,
  WorkspaceProjectMembershipPlanResultSchema,
  WorkspaceProjectMembershipPrepareRequestSchema,
  WorkspaceProjectMembershipSettleRequestSchema,
  WorkspaceProjectMutationResultSchema,
  WorkspaceProjectReorderRequestSchema,
  WorkspaceProjectUpdateRequestSchema,
  WorkspaceProjectWorkstreamConstraintRequestSchema,
  WorkspaceProjectWorkstreamConstraintResultSchema,
  type WorkspaceProjectCreateRequest,
  type WorkspaceProjectAudienceRequest,
  type ProjectDefaultResourceQueueMessage,
  type WorkspaceProjectDefaultResourceRequest,
  type WorkspaceProjectDefaultResult,
  type WorkspaceProjectDirectoryResult,
  type WorkspaceProjectListRequest,
  type WorkspaceProjectLifecycleRequest,
  type WorkspaceProjectMembershipPlanResult,
  type WorkspaceProjectMembershipPrepareRequest,
  type WorkspaceProjectMembershipSettleRequest,
  type WorkspaceProjectMutationResult,
  type WorkspaceProjectReorderRequest,
  type WorkspaceProjectUpdateRequest,
  type WorkspaceProjectWorkstreamConstraintRequest,
  type WorkspaceProjectWorkstreamConstraintResult,
} from "./workspace-project-protocol";
import { WorkspaceProjectStorage } from "./workspace-project-storage";
import { publishProjectDefaultResourceTargets } from "./workspace-project-default-publication";
import {
  applyWorkstreamRegionalEnvelope,
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




const MAX_WORKSPACE_PINS_PER_USER = 1_000;
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

/**
 * The stored attention code as the contract spells it.
 *
 * `attention_code` is a free `TEXT` column — the cutover and the agent both
 * write it — so the value is parsed rather than asserted on the way out. The
 * write path below admits only the contract's reasons, which is why this can
 * be strict: a row outside them is a projection that should never have been
 * accepted, and every caller of this hands its rows to the same schema at the
 * route or socket boundary a moment later anyway.
 */
function automationAttention(code: string | null): AutomationAttentionReason | null {
  return code === null ? null : AutomationAttentionReasonSchema.parse(code);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function workflowAlreadyExists(error: unknown): boolean {
  return error instanceof Error && /(already exists|duplicate|conflict)/iu.test(error.message);
}

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
          && !workspaceDirectoryVisible(this.state.storage, currentAttachment.userId, parsed.data.foregroundWorkstreamId))) {
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
      const page = listWorkspaceDirectory(this.state.storage, {
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
        && !workspaceDirectoryVisible(this.state.storage, attachment.userId, attachment.foregroundWorkstreamId)) {
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
   * Activity retention and project-default publication are derived from their
   * authoritative rows. Product work, schedules, watches, maintenance passes,
   * and Terminal deadlines are stored entries with their own retry gates.
   */
  protected override nextDerivedAlarmCandidates(): readonly number[] {
    const oldest = this.state.storage.sql.exec<{ created_at: number | null }>(
      `SELECT MIN(created_at) AS created_at FROM workspace_activity_events`,
    ).one().created_at;
    const publication = this.projectStorage().nextDefaultPublicationDueAt();
    return [
      ...(oldest === null ? [] : [Number(oldest) + ACTIVITY_EVENT_RETENTION_MS]),
      ...(publication === null ? [] : [publication]),
    ];
  }

  /**
   * The one thing this object's alarm does that no entry owns.
   *
   * Expired activity events are swept on every wake rather than through an
   * entry: the sweep is idempotent, bounded to 500 rows, and its due time
   * moves with every event this workspace records.
   */
  protected override async runDueAlarmWork(now: number): Promise<void> {
    const workspaceId = this.workspaceId();
    if (workspaceId) {
      await this.instrumentWorkspaceAlarmPhase("project_default_publish", undefined, async () => {
        try {
          await publishProjectDefaultResourceTargets({
            storage: this.projectStorage(),
            queue: this.env.ACTIVITY_QUEUE,
            workspaceId,
            region: this.env.AVALON_REGION,
            now,
            retryAt: (attempt) => now + scheduledAlarmRetryDelay(attempt),
          });
        } catch (error) {
          logWarn(this.env, "project_default_publication_failed", {
            workspace_id: workspaceId,
            reason: error instanceof Error ? error.message : "unknown",
          });
        }
      });
    }
    await this.instrumentWorkspaceAlarmPhase("activity_reap", undefined, async () => {
      this.reapExpiredActivityEvents(now);
    });
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
  async revokeSocketAccess(revocation: SocketAccessRevocation): Promise<{
    workstreamIds: string[];
    automationIds: string[];
  }> {
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
    return {
      workstreamIds: this.revocableWorkstreamIds(request.userId),
      // Only the author can hold an automation socket, so a revocation reaches
      // exactly the automations they authored; a membership-wide revocation
      // carries no user and reaches all of them.
      automationIds: this.state.storage.sql.exec<{ automation_id: string }>(
        request.userId
          ? `SELECT automation_id FROM automation_directory
              WHERE lifecycle <> 'deleted' AND author_user_id = ? ORDER BY automation_id`
          : `SELECT automation_id FROM automation_directory
              WHERE lifecycle <> 'deleted' ORDER BY automation_id`,
        ...(request.userId ? [request.userId] : []),
      ).toArray().map((row) => row.automation_id),
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

  /** Resolve an uncertain first wizard send to exactly one server identity. */
  async claimAutomationDraft(
    input: AutomationDraftCreationClaimRequest,
  ): Promise<AutomationDraftCreationClaimResult> {
    await this.initialized;
    const request = AutomationDraftCreationClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (request.region !== this.env.AVALON_REGION) throw new Error("automation_region_mismatch");
    if (!await this.activeWorkspaceMember(request.workspaceId, request.authorUserId)) {
      throw new Error("automation_author_access_denied");
    }
    const cutover = this.state.storage.sql.exec<{ state: string }>(
      `SELECT state FROM automation_cutover_campaign WHERE id = 1`,
    ).toArray()[0];
    if (cutover?.state !== "completed") throw new Error("automation_cutover_in_progress");
    return this.state.storage.transactionSync(() => {
      const existing = this.state.storage.sql.exec<{ automation_id: string }>(
        `SELECT automation_id FROM automation_creation_claims
          WHERE workspace_id = ? AND author_user_id = ? AND client_creation_key = ?`,
        request.workspaceId,
        request.authorUserId,
        request.clientCreationKey,
      ).toArray()[0];
      if (existing) {
        return AutomationDraftCreationClaimResultSchema.parse({
          automationId: existing.automation_id,
          created: false,
        });
      }
      const automationId = uuidV7();
      this.state.storage.sql.exec(
        `INSERT INTO automation_creation_claims
           (workspace_id, author_user_id, client_creation_key, automation_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        request.workspaceId,
        request.authorUserId,
        request.clientCreationKey,
        automationId,
        Date.now(),
      );
      return AutomationDraftCreationClaimResultSchema.parse({ automationId, created: true });
    });
  }

  async finalizeAutomationCutover(input: unknown): Promise<{
    state: "completed";
    imported: number;
    discardedDrafts: number;
    sourceHash: string;
  }> {
    await this.initialized;
    const workspaceId = z.looseObject({ workspaceId: WorkspaceIdSchema }).parse(input).workspaceId;
    this.assertWorkspace(workspaceId);
    const result = await cutoverWorkspaceAutomations({
      env: this.env,
      storage: this.state.storage,
      request: input,
      applyProjection: (projection) => this.applyAutomationProjection(projection),
    });
    await this.refreshSchedule(workspaceId);
    return result;
  }

  async automationCutoverWitness(input: { workspaceId: string }): Promise<{ draftIds: string[] }> {
    await this.migrationsReady();
    this.assertWorkspace(input.workspaceId);
    return readAutomationCutoverWitness(this.state.storage, input.workspaceId);
  }

  /** Content-free list projection; the AutomationAgent remains canonical. */
  async applyAutomationProjection(input: unknown): Promise<{ applied: boolean }> {
    await this.initialized;
    const request = z.strictObject({
      schemaVersion: z.literal(1),
      automationId: IdSchema,
      workspaceId: WorkspaceIdSchema,
      authorUserId: UserIdSchema,
      authorityGeneration: z.number().int().positive(),
      projectionVersion: z.number().int().positive(),
      payloadHash: z.string().min(1),
      lifecycle: z.enum(["draft", "activating", "active", "paused", "deleted"]),
      scope: z.enum(["personal", "workspace", "workstream"]),
      /**
       * The room that owns a `workstream`-scoped automation, and nothing at all
       * for the other two. The rail reads the directory by it and the sidebar
       * excludes rows that have one, so a projection that omitted it would put
       * a room's automation in everybody's sidebar.
       */
      owningWorkstreamId: IdSchema.nullable().default(null),
      title: z.string(),
      description: z.string(),
      nextRunAt: z.number().int().nonnegative().nullable(),
      // The contract's reasons rather than free text: the directory row is what
      // the sidebar reads, and a code nothing on the client can render is a
      // marker with no sentence behind it.
      attentionCode: AutomationAttentionReasonSchema.nullable(),
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = this.state.storage.transactionSync(() => {
      const existing = this.state.storage.sql.exec<{
        authority_generation: number;
        projection_version: number;
        payload_hash: string;
      }>(`SELECT authority_generation, projection_version, payload_hash
            FROM automation_directory WHERE automation_id = ?`, request.automationId).toArray()[0];
      if (existing) {
        const coordinate = compareProjectionCoordinate(
          request.authorityGeneration,
          request.projectionVersion,
          existing.authority_generation,
          existing.projection_version,
        );
        if (coordinate < 0) return { applied: false };
        if (coordinate === 0) {
          if (existing.payload_hash !== request.payloadHash) {
            throw new Error("automation_projection_hash_conflict");
          }
          return { applied: false };
        }
      }
      this.state.storage.sql.exec(
        `INSERT INTO automation_directory
           (automation_id, workspace_id, author_user_id, authority_generation,
            projection_version, payload_hash, lifecycle, scope, owning_workstream_id,
            title, description, next_run_at, attention_code, projected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(automation_id) DO UPDATE SET
           author_user_id = excluded.author_user_id,
           authority_generation = excluded.authority_generation,
           projection_version = excluded.projection_version,
           payload_hash = excluded.payload_hash,
           lifecycle = excluded.lifecycle,
           scope = excluded.scope,
           owning_workstream_id = excluded.owning_workstream_id,
           title = excluded.title,
           description = excluded.description,
           next_run_at = excluded.next_run_at,
           attention_code = excluded.attention_code,
           projected_at = excluded.projected_at`,
        request.automationId,
        request.workspaceId,
        request.authorUserId,
        request.authorityGeneration,
        request.projectionVersion,
        request.payloadHash,
        request.lifecycle,
        request.scope,
        request.owningWorkstreamId,
        request.title,
        request.description,
        request.nextRunAt,
        request.attentionCode,
        Date.now(),
      );
      this.state.storage.sql.exec(
        `UPDATE workspace_sidebar_list_state
            SET waterline = waterline + 1
          WHERE list = 'automations'`,
      );
      return { applied: true };
    });
    if (result.applied) this.publishSidebarList("automations");
    return result;
  }

  /**
   * Content-free automation sidebar projection; AutomationAgent remains authority.
   *
   * Drafts are excluded, and that follows from the builder's retirement rather
   * than being a taste: a draft is a conversation in progress and now lives
   * where that conversation is — a room's rail, or nowhere at all if it was
   * written on the screen that no longer exists. Listing one here would offer a
   * row whose only destination is an automation that has not been created yet.
   */
  async listAutomationDirectory(input: unknown): Promise<{ items: AutomationSummary[] }> {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, userId: UserIdSchema }).parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      throw new Error("automation_directory_access_denied");
    }
    const rows = this.state.storage.sql.exec<{
      automation_id: string;
      lifecycle: "activating" | "active" | "paused";
      scope: "personal" | "workspace";
      title: string;
      description: string;
      next_run_at: number | null;
      attention_code: string | null;
      projected_at: number;
    }>(`SELECT automation_id, lifecycle, scope, title, description, next_run_at,
              attention_code, projected_at
          FROM automation_directory
         WHERE workspace_id = ? AND lifecycle NOT IN ('deleted', 'draft')
           -- A room's automation is listed in that room's rail and nowhere
           -- else. In a personal list it would be an object somebody sees
           -- without the context that explains it, in a list where pausing it
           -- affects people who are not looking at that list.
           AND owning_workstream_id IS NULL
           AND (scope = 'workspace' OR author_user_id = ?)
         ORDER BY projected_at DESC, automation_id
         LIMIT 250`, request.workspaceId, request.userId).toArray();
    return {
      items: rows.map((row) => ({
        id: row.automation_id,
        name: row.title || "New automation",
        description: row.description,
        emailAddress: null,
        scope: row.scope,
        // The sidebar excludes drafts, so this cannot be one. A draft row
        // here led to the overview's "not created yet" error state.
        status: row.lifecycle === "paused"
          ? "paused"
          : row.attention_code ? "error" : "active",
        // Carried beside the status rather than folded into it. Both codes the
        // cutover writes arrive on an automation it also paused, so the status
        // alone says "paused" and nothing says why.
        attention: automationAttention(row.attention_code),
        nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at).toISOString(),
        lastRunAt: null,
        updatedAt: new Date(row.projected_at).toISOString(),
        updateAvailable: false,
      })),
    };
  }

  /**
   * The automations one work stream owns, for that work stream's rail.
   *
   * The counterpart to the sidebar's list, which excludes exactly these rows.
   * A room's automation is managed by the room's participants, so the gate is
   * participation rather than authorship: the person who created it may be
   * gone, and the automation is still theirs to pause.
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
      throw new Error("automation_directory_access_denied");
    }
    // Participation, not listability. A workspace-scoped room is listable to
    // every member of the workspace, so gating on that would hand the names,
    // descriptions and schedules of its automations to people who are not in
    // it — while `authorizeAutomationViewer` goes on refusing them the details.
    // The wider half of that pair is the one that leaks.
    if (!this.isWorkstreamParticipant(request.workstreamId, request.userId)) {
      throw new Error("automation_directory_access_denied");
    }
    const rows = this.state.storage.sql.exec<{
      automation_id: string;
      lifecycle: "activating" | "active" | "paused";
      title: string;
      description: string;
      next_run_at: number | null;
      attention_code: string | null;
      projected_at: number;
    }>(`SELECT automation_id, lifecycle, title, description, next_run_at,
              attention_code, projected_at
          FROM automation_directory
         WHERE owning_workstream_id = ? AND lifecycle NOT IN ('deleted', 'draft')
         ORDER BY projected_at DESC, automation_id
         LIMIT 250`, request.workstreamId).toArray();
    return {
      items: rows.map((row) => ({
        id: row.automation_id,
        name: row.title || "New automation",
        description: row.description,
        emailAddress: null,
        // No draft arm: the query excludes them. A draft is decided on its
        // proposal card in the feed, and a row here led to the overview's
        // "this automation has not been created yet" — the same dead end the
        // sidebar removed and this list reintroduced.
        status: row.lifecycle === "paused"
          ? "paused"
          : row.attention_code ? "error" : "active",
        attention: automationAttention(row.attention_code),
        nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at).toISOString(),
        lastRunAt: null,
        updatedAt: new Date(row.projected_at).toISOString(),
        updateAvailable: false,
      })),
    };
  }

  /**
   * Which of these bindings the named principal can no longer reach.
   *
   * Answered here because `connector_connections` lives here: migration 0090
   * dropped it from regional D1, so a caller reading it on `env.DB` gets
   * `no such table` — the failure the workspace-table routing guard exists to
   * catch, and did.
   *
   * Workspace-scoped bindings are never reported: they belong to the workspace
   * rather than to whoever authorized them, so they did not break when their
   * authorizer left.
   */
  async unreachablePersonalBindings(input: unknown): Promise<{ providers: string[] }> {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema,
      principalUserId: UserIdSchema,
      connectionIds: z.array(z.string().min(1)).max(100),
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    if (request.connectionIds.length === 0) return { providers: [] };
    const rows = this.state.storage.sql.exec<{
      id: string;
      connector_type: string;
      scope: string;
      owner_user_id: string | null;
      status: string;
    }>(
      `SELECT id, connector_type, scope, owner_user_id, status
         FROM connector_connections
        WHERE id IN (SELECT value FROM json_each(?))`,
      JSON.stringify(request.connectionIds),
    ).toArray();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const providers = new Set<string>();
    for (const connectionId of request.connectionIds) {
      const row = byId.get(connectionId);
      // A binding whose row is gone is unreachable and cannot name its
      // provider; the ones that remain say which they were.
      if (!row) { providers.add("a disconnected account"); continue; }
      if (row.scope !== "personal") continue;
      if (row.status === "disabled" || (row.owner_user_id ?? "") !== request.principalUserId) {
        providers.add(row.connector_type);
      }
    }
    return { providers: [...providers].sort() };
  }
  /**
   * Whether this person is an active participant of this work stream.
   *
   * The one predicate every "does the room let you" decision here is built on,
   * so the answer cannot drift between the list, the details, and acceptance.
   */
  private isWorkstreamParticipant(workstreamId: string, userId: string): boolean {
    return this.state.storage.sql.exec<{ is_participant: number }>(
      `SELECT viewer.is_participant
         FROM workspace_workstream_viewers viewer
         JOIN workspace_workstream_directory directory
           ON directory.workstream_id = viewer.workstream_id
          AND directory.authority_generation = viewer.authority_generation
        WHERE viewer.workstream_id = ? AND viewer.user_id = ?
          AND directory.archived_at IS NULL`,
      workstreamId,
      userId,
    ).toArray()[0]?.is_participant === 1;
  }

  /**
   * Whether somebody may still act on a work stream, asked directly.
   *
   * `authorizeAutomationViewer` answers the same question through the
   * automation directory, which a draft being accepted is not yet in. This one
   * names the room, so it works before the automation exists.
   */
  async workstreamParticipation(input: unknown): Promise<{ participant: boolean }> {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema,
      workstreamId: IdSchema,
      userId: UserIdSchema,
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return { participant: this.isWorkstreamParticipant(request.workstreamId, request.userId) };
  }

  /** Current membership plus projected scope gates direct AutomationAgent reads. */
  async authorizeAutomationViewer(input: unknown): Promise<{ authorized: boolean }> {
    await this.initialized;
    const request = z.strictObject({
      workspaceId: WorkspaceIdSchema,
      automationId: AutomationIdSchema,
      userId: UserIdSchema,
    }).parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { authorized: false };
    }
    const row = this.state.storage.sql.exec<{
      scope: "personal" | "workspace" | "workstream";
      author_user_id: string;
      owning_workstream_id: string | null;
    }>(`SELECT scope, author_user_id, owning_workstream_id FROM automation_directory
          WHERE workspace_id = ? AND automation_id = ? AND lifecycle <> 'deleted'`,
    request.workspaceId, request.automationId).toArray()[0];
    if (!row) return { authorized: false };
    // A room's automation is the room's: every active participant may read it,
    // and participation lives in the work stream's own object rather than
    // here. The viewer overlay this object *does* keep is the same fact the
    // sidebar is filtered by, so it answers without a second round trip.
    if (row.scope === "workstream" && row.owning_workstream_id) {
      const participant = this.state.storage.sql.exec<{ is_participant: number }>(
        `SELECT is_participant FROM workspace_workstream_viewers
          WHERE workstream_id = ? AND user_id = ?`,
        row.owning_workstream_id,
        request.userId,
      ).toArray()[0];
      return { authorized: participant?.is_participant === 1 };
    }
    return {
      authorized: row.scope === "workspace" || row.author_user_id === request.userId,
    };
  }

  /** Complete-replace one automation or watched-link evaluator generation. */
  async applyExternalEventRegistrations(input: unknown): Promise<{
    applied: boolean;
    effectiveAfterEventSequence: number;
  }> {
    await this.initialized;
    const request = ExternalEventRegistrationProjectionV1Schema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return applyWorkspaceExternalEventRegistrations(this.state.storage, request);
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
    return hasActiveWorkspaceExternalEventRegistration(this.state.storage, request);
  }

  /** Deterministically create ID-only destination receipts for one accepted event. */
  async matchExternalEventDestinations(input: unknown) {
    await this.initialized;
    const request = z.strictObject({ workspaceId: WorkspaceIdSchema, eventId: IdSchema }).parse(input);
    this.assertWorkspace(request.workspaceId);
    return matchWorkspaceExternalEventDestinations(this.env, this.state.storage, request);
  }

  async claimExternalEventDelivery(input: unknown) {
    await this.initialized;
    const request = WorkspaceExternalEventDeliveryClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return claimWorkspaceExternalEventDelivery(this.state.storage, request);
  }

  async settleExternalEventDelivery(input: unknown): Promise<void> {
    await this.initialized;
    const request = WorkspaceExternalEventDeliverySettleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    settleWorkspaceExternalEventDelivery(this.state.storage, request);
  }

  async createProject(input: WorkspaceProjectCreateRequest): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectCreateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().create(request, uuidV7());
    this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse({ ok: true, project });
  }

  async listProjects(input: WorkspaceProjectListRequest): Promise<WorkspaceProjectDirectoryResult> {
    await this.initialized;
    const request = WorkspaceProjectListRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    return WorkspaceProjectDirectoryResultSchema.parse({
      ok: true,
      directory: this.projectStorage().list(request.userId),
    });
  }

  async listInactiveProjects(input: WorkspaceProjectListRequest): Promise<WorkspaceProjectDirectoryResult> {
    await this.initialized;
    const request = WorkspaceProjectListRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    return WorkspaceProjectDirectoryResultSchema.parse({
      ok: true,
      directory: this.projectStorage().listInactive(request.userId),
    });
  }

  async archiveProject(input: WorkspaceProjectLifecycleRequest): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectLifecycleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().archive(request);
    if (project) this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse(project
      ? { ok: true, project }
      : { ok: false, code: "project_not_found" });
  }

  async restoreProject(input: WorkspaceProjectLifecycleRequest): Promise<WorkspaceProjectDefaultResult> {
    await this.initialized;
    const request = WorkspaceProjectLifecycleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().restore(request);
    const result = WorkspaceProjectDefaultResultSchema.parse(project === "conflict"
      ? { ok: false, code: "project_restore_conflict" }
      : project
        ? { ok: true, project: project.project, targets: project.targets }
        : { ok: false, code: "project_not_found" });
    if (result.ok) this.publishProjectSnapshot();
    if (result.ok && result.targets.length > 0) await this.armNextAlarm();
    return result;
  }

  async reorderProjects(
    input: WorkspaceProjectReorderRequest,
  ): Promise<WorkspaceProjectDirectoryResult> {
    await this.initialized;
    const request = WorkspaceProjectReorderRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const result = WorkspaceProjectDirectoryResultSchema.parse({
      ok: true,
      directory: this.projectStorage().reorder(request.userId, request.order.projectIds),
    });
    this.publishProjectSnapshot();
    return result;
  }

  async updateProjectPresentation(
    input: WorkspaceProjectUpdateRequest,
  ): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectUpdateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().updatePresentation(request);
    if (project !== false) this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse(project === false
      ? { ok: false, code: "project_not_found" }
      : { ok: true, project });
  }

  async updateProjectAudience(input: WorkspaceProjectAudienceRequest): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectAudienceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const activeMemberIds = await Promise.all(request.audience.participantUserIds.map(async (userId) => (
      await this.activeWorkspaceMember(request.workspaceId, userId) ? userId : null
    )));
    if (activeMemberIds.some((userId) => userId === null)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().updateAudience(request);
    if (project) this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse(project
      ? { ok: true, project }
      : { ok: false, code: "project_not_found" });
  }

  async prepareProjectMembership(
    input: WorkspaceProjectMembershipPrepareRequest,
  ): Promise<WorkspaceProjectMembershipPlanResult> {
    await this.initialized;
    const request = WorkspaceProjectMembershipPrepareRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const result = WorkspaceProjectMembershipPlanResultSchema.parse(
      this.projectStorage().prepareMembership(request),
    );
    if (result.ok) this.publishProjectSnapshot();
    return result;
  }

  async projectWorkstreamConstraints(
    input: WorkspaceProjectWorkstreamConstraintRequest,
  ): Promise<WorkspaceProjectWorkstreamConstraintResult> {
    await this.initialized;
    const request = WorkspaceProjectWorkstreamConstraintRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return WorkspaceProjectWorkstreamConstraintResultSchema.parse({
        activeProject: false,
        requiresWorkspaceScope: false,
      });
    }
    return WorkspaceProjectWorkstreamConstraintResultSchema.parse(
      this.projectStorage().workstreamConstraints(request.workstreamId),
    );
  }

  async finalizeProjectMembership(
    input: WorkspaceProjectMembershipSettleRequest,
  ): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectMembershipSettleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().finalizeMembership(request);
    if (project) this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse(project
      ? { ok: true, project }
      : { ok: false, code: "project_not_found" });
  }

  async cancelProjectMembership(
    input: WorkspaceProjectMembershipSettleRequest,
  ): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectMembershipSettleRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().cancelMembership(request);
    if (project) this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse(project
      ? { ok: true, project }
      : { ok: false, code: "project_not_found" });
  }

  async removeProjectMembership(
    input: WorkspaceProjectMembershipPrepareRequest,
  ): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectMembershipPrepareRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().removeMembership(
      request.userId,
      request.projectId,
      request.workstreamId,
    );
    if (project) this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse(project
      ? { ok: true, project }
      : { ok: false, code: "project_not_found" });
  }

  async addProjectDefaultResource(
    input: WorkspaceProjectDefaultResourceRequest,
  ): Promise<WorkspaceProjectDefaultResult> {
    await this.initialized;
    const request = WorkspaceProjectDefaultResourceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const result = WorkspaceProjectDefaultResultSchema.parse(
      this.projectStorage().addDefaultResource(request),
    );
    if (result.ok) this.publishProjectSnapshot();
    if (result.ok && result.targets.length > 0) await this.armNextAlarm();
    return result;
  }

  async removeProjectDefaultResource(
    input: WorkspaceProjectDefaultResourceRequest,
  ): Promise<WorkspaceProjectMutationResult> {
    await this.initialized;
    const request = WorkspaceProjectDefaultResourceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!await this.activeWorkspaceMember(request.workspaceId, request.userId)) {
      return { ok: false, code: "project_access_denied" };
    }
    const project = this.projectStorage().removeDefaultResource(request);
    if (project) this.publishProjectSnapshot();
    return WorkspaceProjectMutationResultSchema.parse(project
      ? { ok: true, project }
      : { ok: false, code: "project_not_found" });
  }

  async projectDefaultTargetCurrent(input: ProjectDefaultResourceQueueMessage): Promise<boolean> {
    await this.initialized;
    const request = ProjectDefaultResourceQueueMessageSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.projectStorage().defaultTargetCurrent(request);
  }

  async projectDefaultTargetActors(input: ProjectDefaultResourceQueueMessage): Promise<string[]> {
    await this.initialized;
    const request = ProjectDefaultResourceQueueMessageSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.projectStorage().defaultTargetActors(request);
  }

  async completeProjectDefaultTarget(input: ProjectDefaultResourceQueueMessage): Promise<boolean> {
    await this.initialized;
    const request = ProjectDefaultResourceQueueMessageSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.projectStorage().completeDefaultTarget(request);
  }

  async recordProjectDefaultTargetFailure(input: ProjectDefaultResourceQueueMessage): Promise<boolean> {
    await this.initialized;
    const request = ProjectDefaultResourceQueueMessageSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.projectStorage().recordDefaultTargetFailure(request, "resource_attach_failed");
  }

  async failProjectDefaultTarget(input: ProjectDefaultResourceQueueMessage): Promise<boolean> {
    await this.initialized;
    const request = ProjectDefaultResourceQueueMessageSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return this.projectStorage().failDefaultTarget(request, "project_no_active_participant");
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
    return ingestWorkspaceConnectorEvent(this.env, this.state.storage, request);
  }

  async connectorEvent(input: WorkspaceConnectorEventRequest): Promise<WorkspaceConnectorEvent | null> {
    await this.initialized;
    const request = WorkspaceConnectorEventRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceConnectorEvent(this.env, this.state.storage, request);
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
    return claimWorkspaceConnectorEvent(
      this.env,
      this.state.storage,
      request,
      legacyWorkflowContract,
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
    settleWorkspaceConnectorEvent(this.env, this.state.storage, request, legacyWorkflowContract);
  }

  /** Append one first-party activity-log event and all of its target edges atomically. */
  async recordActivityEvent(input: WorkspaceActivityEventInput): Promise<string> {
    await this.initialized;
    const request = WorkspaceActivityEventInputSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const eventId = recordWorkspaceActivityEvent(this.state.storage, request);
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
    return listWorkspaceActivityEvents(this.state.storage, request);
  }

  async latestActivityEventCursor(input: WorkspaceActivityEventCursorRequest): Promise<number> {
    await this.initialized;
    const request = WorkspaceActivityEventCursorRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return latestWorkspaceActivityEventCursor(this.state.storage);
  }

  async activityEventSource(input: WorkspaceActivityEventSourceRequest) {
    await this.initialized;
    const request = WorkspaceActivityEventSourceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceActivityEventSource(this.state.storage, request);
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
    const result = reserveWorkspaceDraftAttachments(this.state.storage, request);
    if (request.resourceIds.length > 0) {
      await this.refreshSchedule(request.workspaceId);
    }
    return result;
  }

  /** Idempotently release one failed or discarded Product preparation. */
  async releaseDraftAttachments(
    input: WorkspaceReleaseDraftAttachmentsRequest,
  ): Promise<WorkspaceReleaseDraftAttachmentsResult> {
    await this.initialized;
    const request = WorkspaceReleaseDraftAttachmentsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const released = releaseWorkspaceDraftAttachments(this.state.storage, request);
    // Always reconcile on replay: the preceding attempt may have committed the
    // delete and then lost the response while refreshing the single alarm.
    await this.refreshSchedule(request.workspaceId);
    return WorkspaceReleaseDraftAttachmentsResultSchema.parse({ released });
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
        `SELECT automation_id AS id, title AS name
           FROM automation_directory
          WHERE workspace_id = ? AND automation_id IN (${placeholders})`,
        request.workspaceId,
        ...subscriptionIds,
      ).toArray();
      for (const label of labels) {
        originLabels.set(label.id, truncateUtf16Safe(label.name, 120));
      }
    }
    let directoryChanged = false;
    const commonChanges = new Set<string>();
    const watchReconciliations = new Map<string, {
      authorityGeneration: number;
      projectionVersion: number;
      sourceHash: string;
    }>();
    const automationRunProjections = new Map<string, {
      automationId: string;
      runId: string;
      workstreamId: string;
      workstreamGeneration: number;
      sourceVersion: number;
      payloadHash: string;
      state: string;
      completedAt: number | null;
    }>();
    const viewerChanges = new Map<string, Set<string>>();
    const accepted: WorkspaceDirectoryApplyResult["accepted"] = [];
    for (const envelope of request.envelopes) {
      const applied = applyWorkspaceDirectoryEnvelope(this.state.storage, envelope, activeUsers, originLabels);
      directoryChanged = directoryChanged || applied.changed;
      if (applied.changed && envelope.effect.kind === "directory_common") {
        commonChanges.add(envelope.workstreamId);
      } else if (applied.changed && envelope.effect.kind === "directory_user") {
        if (applied.participantMembershipChanged) {
          // The facepile is the whole participant set. A join or leave that
          // only reached the affected viewer's socket would leave everyone
          // else's pile stale until reconnect.
          commonChanges.add(envelope.workstreamId);
        } else {
          const users = viewerChanges.get(envelope.workstreamId) ?? new Set<string>();
          users.add(envelope.effect.userId);
          viewerChanges.set(envelope.workstreamId, users);
        }
      }
      if (envelope.effect.kind === "directory_common") {
        const current = this.state.storage.sql.exec<{
          authority_generation: number;
          waterline: number;
          payload_hash: string;
        }>(`SELECT authority_generation, waterline, payload_hash
              FROM workspace_workstream_directory WHERE workstream_id = ?`,
        envelope.workstreamId).toArray()[0];
        // Reconcile on an exact replay as well as the first application. The
        // directory row and registration replacement are separate durable
        // transactions, so a failed connector lookup must be recoverable by
        // replaying the same outbox envelope.
        if (current
          && current.authority_generation === envelope.generation
          && current.waterline === envelope.sourceVersion
          && current.payload_hash === envelope.payloadHash) {
          watchReconciliations.set(envelope.workstreamId, {
            authorityGeneration: envelope.generation,
            projectionVersion: envelope.sourceVersion,
            sourceHash: envelope.payloadHash,
          });
          const durableAutomation = envelope.effect.automationSubscriptionId
            ? this.state.storage.sql.exec<{ one: number }>(
                `SELECT 1 AS one FROM automation_directory WHERE automation_id = ?`,
                envelope.effect.automationSubscriptionId,
              ).toArray()[0]
            : null;
          if (durableAutomation && envelope.effect.automationSubscriptionId && envelope.effect.automationRunId) {
            automationRunProjections.set(envelope.effect.automationRunId, {
              automationId: envelope.effect.automationSubscriptionId,
              runId: envelope.effect.automationRunId,
              workstreamId: envelope.workstreamId,
              workstreamGeneration: envelope.generation,
              sourceVersion: envelope.sourceVersion,
              payloadHash: envelope.payloadHash,
              state: envelope.effect.state,
              completedAt: epoch(envelope.effect.completedAt),
            });
          }
        }
      }
      accepted.push({ messageId: envelope.messageId, payloadHash: envelope.payloadHash });
    }
    await Promise.all([...watchReconciliations].map(([workstreamId, coordinate]) => (
      this.reconcileWorkstreamResourceRegistrations({
        workspaceId: request.workspaceId,
        workstreamId,
        ...coordinate,
      })
    )));
    // One automation's refusal must not fail the batch. These envelopes are
    // already accepted above — the directory rows are written, and this hop is
    // the copy each automation keeps of its own run. Letting a rejection
    // propagate out of the `Promise.all` fails every envelope in the batch,
    // which is then redelivered with the same payload and fails the same way:
    // one automation the agent cannot parse for stalls the directory for all
    // of them, permanently. Each projection is carried on its own and its
    // failure logged, so the automation that could not be reached is the only
    // one that falls behind, and it catches up on its next projection.
    const runProjections = await Promise.allSettled(
      [...automationRunProjections.values()].map(async (projection) => {
        const automationId = asAutomationId(projection.automationId);
        const agent = await durableObjectStubForWorkspace(
          this.env,
          this.env.AUTOMATION_AGENTS,
          request.workspaceId,
          automationAgentName(this.env.AVALON_REGION, asWorkspaceId(request.workspaceId), automationId),
        );
        await agent.applyRunProjection({
          schemaVersion: 1,
          workspaceId: request.workspaceId,
          ...projection,
        });
      }),
    );
    for (const settled of runProjections) {
      if (settled.status !== "rejected") continue;
      logWarn(this.env, "automation_run_projection_failed", {
        workspace_id: request.workspaceId,
        code: diagnosticErrorCode(settled.reason, "automation_run_projection_failed"),
      });
    }
    if (commonChanges.size > 0) {
      // A `directory_common` effect is the only writer of
      // `next_terminal_action_at`, and it arrives outside any alarm — off the
      // Queue — so a sandbox deadline created or moved here would otherwise
      // wait for an unrelated target to reconcile before anything armed it.
      await this.refreshTerminalSchedule();
    }
    if (request.envelopes.some((envelope) => (
      envelope.effect.kind === "directory_common"
      && (envelope.effect.resourceLinks?.length ?? 0) > 0
    ))) {
      await this.refreshSchedule(request.workspaceId);
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
   * Turn authoritative watched links into exact typed registrations. The work
   * stream projects only the link intent; WorkspaceDO resolves resource and
   * connector facts and uses the same replacement engine as automations.
   */
  private async reconcileWorkstreamResourceRegistrations(input: {
    workspaceId: string;
    workstreamId: string;
    authorityGeneration: number;
    projectionVersion: number;
    sourceHash: string;
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
        && connection?.status === "active"
        && manifest?.supportsWatches
        ? manifest.activityTriggers.filter((descriptor) => descriptor.resourceRelationships.some(
            (relationship) => relationship.resourceType === resource.resource_type,
          ))
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
        authorityGeneration: input.authorityGeneration,
        projectionVersion: input.projectionVersion,
        sourceHash: input.sourceHash,
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
    return WorkspaceDirectoryPageSchema.parse(listWorkspaceDirectory(this.state.storage, request));
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
       FROM workspace_workstream_directory directory
       LEFT JOIN workspace_workstream_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE directory.archived_at IS NULL
         AND directory.origin_type <> 'automation'
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
    });
  }

  /**
   * Resolve a generic member-visible filter once, inside the object that owns
   * the cross-work-stream index. The caller turns each returned work-stream id
   * into one Queue event; it never probes child objects to rediscover this
   * list.
   *
   * The notes the same filter selects come back beside them because they are
   * in this database too. They are counted here and archived here — see
   * `archiveNotesForBatch` — rather than fanned out, since a note has no object
   * of its own for an event to reach.
   */
  async batchUpdateTargets(input: WorkspaceDirectoryBatchTargetsRequest) {
    await this.initialized;
    const request = WorkspaceDirectoryBatchTargetsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return WorkspaceDirectoryBatchTargetsResultSchema.parse({
      items: workspaceBatchTargetIds(this.state.storage, request.userId, request.filter),
      noteIds: workspaceNoteBatchTargets(
        this.state.storage,
        request.workspaceId,
        request.userId,
        request.filter,
      ),
    });
  }

  /** Freeze one target set and return only the Queue events not yet published. */
  async beginWorkstreamBatchDispatch(input: WorkspaceBatchDispatchBeginRequest) {
    await this.initialized;
    const request = WorkspaceBatchDispatchBeginRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return beginWorkspaceBatchDispatch(this.state.storage, request);
  }

  /** Persist one successful Queue sendBatch chunk; redelivery is a no-op. */
  async advanceWorkstreamBatchDispatch(input: WorkspaceBatchDispatchAdvanceRequest) {
    await this.initialized;
    const request = WorkspaceBatchDispatchAdvanceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return advanceWorkspaceBatchDispatch(this.state.storage, request);
  }

  /**
   * Archive the note half of one frozen batch, exactly once per operation.
   *
   * The work-stream half is frozen as rows because each id has to survive a
   * partial Queue publication and be re-sent without re-selecting. Notes need
   * no such list: they are archived in one statement in this database, so the
   * only thing a retry can get wrong is *widening* — a note touched between the
   * failed attempt and the retry entering an open-ended range like "Last hour".
   * A single count on the dispatch row closes that, and a `NULL` there is the
   * whole of "no note archive has run for this operation".
   *
   * Fenced on the same request hash and user as the dispatch it belongs to, so
   * a second filter or a second person cannot reuse an operation id to archive
   * somebody else's notes under a receipt that already exists.
   */
  async archiveNotesForBatch(
    input: WorkspaceBatchNoteArchiveRequest,
  ): Promise<WorkspaceBatchNoteArchiveResult> {
    await this.initialized;
    const request = WorkspaceBatchNoteArchiveRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = archiveWorkspaceNotesForBatch(this.state.storage, request);
    // After the commit, and only for the call that did the archiving: the push
    // sends the list as it stands now, which a replay has already sent.
    if (!result.replayed && result.archivedNoteCount > 0) this.publishSidebarList("notes");
    return result;
  }

  /**
   * The title to show as a generated work stream's origin label.
   *
   * WorkstreamDO renders the summary and does not hold the automation's
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
  /** The workspace-shared template gallery, at each template's latest version. */
  async listAutomationTemplates(
    input: { workspaceId: string },
  ): Promise<WorkspaceAutomationTemplateList> {
    await this.initialized;
    const workspaceId = IdSchema.parse(input.workspaceId);
    this.assertWorkspace(workspaceId);
    return listWorkspaceAutomationTemplates(this.state.storage, workspaceId);
  }

  /**
   * Whether this person owns an active template with this id.
   *
   * A preflight, so the service can answer 404 before it validates a draft's
   * connectors. Without it, adding a version to somebody else's template
   * answers with a connector error — which both changes the endpoint's
   * contract and tells a caller about connector state they have no claim on.
   * The write still fences on ownership; this only decides what is said.
   */
  async automationTemplateOwnership(
    input: WorkspaceAutomationTemplateOwnershipRequest,
  ): Promise<WorkspaceAutomationTemplateOwnership> {
    await this.initialized;
    const request = WorkspaceAutomationTemplateOwnershipRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceAutomationTemplateOwnership(this.state.storage, request);
  }

  /** Publish a template and its first version, or neither. */
  async publishAutomationTemplate(
    input: WorkspaceAutomationTemplatePublishRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceAutomationTemplatePublishRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    publishWorkspaceAutomationTemplate(this.state.storage, request);
  }

  /**
   * Add the next version of a template the caller owns.
   *
   * The version number is read and bumped in one critical section, which two
   * separate statements through the runtime facade could not do: both readers
   * saw the same number and the unique constraint refused the second write.
   */
  async addAutomationTemplateVersion(
    input: WorkspaceAutomationTemplateVersionRequest,
  ): Promise<WorkspaceAutomationTemplateVersionResult> {
    await this.initialized;
    const request = WorkspaceAutomationTemplateVersionRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return addWorkspaceAutomationTemplateVersion(this.state.storage, request);
  }

  /**
   * Re-derive the alarm after a typed method moved an outbox due time.
   *
   * `executeRuntimeSql` does this for any facade statement that writes an
   * alarm-source table; a typed method that writes `note_privacy_change_outbox`
   * or `note_resource_deletion_outbox` owes the alarm the same refresh, or the
   * pass those rows are due for never wakes.
   */
  private refreshScheduleAfterWrite(workspaceId: string): void {
    this.state.waitUntil(this.refreshSchedule(workspaceId).catch((error: unknown) => {
      // Swallowed silently, a failed refresh here leaves a schedule dark until
      // something else reconciles; this line is how anyone finds out the
      // alarm's own end-of-drain backstop was needed.
      logWarn(this.env, "workspace_schedule_auto_refresh_failed", {
        workspace_id: workspaceId,
        code: error instanceof Error ? error.message : "unknown_error",
      });
    }));
  }

  /** One note and its whole transcript, behind the requested access fence. */
  async noteWithSegments(input: WorkspaceNoteStateRequest): Promise<WorkspaceNoteState> {
    await this.initialized;
    const request = WorkspaceNoteStateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceNoteState(this.state.storage, request);
  }

  /** The notes the sidebar opens with, from the statement the socket also serves. */
  async listNoteSidebar(input: WorkspaceNoteSidebarRequest): Promise<WorkspaceNoteSidebarList> {
    await this.initialized;
    const request = WorkspaceNoteSidebarRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceNoteSidebar(
      this.state.storage,
      request.workspaceId,
      request.userId,
      Math.min(request.limit, SIDEBAR_LIST_LIMIT),
      request.before,
    );
  }

  /**
   * Apply an owner's edit, deciding `becamePrivate` from the row the write
   * replaced — and recording the workspace-to-personal transition in the
   * privacy outbox within the same transaction. The D1 trigger that used to
   * write that row did not travel to this object at cutover, so the "now
   * private" notices had silently stopped.
   */
  async updateNote(input: WorkspaceNoteUpdateRequest): Promise<WorkspaceNoteUpdateResult> {
    await this.initialized;
    const request = WorkspaceNoteUpdateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = updateWorkspaceNote(this.state.storage, request);
    if (result.outcome === "updated") this.publishSidebarList("notes");
    if (result.becamePrivate) this.refreshScheduleAfterWrite(request.workspaceId);
    return result;
  }

  /**
   * Archive, or say why not: a live recording refuses distinctly, because
   * archiving under it would 404 the next segment save while capture kept
   * running. As a write and a fallback read through the facade the two
   * refusals were classified a round trip apart.
   */
  async archiveNote(input: WorkspaceNoteArchiveRequest): Promise<WorkspaceNoteArchiveResult> {
    await this.initialized;
    const request = WorkspaceNoteArchiveRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = archiveWorkspaceNote(this.state.storage, request);
    if (result.outcome === "archived") this.publishSidebarList("notes");
    return result;
  }

  /**
   * Store one transcript segment: fence, duplicate check, sequence allocation
   * and both writes in one critical section, with a replayed save answered by
   * the stored segment rather than a constraint error.
   */
  async appendNoteSegment(
    input: WorkspaceNoteSegmentAppendRequest,
  ): Promise<WorkspaceNoteSegmentAppendResult> {
    await this.initialized;
    const request = WorkspaceNoteSegmentAppendRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = appendWorkspaceNoteSegment(this.state.storage, request);
    if (result.outcome === "appended") this.publishSidebarList("notes");
    return result;
  }

  /** Land a generated briefing only if the cursor pair it was read against still holds. */
  async commitNoteGeneration(
    input: WorkspaceNoteGenerationCommitRequest,
  ): Promise<WorkspaceNoteGenerationCommitResult> {
    await this.initialized;
    const request = WorkspaceNoteGenerationCommitRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = commitWorkspaceNoteGeneration(this.state.storage, request);
    if (result.outcome === "committed") this.publishSidebarList("notes");
    return result;
  }

  /** Which of these note resources the principal may currently see; reads only. */
  async visibleNoteResourceIds(
    input: WorkspaceNoteVisibilityRequest,
  ): Promise<WorkspaceNoteVisibilityResult> {
    await this.initialized;
    const request = WorkspaceNoteVisibilityRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return visibleWorkspaceNoteResourceIds(this.state.storage, request);
  }

  /** The privacy transitions the notifier has not yet delivered. */
  async pendingNotePrivacyTransitions(
    input: WorkspaceNotePrivacyPendingRequest,
  ): Promise<WorkspaceNotePrivacyPendingResult> {
    await this.initialized;
    const request = WorkspaceNotePrivacyPendingRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return pendingWorkspaceNotePrivacyTransitions(this.state.storage, request);
  }

  /** Settle one delivered privacy transition; a replay learns it was not pending. */
  async markNotePrivacyTransitionProcessed(
    input: WorkspaceNotePrivacyMarkRequest,
  ): Promise<WorkspaceNotePrivacyMarkResult> {
    await this.initialized;
    const request = WorkspaceNotePrivacyMarkRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = markWorkspaceNotePrivacyTransitionProcessed(this.state.storage, request);
    if (result.outcome === "processed") this.refreshScheduleAfterWrite(request.workspaceId);
    return result;
  }

  /** The note R2 objects still waiting for cleanup, one pass's worth. */
  async noteResourceDeletionOutbox(
    input: WorkspaceNoteDeletionOutboxRequest,
  ): Promise<WorkspaceNoteDeletionOutbox> {
    await this.initialized;
    const request = WorkspaceNoteDeletionOutboxRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceNoteResourceDeletionOutbox(this.state.storage);
  }

  /** Retire one cleanup entry once its R2 objects are gone. */
  async retireNoteResourceDeletion(
    input: WorkspaceNoteDeletionRetireRequest,
  ): Promise<WorkspaceNoteDeletionRetireResult> {
    await this.initialized;
    const request = WorkspaceNoteDeletionRetireRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = retireWorkspaceNoteResourceDeletion(this.state.storage, request);
    if (result.outcome === "retired") this.refreshScheduleAfterWrite(request.workspaceId);
    return result;
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
   * Settle the status reaction against the emoji the caller removed.
   *
   * Answers `raced` when another transition — a working tick, or the terminal
   * outcome — moved `reaction_current` while the caller was talking to Slack.
   * The decision comes from the `RETURNING` witness, not a row count.
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
    this.state.waitUntil(this.refreshSchedule(workspaceId).catch((error: unknown) => {
      logWarn(this.env, "workspace_schedule_auto_refresh_failed", {
        workspace_id: workspaceId,
        code: error instanceof Error ? error.message : "unknown_error",
      });
    }));
  }

  /** Create a memory scope if it is missing; answer with the stored row either way. */
  async ensureMemoryScope(input: WorkspaceMemoryScopeEnsureRequest): Promise<WorkspaceMemoryScope> {
    await this.initialized;
    const request = WorkspaceMemoryScopeEnsureRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return ensureWorkspaceMemoryScope(this.state.storage, request);
  }

  /** The FTS leg of hybrid memory retrieval, over the caller's authorized scopes. */
  async searchMemoryItemsFts(
    input: WorkspaceMemoryFtsSearchRequest,
  ): Promise<WorkspaceMemoryCandidateList> {
    await this.initialized;
    const request = WorkspaceMemoryFtsSearchRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return searchWorkspaceMemoryItemsFts(this.state.storage, request);
  }

  /**
   * Live items among the requested ids, restricted to the given scopes.
   *
   * The scope list is the service's re-resolved authorization union: what this
   * method enforces is that no candidate outside it is answered, so a scope
   * revoked mid-search cannot leak rows through the ranking.
   */
  async canonicalMemoryItems(
    input: WorkspaceMemoryCanonicalItemsRequest,
  ): Promise<WorkspaceMemoryItemList> {
    await this.initialized;
    const request = WorkspaceMemoryCanonicalItemsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return canonicalWorkspaceMemoryItems(this.state.storage, request);
  }

  /** Bump non-authoritative access counters; a lost update costs nothing. */
  async recordMemoryItemAccess(input: WorkspaceMemoryAccessRecordRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceMemoryAccessRecordRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    recordWorkspaceMemoryItemAccess(this.state.storage, request);
  }

  /** One item with its scope kind, live or not — the write path's read. */
  async memoryItemForWrite(
    input: WorkspaceMemoryItemForWriteRequest,
  ): Promise<WorkspaceMemoryItemForWriteResult> {
    await this.initialized;
    const request = WorkspaceMemoryItemForWriteRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceMemoryItemForWrite(this.state.storage, request);
  }

  /**
   * A prose-memory mutation receipt by idempotency key, so the service can
   * answer a replay before it authorizes anything — the order the tool path
   * has always had.
   */
  async memoryMutationReceipt(
    input: WorkspaceMemoryReceiptRequest,
  ): Promise<WorkspaceMemoryReceiptResult> {
    await this.initialized;
    const request = WorkspaceMemoryReceiptRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceMemoryMutationReceipt(this.state.storage, request);
  }

  /**
   * Add one durable memory: the item, its audit record, and its
   * embedding-outbox intent in one transaction, with the receipt decided
   * inside it. The facade path ran these as a D1 batch and re-read the
   * receipt out-of-band when the batch lost a race.
   */
  async addMemoryItem(input: WorkspaceMemoryAddRequest): Promise<WorkspaceMemoryAddResult> {
    await this.initialized;
    const request = WorkspaceMemoryAddRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = addWorkspaceMemoryItem(this.state.storage, request, uuidV7());
    if (result.outcome === "added") this.refreshScheduleAfterMemoryOutboxWrite(request.workspaceId);
    return result;
  }

  /**
   * Replace a durable memory at an expected revision. A refusal is an
   * outcome, not a throw: `revision_conflict` reaches the service with its
   * HTTP-mapped error intact rather than as a bare RPC message.
   */
  async updateMemoryItem(input: WorkspaceMemoryUpdateRequest): Promise<WorkspaceMemoryWriteResult> {
    await this.initialized;
    const request = WorkspaceMemoryUpdateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = updateWorkspaceMemoryItem(this.state.storage, request, uuidV7());
    if (result.outcome === "written") this.refreshScheduleAfterMemoryOutboxWrite(request.workspaceId);
    return result;
  }

  /** Reversibly invalidate a durable memory at an expected revision. */
  async invalidateMemoryItem(
    input: WorkspaceMemoryInvalidateRequest,
  ): Promise<WorkspaceMemoryWriteResult> {
    await this.initialized;
    const request = WorkspaceMemoryInvalidateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const result = invalidateWorkspaceMemoryItem(this.state.storage, request, uuidV7());
    if (result.outcome === "written") this.refreshScheduleAfterMemoryOutboxWrite(request.workspaceId);
    return result;
  }

  /**
   * Re-derive the workspace alarm after a memory write left an embedding
   * intent in `memory_index_outbox`.
   *
   * `memory_index_outbox` is on `WORKSPACE_ALARM_SOURCE_TABLES`, so while
   * these writes were generic statements `executeRuntimeSql` armed the
   * `memory_index` maintenance target for them. A typed method gets no such
   * thing for free, and without this a memory written into a quiet workspace
   * would sit unprojected until some unrelated mutation happened to reconcile
   * the schedule. Same `waitUntil`-and-log shape as there: the alarm's own
   * end-of-drain refresh is the backstop, and this line is how anyone finds
   * out the backstop was needed.
   *
   * The outbox claim, completion, and retry methods deliberately do not call
   * this. Their only caller is `processMemoryIndexOutbox`, reached only as the
   * `memory_index` maintenance target — inside this object's own alarm drain,
   * whose statements go through the local executor and never carried the
   * auto-refresh either. A reconcile started there would race the drain's own
   * `schedule_reconcile` with a target list read before the rest of the drain
   * advanced its rows.
   */
  private refreshScheduleAfterMemoryOutboxWrite(workspaceId: string): void {
    this.state.waitUntil(this.refreshSchedule(workspaceId).catch((error: unknown) => {
      logWarn(this.env, "workspace_schedule_auto_refresh_failed", {
        workspace_id: workspaceId,
        code: error instanceof Error ? error.message : "unknown_error",
      });
    }));
  }

  /** Embedding-outbox rows due for projection, oldest first. */
  async dueMemoryIndexOutbox(
    input: WorkspaceMemoryOutboxDueRequest,
  ): Promise<WorkspaceMemoryOutboxDueList> {
    await this.initialized;
    const request = WorkspaceMemoryOutboxDueRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return dueWorkspaceMemoryIndexOutbox(this.state.storage, request);
  }

  /** Claim one due outbox row for a lease; the witness is the returned token. */
  async claimMemoryIndexOutboxRow(
    input: WorkspaceMemoryOutboxClaimRequest,
  ): Promise<WorkspaceMemoryOutboxClaimResult> {
    await this.initialized;
    const request = WorkspaceMemoryOutboxClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return claimWorkspaceMemoryIndexOutboxRow(this.state.storage, request);
  }

  /** Settle a claimed outbox row as projected. */
  async completeMemoryIndexOutboxRow(input: WorkspaceMemoryOutboxCompleteRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceMemoryOutboxCompleteRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    completeWorkspaceMemoryIndexOutboxRow(this.state.storage, request);
  }

  /** Return a claimed outbox row to pending with its backoff and last error. */
  async retryMemoryIndexOutboxRow(input: WorkspaceMemoryOutboxRetryRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceMemoryOutboxRetryRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    retryWorkspaceMemoryIndexOutboxRow(this.state.storage, request);
  }

  /** What the vector index should hold for one item, read at projection time. */
  async memoryIndexProjectionSource(
    input: WorkspaceMemoryProjectionSourceRequest,
  ): Promise<WorkspaceMemoryProjectionSourceResult> {
    await this.initialized;
    const request = WorkspaceMemoryProjectionSourceRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return workspaceMemoryIndexProjectionSource(this.state.storage, request);
  }

  /** One durable table and its ordered columns, invalidated or not. */
  async memoryTableWithColumns(
    input: WorkspaceMemoryTableRequest,
  ): Promise<WorkspaceMemoryTableResult> {
    await this.initialized;
    const request = WorkspaceMemoryTableRequestSchema.parse(input);
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
    const request = WorkspaceMemoryReceiptRequestSchema.parse(input);
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
    const request = WorkspaceMemoryTableCreateRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return createWorkspaceMemoryTable(this.state.storage, request);
  }

  /** Record the create receipt for an idempotent reopen of a standing table. */
  async recordMemoryTableOpenReceipt(
    input: WorkspaceMemoryTableOpenReceiptRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceMemoryTableOpenReceiptRequestSchema.parse(input);
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

  /**
   * The title to show as a generated work stream's origin label.
   *
   * WorkstreamDO renders the summary and does not hold the automation's
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
  async automationOriginLabel(
    input: WorkspaceAutomationOriginLabelRequest,
  ): Promise<WorkspaceAutomationOriginLabel> {
    await this.initialized;
    const request = WorkspaceAutomationOriginLabelRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{ title: string }>(
      `SELECT title FROM automation_directory
        WHERE automation_id = ? AND workspace_id = ? AND lifecycle <> 'deleted'`,
      request.automationId,
      request.workspaceId,
    ).toArray()[0];
    return WorkspaceAutomationOriginLabelSchema.parse({ title: row?.title ?? null });
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

  /** The highest point this schedule has committed to covering. */
  async latestDigestCursor(input: WorkspaceDigestCursorRequest): Promise<WorkspaceDigestCursor> {
    await this.initialized;
    const request = WorkspaceDigestCursorRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return latestWorkspaceDigestCursor(this.state.storage, request);
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

  /** Record which hidden work stream this occurrence executes in. */
  async recordDigestDeliveryWorkstream(
    input: WorkspaceDigestDeliveryWorkstreamRequest,
  ): Promise<void> {
    await this.initialized;
    const request = WorkspaceDigestDeliveryWorkstreamRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    recordWorkspaceDigestDeliveryWorkstream(this.state.storage, request);
  }

  /** The launch succeeded: the claim graduates from `planned` to `running`, or says it could not. */
  async markDigestDeliveryRunning(
    input: WorkspaceDigestDeliveryRunningRequest,
  ): Promise<WorkspaceDigestRunningResult> {
    await this.initialized;
    const request = WorkspaceDigestDeliveryRunningRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return markWorkspaceDigestDeliveryRunning(this.state.storage, request);
  }

  /** Undo a claim whose launch never started, so the scheduler's retry gets another go. */
  async releaseDigestDeliveryClaim(
    input: WorkspaceDigestReleaseClaimRequest,
  ): Promise<WorkspaceDigestReleaseClaimResult> {
    await this.initialized;
    const request = WorkspaceDigestReleaseClaimRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    return releaseWorkspaceDigestDeliveryClaim(this.state.storage, request);
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

  /** Keep what the run wrote, before delivery decides what happens to it. */
  async recordDigestSummary(input: WorkspaceDigestSummaryRequest): Promise<void> {
    await this.initialized;
    const request = WorkspaceDigestSummaryRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    recordWorkspaceDigestSummary(this.state.storage, request);
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
    this.state.waitUntil(this.refreshSchedule(workspaceId).catch((error: unknown) => {
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
    return workspaceDirectoryVisible(this.state.storage, request.userId, request.workstreamId);
  }

  async readableWorkstreamIds(
    input: WorkspaceDirectoryReadableIdsRequest,
  ): Promise<WorkspaceDirectoryReadableIdsResult> {
    await this.initialized;
    const request = WorkspaceDirectoryReadableIdsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{ workstream_id: string }>(
      `SELECT directory.workstream_id FROM workspace_workstream_directory directory
       LEFT JOIN workspace_workstream_viewers viewer
         ON viewer.workstream_id = directory.workstream_id
        AND viewer.user_id = ?
        AND viewer.authority_generation = directory.authority_generation
       WHERE directory.workstream_id IN (SELECT value FROM json_each(?))
         AND (directory.scope = 'workspace' OR viewer.is_participant = 1)
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
    return row ? mapDirectoryWorkstream(this.state.storage.sql, row, request.workspaceId) : null;
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
    return row ? mapDirectoryWorkstream(this.state.storage.sql, row, request.workspaceId) : null;
  }

  async pinWorkstream(input: WorkspaceDirectoryPinRequest): Promise<{ items: Workstream[] }> {
    await this.initialized;
    const request = WorkspaceDirectoryPinRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    if (!workspaceDirectoryVisible(this.state.storage, request.userId, request.workstreamId)) {
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
      if (inserted) advanceWorkspaceDirectoryVersion(this.state.storage, now);
      return inserted;
    });
    if (changed) await this.publishDirectorySync(request.workspaceId);
    return { items: mapDirectoryWorkstreams(
      this.state.storage.sql,
      pinnedWorkspaceDirectoryRows(this.state.storage, request.userId, true),
      request.workspaceId,
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
          WHERE user_id = ? AND workstream_id = ? RETURNING workstream_id`,
        request.userId,
        request.workstreamId,
      ).toArray().length === 1;
      if (removed) {
        rewriteWorkspacePinOrder(this.state.storage, request.userId, [], now);
        advanceWorkspaceDirectoryVersion(this.state.storage, now);
      }
      return removed;
    });
    if (changed) await this.publishDirectorySync(request.workspaceId);
    return { items: mapDirectoryWorkstreams(
      this.state.storage.sql,
      pinnedWorkspaceDirectoryRows(this.state.storage, request.userId, true),
      request.workspaceId,
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
      rewriteWorkspacePinOrder(this.state.storage, request.userId, request.workstreamIds, now);
      advanceWorkspaceDirectoryVersion(this.state.storage, now);
    });
    await this.publishDirectorySync(request.workspaceId);
    return { items: mapDirectoryWorkstreams(
      this.state.storage.sql,
      pinnedWorkspaceDirectoryRows(this.state.storage, request.userId, true),
      request.workspaceId,
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

  /**
   * The fence a delivery into a work stream writes behind.
   *
   * Read from the directory rather than from the room itself: the directory is
   * what a re-authorization bumps, so a delivery that read the room would learn
   * about the change only after writing into it. Returns null for a work stream
   * this workspace does not have, which a caller must treat as "do not write"
   * rather than "generation 1".
   */
  async workstreamDeliveryAuthority(
    input: z.input<typeof WorkspaceDirectoryDeliveryAuthorityRequestSchema>,
  ): Promise<z.infer<typeof WorkspaceDirectoryDeliveryAuthoritySchema> | null> {
    await this.initialized;
    const request = WorkspaceDirectoryDeliveryAuthorityRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{
      authority_generation: number;
      archived_at: number | null;
    }>(
      `SELECT authority_generation, archived_at
         FROM workspace_workstream_directory WHERE workstream_id = ?`,
      request.workstreamId,
    ).toArray()[0];
    return row ? WorkspaceDirectoryDeliveryAuthoritySchema.parse({
      authorityGeneration: row.authority_generation,
      archived: row.archived_at !== null,
    }) : null;
  }

  /**
   * Reveal an automation occurrence's own work stream in the sidebar.
   *
   * Creates nothing. The run finished in a work stream that already exists and
   * already holds its whole transcript; every listing query hides it because
   * `origin_type = 'automation'`, and this stops that one row being hidden. A
   * reader who takes the disposition's name literally will look for a creation
   * path that is deliberately absent.
   *
   * Idempotent because it is a boolean: a delivery retry after a crash has
   * nothing to duplicate.
   */
  async exposeAutomationRunWorkstream(
    input: z.input<typeof WorkspaceDirectoryExposeRunRequestSchema>,
  ): Promise<{ exposed: boolean; outcomeCode: string }> {
    await this.initialized;
    const request = WorkspaceDirectoryExposeRunRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const row = this.state.storage.sql.exec<{
      origin_type: string;
      archived_at: number | null;
    }>(
      `SELECT origin_type, archived_at
         FROM workspace_workstream_directory WHERE workstream_id = ?`,
      request.workstreamId,
    ).toArray()[0];
    if (!row) return { exposed: false, outcomeCode: "workstream_not_found" };
    // Only a run's own work stream. Exposing anything else would mean this RPC
    // could unhide a room whose visibility somebody decided deliberately.
    if (row.origin_type !== "automation") {
      return { exposed: false, outcomeCode: "workstream_not_an_automation_run" };
    }
    // An archived run stays archived: a person archives an exposed run like any
    // other work stream, and a later occurrence must not undo that.
    if (row.archived_at !== null) return { exposed: false, outcomeCode: "workstream_archived" };
    this.state.storage.sql.exec(
      request.scope === null
        ? `UPDATE workspace_workstream_directory
              SET automation_exposed = 1
            WHERE workstream_id = ?`
        : `UPDATE workspace_workstream_directory
              SET automation_exposed = 1, scope = ?
            WHERE workstream_id = ?`,
      ...(request.scope === null
        ? [request.workstreamId]
        : [request.scope, request.workstreamId]),
    );
    return { exposed: true, outcomeCode: "workstream_exposed" };
  }

  /** Every automation this work stream owns, whatever its lifecycle. */
  async automationsOwnedByWorkstream(
    input: z.input<typeof WorkspaceDirectoryOwnedAutomationsRequestSchema>,
  ): Promise<z.infer<typeof WorkspaceDirectoryOwnedAutomationsSchema>> {
    await this.initialized;
    const request = WorkspaceDirectoryOwnedAutomationsRequestSchema.parse(input);
    this.assertWorkspace(request.workspaceId);
    const rows = this.state.storage.sql.exec<{ automation_id: string; lifecycle: string }>(
      `SELECT automation_id, lifecycle FROM automation_directory
        WHERE owning_workstream_id = ? ORDER BY automation_id`,
      request.workstreamId,
    ).toArray();
    return WorkspaceDirectoryOwnedAutomationsSchema.parse({
      automations: rows.map((row) => ({
        automationId: row.automation_id,
        lifecycle: row.lifecycle,
      })),
    });
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
    return this.state.storage.sql.exec<{
      automation_id: string;
      lifecycle: "draft" | "activating" | "active" | "paused";
      title: string;
      description: string;
      scope: "personal" | "workspace";
      next_run_at: number | null;
      attention_code: string | null;
      projected_at: number;
    }>(`SELECT automation_id, lifecycle, title, description, scope, next_run_at,
              attention_code, projected_at
          FROM automation_directory
         WHERE workspace_id = ? AND lifecycle <> 'deleted'
           AND (scope = 'workspace' OR author_user_id = ?)
         ORDER BY title COLLATE NOCASE, automation_id
         LIMIT ?`, workspaceId, userId, SIDEBAR_LIST_LIMIT).toArray().map((row) => ({
      id: row.automation_id,
      name: row.title || "New automation",
      description: row.description,
      emailAddress: null,
      scope: row.scope,
      status: row.lifecycle === "draft"
        ? "draft"
        : row.lifecycle === "paused"
          ? "paused"
          : row.attention_code ? "error" : "active",
      attention: automationAttention(row.attention_code),
      nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at).toISOString(),
      lastRunAt: null,
      updatedAt: new Date(row.projected_at).toISOString(),
      updateAvailable: false,
    }));
  }

  private listSidebarNotes(
    workspaceId: string,
    userId: string,
  ): { items: NoteSummary[]; nextCursor: string | null } {
    return workspaceNoteSidebar(this.state.storage, workspaceId, userId, SIDEBAR_LIST_LIMIT);
  }


  /** Push the current row; missed intermediate rows are intentionally irrelevant. */
  private async publishWorkstreamState(workstreamId: string, targetUserId?: string): Promise<void> {
    const occurredAt = new Date().toISOString();
    // Viewer-independent: one query for every subscribed socket, not one per socket.
    const preview = loadParticipantPreviews(this.state.storage.sql, [workstreamId]).get(workstreamId);
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
        && (row.origin_type !== "automation" || row.automation_exposed === 1)
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
        workstream: visible ? directoryWorkstream(row, attachment.workspaceId, preview) : null,
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
      workstreams: listWorkspaceDirectory(this.state.storage, {
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
        ...this.listSidebarNotes(attachment.workspaceId, attachment.userId),
      },
      projects: this.projectSnapshot(attachment.userId),
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
      // The note push carries its cursor so a reader who has paged past the
      // first screen can tell a complete list from its head and merge rather
      // than truncate back to one page.
      const page = list === "automations"
        ? { items: this.listSidebarAutomations(attachment.workspaceId, attachment.userId) }
        : this.listSidebarNotes(attachment.workspaceId, attachment.userId);
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
   * Re-send both project lists to every subscribed socket, shaped for its user.
   *
   * Project presentation, audience, membership, resource, lifecycle, and order
   * all share the WorkspaceDO project waterline. Sending the complete pair
   * means an audience removal is represented by absence for the removed person,
   * and a reconnect can install exactly the same authoritative state.
   */
  private publishProjectSnapshot(): void {
    const occurredAt = new Date().toISOString();
    // An open workspace socket is the authorization. Access revocation closes
    // it through the one shared revocation path; do not add a D1 read here.
    for (const socket of this.state.getWebSockets()) {
      const attachment = readAttachment(socket);
      if (!attachment?.subscribed) continue;
      try {
        socket.send(JSON.stringify(WorkspaceProjectSnapshotEventSchema.parse({
          type: "workspace_project_snapshot",
          occurredAt,
          projects: this.projectSnapshot(attachment.userId),
        })));
      } catch {
        // Reconnect receives this same snapshot in the subscribe payload.
      }
    }
  }

  private projectSnapshot(userId: string): ProjectSnapshot {
    return {
      active: this.projectStorage().list(userId),
      inactive: this.projectStorage().listInactive(userId),
    };
  }

  private async publishDirectorySync(workspaceId: string): Promise<void> {
    const placementAffinity = this.placementAffinity();
    if (!placementAffinity) throw new Error("workspace_object_placement_affinity_missing");
    await this.publishSync(["workstream_directory"], workspaceId, placementAffinity);
  }

  private productStorage(): WorkspaceProductStorage {
    return new WorkspaceProductStorage(this.state.storage);
  }

  private projectStorage(): WorkspaceProjectStorage {
    return new WorkspaceProjectStorage(this.state.storage);
  }

  private async activeWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
    return Boolean(await this.env.DB.prepare(
      `SELECT 1 FROM workspace_members
        WHERE workspace_id = ? AND user_id = ? AND status = 'active' LIMIT 1`,
    ).bind(workspaceId, userId).first());
  }

  private reapExpiredActivityEvents(now: number): void {
    reapExpiredWorkspaceActivityEvents(this.state.storage, now);
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
    removeLegacyAutomationSchema(this.state.storage);
    // A workspace born on the new build has no legacy authority to import. It
    // starts past the campaign fence; only carried objects require the
    // explicit audit/import/cleanup RPC before authoring is admitted.
    this.state.storage.sql.exec(
      `INSERT INTO automation_cutover_campaign
         (id, workspace_id, state, source_hash, source_witness_json,
          cursor_json, completed_at, updated_at)
       VALUES (1, ?, 'completed', 'fresh', '{}', '{}', ?, ?)`,
      workspaceId,
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
            AND member.status = 'active' AND workspace.region = ?
            AND workspace.abandoned_at IS NULL`,
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
      analyticsWorkspaceId: role.analytics_workspace_id ?? null,
    } : null;
  }
}
