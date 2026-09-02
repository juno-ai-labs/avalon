import {
  IdSchema,
} from "@rally/contracts";

import { WorkspaceDoContent } from "./workspace-do-content";
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

/**
 * `WorkspaceDO`'s connection surface: connector OAuth attempts, webhook receipts,
 * Terminal network policy, transcription sessions, resources, and Slack.
 *
 * One link of the `WorkspaceDO` chain; `workspace-do-core.ts` explains it.
 */
export abstract class WorkspaceDoConnections extends WorkspaceDoContent {

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
}
