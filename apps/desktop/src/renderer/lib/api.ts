import {
  ActivitySuggestionSchema as WireActivitySuggestionSchema,
  AutomationDetailSchema as WireAutomationDetailSchema,
  AutomationDraftSchema as WireAutomationDraftSchema,
  AutomationDraftStateSchema as WireAutomationDraftStateSchema,
  AutomationDraftStreamEventSchema as WireAutomationDraftStreamEventSchema,
  AutomationSummarySchema as WireAutomationSummarySchema,
  ClientFeatureFlagsSchema as WireClientFeatureFlagsSchema,
  ConnectionSchema as WireConnectionSchema,
  ConnectorOAuthAttemptSchema as WireConnectorOAuthAttemptSchema,
  ConnectorOAuthStartSchema as WireConnectorOAuthStartSchema,
  CursorPageSchema,
  ElicitationSchema as WireElicitationSchema,
  HyperSightPreferenceSchema as WireHyperSightPreferenceSchema,
  HyperSightSchema as WireHyperSightSchema,
  NoteDetailSchema as WireNoteDetailSchema,
  NoteSummarySchema as WireNoteSummarySchema,
  NoteTranscriptSegmentSchema as WireNoteTranscriptSegmentSchema,
  MessageSchema as WireMessageSchema,
  ParticipantSchema as WireParticipantSchema,
  PendingWorkspaceInvitationSchema as WirePendingWorkspaceInvitationSchema,
  ResourceSchema as WireResourceSchema,
  ToolInvocationSchema as WireToolInvocationSchema,
  WorkstreamContextSchema as WireWorkstreamContextSchema,
  type ViewerSchema as WireViewerSchema,
  WorkspaceMemberSchema as WireWorkspaceMemberSchema,
  WorkspaceInvitationPreviewSchema as WireWorkspaceInvitationPreviewSchema,
  WorkspaceInvitationSchema as WireWorkspaceInvitationSchema,
  WorkspaceSchema as WireWorkspaceSchema,
  WorkstreamDetailSchema as WireWorkstreamDetailSchema,
  DigestScheduleSchema as WireDigestScheduleSchema,
  WorkstreamSchema as WireWorkstreamSchema,
  WorkOpportunityPageSchema as WireWorkOpportunityPageSchema,
  type AutomationDraft as WireAutomationDraft,
  type AutomationDraftStreamEvent as WireAutomationDraftStreamEvent,
  type AutomationRun as WireAutomationRun,
  type BackgroundTask as WireBackgroundTask,
  type ClientFeatureFlags,
  type Connection as WireConnection,
  type ConnectorOAuthAttempt,
  type ConnectorOAuthStart,
  type Elicitation as WireElicitation,
  type Message as WireMessage,
  type Resource as WireResource,
  type User as WireUser,
  type Workstream as WireWorkstream,
  type WorkstreamDetail as WireWorkstreamDetail,
} from '@avalon/contracts';
import { socketTicketProtocols, socketUrlWithoutTicket } from '@avalon/contracts/socket-tickets';
import { HttpUrlSchema } from '@avalon/contracts/url-schemas';
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { DesktopAuthAttempt, DesktopSession } from '../../common/desktop';
import { elicitationMessageId, normalizeElicitation } from './elicitation';
import { createElicitationMessage, upsertTranscriptMessage, visibleTranscriptMessages } from './transcript';
import type {
  ActivitySuggestionData,
  AgentModelOverride,
  AutomationCreateOptions,
  AutomationDeliveryTargetType,
  AutomationDetail,
  AutomationDraftResponse,
  AutomationRunSummary,
  AutomationSummary,
  BackgroundTask,
  CreatedWorkstream,
  DigestSchedule,
  ElicitationData,
  HarnessStatus,
  HyperSight,
  HyperSightPreference,
  Message,
  MessagePage,
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
  WorkstreamDetail,
  WorkstreamResource,
  WorkstreamSummary,
  WorkOpportunity,
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

function abortableDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      return;
    }
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: HeadersInit;
  schema: ZodType<T>;
  signal?: AbortSignal;
}

interface DraftState {
  attachmentIds: string[];
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  draft: WireAutomationDraft | null;
}

export type AutomationAssistantStreamEvent = Extract<
  WireAutomationDraftStreamEvent,
  { type: 'started' | 'thinking' | 'delta' | 'tool' }
>;

