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
import { useAppSession } from '../lib/app-session';
import { ApiError } from '../lib/api';
import { desktopBridge } from '../lib/platform';
import type { AutomationDraftResponse, WorkspaceTemplate, WorkstreamConnection } from '../lib/types';
import { AvalonMark, Badge, Button, EmptyState, InlineError } from '../components/primitives';

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
        <div><h2>Workspace templates</h2><p>Install a coworker’s recipe with your own connection permissions.</p></div>
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

type ConnectableProvider = 'google' | 'github' | 'linear' | 'notion';

const capabilityProviders: Array<{ provider: ConnectableProvider; label: string; prefixes: string[] }> = [
  { provider: 'google', label: 'Google', prefixes: ['gmail.', 'calendar.', 'drive.', 'docs.', 'sheets.'] },
  { provider: 'github', label: 'GitHub', prefixes: ['github.'] },
  { provider: 'linear', label: 'Linear', prefixes: ['linear.'] },
  { provider: 'notion', label: 'Notion', prefixes: ['notion.'] },
];

function providerForCapability(capability: string): ConnectableProvider | null {
  return capabilityProviders.find((candidate) => candidate.prefixes.some((prefix) => capability.startsWith(prefix)))?.provider ?? null;
}

function missingByProvider(capabilities: string[], bindings: Record<string, string>): Array<{ provider: ConnectableProvider; label: string; capabilities: string[] }> {
  return capabilityProviders.map((candidate) => ({
    provider: candidate.provider,
    label: candidate.label,
    capabilities: capabilities.filter((capability) => !bindings[capability] && providerForCapability(capability) === candidate.provider),
  })).filter((candidate) => candidate.capabilities.length > 0);
}

