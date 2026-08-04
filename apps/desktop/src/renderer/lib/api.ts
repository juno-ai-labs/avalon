import {
  ActivitySuggestionSchema as WireActivitySuggestionSchema,
  AutomationDetailSchema as WireAutomationDetailSchema,
  AutomationDraftSchema as WireAutomationDraftSchema,
  AutomationSummarySchema as WireAutomationSummarySchema,
  ConnectionSchema as WireConnectionSchema,
  CursorPageSchema,
  ElicitationSchema as WireElicitationSchema,
  MessageSchema as WireMessageSchema,
  ParticipantSchema as WireParticipantSchema,
  PendingWorkspaceInvitationSchema as WirePendingWorkspaceInvitationSchema,
  ResourceSchema as WireResourceSchema,
  ToolInvocationSchema as WireToolInvocationSchema,
  type ViewerSchema as WireViewerSchema,
  WorkspaceMemberSchema as WireWorkspaceMemberSchema,
  WorkspaceInvitationPreviewSchema as WireWorkspaceInvitationPreviewSchema,
  WorkspaceInvitationSchema as WireWorkspaceInvitationSchema,
  WorkspaceSchema as WireWorkspaceSchema,
  WorkstreamDetailSchema as WireWorkstreamDetailSchema,
  WorkstreamSchema as WireWorkstreamSchema,
  type AutomationDraft as WireAutomationDraft,
  type AutomationRun as WireAutomationRun,
  type BackgroundTask as WireBackgroundTask,
  type Connection as WireConnection,
  type Elicitation as WireElicitation,
  type Message as WireMessage,
  type Resource as WireResource,
  type User as WireUser,
  type Workstream as WireWorkstream,
  type WorkstreamArtifact as WireWorkstreamArtifact,
  type WorkstreamDetail as WireWorkstreamDetail,
} from '@avalon/contracts';
import type { ZodType } from 'zod';
import { z } from 'zod';
import type { DesktopAuthAttempt, DesktopSession } from '../../common/desktop';
import type {
  ActivitySuggestionData,
  ArtifactData,
  AutomationDetail,
  AutomationDraftResponse,
  AutomationRunSummary,
  AutomationSummary,
  BackgroundTask,
  ElicitationData,
  HarnessStatus,
  Message,
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
  WorkstreamDetail,
  WorkstreamResource,
  WorkstreamSummary,
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

interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: HeadersInit;
  schema: ZodType<T>;
  signal?: AbortSignal;
}

interface DraftState {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  draft: WireAutomationDraft | null;
}

export interface MentionIdentity {
  type: 'person' | 'connector';
  label: string;
  userId: string | null;
  connectorType: string | null;
}

const wireWorkstreamPageSchema = CursorPageSchema(WireWorkstreamSchema);
const wireMessagePageSchema = CursorPageSchema(WireMessageSchema);
const wireResourcePageSchema = CursorPageSchema(WireResourceSchema);
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
const socketTicketSchema = z.object({ url: z.string(), ticket: z.string() });

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
  };
}

function mapWorkstreamSummary(workstream: WireWorkstream): WorkstreamSummary {
  return {
    id: workstream.id,
    title: workstream.title,
    objective: workstream.objective,
    ...(workstream.emailAddress ? { emailAddress: workstream.emailAddress } : {}),
    origin: workstream.originType,
    ...(workstream.originLabel ? { automationName: workstream.originLabel } : {}),
    harnessStatus: normalizeHarnessStatus(workstream.harnessStatus),
    lastActivityAt: workstream.lastActivityAt,
    ...(workstream.plannedFor ? { plannedFor: workstream.plannedFor } : {}),
    preview: workstream.objective,
  };
}

