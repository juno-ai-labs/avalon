import { RALLY_HEADERS } from '@rally/contracts/http-headers';
import {
  AutomationDetailSchema as WireAutomationDetailSchema,
  AutomationAgentSnapshotSchema as WireAutomationAgentSnapshotSchema,
  AutomationDraftTurnAdmissionResultSchema as WireAutomationDraftTurnAdmissionResultSchema,
  AutomationDraftSchema as WireAutomationDraftSchema,
  AutomationSummarySchema as WireAutomationSummarySchema,
  WorkstreamAutomationSummarySchema as WireWorkstreamAutomationSummarySchema,
  WorkstreamBatchAcceptedSchema as WireWorkstreamBatchAcceptedSchema,
  WorkstreamBatchPreviewSchema as WireWorkstreamBatchPreviewSchema,
  ClientFeatureFlagsSchema as WireClientFeatureFlagsSchema,
  ConnectionSchema as WireConnectionSchema,
  GitHubRepositoryAccessSettingsSchema as WireGitHubRepositoryAccessSettingsSchema,
  ConnectorOAuthAttemptSchema as WireConnectorOAuthAttemptSchema,
  ConnectorOAuthStartSchema as WireConnectorOAuthStartSchema,
  CursorPageSchema,
  ElicitationSchema as WireElicitationSchema,
  BlockDashboardPreferenceSchema as WireBlockDashboardPreferenceSchema,
  BlockDashboardSchema as WireBlockDashboardSchema,
  NoteDetailSchema as WireNoteDetailSchema,
  NoteCursorSchema as WireNoteCursorSchema,
  NoteSummarySchema as WireNoteSummarySchema,
  NoteTranscriptSegmentSchema as WireNoteTranscriptSegmentSchema,
  ParticipantSchema as WireParticipantSchema,
  PendingWorkspaceInvitationSchema as WirePendingWorkspaceInvitationSchema,
  ResourceSchema as WireResourceSchema,
  WorkstreamResourceSchema as WireWorkstreamResourceSchema,
  type ToolInvocationSchema as WireToolInvocationSchema,
  type ViewerSchema as WireViewerSchema,
  WorkspaceMemberSchema as WireWorkspaceMemberSchema,
  WorkspaceInvitationPreviewSchema as WireWorkspaceInvitationPreviewSchema,
  WorkspaceInvitationSchema as WireWorkspaceInvitationSchema,
  WorkspaceSchema as WireWorkspaceSchema,
  TerminalWorkspaceSettingsSchema as WireTerminalWorkspaceSettingsSchema,
  TerminalNetworkPolicyPreviewSchema as WireTerminalNetworkPolicyPreviewSchema,
  WorkstreamBootSchema as WireWorkstreamBootSchema,
  DigestScheduleSchema as WireDigestScheduleSchema,
  WorkstreamSchema as WireWorkstreamSchema,
  WorkOpportunityPageSchema as WireWorkOpportunityPageSchema,
  type AutomationDraft as WireAutomationDraft,
  type AutomationAgentSnapshot as WireAutomationAgentSnapshot,
  type AutomationDraftTurnAdmissionResult as WireAutomationDraftTurnAdmissionResult,
  type AutomationRun as WireAutomationRun,
  type BackgroundTask as WireBackgroundTask,
  type ClientFeatureFlags,
  type Connection as WireConnection,
  type ConnectorOAuthAttempt,
  type ConnectorOAuthStart,
  type Elicitation as WireElicitation,
  type Resource as WireResource,
  ResourceRevisionSchema as WireResourceRevisionSchema,
  type ResourceRevision as WireResourceRevision,
  type WorkstreamResource as WireWorkstreamResource,
  type User as WireUser,
  type Workstream as WireWorkstream,
  type WorkstreamBatchFilter,
  type WorkstreamBatchUpdate,
  type WorkstreamDetail as WireWorkstreamDetail,
  type GitHubRepositoryAccessSettings as WireGitHubRepositoryAccessSettings,
  ProjectDirectorySchema as WireProjectDirectorySchema,
  ProjectSummarySchema as WireProjectSummarySchema,
  ReorderPendingLoopInputsResultSchema,
  type CreateProjectRequest,
  type PendingTranscriptInput,
  type ProjectDirectory,
  type ProjectSummary,
  type UpdateProjectPresentationRequest,
  type UpdateProjectAudienceRequest,
} from '@rally/contracts';
import { socketTicketProtocols, socketUrlWithoutTicket } from '@rally/contracts/socket-tickets';
import { HttpUrlSchema } from '@rally/contracts/url-schemas';
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { DesktopAuthAttempt, DesktopSession } from '../../common/desktop';
import { normalizeElicitation } from './elicitation';
import { resolveMentionPayload } from './mention-draft';
import { newRequestId } from './perf-trace';
import { logDebug } from '../../common/logger';
import { reportJavascriptError, reportTelemetryProductIntent, telemetryCountBucket, uuidV7 } from './telemetry';
import type { TelemetrySurfaceEntrypoint } from './telemetry';
import type {
  AgentModelOverride,
  AutomationCreateOptions,
  AutomationDeliveryTargetType,
  AutomationDetail,
  AutomationDraftResponse,
  AutomationRunSummary,
  AutomationSummary,
  WorkstreamAutomationSummary,
  BackgroundTask,
  CreatedWorkstream,
  DigestSchedule,
  ElicitationData,
  HarnessStatus,
  BlockDashboard,
  BlockDashboardPreference,
  NoteDetail,
  NoteSummary,
  NoteTranscriptSegment,
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
  WorkspaceTemplate,
  WorkstreamConnection,
  WorkstreamDeferredContext,
  WorkstreamBoot,
  WorkstreamDetail,
  ResourceVersion,
  WorkstreamResource,
  WorkstreamSummary,
  WorkOpportunity,
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

interface DraftState {
  attachmentIds: string[];
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  draft: WireAutomationDraft | null;
}

export interface MentionIdentity {
  type: 'person' | 'connector';
  label: string;
  userId: string | null;
  connectorType: string | null;
  /** UTF-16 offsets for the exact autocomplete selection in the draft. */
  startOffset?: number;
  endOffset?: number;
}

const wirePinnedWorkstreamsSchema = z.object({ items: z.array(WireWorkstreamSchema) });
const wireResourcePageSchema = CursorPageSchema(WireResourceSchema);
const wireNotePageSchema = z.object({
  items: z.array(WireNoteSummarySchema),
  nextCursor: WireNoteCursorSchema.nullable(),
});
const wireMemberPageSchema = z.object({ items: z.array(WireWorkspaceMemberSchema) });
const wireInvitationPageSchema = z.object({ items: z.array(WireWorkspaceInvitationSchema) });
const wireAutomationPageSchema = z.object({ items: z.array(WireAutomationSummarySchema) });
const wireWorkstreamAutomationPageSchema = z.object({
  items: z.array(WireWorkstreamAutomationSummarySchema),
});
const wireConnectionPageSchema = z.object({ items: z.array(WireConnectionSchema) });
const wireTemplatePageSchema = z.object({
  items: z.array(z.object({
    id: z.string(),
    name: z.string(),
    author: z.string(),
    description: z.string(),
    usedBy: z.number(),
    requiredCapabilities: z.array(z.string()),
    latestVersion: z.number(),
    activitySources: z.array(z.object({
      bindingKey: z.string(),
      connectorType: z.string(),
      suggestedPluginId: z.string().optional(),
    })).default([]),
  })),
});
const createWorkstreamResponseSchema = z.object({
  workstream: WireWorkstreamSchema,
  turnId: z.string(),
  harnessRunId: z.string().nullable(),
}).strict();
const runNowResponseSchema = z.object({
  runId: z.string(),
  workstreamId: z.string(),
  harnessRunId: z.string().optional(),
  reused: z.boolean(),
});
// The issuing endpoints still put the ticket in the URL for desktop builds
// released before the subprotocol scheme. Strip it on the way in, so no call
// site can open a socket whose URL carries the credential.
const socketTicketSchema = z.object({
  url: z.string(),
  ticket: z.string(),
  // Optional because the socket-ticket shape is shared with regional Workers
  // that predate it; a client that does not get one simply prints no ticket id.
  ticketId: z.string().optional(),
})
  .transform(({ url, ticket, ticketId }): SocketTicket => ({
    url: socketUrlWithoutTicket(url),
    ticket,
    protocols: socketTicketProtocols(ticket),
    ...(ticketId === undefined ? {} : { ticketId }),
  }));

export function normalizeHarnessStatus(status: WireWorkstream['harnessStatus']): HarnessStatus {
  return status === 'idle' ? 'completed' : status;
}

function mapUser(user: WireUser): WorkspaceMember {
  return {
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

function mapResourceVersion(revision: WireResourceRevision): ResourceVersion {
  return {
    version: revision.version,
    capturedAt: revision.createdAt,
    author: revision.author,
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
    ...(connection.ownerName ? { ownerName: connection.ownerName } : {}),
    status: connection.status === 'healthy'
      ? 'healthy'
      : connection.status === 'disabled'
        ? 'disabled'
        : 'reconnect_required',
    capabilities: connection.grantedCapabilities,
    ...(connection.settingsKind ? { settingsKind: connection.settingsKind } : {}),
    ...(connection.userDelivery ? { userDelivery: connection.userDelivery } : {}),
  };
}

export function mapWorkstreamSummary(workstream: WireWorkstream): WorkstreamSummary {
  return {
    id: workstream.id,
    title: workstream.title,
    titleStatus: workstream.titleStatus,
    objective: workstream.objective,
    ...(workstream.emailAddress ? { emailAddress: workstream.emailAddress } : {}),
    origin: workstream.originType,
    ...(workstream.createdByUserId ? { createdByUserId: workstream.createdByUserId } : {}),
    ...(workstream.originLabel ? { automationName: workstream.originLabel } : {}),
    ...(workstream.automationSubscriptionId
      ? { automationSubscriptionId: workstream.automationSubscriptionId }
      : {}),
    ...(workstream.automationRunId ? { automationRunId: workstream.automationRunId } : {}),
    harnessStatus: normalizeHarnessStatus(workstream.harnessStatus),
    latestAttentionSequenceNumber: workstream.latestAttentionSequenceNumber,
    readThroughSequenceNumber: workstream.readThroughSequenceNumber,
    manualUnreadFromSequenceNumber: workstream.manualUnreadFromSequenceNumber,
    manualUnreadGeneration: workstream.manualUnreadGeneration,
    hasUnread: workstream.hasUnread,
    youAreMentioned: workstream.youAreMentioned,
    unseen: workstream.unseen,
    firstUnreadSequenceNumber: workstream.firstUnreadSequenceNumber,
    lastActivityAt: workstream.lastActivityAt,
    createdAt: workstream.createdAt,
    updatedAt: workstream.updatedAt,
    ...(workstream.archivedAt ? { archivedAt: workstream.archivedAt } : {}),
    ...(workstream.plannedFor ? { plannedFor: workstream.plannedFor } : {}),
    scope: workstream.scope,
    ...(workstream.systemKind ? { systemKind: workstream.systemKind } : {}),
    nextPendingWakeup: workstream.nextPendingWakeup
      ? { ...workstream.nextPendingWakeup }
      : null,
    pinPosition: workstream.pinPosition,
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
    name: invocation.activityName ?? invocation.toolName,
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
    automationRuns: [],
    ...(workstream.modelOverride ? { modelOverride: workstream.modelOverride } : {}),
    ...(workstream.automationSubscriptionId ? { automationSubscriptionId: workstream.automationSubscriptionId } : {}),
    ...(workstream.automationRunId ? { automationRunId: workstream.automationRunId } : {}),
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
    case 'calendar': return trigger.summary;
    case 'interval': return trigger.summary;
    case 'connector_activity': return `${trigger.connectorType}: ${trigger.eventTypes.join(', ')}`;
    case 'semantic_activity': return trigger.condition;
    case 'resource_watch': return 'When the attached resource changes';
    case 'webhook': return `Webhook: ${trigger.eventTypes.join(', ')}`;
  }
}

function activitySourcesFromTriggers(
  triggers: WireAutomationDraft['triggers'],
): Array<{ bindingKey: string; connectorType: string; suggestedPluginId?: string }> {
  const sources = new Map<string, { bindingKey: string; connectorType: string; suggestedPluginId?: string }>();
  for (const trigger of triggers) {
    if (trigger.type !== 'connector_activity' && trigger.type !== 'semantic_activity' && trigger.type !== 'webhook') continue;
    if (!trigger.sourceBindingKey) continue;
    sources.set(trigger.sourceBindingKey, {
      bindingKey: trigger.sourceBindingKey,
      connectorType: trigger.type === 'webhook' ? 'generic_webhook' : trigger.connectorType ?? '',
      ...(trigger.suggestedSourcePluginId ? { suggestedPluginId: trigger.suggestedSourcePluginId } : {}),
    });
  }
  return [...sources.values()].filter((source) => source.connectorType);
}

function mapAutomationRun(run: WireAutomationRun, title: string): AutomationRunSummary {
  const triggerTime = run.plannedFor ?? run.startedAt ?? run.createdAt;
  const start = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
  const end = run.completedAt ? Date.parse(run.completedAt) : Number.NaN;
  return {
    id: run.id,
    workstreamId: run.workstreamId,
    title,
    status: normalizeHarnessStatus(run.status),
    triggerType: ['schedule', 'calendar', 'interval'].includes(run.triggerType)
      ? 'scheduled'
      : run.triggerType,
    triggerTime,
    ...(run.resultSummary ? { resultSummary: run.resultSummary } : {}),
    ...(Number.isFinite(start) && Number.isFinite(end) ? { durationMs: end - start } : {}),
  };
}

/** Exported for the workspace socket's sidebar batch, which carries the same wire rows. */
export function mapAutomationSummary(automation: z.infer<typeof WireAutomationSummarySchema>): AutomationSummary {
  return {
    id: automation.id,
    name: automation.name,
    ...(automation.emailAddress ? { emailAddress: automation.emailAddress } : {}),
    scope: automation.scope === 'personal' ? 'you' : 'workspace',
    status: automation.status,
    ...(automation.attention ? { attention: automation.attention } : {}),
    ...(automation.nextRunAt ? { nextRunAt: automation.nextRunAt } : {}),
    ...(automation.lastRunAt ? { lastRunAt: automation.lastRunAt } : {}),
    updatedAt: automation.updatedAt,
    ...(automation.updateAvailable ? { statusMessage: 'Update available' } : {}),
  };
}

/**
 * The rail's rows.
 *
 * Written out rather than delegating to {@link mapAutomationSummary} with an
 * invented scope: the wire row has no scope, and manufacturing one to throw
 * away would put a value in the type that no caller may trust.
 */
export function mapWorkstreamAutomationSummary(
  automation: z.infer<typeof WireWorkstreamAutomationSummarySchema>,
): WorkstreamAutomationSummary {
  return {
    id: automation.id,
    name: automation.name,
    ...(automation.emailAddress ? { emailAddress: automation.emailAddress } : {}),
    status: automation.status,
    ...(automation.attention ? { attention: automation.attention } : {}),
    ...(automation.nextRunAt ? { nextRunAt: automation.nextRunAt } : {}),
    ...(automation.lastRunAt ? { lastRunAt: automation.lastRunAt } : {}),
    updatedAt: automation.updatedAt,
    ...(automation.updateAvailable ? { statusMessage: 'Update available' } : {}),
  };
}

function mapAutomationDetail(detail: z.infer<typeof WireAutomationDetailSchema>): AutomationDetail {
  const runs = detail.recentRuns.map((run) => mapAutomationRun(run, detail.name));
  const schedule = detail.triggers.find((trigger) => trigger.type === 'calendar' || trigger.type === 'interval');
  const planned = detail.nextPlannedWorkstream;
  return {
    ...mapAutomationSummary(detail),
    description: detail.description,
    versionNumber: detail.versionNumber,
    overview: detail.overview,
    instructions: detail.instructions,
    triggerSummary: detail.triggers.map(triggerSummary).join(' · '),
    ...(schedule ? { scheduleSummary: triggerSummary(schedule) } : {}),
    capabilities: detail.requiredCapabilities,
    expectedOutputs: detail.expectedOutputs,
    recommendedPlugins: detail.recommendedPlugins,
    defaultPluginIds: detail.defaultPluginIds,
    activitySourcePluginIds: detail.activitySourcePluginIds,
    activitySources: activitySourcesFromTriggers(detail.triggers),
    deliveryTargets: detail.deliveryTargets,
    executionScope: detail.executionPrincipal['type'] === 'workspace' ? 'Workspace' : 'You',
    runs,
    ...(detail.templateUpdate
      ? {
          templateUpdate: {
            versionId: detail.templateUpdate.versionId,
            versionNumber: detail.templateUpdate.versionNumber,
            overview: detail.templateUpdate.overview,
            instructions: detail.templateUpdate.instructions,
            triggerSummary: detail.templateUpdate.triggers.map(triggerSummary).join(' · '),
            capabilities: detail.templateUpdate.requiredCapabilities,
            expectedOutputs: detail.templateUpdate.expectedOutputs,
            recommendedPlugins: detail.templateUpdate.recommendedPlugins,
            activitySources: activitySourcesFromTriggers(detail.templateUpdate.triggers),
          },
        }
      : {}),
    ...(planned
      ? {
          nextRun: {
            id: planned.automationRunId ?? planned.id,
            workstreamId: planned.id,
            title: planned.title,
            status: normalizeHarnessStatus(planned.harnessStatus),
            triggerType: 'scheduled',
            triggerTime: planned.plannedFor ?? planned.createdAt,
          },
        }
      : {}),
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
  private readonly drafts = new Map<string, DraftState>();
  private readonly automationDetails = new Map<string, z.infer<typeof WireAutomationDetailSchema>>();
  private readonly pendingRunKeys = new Map<string, string>();

  private renewCredential: (() => Promise<DesktopSession>) | null = null;
  private renewalInFlight: Promise<string | null> | null = null;

  constructor(
    readonly baseUrl: string,
    private session: DesktopSession | null,
  ) {}

  setSession(session: DesktopSession | null): void {
    this.session = session;
  }

  /** Access tokens live minutes while the durable refresh credential lives
   * weeks. Without a reactive renewal an expired bearer fails every request
   * with `invalid_session` until the app restarts, because retrying replays
   * the same dead token. */
  setCredentialRenewal(renew: (() => Promise<DesktopSession>) | null): void {
    this.renewCredential = renew;
  }

  private async send(path: string, init: RequestInit, accessToken: string | null): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw networkApiError('Rally could not reach the selected regional service.', error);
    }
  }

  /** Resolves the credential a replay should use, or null when there is
   * nothing newer to retry under. Signing out mid-flight clears the session,
   * and an unauthenticated replay would only fail again. */
  private async renewedCredential(rejectedToken: string): Promise<string | null> {
    const current = this.session?.accessToken ?? null;
    // A token that already moved on was renewed by a concurrent request, so
    // replay against the current one instead of burning another rotation.
    if (current !== rejectedToken) return current;
    const renew = this.renewCredential;
    if (!renew) return null;
    this.renewalInFlight ??= renew()
      .then((session) => {
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
    const accessToken = this.session?.accessToken ?? null;
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

  private async request<T>(path: string, options: RequestOptions<T>): Promise<T> {
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
    if (response.status === 204) throw new ApiError('The service returned no response body.', 502, 'unexpected_empty_response');
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

  async getWorkspace(signal?: AbortSignal): Promise<Workspace> {
    const raw = await this.request('/workspace', { schema: WireWorkspaceSchema, signal });
    let currentUser: WorkspaceMember | undefined = this.session?.user
      ? { ...this.session.user, timezone: this.session.user.timezone ?? 'America/Los_Angeles', role: raw.role }
      : undefined;
    if (!currentUser) {
      const members = await this.getWorkspaceMembers(signal);
      const matched = members.find((member) => member.role === raw.role) ?? members[0];
      currentUser = matched ? { ...matched, role: raw.role } : undefined;
    }
    if (!currentUser) throw new ApiError('The signed-in user is missing from this workspace.', 401, 'session_profile_missing');
    return {
      id: raw.id,
      name: raw.name,
      region: raw.region,
      timezone: raw.timezone,
      currentUser,
    };
  }

  async updateMyTimezone(timezone: string): Promise<WorkspaceMember> {
    const user = await this.request('/workspace/me', {
      method: 'PATCH',
      body: { timezone },
      schema: z.object({
        id: z.string(), email: z.string(), name: z.string(), avatarUrl: z.string().nullable(),
        timezone: z.string(), createdAt: z.string(),
      }),
    });
    return mapUser(user);
  }

  async updateWorkspaceTimezone(timezone: string): Promise<Workspace> {
    await this.request('/workspace', { method: 'PATCH', body: { timezone }, schema: WireWorkspaceSchema });
    return this.getWorkspace();
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

  async getDigestSchedule(signal?: AbortSignal): Promise<DigestSchedule> {
    return this.request('/digest', { schema: WireDigestScheduleSchema, signal });
  }

  /**
   * Replaces the digest wholesale. A partial update could not express "no days"
   * or "no destinations", and both are things someone can legitimately mean.
   */
  async updateDigestSchedule(input: {
    enabled: boolean;
    days: number[];
    times: number[];
    deliveryTargets: Array<{ type: AutomationDeliveryTargetType; connectionId: string | null }>;
  }): Promise<DigestSchedule> {
    return this.request('/digest', { method: 'PUT', body: input, schema: WireDigestScheduleSchema });
  }

  async getWorkspaceMembers(signal?: AbortSignal): Promise<WorkspaceMember[]> {
    const page = await this.request('/workspace/members', { schema: wireMemberPageSchema, signal });
    return page.items.map((member) => ({
      ...mapUser(member.user),
      role: member.role,
      // Carried, not dropped: the roster is the only list that can contain a
      // membership the work-stream endpoints will refuse, and a caller that
      // cannot see the status has no way to keep one out of a picker.
      status: member.status,
    }));
  }

  async getInvitationPreview(token: string, signal?: AbortSignal): Promise<WorkspaceInvitationPreview> {
    return this.request(`/auth/invitations/preview?token=${encodeURIComponent(token)}`, {
      schema: WireWorkspaceInvitationPreviewSchema,
      signal,
    });
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

  async createWorkspace(name: string): Promise<void> {
    await this.requestVoid('/onboarding/workspace', { method: 'POST', body: { name } });
  }

  async acceptPendingWorkspaceInvitation(id: string): Promise<void> {
    await this.requestVoid(`/onboarding/invitations/${encodeURIComponent(id)}/accept`, { method: 'POST' });
  }

  async declinePendingWorkspaceInvitation(id: string): Promise<void> {
    await this.requestVoid(`/onboarding/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async getAutomations(signal?: AbortSignal): Promise<AutomationSummary[]> {
    const page = await this.request('/automations', { schema: wireAutomationPageSchema, signal });
    return page.items.map(mapAutomationSummary);
  }

  /** What one work stream owns. Its rail is the only place these are listed. */
  async getWorkstreamAutomations(
    workstreamId: string,
    signal?: AbortSignal,
  ): Promise<WorkstreamAutomationSummary[]> {
    const page = await this.request(
      `/automations/workstream/${encodeURIComponent(workstreamId)}`,
      { schema: wireWorkstreamAutomationPageSchema, signal },
    );
    return page.items.map(mapWorkstreamAutomationSummary);
  }

  async getAutomation(id: string, signal?: AbortSignal): Promise<AutomationDetail> {
    const raw = await this.request(`/automations/${encodeURIComponent(id)}`, { schema: WireAutomationDetailSchema, signal });
    this.automationDetails.set(id, raw);
    return mapAutomationDetail(raw);
  }

  async updateAutomation(id: string, input: {
    instructions?: string;
    activitySourcePluginIds?: Record<string, string>;
    /** Absent leaves destinations alone; present replaces the whole set. */
    deliveryTargets?: Array<{ type: 'email' } | { type: 'slack_agent_dm'; connectionId: string }>;
  }): Promise<AutomationDetail> {
    const updated = await this.request(`/automations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
      schema: WireAutomationDetailSchema,
    });
    this.automationDetails.set(id, updated);
    return mapAutomationDetail(updated);
  }

  async adoptAutomationUpdate(
    id: string,
    versionId: string,
    activitySourcePluginIds?: Record<string, string>,
  ): Promise<AutomationDetail> {
    const updated = await this.request(`/automation-subscriptions/${encodeURIComponent(id)}/adopt-version`, {
      method: 'POST',
      body: { versionId, ...(activitySourcePluginIds ? { activitySourcePluginIds } : {}) },
      schema: WireAutomationDetailSchema,
    });
    this.automationDetails.set(id, updated);
    return mapAutomationDetail(updated);
  }

  async shareAutomation(id: string): Promise<{ templateId: string }> {
    return this.request('/automation-templates', {
      method: 'POST',
      body: { automationSubscriptionId: id },
      schema: z.object({ templateId: z.string() }),
    });
  }

  async setAutomationStatus(id: string, action: 'pause' | 'resume'): Promise<AutomationDetail> {
    await this.requestVoid(`/automations/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
    return this.getAutomation(id);
  }

  async deleteAutomation(id: string): Promise<void> {
    await this.requestVoid(`/automations/${encodeURIComponent(id)}`, { method: 'DELETE' });
    this.automationDetails.delete(id);
  }

  async runAutomation(id: string): Promise<WorkstreamSummary> {
    const idempotencyKey = this.pendingRunKeys.get(id) ?? crypto.randomUUID();
    this.pendingRunKeys.set(id, idempotencyKey);
    const result = await this.request(`/automations/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      schema: runNowResponseSchema,
    });
    this.pendingRunKeys.delete(id);
    return {
      id: result.workstreamId,
      title: 'Automation run',
      titleStatus: 'settled',
      origin: 'automation',
      harnessStatus: 'running',
      scope: 'workspace',
      lastActivityAt: new Date().toISOString(),
      latestAttentionSequenceNumber: 0,
      readThroughSequenceNumber: 0,
      manualUnreadFromSequenceNumber: null,
      manualUnreadGeneration: 0,
      hasUnread: false,
      firstUnreadSequenceNumber: null,
      nextPendingWakeup: null,
      pinPosition: null,
      participantUserIds: [],
      participantExtraCount: 0,
    };
  }

  async getWorkOpportunities(signal?: AbortSignal): Promise<WorkOpportunity[]> {
    const page = await this.request('/work-opportunities?limit=4', {
      schema: WireWorkOpportunityPageSchema,
      signal,
    });
    return page.items;
  }

  async recordWorkOpportunityImpressions(opportunityIds: string[]): Promise<void> {
    await this.requestVoid('/work-opportunities/impressions', {
      method: 'POST',
      body: { opportunityIds, surface: 'workspace_home' },
    });
  }

  async dismissWorkOpportunity(id: string, version?: number, position?: number): Promise<void> {
    const query = new URLSearchParams({ surface: 'workspace_home' });
    if (version != null) query.set('version', String(version));
    if (position != null) query.set('position', String(position));
    await this.requestVoid(`/work-opportunities/${encodeURIComponent(id)}?${query.toString()}`, { method: 'DELETE' });
  }

  async startWorkOpportunity(
    id: string,
    version: number,
    idempotencyKey: string,
    surface: 'workspace_home',
    position?: number,
  ): Promise<CreatedWorkstream> {
    const response = await this.request(`/work-opportunities/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      body: { version, idempotencyKey, surface, ...(position == null ? {} : { position }) },
      schema: createWorkstreamResponseSchema,
    });
    return {
      workstream: mapWorkstreamSummary(response.workstream),
      turnId: response.turnId,
      clientMessageId: `opportunity:${id}:v${version}`,
      createdAt: response.workstream.createdAt,
      harnessRunId: response.harnessRunId,
    };
  }

  /** One page of the note list, newest first; `before` resumes after a cursor. */
  async getNotes(
    input: { limit: number; before?: string } = { limit: 250 },
    signal?: AbortSignal,
  ): Promise<{ items: NoteSummary[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: String(input.limit) });
    if (input.before) query.set('before', input.before);
    return this.request(`/notes?${query.toString()}`, { schema: wireNotePageSchema, signal });
  }

  createProject(input: CreateProjectRequest): Promise<ProjectSummary> {
    return this.request('/projects', {
      method: 'POST',
      body: input,
      schema: WireProjectSummarySchema,
    });
  }

  updateProject(id: string, input: UpdateProjectPresentationRequest): Promise<ProjectSummary> {
    return this.request(`/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
      schema: WireProjectSummarySchema,
    });
  }

  updateProjectAudience(id: string, input: UpdateProjectAudienceRequest): Promise<ProjectSummary> {
    return this.request(`/projects/${encodeURIComponent(id)}/audience`, {
      method: 'PATCH',
      body: input,
      schema: WireProjectSummarySchema,
    });
  }

  archiveProject(id: string): Promise<ProjectSummary> {
    return this.request(`/projects/${encodeURIComponent(id)}/archive`, {
      method: 'POST',
      schema: WireProjectSummarySchema,
    });
  }

  restoreProject(id: string): Promise<ProjectSummary> {
    return this.request(`/projects/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      schema: WireProjectSummarySchema,
    });
  }

  reorderProjects(projectIds: string[]): Promise<ProjectDirectory> {
    return this.request('/projects/order', {
      method: 'PUT',
      body: { projectIds },
      schema: WireProjectDirectorySchema,
    });
  }

  addWorkstreamToProject(projectId: string, workstreamId: string): Promise<ProjectSummary> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/workstreams`, {
      method: 'POST',
      body: { workstreamId },
      schema: WireProjectSummarySchema,
    });
  }

  removeWorkstreamFromProject(projectId: string, workstreamId: string): Promise<ProjectSummary> {
    return this.request(
      `/projects/${encodeURIComponent(projectId)}/workstreams/${encodeURIComponent(workstreamId)}`,
      { method: 'DELETE', schema: WireProjectSummarySchema },
    );
  }

  addProjectDefaultResource(projectId: string, resourceId: string): Promise<ProjectSummary> {
    return this.request(`/projects/${encodeURIComponent(projectId)}/default-resources`, {
      method: 'POST',
      body: { resourceId },
      schema: WireProjectSummarySchema,
    });
  }

  removeProjectDefaultResource(projectId: string, resourceId: string): Promise<ProjectSummary> {
    return this.request(
      `/projects/${encodeURIComponent(projectId)}/default-resources/${encodeURIComponent(resourceId)}`,
      { method: 'DELETE', schema: WireProjectSummarySchema },
    );
  }

  createNote(id: string, title: string): Promise<NoteDetail> {
    return this.request('/notes', {
      method: 'POST',
      body: { id, title, scope: 'personal' },
      schema: WireNoteDetailSchema,
    });
  }

  getNote(id: string, signal?: AbortSignal): Promise<NoteDetail> {
    return this.request(`/notes/${encodeURIComponent(id)}`, { schema: WireNoteDetailSchema, signal });
  }

  updateNote(
    id: string,
    input: {
      title?: string;
      manualNotes?: string;
      scope?: 'personal' | 'workspace';
      recordingStatus?: 'idle' | 'recording' | 'complete';
      recordedMs?: number;
      startedAt?: string | null;
      endedAt?: string | null;
    },
  ): Promise<NoteDetail> {
    return this.request(`/notes/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
      schema: WireNoteDetailSchema,
    });
  }

  archiveNote(id: string): Promise<void> {
    return this.requestVoid(`/notes/${encodeURIComponent(id)}/archive`, { method: 'POST' });
  }

  appendNoteTranscriptSegment(
    id: string,
    input: {
      clientSegmentId: string;
      startOffsetMs: number;
      endOffsetMs: number;
      capturedAt: string;
      speakerLabel?: string | null;
      text: string;
    },
  ): Promise<NoteTranscriptSegment> {
    return this.request(`/notes/${encodeURIComponent(id)}/segments`, {
      method: 'POST',
      body: { ...input, speakerLabel: input.speakerLabel ?? null },
      schema: WireNoteTranscriptSegmentSchema,
    });
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
   * `refreshSeconds` is the cadence this meeting settled on. It travels with
   * the request so the briefing is written for the schedule the client is
   * actually keeping, rather than for whatever the flag says when the server
   * happens to read it.
   */
  generateNoteNotes(
    id: string,
    mode: 'live' | 'final' = 'live',
    transcriptStatus: 'complete' | 'partial' = mode === 'final' ? 'complete' : 'partial',
    refreshSeconds?: number,
  ): Promise<NoteDetail> {
    return this.request(`/notes/${encodeURIComponent(id)}/generate`, {
      method: 'POST',
      body: {
        mode,
        transcriptStatus,
        ...(refreshSeconds === undefined ? {} : { refreshSeconds }),
      },
      schema: WireNoteDetailSchema,
    });
  }

  async renameWorkstream(id: string, title: string): Promise<WorkstreamSummary> {
    const workstream = await this.request(`/workstreams/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { title },
      schema: WireWorkstreamSchema,
    });
    return mapWorkstreamSummary(workstream);
  }

  /**
   * Narrow a work stream to the people in it, or open it to the workspace.
   *
   * `personal` keeps the work stream readable to its participants — who may
   * still add anyone else in the workspace to it — and to nobody else.
   */
  async setWorkstreamScope(id: string, scope: 'personal' | 'workspace'): Promise<WorkstreamSummary> {
    const workstream = await this.request(`/workstreams/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { scope },
      schema: WireWorkstreamSchema,
    });
    return mapWorkstreamSummary(workstream);
  }

  /**
   * Take a work stream out of every listing, for everyone who could see it.
   *
   * The same `PATCH` a rename and a visibility change use, because being
   * archived is a field of the work stream rather than a lifecycle of its own.
   * The row that comes back is the archived one; nothing here removes it from
   * the sidebar, because WorkstreamDO answers this write with a directory
   * tombstone and `applyVersionedWorkstreamState` drops the row and its detail
   * query off the back of that — the same path an archive from another window
   * already takes.
   */
  async archiveWorkstream(id: string): Promise<WorkstreamSummary> {
    const workstream = await this.request(`/workstreams/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { archived: true },
      schema: WireWorkstreamSchema,
    });
    return mapWorkstreamSummary(workstream);
  }

  async previewWorkstreamBatch(
    filter: WorkstreamBatchFilter,
  ): Promise<{ matchedCount: number; matchedNoteCount: number }> {
    const result = await this.request('/workstreams/batch/preview', {
      method: 'POST',
      body: { filter },
      schema: WireWorkstreamBatchPreviewSchema,
    });
    return { matchedCount: result.matchedCount, matchedNoteCount: result.matchedNoteCount };
  }

  async applyWorkstreamBatch(
    operationId: string,
    filter: WorkstreamBatchFilter,
    update: WorkstreamBatchUpdate,
  ): Promise<{ enqueuedCount: number; archivedNoteCount: number }> {
    const result = await this.request('/workstreams/batch', {
      method: 'POST',
      body: { operationId, filter, update },
      schema: WireWorkstreamBatchAcceptedSchema,
    });
    return { enqueuedCount: result.enqueuedCount, archivedNoteCount: result.archivedNoteCount };
  }

  async acknowledgeWorkstreamRead(
    id: string,
    readThroughSequenceNumber: number,
    observedManualUnreadGeneration: number,
    entrypoint?: TelemetrySurfaceEntrypoint,
  ): Promise<WorkstreamSummary> {
    const workstream = await this.request(`/workstreams/${encodeURIComponent(id)}/read-state`, {
      method: 'PATCH',
      body: { readThroughSequenceNumber, observedManualUnreadGeneration, entrypoint },
      schema: WireWorkstreamSchema,
    });
    return mapWorkstreamSummary(workstream);
  }

  async markWorkstreamUnread(id: string): Promise<WorkstreamSummary> {
    const workstream = await this.request(`/workstreams/${encodeURIComponent(id)}/read-state/mark-unread`, {
      method: 'POST',
      schema: WireWorkstreamSchema,
    });
    return mapWorkstreamSummary(workstream);
  }

  /**
   * Pin a work stream for the signed-in person, across every device they use.
   *
   * All three pin calls answer with the whole pinned list in its stored order,
   * so the caller replaces what it holds rather than reasoning about which row
   * moved — see {@link ApiClient.reorderWorkstreamPins}.
   */
  async pinWorkstream(id: string): Promise<WorkstreamSummary[]> {
    return this.readPinnedWorkstreams(`/workstreams/${encodeURIComponent(id)}/pin`, 'PUT');
  }

  async unpinWorkstream(id: string): Promise<WorkstreamSummary[]> {
    return this.readPinnedWorkstreams(`/workstreams/${encodeURIComponent(id)}/pin`, 'DELETE');
  }

  /**
   * Send the pinned list's new order after a drag.
   *
   * The whole arrangement travels, not the row that moved: the server writes it
   * as dense positions, and the list it sends back is the one to render. Ids
   * that have been unpinned elsewhere are ignored rather than refused.
   */
  async reorderWorkstreamPins(workstreamIds: string[]): Promise<WorkstreamSummary[]> {
    return this.readPinnedWorkstreams('/workstreams/pins', 'PUT', { workstreamIds });
  }

  private async readPinnedWorkstreams(
    path: string,
    method: 'PUT' | 'DELETE',
    body?: unknown,
  ): Promise<WorkstreamSummary[]> {
    const page = await this.request(path, {
      method,
      ...(body === undefined ? {} : { body }),
      schema: wirePinnedWorkstreamsSchema,
    });
    return page.items.map(mapWorkstreamSummary);
  }

  async createWorkstream(input: {
    openingMessage: string;
    participantIds: string[];
    projectId?: string;
    mentions?: MentionIdentity[];
    attachmentIds?: string[];
    modelOverride?: AgentModelOverride;
    /** The caller's open `workstream_create` trace id, when it has one. */
    requestId?: string;
  }): Promise<CreatedWorkstream> {
    const mentions = input.openingMessage.includes('@') || (input.mentions?.length ?? 0) > 0
      ? await this.messageMentionPayload(input.openingMessage, input.mentions)
      : [];
    const participantUserIds = [...new Set([
      ...input.participantIds,
      ...mentions.flatMap((mention) => mention.type === 'person' && mention.userId ? [mention.userId] : []),
    ])];
    const clientMessageId = crypto.randomUUID();
    const operationId = uuidV7();
    reportTelemetryProductIntent({ kind: 'workstream_create_requested', entrypoint: 'composer', operationId });
    reportTelemetryProductIntent({ kind: 'run_requested', entrypoint: 'composer', operationId });
    const response = await this.request('/workstreams', {
      method: 'POST',
      headers: { [RALLY_HEADERS.OPERATION_ID]: operationId },
      body: {
        ...(input.projectId ? { projectId: input.projectId } : {}),
        openingMessage: input.openingMessage,
        participantUserIds,
        clientMessageId,
        attachmentIds: input.attachmentIds ?? [],
        ...(mentions.length > 0 ? { mentions } : {}),
        // Omitted rather than sent as null when nothing was pinned, so the work
        // stream stays on whatever `agent-model-workstream` serves it.
        ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      },
      schema: createWorkstreamResponseSchema,
      ...(input.requestId ? { requestId: input.requestId } : {}),
    });
    return {
      workstream: mapWorkstreamSummary(response.workstream),
      turnId: response.turnId,
      clientMessageId,
      createdAt: response.workstream.createdAt,
      harnessRunId: response.harnessRunId,
    };
  }

  /** The REST recovery twin of the canonical socket snapshot. */
  async getWorkstream(id: string, signal?: AbortSignal, openAttemptId?: string): Promise<WorkstreamBoot> {
    const raw = await this.request(`/workstreams/${encodeURIComponent(id)}`, {
      schema: WireWorkstreamBootSchema,
      signal,
      ...(openAttemptId ? { headers: { [RALLY_HEADERS.OPERATION_ID]: openAttemptId } } : {}),
    });
    return {
      ...mapWorkstreamDetail(raw),
      transcript: raw.transcript,
    };
  }


  async getBlockDashboard(id: string, signal?: AbortSignal): Promise<BlockDashboard> {
    return this.request(`/workstreams/${encodeURIComponent(id)}/block-dashboard`, {
      schema: WireBlockDashboardSchema,
      signal,
    });
  }


  async updateBlockDashboardPreference(id: string, visible: boolean): Promise<BlockDashboardPreference> {
    return this.request(`/workstreams/${encodeURIComponent(id)}/block-dashboard/preference`, {
      method: 'PUT',
      body: { visible },
      schema: WireBlockDashboardPreferenceSchema,
    });
  }

  async updateBlockDashboard(
    id: string,
    input: { expectedVersionNumber: number; blocks: Array<{ id: string; prompt: string }> },
  ): Promise<BlockDashboard> {
    return this.request(`/workstreams/${encodeURIComponent(id)}/block-dashboard`, {
      method: 'PUT',
      body: input,
      schema: WireBlockDashboardSchema,
    });
  }

  async getWorkstreamContext(
    id: string,
    automationSubscriptionId?: string,
    signal?: AbortSignal,
  ): Promise<WorkstreamDeferredContext> {
    // `/context` is gone: its only field was `backgroundTasks`, which the detail
    // has always been shaped to carry and now does. What is left is the
    // automation, which is a different resource and only exists for some work
    // streams.
    const context: WorkstreamDeferredContext = { backgroundTasks: [], automationRuns: [] };
    if (!automationSubscriptionId) return context;
    try {
      const automation = await this.getAutomation(automationSubscriptionId, signal);
      return {
        ...context,
        automationRuns: automation.runs,
        automationSubscription: {
          id: automation.id,
          name: automation.name,
          scope: automation.scope,
          status: automation.status,
          triggerSummary: automation.triggerSummary,
          executionScope: automation.executionScope,
        },
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      return context;
    }
  }

  async messageMentionPayload(text: string, selected: MentionIdentity[] = []): Promise<Array<{
    type: 'person' | 'connector';
    userId: string | null;
    connectorType: string | null;
    startOffset: number;
    endOffset: number;
  }>> {
    const members = await this.getWorkspaceMembers();
    // People only, and only here: what a name in the text resolves to has to
    // agree with what the composer that wrote it offered and highlighted.
    // The work stream's connections were discovered here too, so a hand-typed
    // `@<connection>` still left as a connector span — a chip in the transcript
    // for something the composer had already stopped naming. A connector
    // mention a caller states outright still travels, through `selected` below.
    const discovered = members
      .filter((member) => (member.status ?? 'active') === 'active')
      .map((member) => ({ type: 'person' as const, label: member.name, userId: member.id, connectorType: null }));
    return resolveMentionPayload(text, selected, discovered);
  }

  async uploadResource(
    file: File,
    draftId: string,
    onProgress?: (percentage: number) => void,
    signal?: AbortSignal,
  ): Promise<WorkstreamResource> {
    const accessToken = this.session?.accessToken ?? null;
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
      request.send(form);
    });
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

  async getResourcePreviewContent(id: string, signal?: AbortSignal): Promise<Blob> {
    const response = await this.execute(`/resources/${encodeURIComponent(id)}/preview`, {
      method: 'GET',
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return this.throwResponseError(response);
    return response.blob();
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
    return { items: page.items.map(mapResource), nextCursor: page.nextCursor };
  }

  async attachResource(id: string, resourceId: string): Promise<WorkstreamDetail> {
    await this.request(`/workstreams/${encodeURIComponent(id)}/resources`, {
      method: 'POST',
      body: { resourceId },
      schema: WireWorkstreamResourceSchema,
    });
    return this.getWorkstream(id);
  }

  async detachResource(workstreamId: string, resourceId: string): Promise<void> {
    await this.requestVoid(`/workstreams/${encodeURIComponent(workstreamId)}/resources/${encodeURIComponent(resourceId)}`, {
      method: 'DELETE',
    });
  }

  async stopHarness(id: string): Promise<void> {
    await this.requestVoid(`/workstreams/${encodeURIComponent(id)}/stop`, { method: 'POST' });
  }

  /**
   * Send the visible pending-input queue's new order after a drag.
   *
   * The whole arrangement travels, not the row that moved: the object
   * permutes existing `input_sequence` values. Ids that have already been
   * delivered are ignored rather than refused, and visible pending inputs
   * the caller does not name keep their relative order behind the ones it
   * did.
   */
  async reorderPendingLoopInputs(
    id: string,
    inputIds: string[],
  ): Promise<{ pendingInputs: PendingTranscriptInput[] }> {
    return this.request(`/workstreams/${encodeURIComponent(id)}/pending-inputs`, {
      method: 'PUT',
      body: { inputIds },
      schema: ReorderPendingLoopInputsResultSchema,
    });
  }

  async retryHarness(id: string): Promise<{ harnessRunId: string }> {
    return this.request(`/workstreams/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
      schema: z.object({ harnessRunId: z.string().uuid() }),
    });
  }

  async addParticipant(id: string, userId: string): Promise<WorkstreamDetail> {
    await this.request(`/workstreams/${encodeURIComponent(id)}/participants`, {
      method: 'POST',
      body: { userId },
      schema: WireParticipantSchema,
    });
    return this.getWorkstream(id);
  }

  async removeParticipant(id: string, userId: string): Promise<void> {
    await this.requestVoid(
      `/workstreams/${encodeURIComponent(id)}/participants/${encodeURIComponent(userId)}`,
      { method: 'DELETE' },
    );
  }

  async answerElicitation(
    id: string,
    elicitationId: string,
    answer: string | string[] | null,
    customResponse?: string,
  ): Promise<void> {
    await this.request(`/workstreams/${encodeURIComponent(id)}/elicitations/${encodeURIComponent(elicitationId)}/answer`, {
      method: 'POST',
      body: answer == null
        ? { skipped: true }
        : { answer, ...(customResponse ? { customResponse } : {}) },
      schema: z.object({ elicitation: WireElicitationSchema.optional() }).strict(),
    });
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
  async getResourceVersionContent(resourceId: string, version: number, signal?: AbortSignal): Promise<Blob> {
    const response = await this.execute(
      `/resources/${encodeURIComponent(resourceId)}/versions/${encodeURIComponent(version)}/content`,
      { method: 'GET', ...(signal ? { signal } : {}) },
    );
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

  getSocketTicket(id: string, substreamId = '0', requestId?: string): Promise<SocketTicket> {
    return this.request(
      `/workstreams/${encodeURIComponent(id)}/substreams/${encodeURIComponent(substreamId)}/socket`,
      { schema: socketTicketSchema, ...(requestId ? { requestId } : {}) },
    );
  }

  getWorkspaceSocketTicket(): Promise<SocketTicket> {
    return this.request('/workspace/socket', { schema: socketTicketSchema });
  }

  getWorkstreamControlSocketTicket(id: string, requestId?: string): Promise<SocketTicket> {
    return this.request(`/workstreams/${encodeURIComponent(id)}/control-socket`, {
      schema: socketTicketSchema,
      ...(requestId ? { requestId } : {}),
    });
  }

  getBlockDashboardBlockSocketTicket(id: string, blockId: string): Promise<SocketTicket> {
    return this.request(
      `/workstreams/${encodeURIComponent(id)}/block-dashboard/blocks/${encodeURIComponent(blockId)}/socket`,
      { schema: socketTicketSchema },
    );
  }

  getTranscriptionSocketTicket(): Promise<SocketTicket> {
    return this.request('/realtime/transcription/socket', { schema: socketTicketSchema });
  }

  admitAutomationDraftTurn(input: {
    automationId?: string;
    clientCreationKey?: string;
    clientMessageId: string;
    content: string;
    attachmentIds?: string[];
    inputMode?: 'typed' | 'suggested_prompt' | 'elicitation_response' | 'edit';
  }): Promise<WireAutomationDraftTurnAdmissionResult> {
    const path = input.automationId
      ? `/automations/${encodeURIComponent(input.automationId)}/agent/draft/turn`
      : '/automations/agent/draft/turn';
    return this.request(path, {
      method: 'POST',
      body: {
        ...(!input.automationId ? { clientCreationKey: input.clientCreationKey } : {}),
        clientMessageId: input.clientMessageId,
        content: input.content,
        attachmentIds: input.attachmentIds ?? [],
        inputMode: input.inputMode ?? 'typed',
      },
      schema: WireAutomationDraftTurnAdmissionResultSchema,
    });
  }

  getAutomationAgentDraft(id: string, signal?: AbortSignal): Promise<WireAutomationAgentSnapshot> {
    return this.request(`/automations/${encodeURIComponent(id)}/agent/draft`, {
      schema: WireAutomationAgentSnapshotSchema,
      signal,
    });
  }

  automationDraftFromAgentSnapshot(snapshot: WireAutomationAgentSnapshot): {
    draft: AutomationDraftResponse | null;
    messages: Array<{
      turnId: string;
      transcriptSequence: number;
      clientMessageId: string | null;
      role: 'user' | 'assistant';
      content: string;
      attachmentIds: string[];
      createdAt: number;
    }>;
  } {
    const messages = snapshot.messages.map((message) => ({
      turnId: message.turnId,
      transcriptSequence: message.transcriptSequence,
      clientMessageId: message.clientMessageId,
      role: message.role,
      content: message.content,
      attachmentIds: message.attachmentIds,
      createdAt: message.createdAt,
    }));
    if (snapshot.definition === null) return { draft: null, messages };
    // Thrown as an `ApiError`, never as a raw `ZodError`: this runs
    // inside the builder's render effect, where a thrown parse takes
    // the whole screen down instead of showing the failure. The
    // sibling stream path already answers this shape the same way.
    const parsed = WireAutomationDraftSchema.safeParse(snapshot.definition);
    if (!parsed.success) {
      throw new ApiError(STALE_BUILD_RESPONSE_MESSAGE, 502, 'invalid_response', {
        issues: parsed.error.issues,
        path: `/automations/${snapshot.automationId}/agent/draft`,
      });
    }
    const raw = parsed.data;
    // The one place a socket-driven draft is recorded for `createAutomation`,
    // which sends the exact definition back and is rejected by the agent
    // when the two disagree. Before the draft moved onto the socket this
    // was written by the compile stream instead.
    this.drafts.set(snapshot.automationId, {
      attachmentIds: [...new Set(snapshot.messages.flatMap((message) => message.attachmentIds))],
      messages: snapshot.messages.map((message) => ({ role: message.role, content: message.content })),
      draft: raw,
    });
    const assistantMessage = [...snapshot.messages].reverse()
      .find((message) => message.role === 'assistant')?.content ?? '';
    return {
      draft: this.automationDraftResponse(
        snapshot.automationId,
        raw,
        assistantMessage,
        snapshot.pendingElicitation?.id,
        snapshot.pendingElicitation ? new Date(snapshot.messages.at(-1)?.createdAt ?? Date.now()).toISOString() : undefined,
      ),
      messages,
    };
  }

  getAutomationAgentSocketTicket(id: string): Promise<SocketTicket> {
    return this.request(`/automations/${encodeURIComponent(id)}/agent/socket`, {
      schema: socketTicketSchema,
    });
  }

  stopAutomationCompiler(id: string, runId: string): Promise<void> {
    return this.requestVoid(
      `/automations/${encodeURIComponent(id)}/agent/draft/${encodeURIComponent(runId)}/stop`,
      { method: 'POST' },
    );
  }

  retryAutomationCompiler(id: string, runId: string): Promise<void> {
    return this.requestVoid(
      `/automations/${encodeURIComponent(id)}/agent/draft/${encodeURIComponent(runId)}/retry`,
      { method: 'POST' },
    );
  }

  /** The one place a compiled draft becomes what the builder screen renders,
   * so a draft picked back up out of the sidebar reads exactly like the turn
   * that produced it. */
  private automationDraftResponse(
    draftId: string,
    raw: WireAutomationDraft,
    assistantMessage: string,
    elicitationId?: string,
    elicitationPresentedAt?: string,
  ): AutomationDraftResponse {
    const elicitation = raw.elicitation;
    return {
      draftId,
      assistantMessage,
      ...(raw.followUpQuestion
        ? {
            question: {
              id: elicitationId ?? crypto.randomUUID(),
              presentedAt: elicitationPresentedAt ?? new Date().toISOString(),
              prompt: elicitation?.prompt ?? raw.followUpQuestion,
              ...(elicitation?.placeholder ? { placeholder: elicitation.placeholder } : {}),
              responseType: elicitation?.responseType ?? 'free_text',
              options: (elicitation?.options ?? []).map((option) => ({
                label: option.label,
                value: option.value,
                ...(option.description ? { description: option.description } : {}),
              })),
              ...(elicitation ? { minimumSelections: elicitation.minimumSelections } : {}),
              ...(elicitation?.maximumSelections != null ? { maximumSelections: elicitation.maximumSelections } : {}),
              allowOther: elicitation?.allowOther ?? false,
            },
          }
        : {}),
      ...(raw.ready
        ? {
            summary: {
              name: raw.name,
              description: raw.description,
              overview: raw.overview,
              recommendedPlugins: raw.recommendedPlugins,
              activitySources: activitySourcesFromTriggers(raw.triggers),
              scope: raw.suggestedScope === 'personal' ? 'you' : 'workspace',
              triggerSummary: raw.triggers.map(triggerSummary).join(' · '),
              capabilities: raw.requiredCapabilities,
              // What the compiler understood the person to ask for, not what a
              // regex could find in its prose. The prose version pre-ticked a
              // destination for "a ranked list of your most important emails" —
              // a briefing *about* email — and a destination frozen by mistake
              // could not be changed afterwards.
              requiresSlackDelivery: raw.requestedDelivery.includes("slack_agent_dm"),
              requiresEmailDelivery: raw.requestedDelivery.includes("email"),
            },
          }
        : {}),
    };
  }

  async createAutomation(
    draftId: string,
    defaultPluginIds: string[],
    activitySourcePluginIds: Record<string, string>,
    options: AutomationCreateOptions = {},
  ): Promise<AutomationDetail> {
    const state = this.drafts.get(draftId);
    if (!state?.draft?.ready) throw new ApiError('Finish the automation conversation before creating it.', 422, 'automation_not_ready');
    const delivery = options.delivery ?? {};
    const raw = await this.request('/automations', {
      method: 'POST',
      body: {
        draftId,
        draft: state.draft,
        scope: options.scope === undefined
          ? state.draft.suggestedScope
          : options.scope === 'you' ? 'personal' : 'workspace',
        defaultPluginIds,
        activitySourcePluginIds,
        resourceIds: [],
        deliveryTargets: [
          ...(delivery.connection ? [{ type: delivery.connection.targetType, connectionId: delivery.connection.id }] : []),
          ...(delivery.email ? [{ type: 'email' }] : []),
        ],
        ...(options.modelOverride ? { modelOverride: options.modelOverride } : {}),
      },
      schema: WireAutomationDetailSchema,
    });
    this.automationDetails.set(raw.id, raw);
    this.drafts.delete(draftId);
    return mapAutomationDetail(raw);
  }

  async getWorkspaceTemplates(signal?: AbortSignal): Promise<WorkspaceTemplate[]> {
    const page = await this.request('/automation-templates', { schema: wireTemplatePageSchema, signal });
    return page.items.map((template) => ({
      id: template.id,
      name: template.name,
      authorName: template.author,
      description: template.description,
      usageCount: template.usedBy,
      capabilities: template.requiredCapabilities,
      latestVersion: template.latestVersion,
      activitySources: template.activitySources,
    }));
  }

  async subscribeTemplate(
    templateId: string,
    defaultPluginIds: string[],
    activitySourcePluginIds: Record<string, string>,
  ): Promise<AutomationDetail> {
    const raw = await this.request(`/automation-templates/${encodeURIComponent(templateId)}/subscribe`, {
      method: 'POST',
      body: { defaultPluginIds, activitySourcePluginIds },
      schema: WireAutomationDetailSchema,
    });
    this.automationDetails.set(raw.id, raw);
    return mapAutomationDetail(raw);
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
    provider: 'google' | 'github' | 'granola' | 'linear' | 'notion' | 'slack',
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
    return this.request(`/connections/${provider}/start?telemetryVersion=2&desktopHandoffVersion=2`, {
      method: 'POST',
      headers: { [RALLY_HEADERS.OPERATION_ID]: operationId },
      body: { scope: scope === 'you' ? 'personal' : 'workspace', capabilities },
      schema: WireConnectorOAuthStartSchema,
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

  async createGranolaWorkspaceConnection(apiKey: string): Promise<WorkstreamConnection> {
    reportTelemetryProductIntent({
      kind: 'connector_setup_requested_v2', connector: 'granola', scope: 'workspace',
      method: 'api_key', capabilityCount: telemetryCountBucket(1),
    });
    const response = await this.request('/connections/granola/workspace', {
      method: 'POST',
      body: { apiKey, capabilities: ['granola.workspace.read'] },
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
    provider?: 'google' | 'github' | 'linear' | 'notion' | 'slack',
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
      `/connections/${encodeURIComponent(id)}/reconnect?telemetryVersion=2&desktopHandoffVersion=2`,
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

  async beginGoogleLogin(
    region: Region,
    callbackUri: string,
    input: { workspaceName?: string; invitationToken?: string; authAttempt: DesktopAuthAttempt },
  ): Promise<string> {
    const result = await this.request('/auth/google/start', {
      method: 'POST',
      body: {
        region,
        returnUri: callbackUri,
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
