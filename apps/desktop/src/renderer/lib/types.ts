import type { AutomationPluginActivity } from '@avalon/contracts';

export type Region = 'global' | 'eu';
export type Scope = 'you' | 'workspace';
export type HarnessStatus = 'scheduled' | 'running' | 'needs_input' | 'completed' | 'failed';
export type AutomationStatus = 'active' | 'paused' | 'draft' | 'error';

export interface WorkspaceMember {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
  timezone: string;
  role?: string;
}

export interface Workspace {
  id: string;
  name: string;
  region: Region;
  timezone: string;
  logAgentInference: boolean;
  currentUser: WorkspaceMember;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: 'admin' | 'member';
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  invitedByName: string;
  expiresAt: string;
  acceptedAt: string | null;
  createdAt: string;
}

export interface WorkspaceInvitationPreview {
  workspaceId: string;
  workspaceName: string;
  region: Region;
  email: string;
  role: 'admin' | 'member';
  expiresAt: string;
}

export interface PendingWorkspaceInvitation extends WorkspaceInvitationPreview {
  id: string;
  invitedByName: string;
}

export interface AutomationSummary {
  id: string;
  name: string;
  emailAddress?: string;
  scope: Scope;
  status: AutomationStatus;
  nextRunAt?: string;
  lastRunAt?: string;
  statusMessage?: string;
}

export interface WorkstreamSummary {
  id: string;
  title: string;
  objective?: string;
  emailAddress?: string;
  origin: 'ad_hoc' | 'automation';
  automationName?: string;
  harnessStatus: HarnessStatus;
  latestAttentionSequenceNumber: number;
  readThroughSequenceNumber: number;
  manualUnreadFromSequenceNumber: number | null;
  manualUnreadGeneration: number;
  hasUnread: boolean;
  firstUnreadSequenceNumber: number | null;
  lastActivityAt: string;
  plannedFor?: string;
  preview?: string;
}

export interface Participant extends WorkspaceMember {
  accent?: string;
  viewing?: boolean;
}

export interface WorkstreamResource {
  id: string;
  title: string;
  resourceType: string;
  provider?: string;
  mimeType?: string;
  canonicalUrl?: string;
  watchEnabled: boolean;
  watchStatus: 'watching' | 'paused' | 'unsupported' | 'error';
  updatedAt?: string;
  contentAvailable?: boolean;
  sizeBytes?: number;
}

export interface MessageAttachment {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  contentAvailable: boolean;
  createdAt: string;
}

export interface ResourcePage {
  items: WorkstreamResource[];
  nextCursor: string | null;
}

export interface WorkstreamConnection {
  id: string;
  modelPluginId: string;
  connectorType: string;
  displayName: string;
  scope: Scope;
  ownerName?: string;
  status: 'healthy' | 'reconnect_required' | 'disabled';
  capabilities?: string[];
}

export interface ToolEventData {
  id: string;
  name: string;
  summary?: string;
  status: 'started' | 'completed' | 'failed' | 'ambiguous';
  durationMs?: number;
  toolType?: string;
  plugins?: AutomationPluginActivity[];
  input?: unknown;
  output?: unknown;
}

export interface ThoughtEventData {
  status: 'started' | 'completed';
  /** Completed model-inference time accumulated across this turn. */
  durationMs: number;
  /** Client receipt time for the currently streaming inference attempt. */
  startedAt?: number;
}

export interface ArtifactData {
  id: string;
  title: string;
  artifactType: string;
  previewText?: string;
  status?: string;
  mimeType?: string;
  harnessRunId?: string;
  createdAt?: string;
}

export interface ElicitationData {
  id: string;
  prompt: string;
  responseType: 'text' | 'radio' | 'single_select' | 'multi_select';
  options?: Array<{ label: string; value: string; description?: string }>;
  minimumSelections?: number;
  maximumSelections?: number;
  allowOther?: boolean;
  targetUserId?: string;
  status: 'open' | 'answered';
  answer?: unknown;
  answeredByName?: string;
  createdAt?: string;
}