export function mapElicitation(elicitation: WireElicitation): ElicitationData {
  return {
    id: elicitation.id,
    prompt: elicitation.prompt,
    responseType: elicitation.responseType,
    options: elicitation.options.map((option) => ({
      label: option.label,
      value: option.value,
      ...(option.description ? { description: option.description } : {}),
    })),
    minimumSelections: elicitation.minimumSelections,
    ...(elicitation.maximumSelections !== null ? { maximumSelections: elicitation.maximumSelections } : {}),
    ...(elicitation.targetUserId ? { targetUserId: elicitation.targetUserId } : {}),
    status: elicitation.status === 'open' ? 'open' : 'answered',
    ...(elicitation.answer !== null ? { answer: elicitation.answer } : {}),
  };
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
    name: invocation.toolName,
    summary: invocation.outputSummary ?? invocation.inputSummary,
    status: invocation.status === 'pending' ? 'started' : invocation.status,
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

export function mapWorkstreamArtifact(artifact: WireWorkstreamArtifact): ArtifactData {
  return {
    id: artifact.id,
    title: artifact.title,
    artifactType: artifact.artifactType,
    ...(artifact.previewText ? { previewText: artifact.previewText } : {}),
    status: artifact.status,
    mimeType: artifact.mimeType,
    ...(artifact.harnessRunId ? { harnessRunId: artifact.harnessRunId } : {}),
    createdAt: artifact.createdAt,
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
    id: message.id,
    ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
    workstreamId: message.workstreamId,
    sequenceNumber: message.sequenceNumber,
    authorType: message.author.type === 'human' ? 'human' : message.author.type,
    ...(message.author.type === 'human' ? { author: mapUser(message.author.user) } : {}),
    messageType,
    text: message.textContent,
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
    ...(message.messageType === 'artifact'
      ? {
          artifact: {
            id: typeof structured['id'] === 'string' ? structured['id'] : message.id,
            title: typeof structured['title'] === 'string' ? structured['title'] : message.textContent || 'Artifact',
            artifactType: typeof structured['artifactType'] === 'string' ? structured['artifactType'] : 'artifact',
            ...(typeof structured['previewText'] === 'string' ? { previewText: structured['previewText'] } : {}),
          },
        }
      : {}),
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
    artifacts: (workstream.artifacts ?? []).map(mapWorkstreamArtifact),
    backgroundTasks: (workstream.backgroundTasks ?? []).map(mapBackgroundTask),
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
    instructions: detail.instructions,
    triggerSummary: detail.triggers.map(triggerSummary).join(' · '),
    ...(schedule ? { scheduleSummary: triggerSummary(schedule) } : {}),
    capabilities: detail.requiredCapabilities,
    expectedOutputs: detail.expectedOutputs,
    executionScope: detail.executionPrincipal['type'] === 'workspace' ? 'Workspace' : 'You',
    runs,
    ...(detail.templateUpdate
      ? {
          templateUpdate: {
            versionId: detail.templateUpdate.versionId,
            versionNumber: detail.templateUpdate.versionNumber,
            instructions: detail.templateUpdate.instructions,
            triggerSummary: detail.templateUpdate.triggers.map(triggerSummary).join(' · '),
            capabilities: detail.templateUpdate.requiredCapabilities,
            expectedOutputs: detail.templateUpdate.expectedOutputs,
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

  constructor(
    readonly baseUrl: string,
    private session: DesktopSession | null,
  ) {}

  setSession(session: DesktopSession | null): void {
    this.session = session;
  }

  private async execute(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    if (this.session?.accessToken) headers.set('Authorization', `Bearer ${this.session.accessToken}`);
    try {
      return await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new ApiError('Avalon could not reach the selected regional service.', 0, 'network_error', error);
    }
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
    return { id: raw.id, name: raw.name, region: raw.region, timezone: raw.timezone, currentUser };
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
        inviteUrl: z.string().url(),
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

  async updateAutomation(id: string, input: { instructions: string }): Promise<AutomationDetail> {
    const updated = await this.request(`/automations/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
      schema: WireAutomationDetailSchema,
    });
    this.automationDetails.set(id, updated);
    return mapAutomationDetail(updated);
  }

  async adoptAutomationUpdate(id: string, versionId: string): Promise<AutomationDetail> {
    const updated = await this.request(`/automation-subscriptions/${encodeURIComponent(id)}/adopt-version`, {
      method: 'POST',
      body: { versionId },
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
      origin: 'automation',
      harnessStatus: 'running',
      lastActivityAt: new Date().toISOString(),
    };
  }

  async getWorkstreams(signal?: AbortSignal): Promise<WorkstreamSummary[]> {
    const page = await this.request('/workstreams?limit=250', { schema: wireWorkstreamPageSchema, signal });
    return page.items.map(mapWorkstreamSummary);
  }

  async createWorkstream(input: { openingMessage: string; participantIds: string[] }): Promise<WorkstreamDetail> {
    const clientMessageId = crypto.randomUUID();
    const response = await this.request('/workstreams', {
      method: 'POST',
      body: {
        objective: input.openingMessage,
        openingMessage: input.openingMessage,
        participantUserIds: input.participantIds,
        clientMessageId,
      },
      schema: createWorkstreamResponseSchema,
    });
    return this.getWorkstream(response.workstream.id);
  }

  async getWorkstream(id: string, signal?: AbortSignal): Promise<WorkstreamDetail> {
    const raw = await this.request(`/workstreams/${encodeURIComponent(id)}`, { schema: WireWorkstreamDetailSchema, signal });
    const detail = mapWorkstreamDetail(raw);
    if (!raw.automationSubscriptionId) return detail;
    try {
      const automation = await this.getAutomation(raw.automationSubscriptionId, signal);
      return {
        ...detail,
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
      return detail;
    }
  }

  async getMessages(id: string, signal?: AbortSignal): Promise<Message[]> {
    const wireMessages: WireMessage[] = [];
    const seenCursors = new Set<string>();
    let before: string | null = null;
    do {
      const query = new URLSearchParams({ limit: '200' });
      if (before) query.set('before', before);
      const page = await this.request(`/workstreams/${encodeURIComponent(id)}/messages?${query.toString()}`, {
        schema: wireMessagePageSchema,
        signal,
      });
      wireMessages.unshift(...page.items);
      before = page.nextCursor;
      if (before && seenCursors.has(before)) throw new ApiError('Avalon received a repeated transcript cursor.', 502, 'invalid_cursor');
      if (before) seenCursors.add(before);
    } while (before);
    const detail = await this.request(`/workstreams/${encodeURIComponent(id)}`, { schema: WireWorkstreamDetailSchema, signal });
    const mapped = wireMessages.map(mapMessage);
    let sequence = mapped.reduce((maximum, message) => Math.max(maximum, message.sequenceNumber), 0);
    const elicitationMessages = detail.openElicitations.map<Message>((elicitation) => ({
      id: `elicitation-${elicitation.id}`,
      workstreamId: id,
      sequenceNumber: ++sequence,
      authorType: 'agent',
      messageType: 'elicitation',
      createdAt: elicitation.createdAt,
      elicitation: mapElicitation(elicitation),
    }));
    const suggestionMessages = detail.suggestions.map<Message>((suggestion) => ({
      id: `suggestion-${suggestion.id}`,
      workstreamId: id,
      sequenceNumber: ++sequence,
      authorType: 'system',
      messageType: 'activity_suggestion',
      createdAt: suggestion.createdAt,
      activitySuggestion: mapSuggestion(suggestion),
    }));
    return [...mapped, ...elicitationMessages, ...suggestionMessages];
  }

  async downloadArtifact(workstreamId: string, artifactId: string, signal?: AbortSignal): Promise<{
    blob: Blob;
    fileName: string;
  }> {
    const response = await this.execute(
      `/workstreams/${encodeURIComponent(workstreamId)}/artifacts/${encodeURIComponent(artifactId)}/content`,
      { method: 'GET', ...(signal ? { signal } : {}) },
    );
    if (!response.ok) return this.throwResponseError(response);
    const disposition = response.headers.get('Content-Disposition') ?? '';
    const encodedName = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1];
    const quotedName = /filename="([^"]+)"/iu.exec(disposition)?.[1];
    let fileName = quotedName ?? `avalon-output-${artifactId}.txt`;
    if (encodedName) {
      try {
        fileName = decodeURIComponent(encodedName);
      } catch {
        // Keep the conservative quoted filename when the extended form is malformed.
      }
    }
    return { blob: await response.blob(), fileName };
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
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', `${this.baseUrl}/resources/upload`);
      request.responseType = 'json';
      request.setRequestHeader('Accept', 'application/json');
      request.setRequestHeader('X-Avalon-Draft-Id', draftId);
      if (this.session?.accessToken) request.setRequestHeader('Authorization', `Bearer ${this.session.accessToken}`);
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

  async answerElicitation(id: string, elicitationId: string, answer: unknown): Promise<void> {
    await this.request(`/workstreams/${encodeURIComponent(id)}/elicitations/${encodeURIComponent(elicitationId)}/answer`, {
      method: 'POST',
      body: { answer },
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

  async compileAutomation(input: { message: string; draftId?: string; templateId?: string }): Promise<AutomationDraftResponse> {
    const draftId = input.draftId ?? crypto.randomUUID();
    const previous = this.drafts.get(draftId) ?? { messages: [], draft: null };
    const messages = [...previous.messages, { role: 'user' as const, content: input.message }];
    const raw = await this.request('/automations/draft', {
      method: 'POST',
      body: { messages, currentDraft: previous.draft },
      schema: WireAutomationDraftSchema,
    });
    const assistantMessage = raw.followUpQuestion ?? (raw.ready ? 'The automation is ready to create.' : undefined);
    this.drafts.set(draftId, {
      messages: assistantMessage ? [...messages, { role: 'assistant', content: assistantMessage }] : messages,
      draft: raw,
    });
    const steps = raw.instructions
      .split(/\r?\n/u)
      .map((line) => line.replace(/^\s*(?:\d+[.)]|[-*])\s*/u, '').trim())
      .filter(Boolean)
      .slice(0, 8);
    return {
      draftId,
      ...(assistantMessage ? { assistantMessage } : {}),
      ...(raw.followUpQuestion ? { question: { id: crypto.randomUUID(), prompt: raw.followUpQuestion } } : {}),
      ...(raw.ready
        ? {
            summary: {
              name: raw.name,
              description: raw.description,
              steps: steps.length ? steps : raw.expectedOutputs,
              scope: raw.suggestedScope === 'personal' ? 'you' : 'workspace',
              triggerSummary: raw.triggers.map(triggerSummary).join(' · '),
              capabilities: raw.requiredCapabilities,
            },
          }
        : {}),
    };
  }

  async createAutomation(draftId: string, connectorBindings: Record<string, string>): Promise<AutomationDetail> {
    const state = this.drafts.get(draftId);
    if (!state?.draft?.ready) throw new ApiError('Finish the automation conversation before creating it.', 422, 'automation_not_ready');
    const raw = await this.request('/automations', {
      method: 'POST',
      body: { draft: state.draft, scope: state.draft.suggestedScope, connectorBindings },
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
    }));
  }

  async subscribeTemplate(templateId: string, connectorBindings: Record<string, string>): Promise<AutomationDetail> {
    const raw = await this.request(`/automation-templates/${encodeURIComponent(templateId)}/subscribe`, {
      method: 'POST',
      body: { connectorBindings },
      schema: WireAutomationDetailSchema,
    });
    this.automationDetails.set(raw.id, raw);
    return mapAutomationDetail(raw);
  }

  async getConnections(signal?: AbortSignal): Promise<WorkstreamConnection[]> {
    const page = await this.request('/connections', { schema: wireConnectionPageSchema, signal });
    return page.items.map(mapConnection);
  }

  async startGoogleConnection(scope: 'you' | 'workspace', capabilities: string[]): Promise<string> {
    return this.startProviderConnection('google', scope, capabilities);
  }

  async startProviderConnection(
    provider: 'google' | 'github' | 'linear' | 'notion',
    scope: 'you' | 'workspace',
    capabilities: string[],
  ): Promise<string> {
    const response = await this.request(`/connections/${provider}/start`, {
      method: 'POST',
      body: { scope: scope === 'you' ? 'personal' : 'workspace', capabilities },
      schema: z.object({ url: z.string().url() }),
    });
    return response.url;
  }

  async reconnectConnection(id: string): Promise<string> {
    const response = await this.request(`/connections/${encodeURIComponent(id)}/reconnect`, {
      method: 'POST',
      schema: z.object({ url: z.string().url() }),
    });
    return response.url;
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
      schema: z.object({ url: z.string().url() }),
    });
    return result.url;
  }

}

export function backgroundTasksFromMessages(messages: Message[]): BackgroundTask[] {
  return messages.flatMap((message) => {
    const tool = message.toolEvent;
    if (!tool) return [];
    return [{
      id: tool.id,
      title: tool.name,
      type: 'tool' as const,
      status: tool.status === 'started' ? 'running' as const : tool.status === 'completed' ? 'completed' as const : 'failed' as const,
      startedAt: message.createdAt,
      ...(tool.durationMs !== undefined ? { durationMs: tool.durationMs } : {}),
      transcriptMessageId: message.id,
    }];
  });
}
