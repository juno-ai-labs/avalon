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
import { MarkdownBody } from '../components/workstream-blocks';
import { AvalonMark, Badge, Button, EmptyState, InlineError } from '../components/primitives';
import { useAppSession } from '../lib/app-session';
import { ApiError } from '../lib/api';
import { desktopBridge } from '../lib/platform';
import type {
  AutomationDraftQuestion,
  AutomationDraftResponse,
  WorkspaceTemplate,
  WorkstreamConnection,
} from '../lib/types';

interface DraftTurn {
  id: string;
  role: 'user' | 'assistant';
  text: string;
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

function DraftQuestion({
  question,
  submitting,
  onSubmit,
}: {
  question: AutomationDraftQuestion;
  submitting: boolean;
  onSubmit: (answer: string) => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState('');
  useEffect(() => { setSelected([]); setOther(''); }, [question.id]);
  if (question.responseType === 'free_text') return <></>;
  const options = question.options ?? [];
  const minimum = question.minimumSelections ?? 1;
  const maximum = question.maximumSelections ?? (question.responseType === 'single_select' ? 1 : options.length + 1);
  const toggle = (value: string): void => {
    if (question.responseType === 'single_select') {
      setSelected([value]);
      return;
    }
    setSelected((current) => current.includes(value)
      ? current.filter((candidate) => candidate !== value)
      : current.length < maximum ? [...current, value] : current);
  };
  const answerValues = [...selected, ...(other.trim() ? [other.trim()] : [])];
  return (
    <section className="automation-elicitation" aria-labelledby={`automation-question-${question.id}`}>
      <header><small>Avalon needs input</small><h3 id={`automation-question-${question.id}`}>{question.prompt}</h3></header>
      <div className="automation-elicitation-options">
        {options.map((option) => {
          const active = selected.includes(option.value);
          return (
            <button className={clsx(active && 'selected')} key={option.value} onClick={() => toggle(option.value)} type="button">
              <span className="automation-option-check">{active && <Check size={12} />}</span>
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
            </button>
          );
        })}
      </div>
      {question.allowOther && (
        <input onChange={(event) => setOther(event.target.value)} placeholder="Other…" value={other} />
      )}
      <footer>
        <span>{question.responseType === 'multi_select' ? `Choose ${minimum}${maximum < options.length + 1 ? `–${maximum}` : ' or more'}` : 'Choose one'}</span>
        <Button
          className="button-primary"
          disabled={submitting || answerValues.length < minimum || answerValues.length > maximum}
          onClick={() => onSubmit(answerValues.length === 1 ? answerValues[0]! : answerValues.join(', '))}
        >
          {submitting ? <LoaderCircle className="spin" size={14} /> : <ArrowUp size={14} />} Continue
        </Button>
      </footer>
    </section>
  );
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
  const [turns, setTurns] = useState<DraftTurn[]>([]);
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
    mutationFn: (payload: { message: string; templateId?: string; turnId: string }) =>
      api!.compileAutomation({
        message: payload.message,
        ...(draft?.draftId ? { draftId: draft.draftId } : {}),
        ...(payload.templateId ? { templateId: payload.templateId } : {}),
      }),
    onMutate: (payload) => {
      setTurns((current) => current.some((turn) => turn.id === payload.turnId)
        ? current
        : [...current, { id: payload.turnId, role: 'user', text: payload.message }]);
      setInput('');
    },
    onSuccess: (response) => {
      setDraft(response);
      if (!response.question && response.assistantMessage) {
        setTurns((current) => [...current, { id: crypto.randomUUID(), role: 'assistant', text: response.assistantMessage! }]);
      }
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

  const submit = (message = input): void => {
    const trimmed = message.trim();
    if (!trimmed || compile.isPending) return;
    compile.mutate({ message: trimmed, turnId: crypto.randomUUID() });
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
              <div className="automation-conversation" aria-live="polite">
                {turns.map((turn) => (
                  <div className={clsx('draft-turn', `draft-${turn.role}`)} key={turn.id}>
                    <span>{turn.role === 'assistant' ? 'Avalon' : 'You'}</span>
                    <MarkdownBody>{turn.text}</MarkdownBody>
                  </div>
                ))}
                {compile.isPending && <div className="draft-turn draft-assistant"><span>Avalon</span><p className="thinking-line"><LoaderCircle className="spin" size={14} /> Researching and refining the automation…</p></div>}
                {draft?.question && (
                  <DraftQuestion question={draft.question} submitting={compile.isPending} onSubmit={submit} />
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
