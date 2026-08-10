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
import { useNavigate } from 'react-router-dom';
import { AgentWorkTiming } from '../components/agent-work-timing';
import { type AttachmentPreview, AttachmentLightbox } from '../components/attachments';
import { ComposerInput } from '../components/composer-input';
import { MarkdownBody, MessageBlock } from '../components/workstream-blocks';
import { AvalonMark, Badge, Button, EmptyState, IconButton, InlineError } from '../components/primitives';
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
import { desktopBridge } from '../lib/platform';
import { createElicitationMessage, createTextMessage, createToolEventMessage, upsertTranscriptMessage } from '../lib/transcript';
import { useFileAttachments } from '../lib/use-file-attachments';
import type {
  AutomationActivitySource,
  AutomationDraftQuestion,
  AutomationDraftResponse,
  AutomationScope,
  Message,
  MessageAttachment,
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
  templateId?: string;
  turnId: string;
  elicitation?: { id: string; answer: ElicitationAnswer };
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

function AutomationMessageBlock({
  loadAttachmentContent,
  message,
  onAnswerElicitation,
  onOpenAttachment,
}: {
  loadAttachmentContent?: (id: string, signal?: AbortSignal) => Promise<Blob>;
  message: Message;
  onAnswerElicitation?: (answer: string | string[] | null) => Promise<void>;
  onOpenAttachment?: (preview: AttachmentPreview) => void;
}): React.JSX.Element {
  return (
    <MessageBlock
      currentUserId={AUTOMATION_USER_ID}
      loadAttachmentContent={loadAttachmentContent}
      message={message}
      onAnswerElicitation={(_elicitationId, answer) => onAnswerElicitation?.(answer) ?? Promise.resolve()}
      onResolveSuggestion={() => Promise.resolve()}
      onOpenAttachment={onOpenAttachment}
    />
  );
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
          <dt><Users size={13} /> <label htmlFor="automation-scope">Runs as</label></dt>
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
          <div><strong>Deliver results</strong><small>{summary.requiresSlackDelivery ? 'This draft mentions Slack delivery. ' : ''}Every destination is frozen when this automation is saved.</small></div>
        </header>
        <ul>
          <DeliveryChoice
            checked
            description="Every run is saved to its own Avalon work stream."
            icon={<AvalonMark />}
            label="Avalon"
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
        <span>Avalon preloads the plugins this draft needs, and never widens their runtime authority.</span>
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

export function NewAutomationScreen(): React.JSX.Element {
  const { api, session } = useAppSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState('');
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<AttachmentPreview | null>(null);
  const [draft, setDraft] = useState<AutomationDraftResponse | null>(null);
  const [turns, setTurns] = useState<Message[]>([]);
  const [streamingAssistant, setStreamingAssistant] = useState<{ hasText: boolean; text: string }>({
    hasText: false,
    text: '',
  });
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [defaultPluginIds, setDefaultPluginIds] = useState<string[]>([]);
  const [activitySourcePluginIds, setActivitySourcePluginIds] = useState<Record<string, string>>({});
  const [scopeOverride, setScopeOverride] = useState<AutomationScope | null>(null);
  const [emailDelivery, setEmailDelivery] = useState(false);
  const [deliveryConnectionId, setDeliveryConnectionId] = useState('');
  const [initializedRecommendations, setInitializedRecommendations] = useState('');
  const [initializedActivitySources, setInitializedActivitySources] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<WorkspaceTemplate | null>(null);
  const attachmentDraft = useFileAttachments(api);

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: ({ signal }) => api!.getConnections(signal),
    enabled: Boolean(api),
    staleTime: 10_000,
  });
  const visibleMentionConnections = mentionQuery === null
    ? []
    : (connections.data ?? [])
      .filter((connection) => connection.displayName.toLowerCase().includes(mentionQuery.toLowerCase()))
      .slice(0, 8);
  const mentionLabels = useMemo(
    () => (connections.data ?? []).map((connection) => connection.displayName),
    [connections.data],
  );
  const loadAttachmentContent = useCallback(
    (resourceId: string, signal?: AbortSignal) => api!.getResourceContent(resourceId, signal),
    [api],
  );

  const updateInput = (value: string): void => {
    setInput(value);
    setMentionQuery(value.match(/(?:^|\s)@([^\s@]*)$/u)?.[1] ?? null);
  };

  const beginConnectionMention = (): void => {
    setInput((current) => current.length === 0 || /\s$/u.test(current) ? `${current}@` : `${current} @`);
    setMentionQuery('');
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      textarea?.focus();
      textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    });
  };

  const insertConnectionMention = (connection: WorkstreamConnection): void => {
    const atIndex = input.lastIndexOf('@');
    setInput(`${input.slice(0, atIndex)}@${connection.displayName} `);
    setMentionQuery(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  // Avalon's suggestion is the default; the creator can still redirect the
  // automation, and only an administrator may make it a workspace automation.
  const scopeChangeAllowed = session?.workspace?.role === 'owner' || session?.workspace?.role === 'admin';
  const scope: AutomationScope = scopeOverride ?? draft?.summary?.scope ?? 'you';

  // Keyed on the scope in force, not the one Avalon suggested: a workspace
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
  useEffect(() => {
    setDeliveryConnectionId('');
    setEmailDelivery(false);
  }, [deliveryDraftKey]);

  useEffect(() => {
    if (scope !== 'you') setEmailDelivery(false);
  }, [scope]);

  useEffect(() => {
    if (!deliveryConnectionId) return;
    const stillAvailable = (connections.data ?? []).some((connection) =>
      connection.id === deliveryConnectionId && connection.userDelivery);
    if (!stillAvailable || scope !== 'you') setDeliveryConnectionId('');
  }, [connections.data, scope, deliveryConnectionId]);

  const compile = useMutation({
    mutationFn: (payload: AutomationCompilePayload) =>
      api!.compileAutomation({
        message: payload.message,
        ...(draft?.draftId ? { draftId: draft.draftId } : {}),
        ...(payload.templateId ? { templateId: payload.templateId } : {}),
        ...(payload.attachmentIds.length > 0 ? { attachmentIds: payload.attachmentIds } : {}),
      }, (event) => {
        if (event.type === 'started') {
          setStreamingAssistant({ hasText: false, text: '' });
          return;
        }
        if (event.type === 'thinking') {
          const thoughtId = `${payload.turnId}-thought`;
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
                // Provider completions pause the model clock, but the row
                // remains active until this entire automation turn settles.
                status: 'started',
                durationMs: event.durationMs,
                ...(event.status === 'started' ? { startedAt: Date.now() } : {}),
              },
            };
            if (existing < 0) return [...current, thoughtMessage];
            if (event.status === 'started') {
              return [...current.filter((_, index) => index !== existing), thoughtMessage];
            }
            return current.map((message, index) => index === existing ? thoughtMessage : message);
          });
          return;
        }
        if (event.type === 'tool') {
          setTurns((current) => {
            const existing = current.findIndex((message) => message.id === event.toolCallId);
            const previous = existing >= 0 ? current[existing] : undefined;
            const toolMessage = createToolEventMessage({
              id: event.toolCallId,
              workstreamId: AUTOMATION_CHAT_ID,
              sequenceNumber: previous?.sequenceNumber ?? current.length,
              authorType: 'agent',
              createdAt: previous?.createdAt ?? new Date().toISOString(),
              toolEvent: {
                id: event.toolCallId,
                name: event.name,
                summary: event.summary,
                status: event.status,
                plugins: event.plugins,
                ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
              },
            });
            return upsertTranscriptMessage(current, toolMessage);
          });
          return;
        }
        setStreamingAssistant((current) => ({
          hasText: true,
          text: event.reset ? event.delta : current.text + event.delta,
        }));
      }),
    onMutate: (payload) => {
      setStreamingAssistant({ hasText: false, text: '' });
      setTurns((current) => {
        const updated = payload.elicitation
          ? resolveElicitationMessages(current, payload.elicitation.id, payload.elicitation.answer)
          : current;
        return updated.some((turn) => turn.id === payload.turnId)
          ? updated
          : [...updated, automationTextMessage(payload.turnId, 'human', payload.message, false, payload.attachments)];
      });
      setInput('');
      setMentionQuery(null);
    },
    onSuccess: (response, payload) => {
      attachmentDraft.consume(payload.attachmentLocalIds);
      setStreamingAssistant({ hasText: false, text: '' });
      setDraft(response);
      const responseMessage = response.question
        ? automationQuestionMessage(response.assistantMessage, response.question)
        : response.assistantMessage
          ? automationTextMessage(crypto.randomUUID(), 'agent', response.assistantMessage)
          : null;
      setTurns((current) => {
        const settled = settleThought(current, `${payload.turnId}-thought`);
        if (!responseMessage || settled.some((message) => message.id === responseMessage.id)) return settled;
        return [...settled, responseMessage];
      });
    },
    onError: (_error, payload) => {
      setStreamingAssistant({ hasText: false, text: '' });
      setTurns((current) => settleThought(current, `${payload.turnId}-thought`));
    },
  });

  const deliveryConnection = (connections.data ?? []).find((connection) =>
    connection.id === deliveryConnectionId && connection.userDelivery);

  const create = useMutation({
    mutationFn: () => api!.createAutomation(draft!.draftId, defaultPluginIds, activitySourcePluginIds, {
      scope,
      delivery: {
        ...(deliveryConnection
          ? { connection: { id: deliveryConnection.id, targetType: deliveryConnection.userDelivery!.targetType } }
          : {}),
        ...(emailDelivery ? { email: true } : {}),
      },
    }),
    onSuccess: (automation) => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
      void navigate(`/automations/${automation.id}`);
    },
  });

  const subscribe = useMutation({
    mutationFn: () => api!.subscribeTemplate(selectedTemplate!.id, defaultPluginIds, activitySourcePluginIds),
    onSuccess: (automation) => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
      void navigate(`/automations/${automation.id}`);
    },
  });

  const submitAsync = async (
    message = input,
    turnId: string = crypto.randomUUID(),
    elicitation?: AutomationCompilePayload['elicitation'],
  ): Promise<void> => {
    const readyAttachments = attachmentDraft.ready;
    const trimmed = message.trim();
    if ((!trimmed && readyAttachments.length === 0) || attachmentDraft.uploading || compile.isPending) return;
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
      turnId,
      ...(elicitation ? { elicitation } : {}),
    });
  };

  const submit = (message = input): void => {
    void submitAsync(message).catch(() => undefined);
  };

  const draftId = draft?.draftId;

  return (
    <div className="new-automation-screen screen-with-titlebar">
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
                  if (draftId) void desktopBridge().copyText(draftId);
                }}
              >
                <Info size={14} /> Copy draft ID
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <div className={clsx('automation-builder', (turns.length > 0 || draft) && 'has-conversation')}>
        {templatesOpen ? (
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
                  disabled={subscribe.isPending || selectedTemplate.activitySources.some((source) => !activitySourcePluginIds[source.bindingKey])}
                  onClick={() => subscribe.mutate()}
                >
                  {subscribe.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Use template
                </Button>
              </section>
            ) : turns.length === 0 && !draft ? (
              <section className="automation-builder-intro" aria-labelledby="automation-builder-heading">
                <AvalonMark />
                <p className="eyebrow">Create an automation</p>
                <h1 id="automation-builder-heading">What should happen automatically?</h1>
                <p>Describe the outcome. Avalon can research your plugins and will ask for the details it needs.</p>
                <AutomationSuggestedPrompts onSelect={submit} />
                <button className="template-path" onClick={() => setTemplatesOpen(true)} type="button">Use a workspace template <ChevronRight size={13} /></button>
              </section>
            ) : (
              <div className="automation-chat-surface automation-conversation" aria-live="polite">
                {turns.map((turn) => (
                  <AutomationMessageBlock
                    key={turn.id}
                    loadAttachmentContent={loadAttachmentContent}
                    message={turn}
                    onAnswerElicitation={turn.messageType === 'elicitation' && turn.elicitation?.status === 'open'
                      ? (answer) => answerElicitationOptimistically({
                          answer,
                          elicitationId: turn.elicitation!.id,
                          previousMessage: turn,
                          submit: () => submitAsync(
                            answer == null ? 'Skip' : Array.isArray(answer) ? answer.join(', ') : answer,
                            turn.id,
                            { id: turn.elicitation!.id, answer },
                          ),
                          updateMessages: (update) => setTurns(update),
                        })
                      : undefined}
                    onOpenAttachment={setAttachmentPreview}
                  />
                ))}
                {compile.isPending && (
                  streamingAssistant.hasText
                    ? <AutomationMessageBlock message={automationTextMessage('automation-streaming', 'agent', streamingAssistant.text, true)} />
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
                {visibleMentionConnections.length > 0 && (
                  <div className="mention-popover" role="listbox" aria-label="Connections">
                    {visibleMentionConnections.map((connection) => (
                      <button key={connection.id} onClick={() => insertConnectionMention(connection)} role="option" type="button">
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
                  onAttach={attachmentDraft.addFiles}
                  onMention={beginConnectionMention}
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape' || mentionQuery === null) return;
                    event.preventDefault();
                    setMentionQuery(null);
                  }}
                  onOpenAttachment={setAttachmentPreview}
                  onRemoveAttachment={attachmentDraft.removeAttachment}
                  onRetryAttachment={attachmentDraft.retryAttachment}
                  onSubmit={() => submitAsync().catch(() => undefined)}
                  onValueChange={updateInput}
                  placeholder={draft?.question?.placeholder ?? draft?.question?.prompt ?? 'Describe what should happen…'}
                  ref={textareaRef}
                  shouldSubmitOnEnter={() => mentionQuery === null}
                  submitDisabled={attachmentDraft.uploading || (!input.trim() && attachmentDraft.ready.length === 0) || compile.isPending}
                  submitLabel="Send"
                  submitting={compile.isPending}
                  uploading={attachmentDraft.uploading}
                  value={input}
                />
                {(compile.error || create.error || connections.error || attachmentDraft.error) && (
                  <div className="automation-error-actions">
                    <InlineError>
                      {compile.error?.message ?? create.error?.message ?? connections.error?.message ?? attachmentDraft.error}
                      {compile.error instanceof ApiError && compile.error.requestId ? ` · Request ${compile.error.requestId}` : ''}
                    </InlineError>
                    {compile.error && compile.variables?.message && <Button onClick={() => compile.mutate(compile.variables!)}>Retry</Button>}
                    {compile.error instanceof ApiError && compile.error.requestId && (() => {
                      const requestId = compile.error.requestId;
                      return <Button onClick={() => void desktopBridge().copyText(requestId)}>Copy request ID</Button>;
                    })()}
                  </div>
                )}
                {draft?.summary && <p className="keep-editing-hint">Keep editing by describing what should change.</p>}
              </div>
            )}
            {selectedTemplate && (subscribe.error || connections.error) && (
              <InlineError>{subscribe.error?.message ?? connections.error?.message}</InlineError>
            )}
          </>
        )}
      </div>
      <AttachmentLightbox preview={attachmentPreview} onClose={() => setAttachmentPreview(null)} />
    </div>
  );
}
