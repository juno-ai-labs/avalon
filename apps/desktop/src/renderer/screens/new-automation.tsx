import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowLeft,
  AtSign,
  CalendarClock,
  Check,
  ChevronRight,
  Ellipsis,
  Info,
  LoaderCircle,
  Mail,
  MessageSquare,
  Users,
  WandSparkles,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { AgentWorkTiming } from '../components/agent-work-timing';
import { AttachmentLightbox } from '../components/attachment-lightbox';
import type { AttachmentPreview } from '../components/attachments';
import { ComposerInput } from '../components/composer-input';
import { JumpToLatestButton } from '../components/conversation-follow';
import { MarkdownBody, MessageBlock } from '../components/workstream-blocks';
import { RallyMark, Badge, Button, EmptyState, IconButton, InlineError } from '../components/primitives';
import { withSuggestedPrompts } from '../components/suggested-prompts';
import { useAppSession } from '../lib/app-session';
import { ApiError } from '../lib/api';
import {
  answerElicitationOptimistically,
  automationQuestionToElicitation,
  elicitationMessageId,
  resolveElicitationMessages,
  type ElicitationAnswer,
} from '../lib/elicitation';
import { newAutomationDraftKey } from '../lib/draft-keys';
import { completeMentionAtCaret } from '../lib/mention-draft';
import { desktopBridge } from '../lib/platform';
import {
  currentSurfaceEntrypoint,
  reportTelemetryProductIntent,
} from '../lib/telemetry';
import { useDraftText } from '../lib/use-draft-text';
import { draftWithMentionStarted, mentionOptionId, mentionQueryAtCaret, useMentionNavigation } from '../lib/use-mention-navigation';
import { createElicitationMessage, createTextMessage, createToolEventMessage, upsertTranscriptMessage } from '../lib/transcript';
import { useFileAttachments } from '../lib/use-file-attachments';
import { useClientFeatureFlags } from '../lib/use-client-feature-flags';
import { useAutomationAgentSocket } from '../lib/use-automation-agent-socket';
import { useTranscriptFollow } from '../lib/use-transcript-follow';
import { useWindowFilePaste } from '../lib/use-file-paste';
import type {
  AgentModelOverride,
  AutomationActivitySource,
  AutomationDraftQuestion,
  AutomationDraftResponse,
  AutomationDraftSummary,
  AutomationSummary,
  AutomationScope,
  Message,
  MessageAttachment,
  Workspace,
  WorkspaceTemplate,
  WorkstreamConnection,
} from '../lib/types';

const AUTOMATION_CHAT_ID = 'automation-creator';
const AUTOMATION_USER_ID = 'automation-current-user';
const AUTOMATION_USER = {
  id: AUTOMATION_USER_ID,
  name: 'You',
  email: '',
  timezone: 'UTC',
};

interface AutomationCompilePayload {
  attachmentIds: string[];
  attachmentLocalIds: string[];
  attachments: MessageAttachment[];
  message: string;
  /**
   * The draft this turn was sent from, or null when it opens a new one. A turn
   * outlives the screen state it was sent from — the builder stays mounted
   * across a switch to another draft — so every write it makes is checked
   * against this rather than against whatever is on screen when it lands.
   */
  startedOnDraftId: string | null;
  templateId?: string;
  turnId: string;
  inputMode: 'typed' | 'suggested_prompt' | 'elicitation_response' | 'edit';
  elicitation?: {
    id: string;
    answer: ElicitationAnswer;
    responseType: AutomationDraftQuestion['responseType'];
    options: AutomationDraftQuestion['options'];
    allowOther: boolean;
    presentedAt: string;
  };
}

function automationTextMessage(
  id: string,
  authorType: 'human' | 'agent',
  text: string,
  streaming = false,
  attachments: MessageAttachment[] = [],
): Message {
  return createTextMessage({
    id,
    workstreamId: AUTOMATION_CHAT_ID,
    sequenceNumber: 0,
    authorType,
    ...(authorType === 'human' ? { author: AUTOMATION_USER } : {}),
    text,
    createdAt: new Date().toISOString(),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(streaming ? { streaming: true } : {}),
  });
}

/**
 * How much narration a failed compile leaves behind, and from which end.
 *
 * The opening plan and the first progress updates are the part that explains a
 * failure; a run that degenerates does so at the end. A compiler stuck
 * repairing a rejected submission has been observed narrating the rejected
 * schema itself, and persisting that into the transcript is worse than
 * persisting nothing — so the tail is what gets dropped, not the head.
 */
const RETAINED_NARRATION_CHARACTERS = 1_500;

export function retainableNarration(narration: string): string {
  const trimmed = narration.trim();
  if (trimmed.length <= RETAINED_NARRATION_CHARACTERS) return trimmed;
  // Cut at the last paragraph break inside the budget so the message ends on a
  // finished thought; fall back to the hard cut when there is no break to use.
  const head = trimmed.slice(0, RETAINED_NARRATION_CHARACTERS);
  const lastBreak = head.lastIndexOf('\n\n');
  return `${(lastBreak > 0 ? head.slice(0, lastBreak) : head).trimEnd()}\n\n…`;
}

function settleThought(turns: Message[], thoughtId: string): Message[] {
  const settledAt = Date.now();
  return turns.map((message) => {
    if (message.id !== thoughtId || !message.thoughtEvent) return message;
    const activeDuration = message.thoughtEvent.startedAt === undefined
      ? 0
      : Math.max(0, settledAt - message.thoughtEvent.startedAt);
    return {
      ...message,
      thoughtEvent: {
        status: 'completed',
        durationMs: message.thoughtEvent.durationMs + activeDuration,
      },
    };
  });
}

const examples = [
  'Check this blog every 24 hours for a new post.',
  'When a candidate call ends, prepare the follow-up email.',
  'Every Friday, prepare a changelog from merged work.',
  'When this error appears in the logs, open an investigation.',
];

const AutomationSuggestedPrompts = withSuggestedPrompts<{
  onSelect: (example: string) => void;
}>(({ onSelect }) => ({
  items: examples.map((example) => ({ id: example, text: example, icon: 'clock' as const })),
  onSelect: (item) => onSelect(item.text),
}));

