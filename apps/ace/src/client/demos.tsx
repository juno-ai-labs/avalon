import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DemoOperationListSchema,
  DemoOperationStatusSchema,
  DemoTemplateSchema,
  type DemoOperationPhaseStatus,
  type DemoOperationStatus,
  type DemoPreparationPhase,
  type DemoTemplate,
} from '@rally/contracts';
import { z } from 'zod';
import { Button, EmptyState, Field } from './components/ui';

/**
 * The Demos page: every preparation the operator started, what phase each is
 * in, and one form to start another.
 *
 * Everything shown is read from the regional API through Ace's own routes and
 * nothing is inferred locally: a phase is what its receipt says, "Waiting for
 * workspace" lists the gaps the readiness check named, and Failed shows the
 * phase, the reason and the operation id the operator can quote. There is no
 * estimated time and no percentage, because neither is known. While anything
 * is running the page re-reads on a cadence; when a read fails, the last known
 * state stays on screen labelled with when it was read, rather than being
 * replaced by a guess. Every response is parsed with the shared contract.
 */

const PHASES: readonly { phase: DemoPreparationPhase; label: string }[] = [
  { phase: 'checking_template', label: 'Checking template' },
  { phase: 'creating_workspace', label: 'Creating workspace' },
  { phase: 'copying_connections', label: 'Copying connections' },
  { phase: 'seeding_conversations', label: 'Seeding conversations' },
  { phase: 'waiting_for_workspace', label: 'Waiting for workspace' },
];

/** How often a running operation is re-read. A cadence, not a ceiling. */
const RUNNING_POLL_MS = 5_000;

const GapSchema = z.object({ room: z.string().nullable(), code: z.string(), detail: z.string() });

async function responseBody<Result>(response: Response, parse: (value: unknown) => Result): Promise<Result> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || body === null) {
    const failure = body as { error?: string; message?: string } | null;
    throw new Error(failure?.message ?? failure?.error ?? `Request failed (${response.status})`);
  }
  return parse(body);
}

function formatTime(value: string | null): string {
  return value === null ? '—' : new Date(value).toLocaleString();
}

function formatClock(value: string): string {
  return new Date(value).toLocaleTimeString();
}

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1).replaceAll('-', ' ');
}

/** The phase the operator should look at: the one running, else the last recorded. */
export function currentPhase(operation: DemoOperationStatus): DemoOperationPhaseStatus | null {
  return operation.phases.find((phase) => phase.status === 'running')
    ?? operation.phases.find((phase) => phase.status === 'failed')
    ?? operation.phases.at(-1)
    ?? null;
}

export function operationHeadline(operation: DemoOperationStatus): string {
  if (operation.retiredAt) return 'Retired';
  if (operation.status === 'ready') return 'Ready';
  if (operation.status === 'abandoned') return 'Abandoned';
  if (operation.status === 'failed') {
    const phase = PHASES.find((candidate) => candidate.phase === operation.failedPhase);
    return phase ? `Failed: ${phase.label.toLowerCase()}` : 'Failed';
  }
  const phase = currentPhase(operation);
  const label = PHASES.find((candidate) => candidate.phase === phase?.phase)?.label;
  return label ?? 'Starting';
}

/**
 * The cast the form opens with: the presenter in the presenter's role, and the
 * other roles dealt out over the remaining members in order. A default is a
 * suggestion the operator reads before starting, so it has to be the one a
 * person would pick — not shifted by one, and never the same person twice
 * while there are members left.
 */
export function defaultCast(template: DemoTemplate, presenterUserId: string): Record<string, string> {
  const others = template.members.filter((member) => member.userId !== presenterUserId);
  const assigned: Record<string, string> = {};
  let index = 0;
  for (const role of template.pack.roles) {
    if (role === 'presenter') {
      assigned[role] = presenterUserId;
      continue;
    }
    assigned[role] = others[index % Math.max(others.length, 1)]?.userId ?? presenterUserId;
    index += 1;
  }
  return assigned;
}

