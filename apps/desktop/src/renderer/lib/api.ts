import { MessageIssueReceiptSchema, type CreateMessageIssue, type MessageIssueReceipt } from '@rally/contracts/message-issues';
import { connectorAuthorizationStatus } from '@rally/contracts';
import { SidekickDelegatesResultSchema, SidekickDelegationMutationResultSchema } from '@rally/contracts';

import { ManagedScopeGrantsSchema, RevokeScopeGrantSchema, ScopeGrantMutationResultSchema } from "@rally/contracts/scope-grants";
import { ScopeSharingOptionsSchema, ScopeInvitationsListSchema, ScopeInvitationResultSchema, type ScopeGrantTarget, type CreateScopeInvitations } from "@rally/contracts/scope-grants";
import { WorkspaceRelationshipSchema, PromoteWorkspaceGuestSchema } from "@rally/contracts/scope-grants";
import { MemberPreferencesSchema, MemoryForgetResponseSchema, MemoryReviewSchema, PersonalSystemPromptSchema, type MemoryForgetResponse, type MemoryReview, type MemberPreferences, type MemberPreferencesUpdate } from "@rally/contracts";
import { WorkspaceDepartureSchema, type WorkspaceDeparture, type WorkspaceDepartureOutcome } from "@rally/contracts";
import { WebPushConfigurationSchema, type RegisterPushDeviceRequest } from "@rally/contracts/push-notifications";
import { AccountOnboardingSchema, OrganizationNameSuggestionSchema, UpdateAccountOnboardingSchema, type AccountOnboarding, type OrganizationNameSuggestion, type UpdateAccountOnboarding } from "@rally/contracts";

import { SupportAccessSchema, type SupportAccess } from "@rally/contracts";
import { UserTimezoneSchema, type UserTimezone } from "@rally/contracts";

import {
  CanvasDetailSchema,
  CreatedCanvasSchema,
  type CanvasAudienceUpdate,
  type CanvasDetail,
  type CreateCanvasRequest,
  type CreatedCanvas,
  AutomationDetailSchema as WireAutomationDetailSchema,
  AutomationExecutionPrincipalClaimSchema,
  AutomationRunSchema as WireAutomationRunSchema,
  AutomationSummarySchema as WireAutomationSummarySchema,
  ClientFeatureFlagsSchema as WireClientFeatureFlagsSchema,
  ConnectionSchema as WireConnectionSchema,
  CustomMcpConnectionSettingsSchema as WireCustomMcpConnectionSettingsSchema,
  GitHubRepositoryAccessSettingsSchema as WireGitHubRepositoryAccessSettingsSchema,
  ConnectorOAuthAttemptSchema as WireConnectorOAuthAttemptSchema,
  ConnectorOAuthStartSchema as WireConnectorOAuthStartSchema,
  ConnectorResourceAuthorizationStartSchema as WireConnectorResourceAuthorizationStartSchema,
  CursorPageSchema,
  type ParticipantSchema as WireParticipantSchema,
  PendingWorkspaceInvitationSchema as WirePendingWorkspaceInvitationSchema,
  ResourceSchema as WireResourceSchema,
  WorkstreamResourceSchema as WireWorkstreamResourceSchema,
  type ToolInvocationSchema as WireToolInvocationSchema,
  type ViewerSchema as WireViewerSchema,
  WorkspaceMemberSchema as WireWorkspaceMemberSchema,
  WorkspaceInvitationPreviewSchema as WireWorkspaceInvitationPreviewSchema,
  WorkspaceInvitationSchema as WireWorkspaceInvitationSchema,
  WorkspaceInviteeSchema,
  type WorkspaceInvitee,
  WorkspaceSchema as WireWorkspaceSchema,
  TerminalWorkspaceSettingsSchema as WireTerminalWorkspaceSettingsSchema,
  TerminalNetworkPolicyPreviewSchema as WireTerminalNetworkPolicyPreviewSchema,
  WorkstreamBootSchema as WireWorkstreamBootSchema,
  WorkstreamSchema as WireWorkstreamSchema,
  type AutomationDraft as WireAutomationDraft,
  type AutomationRun as WireAutomationRun,
  type BackgroundTask as WireBackgroundTask,
  type ClientFeatureFlags,
  type Connection as WireConnection,
  type ConnectorOAuthAttempt,
  type ConnectorOAuthStart,
  type ConnectorResourceAuthorizationRequest,
  type ConnectorResourceAuthorizationStart,
  type CustomMcpConnectionSettings,
  type CustomMcpToolPolicy,
  type Elicitation as WireElicitation,
  type Resource as WireResource,
  ResourceRevisionSchema as WireResourceRevisionSchema,
  type ResourceRevision as WireResourceRevision,
  type WorkstreamResource as WireWorkstreamResource,
  type User as WireUser,
  type Workstream as WireWorkstream,
  type WorkstreamDetail as WireWorkstreamDetail,
  type GitHubRepositoryAccessSettings as WireGitHubRepositoryAccessSettings,
  type WorkstreamAppearancePatch,
  ConnectionTestResponseSchema,
  ConnectorInstallationMutationResponseSchema,
  ConnectorInstallationReadResponseSchema,
  ConnectorInstallationSetupResponseSchema,
  OnboardingJourneySchema,
  type UpdateOnboardingJourney,
} from '@rally/contracts';

import { CLIENT_CONTRACT_VERSION, RALLY_HEADERS } from '@rally/contracts/http-headers';
import { SearchResponseSchema, type SearchRequest, type SearchResponse } from '@rally/contracts/search';
import { socketTicketProtocols, socketUrlWithoutTicket } from '@rally/contracts/socket-tickets';

