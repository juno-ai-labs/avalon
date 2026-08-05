import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  ArrowLeft,
  ArrowUp,
  CalendarClock,
  Check,
  ChevronRight,
  Clock3,
  LoaderCircle,
  Sparkles,
  Users,
  WandSparkles,
  Zap,
} from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MarkdownBody, MessageBlock } from '../components/workstream-blocks';
import { AvalonMark, Badge, Button, EmptyState, InlineError } from '../components/primitives';
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
import type {
  AutomationDraftQuestion,
  AutomationDraftResponse,
  Message,
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
): Message {
  return createTextMessage({
    id,
    workstreamId: AUTOMATION_CHAT_ID,
    sequenceNumber: 0,
    authorType,
    ...(authorType === 'human' ? { author: AUTOMATION_USER } : {}),
    text,
    createdAt: new Date().toISOString(),
    ...(streaming ? { streaming: true } : {}),
  });
}

function AutomationMessageBlock({
  message,
  onAnswerElicitation,
}: {
  message: Message;
  onAnswerElicitation?: (answer: string | string[] | null) => Promise<void>;
}): React.JSX.Element {
  return (
    <MessageBlock
      currentUserId={AUTOMATION_USER_ID}
      message={message}
      onAnswerElicitation={(_elicitationId, answer) => onAnswerElicitation?.(answer) ?? Promise.resolve()}
      onResolveSuggestion={() => Promise.resolve()}
    />
  );
}

const examples = [
  'Check this blog every 24 hours for a new post.',
  'When a candidate call ends, prepare the follow-up email.',
  'Every Friday, prepare a changelog from merged work.',
  'When this error appears in the logs, open an investigation.',
];

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