function TemplateBrowser({ onSelect, onBack }: { onSelect: (template: WorkspaceTemplate) => void; onBack: () => void }): React.JSX.Element {
  const { api } = useAppSession();
  const templates = useQuery({
    queryKey: ['automation-templates'],
    queryFn: ({ signal }) => api!.getWorkspaceTemplates(signal),
    enabled: Boolean(api),
  });
  return (
    <div className="template-browser">
      <header>
        <Button className="button-quiet" onClick={onBack}><ArrowLeft size={14} /> Back</Button>
        <div><h2>Workspace templates</h2><p>Install a coworker’s recipe with optional plugin defaults of your own.</p></div>
      </header>
      {templates.isLoading ? (
        <div className="template-loading"><LoaderCircle className="spin" size={16} /> Loading templates…</div>
      ) : templates.error ? (
        <InlineError>{templates.error.message}</InlineError>
      ) : !templates.data?.length ? (
        <EmptyState title="No shared templates yet" description="Create an automation from scratch, then share it with your workspace." />
      ) : (
        <ul className="template-list">
          {templates.data.map((template) => (
            <li key={template.id}>
              <button onClick={() => onSelect(template)} type="button">
                <span className="template-icon"><Zap size={16} /></span>
                <span className="template-copy">
                  <strong>{template.name}</strong>
                  <small>by {template.authorName} · used by {template.usageCount}</small>
                  <p>{template.description}</p>
                  <span className="template-badges">{template.capabilities.map((capability) => <Badge key={capability}>{capability}</Badge>)}</span>
                </span>
                <span className="template-version">v{template.latestVersion}</span>
                <ChevronRight size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function eligiblePlugins(connections: WorkstreamConnection[], scope: 'you' | 'workspace'): WorkstreamConnection[] {
  return connections
    .filter((connection) => connection.status === 'healthy' && (scope === 'you' || connection.scope === 'workspace'))
    .sort((left, right) => left.displayName.localeCompare(right.displayName));
}

function PluginDefaults({
  connections,
  selected,
  scope,
  recommendations = [],
  onChange,
}: {
  connections: WorkstreamConnection[];
  selected: string[];
  scope: 'you' | 'workspace';
  recommendations?: Array<{ pluginId: string; recommendedTools: string[]; reason: string }>;
  onChange: (pluginIds: string[]) => void;
}): React.JSX.Element {
  const candidates = eligiblePlugins(connections, scope);
  const recommendationById = new Map(recommendations.map((recommendation) => [recommendation.pluginId, recommendation]));
  const ordered = [...candidates].sort((left, right) => {
    const leftRecommended = recommendationById.has(left.modelPluginId) ? 0 : 1;
    const rightRecommended = recommendationById.has(right.modelPluginId) ? 0 : 1;
    return leftRecommended - rightRecommended || left.displayName.localeCompare(right.displayName);
  });
  return (
    <section className="automation-plugin-defaults" aria-label="Default plugins">
      <header>
        <div><strong>Default plugins</strong><small>Optional preloads. The automation can discover and load any authorized plugin while it runs.</small></div>
        <span>{selected.length} selected</span>
      </header>
      {!ordered.length ? (
        <p className="automation-plugin-empty">No connected plugins are available yet. You can still create this automation.</p>
      ) : (
        <ul>
          {ordered.map((connection) => {
            const recommendation = recommendationById.get(connection.modelPluginId);
            const checked = selected.includes(connection.modelPluginId);
            return (
              <li key={connection.id}>
                <label>
                  <input
                    checked={checked}
                    onChange={() => onChange(checked
                      ? selected.filter((pluginId) => pluginId !== connection.modelPluginId)
                      : [...selected, connection.modelPluginId])}
                    type="checkbox"
                  />
                  <span className="automation-plugin-check">{checked && <Check size={12} />}</span>
                  <span className="automation-plugin-copy">
                    <strong>{connection.displayName}{recommendation && <Badge>Recommended</Badge>}</strong>
                    <small>{connection.scope === 'workspace' ? 'Workspace' : 'Personal'} · {connection.modelPluginId}</small>
                    {recommendation && <p>{recommendation.reason}</p>}
                    {recommendation?.recommendedTools.length ? (
                      <span className="automation-plugin-tools">Suggested tools: {recommendation.recommendedTools.join(', ')}</span>
                    ) : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ActivitySourceBindings({
  connections,
  sources,
  selected,
  scope,
  onChange,
}: {
  connections: WorkstreamConnection[];
  sources: AutomationActivitySource[];
  selected: Record<string, string>;
  scope: 'you' | 'workspace';
  onChange: (bindings: Record<string, string>) => void;
}): React.JSX.Element | null {
  if (!sources.length) return null;
  const candidates = eligiblePlugins(connections, scope);
  return (
    <section className="automation-plugin-defaults" aria-label="Activity sources">
      <header>
        <div><strong>Activity sources</strong><small>Each trigger listens only to the selected connector connection.</small></div>
        <span>{sources.filter((source) => selected[source.bindingKey]).length} / {sources.length}</span>
      </header>
      <ul>
        {sources.map((source) => {
          const sourceCandidates = candidates.filter((connection) => connection.connectorType === source.connectorType);
          return (
            <li key={source.bindingKey}>
              <label className="automation-activity-source">
                <span className="automation-plugin-copy">
                  <strong>{source.bindingKey.replaceAll('_', ' ')}</strong>
                  <small>{source.connectorType}</small>
                </span>
                <select
                  aria-label={`Connector for ${source.bindingKey}`}
                  onChange={(event) => onChange({ ...selected, [source.bindingKey]: event.target.value })}
                  value={selected[source.bindingKey] ?? ''}
                >
                  <option value="">Select a connection…</option>
                  {sourceCandidates.map((connection) => (
                    <option key={connection.id} value={connection.modelPluginId}>
                      {connection.displayName} · {connection.scope === 'workspace' ? 'Workspace' : 'Personal'}
                    </option>
                  ))}
                </select>
              </label>
              {!sourceCandidates.length && <p className="automation-plugin-empty">Connect an eligible {source.connectorType} account to use this trigger.</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function automationQuestionMessage(
  assistantMessage: string | undefined,
  question: AutomationDraftQuestion,
): Message {
  const elicitation = automationQuestionToElicitation(question);
  if (question.responseType === 'free_text') {
    return automationTextMessage(elicitationMessageId(question.id), 'agent', assistantMessage ?? elicitation.prompt);
  }
  return createElicitationMessage({
    id: elicitationMessageId(question.id),
    workstreamId: AUTOMATION_CHAT_ID,
    sequenceNumber: 0,
    authorType: 'agent',
    createdAt: new Date().toISOString(),
    elicitation,
  });
}

/** A saved conversation as the builder renders it. Every turn comes back as
 * plain text except the compiler's last one, which is re-rendered from the
 * draft so a choice the person walked away from is still a choice they can
 * make, rather than a sentence describing one. */
function resumedTurns(
  messages: Array<{
    role: 'user' | 'assistant';
    content: string;
    turnId?: string;
    clientMessageId?: string | null;
    attachmentIds?: string[];
    createdAt?: number;
  }>,
  draft: AutomationDraftResponse | null,
  current: Message[] = [],
): Message[] {
  const lastIndex = messages.length - 1;
  const merged = [...current];
  messages.forEach((message, index) => {
    const authorType = message.role === 'user' ? 'human' : 'agent';
    const elicitationIndex = message.role === 'user' && message.clientMessageId
      ? merged.findIndex((candidate) =>
          candidate.messageType === 'elicitation' && candidate.id === message.clientMessageId)
      : -1;
    if (elicitationIndex >= 0) {
      merged[elicitationIndex] = { ...merged[elicitationIndex]!, clientMessageId: message.clientMessageId ?? undefined };
      return;
    }
    const existingIndex = merged.findIndex((candidate) =>
      (message.turnId !== undefined && candidate.id === message.turnId)
      || (message.clientMessageId !== undefined && message.clientMessageId !== null
        && candidate.clientMessageId === message.clientMessageId)
      || (message.clientMessageId !== undefined && message.clientMessageId !== null
        && candidate.id === message.clientMessageId)
      || (candidate.authorType === authorType && candidate.text === message.content));
    let canonical: Message;
    if (index === lastIndex && message.role === 'assistant' && draft?.question) {
      canonical = automationQuestionMessage(draft.assistantMessage ?? message.content, draft.question);
    } else {
      canonical = automationTextMessage(
        message.turnId ?? `resumed-${index}`,
        authorType,
        message.content,
      );
    }
    const existing = existingIndex >= 0 ? merged[existingIndex] : undefined;
    const next: Message = {
      ...canonical,
      ...(existing ?? {}),
      id: message.turnId ?? canonical.id,
      authorType,
      text: message.content,
      ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
      ...(message.createdAt === undefined ? {} : { createdAt: new Date(message.createdAt).toISOString() }),
    };
    if (existingIndex >= 0) merged[existingIndex] = next;
    else merged.push(next);
  });
  const elicitationTurnIds = new Set(
    merged
      .filter((message) => message.messageType === 'elicitation')
      .map((message) => message.id),
  );
  const elicitationAnswers = new Set(
    merged
      .filter((message) => message.messageType === 'elicitation')
      .flatMap((message) => {
        const answer = message.elicitation?.answer;
        return answer == null ? [] : Array.isArray(answer) ? answer : [answer];
      }),
  );
  return merged.filter((message) => !(
    message.messageType === 'text'
    && message.authorType === 'human'
    && (
      (message.clientMessageId !== undefined
        && message.clientMessageId !== null
        && elicitationTurnIds.has(message.clientMessageId))
      || (message.text !== undefined && elicitationAnswers.has(message.text))
    )
  ));
}

function DeliveryChoice({
  checked,
  description,
  icon,
  label,
  locked = false,
  onToggle,
}: {
  checked: boolean;
  description: string;
  icon: React.JSX.Element;
  label: string;
  locked?: boolean;
  onToggle?: () => void;
}): React.JSX.Element {
  return (
    <li>
      <label>
        <input
          checked={checked}
          disabled={locked}
          onChange={() => onToggle?.()}
          type="checkbox"
        />
        <span className="automation-plugin-check">{checked && <Check size={12} />}</span>
        <span className="automation-plugin-copy">
          <strong>{icon} {label}{locked && <Badge>Always on</Badge>}</strong>
          <small>{description}</small>
        </span>
      </label>
    </li>
  );
}

/**
 * What the draft itself said about where the result goes.
 *
 * Rally sends the result to the destinations chosen here and the run sends
 * nothing, so a draft that promises to email or message somebody and lands on a
 * screen with no destination ticked is an automation that quietly delivers
 * nowhere. The sentence names what was asked for; the boxes below are what
 * actually decides it.
 */
function deliveryNudge(summary: AutomationDraftSummary): string {
  if (summary.requiresEmailDelivery && summary.requiresSlackDelivery) return 'This draft mentions email and Slack delivery. ';
  if (summary.requiresEmailDelivery) return 'This draft mentions email delivery. ';
  if (summary.requiresSlackDelivery) return 'This draft mentions Slack delivery. ';
  return '';
}

function DraftSummary({
  draft,
  creating,
  connections,
  activitySourcePluginIds,
  emailDelivery,
  ownerEmail,
  scope,
  scopeChangeAllowed,
  deliveryConnectionId,
  onActivitySourcesChange,
  onEmailDeliveryChange,
  onScopeChange,
  onDeliveryConnectionChange,
  onCreate,
}: {
  draft: AutomationDraftResponse;
  creating: boolean;
  connections: WorkstreamConnection[];
  activitySourcePluginIds: Record<string, string>;
  emailDelivery: boolean;
  ownerEmail: string;
  scope: AutomationScope;
  scopeChangeAllowed: boolean;
  deliveryConnectionId: string;
  onActivitySourcesChange: (bindings: Record<string, string>) => void;
  onEmailDeliveryChange: (enabled: boolean) => void;
  onScopeChange: (scope: AutomationScope) => void;
  onDeliveryConnectionChange: (connectionId: string) => void;
  onCreate: () => void;
}): React.JSX.Element | null {
  if (!draft.summary) return null;
  const summary = draft.summary;
  const activitySources = summary.activitySources ?? [];
  // Connectors declare for themselves whether they can hand a result to this
  // user; the API only sets userDelivery once that is actually true for them.
  const deliveryConnections = scope === 'you' ? connections.filter((connection) => connection.userDelivery) : [];
  return (
    <section className="automation-summary-card" aria-labelledby="automation-summary-title">
      <header>
        <span><WandSparkles size={17} /></span>
        <div><small>Ready to create</small><h2 id="automation-summary-title">{summary.name}</h2><p>{summary.description}</p></div>
      </header>
      <div className="automation-overview"><MarkdownBody>{summary.overview || summary.description}</MarkdownBody></div>
      <dl className="automation-summary-meta">
        <div>
          <dt><Users size={13} /> {scopeChangeAllowed
            ? <label htmlFor="automation-scope">Runs as</label>
            : <span>Runs as</span>}</dt>
          <dd>
            {scopeChangeAllowed ? (
              <select
                id="automation-scope"
                onChange={(event) => onScopeChange(event.target.value === 'workspace' ? 'workspace' : 'you')}
                value={scope}
              >
                <option value="you">You</option>
                <option value="workspace">Workspace</option>
              </select>
            ) : scope === 'you' ? 'You' : 'Workspace'}
          </dd>
        </div>
        <div><dt><CalendarClock size={13} /> Trigger</dt><dd>{summary.triggerSummary}</dd></div>
      </dl>
      <ActivitySourceBindings
        connections={connections}
        onChange={onActivitySourcesChange}
        scope={scope}
        selected={activitySourcePluginIds}
        sources={activitySources}
      />
      <section className="automation-plugin-defaults automation-delivery-target" aria-label="Deliver results">
        <header>
          <div><strong>Deliver results</strong><small>{deliveryNudge(summary)}You can change these later from the automation.</small></div>
        </header>
        <ul>
          <DeliveryChoice
            checked
            description="Every run is saved to its own Rally work stream."
            icon={<RallyMark />}
            label="Rally"
            locked
          />
          {scope === 'you' && ownerEmail && (
            <DeliveryChoice
              checked={emailDelivery}
              description={`Email each result to ${ownerEmail}.`}
              icon={<Mail size={13} />}
              label="Email"
              onToggle={() => onEmailDeliveryChange(!emailDelivery)}
            />
          )}
          {deliveryConnections.map((connection) => (
            <DeliveryChoice
              checked={deliveryConnectionId === connection.id}
              description={connection.userDelivery!.description}
              icon={<MessageSquare size={13} />}
              key={connection.id}
              label={`${connection.userDelivery!.label} · ${connection.displayName}`}
              onToggle={() => onDeliveryConnectionChange(deliveryConnectionId === connection.id ? '' : connection.id)}
            />
          ))}
        </ul>
      </section>
      <footer>
        <span>Rally preloads the plugins this draft needs, and never widens their runtime authority.</span>
        <Button
          className="button-primary"
          disabled={creating || activitySources.some((source) => !activitySourcePluginIds[source.bindingKey])}
          onClick={onCreate}
        >
          {creating ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Create automation
        </Button>
      </footer>
    </section>
  );
}

export function NewAutomationScreen({ workspace }: { workspace: Workspace }): React.JSX.Element {
  const { api, session } = useAppSession();
  const featureFlags = useClientFeatureFlags(api);
  const workspaceTemplatesEnabled = featureFlags.data?.automationWorkspaceTemplatesEnabled === true;
  const navigate = useNavigate();
  const { id: routeAutomationId = 'new' } = useParams();
  const resumeDraftId = routeAutomationId === 'new' ? null : routeAutomationId;
  // This screen also writes the draft into the URL once a turn compiles, and
  // that write must not read back as "go and load this draft" — the
  // conversation on screen is already the one it names, and loading it would
  // replace it with the turn before. What separates the two is which *screen*
  // wrote the URL, so the mark is held here and not in history state: a history
  // entry outlives this component, and one that stayed marked would leave a
  // remount — a back gesture, a restored window — with the resume permanently
  // switched off, showing an empty builder for a draft that has a conversation.
  const selfNamedDraftId = useRef<string | null>(null);
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The conversation this screen's composer belongs to. Keeping the cache per
  // draft is what stops an unsent message, and the attachments staged with it,
  // following the screen into somebody else's conversation — including the
  // blank one **New automation** opens, which shares the launcher's key.
  //
  // It moves on a settled turn rather than on the draft in the URL, because
  // this screen's own URL write reaches the router several renders late and a
  // key that followed it would re-key the composer mid-turn. `useDraftText`
  // empties the composer whenever its key changes, so whatever was typed while
  // the turn was compiling is carried over by hand rather than dropped.
  const [composerDraftId, setComposerDraftId] = useState<string | null>(resumeDraftId);
  const automationId = composerDraftId ?? resumeDraftId;
  const agentFeed = useAutomationAgentSocket(api, automationId);
  const carriedInput = useRef<string | null>(null);
  const draftKey = newAutomationDraftKey(workspace.id, composerDraftId);
  const { text: input, setText: setInput, releaseDraft } = useDraftText(draftKey);
  useEffect(() => {
    const carried = carriedInput.current;
    carriedInput.current = null;
    // Runs after the hook's own key effect, which is declared above this one,
    // so this is what the composer is left holding. Writing it back also marks
    // the draft edited, so the cache read still in flight stands down rather
    // than overwriting it.
    if (carried) setInput(carried);
  }, [composerDraftId, setInput]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreview | null>(null);
  const [draft, setDraft] = useState<AutomationDraftResponse | null>(null);
  const [turns, setTurns] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState('');
  /**
   * The same narration, readable from a settled-mutation callback. `onError`
   * runs after the stream is over and has to keep what the architect said;
   * the state above is the render source and this is the imperative read, both
   * written only by `applyNarration` below.
   */
  const streamingNarrationRef = useRef('');
  const applyNarration = useCallback((next: (current: string) => string) => {
    const settled = next(streamingNarrationRef.current);
    streamingNarrationRef.current = settled;
    setStreamingText(settled);
  }, []);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [defaultPluginIds, setDefaultPluginIds] = useState<string[]>([]);
  const [activitySourcePluginIds, setActivitySourcePluginIds] = useState<Record<string, string>>({});
  const [scopeOverride, setScopeOverride] = useState<AutomationScope | null>(null);
  const [emailDelivery, setEmailDelivery] = useState(false);
  const [deliveryConnectionId, setDeliveryConnectionId] = useState('');
  const [initializedRecommendations, setInitializedRecommendations] = useState('');
  const [initializedActivitySources, setInitializedActivitySources] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<WorkspaceTemplate | null>(null);

  useEffect(() => {
    if (workspaceTemplatesEnabled) return;
    setTemplatesOpen(false);
    setSelectedTemplate(null);
  }, [workspaceTemplatesEnabled]);
  // Pins the work streams this automation's runs create, not the drafting
  // conversation above — the automation architect keeps its own flag.
  const [modelOverride, setModelOverride] = useState<AgentModelOverride | null>(null);
  const attachmentDraft = useFileAttachments(api, draftKey);
  // This composer does not autofocus either, so a paste landing on the document
  // reaches the draft rather than going nowhere.
  useWindowFilePaste(attachmentDraft.addFiles);

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: ({ signal }) => api!.getConnections(signal),
    enabled: Boolean(api),
    staleTime: 10_000,
  });

  // Opened from a draft in the sidebar. The conversation is fetched once and
  // applied once: after that the screen owns it again, so continuing the draft
  // is not undone by a refetch of the turn it was resumed at.
  const [resumedDraftId, setResumedDraftId] = useState<string | null>(null);
  const resumedDraft = useQuery({
    queryKey: ['automation-draft', resumeDraftId],
    queryFn: ({ signal }) => api!.getAutomationAgentDraft(resumeDraftId!, signal),
    enabled: Boolean(api && resumeDraftId)
      && resumeDraftId !== selfNamedDraftId.current
      && resumedDraftId !== resumeDraftId,
    staleTime: Infinity,
    retry: false,
  });
  // Which draft the address bar named last. The transition is what matters, not
  // the value: a screen that read "no draft" as "start over" on every render
  // would wipe a conversation as soon as it began, before it had named itself.
  const namedDraftId = useRef(resumeDraftId);
  // The history entry that draft id was read from. The id alone cannot see a
  // navigation that lands in the same commit as this screen's own URL write:
  // the bar goes null → this draft → null, the effect observes only the value
  // it ends on, and a transition that never appears is one nothing reacts to.
  // A new entry is what actually says somebody navigated, and — unlike the id —
  // it does not appear during the renders where the bar is merely behind.
  const locationKey = useLocation().key;
  const reportedBuilderLocation = useRef<string | null>(null);
  useEffect(() => {
    if (reportedBuilderLocation.current === locationKey) return;
    reportedBuilderLocation.current = locationKey;
    reportTelemetryProductIntent({
      kind: 'automation_builder_started',
      entrypoint: currentSurfaceEntrypoint(),
      resumedDraft: resumeDraftId !== null,
    });
  }, [locationKey, resumeDraftId]);
  const namedLocationKey = useRef(locationKey);
  useEffect(() => {
    const previous = namedDraftId.current;
    const navigated = namedLocationKey.current !== locationKey;
    namedDraftId.current = resumeDraftId;
    namedLocationKey.current = locationKey;
    // Everything below keys off the address bar *changing*, never off what it
    // currently says. This screen's own write reaches the router several
    // renders after the state beside it, so for a render or two the bar still
    // names the draft before last — and reading that as a navigation is what
    // wiped a conversation, and then re-keyed the composer under the typing
    // hand, in two earlier attempts at this.
    const movedToAnotherDraft = resumeDraftId !== previous;
    // The mark only ever covers the URL this screen wrote, and it is stale once
    // the reader has moved somewhere else. Left set, it would refuse to reopen
    // that very draft later in the same screen.
    if (movedToAnotherDraft && resumeDraftId !== null && resumeDraftId !== selfNamedDraftId.current) {
      selfNamedDraftId.current = null;
    }
    if (resumeDraftId === null) {
      // New automation was chosen while a draft was on screen. The route did
      // not change, so nothing else clears it.
      //
      // Either the id was seen to change, or a new history entry arrived while
      // a draft is on screen. The second is not redundant: this screen names
      // its own draft in the bar, and when that write and the reader's next
      // navigation land in one commit the id reads null both before and after,
      // so the first test sees nothing happen. The composer was then left keyed
      // to a draft the reader had already navigated away from — holding, on the
      // blank builder, the sentence they typed for the other one.
      if (previous !== null || (navigated && composerDraftId !== null)) {
        selfNamedDraftId.current = null;
        setResumedDraftId(null);
        setComposerDraftId(null);
        setDraft(null);
        setTurns([]);
      }
      return;
    }
    // The moment the reader picks a different draft, the conversation on screen
    // stops being the one this screen is showing — before its replacement has
    // loaded, and whether or not that load ever succeeds. Leaving the old one
    // up would let a turn be sent against the draft the sidebar says was
    // closed, and a failed load would leave it there for good.
    if (movedToAnotherDraft
      && resumeDraftId !== selfNamedDraftId.current
      && resumeDraftId !== resumedDraftId
      && draft !== null) {
      setDraft(null);
      setTurns([]);
    }
    const resumedSnapshot = resumedDraft.data;
    if (!resumedSnapshot || resumedDraftId === resumeDraftId) return;
    const resumed = api!.automationDraftFromAgentSnapshot(resumedSnapshot);
    setResumedDraftId(resumeDraftId);
    setComposerDraftId(resumeDraftId);
    setDraft(resumed.draft);
    setTurns(resumed.draft ? resumedTurns(resumed.messages, resumed.draft) : resumedTurns(resumed.messages, null));
  }, [api, composerDraftId, draft, locationKey, resumeDraftId, resumedDraft.data, resumedDraftId]);

  useEffect(() => {
    const snapshot = agentFeed.snapshot;
    if (!snapshot || snapshot.automationId !== automationId || !api) return;
    const normalized = api.automationDraftFromAgentSnapshot(snapshot);
    setDraft(normalized.draft);
    setTurns((current) => {
      const resumed = resumedTurns(normalized.messages, normalized.draft, current);
      const compilerRun = snapshot.activeCompilerRun;
      if (compilerRun?.state !== 'failed') return resumed;
      return settleThought(resumed, `${compilerRun.admittedTurnId}-thought`);
    });
    if (!snapshot.activeCompilerRun) applyNarration(() => '');
    else if (snapshot.compilerCheckpoint?.narration) {
      applyNarration((current) => (
        snapshot.activeCompilerRun?.state === 'failed' || current.length === 0
          ? snapshot.compilerCheckpoint!.narration
          : current
      ));
    }
  }, [agentFeed.snapshot, api, applyNarration, automationId]);

  const handledStreamSequence = useRef(0);
  useEffect(() => {
    handledStreamSequence.current = 0;
  }, [automationId]);
  useEffect(() => {
    for (const entry of agentFeed.streamEvents) {
      if (entry.sequence <= handledStreamSequence.current) continue;
      handledStreamSequence.current = entry.sequence;
      const event = entry.event;
      if (event.type === 'started') {
        applyNarration(() => '');
        continue;
      }
      if (event.type === 'delta') {
        applyNarration((current) => event.reset ? event.delta : current + event.delta);
        continue;
      }
      const activeTurnId = agentFeed.snapshot?.activeCompilerRun?.admittedTurnId;
      if (!activeTurnId) continue;
      if (event.type === 'thinking') {
      const thoughtId = `${activeTurnId}-thought`;
      setTurns((current) => {
        const existing = current.findIndex((message) => message.id === thoughtId);
        const previous = existing >= 0 ? current[existing] : undefined;
        const thoughtMessage: Message = {
          id: thoughtId,
          workstreamId: AUTOMATION_CHAT_ID,
          sequenceNumber: previous?.sequenceNumber ?? current.length,
          authorType: 'agent',
          messageType: 'thought',
          createdAt: previous?.createdAt ?? new Date().toISOString(),
          thoughtEvent: {
            status: event.status === 'started' ? 'started' : 'completed',
            durationMs: event.durationMs,
            ...(event.status === 'started' ? { startedAt: Date.now() } : {}),
          },
        };
        return upsertTranscriptMessage(current, thoughtMessage);
      });
        continue;
      }
      if (event.type === 'tool') {
        setTurns((current) => {
          const existing = current.find((message) => message.id === event.toolCallId);
          return upsertTranscriptMessage(current, createToolEventMessage({
            id: event.toolCallId,
            workstreamId: AUTOMATION_CHAT_ID,
            sequenceNumber: existing?.sequenceNumber ?? current.length,
            authorType: 'agent',
            createdAt: existing?.createdAt ?? new Date().toISOString(),
            toolEvent: {
              id: event.toolCallId,
              name: event.name,
              summary: event.summary,
              status: event.status,
              ...(event.plugin ? { plugin: event.plugin } : {}),
              ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
            },
          }));
        });
      }
    }
  }, [agentFeed.snapshot?.activeCompilerRun?.admittedTurnId, agentFeed.streamEvents, applyNarration]);
  const visibleMentionConnections = mentionQuery === null
    ? []
    : (connections.data ?? [])
      .filter((connection) => connection.displayName.toLowerCase().includes(mentionQuery.toLowerCase()))
      .slice(0, 8);
  const mentionNavigation = useMentionNavigation(
    visibleMentionConnections.map((connection) => connection.id),
    (index) => {
      const connection = visibleMentionConnections[index];
      if (connection) insertConnectionMention(connection);
    },
  );
  const mentionLabels = useMemo(
    () => (connections.data ?? []).map((connection) => connection.displayName),
    [connections.data],
  );
  const loadAttachmentContent = useCallback(
    (resourceId: string, signal?: AbortSignal) => api!.getResourcePreviewContent(resourceId, signal),
    [api],
  );

  const updateInput = (value: string): void => {
    setInput(value);
    syncMentionQuery(value);
  };

  /** What the caret is naming, recomputed as the draft changes. */
  const syncMentionQuery = (value: string): void => {
    setMentionQuery(mentionQueryAtCaret(value, textareaRef.current?.selectionStart));
  };

  /**
   * The caret moved without the draft changing — an arrow key, a click, a drag.
   * This may only *close* the list: a list that outlives the mention the caret
   * was in still answers `Enter` and inserts against an `@` the caret has left.
   * It may not open one, or `Escape` would last exactly until the next arrow
   * key, and wandering back through an old mention would raise a list nobody
   * asked for.
   */
  const refreshOpenMentionQuery = (value: string): void => {
    setMentionQuery((current) => current === null
      ? null
      : mentionQueryAtCaret(value, textareaRef.current?.selectionStart));
  };

  const beginConnectionMention = (): void => {
    const started = draftWithMentionStarted(
      input,
      textareaRef.current?.selectionStart,
      textareaRef.current?.selectionEnd,
    );
    setInput(started.value);
    setMentionQuery('');
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      // Only while the draft is still the one this opened. A frame is enough
      // room for a keystroke, and putting the caret back where the `@` went
      // would drag it out of whatever was typed in the meantime.
      if (textarea?.value === started.value) textarea.setSelectionRange(started.caret, started.caret);
    });
  };

  const insertConnectionMention = (connection: WorkstreamConnection): void => {
    const textarea = textareaRef.current;
    const caret = textarea?.selectionStart ?? input.length;
    const completed = completeMentionAtCaret(
      input,
      caret,
      connection.displayName,
      textarea?.selectionEnd ?? caret,
    );
    // The caret has left the mention this list belongs to; `slice(0, -1)` would
    // eat the character before it rather than replacing a half-typed name.
    if (!completed) {
      setMentionQuery(null);
      return;
    }
    setInput(completed.text);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(completed.caret, completed.caret);
    });
  };

  // Rally's suggestion is the default; the creator can still redirect the
  // automation, and only an administrator may make it a workspace automation.
  const scopeChangeAllowed = session?.workspace?.role === 'owner' || session?.workspace?.role === 'admin';
  const scope: AutomationScope = scopeOverride ?? draft?.summary?.scope ?? 'you';

  // Keyed on the scope in force, not the one Rally suggested: a workspace
  // automation cannot preload a coworker's personal plugin, and switching back
  // to You has to restore the personal picks it dropped. The creator has no
  // control to recover them by hand.
  useEffect(() => {
    const summary = draft?.summary;
    if (!summary || !connections.data) return;
    const recommendations = summary.recommendedPlugins ?? [];
    const key = `${draft.draftId}:${scope}:${recommendations.map((item) => item.pluginId).join(',')}`;
    if (key === initializedRecommendations) return;
    const eligible = new Set(eligiblePlugins(connections.data, scope).map((connection) => connection.modelPluginId));
    setDefaultPluginIds(recommendations.map((item) => item.pluginId).filter((pluginId) => eligible.has(pluginId)));
    setInitializedRecommendations(key);
  }, [connections.data, draft, initializedRecommendations, scope]);

  const visibleActivitySources = selectedTemplate?.activitySources ?? draft?.summary?.activitySources ?? [];
  // Switching Runs as changes which connections are eligible, so the bindings
  // are re-derived under the scope in force rather than the suggested one.
  const activitySourceScope = selectedTemplate ? 'you' : scope;
  const activitySourceInitializationKey = selectedTemplate
    ? `template:${selectedTemplate.id}:${selectedTemplate.latestVersion}`
    : draft
      ? `draft:${draft.draftId}:${activitySourceScope}:${visibleActivitySources.map((source) => source.bindingKey).join(',')}`
      : '';
  useEffect(() => {
    if (!activitySourceInitializationKey || initializedActivitySources === activitySourceInitializationKey || !connections.data) return;
    const candidates = eligiblePlugins(connections.data, activitySourceScope);
    const next: Record<string, string> = {};
    for (const source of visibleActivitySources) {
      const sourceCandidates = candidates.filter((connection) => connection.connectorType === source.connectorType);
      const suggested = sourceCandidates.find((connection) => connection.modelPluginId === source.suggestedPluginId);
      const chosen = suggested ?? (sourceCandidates.length === 1 ? sourceCandidates[0] : undefined);
      if (chosen) next[source.bindingKey] = chosen.modelPluginId;
    }
    setActivitySourcePluginIds(next);
    setInitializedActivitySources(activitySourceInitializationKey);
  }, [activitySourceInitializationKey, activitySourceScope, connections.data, initializedActivitySources, visibleActivitySources]);

  useEffect(() => {
    setScopeOverride(null);
  }, [draft?.draftId, draft?.summary?.scope]);

  const deliveryDraftKey = draft ? `${draft.draftId}:${draft.summary?.scope ?? 'pending'}` : '';
  // The email box starts ticked when the draft's own outputs promise an emailed
  // result. Rally is the only sender now — the run is forbidden to mail the
  // result itself — so leaving it off by default turns "email me every morning"
  // into an automation that emails nobody, on the path where the reader agrees
  // with everything on screen and presses Create.
  const draftAsksForEmail = draft?.summary?.requiresEmailDelivery ?? false;
  useEffect(() => {
    setDeliveryConnectionId('');
    setEmailDelivery(draftAsksForEmail);
  }, [deliveryDraftKey, draftAsksForEmail]);

  useEffect(() => {
    if (scope !== 'you') setEmailDelivery(false);
  }, [scope]);

  useEffect(() => {
    if (!deliveryConnectionId) return;
    const stillAvailable = (connections.data ?? []).some((connection) =>
      connection.id === deliveryConnectionId && connection.userDelivery);
    if (!stillAvailable || scope !== 'you') setDeliveryConnectionId('');
  }, [connections.data, scope, deliveryConnectionId]);

  // The conversation on screen right now, read from a box rather than from a
  // closure: a turn's callbacks are created when it is sent and fire minutes
  // later, by which time the render they closed over may describe a draft the
  // reader has already left.
  const openDraftId = useRef<string | null>(null);
  openDraftId.current = draft?.draftId ?? null;
  const showsTurn = (payload: AutomationCompilePayload): boolean =>
    payload.startedOnDraftId === openDraftId.current;

  const compile = useMutation({
    mutationFn: (payload: AutomationCompilePayload) => api!.admitAutomationDraftTurn({
      ...(payload.startedOnDraftId ? { automationId: payload.startedOnDraftId } : {
        clientCreationKey: payload.turnId,
      }),
      clientMessageId: payload.turnId,
      content: payload.message,
      attachmentIds: payload.attachmentIds,
      inputMode: payload.inputMode,
    }),
    onMutate: (payload) => {
      applyNarration(() => '');
      setTurns((current) => {
        const updated = payload.elicitation
          ? resolveElicitationMessages(current, payload.elicitation.id, payload.elicitation.answer)
          : current;
        if (payload.elicitation) return updated;
        return updated.some((turn) => turn.id === payload.turnId)
          ? updated
          : [...updated, automationTextMessage(payload.turnId, 'human', payload.message, false, payload.attachments)];
      });
      setInput('');
      setMentionQuery(null);
    },
    onSuccess: (response, payload) => {
      attachmentDraft.consume(payload.attachmentLocalIds);
      queryClient.removeQueries({ queryKey: ['automation-draft', response.automationId] });
      if (!showsTurn(payload)) return;
      // Admission returns the durable identity immediately. The same
      // conversation subtree adopts it while compilation continues by socket.
      if (resumeDraftId !== response.automationId) {
        selfNamedDraftId.current = response.automationId;
        setResumedDraftId(response.automationId);
        queryClient.setQueryData<AutomationSummary[]>(['automations'], (current = []) => (
          current.some((item) => item.id === response.automationId)
            ? current
            : [{
                id: response.automationId,
                name: 'New automation',
                scope: 'you',
                status: 'draft',
                updatedAt: new Date().toISOString(),
              }, ...current]
        ));
        void navigate(`/automations/${encodeURIComponent(response.automationId)}`, { replace: true });
      }
      if (composerDraftId !== response.automationId) {
        carriedInput.current = input;
        releaseDraft();
        setComposerDraftId(response.automationId);
      }
    },
    onError: (_error, payload) => {
      if (!showsTurn(payload)) return;
      // Keep what the architect said. A compile that exhausts the harness's
      // wall clock is exactly when the narration is worth the most — "GitHub
      // holds the data but no connector is authorized" explains a timeout
      // that a column of tool rows does not — and clearing it here would
      // delete the explanation at the one moment it is needed.
      const narration = retainableNarration(streamingNarrationRef.current);
      applyNarration(() => '');
      setTurns((current) => {
        const settled = settleThought(current, `${payload.turnId}-thought`);
        return narration
          ? [...settled, automationTextMessage(crypto.randomUUID(), 'agent', narration)]
          : settled;
      });
    },
  });

  const compilerRun = agentFeed.snapshot?.activeCompilerRun;
  const compilePending = compile.isPending
    || compilerRun?.state === 'admitted'
    || compilerRun?.state === 'running';
  const compilerError = compilerRun?.state === 'failed'
    ? compilerRun.errorMessage ?? compilerRun.errorCode ?? 'Rally could not finish this turn.'
    : null;
  const stopCompiler = useMutation({
    mutationFn: () => api!.stopAutomationCompiler(automationId!, compilerRun!.id),
  });
  const retryCompiler = useMutation({
    mutationFn: () => api!.retryAutomationCompiler(automationId!, compilerRun!.id),
  });
  const transcriptFollow = useTranscriptFollow(
    transcriptScrollRef,
    compilePending,
    draft?.draftId ?? resumeDraftId ?? 'new-automation',
  );

  const deliveryConnection = (connections.data ?? []).find((connection) =>
    connection.id === deliveryConnectionId && connection.userDelivery);

  const create = useMutation({
    mutationFn: () => api!.createAutomation(draft!.draftId, defaultPluginIds, activitySourcePluginIds, {
      scope,
      ...(modelOverride ? { modelOverride } : {}),
      delivery: {
        ...(deliveryConnection
          ? { connection: { id: deliveryConnection.id, targetType: deliveryConnection.userDelivery!.targetType } }
          : {}),
        ...(emailDelivery ? { email: true } : {}),
      },
    }),
    onSuccess: (automation) => {
      void navigate(`/automations/${automation.id}`);
    },
  });

  const submitAsync = async (
    message = input,
    turnId: string = crypto.randomUUID(),
    elicitation?: AutomationCompilePayload['elicitation'],
    inputMode: AutomationCompilePayload['inputMode'] = elicitation ? 'elicitation_response' : 'typed',
  ): Promise<void> => {
    const readyAttachments = attachmentDraft.ready;
    const trimmed = message.trim();
    if ((!trimmed && readyAttachments.length === 0) || attachmentDraft.uploading || compilePending) return;
    // The address bar names a draft this screen has not got hold of — it is
    // still loading, or the load failed. A turn sent now carries no draft id
    // and would open a *second* draft while the sidebar still highlights the
    // first.
    if (resumeDraftId !== null && draft === null && agentFeed.snapshot === null) return;
    const createdAt = new Date().toISOString();
    await compile.mutateAsync({
      attachmentIds: readyAttachments.map((attachment) => attachment.resource!.id),
      attachmentLocalIds: readyAttachments.map((attachment) => attachment.localId),
      attachments: readyAttachments.map((attachment) => ({
        id: attachment.resource!.id,
        fileName: attachment.file.name,
        mimeType: attachment.file.type || 'application/octet-stream',
        sizeBytes: attachment.file.size,
        contentAvailable: true,
        createdAt,
      })),
      message: trimmed,
      inputMode,
      startedOnDraftId: draft?.draftId ?? null,
      turnId,
      ...(elicitation ? { elicitation } : {}),
    });
  };

  const submit = (message = input, inputMode: AutomationCompilePayload['inputMode'] = 'typed'): void => {
    void submitAsync(message, crypto.randomUUID(), undefined, inputMode).catch(() => undefined);
  };

  const draftId = draft?.draftId;

  return (
    <div
      className="new-automation-screen screen-with-titlebar"
      onScroll={(event) => transcriptFollow.onScroll(event.currentTarget)}
      onWheel={(event) => transcriptFollow.onWheel(event.currentTarget, event.deltaY)}
      ref={transcriptScrollRef}
    >
      <div className="screen-drag-strip window-drag" />
      <div className="new-automation-actions window-no-drag">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <IconButton label="More automation actions"><Ellipsis size={16} /></IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" className="menu-content" sideOffset={8}>
              <DropdownMenu.Item
                className="menu-item"
                disabled={!draftId}
                onSelect={() => {
                  if (draftId) void desktopBridge().copyText(draftId)
                    .then(() => reportTelemetryProductIntent({
                      kind: 'content_copied', contentType: 'automation_id', resourceType: 'automation',
                      resourceId: draftId,
                    }))
                    .catch(() => undefined);
                }}
              >
                <Info size={14} /> Copy draft ID
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <div className={clsx('automation-builder', (turns.length > 0 || draft) && 'has-conversation')}>
        {workspaceTemplatesEnabled && templatesOpen ? (
          <TemplateBrowser
            onBack={() => setTemplatesOpen(false)}
            onSelect={(template) => {
              setTemplatesOpen(false);
              setDefaultPluginIds([]);
              setActivitySourcePluginIds({});
              setInitializedActivitySources('');
              setSelectedTemplate(template);
            }}
          />
        ) : (
          <>
            {selectedTemplate ? (
              <section className="template-subscribe-card" aria-labelledby="template-subscribe-title">
                <Button className="button-quiet" onClick={() => setSelectedTemplate(null)}><ArrowLeft size={14} /> Back</Button>
                <span className="template-icon"><Zap size={18} /></span>
                <p className="eyebrow">Workspace template · v{selectedTemplate.latestVersion}</p>
                <h1 id="template-subscribe-title">{selectedTemplate.name}</h1>
                <p>{selectedTemplate.description}</p>
                <PluginDefaults
                  connections={connections.data ?? []}
                  onChange={setDefaultPluginIds}
                  scope="you"
                  selected={defaultPluginIds}
                />
                <ActivitySourceBindings
                  connections={connections.data ?? []}
                  onChange={setActivitySourcePluginIds}
                  scope="you"
                  selected={activitySourcePluginIds}
                  sources={selectedTemplate.activitySources}
                />
                <Button
                  className="button-primary"
                  onClick={() => {
                    setInput(`Create an automation from the workspace template "${selectedTemplate.name}". ${selectedTemplate.description}`);
                    setSelectedTemplate(null);
                  }}
                >
                  <Check size={14} /> Start with template
                </Button>
              </section>
            ) : resumeDraftId !== null && !draft && turns.length === 0 && !agentFeed.snapshot && resumedDraft.isError ? (
              // The draft named in the address bar is the one the sidebar is
              // highlighting, so the intro's blank slate would be a lie here —
              // and a message sent against it starts a second draft while the
              // first is still on screen in the sidebar.
              <section className="automation-builder-intro" aria-labelledby="automation-builder-heading">
                <RallyMark />
                <p className="eyebrow">Draft automation</p>
                <h1 id="automation-builder-heading">This draft could not be opened</h1>
                <p>{resumedDraft.error instanceof ApiError ? resumedDraft.error.message : 'Rally could not load this conversation.'}</p>
                <Button className="button-secondary" onClick={() => void resumedDraft.refetch()}>Try again</Button>
              </section>
            ) : resumeDraftId !== null && !draft && turns.length === 0 && !agentFeed.snapshot ? (
              <section className="automation-builder-intro" aria-labelledby="automation-builder-heading">
                <RallyMark />
                <p className="eyebrow">Draft automation</p>
                <h1 id="automation-builder-heading">Opening this draft…</h1>
              </section>
            ) : turns.length === 0 && !draft ? (
              <section className="automation-builder-intro" aria-labelledby="automation-builder-heading">
                <RallyMark />
                <p className="eyebrow">Create an automation</p>
                <h1 id="automation-builder-heading">What should happen automatically?</h1>
                <p>Describe the outcome. Rally can research your plugins and will ask for the details it needs.</p>
                <AutomationSuggestedPrompts onSelect={(example) => submit(example, 'suggested_prompt')} />
                {workspaceTemplatesEnabled && (
                  <button className="template-path" onClick={() => setTemplatesOpen(true)} type="button">Use a workspace template <ChevronRight size={13} /></button>
                )}
              </section>
            ) : (
              <div className="automation-chat-surface automation-conversation" aria-live="polite">
                {turns.map((turn) => (
                  <MessageBlock
                    key={turn.id}
                    currentUserId={AUTOMATION_USER_ID}
                    loadAttachmentContent={loadAttachmentContent}
                    message={turn}
                    onAnswerElicitation={turn.messageType === 'elicitation' && turn.elicitation?.status === 'open'
                      ? (_elicitationId, answer) => answerElicitationOptimistically({
                          answer,
                          elicitationId: turn.elicitation!.id,
                          previousMessage: turn,
                          submit: () => submitAsync(
                            answer == null ? 'Skip' : Array.isArray(answer) ? answer.join(', ') : answer,
                            turn.id,
                            {
                              id: turn.elicitation!.id,
                              answer,
                              responseType: turn.elicitation!.responseType === 'text'
                                ? 'free_text'
                                : turn.elicitation!.responseType === 'radio'
                                  ? 'single_select'
                                  : turn.elicitation!.responseType,
                              options: turn.elicitation!.options ?? [],
                              allowOther: turn.elicitation!.allowOther ?? false,
                              presentedAt: turn.elicitation!.createdAt ?? turn.createdAt,
                            },
                          ),
                          updateMessages: (update) => setTurns(update),
                        })
                      : async () => undefined}
                    onOpenAttachment={setAttachmentPreview}
                    onResolveSuggestion={async () => undefined}
                  />
                ))}
                {(compilePending || (compilerError !== null && streamingText.trim().length > 0)) && (
                  // Trimmed, not just non-empty: an abandoned first turn
                  // resets to '' and a model that opens a narration turn with
                  // a bare newline sends whitespace before it sends a word.
                  // Either would render as Rally having said something blank.
                  streamingText.trim().length > 0
                    ? <MessageBlock
                        currentUserId={AUTOMATION_USER_ID}
                        message={automationTextMessage('automation-streaming', 'agent', streamingText, true)}
                        onAnswerElicitation={async () => undefined}
                        onResolveSuggestion={async () => undefined}
                      />
                    : turns.some((turn) => turn.messageType === 'thought' && turn.thoughtEvent?.status === 'started')
                      ? null
                      : <AgentWorkTiming
                          active
                          durationMs={0}
                          {...(compile.submittedAt > 0 ? { startedAt: compile.submittedAt } : {})}
                        />
                )}
                {draft && (
                  <DraftSummary
                    connections={connections.data ?? []}
                    creating={create.isPending}
                    activitySourcePluginIds={activitySourcePluginIds}
                    emailDelivery={emailDelivery}
                    ownerEmail={session?.user.email ?? ''}
                    scope={scope}
                    scopeChangeAllowed={scopeChangeAllowed}
                    deliveryConnectionId={deliveryConnectionId}
                    draft={draft}
                    onActivitySourcesChange={setActivitySourcePluginIds}
                    onCreate={() => create.mutate()}
                    onEmailDeliveryChange={setEmailDelivery}
                    onScopeChange={setScopeOverride}
                    onDeliveryConnectionChange={setDeliveryConnectionId}
                  />
                )}
              </div>
            )}

            {!selectedTemplate && (
              <div className="automation-composer-wrap">
                {!transcriptFollow.atEnd && (
                  <JumpToLatestButton onJump={() => transcriptFollow.scrollToEnd({ smooth: true })} />
                )}
                {visibleMentionConnections.length > 0 && (
                  <div className="mention-popover" id="automation-mention-listbox" role="listbox" aria-label="Connections">
                    {visibleMentionConnections.map((connection, index) => (
                      <button
                        aria-selected={index === mentionNavigation.activeIndex}
                        className={index === mentionNavigation.activeIndex ? 'is-selected' : undefined}
                        id={mentionOptionId(connection.id)}
                        key={connection.id}
                        onClick={() => insertConnectionMention(connection)}
                        onMouseMove={() => mentionNavigation.setActiveIndex(index)}
                        ref={index === mentionNavigation.activeIndex ? mentionNavigation.activeOptionRef : undefined}
                        role="option"
                        type="button"
                      >
                        <span className="mention-icon"><AtSign size={14} /></span>
                        <span><strong>{connection.displayName}</strong><small>{connection.scope === 'you' ? 'Your connection' : 'Workspace connection'}</small></span>
                        <Badge>Connection</Badge>
                      </button>
                    ))}
                  </div>
                )}
                <ComposerInput
                  api={api ?? undefined}
                  ariaLabel={draft?.question?.prompt ?? 'Describe an automation'}
                  attachments={attachmentDraft.attachments}
                  className="automation-composer"
                  fileInputRef={fileInputRef}
                  mentionLabel="Mention a connection"
                  mentionLabels={mentionLabels}
                  mentionListbox={visibleMentionConnections.length > 0
                    ? { id: 'automation-mention-listbox', activeOptionId: mentionNavigation.activeOptionId }
                    : undefined}
                  model={{ kind: 'choice', value: modelOverride, onChange: setModelOverride }}
                  onAttach={attachmentDraft.addFiles}
                  onMention={beginConnectionMention}
                  onKeyDown={(event) => {
                    if (mentionNavigation.handleKeyDown(event)) return;
                    if (event.key !== 'Escape' || mentionQuery === null) return;
                    event.preventDefault();
                    setMentionQuery(null);
                  }}
                  onOpenAttachment={setAttachmentPreview}
                  onRemoveAttachment={attachmentDraft.removeAttachment}
                  onRetryAttachment={attachmentDraft.retryAttachment}
                  onSelect={() => refreshOpenMentionQuery(input)}
                  onSubmit={() => submitAsync().catch(() => undefined)}
                  onValueChange={updateInput}
                  placeholder={draft?.question?.placeholder ?? draft?.question?.prompt ?? 'Describe what should happen…'}
                  ref={textareaRef}
                  shouldSubmitOnEnter={() => mentionQuery === null}
                  submitDisabled={attachmentDraft.uploading || (!input.trim() && attachmentDraft.ready.length === 0) || compilePending}
                  submitLabel="Send"
                  submitting={compilePending}
                  uploading={attachmentDraft.uploading}
                  value={input}
                />
                {automationId && compilerRun && ['admitted', 'running'].includes(compilerRun.state) && (
                  <Button
                    className="button-secondary"
                    disabled={stopCompiler.isPending}
                    onClick={() => stopCompiler.mutate()}
                  >
                    Stop
                  </Button>
                )}
                {(compile.error || compilerError || create.error || connections.error || attachmentDraft.error) && (
                  <div className="automation-error-actions">
                    <InlineError>
                      {compile.error?.message ?? compilerError ?? create.error?.message ?? connections.error?.message ?? attachmentDraft.error}
                      {compile.error instanceof ApiError && compile.error.requestId ? ` · Request ${compile.error.requestId}` : ''}
                    </InlineError>
                    {compilerError && automationId && compilerRun && (
                      <Button disabled={retryCompiler.isPending} onClick={() => retryCompiler.mutate()}>Retry</Button>
                    )}
                    {compile.error instanceof ApiError && compile.error.requestId && (() => {
                      const requestId = compile.error.requestId;
                      return <Button onClick={() => void desktopBridge().copyText(requestId)}>Copy request ID</Button>;
                    })()}
                  </div>
                )}
                {draft?.summary && <p className="keep-editing-hint">Keep editing by describing what should change.</p>}
              </div>
            )}
            {selectedTemplate && connections.error && (
              <InlineError>{connections.error.message}</InlineError>
            )}
          </>
        )}
      </div>
      <AttachmentLightbox preview={attachmentPreview} onClose={() => setAttachmentPreview(null)} />
    </div>
  );
}