import { HttpUrlSchema } from '@rally/contracts/url-schemas';
import { OrganizationUsageSchema, type OrganizationUsage, type PlanId } from '@rally/contracts/usage';
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { DesktopAuthAttempt, DesktopSession } from '../../common/desktop';
import { localCacheScope } from './local-cache';
import { ResourcePreviewCache } from './resource-preview-cache';
import { isCookieSession, type CookieClientSession } from '@rally/contracts/client-session';
import { logDebug } from '../../common/logger';
import { isSocketTicketRequestTimeoutError, requestSocketTicket } from './socket-ticket-request';
import { fetchWithNetworkRecovery, networkRecoveryGeneration, reportNetworkTicket, waitForNetworkRecovery } from './network-recovery';
import type { NetworkTicketObservation } from '../../common/network-recovery';
import { normalizeElicitation } from './elicitation';
import { resolveMentionPayload } from './mention-draft';
import { newRequestId } from './perf-trace';
import type { TelemetrySurfaceEntrypoint } from './telemetry';
import { reportJavascriptError, reportTelemetryProductIntent, telemetryCountBucket, uuidV7 } from './telemetry';
import { isPastedText } from './pasted-text';
import type {
  AutomationDetail,
  AutomationRun,
  AutomationScope,
  AutomationSummary,
  BackgroundTask,
  ElicitationData,
  HarnessStatus,
  Participant,
  Region,
  SocketTicket,
  ToolEventData,
  Workspace,
  WorkspaceInvitation,
  WorkspaceInvitationPreview,
  PendingWorkspaceInvitation,
  ResourcePage,
  WorkspaceMember,
  WorkstreamConnection,
  WorkstreamBoot,
  WorkstreamDetail,
  ResourceVersion,
  WorkstreamResource,
  WorkstreamSummary,
  TerminalWorkspaceSettings,
  TerminalNetworkPolicyPreview,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(message: string, status: number, code?: string, details?: unknown, requestId?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

function networkApiError(message: string, cause?: unknown): ApiError {
  const error = new ApiError(message, 0, 'network_error', cause);
  reportJavascriptError(error, 'network_error');
  return error;
}

/**
 * For a schema shared with the server — `WireAutomationAgentSnapshotSchema`
 * below is one — a response that fails the client's own copy is not a network
 * failure or a server bug report: the server built and validated the same
 * bytes against the same shared schema, so the two copies disagreeing is best
 * explained by this process running stale (or, less often, ahead) across a
 * deploy. Rally checks for an update every few hours and still waits for the
 * person to confirm the restart, so a stale process can outlive a shape
 * change by a long margin — long enough that a bare "unexpected response"
 * reads as unrecoverable when restarting the app is the fix.
 *
 * A good few of the schemas below are not shared, though — envelopes this
 * file declares locally (`wireAutomationPageSchema` and its neighbors), which
 * nothing on the server validates against. A mismatch there can be an
 * ordinary client-side bug in one of those, and restarting will not help; the
 * message still says "usually" for exactly that reason, and `details.issues`
 * carries the actual diagnosis either way.
 */
const STALE_BUILD_RESPONSE_MESSAGE =
  "Rally received a response it doesn't recognize. Restarting Rally usually fixes this by finishing a pending update — try that, then retry.";

/** The service answers 401 for plenty of things that are not a dead bearer —
 * replayed socket tickets, stale OAuth state, a missing identity. Renewing on
 * those would burn a refresh-token rotation and silently replay the request,
 * so only a rejected session credential is worth retrying. */
const sessionRejectionCodes = new Set(['invalid_session', 'authentication_required', 'session_revoked']);

export function isSessionRejection(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && sessionRejectionCodes.has(error.code ?? '');
}

async function rejectedTheBearer(response: Response): Promise<boolean> {
  const payload: unknown = await response.clone().json().catch(() => null);
  const code = payload && typeof payload === 'object' && 'error' in payload
    ? (payload as { error?: { code?: string } }).error?.code
    : undefined;
  return code !== undefined && sessionRejectionCodes.has(code);
}

interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: HeadersInit;
  schema: ZodType<T>;
  signal?: AbortSignal;
  /**
   * The `x-request-id` this call travels under. A caller that is timing a flow
   * passes the id it already printed, so the Worker's rows for this request
   * carry the same one; everything else gets a fresh id rather than none, which
   * is what makes an arbitrary slow call findable in Workers Logs at all.
   */
  requestId?: string;
}

export interface MentionIdentity {
  /**
   * `sidekick` lives only in the draft: the composer turns it into a
   * `[@Name](sidekick://<id>)` link before sending, so it never reaches the
   * mention payload. See `sidekickMentionsAsMarkdown`.
   */
  type: 'person' | 'connector' | 'sidekick';
  label: string;
  userId: string | null;
  connectorType: string | null;
  sidekickId?: string;
  /** UTF-16 offsets for the exact autocomplete selection in the draft. */
  startOffset?: number;
  endOffset?: number;
}

const wireResourcePageSchema = CursorPageSchema(WireResourceSchema).extend({ complete: z.boolean().optional() });
const wireMemberPageSchema = z.object({ items: z.array(WireWorkspaceMemberSchema) });
const wireInvitationPageSchema = z.object({ items: z.array(WireWorkspaceInvitationSchema) });
const wireInviteePageSchema = z.object({ items: z.array(WorkspaceInviteeSchema) });
/**
 * A Channel feed page as an API from before 2026-10-13 may still send it, with
 * a `locked` row for a private thread the reader is not in. The client drops
 * those rather than refusing the page, so a client that updates before the API
 * still opens the Channel. Remove once every region serves thread rows only.
 */
const wireAutomationPageSchema = z.object({ items: z.array(WireAutomationSummarySchema) });
const wireExecutionPrincipalClaimSchema = AutomationExecutionPrincipalClaimSchema;
const wireConnectionPageSchema = z.object({ items: z.array(WireConnectionSchema) });
const wireAutomationRunPageSchema = z.object({ items: z.array(WireAutomationRunSchema) });
const createdAutomationSchema = z.object({ automationId: z.string() });
const runNowResponseSchema = z.object({
  runId: z.string(),
  reused: z.boolean(),
});
// Older servers may return query tickets or capability flags. Discard all
// query data; every stream uses the ticket subprotocol and an unconditional protocol.
const socketTicketSchema = z.object({
  url: z.string(),
  ticket: z.string(),
  // Optional because the socket-ticket shape is shared with regional Workers
  // that predate it; a client that does not get one simply prints no ticket id.
  ticketId: z.string().optional(),
  subscriptionBootstrap: z.boolean().optional(),
})
  .transform(({ url, ticket, ticketId, subscriptionBootstrap }): SocketTicket => ({
    url: socketUrlWithoutTicket(url),
    ticket,
    protocols: socketTicketProtocols(ticket),
    ...(ticketId === undefined ? {} : { ticketId }),
    ...(subscriptionBootstrap === undefined ? {} : { subscriptionBootstrap }),
  }));

export function normalizeHarnessStatus(status: WireWorkstream['harnessStatus']): HarnessStatus {
  return status === 'idle' ? 'completed' : status;
}

function mapUser(user: WireUser): WorkspaceMember {
  return {
    presentation: user.presentation,
    id: user.id,
    email: user.email,
    name: user.name,
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    timezone: user.timezone,
  };
}

export function mapParticipant(participant: z.infer<typeof WireParticipantSchema>): Participant {
  return { ...mapUser(participant.user), role: participant.participationReason };
}

export function mapViewer(viewer: z.infer<typeof WireViewerSchema>): Participant {
  return { ...mapUser(viewer.user), viewing: true };
}

export function mapResourceVersion(revision: WireResourceRevision): ResourceVersion {
  return {
    version: revision.version,
    capturedAt: revision.createdAt,
    author: revision.author,
    authorName: revision.authorName ?? null,
    cause: revision.cause,
    contentAvailable: revision.contentAvailable,
    // The version's own title and type, not the resource's. A rename or a
    // retype is itself what captured the version being opened, so showing the
    // current name over old bytes would misdescribe the thing on screen.
    title: revision.title,
    mimeType: revision.mimeType,
  };
}

export function mapResource(resource: WireResource | WireWorkstreamResource): WorkstreamResource {
  return {
    id: resource.id,
    slug: resource.slug,
    title: resource.title,
    resourceType: resource.resourceType,
    provider: resource.provider,
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    ...(resource.canonicalUrl ? { canonicalUrl: resource.canonicalUrl } : {}),
    refreshSupported: resource.refreshSupported,
    watchEnabled: resource.watchEnabled,
    watchStatus: resource.watchStatus,
    updatedAt: resource.updatedAt,
    contentAvailable: resource.contentAvailable,
    sizeBytes: resource.sizeBytes,
    currentVersion: resource.currentVersion,
    relationshipType: 'relationshipType' in resource && resource.relationshipType !== 'suggested_activity'
      ? resource.relationshipType
      : 'attachment',
    direction: 'direction' in resource ? resource.direction : 'source',
  };
}

function mapConnection(connection: WireConnection): WorkstreamConnection {
  return {
    id: connection.id,
    modelPluginId: connection.modelPluginId,
    connectorType: connection.connectorType,
    displayName: connection.displayName,
    scope: connection.scope === 'personal' ? 'you' : 'workspace',
    ...(connection.ownerUserId ? { ownerUserId: connection.ownerUserId } : {}),
    ...(connection.ownerName ? { ownerName: connection.ownerName } : {}),
    status: connectorAuthorizationStatus(connection.status),
    capabilities: connection.grantedCapabilities,
    ...(connection.settingsKind ? { settingsKind: connection.settingsKind } : {}),
    ...(connection.userDelivery ? { userDelivery: connection.userDelivery } : {}),
    ...(connection.toolCount === null ? {} : { toolCount: connection.toolCount }),
    ...(connection.toolCountMissing === null ? {} : { toolCountMissing: connection.toolCountMissing }),
  };
}

export function mapWorkstreamSummary(workstream: WireWorkstream): WorkstreamSummary {
  return {
    ...(workstream.resolved === undefined ? {} : { resolved: workstream.resolved }),
    id: workstream.id,
    title: workstream.title,
    titleStatus: workstream.titleStatus,
    appearance: workstream.appearance,
    objective: workstream.objective,
    ...(workstream.emailAddress ? { emailAddress: workstream.emailAddress } : {}),
    ...(workstream.createdByUserId ? { createdByUserId: workstream.createdByUserId } : {}),
    harnessStatus: normalizeHarnessStatus(workstream.harnessStatus),
    latestAttentionSequenceNumber: workstream.latestAttentionSequenceNumber,
    readThroughSequenceNumber: workstream.readThroughSequenceNumber,
    manualUnreadFromSequenceNumber: workstream.manualUnreadFromSequenceNumber,
    manualUnreadGeneration: workstream.manualUnreadGeneration,
    hasUnread: workstream.hasUnread,
    youAreMentioned: workstream.youAreMentioned,
    unseen: workstream.unseen,
    ...(workstream.isParticipant !== undefined ? { isParticipant: workstream.isParticipant } : {}),
    firstUnreadSequenceNumber: workstream.firstUnreadSequenceNumber,
    lastActivityAt: workstream.lastActivityAt,
    createdAt: workstream.createdAt,
    updatedAt: workstream.updatedAt,
    ...(workstream.archivedAt ? { archivedAt: workstream.archivedAt } : {}),
    scope: workstream.scope,
    ...(workstream.systemKind ? { systemKind: workstream.systemKind } : {}),
    nextPendingWakeup: workstream.nextPendingWakeup
      ? { ...workstream.nextPendingWakeup }
      : null,
    pinPosition: workstream.pinPosition,
    // Only WorkspaceDO owns this field. Child responses omit it and must not
    // erase a newer directory-waterlined visit when callers merge the result.
    ...(workstream.lastAccessedAt !== undefined ? { lastAccessedAt: workstream.lastAccessedAt } : {}),
    participantUserIds: [...workstream.participantUserIds],
    participantExtraCount: workstream.participantExtraCount,
    preview: workstream.objective,
  };
}

export function mapElicitation(elicitation: WireElicitation): ElicitationData {
  return normalizeElicitation(elicitation);
}

export function mapToolInvocation(invocation: z.infer<typeof WireToolInvocationSchema>): ToolEventData {
  const started = invocation.startedAt ? Date.parse(invocation.startedAt) : Number.NaN;
  const completed = invocation.completedAt ? Date.parse(invocation.completedAt) : Number.NaN;
  return {
    id: invocation.id,
    toolCallId: invocation.toolCallId,
    name: invocation.activityName ?? invocation.toolName,
    // Kept beside the display name, which the prose above has taken over.
    wireName: invocation.toolName,
    summary: invocation.outputSummary ?? invocation.inputSummary,
    status: invocation.status === 'pending' ? 'started' : invocation.status,
    // The live row identifies a connector plugin by its model-facing id while
    // the canonical block identifies the same plugin by its connection. Both
    // carry the display name, which is what the grouped row keys on, so the
    // pre-canonical row and the block that replaces it land on one row rather
    // than two — see `pluginGroup`.
    ...(invocation.plugin
      ? { plugin: invocation.plugin, pluginName: invocation.plugin.displayName }
      : {}),
    ...(Number.isFinite(started) && Number.isFinite(completed) ? { durationMs: completed - started } : {}),
    input: invocation.inputSummary,
    ...(invocation.outputSummary ? { output: invocation.outputSummary } : {}),
  };
}

export function mapBackgroundTask(task: WireBackgroundTask): BackgroundTask {
  const started = Date.parse(task.startedAt);
  const completed = task.completedAt ? Date.parse(task.completedAt) : Number.NaN;
  return {
    id: task.id,
    harnessRunId: task.harnessRunId,
    title: task.title,
    type: task.taskType,
    status: task.status,
    startedAt: task.startedAt,
    ...(task.completedAt ? { completedAt: task.completedAt } : {}),
    ...(Number.isFinite(started) && Number.isFinite(completed) ? { durationMs: Math.max(0, completed - started) } : {}),
    ...(task.tokenCount !== null ? { tokenCount: task.tokenCount } : {}),
    ...(task.toolUses !== null ? { toolUses: task.toolUses } : {}),
    ...(task.transcriptTurnId ? { transcriptTurnId: task.transcriptTurnId } : {}),
  };
}

export function mapWorkstreamDetail(workstream: WireWorkstreamDetail): WorkstreamDetail {
  const participants = workstream.participants.map(mapParticipant);
  return {
    ...mapWorkstreamSummary(workstream),
    createdAt: workstream.createdAt,
    stopRequested: workstream.stopRequested ?? false,
    ...(workstream.createdByUserId
      ? { createdBy: participants.find((participant) => participant.id === workstream.createdByUserId) }
      : {}),
    participants,
    viewers: workstream.viewers.map(mapViewer),
    resources: workstream.resources.map(mapResource),
    connections: workstream.connections.map(mapConnection),
    backgroundTasks: (workstream.backgroundTasks ?? []).map(mapBackgroundTask),
    openElicitations: workstream.openElicitations.map(mapElicitation),
    ...(workstream.modelOverride ? { modelOverride: workstream.modelOverride } : {}),
    ...(workstream.latestHarnessRunId ? { latestHarnessRunId: workstream.latestHarnessRunId } : {}),
    ...(workstream.latestHarnessRun
      ? {
          latestHarnessRun: {
            id: workstream.latestHarnessRun.id,
            origin: workstream.latestHarnessRun.origin,
            status: workstream.latestHarnessRun.status,
            ...(workstream.latestHarnessRun.model ? { model: workstream.latestHarnessRun.model } : {}),
            ...(workstream.latestHarnessRun.error ? { error: workstream.latestHarnessRun.error } : {}),
            ...(workstream.latestHarnessRun.requestId ? { requestId: workstream.latestHarnessRun.requestId } : {}),
            ...(workstream.latestHarnessRun.startedAt ? { startedAt: workstream.latestHarnessRun.startedAt } : {}),
            ...(workstream.latestHarnessRun.completedAt ? { completedAt: workstream.latestHarnessRun.completedAt } : {}),
            createdAt: workstream.latestHarnessRun.createdAt,
          },
        }
      : {}),
  };
}

function triggerSummary(trigger: WireAutomationDraft['triggers'][number]): string {
  switch (trigger.type) {
    case 'manual': return 'Manual';
    case 'inbound_email': return 'When an email arrives';
    case 'calendar': return trigger.summary;
    case 'interval': return trigger.summary;
    case 'connector_activity': return `When there is matching activity in ${trigger.connectorType.replaceAll('_', ' ')}`;
    case 'semantic_activity': return trigger.condition;
    case 'resource_watch': return 'When the attached resource changes';
    case 'webhook': return 'When an external service sends an update';
  }
}

function mapAutomationRun(run: WireAutomationRun): AutomationRun {
  const start = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  const end = run.completedAt ? Date.parse(run.completedAt) : Number.NaN;
  return {
    id: run.id,
    automationId: run.automationId,
    ...(run.coordinatorUserId === undefined ? {} : { coordinatorUserId: run.coordinatorUserId }),
    triggerType: run.triggerType,
    status: run.status,
    plannedFor: run.plannedFor,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    resultSummary: run.resultSummary,
    createdAt: run.createdAt,
    ...(Number.isFinite(start) && Number.isFinite(end) ? { durationMs: Math.max(0, end - start) } : {}),
  };
}

function mapAutomationScope(scope: z.infer<typeof WireAutomationSummarySchema>['scope']): AutomationScope {
  return scope === 'personal' ? 'you' : scope;
}

/** Exported for the workspace socket's sidebar batch, which carries the same wire rows. */
export function mapAutomationSummary(automation: z.infer<typeof WireAutomationSummarySchema>): AutomationSummary {
  return {
    id: automation.id,
    loadable: automation.loadable,
    ...(automation.appearance ? { appearance: automation.appearance } : {}),
    name: automation.name,
    description: automation.description,
    ...(automation.emailAddress ? { emailAddress: automation.emailAddress } : {}),
    scope: mapAutomationScope(automation.scope),
    status: automation.status,
    ...(automation.nextRunAt ? { nextRunAt: automation.nextRunAt } : {}),
    ...(automation.lastRunAt ? { lastRunAt: automation.lastRunAt } : {}),
    updatedAt: automation.updatedAt,
    ...(automation.unread === undefined ? {} : { unread: automation.unread }),
    ...(automation.needsInput === undefined ? {} : { needsInput: automation.needsInput }),
    ...(automation.pinnedPosition === undefined ? {} : { pinnedPosition: automation.pinnedPosition }),
    ...(automation.audience === undefined ? {} : { audience: automation.audience }),
    ...(automation.runState === undefined ? {} : { runState: automation.runState }),
    ...(automation.pendingQuestion ? { pendingQuestion: automation.pendingQuestion } : {}),
    ...(automation.triggerKinds ? { triggerKinds: automation.triggerKinds } : {}),
  };
}

function mapAutomationDetail(detail: z.infer<typeof WireAutomationDetailSchema>): AutomationDetail {
  return {
    ...mapAutomationSummary(detail),
    lifecycle: detail.lifecycle,
    authorUserId: detail.authorUserId,
    runAsUserId: detail.runAsUserId,
    ...(detail.delegationAttention !== undefined ? { delegationAttention: detail.delegationAttention } : {}),
    currentDefinition: detail.currentDefinition,
    currentDefinitionRevision: detail.currentDefinitionRevision,
    acceptedDefinitionRevision: detail.acceptedDefinitionRevision,
    runnable: detail.runnable,
    connectorBindings: { ...detail.connectorBindings },
    triggerSummaries: (detail.currentDefinition?.triggers ?? []).map(triggerSummary),
    recentRuns: detail.recentRuns.map(mapAutomationRun),
    ...(detail.sharedWithUserIds === undefined ? {} : { sharedWithUserIds: detail.sharedWithUserIds }),
    ...(detail.canvases === undefined ? {} : { canvases: detail.canvases }),
  };
}

/**
 * A request path with every query *value* dropped, keeping the parameter names.
 *
 * A path is diagnostic and goes to the renderer's console and log file, but a
 * query string is caller data: `/auth/invitations/preview?token=…` carries a
 * bearer invitation token, and `/resources?q=…` carries whatever someone typed
 * into a search box. Keeping the names says which parameters were sent, which
 * is what a latency trace actually needs, and keeping none of the values means
 * there is no list of sensitive keys to maintain and get wrong later.
 */
export function redactQuery(path: string): string {
  const separator = path.indexOf('?');
  if (separator === -1) return path;
  const names = new URLSearchParams(path.slice(separator + 1));
  const keys = [...new Set([...names.keys()])];
  return keys.length === 0 ? path.slice(0, separator) : `${path.slice(0, separator)}?${keys.join(',')}`;
}

export class RallyApi {
  private readonly networkTickets = new WeakMap<SocketTicket, NetworkTicketObservation>();
  private readonly pendingRunKeys = new Map<string, string>();
  private readonly faviconRequests = new Map<string, Promise<Blob | null>>();
  private readonly resourcePreviews = new ResourcePreviewCache();

  private renewCredential: (() => Promise<DesktopSession>) | null = null;
  private renewalInFlight: Promise<string | null> | null = null;
  private sessionRevision = 0;

  constructor(
    readonly baseUrl: string,
    private session: DesktopSession | CookieClientSession | null,
  ) {}

  setSession(session: DesktopSession | CookieClientSession | null): void {
    ++this.sessionRevision;
    this.session = session;
  }

  private get accessToken(): string | null {
    return this.session && 'accessToken' in this.session ? this.session.accessToken : null;
  }

  private get socketSchema() {
    const session = this.session;
    if (!session || !('authentication' in session) || session.authentication !== 'cookie') return socketTicketSchema;
    return socketTicketSchema.transform((ticket, ctx): SocketTicket => {
      if (!session.workspace) { ctx.addIssue({ code: 'custom', message: 'A browser socket requires a selected organization' }); return z.NEVER; }
      const source = new URL(ticket.url);
      if (!source.pathname.startsWith('/socket/')) { ctx.addIssue({ code: 'custom', path: ['url'], message: 'Invalid browser socket destination' }); return z.NEVER; }
      const target = new URL(this.baseUrl, location.origin);
      target.pathname = `/regional/${encodeURIComponent(session.workspace.region)}${source.pathname}`;
      target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
      target.search = source.search;
      target.hash = '';
      return { ...ticket, url: target.toString() };
    });
  }

  /**
   * Who this client is authenticated as, for the one decision that cannot be
   * made without knowing: whether an arriving turn is the reader's own. Every
   * request already carries this identity in its bearer token, so a caller
   * threading the signed-in user alongside the api it is already holding would
   * be carrying the same fact twice — and a screen that passed the wrong one
   * would silently mis-attribute somebody else's message.
   *
   * Null before sign-in and after signing out, which is also the only state a
   * caller has to handle: nothing is anybody's own message then.
   */
  get viewerUserId(): string | null {
    return this.session?.user.id ?? null;
  }

  private prefetchedTranscriptionTicket: { promise: Promise<SocketTicket>; usableUntil: number } | undefined;

  /** Access tokens live minutes while the durable refresh credential lives
   * weeks. Without a reactive renewal an expired bearer fails every request
   * with `invalid_session` until the app restarts, because retrying replays
   * the same dead token. */
  setCredentialRenewal(renew: (() => Promise<DesktopSession>) | null): void {
    this.renewCredential = renew;
  }

  private async send(path: string, init: RequestInit, accessToken: string | null): Promise<Response> {
    const recovery = waitForNetworkRecovery(init.signal ?? undefined);
    if (recovery) await recovery;
    const headers = new Headers(init.headers);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    // On every request rather than on the two that check it: the header says
    // what this build speaks, the Worker decides where that matters, and a
    // client that only declared itself on some paths would be a client the next
    // gate could not place.
    headers.set(RALLY_HEADERS.CLIENT_CONTRACT, String(CLIENT_CONTRACT_VERSION));
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    const cookie = isCookieSession(this.session);
    if (cookie) headers.delete('Authorization');
    try {
      return await fetchWithNetworkRecovery(`${this.baseUrl}${path}`, { ...init, headers, ...(cookie ? { credentials: 'same-origin' as const } : {}) });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw networkApiError('Rally could not reach the selected regional service.', error);
    }
  }

  /** Resolves the credential a replay should use, or null when there is
   * nothing newer to retry under. Signing out mid-flight clears the session,
   * and an unauthenticated replay would only fail again. */
  private async renewedCredential(rejectedToken: string): Promise<string | null> {
    const current = this.accessToken;
    // A token that already moved on was renewed by a concurrent request, so
    // replay against the current one instead of burning another rotation.
    if (current !== rejectedToken) return current;
    const renew = this.renewCredential;
    if (!renew) return null;
    const revision = this.sessionRevision;
    this.renewalInFlight ??= renew()
      .then((session) => {
        // A completed sign-out, workspace switch or browser session replacement
        // cannot be undone by an older native credential renewal.
        if (revision !== this.sessionRevision) return this.accessToken === session.accessToken ? session.accessToken : null;
        this.session = session;
        return session.accessToken === rejectedToken ? null : session.accessToken;
      })
      .catch(() => null)
      .finally(() => {
        this.renewalInFlight = null;
      });
    return this.renewalInFlight;
  }

  private async execute(path: string, init: RequestInit): Promise<Response> {
    const accessToken = this.accessToken;
    const response = await this.send(path, init, accessToken);
    if (response.status !== 401 || accessToken === null) return response;
    // The clone drains the body now, so nothing is left outstanding across the
    // renewal round-trip while the original stays readable for the caller if
    // this turns out not to be a rejected bearer.
    if (!await rejectedTheBearer(response)) return response;
    const renewed = await this.renewedCredential(accessToken);
    if (renewed === null) return response;
    // Every `execute` body is a string, so the rejected attempt can be
    // discarded and replayed verbatim under the renewed credential.
    void response.body?.cancel().catch(() => undefined);
    return this.send(path, init, renewed);
  }

  private async throwResponseError(response: Response): Promise<never> {
    const payload: unknown = await response.json().catch(() => null);
    const nested = payload && typeof payload === 'object' && 'error' in payload
      ? (payload as { error?: { code?: string; message?: string; details?: unknown; requestId?: string } }).error
      : undefined;
    throw new ApiError(
      nested?.message ?? `Request failed with status ${response.status}`,
      response.status,
      nested?.code,
      nested?.details,
      nested?.requestId,
    );
  }

  /**
   * Stamps the request id and prints one trace line per call. The id is set
   * before `execute`, so a credential renewal replays the same id — deliberate:
   * the two attempts are one call from the caller's point of view, and the
   * server's own rows distinguish them by status.
   */
  private async traced(
    path: string,
    method: string,
    requestId: string | undefined,
    headers: Headers,
    run: () => Promise<Response>,
  ): Promise<Response> {
    const id = requestId ?? newRequestId();
    headers.set('X-Request-Id', id);
    const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now();
    let status = 0;
    try {
      const response = await run();
      status = response.status;
      return response;
    } finally {
      const durationMs = Math.round(
        (typeof performance === 'undefined' ? Date.now() : performance.now()) - startedAt,
      );
      const safePath = redactQuery(path);
      logDebug('perf', `http ${method} ${safePath} ${status} ${durationMs}ms`, {
        method, path: safePath, status, durationMs, requestId: id,
      });
    }
  }

  searchWorkspace(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse> {
    return this.request('/search', { method: 'POST', body: request, schema: SearchResponseSchema, signal });
  }

  /**
   * How a connector authorization this client starts comes back: a browser tab
   * returns to its completion page, the desktop to its versioned deep link.
   */
  private connectorHandoffQuery(): string {
    const cookie = isCookieSession(this.session);
    return cookie ? 'handoff=browser' : 'desktopHandoffVersion=2';
  }

  private async request<T>(path: string, options: RequestOptions<T>): Promise<T>;
  private async request<T, E>(path: string, options: RequestOptions<T> & { emptyAs: E }): Promise<T | E>;
  private async request<T, E>(path: string, options: RequestOptions<T> & { emptyAs?: E }): Promise<T | E> {
    const headers = new Headers(options.headers);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const method = options.method ?? 'GET';
    const response = await this.traced(path, method, options.requestId, headers, () => this.execute(path, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }));
    if (!response.ok) return this.throwResponseError(response);
    if (response.status === 204) {
      if ('emptyAs' in options) return options.emptyAs as E;
      throw new ApiError('The service returned no response body.', 502, 'unexpected_empty_response');
    }
    const payload: unknown = await response.json();
    const parsed = options.schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError(STALE_BUILD_RESPONSE_MESSAGE, 502, 'invalid_response', {
        issues: parsed.error.issues,
        path,
      });
    }
    return parsed.data;
  }

  private async requestVoid(path: string, options: Omit<RequestOptions<never>, 'schema'>): Promise<void> {
    const headers = new Headers(options.headers);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const method = options.method ?? 'POST';
    const response = await this.traced(path, method, options.requestId, headers, () => this.execute(path, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    }));
    if (!response.ok) return this.throwResponseError(response);
  }

  /**
   * Opens the authenticated raw-PCM response without buffering it. Credential
   * renewal is complete before the body is handed to Web Audio, so a replay
   * can never splice two provider streams into one audible response.
   */
  async streamMessageSpeech(markdown: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const path = '/speech';
    const headers = new Headers({
      Accept: 'application/octet-stream',
      'Content-Type': 'application/json',
    });
    const response = await this.traced(path, 'POST', undefined, headers, () => this.execute(path, {
      method: 'POST',
      headers,
      body: JSON.stringify({ markdown }),
      signal,
    }));
    if (!response.ok) return this.throwResponseError(response);
    if (!response.body) {
      throw new ApiError('The speech service returned no audio stream.', 502, 'unexpected_empty_response');
    }
    if (response.headers.get('content-type') !== 'audio/pcm;rate=24000;channels=1;bits=16;endian=little') {
      void response.body.cancel().catch(() => undefined);
      throw new ApiError('The speech service returned an unsupported audio format.', 502, 'invalid_response');
    }
    return response.body;
  }

  getOnboardingJourney() {
    return this.request('/workspace/onboarding', { schema: OnboardingJourneySchema });
  }

  updateOnboardingJourney(input: UpdateOnboardingJourney) {
    return this.request('/workspace/onboarding', { method: 'PATCH', body: input, schema: OnboardingJourneySchema });
  }

  async getWorkspace(signal?: AbortSignal): Promise<Workspace> {
    const raw = await this.request('/workspace', { schema: WireWorkspaceSchema, signal });
    let currentUser: WorkspaceMember | undefined = this.session?.user
      ? { ...this.session.user, timezone: this.session.user.timezone ?? 'America/Los_Angeles', role: raw.role, ...(raw.accessClass ? { accessClass: raw.accessClass } : {}) }
      : undefined;
    if (!currentUser) {
      const members = await this.getWorkspaceMembers(signal);
      const matched = members.find((member) => member.role === raw.role) ?? members[0];
      currentUser = matched ? { ...matched, role: raw.role } : undefined;
    }
    if (!currentUser) throw new ApiError('The signed-in user is missing from this organization.', 401, 'session_profile_missing');
    return {
      id: raw.id,
      name: raw.name,
      region: raw.region,
      timezone: raw.timezone,
      currentUser,
    };
  }

  async getMyPreferences(signal?: AbortSignal): Promise<MemberPreferences> {
    return this.request('/workspace/me/preferences', { schema: MemberPreferencesSchema, signal });
  }

  async updateMyPreferences(preferences: MemberPreferencesUpdate): Promise<MemberPreferences> {
    return this.request('/workspace/me/preferences', {
      method: 'PUT',
      body: preferences,
      schema: MemberPreferencesSchema,
    });
  }

  /** Text the agent reads in its system prompt on every turn this person starts. */
  async getMyPersonalSystemPrompt(signal?: AbortSignal): Promise<string> {
    const result = await this.request('/workspace/me/system-prompt', { schema: PersonalSystemPromptSchema, signal });
    return result.personalSystemPrompt;
  }

  async updateMyPersonalSystemPrompt(personalSystemPrompt: string): Promise<string> {
    const result = await this.request('/workspace/me/system-prompt', {
      method: 'PUT',
      body: { personalSystemPrompt },
      schema: PersonalSystemPromptSchema,
    });
    return result.personalSystemPrompt;
  }

  /** What Rally remembers about this person, newest first (`docs/agent-memory.md`). */
  getMyMemory(signal?: AbortSignal): Promise<MemoryReview> {
    return this.request('/workspace/me/memory', { schema: MemoryReviewSchema, signal });
  }

  forgetMyMemory(factId: string): Promise<MemoryForgetResponse> {
    return this.request(`/workspace/me/memory/${encodeURIComponent(factId)}`, { method: 'DELETE', schema: MemoryForgetResponseSchema });
  }

  /** What Rally remembers about the Organization. */
  getOrganizationMemory(signal?: AbortSignal): Promise<MemoryReview> {
    return this.request('/workspace/memory', { schema: MemoryReviewSchema, signal });
  }

  forgetOrganizationMemory(factId: string): Promise<MemoryForgetResponse> {
    return this.request(`/workspace/memory/${encodeURIComponent(factId)}`, { method: 'DELETE', schema: MemoryForgetResponseSchema });
  }

  getMyTimezone(signal?: AbortSignal): Promise<UserTimezone> {
    return this.request('/workspace/me/timezone', { schema: UserTimezoneSchema, signal });
  }

  /** This device's zone; the account takes it only while it follows the device. */
  reportDeviceTimezone(timezone: string): Promise<UserTimezone> {
    return this.request('/workspace/me/device-timezone', { method: 'PUT', body: { timezone }, schema: UserTimezoneSchema });
  }

  async updateMyTimezone(timezone: string, followDevice = false): Promise<WorkspaceMember> {
    const user = await this.request('/workspace/me', {
      method: 'PATCH',
      body: { timezone, followDevice },
      schema: z.object({
        id: z.string(), email: z.string(), name: z.string(), avatarUrl: z.string().nullable(),
        timezone: z.string(), createdAt: z.string(),
      }),
    });
    return mapUser(user);
  }

  /**
   * Saves only the fields given; the server keeps the rest. Answers with the
   * profile the PATCH returned rather than a second read, so a committed
   * change is never reported as failed by a read that followed it.
   */
  updateWorkspace(input: { name?: string; timezone?: string }): Promise<{ name: string; timezone: string }> {
    return this.request('/workspace', { method: 'PATCH', body: input, schema: WireWorkspaceSchema });
  }

  /** Rally access for this Organization (`docs/impersonation.md`). */
  async getSupportAccess(): Promise<SupportAccess> {
    return this.request('/workspace/support-access', { schema: SupportAccessSchema });
  }

  async grantSupportAccess(): Promise<SupportAccess> {
    return this.request('/workspace/support-access', { method: 'PUT', schema: SupportAccessSchema });
  }

  async revokeSupportAccess(): Promise<SupportAccess> {
    return this.request('/workspace/support-access', { method: 'DELETE', schema: SupportAccessSchema });
  }

  async getTerminalWorkspaceSettings(signal?: AbortSignal): Promise<TerminalWorkspaceSettings> {
    return this.request('/workspace/terminal', { schema: WireTerminalWorkspaceSettingsSchema, signal });
  }

  async previewTerminalNetworkPolicy(input: {
    expectedRevision: number;
    mode: 'trusted_only' | 'full_internet';
    customDomains: string[];
  }): Promise<TerminalNetworkPolicyPreview> {
    return this.request('/workspace/terminal/network-policy/preview', {
      method: 'POST', body: input, schema: WireTerminalNetworkPolicyPreviewSchema,
    });
  }

  async applyTerminalNetworkPolicy(input: {
    mutationId: string;
    expectedRevision: number;
    confirmed: true;
  }): Promise<TerminalWorkspaceSettings> {
    return this.request('/workspace/terminal/network-policy/apply', {
      method: 'POST', body: input, schema: WireTerminalWorkspaceSettingsSchema,
    });
  }

  /**
   * The Organization's plan and how much of this week's shared quota is left.
   * Any member may read it; the dollars behind the percentage never cross.
   */
  async getWorkspaceUsage(signal?: AbortSignal): Promise<OrganizationUsage> {
    return this.request('/workspace/usage', { schema: OrganizationUsageSchema, signal });
  }

  /** Administrators only. Answers with the meter as it reads under the new plan. */
  async setWorkspacePlan(plan: PlanId): Promise<OrganizationUsage> {
    return this.request('/workspace/plan', { method: 'PUT', body: { plan }, schema: OrganizationUsageSchema });
  }

  async getWorkspaceMembers(signal?: AbortSignal): Promise<WorkspaceMember[]> {
    const page = await this.request('/workspace/members', { schema: wireMemberPageSchema, signal });
    return page.items.map((member) => ({
      ...mapUser(member.user),
      role: member.role,
      ...(member.incarnation ? { incarnation: member.incarnation } : {}),
      ...(member.revision ? { revision: member.revision } : {}),
      ...(member.accessClass ? { accessClass: member.accessClass } : {}),
      // Carried, not dropped: the roster is the only list that can contain a
      // membership the work-stream endpoints will refuse, and a caller that
      // cannot see the status has no way to keep one out of a picker. The
      // access class travels for the same reason — a guest holds no role, so a
      // surface that offers one has to be able to tell a guest apart from a
      // member whose role simply has not loaded.
      ...(member.accessClass ? { accessClass: member.accessClass } : {}),
      status: member.status,
    }));
  }

  /** Make an existing member an administrator, or hand them back to member. */
  async setWorkspaceMemberRole(userId: string, role: 'admin' | 'member'): Promise<void> {
    await this.requestVoid(`/workspace/members/${encodeURIComponent(userId)}/role`, {
      method: 'PATCH',
      body: { role },
    });
  }

  async promoteWorkspaceGuest(userId: string, input: { incarnation: string; expectedRevision: number }) {
    return this.request(`/workspace/members/${encodeURIComponent(userId)}/promote`, {
      method: 'POST', body: PromoteWorkspaceGuestSchema.parse(input), schema: WorkspaceRelationshipSchema,
    });
  }

  async getInvitationPreview(token: string, signal?: AbortSignal): Promise<WorkspaceInvitationPreview> {
    return this.request(`/auth/invitations/preview?token=${encodeURIComponent(token)}`, {
      schema: WireWorkspaceInvitationPreviewSchema,
      signal,
    });
  }

  /** Addresses invited to the Organization and not yet joined, as any member may see them. */
  async getWorkspaceInvitees(signal?: AbortSignal): Promise<WorkspaceInvitee[]> {
    const page = await this.request('/workspace/invitees', { schema: wireInviteePageSchema, signal });
    return page.items;
  }

  async getWorkspaceInvitations(signal?: AbortSignal): Promise<WorkspaceInvitation[]> {
    const page = await this.request('/workspace/invitations', { schema: wireInvitationPageSchema, signal });
    return page.items;
  }

  async createWorkspaceInvitation(
    email: string,
    role: 'admin' | 'member',
  ): Promise<{ invitation: WorkspaceInvitation; inviteUrl: string; emailDelivery: 'sent' | 'skipped' }> {
    return this.request('/workspace/invitations', {
      method: 'POST',
      body: { email, role },
      schema: z.object({
        invitation: WireWorkspaceInvitationSchema,
        inviteUrl: HttpUrlSchema,
        emailDelivery: z.enum(['sent', 'skipped']),
      }),
    });
  }

  async revokeWorkspaceInvitation(id: string): Promise<void> {
    await this.requestVoid(`/workspace/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async acceptWorkspaceInvitation(token: string): Promise<void> {
    await this.requestVoid('/workspace/invitations/accept', { method: 'POST', body: { token } });
  }

  async getWorkspaceOnboarding(signal?: AbortSignal): Promise<{ invitations: PendingWorkspaceInvitation[] }> {
    return this.request('/onboarding', {
      schema: z.object({ invitations: z.array(WirePendingWorkspaceInvitationSchema) }),
      signal,
    });
  }

  /** The signed-in person's account onboarding. Identity-scoped: call it on an identity API. */
  async getAccountOnboarding(signal?: AbortSignal): Promise<AccountOnboarding> {
    return this.request('/onboarding/account', { schema: AccountOnboardingSchema, signal });
  }

  /** A name to prefill when creating an organization. Identity-scoped: call it on an identity API. */
  async getOrganizationNameSuggestion(signal?: AbortSignal): Promise<OrganizationNameSuggestion> {
    return this.request('/onboarding/organization-suggestion', { schema: OrganizationNameSuggestionSchema, signal });
  }

  async updateAccountOnboarding(input: UpdateAccountOnboarding): Promise<AccountOnboarding> {
    return this.request('/onboarding/account', {
      method: 'PATCH', body: UpdateAccountOnboardingSchema.parse(input), schema: AccountOnboardingSchema,
    });
  }

/** The VAPID key this browser subscribes with; a 404 means Web Push cannot send here. */
  async getWebPushConfiguration(signal?: AbortSignal): Promise<{ publicKey: string }> {
    return this.request('/push-devices/web-push', { schema: WebPushConfigurationSchema, signal });
  }

  async registerPushDevice(installationId: string, input: RegisterPushDeviceRequest): Promise<void> {
    await this.requestVoid(`/push-devices/${encodeURIComponent(installationId)}`, { method: 'PUT', body: input });
  }

  async deletePushDevice(installationId: string): Promise<void> {
    await this.requestVoid(`/push-devices/${encodeURIComponent(installationId)}`, { method: 'DELETE' });
  }

  async leaveWorkspace(workspaceId: string, expectedOutcome: WorkspaceDepartureOutcome): Promise<WorkspaceDeparture> {
    return this.request(`/workspaces/${encodeURIComponent(workspaceId)}/membership?expectedOutcome=${expectedOutcome}`, {
      method: 'DELETE', schema: WorkspaceDepartureSchema,
    });
  }

  /**
   * Take somebody else out of a workspace. The settings roster calls this
   * "Suspend": the person loses access at once and can be invited back later.
   */
  async removeWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
    await this.requestVoid(
      `/workspaces/${encodeURIComponent(workspaceId)}/membership/member/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    );
  }

  async createWorkspace(name: string): Promise<void> {
    await this.requestVoid('/onboarding/workspace', { method: 'POST', body: { name } });
  }

  async acceptPendingWorkspaceInvitation(id: string): Promise<void> {
    await this.requestVoid(`/onboarding/invitations/${encodeURIComponent(id)}/accept`, { method: 'POST' });
  }

  async declinePendingWorkspaceInvitation(id: string): Promise<void> {
    await this.requestVoid(`/onboarding/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async getSidekicks(signal?: AbortSignal): Promise<AutomationSummary[]> {
    const result = await this.request('/sidekicks', { signal, schema: wireAutomationPageSchema });
    return result.items.map(mapAutomationSummary);
  }

  async getAutomations(signal?: AbortSignal): Promise<AutomationSummary[]> {
    const page = await this.request('/automations', { schema: wireAutomationPageSchema, signal });
    return page.items.map(mapAutomationSummary);
  }

  async listManagedScopeGrants(target: ScopeGrantTarget, signal?: AbortSignal) {
    return this.request('/sharing/grants/list', { method: 'POST', body: { target }, schema: ManagedScopeGrantsSchema, signal });
  }

  async revokeScopeGrant(input: z.infer<typeof RevokeScopeGrantSchema>) {
    return this.request('/sharing/grants/revoke', { method: 'POST', body: RevokeScopeGrantSchema.parse(input), schema: ScopeGrantMutationResultSchema });
  }

  async getScopeSharingOptions(parentId: string, signal?: AbortSignal) {
    return this.request(`/sharing/${encodeURIComponent(parentId)}/options`, { schema: ScopeSharingOptionsSchema, signal });
  }

  async listScopeInvitations(target: ScopeGrantTarget, signal?: AbortSignal) {
    return this.request('/sharing/list', { method: 'POST', body: { target }, schema: ScopeInvitationsListSchema, signal });
  }

  async createScopeInvitations(input: Omit<CreateScopeInvitations, 'actorUserId' | 'workspaceId'>) {
    return this.request('/sharing', { method: 'POST', body: input, schema: ScopeInvitationResultSchema });
  }

  async revokeScopeInvitation(parentId: string, invitationId: string, expectedRevision: number) {
    return this.request(`/sharing/${encodeURIComponent(parentId)}/${encodeURIComponent(invitationId)}`, {
      method: 'DELETE', body: { expectedRevision }, schema: ScopeInvitationResultSchema,
    });
  }

  /**
   * "New automation": the object and its conversation, and nothing else.
   *
   * No body, because the draft is written in that conversation. The id that
   * comes back is the route to open.
   */
  async createAutomation(): Promise<{ automationId: string }> {
    return this.request('/automations', { method: 'POST', schema: createdAutomationSchema });
  }

  async getSidekickDelegates(id: string, signal?: AbortSignal): Promise<z.infer<typeof SidekickDelegatesResultSchema>> {
    return this.request(`/sidekicks/${encodeURIComponent(id)}/delegation`, { schema: SidekickDelegatesResultSchema, signal });
  }

  async setMySidekickDelegation(id: string, allowed: boolean, operationId: string): Promise<z.infer<typeof SidekickDelegationMutationResultSchema>> {
    return this.request(`/sidekicks/${encodeURIComponent(id)}/delegation`, {
      method: 'POST', body: { allowed, operationId }, schema: SidekickDelegationMutationResultSchema,
    });
  }

  async acceptAutomation(id: string): Promise<AutomationDetail> {
    const raw = await this.request(`/sidekicks/${encodeURIComponent(id)}/accept`, {
      method: 'POST',
      schema: WireAutomationDetailSchema,
    });
    return mapAutomationDetail(raw);
  }

  /**
   * Take over an automation whose principal lost access.
   *
   * No body: the claimant is the caller. A field naming somebody else would let
   * one person lend a colleague's credentials to a standing automation.
   */
  async claimAutomationExecutionPrincipal(
    id: string,
  ): Promise<z.infer<typeof wireExecutionPrincipalClaimSchema>> {
    return this.request(`/sidekicks/${encodeURIComponent(id)}/execution-principal`, {
      method: 'POST',
      schema: wireExecutionPrincipalClaimSchema,
    });
  }

  // -------------------------------------------------------------------------
  // Canvases (docs/canvases.md). A Canvas's Chat is an ordinary conversation,
  // opened by its id as any conversation is; these are the Canvas's own reads
  // and writes.
  // -------------------------------------------------------------------------

  /**
   * A new Canvas with no artifacts; `prompt` is the "Start from a prompt"
   * card's first message. The id is minted here, so a retry of this request
   * answers the Canvas the first made rather than making a second.
   */
  createCanvas(input: CreateCanvasRequest = {}): Promise<CreatedCanvas> {
    return this.request('/canvases', {
      method: 'POST', body: { ...input, canvasId: input.canvasId ?? uuidV7() }, schema: CreatedCanvasSchema,
    });
  }

  /** The Canvas as this person sees it: its row, who it is shared with, and its artifacts. */
  getCanvas(id: string, signal?: AbortSignal): Promise<CanvasDetail> {
    return this.request(`/canvases/${encodeURIComponent(id)}`, { schema: CanvasDetailSchema, signal });
  }

  /** Retitle a Canvas; anyone the Canvas admits may. The server trims and bounds the title. */
  renameCanvas(id: string, title: string): Promise<CanvasDetail> {
    return this.request(`/canvases/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title }, schema: CanvasDetailSchema });
  }

  /** Change who can open a Canvas; its creator's, an administrator's, or its Sidekick's manager's. */
  setCanvasAudience(id: string, update: CanvasAudienceUpdate): Promise<CanvasDetail> {
    return this.request(`/canvases/${encodeURIComponent(id)}/audience`, { method: 'POST', body: update, schema: CanvasDetailSchema });
  }

  /** Pin a Canvas in, or out of, the Canvas list's Pinned group. */
  async setCanvasPinned(id: string, pinned: boolean): Promise<void> {
    await this.requestVoid(`/canvases/${encodeURIComponent(id)}/pin`, { method: 'POST', body: { pinned } });
  }

  /** Pin a Sidekick in, or out of, the Sidekick list's Pinned group. */
  async setSidekickPinned(id: string, pinned: boolean): Promise<void> {
    await this.requestVoid(`/sidekicks/${encodeURIComponent(id)}/pin`, { method: 'POST', body: { pinned } });
  }

  async getAutomation(id: string, signal?: AbortSignal): Promise<AutomationDetail> {
    const raw = await this.request(`/sidekicks/${encodeURIComponent(id)}`, { schema: WireAutomationDetailSchema, signal });
    return mapAutomationDetail(raw);
  }

  async getAutomationRuns(id: string, signal?: AbortSignal): Promise<AutomationRun[]> {
    const page = await this.request(`/sidekicks/${encodeURIComponent(id)}/runs`, {
      schema: wireAutomationRunPageSchema,
      signal,
    });
    return page.items.map(mapAutomationRun);
  }

  async setAutomationStatus(id: string, action: 'pause' | 'resume'): Promise<AutomationDetail> {
    await this.requestVoid(`/sidekicks/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    return this.getAutomation(id);
  }

  /**
   * Choose the Sidekick's icon or colour.
   *
   * A partial patch, so a colour choice cannot undo somebody's icon, and the
   * response is the committed Sidekick rather than an acknowledgement: the
   * caller writes it straight into the detail cache instead of waiting for the
   * directory push that tells everybody else.
   */
  async setAutomationAppearance(id: string, appearance: WorkstreamAppearancePatch): Promise<AutomationDetail> {
    const raw = await this.request(`/sidekicks/${encodeURIComponent(id)}/appearance`, {
      method: 'POST',
      body: appearance,
      schema: WireAutomationDetailSchema,
    });
    return mapAutomationDetail(raw);
  }

  async archiveAutomation(id: string): Promise<void> {
    const path = `/sidekicks/${encodeURIComponent(id)}`;
    try {
      await this.requestVoid(`${path}/archive`, { method: 'POST' });
    } catch (error) {
      // During a rolling API deployment, the previous Worker knows the same
      // retained tombstone only as DELETE. A route miss proves the POST did
      // not reach a mutation; every domain 404 remains a real archive failure.
      if (!(error instanceof ApiError && error.status === 404 && error.code === 'not_found')) throw error;
      await this.requestVoid(path, { method: 'DELETE' });
    }
  }

  /**
   * Start a run now. The key is reused until the server confirms one, so a
   * retry after a dropped connection lands on the run it already started.
   */
  async runAutomation(id: string): Promise<{ runId: string; reused: boolean }> {
    const idempotencyKey = this.pendingRunKeys.get(id) ?? crypto.randomUUID();
    this.pendingRunKeys.set(id, idempotencyKey);
    const result = await this.request(`/sidekicks/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      schema: runNowResponseSchema,
    });
    this.pendingRunKeys.delete(id);
    return result;
  }

  /**
   * The server-decided values this device is allowed to see, for the signed-in
   * person. The main process polls the same route for Application → Developer;
   * a renderer asks directly for a value only it acts on, rather than adding an
   * IPC hop and a second reader of the same answer.
   */
  clientFeatureFlags(signal?: AbortSignal): Promise<ClientFeatureFlags> {
    return this.request('/feature-flags', { schema: WireClientFeatureFlagsSchema, signal });
  }

  /**
   * Tell one conversation how far this person has read it.
   *
   * Addressed by conversation rather than by work stream, because that is what
   * owns the waterline: a substream keeps its own attention ordinals, so an
   * acknowledgement sent to the work stream advanced Main and left the child's
   * unread divider with nothing to clear it. The answer is the addressed
   * conversation's own summary, which is what the caller writes back to that
   * conversation's cache entry.
   */
  async acknowledgeConversationRead(
    parentId: string,
    substreamId: string,
    readThroughSequenceNumber: number,
    observedManualUnreadGeneration: number,
    entrypoint?: TelemetrySurfaceEntrypoint,
  ): Promise<WorkstreamSummary> {
    const workstream = await this.request(`${this.substreamPath(parentId, substreamId)}/read-state`, {
      method: 'PATCH',
      body: { readThroughSequenceNumber, observedManualUnreadGeneration, entrypoint },
      schema: WireWorkstreamSchema,
    });
    return mapWorkstreamSummary(workstream);
  }

  /**
   * The REST recovery twin of the canonical socket snapshot.
   *
   * One route for every parent: a work stream and an automation are both
   * opened through `/conversations`, and the parent decides who may read.
   */
  async getConversation(parentId: string, signal?: AbortSignal, openAttemptId?: string): Promise<WorkstreamBoot> {
    const raw = await this.request(`/conversations/${encodeURIComponent(parentId)}`, {
      schema: WireWorkstreamBootSchema,
      signal,
      ...(openAttemptId ? { headers: { [RALLY_HEADERS.OPERATION_ID]: openAttemptId } } : {}),
    });
    return {
      ...mapWorkstreamDetail(raw),
      transcript: raw.transcript,
    };
  }

  async messageMentionPayload(
    text: string,
    selected: MentionIdentity[] = [],
    existingRoster?: readonly WorkspaceMember[],
  ): Promise<Array<{
    type: 'person' | 'connector';
    userId: string | null;
    connectorType: string | null;
    startOffset: number;
    endOffset: number;
  }>> {
    // Most sends contain no mention syntax. Keep their command path on the
    // already-open work-stream room socket instead of putting a roster request in
    // front of it. `person://` covers durable mention Markdown that is pasted
    // or replayed; `@` covers composer and hand-typed mentions.
    if (!text.includes('@') && !text.includes('person://')) return [];
    // Guests resolve selected identities from their authorized conversation roster.
    // A hand-typed name does not grant access to the workspace-wide directory.
    if (this.session?.workspace?.accessClass === 'guest') return resolveMentionPayload(text, selected, []);
    const members = existingRoster ?? await this.getWorkspaceMembers();
    // People only, and only here: what a name in the text resolves to has to
    // agree with what the composer that wrote it offered and highlighted.
    // The work stream's connections were discovered here too, so a hand-typed
    // `@<connection>` still left as a connector span — a chip in the transcript
    // for something the composer had already stopped naming. A connector
    // mention a caller states outright still travels, through `selected` below.
    const discovered = members
      .filter((member) => (member.status ?? 'active') === 'active')
      .map((member) => ({ type: 'person' as const, label: member.name, userId: member.id, connectorType: null }));
    const resolved = resolveMentionPayload(text, selected, discovered);
    // Workspace socket invalidation normally keeps the shared roster current.
    // If a supplied snapshot cannot resolve any person at all, refresh once so
    // a newly added member is not silently sent as plain text. Selected chips
    // remain authoritative here; the server still validates their membership.
    if (existingRoster !== undefined
      && !resolved.some((mention) => mention.type === 'person')
      && !selected.some((mention) => mention.type === 'person')) {
      const freshMembers = await this.getWorkspaceMembers();
      const freshDiscovered = freshMembers
        .filter((member) => (member.status ?? 'active') === 'active')
        .map((member) => ({
          type: 'person' as const,
          label: member.name,
          userId: member.id,
          connectorType: null,
        }));
      return resolveMentionPayload(text, selected, freshDiscovered);
    }
    return resolved;
  }

  async uploadResource(
    file: File,
    draftId: string,
    onProgress?: (percentage: number) => void,
    signal?: AbortSignal,
  ): Promise<WorkstreamResource> {
    const accessToken = this.accessToken;
    try {
      return await this.sendUpload(file, draftId, accessToken, onProgress, signal);
    } catch (error) {
      if (!isSessionRejection(error) || accessToken === null) throw error;
      const renewed = await this.renewedCredential(accessToken);
      if (renewed === null) throw error;
      return this.sendUpload(file, draftId, renewed, onProgress, signal);
    }
  }

  private async sendUpload(
    file: File,
    draftId: string,
    accessToken: string | null,
    onProgress?: (percentage: number) => void,
    signal?: AbortSignal,
  ): Promise<WorkstreamResource> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', `${this.baseUrl}/resources/upload`);
      request.responseType = 'json';
      request.setRequestHeader('Accept', 'application/json');
      request.setRequestHeader(RALLY_HEADERS.DRAFT_ID, draftId);
      if (accessToken) request.setRequestHeader('Authorization', `Bearer ${accessToken}`);
      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      });
      let settled = false;
      request.addEventListener('load', () => {
        if (settled) return;
        settled = true;
        if (request.status < 200 || request.status >= 300) {
          const nested = request.response && typeof request.response === 'object' && 'error' in request.response
            ? (request.response as { error?: { code?: string; message?: string; details?: unknown; requestId?: string } }).error
            : undefined;
          reject(new ApiError(
            nested?.message ?? `Upload failed with status ${request.status}`,
            request.status,
            nested?.code,
            nested?.details,
            nested?.requestId,
          ));
          return;
        }
        const parsed = WireResourceSchema.safeParse(request.response);
        if (!parsed.success) {
          reject(new ApiError('The upload response was invalid.', 502, 'invalid_response', parsed.error.issues));
          return;
        }
        onProgress?.(100);
        resolve(mapResource(parsed.data));
      });
      request.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        reject(networkApiError('Rally could not upload the attachment.'));
      });
      request.addEventListener('abort', () => {
        if (settled) return;
        settled = true;
        reject(new DOMException('The upload was cancelled.', 'AbortError'));
      });
      if (signal) {
        if (signal.aborted) {
          request.abort();
          return;
        }
        signal.addEventListener('abort', () => request.abort(), { once: true });
      }
      const form = new FormData();
      form.set('file', file, file.name);
      if (isPastedText(file)) form.set('pastedText', 'true');
      request.send(form);
    });
  }

  async getResource(id: string): Promise<WorkstreamResource> {
    return mapResource(await this.request(`/resources/${encodeURIComponent(id)}`, {
      method: 'GET',
      schema: WireResourceSchema,
    }));
  }

  async deleteDraftResource(id: string): Promise<void> {
    await this.requestVoid(`/resources/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async getResourceContent(id: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.execute(`/resources/${encodeURIComponent(id)}/content`, {
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return this.throwResponseError(response);
    return response.blob();
  }

  /** Observed versions separate pending refreshes; this endpoint still reads the current head. */
  async getResourcePreviewContent(id: string, signal?: AbortSignal, version?: number): Promise<Blob> {
    const path = `/resources/${encodeURIComponent(id)}/preview`;
    const fetchPreview = async (etag?: string, loadSignal?: AbortSignal): Promise<Response> => {
      const response = await this.execute(path, {
        method: 'GET',
        ...(etag ? { headers: { 'If-None-Match': etag } } : {}),
        ...(loadSignal ? { signal: loadSignal } : {}),
      });
      if (!response.ok && response.status !== 304) return this.throwResponseError(response);
      return response;
    };
    const session = this.session;
    if (!session?.workspace) return (await fetchPreview(undefined, signal)).blob();
    return this.resourcePreviews.load(
      localCacheScope(session.user.id, session.workspace.region, session.workspace.id, session.workspace.accessClass),
      `${this.baseUrl}${path}`, fetchPreview, signal, version,
    );
  }

  getFavicon(hostname: string): Promise<Blob | null> {
    const normalized = hostname.toLowerCase();
    const pending = this.faviconRequests.get(normalized);
    if (pending) return pending;
    const request = this.fetchFavicon(normalized)
      .finally(() => this.faviconRequests.delete(normalized));
    this.faviconRequests.set(normalized, request);
    return request;
  }

  private async fetchFavicon(hostname: string): Promise<Blob | null> {
    const path = `/favicons/${encodeURIComponent(hostname)}`;
    const headers = new Headers({ Accept: "image/*" });
    const response = await this.traced(path, "GET", undefined, headers, () => this.execute(path, {
      method: "GET",
      headers,
    }));
    if (response.status === 404) return null;
    if (!response.ok) return this.throwResponseError(response);
    if (!response.headers.get("content-type")?.startsWith("image/")) {
      throw new ApiError("The favicon response was not an image.", 502, "invalid_response");
    }
    return response.blob();
  }

  async getSearchResourcePreviewContent(id: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.execute(`/search/resources/${encodeURIComponent(id)}/preview`, {
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return this.throwResponseError(response);
    return response.blob();
  }

  /**
   * Mint this person's access to a live artifact.
   *
   * A POST because it creates a single-use code, and a GET would be
   * prefetchable and cacheable — both wrong for a credential. The `openUrl` it
   * returns carries that code in its fragment, which never leaves the browser.
   */
  async openArtifact(resourceId: string): Promise<{
    openUrl: string;
    canonicalUrl: string;
    artifactId: string;
    mode: 'static' | 'active';
    stateful: boolean;
  }> {
    const response = await this.execute(
      `/resources/${encodeURIComponent(resourceId)}/artifact/open`,
      { method: 'POST' },
    );
    if (!response.ok) return this.throwResponseError(response);
    return response.json();
  }

  /** The tables a stateful artifact keeps, for the rail's Data view. */
  async describeArtifactData(resourceId: string): Promise<{
    tables: { name: string; columns: { name: string; type: string }[]; rowCount: number }[];
  }> {
    const response = await this.execute(
      `/resources/${encodeURIComponent(resourceId)}/artifact/data`,
      { method: 'GET' },
    );
    if (!response.ok) return this.throwResponseError(response);
    return response.json();
  }

  /**
   * One page of one table, as rows and as the CSV an export hands somebody.
   *
   * Both come from one read, so what the view shows and what a person exports
   * can never disagree.
   */
  async readArtifactTable(resourceId: string, table: string): Promise<{
    rows: Record<string, unknown>[];
    csv: string;
  }> {
    const response = await this.execute(
      `/resources/${encodeURIComponent(resourceId)}/artifact/data/${encodeURIComponent(table)}`,
      { method: 'GET' },
    );
    if (!response.ok) return this.throwResponseError(response);
    return response.json();
  }

  async listResources(input: {
    query?: string;
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  } = {}): Promise<ResourcePage> {
    const query = new URLSearchParams({ limit: String(input.limit ?? 50) });
    if (input.query?.trim()) query.set('q', input.query.trim());
    if (input.cursor) query.set('cursor', input.cursor);
    const page = await this.request(`/resources?${query.toString()}`, {
      schema: wireResourcePageSchema,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return { items: page.items.map(mapResource), nextCursor: page.nextCursor, ...(page.complete !== undefined ? { complete: page.complete } : {}) };
  }

  async createMessageIssue(input: CreateMessageIssue): Promise<MessageIssueReceipt> {
    return this.request('/message-issues', { method: 'POST', body: input, schema: MessageIssueReceiptSchema });
  }

  async attachResource(parentId: string, resourceId: string): Promise<WorkstreamDetail> {
    await this.request(`/conversations/${encodeURIComponent(parentId)}/resources`, {
      method: 'POST',
      body: { resourceId },
      schema: WireWorkstreamResourceSchema,
    });
    return this.getConversation(parentId);
  }

  /** Rename an artifact the thread generated; its room hears `resource_updated`. */
  async renameResource(parentId: string, resourceId: string, title: string): Promise<void> {
    await this.requestVoid(`/conversations/${encodeURIComponent(parentId)}/resources/${encodeURIComponent(resourceId)}`, {
      method: 'PATCH',
      body: { title },
    });
  }

  async detachResource(parentId: string, resourceId: string): Promise<void> {
    await this.requestVoid(`/conversations/${encodeURIComponent(parentId)}/resources/${encodeURIComponent(resourceId)}`, {
      method: 'DELETE',
    });
  }

  private substreamPath(parentId: string, substreamId: string): string {
    return `/conversations/${encodeURIComponent(parentId)}/substreams/${encodeURIComponent(substreamId)}`;
  }

  /**
   * A resource's history, newest first, including its current state.
   *
   * The rail shows the list only when there is more than one entry: a
   * resource that has never changed is its own history, which the detail
   * above already says.
   */
  async getResourceVersions(resourceId: string, signal?: AbortSignal): Promise<ResourceVersion[]> {
    const versions = await this.request(`/resources/${encodeURIComponent(resourceId)}/versions`, {
      schema: z.array(WireResourceRevisionSchema),
      ...(signal ? { signal } : {}),
    });
    return versions.map(mapResourceVersion);
  }

  /**
   * One prior version's original bytes.
   *
   * The stored object, not the preview route's conversion — there is no
   * per-version preview, which is why the rail only offers to open a version
   * whose own type the preview surface can render from source bytes.
   */
  async getResourceVersionPreview(resourceId:string,version:number,signal?:AbortSignal):Promise<Blob> {
    const response=await this.execute(`/resources/${encodeURIComponent(resourceId)}/versions/${version}/preview`,{method:'GET',...(signal?{signal}: {})});
    if(!response.ok)return this.throwResponseError(response);
    return response.blob();
  }

  async getResourceVersionContent(resourceId: string, version: number, signal?: AbortSignal, representation: "model" | "original" = "original"): Promise<Blob> {
    const response = await this.execute(
      `/resources/${encodeURIComponent(resourceId)}/versions/${encodeURIComponent(version)}/${representation === "model" ? "model-content" : "content"}`,
      { method: 'GET', ...(signal ? { signal } : {}) },
    );
    if (!response.ok) return this.throwResponseError(response);
    return response.blob();
  }

  async getAnnotationSitePreview(resourceId:string,version:number,pagePath:string,signal?:AbortSignal):Promise<Blob> {
    const response = await this.execute(`/resources/${encodeURIComponent(resourceId)}/versions/${version}/site-preview?path=${encodeURIComponent(pagePath)}`,{method:'GET',...(signal?{signal}:{})});
    if (!response.ok) return this.throwResponseError(response);
    return response.blob();
  }

  /** Re-fetch a connector-owned resource; the superseded state becomes a version. */
  async refreshResource(resourceId: string): Promise<WorkstreamResource> {
    return mapResource(await this.request(`/resources/${encodeURIComponent(resourceId)}/hydrate`, {
      method: 'POST',
      schema: WireResourceSchema,
    }));
  }

  async setResourceWatch(workstreamId: string, resourceId: string, enabled: boolean): Promise<{ enabled: boolean }> {
    if (enabled) {
      const result = await this.request(`/resources/${encodeURIComponent(resourceId)}/watch`, {
        method: 'POST',
        body: { workstreamId },
        schema: z.object({ watchEnabled: z.boolean() }),
      });
      return { enabled: result.watchEnabled };
    }
    await this.requestVoid(`/resources/${encodeURIComponent(resourceId)}/watch?workstreamId=${encodeURIComponent(workstreamId)}`, { method: 'DELETE' });
    return { enabled: false };
  }

  /** A feed ticket for one of a parent's conversations, whichever kind of parent. */
  getSocketTicket(
    parentId: string,
    substreamId = '0',
    requestId?: string,
    afterSequence?: number,
    speculative = false,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<SocketTicket> {
    const queryParams = new URLSearchParams();
    if (afterSequence !== undefined) queryParams.set('afterSequence', String(afterSequence));
    if (speculative) queryParams.set('speculative', 'true');
    const encodedQuery = queryParams.toString();
    const query = encodedQuery === '' ? '' : `?${encodedQuery}`;
    return this.socketTicketRequest(
      `/conversations/${encodeURIComponent(parentId)}/substreams/${encodeURIComponent(substreamId)}/socket${query}`,
      { signal, timeoutMs, requestId },
    );
  }

  getWorkspaceSocketTicket(signal?: AbortSignal): Promise<SocketTicket> {
    return this.socketTicketRequest('/workspace/socket', { signal });
  }

  /** A live snapshot/sync, rather than a 101 or a ticket, proves recovery. */
  confirmSocketTicket(ticket: SocketTicket): void {
    const observation = this.networkTickets.get(ticket);
    if (!observation) return;
    this.networkTickets.delete(ticket);
    reportNetworkTicket({ ...observation, outcome: 'live' });
  }

  private async socketTicketRequest(path: string, options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    requestId?: string;
  }): Promise<SocketTicket> {
    const recovery = waitForNetworkRecovery(options.signal);
    if (recovery) await recovery;
    const observation: NetworkTicketObservation = {
      generation: networkRecoveryGeneration(), target: path.split('?')[0]!, outcome: 'accepted',
    };
    try {
      const ticket = await requestSocketTicket(
        (signal) => this.request(path, { schema: this.socketSchema, signal,
          ...(options.requestId ? { requestId: options.requestId } : {}) }),
        { ownerSignal: options.signal, timeoutMs: options.timeoutMs },
      );
      this.networkTickets.set(ticket, observation);
      reportNetworkTicket(observation);
      return ticket;
    } catch (error) {
      reportNetworkTicket({ ...observation,
        outcome: isSocketTicketRequestTimeoutError(error) && navigator.onLine !== false ? 'timeout' : 'failed' });
      throw error;
    }
  }

  /**
   * Fetches a transcription ticket ahead of a recording, so the press that
   * starts one finds it already in hand. `usableForMs` is the caller's
   * promise about how soon it will present the ticket: the next
   * `getTranscriptionSocketTicket` within that window takes this one instead
   * of requesting another, and after it a fresh request is made, because a
   * ticket presented near the end of its life fails the upgrade. A ticket is
   * single-use, so the prefetched one is handed out once. Its failure is
   * nobody's problem: the consumer falls back to a request of its own.
   */
  prefetchTranscriptionSocketTicket(usableForMs: number): void {
    if (this.prefetchedTranscriptionTicket && Date.now() < this.prefetchedTranscriptionTicket.usableUntil) return;
    const promise = this.request('/realtime/transcription/socket', { schema: this.socketSchema });
    void promise.catch(() => undefined);
    this.prefetchedTranscriptionTicket = { promise, usableUntil: Date.now() + usableForMs };
  }

  async getTranscriptionSocketTicket(signal?: AbortSignal): Promise<SocketTicket> {
    signal?.throwIfAborted();
    const prefetched = this.prefetchedTranscriptionTicket;
    this.prefetchedTranscriptionTicket = undefined;
    const fresh = (): Promise<SocketTicket> => this.request('/realtime/transcription/socket', { schema: this.socketSchema, signal });
    // Checked again once the prefetch resolves: a request that waited out a
    // network recovery can land after the window it was fetched for.
    const request = prefetched && Date.now() < prefetched.usableUntil
      ? prefetched.promise.then((ticket) => Date.now() < prefetched.usableUntil ? ticket : fresh(), fresh)
      : fresh();
    if (!signal) return request;
    // A shared credential renewal can outlive fetch cancellation. Settle this
    // caller immediately without cancelling another caller's credential renewal.
    return new Promise((resolve, reject) => {
      const abort = (): void => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      void request.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  async getConnections(signal?: AbortSignal): Promise<WorkstreamConnection[]> {
    const page = await this.request('/connections', { schema: wireConnectionPageSchema, signal });
    return page.items.map(mapConnection);
  }

  async getAvailableConnectorTypes(signal?: AbortSignal): Promise<string[]> {
    const result = await this.request('/connections/catalog', {
      schema: z.object({ availableConnectorTypes: z.array(z.string().min(1)) }),
      signal,
    });
    return result.availableConnectorTypes;
  }

  async getGitHubRepositoryAccessSettings(
    connectionId: string,
    signal?: AbortSignal,
  ): Promise<WireGitHubRepositoryAccessSettings> {
    return this.request(`/connections/${encodeURIComponent(connectionId)}/github/repository-access`, {
      schema: WireGitHubRepositoryAccessSettingsSchema,
      signal,
    });
  }

  async updateGitHubRepositoryAccessSettings(
    connectionId: string,
    input: {
      expectedRevision: number;
      mode: 'all_repositories' | 'selected_repositories';
      defaultRemoteAccess: 'read_only' | 'full_access';
      repositories: Array<{
        repositoryId: string;
        repositoryFullName: string;
        remoteAccess: 'read_only' | 'full_access';
      }>;
    },
  ): Promise<WireGitHubRepositoryAccessSettings> {
    return this.request(`/connections/${encodeURIComponent(connectionId)}/github/repository-access`, {
      method: 'PUT',
      body: input,
      schema: WireGitHubRepositoryAccessSettingsSchema,
    });
  }

  async startGoogleConnection(scope: 'you' | 'workspace', capabilities: string[]): Promise<ConnectorOAuthStart> {
    return this.startProviderConnection('google', scope, capabilities);
  }

  async startProviderConnection(
    provider: 'apollo' | 'ashby' | 'canva' | 'fireflies' | 'google' | 'github' | 'granola' | 'linear' | 'notion' | 'slack',
    scope: 'you' | 'workspace',
    capabilities: string[],
  ): Promise<ConnectorOAuthStart> {
    const operationId = uuidV7();
    reportTelemetryProductIntent({
      kind: 'connector_setup_requested_v2',
      connector: provider,
      scope: scope === 'you' ? 'personal' : 'workspace',
      method: 'oauth',
      capabilityCount: telemetryCountBucket(capabilities.length),
      operationId,
    });
    return this.request(`/connections/${provider}/start?telemetryVersion=2&${this.connectorHandoffQuery()}`, {
      method: 'POST',
      headers: { [RALLY_HEADERS.OPERATION_ID]: operationId },
      body: { scope: scope === 'you' ? 'personal' : 'workspace', capabilities },
      schema: WireConnectorOAuthStartSchema,
    });
  }

  async createCustomMcpConnection(input: {
    displayName: string;
    scope: 'you' | 'workspace';
    serverUrl: string;
    requestHeaders: Record<string, string>;
    toolPolicy: CustomMcpToolPolicy;
  }): Promise<WorkstreamConnection> {
    reportTelemetryProductIntent({
      kind: 'connector_setup_requested_v2', connector: 'custom_mcp',
      scope: input.scope === 'you' ? 'personal' : 'workspace',
      method: 'api_key', capabilityCount: telemetryCountBucket(1),
    });
    const response = await this.request('/connections/custom-mcp', {
      method: 'POST',
      body: {
        displayName: input.displayName,
        scope: input.scope === 'you' ? 'personal' : 'workspace',
        serverUrl: input.serverUrl,
        requestHeaders: input.requestHeaders,
        toolPolicy: input.toolPolicy,
      },
      schema: z.object({ connection: WireConnectionSchema }),
    });
    return mapConnection(response.connection);
  }

  async startCustomMcpConnection(input: {
    displayName: string;
    scope: 'you' | 'workspace';
    serverUrl: string;
    toolPolicy: CustomMcpToolPolicy;
  }): Promise<ConnectorOAuthStart> {
    const operationId = uuidV7();
    reportTelemetryProductIntent({
      kind: 'connector_setup_requested_v2', connector: 'custom_mcp',
      scope: input.scope === 'you' ? 'personal' : 'workspace',
      method: 'oauth', capabilityCount: telemetryCountBucket(1),
      operationId,
    });
    return this.request(`/connections/custom-mcp/start?telemetryVersion=2&${this.connectorHandoffQuery()}`, {
      method: 'POST',
      headers: { [RALLY_HEADERS.OPERATION_ID]: operationId },
      body: {
        displayName: input.displayName,
        scope: input.scope === 'you' ? 'personal' : 'workspace',
        serverUrl: input.serverUrl,
        toolPolicy: input.toolPolicy,
      },
      schema: WireConnectorOAuthStartSchema,
    });
  }

  async getCustomMcpSettings(
    connectionId: string,
    signal?: AbortSignal,
  ): Promise<CustomMcpConnectionSettings> {
    return this.request(`/connections/${encodeURIComponent(connectionId)}/custom-mcp/tools`, {
      schema: WireCustomMcpConnectionSettingsSchema,
      signal,
    });
  }

  async updateCustomMcpToolPolicy(
    connectionId: string,
    toolPolicy: CustomMcpToolPolicy,
  ): Promise<CustomMcpConnectionSettings> {
    return this.request(`/connections/${encodeURIComponent(connectionId)}/custom-mcp/tool-policy`, {
      method: 'PUT',
      body: { toolPolicy },
      schema: WireCustomMcpConnectionSettingsSchema,
    });
  }

  async createXConnection(
    capabilities: string[],
  ): Promise<WorkstreamConnection> {
    reportTelemetryProductIntent({
      kind: 'connector_setup_requested_v2', connector: 'x', scope: 'workspace',
      method: 'api_key', capabilityCount: telemetryCountBucket(capabilities.length),
    });
    const response = await this.request('/connections/x', {
      method: 'POST',
      body: { scope: 'workspace', capabilities },
      schema: z.object({ connection: WireConnectionSchema }),
    });
    return mapConnection(response.connection);
  }

  async replaceInstallationApiKey(connectionId: string, apiKey: string) {
    return this.request(`/connections/${connectionId}/installation/api-key`, {
      method: 'POST', body: { apiKey }, schema: ConnectorInstallationMutationResponseSchema,
    });
  }

  async createAshbyWorkspaceConnection(apiKey: string, idempotencyKey: string) {
    return this.request('/connections/ashby/workspace', {
      method: 'POST', body: { apiKey, idempotencyKey },
      schema: ConnectorInstallationSetupResponseSchema,
    });
  }

  async connectorInstallation(connectionId: string) {
    return this.request(`/connections/${connectionId}/installation`, {
      schema: ConnectorInstallationReadResponseSchema,
    });
  }

  async changeConnectorInstallation(connectionId: string, input: {
    action: 'repair' | 'disconnect' | 'forget_cleanup' | 'reconcile' | 'rotate'; key?: string; providerId?: string;
  }) {
    return this.request(`/connections/${connectionId}/installation`, {
      method: 'POST', body: input, schema: ConnectorInstallationMutationResponseSchema,
    });
  }

  async createGranolaWorkspaceConnection(apiKey: string, idempotencyKey: string): Promise<WorkstreamConnection> {
    reportTelemetryProductIntent({
      kind: 'connector_setup_requested_v2', connector: 'granola', scope: 'workspace',
      method: 'api_key', capabilityCount: telemetryCountBucket(1),
    });
    const response = await this.request('/connections/granola/workspace', {
      method: 'POST',
      body: { apiKey, idempotencyKey, capabilities: ['granola.workspace.read'] },
      schema: z.object({ connection: WireConnectionSchema }),
    });
    return mapConnection(response.connection);
  }

  async createWebhookConnection(
    displayName: string,
    scope: 'you' | 'workspace',
    eventTypes: string[],
    idempotencyKey: string,
  ): Promise<{
    connection: WorkstreamConnection;
    endpoint: string;
    signingSecret: string;
    signatureFormat: string;
  }> {
    reportTelemetryProductIntent({
      kind: 'connector_setup_requested_v2', connector: 'generic_webhook',
      scope: scope === 'you' ? 'personal' : 'workspace', method: 'webhook', capabilityCount: telemetryCountBucket(0),
    });
    const response = await this.request('/connections/webhook', {
      method: 'POST',
      body: {
        displayName,
        scope: scope === 'you' ? 'personal' : 'workspace',
        eventTypes,
        idempotencyKey,
      },
      schema: z.object({
        connection: WireConnectionSchema,
        endpoint: HttpUrlSchema,
        signingSecret: z.string().min(1),
        signatureFormat: z.string().min(1),
      }),
    });
    return { ...response, connection: mapConnection(response.connection) };
  }

  async rotateWebhookSecret(id: string): Promise<{
    endpoint: string;
    signingSecret: string;
    signatureFormat: string;
  }> {
    return this.request(`/connections/${encodeURIComponent(id)}/webhook-secret/rotate`, {
      method: 'POST',
      schema: z.object({
        endpoint: HttpUrlSchema,
        signingSecret: z.string().min(1),
        signatureFormat: z.string().min(1),
      }),
    });
  }

  async reconnectConnection(
    id: string,
    provider?: 'apollo' | 'ashby' | 'canva' | 'fireflies' | 'google' | 'github' | 'linear' | 'notion' | 'slack',
    scope: 'you' | 'workspace' = 'you',
    capabilityCount = 0,
  ): Promise<ConnectorOAuthStart> {
    const operationId = provider ? uuidV7() : null;
    if (provider && operationId) {
      reportTelemetryProductIntent({
        kind: 'connector_setup_requested_v2', connector: provider,
        scope: scope === 'you' ? 'personal' : 'workspace', method: 'oauth',
        capabilityCount: telemetryCountBucket(capabilityCount),
        operationId,
      });
    }
    return this.request(
      `/connections/${encodeURIComponent(id)}/reconnect?telemetryVersion=2&${this.connectorHandoffQuery()}`,
      {
        method: 'POST',
        ...(operationId ? { headers: { [RALLY_HEADERS.OPERATION_ID]: operationId } } : {}),
        schema: WireConnectorOAuthStartSchema,
      },
    );
  }

  async getConnectorOAuthAttempt(attemptId: string, signal?: AbortSignal): Promise<ConnectorOAuthAttempt> {
    return this.request(`/connections/oauth-attempts/${encodeURIComponent(attemptId)}`, {
      schema: WireConnectorOAuthAttemptSchema,
      signal,
    });
  }

  async startConnectorResourceAuthorization(
    request: ConnectorResourceAuthorizationRequest,
  ): Promise<ConnectorResourceAuthorizationStart> {
    return this.request(
      `/connections/${encodeURIComponent(request.connectionId)}/resource-authorizations/start?${this.connectorHandoffQuery()}`,
      {
        method: 'POST',
        body: { target: {
          parentKind: request.parentKind,
          parentId: request.parentId,
          substreamId: request.substreamId,
          failedToolInvocationId: request.failedToolInvocationId,
        } },
        schema: WireConnectorResourceAuthorizationStartSchema,
      },
    );
  }

  async testConnection(id: string) {
    return this.request(`/connections/${encodeURIComponent(id)}/test`, {
      method: 'POST', schema: ConnectionTestResponseSchema,
    });
  }

  async disconnectConnection(id: string): Promise<void> {
    await this.requestVoid(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async linkSlackUser(token: string): Promise<{ linked: true; teamId: string; slackUserId: string }> {
    return this.request('/connections/slack/link', {
      method: 'POST',
      body: { token },
      schema: z.object({ linked: z.literal(true), teamId: z.string().min(1), slackUserId: z.string().min(1) }),
    });
  }

  async previewSlackUserLink(token: string): Promise<{ teamId: string; slackUserId: string; workspaceName: string }> {
    return this.request('/connections/slack/link/preview', {
      method: 'POST',
      body: { token },
      schema: z.object({ teamId: z.string().min(1), slackUserId: z.string().min(1), workspaceName: z.string().min(1) }),
    });
  }

  async observeSignupView(flowId: string): Promise<void> {
    await this.requestVoid('/auth/signup/view', { method: 'POST', body: { flowId } });
  }

  async beginGoogleLogin(
    region: Region,
    callbackUri: string,
    input: { workspaceName?: string; invitationToken?: string; authAttempt: DesktopAuthAttempt; signupFlowId?: string },
  ): Promise<string> {
    const result = await this.request('/auth/google/start', {
      method: 'POST',
      body: {
        region,
        returnUri: callbackUri,
        ...(input.signupFlowId ? { signupFlowId: input.signupFlowId } : {}),
        desktopAttemptId: input.authAttempt.attemptId,
        desktopCodeChallenge: input.authAttempt.codeChallenge,
        ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
        ...(input.invitationToken ? { invitationToken: input.invitationToken } : {}),
      },
      schema: z.object({ url: HttpUrlSchema }),
    });
    return result.url;
  }

}