export interface ActivitySuggestionData {
  id: string;
  title: string;
  source?: string;
  occurredAt?: string;
  reason: string;
  status: 'pending' | 'accepted' | 'dismissed';
}

export interface HyperSightBlockRun {
  id: string;
  blockId: string;
  configurationVersionId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
  markdown: string | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface HyperSightBlock {
  id: string;
  prompt: string;
  latestRun: HyperSightBlockRun | null;
}

export interface HyperSight {
  versionId: string | null;
  versionNumber: number;
  blocks: HyperSightBlock[];
  updatedAt: string | null;
}

export interface HyperSightPreference {
  visible: boolean;
  updatedAt: string | null;
}

export interface MessageMention {
  type: 'person' | 'connector';
  personId?: string;
  connectorType?: string;
  displayName?: string;
  avatarUrl?: string;
  startOffset: number;
  endOffset: number;
}

export interface ExternalActor {
  provider: string;
  providerAccountId: string;
  providerUserId: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface Message {
  id: string;
  /**
   * Stable identity supplied by the client for idempotent message creation.
   * The persisted message receives a different database `id`, so this value
   * is also used to reconcile optimistic, REST, and realtime copies.
   */
  clientMessageId?: string;
  workstreamId: string;
  sequenceNumber: number;
  authorType: 'human' | 'external' | 'agent' | 'system';
  author?: WorkspaceMember;
  externalActor?: ExternalActor;
  messageType:
    | 'text'
    | 'thought'
    | 'tool_event'
    | 'artifact'
    | 'elicitation'
    | 'activity_suggestion'
    | 'system';
  text?: string;
  mentions?: MessageMention[];
  attachments?: MessageAttachment[];
  createdAt: string;
  streaming?: boolean;
  deliveryState?: 'sending';
  /**
   * Durable Object events and D1 transcript rows have independent sequence
   * counters. Realtime-only blocks use this anchor so their observed order can
   * be retained without treating an event sequence as a persisted message
   * sequence.
   */
  realtimeOrder?: {
    anchorSequenceNumber: number;
    eventSequence: number;
    placement: 'before_anchor' | 'at_anchor';
  };
  toolEvent?: ToolEventData;
  thoughtEvent?: ThoughtEventData;
  artifact?: ArtifactData;
  elicitation?: ElicitationData;
  activitySuggestion?: ActivitySuggestionData;
}

export interface MessagePage {
  items: Message[];
  nextCursor: string | null;
  newerCursor: string | null;
}

export interface BackgroundTask {
  id: string;
  harnessRunId?: string;
  title: string;
  type: 'agent' | 'tool' | 'connector';
  status: 'running' | 'needs_input' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenCount?: number;
  toolUses?: number;
  transcriptMessageId?: string;
}

export interface AutomationRunSummary {
  id: string;
  workstreamId: string;
  title: string;
  status: HarnessStatus;
  triggerType: string;
  triggerTime: string;
  resultSummary?: string;
  durationMs?: number;
  participants?: Participant[];
}

export interface AutomationTemplateUpdate {
  versionId: string;
  versionNumber: number;
  overview: string;
  instructions: string;
  triggerSummary: string;
  capabilities: string[];
  expectedOutputs: string[];
  recommendedPlugins: Array<{ pluginId: string; recommendedTools: string[]; reason: string }>;
}

export interface HarnessRunMetadata {
  id: string;
  origin: string;
  status: 'scheduled' | 'running' | 'needs_input' | 'completed' | 'failed' | 'stopped';
  model?: string;
  error?: { code: string; message: string };
  requestId?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface WorkstreamAutomationSubscription {
  id: string;
  name: string;
  scope: Scope;
  status: AutomationStatus;
  triggerSummary: string;
  executionScope: string;
}

export interface WorkstreamDetail extends WorkstreamSummary {
  createdAt: string;
  createdBy?: WorkspaceMember;
  participants: Participant[];
  viewers: Participant[];
  resources: WorkstreamResource[];
  connections: WorkstreamConnection[];
  artifacts: ArtifactData[];
  backgroundTasks: BackgroundTask[];
  automationRuns: AutomationRunSummary[];
  automationSubscriptionId?: string;
  automationSubscription?: WorkstreamAutomationSubscription;
  automationRunId?: string;
  latestHarnessRunId?: string;
  latestHarnessRun?: HarnessRunMetadata;
  openElicitations?: ElicitationData[];
  suggestions?: ActivitySuggestionData[];
}

export interface WorkstreamDeferredContext {
  artifacts: ArtifactData[];
  backgroundTasks: BackgroundTask[];
  automationRuns: AutomationRunSummary[];
  automationSubscription?: WorkstreamAutomationSubscription;
}

export interface CreatedWorkstream {
  workstream: WorkstreamSummary;
  messageId: string;
  clientMessageId: string;
  createdAt: string;
}

export interface AutomationDetail extends AutomationSummary {
  description: string;
  versionNumber: number;
  overview: string;
  instructions: string;
  triggerSummary: string;
  scheduleSummary?: string;
  capabilities: string[];
  expectedOutputs: string[];
  recommendedPlugins: Array<{ pluginId: string; recommendedTools: string[]; reason: string }>;
  defaultPluginIds: string[];
  deliveryTargets?: Array<{
    type: 'slack_agent_dm';
    connectionId: string;
    displayName: string;
    status: 'active' | 'needs_input' | 'disabled';
  }>;
  executionScope: string;
  owner?: WorkspaceMember;
  runs: AutomationRunSummary[];
  nextRun?: AutomationRunSummary;
  templateUpdate?: AutomationTemplateUpdate;
}

export interface AutomationDraftQuestion {
  id: string;
  prompt: string;
  placeholder?: string;
  responseType: 'free_text' | 'single_select' | 'multi_select';
  options: Array<{ label: string; value: string; description?: string }>;
  minimumSelections?: number;
  maximumSelections?: number;
  allowOther: boolean;
}

export interface AutomationDraftSummary {
  name: string;
  description: string;
  overview: string;
  recommendedPlugins: Array<{ pluginId: string; recommendedTools: string[]; reason: string }>;
  scope: Scope;
  triggerSummary: string;
  capabilities: string[];
  requiresSlackDelivery: boolean;
}

export interface AutomationDraftResponse {
  draftId: string;
  assistantMessage?: string;
  question?: AutomationDraftQuestion;
  summary?: AutomationDraftSummary;
}

export interface WorkspaceTemplate {
  id: string;
  name: string;
  authorName: string;
  description: string;
  usageCount: number;
  capabilities: string[];
  latestVersion: number;
}

export interface SocketTicket {
  url: string;
  ticket: string;
}

export type WorkstreamSocketEvent =
  | { type: 'snapshot'; workstream: WorkstreamDetail; messages: Message[]; sequence: number }
  | { type: 'presence_changed'; viewers: Participant[]; sequence: number }
  | { type: 'message_created'; message: Message; sequence: number }
  | {
      type: 'stream_started';
      messageId: string;
      harnessRunId: string;
      turnId: string;
      epoch: number;
      streamSeq: number;
      reset: false;
      sequence: number;
    }
  | {
      type: 'stream_delta';
      messageId: string;
      delta: string;
      turnId: string;
      epoch: number;
      streamSeq: number;
      reset: boolean;
      sequence: number;
    }
  | { type: 'stream_completed'; message: Message; sequence: number }
  | { type: 'harness_status_changed'; status: HarnessStatus; sequence: number }
  | { type: 'resource_updated'; resource: WorkstreamResource; sequence: number }
  | { type: 'resync_required'; reason: 'history_unavailable' | 'sequence_ahead'; latestSequence: number; sequence: number }
  | { type: 'error'; message: string; sequence?: number };