function DraftSummary({
  draft,
  creating,
  connections,
  defaultPluginIds,
  onDefaultPluginsChange,
  onCreate,
}: {
  draft: AutomationDraftResponse;
  creating: boolean;
  connections: WorkstreamConnection[];
  defaultPluginIds: string[];
  onDefaultPluginsChange: (pluginIds: string[]) => void;
  onCreate: () => void;
}): React.JSX.Element | null {
  if (!draft.summary) return null;
  const summary = draft.summary;
  const recommendations = summary.recommendedPlugins ?? [];
  return (
    <section className="automation-summary-card" aria-labelledby="automation-summary-title">
      <header>
        <span><WandSparkles size={17} /></span>
        <div><small>Ready to create</small><h2 id="automation-summary-title">{summary.name}</h2><p>{summary.description}</p></div>
      </header>
      <div className="automation-overview"><MarkdownBody>{summary.overview || summary.description}</MarkdownBody></div>
      <dl className="automation-summary-meta">
        <div><dt><Users size={13} /> Runs as</dt><dd>{summary.scope === 'you' ? 'You' : 'Workspace'}</dd></div>
        <div><dt><CalendarClock size={13} /> Trigger</dt><dd>{summary.triggerSummary}</dd></div>
        <div><dt><Sparkles size={13} /> Runtime</dt><dd>Dynamic plugin discovery</dd></div>
      </dl>
      <PluginDefaults
        connections={connections}
        onChange={onDefaultPluginsChange}
        recommendations={recommendations}
        scope={summary.scope}
        selected={defaultPluginIds}
      />
      <footer>
        <span>Plugin defaults improve startup speed but never widen runtime authority.</span>
        <Button className="button-primary" disabled={creating} onClick={onCreate}>
          {creating ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Create automation
        </Button>
      </footer>
    </section>
  );
}

export function NewAutomationScreen(): React.JSX.Element {
  const { api } = useAppSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState<AutomationDraftResponse | null>(null);
  const [turns, setTurns] = useState<Message[]>([]);
  const [streamingAssistant, setStreamingAssistant] = useState<{ hasText: boolean; text: string }>({
    hasText: false,
    text: '',
  });
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [defaultPluginIds, setDefaultPluginIds] = useState<string[]>([]);
  const [initializedRecommendations, setInitializedRecommendations] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<WorkspaceTemplate | null>(null);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    if (input) textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [input]);

  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: ({ signal }) => api!.getConnections(signal),
    enabled: Boolean(api),
    staleTime: 10_000,
  });

  useEffect(() => {
    const summary = draft?.summary;
    if (!summary || !connections.data) return;
    const recommendations = summary.recommendedPlugins ?? [];
    const key = `${draft.draftId}:${recommendations.map((item) => item.pluginId).join(',')}`;
    if (key === initializedRecommendations) return;
    const eligible = new Set(eligiblePlugins(connections.data, summary.scope).map((connection) => connection.modelPluginId));
    setDefaultPluginIds(recommendations.map((item) => item.pluginId).filter((pluginId) => eligible.has(pluginId)));
    setInitializedRecommendations(key);
  }, [connections.data, draft, initializedRecommendations]);

  const compile = useMutation({
    mutationFn: (payload: AutomationCompilePayload) =>
      api!.compileAutomation({
        message: payload.message,
        ...(draft?.draftId ? { draftId: draft.draftId } : {}),
        ...(payload.templateId ? { templateId: payload.templateId } : {}),
      }, (event) => {
        if (event.type === 'started') {
          setStreamingAssistant({ hasText: false, text: '' });
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
          : [...updated, automationTextMessage(payload.turnId, 'human', payload.message)];
      });
      setInput('');
    },
    onSuccess: (response) => {
      setStreamingAssistant({ hasText: false, text: '' });
      setDraft(response);
      const responseMessage = response.question
        ? automationQuestionMessage(response.assistantMessage, response.question)
        : response.assistantMessage
          ? automationTextMessage(crypto.randomUUID(), 'agent', response.assistantMessage)
          : null;
      if (responseMessage) setTurns((current) => current.some((message) => message.id === responseMessage.id)
        ? current
        : [...current, responseMessage]);
    },
    onError: () => {
      setStreamingAssistant({ hasText: false, text: '' });
    },
  });

  const create = useMutation({
    mutationFn: () => api!.createAutomation(draft!.draftId, defaultPluginIds),
    onSuccess: (automation) => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
      void navigate(`/automations/${automation.id}`);
    },
  });

  const subscribe = useMutation({
    mutationFn: () => api!.subscribeTemplate(selectedTemplate!.id, defaultPluginIds),
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
    const trimmed = message.trim();
    if (!trimmed || compile.isPending) return;
    await compile.mutateAsync({ message: trimmed, turnId, ...(elicitation ? { elicitation } : {}) });
  };

  const submit = (message = input): void => {
    void submitAsync(message).catch(() => undefined);
  };

  return (
    <div className="new-automation-screen screen-with-titlebar">
      <div className="screen-drag-strip window-drag" />
      <div className={clsx('automation-builder', (turns.length > 0 || draft) && 'has-conversation')}>
        {templatesOpen ? (
          <TemplateBrowser
            onBack={() => setTemplatesOpen(false)}
            onSelect={(template) => {
              setTemplatesOpen(false);
              setDefaultPluginIds([]);
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
                <Button className="button-primary" disabled={subscribe.isPending} onClick={() => subscribe.mutate()}>
                  {subscribe.isPending ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Use template
                </Button>
              </section>
            ) : turns.length === 0 && !draft ? (
              <section className="automation-builder-intro" aria-labelledby="automation-builder-heading">
                <AvalonMark />
                <p className="eyebrow">Create an automation</p>
                <h1 id="automation-builder-heading">What should happen automatically?</h1>
                <p>Describe the outcome. Avalon can research your plugins and will ask for the details it needs.</p>
                <div className="automation-examples">
                  {examples.map((example) => <button key={example} onClick={() => submit(example)} type="button"><Clock3 size={13} /><span>{example}</span><ChevronRight size={13} /></button>)}
                </div>
                <button className="template-path" onClick={() => setTemplatesOpen(true)} type="button">Use a workspace template <ChevronRight size={13} /></button>
              </section>
            ) : (
              <div className="automation-chat-surface automation-conversation" aria-live="polite">
                {turns.map((turn) => (
                  <AutomationMessageBlock
                    key={turn.id}
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
                  />
                ))}
                {compile.isPending && (
                  streamingAssistant.hasText
                    ? <AutomationMessageBlock message={automationTextMessage('automation-streaming', 'agent', streamingAssistant.text, true)} />
                    : <div aria-live="polite" className="agent-thinking" role="status"><span className="thinking-mark" /><span>Avalon is working</span><span className="thinking-dots">…</span></div>
                )}
                {draft && (
                  <DraftSummary
                    connections={connections.data ?? []}
                    creating={create.isPending}
                    defaultPluginIds={defaultPluginIds}
                    draft={draft}
                    onCreate={() => create.mutate()}
                    onDefaultPluginsChange={setDefaultPluginIds}
                  />
                )}
              </div>
            )}

            {!selectedTemplate && (
              <div className="automation-composer-wrap">
                <div className="automation-composer">
                  <textarea
                    aria-label={draft?.question?.prompt ?? 'Describe an automation'}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        submit();
                      }
                    }}
                    placeholder={draft?.question?.placeholder ?? draft?.question?.prompt ?? 'Describe what should happen…'}
                    ref={textareaRef}
                    rows={1}
                    value={input}
                  />
                  <button aria-label="Send" disabled={!input.trim() || compile.isPending} onClick={() => submit()} type="button">
                    {compile.isPending ? <LoaderCircle className="spin" size={15} /> : <ArrowUp size={15} />}
                  </button>
                </div>
                {(compile.error || create.error || connections.error) && (
                  <div className="automation-error-actions">
                    <InlineError>
                      {compile.error?.message ?? create.error?.message ?? connections.error?.message}
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
    </div>
  );
}