function gapsOf(phase: DemoOperationPhaseStatus | undefined): z.infer<typeof GapSchema>[] {
  const gaps = phase?.detail.gaps;
  if (!Array.isArray(gaps)) return [];
  return gaps.flatMap((gap) => {
    const parsed = GapSchema.safeParse(gap);
    return parsed.success ? [parsed.data] : [];
  });
}

function PhaseRow({ definition, phase, operation }: {
  definition: typeof PHASES[number];
  phase: DemoOperationPhaseStatus | undefined;
  operation: DemoOperationStatus;
}): React.JSX.Element {
  const status = phase?.status ?? 'pending';
  const detail = phase?.detail ?? {};
  const items: string[] = [];
  if (definition.phase === 'creating_workspace' && typeof detail.members === 'number') items.push(`${detail.members} members seated`);
  if (definition.phase === 'copying_connections' && Array.isArray(detail.copied)) {
    items.push(`${detail.copied.length} connection${detail.copied.length === 1 ? '' : 's'} copied`);
    if (Array.isArray(detail.skipped) && detail.skipped.length > 0) items.push(`${detail.skipped.length} personal, left behind`);
  }
  if (definition.phase === 'seeding_conversations' && status !== 'pending') {
    items.push(`${operation.seeding.confirmed} of ${operation.seeding.total} actions confirmed`);
  }
  if (definition.phase === 'checking_template' && typeof detail.templateConnections === 'number') {
    items.push(`${detail.templateConnections} template connection${detail.templateConnections === 1 ? '' : 's'}`);
  }
  // The gaps stay readable once the wait has failed: that is the failure the
  // operator most needs explained, and the last round's list is the explanation.
  const gaps = definition.phase === 'waiting_for_workspace' && (status === 'running' || status === 'failed') ? gapsOf(phase) : [];
  const stateLine = status === 'pending' ? 'Not started'
    : status === 'running' ? `In progress · started ${formatClock(phase!.startedAt)}`
      : status === 'completed' ? `Completed ${formatTime(phase?.finishedAt ?? null)}`
        : `Failed ${formatTime(phase?.finishedAt ?? null)}`;
  return <li className={`demo-phase demo-phase-${status}`}>
    <span className="demo-phase-marker" aria-hidden="true" />
    <div>
      <strong>{definition.label}</strong>
      <small>{stateLine}</small>
      {items.length > 0 && <small>{items.join(' · ')}</small>}
      {gaps.length > 0 && <ul className="demo-gaps" aria-label={status === 'failed' ? 'What had not arrived' : 'What has not arrived yet'}>
        {gaps.map((gap, index) => <li key={`${gap.room ?? 'workspace'}-${gap.code}-${index}`}><code>{gap.room ?? 'workspace'}</code> {gap.code.replaceAll('_', ' ')}: {gap.detail}</li>)}
      </ul>}
    </div>
  </li>;
}