async function readSseData(
  response: Response,
  onData: (data: string) => void | Promise<void>,
): Promise<void> {
  if (!response.body) throw new ApiError('The service returned no response body.', 502, 'unexpected_empty_response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consume = async (flush = false): Promise<void> => {
    buffer = buffer.replaceAll('\r\n', '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /u, ''))
        .join('\n');
      if (data) await onData(data);
      boundary = buffer.indexOf('\n\n');
    }
    if (flush && buffer.trim()) {
      const data = buffer
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /u, ''))
        .join('\n');
      if (data) await onData(data);
      buffer = '';
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    await consume();
  }
  buffer += decoder.decode();
  await consume(true);
}

export interface MentionIdentity {
  type: 'person' | 'connector';
  label: string;
  userId: string | null;
  connectorType: string | null;
}

/**
 * How many work streams one sidebar page asks for.
 *
 * The service's ceiling, kept there rather than lowered now that the list pages:
 * a first page this size means the overwhelming majority of workspaces are one
 * request as they always were, and paging engages only where it was needed —
 * past the point a single page could hold the list at all.
 */
const WORKSTREAM_PAGE_SIZE = 250;

const wireWorkstreamPageSchema = CursorPageSchema(WireWorkstreamSchema);
const wirePinnedWorkstreamsSchema = z.object({ items: z.array(WireWorkstreamSchema) });
const wireMessagePageSchema = CursorPageSchema(WireMessageSchema).extend({
  newerCursor: z.string().nullable().default(null),
});
const wireResourcePageSchema = CursorPageSchema(WireResourceSchema);
const wireNotePageSchema = z.object({ items: z.array(WireNoteSummarySchema) });
const wireMemberPageSchema = z.object({ items: z.array(WireWorkspaceMemberSchema) });
const wireInvitationPageSchema = z.object({ items: z.array(WireWorkspaceInvitationSchema) });
const wireAutomationPageSchema = z.object({ items: z.array(WireAutomationSummarySchema) });
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
  messageId: z.string(),
  harnessRunId: z.string().nullable(),
});
const createMessageResponseSchema = z.object({
  message: WireMessageSchema,
  agentInvoked: z.boolean(),
  harnessRunId: z.string().nullable(),
});
const runNowResponseSchema = z.object({
  runId: z.string(),
  workstreamId: z.string(),
  harnessRunId: z.string().optional(),
  reused: z.boolean(),
});
// The issuing endpoints still put the ticket in the URL for desktop builds
// released before the subprotocol scheme. Strip it on the way in, so no call
// site can open a socket whose URL carries the credential.
const socketTicketSchema = z.object({ url: z.string(), ticket: z.string() })
  .transform(({ url, ticket }): SocketTicket => ({
    url: socketUrlWithoutTicket(url),
    ticket,
    protocols: socketTicketProtocols(ticket),
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

export function mapResource(resource: WireResource): WorkstreamResource {
  return {
    id: resource.id,
    title: resource.title,
    resourceType: resource.resourceType,
    provider: resource.provider,
    ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
    ...(resource.canonicalUrl ? { canonicalUrl: resource.canonicalUrl } : {}),
    watchEnabled: resource.watchEnabled,
    watchStatus: resource.watchStatus,
    updatedAt: resource.updatedAt,
    contentAvailable: resource.contentAvailable,
    sizeBytes: resource.sizeBytes,
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
    ...(connection.userDelivery ? { userDelivery: connection.userDelivery } : {}),
  };
}

function mapWorkstreamSummary(workstream: WireWorkstream): WorkstreamSummary {
  return {
    id: workstream.id,
    title: workstream.title,
    titleStatus: workstream.titleStatus,
    objective: workstream.objective,
    ...(workstream.emailAddress ? { emailAddress: workstream.emailAddress } : {}),
    origin: workstream.originType,
    ...(workstream.originLabel ? { automationName: workstream.originLabel } : {}),
    ...(workstream.automationSubscriptionId
      ? { automationSubscriptionId: workstream.automationSubscriptionId }
      : {}),
    harnessStatus: normalizeHarnessStatus(workstream.harnessStatus),
    latestAttentionSequenceNumber: workstream.latestAttentionSequenceNumber,
    readThroughSequenceNumber: workstream.readThroughSequenceNumber,
    manualUnreadFromSequenceNumber: workstream.manualUnreadFromSequenceNumber,
    manualUnreadGeneration: workstream.manualUnreadGeneration,
    hasUnread: workstream.hasUnread,
    firstUnreadSequenceNumber: workstream.firstUnreadSequenceNumber,
    lastActivityAt: workstream.lastActivityAt,
    ...(workstream.plannedFor ? { plannedFor: workstream.plannedFor } : {}),
    scope: workstream.scope,
    ...(workstream.systemKind ? { systemKind: workstream.systemKind } : {}),
    nextPendingWakeup: workstream.nextPendingWakeup
      ? { ...workstream.nextPendingWakeup }
      : null,
    pinPosition: workstream.pinPosition,
    preview: workstream.objective,
  };
}

export function mapElicitation(elicitation: WireElicitation): ElicitationData {
  return normalizeElicitation(elicitation);
}

export function mapSuggestion(suggestion: z.infer<typeof WireActivitySuggestionSchema>): ActivitySuggestionData {
  return {
    id: suggestion.id,
    title: suggestion.title,
    source: 'Activity',
    occurredAt: suggestion.createdAt,
    reason: suggestion.reason,
    status: suggestion.status,
  };
}

export function mapToolInvocation(invocation: z.infer<typeof WireToolInvocationSchema>): ToolEventData {
  const started = invocation.startedAt ? Date.parse(invocation.startedAt) : Number.NaN;
  const completed = invocation.completedAt ? Date.parse(invocation.completedAt) : Number.NaN;
  return {
    id: invocation.id,
    name: invocation.activityName ?? invocation.toolName,
    summary: invocation.outputSummary ?? invocation.inputSummary,
    status: invocation.status === 'pending' ? 'started' : invocation.status,
    ...(invocation.plugin ? { plugin: invocation.plugin } : {}),
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
    ...(task.transcriptMessageId ? { transcriptMessageId: task.transcriptMessageId } : {}),
  };
}

export function mapMessage(message: WireMessage): Message {
  const structured = message.structuredContent ?? {};
  const invocation = WireToolInvocationSchema.safeParse('invocation' in structured ? structured['invocation'] : structured);
  const elicitation = WireElicitationSchema.safeParse('elicitation' in structured ? structured['elicitation'] : structured);
  const suggestion = WireActivitySuggestionSchema.safeParse('suggestion' in structured ? structured['suggestion'] : structured);
  const messageType: Message['messageType'] = message.messageType === 'tool'
    ? 'tool_event'
    : message.messageType === 'suggestion'
      ? 'activity_suggestion'
      : message.messageType;
  return {
    // The durable open question and its later durable answer are separate
    // transcript rows, while an unfetched open question can also be synthesized
    // from detail.openElicitations. Give every representation one UI identity so
    // messagesWithTransientBlocks can render only the current state.
    id: elicitation.success ? elicitationMessageId(elicitation.data.id) : message.id,
    ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
    workstreamId: message.workstreamId,
    sequenceNumber: message.sequenceNumber,
    authorType: message.author.type === 'human' ? 'human' : message.author.type,
    ...(message.author.type === 'human' ? { author: mapUser(message.author.user) } : {}),
    ...(message.author.type === 'external' ? { externalActor: { ...message.author.actor } } : {}),
    messageType,
    text: message.textContent,
    ...(structured['kind'] === 'suggested_work_expansion' && typeof structured['label'] === 'string'
      ? { contextLabel: structured['label'] }
      : {}),
    mentions: message.mentions.map((mention) => ({
      type: mention.type,
      ...(mention.userId ? { personId: mention.userId } : {}),
      ...(mention.connectorType ? { connectorType: mention.connectorType } : {}),
      ...(mention.displayName ? { displayName: mention.displayName } : {}),
      ...(mention.avatarUrl ? { avatarUrl: mention.avatarUrl } : {}),
      startOffset: mention.startOffset,
      endOffset: mention.endOffset,
    })),
    attachments: message.attachments.map((attachment) => ({ ...attachment })),
    createdAt: message.createdAt,
    ...(invocation.success ? { toolEvent: mapToolInvocation(invocation.data) } : {}),
    ...(elicitation.success ? { elicitation: mapElicitation(elicitation.data) } : {}),
    ...(suggestion.success ? { activitySuggestion: mapSuggestion(suggestion.data) } : {}),
  };
}

export function mapWorkstreamDetail(workstream: WireWorkstreamDetail): WorkstreamDetail {
  const participants = workstream.participants.map(mapParticipant);
  return {
    ...mapWorkstreamSummary(workstream),
    createdAt: workstream.createdAt,
    ...(workstream.createdByUserId
      ? { createdBy: participants.find((participant) => participant.id === workstream.createdByUserId) }
      : {}),
    participants,
    viewers: workstream.viewers.map(mapViewer),
    resources: workstream.resources.map(mapResource),
    connections: workstream.connections.map(mapConnection),
    backgroundTasks: (workstream.backgroundTasks ?? []).map(mapBackgroundTask),
    openElicitations: workstream.openElicitations.map(mapElicitation),
    suggestions: workstream.suggestions.map(mapSuggestion),
    automationRuns: [],
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

export function messagesWithTransientBlocks(
  mapped: Message[],
  detail: WorkstreamDetail,
  dismissedSuggestionIds: readonly string[] = [],
): Message[] {
  // Both the question and its durable human response remain separate rows in
  // the model transcript. mapMessage intentionally gives those rows one UI
  // identity, so collapse the canonical page before React and the virtualizer
  // see duplicate keys. The shared upsert keeps answered elicitations from
  // regressing to open even when pages or realtime updates arrive out of order.
  const canonicalMessages = mapped.reduce<Message[]>(
    (messages, message) => upsertTranscriptMessage(messages, message),
    [],
  );
  let sequence = canonicalMessages.reduce((maximum, message) => Math.max(maximum, message.sequenceNumber), 0);
  const canonicalIds = new Set(canonicalMessages.map((message) => message.id));
  const elicitationMessages = (detail.openElicitations ?? [])
    .filter((elicitation) => !canonicalIds.has(elicitationMessageId(elicitation.id)))
    .map((elicitation) => createElicitationMessage({
    id: elicitationMessageId(elicitation.id),
    workstreamId: detail.id,
    sequenceNumber: ++sequence,
    authorType: 'agent',
    createdAt: elicitation.createdAt ?? detail.lastActivityAt,
    elicitation,
  }));
  const suggestionMessages = (detail.suggestions ?? []).map<Message>((suggestion) => ({
    id: `suggestion-${suggestion.id}`,
    workstreamId: detail.id,
    sequenceNumber: ++sequence,
    authorType: 'system',
    messageType: 'activity_suggestion',
    createdAt: suggestion.occurredAt ?? detail.lastActivityAt,
    activitySuggestion: suggestion,
  }));
  return visibleTranscriptMessages(
    [...canonicalMessages, ...elicitationMessages, ...suggestionMessages],
    dismissedSuggestionIds,
  );
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
    triggerType: run.triggerType === 'schedule' ? 'scheduled' : run.triggerType,
    triggerTime,
    ...(run.resultSummary ? { resultSummary: run.resultSummary } : {}),
    ...(Number.isFinite(start) && Number.isFinite(end) ? { durationMs: end - start } : {}),
  };
}

function mapAutomationSummary(automation: z.infer<typeof WireAutomationSummarySchema>): AutomationSummary {
  return {
    id: automation.id,
    name: automation.name,
    ...(automation.emailAddress ? { emailAddress: automation.emailAddress } : {}),
    scope: automation.scope === 'personal' ? 'you' : 'workspace',
    status: automation.status,
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

export class AvalonApi {
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
      throw new ApiError('Avalon could not reach the selected regional service.', 0, 'network_error', error);
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

  private async request<T>(path: string, options: RequestOptions<T>): Promise<T> {
    const headers = new Headers(options.headers);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await this.execute(path, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) return this.throwResponseError(response);
    if (response.status === 204) throw new ApiError('The service returned no response body.', 502, 'unexpected_empty_response');
    const payload: unknown = await response.json();
    const parsed = options.schema.safeParse(payload);
    if (!parsed.success) {
      throw new ApiError('Avalon received an unexpected response from the service.', 502, 'invalid_response', {
        issues: parsed.error.issues,
        path,
      });
    }
    return parsed.data;
  }

  private async requestVoid(path: string, options: Omit<RequestOptions<never>, 'schema'>): Promise<void> {
    const headers = new Headers(options.headers);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await this.execute(path, {
      method: options.method ?? 'POST',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) return this.throwResponseError(response);
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
      logAgentInference: raw.logAgentInference,
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

  async updateWorkspaceLogAgentInference(logAgentInference: boolean): Promise<Workspace> {
    await this.request('/workspace', {
      method: 'PATCH',
      body: { logAgentInference },
      schema: WireWorkspaceSchema,
    });
    return this.getWorkspace();
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
    return page.items.map((member) => ({ ...mapUser(member.user), role: member.role }));
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

  async getAutomation(id: string, signal?: AbortSignal): Promise<AutomationDetail> {
    const raw = await this.request(`/automations/${encodeURIComponent(id)}`, { schema: WireAutomationDetailSchema, signal });
    this.automationDetails.set(id, raw);
    return mapAutomationDetail(raw);
  }

  async updateAutomation(id: string, input: {
    instructions: string;
    activitySourcePluginIds?: Record<string, string>;
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

  async archiveDraftAutomation(id: string): Promise<void> {
    await this.requestVoid(`/automations/${encodeURIComponent(id)}/archive`, { method: 'POST' });
    this.automationDetails.delete(id);
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
    };
  }

  /**
   * `includeSystem` widens what the sidebar shows, not who may see it: the API
   * still only returns a system work stream to someone who participates in it.
   */
  /**
   * One page of the work-stream list, with the cursor for the next one.
   *
   * `before` is the previous page's `nextCursor`, which the service derives from
   * the paged rows alone — pinned and system work streams arrive appended to the
   * first page and are excluded from the paging, so following the cursor never
   * returns them twice.
   */
  async getWorkstreams(
    signal?: AbortSignal,
    includeSystem = false,
    before?: string,
  ): Promise<{ items: WorkstreamSummary[]; nextCursor: string | null }> {
    const page = await this.request(
      `/workstreams?limit=${WORKSTREAM_PAGE_SIZE}${includeSystem ? '&includeSystem=true' : ''}`
      + `${before ? `&before=${encodeURIComponent(before)}` : ''}`,
      { schema: wireWorkstreamPageSchema, signal },
    );
    return { items: page.items.map(mapWorkstreamSummary), nextCursor: page.nextCursor };
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
      body: { opportunityIds },
    });
  }

  async dismissWorkOpportunity(id: string): Promise<void> {
    await this.requestVoid(`/work-opportunities/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async startWorkOpportunity(id: string, version: number, idempotencyKey: string): Promise<CreatedWorkstream> {
    const response = await this.request(`/work-opportunities/${encodeURIComponent(id)}/start`, {
      method: 'POST',
      body: { version, idempotencyKey },
      schema: createWorkstreamResponseSchema,
    });
    return {
      workstream: mapWorkstreamSummary(response.workstream),
      messageId: response.messageId,
      clientMessageId: `opportunity:${id}:v${version}`,
      createdAt: response.workstream.createdAt,
      harnessRunId: response.harnessRunId,
    };
  }

  async getNotes(signal?: AbortSignal): Promise<NoteSummary[]> {
    const page = await this.request('/notes?limit=250', { schema: wireNotePageSchema, signal });
    return page.items;
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

  async acknowledgeWorkstreamRead(
    id: string,
    readThroughSequenceNumber: number,
    observedManualUnreadGeneration: number,
  ): Promise<WorkstreamSummary> {
    const workstream = await this.request(`/workstreams/${encodeURIComponent(id)}/read-state`, {
      method: 'PATCH',
      body: { readThroughSequenceNumber, observedManualUnreadGeneration },
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
    attachmentIds?: string[];
    modelOverride?: AgentModelOverride;
  }): Promise<CreatedWorkstream> {
    const clientMessageId = crypto.randomUUID();
    const response = await this.request('/workstreams', {
      method: 'POST',
      body: {
        openingMessage: input.openingMessage,
        participantUserIds: input.participantIds,
        clientMessageId,
        attachmentIds: input.attachmentIds ?? [],
        // Omitted rather than sent as null when nothing was pinned, so the work
        // stream stays on whatever `agent-model-workstream` serves it.
        ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      },
      schema: createWorkstreamResponseSchema,
    });
    return {
      workstream: mapWorkstreamSummary(response.workstream),
      messageId: response.messageId,
      clientMessageId,
      createdAt: response.workstream.createdAt,
      harnessRunId: response.harnessRunId,
    };
  }

  async getWorkstream(id: string, signal?: AbortSignal): Promise<WorkstreamDetail> {
    const raw = await this.request(`/workstreams/${encodeURIComponent(id)}`, { schema: WireWorkstreamDetailSchema, signal });
    return mapWorkstreamDetail(raw);
  }

  async getHyperSight(id: string, signal?: AbortSignal): Promise<HyperSight> {
    return this.request(`/workstreams/${encodeURIComponent(id)}/hypersight`, {
      schema: WireHyperSightSchema,
      signal,
    });
  }

  async getHyperSightPreference(id: string, signal?: AbortSignal): Promise<HyperSightPreference> {
    return this.request(`/workstreams/${encodeURIComponent(id)}/hypersight/preference`, {
      schema: WireHyperSightPreferenceSchema,
      signal,
    });
  }

  async updateHyperSightPreference(id: string, visible: boolean): Promise<HyperSightPreference> {
    return this.request(`/workstreams/${encodeURIComponent(id)}/hypersight/preference`, {
      method: 'PUT',
      body: { visible },
      schema: WireHyperSightPreferenceSchema,
    });
  }

  async updateHyperSight(
    id: string,
    input: { expectedVersionNumber: number; blocks: Array<{ id: string; prompt: string }> },
  ): Promise<HyperSight> {
    return this.request(`/workstreams/${encodeURIComponent(id)}/hypersight`, {
      method: 'PUT',
      body: input,
      schema: WireHyperSightSchema,
    });
  }

  async getWorkstreamContext(
    id: string,
    automationSubscriptionId?: string,
    signal?: AbortSignal,
  ): Promise<WorkstreamDeferredContext> {
    const raw = await this.request(`/workstreams/${encodeURIComponent(id)}/context`, {
      schema: WireWorkstreamContextSchema,
      signal,
    });
    const context: WorkstreamDeferredContext = {
      backgroundTasks: raw.backgroundTasks.map(mapBackgroundTask),
      automationRuns: [],
    };
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

  async getMessagePage(id: string, options: {
    before?: string;
    after?: string;
    around?: number;
    signal?: AbortSignal;
  } = {}): Promise<MessagePage> {
    const query = new URLSearchParams({ limit: '200' });
    if (options.before) query.set('before', options.before);
    if (options.after) query.set('after', options.after);
    if (options.around !== undefined) query.set('around', String(options.around));
    const page = await this.request(`/workstreams/${encodeURIComponent(id)}/messages?${query.toString()}`, {
      schema: wireMessagePageSchema,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return {
      items: visibleTranscriptMessages(page.items.map(mapMessage)),
      nextCursor: page.nextCursor,
      newerCursor: page.newerCursor,
    };
  }

  async getMessages(id: string, signal?: AbortSignal): Promise<Message[]> {
    return (await this.getMessagePage(id, { signal })).items;
  }

  private async mentionPayload(workstreamId: string, text: string, selected: MentionIdentity[] = []): Promise<Array<{
    type: 'person' | 'connector';
    userId: string | null;
    connectorType: string | null;
    startOffset: number;
    endOffset: number;
  }>> {
    const [members, detail] = await Promise.all([this.getWorkspaceMembers(), this.getWorkstream(workstreamId)]);
    const discovered = [
      ...members.map((member) => ({ type: 'person' as const, label: member.name, userId: member.id, connectorType: null })),
      ...detail.connections.map((connection) => ({ type: 'connector' as const, label: connection.displayName, userId: null, connectorType: connection.connectorType })),
    ];
    const explicitlySelectedLabels = new Set(selected.map((candidate) => candidate.label.toLocaleLowerCase()));
    const candidates = [
      ...selected,
      ...discovered.filter((candidate) => !explicitlySelectedLabels.has(candidate.label.toLocaleLowerCase())),
    ].filter((candidate, index, list) => list.findIndex((item) =>
      item.type === candidate.type && item.userId === candidate.userId && item.connectorType === candidate.connectorType && item.label === candidate.label,
    ) === index);
    return candidates.flatMap((candidate) => {
      const escaped = candidate.label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      const expression = new RegExp(`@${escaped}(?=$|[\\s\\p{P}])`, 'giu');
      return [...text.matchAll(expression)].filter((match) => {
        const startOffset = match.index;
        return startOffset === 0 || /[\s([{]/u.test(text[startOffset - 1] ?? '');
      }).map((match) => {
        const startOffset = match.index;
        return {
          type: candidate.type,
          userId: candidate.userId,
          connectorType: candidate.connectorType,
          startOffset,
          endOffset: startOffset + match[0].length,
        };
      });
    }).sort((left, right) => left.startOffset - right.startOffset);
  }

  async createMessage(id: string, input: {
    text: string;
    clientId: string;
    mentions?: MentionIdentity[];
    confirmedParticipantUserIds?: string[];
    attachmentIds?: string[];
  }): Promise<Message> {
    const mentions = await this.mentionPayload(id, input.text, input.mentions);
    const response = await this.request(`/workstreams/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: {
        text: input.text,
        clientMessageId: input.clientId,
        mentions,
        confirmedParticipantUserIds: input.confirmedParticipantUserIds ?? [],
        attachmentIds: input.attachmentIds ?? [],
      },
      schema: createMessageResponseSchema,
    });
    return mapMessage(response.message);
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
      request.setRequestHeader('X-Avalon-Draft-Id', draftId);
      if (accessToken) request.setRequestHeader('Authorization', `Bearer ${accessToken}`);
      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) onProgress?.(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      });
      request.addEventListener('load', () => {
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
      request.addEventListener('error', () => reject(new ApiError('Avalon could not upload the attachment.', 0, 'network_error')));
      request.addEventListener('abort', () => reject(new DOMException('The upload was cancelled.', 'AbortError')));
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
      schema: WireResourceSchema,
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
      schema: z.object({ elicitation: WireElicitationSchema.optional(), harnessRunId: z.string().nullable() }),
    });
  }

  async resolveActivitySuggestion(id: string, suggestionId: string, action: 'accept' | 'dismiss'): Promise<void> {
    await this.request(`/workstreams/${encodeURIComponent(id)}/activities/${encodeURIComponent(suggestionId)}/${action}`, {
      method: 'POST',
      schema: z.object({ suggestion: WireActivitySuggestionSchema.optional(), resourceId: z.string().nullable() }),
    });
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

  getSocketTicket(id: string): Promise<SocketTicket> {
    return this.request(`/workstreams/${encodeURIComponent(id)}/socket`, { schema: socketTicketSchema });
  }

  getTranscriptionSocketTicket(): Promise<SocketTicket> {
    return this.request('/realtime/transcription/socket', { schema: socketTicketSchema });
  }

  async compileAutomation(
    input: { message: string; draftId?: string; templateId?: string; attachmentIds?: string[] },
    onAssistantStream?: (event: AutomationAssistantStreamEvent) => void,
  ): Promise<AutomationDraftResponse> {
    // The first turn has no draft to continue. Every later one names the draft
    // subscription the API wrote, which is the automation's real id — the
    // renderer never mints one, because a key only this process knows could not
    // put the draft in the sidebar or bring it back after a restart.
    const previous = input.draftId
      ? this.drafts.get(input.draftId) ?? { attachmentIds: [], messages: [], draft: null }
      : { attachmentIds: [], messages: [], draft: null };
    const messages = [...previous.messages, { role: 'user' as const, content: input.message }];
    const attachmentIds = [...new Set([...previous.attachmentIds, ...(input.attachmentIds ?? [])])];
    const response = await this.execute('/automations/draft/stream', {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...(input.draftId ? { draftId: input.draftId } : {}),
        messages,
        currentDraft: previous.draft,
        attachmentIds,
      }),
    });
    if (!response.ok) return this.throwResponseError(response);
    const streamState: {
      completed?: Extract<WireAutomationDraftStreamEvent, { type: 'completed' }>;
    } = {};
    await readSseData(response, (data) => {
      let payload: unknown;
      try {
        payload = JSON.parse(data);
      } catch (error) {
        throw new ApiError('Avalon received an invalid automation stream.', 502, 'invalid_response', error);
      }
      const parsed = WireAutomationDraftStreamEventSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ApiError('Avalon received an unexpected response from the service.', 502, 'invalid_response', {
          issues: parsed.error.issues,
          path: '/automations/draft/stream',
        });
      }
      const event = parsed.data;
      if (event.type === 'error') {
        throw new ApiError(
          event.error.message,
          event.error.status,
          event.error.code,
          event.error.details,
          event.error.requestId ?? undefined,
        );
      }
      if (event.type === 'completed') streamState.completed = event;
      else onAssistantStream?.(event);
    });
    const completed = streamState.completed;
    if (!completed) {
      throw new ApiError('The automation stream ended before the draft was complete.', 502, 'unexpected_empty_response');
    }
    const raw = WireAutomationDraftSchema.parse(completed.draft);
    const assistantMessage = completed.assistantMessage;
    const draftId = completed.draftId;
    this.drafts.set(draftId, {
      attachmentIds,
      messages: [...messages, { role: 'assistant', content: assistantMessage }],
      draft: raw,
    });
    return this.automationDraftResponse(draftId, raw, assistantMessage);
  }

  /** The one place a compiled draft becomes what the builder screen renders,
   * so a draft picked back up out of the sidebar reads exactly like the turn
   * that produced it. */
  private automationDraftResponse(
    draftId: string,
    raw: WireAutomationDraft,
    assistantMessage: string,
  ): AutomationDraftResponse {
    const elicitation = raw.elicitation;
    return {
      draftId,
      assistantMessage,
      ...(raw.followUpQuestion
        ? {
            question: {
              id: crypto.randomUUID(),
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
              requiresSlackDelivery: raw.expectedOutputs.some((output) => /\bslack\b/iu.test(output)),
            },
          }
        : {}),
    };
  }

  /** Reopens a draft left in the sidebar. The conversation comes back from the
   * API rather than from this process's memory, which is the whole point: the
   * draft outlived the screen it was written on. */
  async resumeAutomationDraft(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ draft: AutomationDraftResponse; messages: Array<{ role: 'user' | 'assistant'; content: string }> }> {
    const state = await this.request(`/automations/${encodeURIComponent(id)}/draft`, {
      schema: WireAutomationDraftStateSchema,
      signal,
    });
    this.drafts.set(state.draftId, {
      attachmentIds: state.attachmentIds,
      messages: state.messages,
      draft: state.draft,
    });
    const assistantMessage = [...state.messages].reverse()
      .find((message) => message.role === 'assistant')?.content ?? '';
    return {
      draft: this.automationDraftResponse(state.draftId, state.draft, assistantMessage),
      messages: state.messages,
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

  async startGoogleConnection(scope: 'you' | 'workspace', capabilities: string[]): Promise<ConnectorOAuthStart> {
    return this.startProviderConnection('google', scope, capabilities);
  }

  async startProviderConnection(
    provider: 'google' | 'github' | 'granola' | 'linear' | 'notion' | 'slack',
    scope: 'you' | 'workspace',
    capabilities: string[],
  ): Promise<ConnectorOAuthStart> {
    return this.request(`/connections/${provider}/start`, {
      method: 'POST',
      body: { scope: scope === 'you' ? 'personal' : 'workspace', capabilities },
      schema: WireConnectorOAuthStartSchema,
    });
  }

  async createXConnection(
    capabilities: string[],
  ): Promise<WorkstreamConnection> {
    const response = await this.request('/connections/x', {
      method: 'POST',
      body: { scope: 'workspace', capabilities },
      schema: z.object({ connection: WireConnectionSchema }),
    });
    return mapConnection(response.connection);
  }

  async createGranolaWorkspaceConnection(apiKey: string): Promise<WorkstreamConnection> {
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

  async reconnectConnection(id: string): Promise<ConnectorOAuthStart> {
    return this.request(`/connections/${encodeURIComponent(id)}/reconnect`, {
      method: 'POST',
      schema: WireConnectorOAuthStartSchema,
    });
  }

  async getConnectorOAuthAttempt(attemptId: string, signal?: AbortSignal): Promise<ConnectorOAuthAttempt> {
    return this.request(`/connections/oauth-attempts/${encodeURIComponent(attemptId)}`, {
      schema: WireConnectorOAuthAttemptSchema,
      signal,
    });
  }

  async waitForConnectorOAuthAttempt(attemptId: string, signal?: AbortSignal): Promise<ConnectorOAuthAttempt> {
    const deadline = Date.now() + 16 * 60_000;
    let retryDelayMs = 750;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      try {
        const attempt = await this.getConnectorOAuthAttempt(attemptId, signal);
        if (attempt.status !== 'pending') return attempt;
        retryDelayMs = 1_000;
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
        if (error instanceof ApiError && error.status > 0 && error.status < 500) throw error;
        retryDelayMs = Math.min(5_000, retryDelayMs * 2);
      }
      await abortableDelay(retryDelayMs, signal);
    }
    throw new ApiError('Connector authorization could not be confirmed.', 408, 'oauth_attempt_timeout');
  }

  async testConnection(id: string): Promise<{ ok: boolean; message: string }> {
    return this.request(`/connections/${encodeURIComponent(id)}/test`, {
      method: 'POST',
      schema: z.object({ ok: z.boolean(), message: z.string() }),
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