function DraftSummary({
  draft,
  creating,
  connecting,
  connections,
  bindings,
  onBindingChange,
  onConnectProvider,
  onCreate,
}: {
  draft: AutomationDraftResponse;
  creating: boolean;
  connecting: boolean;
  connections: WorkstreamConnection[];
  bindings: Record<string, string>;
  onBindingChange: (capability: string, connectionId: string) => void;
  onConnectProvider: (provider: ConnectableProvider, capabilities: string[]) => void;
  onCreate: () => void;
}): React.JSX.Element | null {
  if (!draft.summary) return null;
  const summary = draft.summary;
  const missingCapabilities = summary.capabilities.filter((capability) => !bindings[capability]);
  const missingProviders = missingByProvider(summary.capabilities, bindings);
  return (
    <section className="automation-summary-card" aria-labelledby="automation-summary-title">
      <header>
        <span><WandSparkles size={17} /></span>
        <div><small>Ready to create</small><h2 id="automation-summary-title">{summary.name}</h2><p>{summary.description}</p></div>
      </header>
      <ol className="automation-steps">
        {summary.steps.map((step, index) => <li key={`${index}-${step}`}><span>{index + 1}</span><p>{step}</p></li>)}
      </ol>
      <dl className="automation-summary-meta">
        <div><dt><Users size={13} /> Runs as</dt><dd>{summary.scope === 'you' ? 'You' : 'Workspace'}</dd></div>
        <div><dt><CalendarClock size={13} /> Trigger</dt><dd>{summary.triggerSummary}</dd></div>
        <div><dt><Sparkles size={13} /> Uses</dt><dd>{summary.capabilities.join(', ') || 'Avalon tools'}</dd></div>
      </dl>
      {summary.capabilities.length > 0 && (
        <div className="automation-bindings" aria-label="Automation connections">
          <div><strong>Connections</strong><small>Each capability runs only through the connection you select.</small></div>
          {summary.capabilities.map((capability) => {
            const candidates = connections.filter((connection) =>
              connection.status === 'healthy' && connection.capabilities?.includes(capability) &&
              (summary.scope === 'you' || connection.scope === 'workspace'),
            );
            return (
              <label key={capability}>
                <span>{capability}</span>
                <select
                  aria-label={`Connection for ${capability}`}
                  onChange={(event) => onBindingChange(capability, event.target.value)}
                  value={bindings[capability] ?? ''}
                >
                  <option value="">Select a connection</option>
                  {candidates.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.displayName} · {connection.scope === 'you' ? 'You' : 'Workspace'}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
          {missingProviders.map((provider) => (
            <Button disabled={connecting} key={provider.provider} onClick={() => onConnectProvider(provider.provider, provider.capabilities)}>
              {connecting ? <LoaderCircle className="spin" size={14} /> : <Zap size={14} />}
              Connect {provider.label}
            </Button>
          ))}
          {missingCapabilities.some((capability) => providerForCapability(capability) === null) && (
            <InlineError>Connect the required provider before creating this automation.</InlineError>
          )}
        </div>
      )}
      <footer>
        <span>External actions are recorded in the resulting work stream.</span>
        <Button className="button-primary" disabled={creating || missingCapabilities.length > 0} onClick={onCreate}>
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
  const [bindings, setBindings] = useState<Record<string, string>>({});
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

  const connectProvider = useMutation({
    mutationFn: async (input: { provider: ConnectableProvider; capabilities: string[] }) => {
      const requestedScope = draft?.summary?.scope ?? 'you';
      const scope = input.provider === 'notion' ? 'you' : requestedScope;
      const url = await api!.startProviderConnection(input.provider, scope, input.capabilities);
      await desktopBridge().openExternal(url);
    },
  });

  useEffect(() => {
    const capabilities = draft?.summary?.capabilities ?? selectedTemplate?.capabilities;
    const scope = draft?.summary?.scope ?? 'you';
    if (!capabilities || !connections.data) return;
    setBindings((current) => {
      const next: Record<string, string> = {};
      for (const capability of capabilities) {
        const candidates = connections.data.filter((connection) =>
          connection.status === 'healthy' && connection.capabilities?.includes(capability) &&
          (scope === 'you' || connection.scope === 'workspace'),
        );
        if (current[capability] && candidates.some((connection) => connection.id === current[capability])) {
          next[capability] = current[capability];
        } else if (candidates.length === 1) {
          next[capability] = candidates[0]!.id;
        }
      }
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [connections.data, draft, selectedTemplate]);

  const compile = useMutation({
    mutationFn: (payload: { message: string; templateId?: string }) =>
      api!.compileAutomation({
        message: payload.message,
        ...(draft?.draftId ? { draftId: draft.draftId } : {}),
        ...(payload.templateId ? { templateId: payload.templateId } : {}),
      }),
    onSuccess: (response, payload) => {
      setDraft(response);
      setTurns((current) => [
        ...current,
        { id: crypto.randomUUID(), role: 'user', text: payload.message },
        ...(response.assistantMessage || response.question
          ? [{ id: crypto.randomUUID(), role: 'assistant' as const, text: response.assistantMessage ?? response.question!.prompt }]
          : []),
      ]);
      setInput('');
    },
  });

  const create = useMutation({
    mutationFn: () => api!.createAutomation(draft!.draftId, bindings),
    onSuccess: (automation) => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
      void navigate(`/automations/${automation.id}`);
    },
  });

  const subscribe = useMutation({
    mutationFn: () => api!.subscribeTemplate(selectedTemplate!.id, bindings),
    onSuccess: (automation) => {
      void queryClient.invalidateQueries({ queryKey: ['automations'] });
      void navigate(`/automations/${automation.id}`);
    },
  });

  const submit = (message = input): void => {
    const trimmed = message.trim();
    if (!trimmed || compile.isPending) return;
    compile.mutate({ message: trimmed });
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
              setBindings({});
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
                <div className="automation-bindings" aria-label="Template connections">
                  {selectedTemplate.capabilities.map((capability) => {
                    const candidates = (connections.data ?? []).filter((connection) =>
                      connection.status === 'healthy' && connection.capabilities?.includes(capability),
                    );
                    return (
                      <label key={capability}>
                        <span>{capability}</span>
                        <select
                          aria-label={`Connection for ${capability}`}
                          onChange={(event) => setBindings((current) => {
                            const next = { ...current };
                            if (event.target.value) next[capability] = event.target.value;
                            else delete next[capability];
                            return next;
                          })}
                          value={bindings[capability] ?? ''}
                        >
                          <option value="">Select a connection</option>
                          {candidates.map((connection) => <option key={connection.id} value={connection.id}>{connection.displayName} · {connection.scope === 'you' ? 'You' : 'Workspace'}</option>)}
                        </select>
                      </label>
                    );
                  })}
                  {missingByProvider(selectedTemplate.capabilities, bindings).map((provider) => (
                    <Button disabled={connectProvider.isPending} key={provider.provider} onClick={() => connectProvider.mutate({ provider: provider.provider, capabilities: provider.capabilities })}>
                      {connectProvider.isPending ? <LoaderCircle className="spin" size={14} /> : <Zap size={14} />} Connect {provider.label}
                    </Button>
                  ))}
                </div>
                <Button
                  className="button-primary"
                  disabled={subscribe.isPending || selectedTemplate.capabilities.some((capability) => !bindings[capability])}
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
                <p>Describe the outcome. Avalon will ask only for the details it needs.</p>
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
                    <p>{turn.text}</p>
                  </div>
                ))}
                {compile.isPending && <div className="draft-turn draft-assistant"><span>Avalon</span><p className="thinking-line"><LoaderCircle className="spin" size={14} /> Compiling the automation…</p></div>}
                {draft && (
                  <DraftSummary
                    bindings={bindings}
                    connecting={connectProvider.isPending}
                    connections={connections.data ?? []}
                    creating={create.isPending}
                    draft={draft}
                    onBindingChange={(capability, connectionId) => setBindings((current) => ({ ...current, [capability]: connectionId }))}
                    onConnectProvider={(provider, capabilities) => connectProvider.mutate({ provider, capabilities })}
                    onCreate={() => create.mutate()}
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
                {(compile.error || create.error || connectProvider.error || connections.error) && (
                  <div className="automation-error-actions">
                    <InlineError>
                      {compile.error?.message ?? create.error?.message ?? connectProvider.error?.message ?? connections.error?.message}
                      {compile.error instanceof ApiError && compile.error.requestId ? ` · Request ${compile.error.requestId}` : ''}
                    </InlineError>
                    {compile.error && compile.variables?.message && (
                      <Button onClick={() => compile.mutate(compile.variables!)}>Retry</Button>
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
            {selectedTemplate && (subscribe.error || connectProvider.error || connections.error) && (
              <InlineError>{subscribe.error?.message ?? connectProvider.error?.message ?? connections.error?.message}</InlineError>
            )}
          </>
        )}
      </div>
    </div>
  );
}