function NewDemoForm({ template, onStarted, onCancel }: {
  template: DemoTemplate;
  onStarted: (operation: DemoOperationStatus) => void;
  onCancel: () => void;
}): React.JSX.Element {
  // One id per form, so a second click on Start resolves to the same
  // operation rather than preparing a second workspace.
  const [operationId] = useState(() => crypto.randomUUID());
  const [companyName, setCompanyName] = useState('');
  const [presenterUserId, setPresenterUserId] = useState(template.members[0]?.userId ?? '');
  const [cast, setCast] = useState<Record<string, string>>(() => defaultCast(template, template.members[0]?.userId ?? ''));
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  const fullCast: Record<string, string> = { ...cast, ...(template.pack.roles.includes('presenter') ? { presenter: presenterUserId } : {}) };
  const seatedTwice = template.pack.roles.filter((role, index) =>
    template.pack.roles.findIndex((other) => fullCast[other] === fullCast[role]) !== index);
  const complete = companyName.trim().length > 0 && presenterUserId !== ''
    && template.pack.roles.every((role) => (fullCast[role] ?? '') !== '')
    && seatedTwice.length === 0;

  const start = async (): Promise<void> => {
    if (!complete || starting) return;
    setStarting(true); setError('');
    try {
      const response = await fetch('/api/demos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operationId, companyName: companyName.trim(), presenterUserId, cast: fullCast }),
      });
      onStarted(await responseBody(response, (value) => DemoOperationStatusSchema.parse(value)));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The demo could not be started.');
    } finally { setStarting(false); }
  };

  const nameOf = (userId: string): string => template.members.find((member) => member.userId === userId)?.name ?? userId;

  return <form className="ace-form" aria-label="New demo" onSubmit={(event) => { event.preventDefault(); void start(); }}>
    <div className="section-title"><div><h3>New demo</h3><p>Pack {template.pack.version}. The workspace will be named after the company, and each pack role is played by one member of the template.</p></div></div>
    <div className="demo-form-grid">
      <Field label="Company"><input placeholder="Alto Capital" value={companyName} onChange={(event) => setCompanyName(event.target.value)} /></Field>
      <Field label="Presenter"><select value={presenterUserId} onChange={(event) => { setPresenterUserId(event.target.value); setCast(defaultCast(template, event.target.value)); }}>
        {template.members.map((member) => <option key={member.userId} value={member.userId}>{member.name} · {member.email}</option>)}
      </select></Field>
      {template.pack.roles.filter((role) => role !== 'presenter').map((role) => <Field key={role} label={`Cast: ${roleLabel(role)}`}>
        <select value={cast[role] ?? ''} onChange={(event) => setCast((current) => ({ ...current, [role]: event.target.value }))}>
          {template.members.map((member) => <option key={member.userId} value={member.userId}>{member.name}</option>)}
        </select>
      </Field>)}
    </div>
    <p className="ace-form-note">Operation <code>{operationId}</code></p>
    {seatedTwice.length > 0 && <p className="queue-error" role="alert">{nameOf(fullCast[seatedTwice[0]!]!)} is cast in two roles. Each role needs a different member.</p>}
    {error && <p className="queue-error" role="alert">{error}</p>}
    <div className="ace-form-actions">
      <Button disabled={!complete || starting} type="submit" variant="primary">{starting ? 'Starting…' : 'Start preparation'}</Button>
      <Button onClick={onCancel} type="button">Cancel</Button>
    </div>
  </form>;
}

type TemplateState = { state: 'loading' } | { state: 'ready'; template: DemoTemplate } | { state: 'unavailable'; reason: string };

export function DemosView(): React.JSX.Element {
  const [operations, setOperations] = useState<DemoOperationStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [template, setTemplate] = useState<TemplateState>({ state: 'loading' });
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [readAt, setReadAt] = useState<string | null>(null);
  const [offlineSince, setOfflineSince] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState('');
  const [abandoning, setAbandoning] = useState(false);
  const [abandonConfirmation, setAbandonConfirmation] = useState('');
  const hadData = useRef(false);
  const latestLoad = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    // A slow read must not overwrite a newer one: the page is the operator's
    // only view of a long preparation, and a phase cannot move backwards.
    const requestId = latestLoad.current + 1;
    latestLoad.current = requestId;
    try {
      const body = await responseBody(await fetch('/api/demos'), (value) => DemoOperationListSchema.parse(value));
      if (requestId !== latestLoad.current) return;
      hadData.current = true;
      setOperations(body.operations);
      setReadAt(new Date().toISOString());
      setOfflineSince(null);
      setListError('');
      setSelectedId((current) => current && body.operations.some((operation) => operation.operationId === current) ? current : body.operations[0]?.operationId ?? null);
    } catch (error) {
      if (requestId !== latestLoad.current) return;
      // Offline: keep what was last read, and say since when, rather than show
      // an empty page that reads as "no demos".
      if (hadData.current) setOfflineSince((current) => current ?? new Date().toISOString());
      setListError(error instanceof Error ? error.message : 'Demos are unavailable.');
    } finally { setLoading(false); }
  }, []);

  const loadTemplate = useCallback(async (): Promise<void> => {
    setTemplate({ state: 'loading' });
    try {
      setTemplate({ state: 'ready', template: await responseBody(await fetch('/api/demos/template'), (value) => DemoTemplateSchema.parse(value)) });
    } catch (error) {
      setTemplate({ state: 'unavailable', reason: error instanceof Error ? error.message : 'The template could not be read.' });
    }
  }, []);

  useEffect(() => { void load(); void loadTemplate(); }, [load, loadTemplate]);
  const anyRunning = operations.some((operation) => operation.status === 'running');
  useEffect(() => {
    if (!anyRunning) return undefined;
    const timer = window.setInterval(() => { void load(); }, RUNNING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [anyRunning, load]);

  const selected = useMemo(
    () => operations.find((operation) => operation.operationId === selectedId) ?? null,
    [operations, selectedId],
  );
  useEffect(() => { setAbandoning(false); setAbandonConfirmation(''); setActionError(''); }, [selectedId]);

  const act = async (action: 'retry' | 'abandon'): Promise<void> => {
    if (!selected) return;
    setActing(true); setActionError('');
    try {
      const response = await fetch(`/api/demos/${encodeURIComponent(selected.operationId)}/${action}`, {
        method: 'POST',
        ...(action === 'abandon'
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmOperationId: abandonConfirmation.trim() }) }
          : {}),
      });
      const updated = await responseBody(response, (value) => DemoOperationStatusSchema.parse(value));
      setOperations((current) => current.map((operation) => operation.operationId === updated.operationId ? updated : operation));
      setAbandoning(false);
      setAbandonConfirmation('');
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'The action failed.');
    } finally { setActing(false); }
  };

  const live = operations.filter((operation) => operation.status === 'ready' && !operation.retiredAt).length;
  const phaseByName = new Map((selected?.phases ?? []).map((phase) => [phase.phase, phase]));
  const canCompose = template.state === 'ready' && !composing;
  const refresh = (): void => { void load(); if (template.state !== 'ready') void loadTemplate(); };

  return <>
    <aside className="queue-list demo-list"><header><p>Demo workspaces</p><h1>Demos</h1><small>{loading ? 'Reading preparations…' : `${live} live · ${operations.length} ${operations.length === 1 ? 'operation' : 'operations'}`}</small></header>
      <div className="queue-list-actions">
        <Button disabled={!canCompose} onClick={() => { setComposing(true); setSelectedId(null); }} title={template.state === 'unavailable' ? template.reason : undefined} type="button" variant="primary">New demo</Button>
        <Button onClick={refresh} type="button">Refresh</Button>
      </div>
      {template.state === 'unavailable' && <p className="queue-error" role="alert">Template unavailable: {template.reason.replace(/\.?$/u, '.')} New demos cannot be started until it can be read; Refresh tries again.</p>}
      {offlineSince && <p className="demo-stale" role="status">Offline since {formatClock(offlineSince)}. Showing the state read at {readAt ? formatClock(readAt) : '—'}; the page keeps trying, or Refresh now.</p>}
      {listError && !offlineSince && <p className="queue-error" role="alert">{listError}</p>}
      <div className="queues demos">
        {operations.map((operation) => <button className={selectedId === operation.operationId && !composing ? 'selected' : ''} key={operation.operationId} onClick={() => { setComposing(false); setSelectedId(operation.operationId); }} type="button">
          <span className={`demo-state demo-state-${operation.retiredAt ? 'retired' : operation.status}`} aria-hidden="true" />
          <div><strong>{operation.companyName}-demo</strong><small>{operationHeadline(operation)}{operation.presenterName ? ` · ${operation.presenterName}` : ''} · started {formatClock(operation.createdAt)}</small></div>
          <b>›</b>
        </button>)}
        {!loading && operations.length === 0 && !listError && <EmptyState title="No demos yet" description="Start one with New demo. It is prepared from the template and published when the presenter's view matches the pack." />}
      </div>
      <footer><span className={listError ? 'status-dot' : 'healthy-dot'} />{offlineSince ? 'Reconnecting…' : listError ? 'Regional API unavailable' : 'Regional API connected'}</footer>
    </aside>
    <main className="queue-detail demo-detail">
      {composing && template.state === 'ready' ? <div className="queue-messages"><NewDemoForm template={template.template} onCancel={() => setComposing(false)} onStarted={(operation) => {
        setComposing(false);
        setOperations((current) => [operation, ...current.filter((candidate) => candidate.operationId !== operation.operationId)]);
        setSelectedId(operation.operationId);
      }} /></div>
      : selected ? <>
        <header className="queue-detail-header"><div><p>{operationHeadline(selected)}</p><h2>{selected.companyName}-demo</h2><code>operation {selected.operationId}</code></div>
          <div className="demo-detail-actions">
            {(selected.status === 'failed' || selected.status === 'running') && <Button disabled={acting} onClick={() => void act('retry')} title={selected.status === 'running' ? 'For a preparation that has stopped moving: starts the next attempt from where it left off' : undefined} type="button" variant="primary">{acting ? 'Working…' : 'Retry'}</Button>}
            {(selected.status === 'failed' || selected.status === 'running') && !abandoning && <Button disabled={acting} onClick={() => setAbandoning(true)} type="button">Abandon…</Button>}
          </div>
        </header>
        <section className="queue-metrics" aria-label="Demo summary">
          <div><span>Presenter</span><strong>{selected.presenterName ?? selected.presenterUserId}</strong></div>
          <div><span>Workspace</span><strong>{selected.workspaceName ?? 'Not yet allocated'}</strong>{selected.workspaceId && <code className="ace-id">{selected.workspaceId}</code>}</div>
          <div><span>{selected.readyAt ? 'Ready since' : 'Started'}</span><strong>{formatTime(selected.readyAt ?? selected.createdAt)}</strong></div>
        </section>
        {selected.status === 'ready' && selected.workspaceId && !selected.retiredAt && <section className="demo-next-step" role="status" aria-label="Next step">
          <p>Ready. Tell the presenter to switch to <strong>{selected.workspaceName ?? `${selected.companyName}-demo`}</strong> in Rally's workspace switcher.</p>
          <small>There is no link to open it: the demo is the presenter's own view, and it appears in their switcher now that it is published.</small>
        </section>}
        {selected.status === 'failed' && selected.error && <section className="queue-source demo-failure" role="alert"><span>Failed</span><div><code>{selected.error.code}</code><span className="demo-failure-message">{selected.error.message}</span></div><p>Retry runs the next attempt of this operation from where it stopped. Abandon retires the candidate workspace and touches nothing else.</p></section>}
        {selected.retiredAt && <section className="queue-source"><span>Retired</span><div><span className="demo-retired-note">{formatTime(selected.retiredAt)}</span></div></section>}
        {abandoning && <div className="demo-confirm" role="group" aria-label="Abandon this preparation">
          <p>Abandoning retires the candidate workspace <strong>{selected.workspaceName ?? `${selected.companyName}-demo`}</strong> permanently and closes this preparation. Type or paste the operation id to confirm.</p>
          <Field label="Operation id"><input autoComplete="off" placeholder="Paste the operation id" spellCheck={false} value={abandonConfirmation} onChange={(event) => setAbandonConfirmation(event.target.value)} /></Field>
          <div className="ace-form-actions">
            <Button disabled={acting || abandonConfirmation.trim() !== selected.operationId} onClick={() => void act('abandon')} type="button" variant="danger">{acting ? 'Working…' : 'Abandon preparation'}</Button>
            <Button disabled={acting} onClick={() => { setAbandoning(false); setAbandonConfirmation(''); }} type="button">Keep it</Button>
          </div>
        </div>}
        {actionError && <p className="queue-error" role="alert">{actionError}</p>}
        <section className="queue-messages"><div className="section-title"><div><h3>Phases</h3><p>Each phase's state comes from its own receipt. Attempt {selected.attempt}.</p></div><span>pack {selected.packVersion}</span></div>
          <ol className="demo-phases">
            {PHASES.map((definition) => <PhaseRow definition={definition} key={definition.phase} operation={selected} phase={phaseByName.get(definition.phase)} />)}
          </ol>
        </section>
      </>
      : <div className="queue-detail-empty">
        {listError && !hadData.current
          ? <EmptyState title="Demos could not be read" description={<>{listError} <button className="ace-button ace-button-secondary" onClick={refresh} type="button">Try again</button></>} />
          : template.state === 'loading'
            ? <EmptyState title="Reading the template…" description="The template's members are being read from the regional API." />
            : <EmptyState title="Select a demo" description="Choose a preparation on the left, or start a new one." />}
      </div>}
    </main>
  </>;
}
