import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DemoOperationListSchema,
  DemoOperationStatusSchema,
  DemoReadinessGapSchema,
  DemoTemplateSchema,
  type DemoCastEntry,
  type DemoOperationPhaseStatus,
  type DemoOperationStatus,
  type DemoPreparationPhase,
  type DemoReadinessGap,
  type DemoTemplate,
} from '@rally/contracts';
import { Button, EmptyState, Field } from './components/ui';
import { responseBody } from './response';

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

/** How often a running operation is re-read, and how often an offline page tries again. A cadence, not a ceiling. */
const RUNNING_POLL_MS = 5_000;

function formatTime(value: string | null): string {
  return value === null ? '—' : new Date(value).toLocaleString();
}

function formatClock(value: string): string {
  return new Date(value).toLocaleTimeString();
}

function roleLabel(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1).replaceAll('-', ' ');
}

/**
 * The phase the operator should look at: the one running, else the last
 * recorded — among the current attempt's phases. A retried operation keeps its
 * earlier attempt's rows until the new driver re-reaches each phase, and a
 * stale "running" wait from attempt one must not read as attempt two's state.
 */
export function currentPhase(operation: DemoOperationStatus): DemoOperationPhaseStatus | null {
  const live = operation.phases.filter((phase) => phase.attempt === operation.attempt);
  const phases = live.length > 0 ? live : operation.phases;
  return phases.find((phase) => phase.status === 'running')
    ?? phases.find((phase) => phase.status === 'failed')
    ?? phases.at(-1)
    ?? null;
}

export function operationHeadline(operation: DemoOperationStatus): string {
  // Abandoned before retired: the two are different histories, and an
  // abandoned candidate that was then closed is still an abandoned one.
  if (operation.status === 'abandoned') return operation.retiredAt ? 'Abandoned · candidate closed' : 'Abandoned';
  if (operation.retiredAt) return 'Retired';
  if (operation.status === 'ready') return 'Ready';
  if (operation.status === 'failed') {
    const phase = PHASES.find((candidate) => candidate.phase === operation.failedPhase);
    return phase ? `Failed: ${phase.label.toLowerCase()}` : 'Failed';
  }
  const phase = currentPhase(operation);
  const label = PHASES.find((candidate) => candidate.phase === phase?.phase)?.label;
  return label ?? 'Starting';
}

/** The roles the operator names: every role the presenter does not play. */
export function castRolesOf(template: DemoTemplate): string[] {
  return template.pack.roles.filter((role) => role !== template.pack.presenterRole);
}

/**
 * The cast the form opens with: nobody. A default could be a real colleague
 * seated in a demo workspace because the operator did not look, so the form
 * is not submittable until each part has been named.
 */
export function emptyCast(template: DemoTemplate): Record<string, string> {
  return Object.fromEntries(castRolesOf(template).map((role) => [role, '']));
}

/**
 * What a typed part is sent as: the colleague whose name it is, when exactly
 * one colleague has it, and otherwise the name itself — played by a persona
 * that cannot sign in.
 */
export function castEntryOf(name: string, colleagues: readonly DemoTemplate['castCandidates'][number][]): DemoCastEntry {
  const matches = colleagues.filter((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? matches[0]!.userId : { name };
}

/**
 * What a typed part will be, said under its field: a typo that misses a
 * colleague would otherwise become a placeholder nobody notices until the demo.
 */
export function castHint(name: string, colleagues: readonly DemoTemplate['castCandidates'][number][]): string {
  const entry = castEntryOf(name, colleagues);
  const colleague = typeof entry === 'string' ? colleagues.find((candidate) => candidate.userId === entry) : undefined;
  return colleague ? `Seats ${colleague.name} · ${colleague.email}` : 'Placeholder person: cannot sign in';
}

/**
 * Who is in this demo besides the presenter, by name — the cast the operator
 * typed when they started it, which is not recoverable from anywhere else once
 * the form is gone.
 */
function castOf(operation: DemoOperationStatus): string {
  const names = Object.entries(operation.castNames)
    .filter(([, name]) => name !== operation.presenterName)
    .map(([, name]) => name);
  return names.length > 0 ? names.join(', ') : '—';
}

/** The gaps a wait phase recorded, in the shape the API writes them (the contract's). */
function gapsOf(phase: DemoOperationPhaseStatus | undefined): DemoReadinessGap[] {
  const gaps = phase?.detail.gaps;
  if (!Array.isArray(gaps)) return [];
  return gaps.flatMap((gap) => {
    const parsed = DemoReadinessGapSchema.safeParse(gap);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Who a viewer is, by the name the demo carries, so a gap names whose projection is behind. */
function nameOf(operation: DemoOperationStatus, userId: string): string {
  const role = Object.entries(operation.cast).find(([, id]) => id === userId)?.[0];
  return (role === undefined ? undefined : operation.castNames[role]) ?? (role === undefined ? userId : roleLabel(role));
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
    if (Array.isArray(detail.skipped) && detail.skipped.length > 0) {
      // Left behind for one of two reasons, and the operator needs to know
      // which: a personal connection is the template owner's to share by
      // reconnecting it at workspace scope; a grant that cannot be shared
      // stays out whatever they do.
      const skipped = detail.skipped.filter((entry): entry is { displayName?: unknown; reason?: unknown } => typeof entry === 'object' && entry !== null);
      const named = skipped.map((entry) => `${typeof entry.displayName === 'string' && entry.displayName ? entry.displayName : 'a connection'} (${entry.reason === 'personal_scope' ? 'personal' : 'grant not shareable'})`);
      items.push(`${skipped.length} left behind: ${named.join(', ')}`);
    }
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
  // A row from an earlier attempt is a receipt of that attempt, not the
  // operation's present state: the new driver has not reached this phase yet.
  const past = phase !== undefined && phase.attempt < operation.attempt;
  // A phase's own reason, shown when the operation does not already carry it:
  // `failPhase` mirrors the reason onto the operation, so a failed operation
  // shows it once, in the banner; a retried operation has that banner cleared
  // and this row is then the only place the reason survives.
  const phaseError = phase?.error && !past
    && (operation.error?.code !== phase.error.code || operation.error?.message !== phase.error.message)
    ? phase.error
    : null;
  const stateLine = status === 'pending' ? 'Not started'
    : past ? `From attempt ${phase.attempt} · ${status === 'running' ? 'not reached yet by this attempt' : status === 'completed' ? `completed ${formatTime(phase.finishedAt)}` : `failed ${formatTime(phase.finishedAt)}`}`
      : status === 'running' ? `In progress · started ${formatClock(phase!.startedAt)}`
        : status === 'completed' ? `Completed ${formatTime(phase?.finishedAt ?? null)}`
          : `Failed ${formatTime(phase?.finishedAt ?? null)}`;
  return <li className={`demo-phase demo-phase-${past ? 'past' : status}`}>
    <span className="demo-phase-marker" aria-hidden="true" />
    <div>
      <strong>{definition.label}</strong>
      <small>{stateLine}</small>
      {items.length > 0 && <small>{items.join(' · ')}</small>}
      {phaseError && <p className="demo-phase-error"><code>{phaseError.code}</code> {phaseError.message}</p>}
      {gaps.length > 0 && <ul className="demo-gaps" aria-label={status === 'failed' ? 'What had not arrived' : 'What has not arrived yet'}>
        {gaps.map((gap, index) => <li key={`${gap.viewerUserId}-${gap.room ?? 'workspace'}-${gap.code}-${index}`}>{nameOf(operation, gap.viewerUserId)}: <code>{gap.room ?? 'workspace'}</code> {gap.code.replaceAll('_', ' ')}: {gap.detail}</li>)}
      </ul>}
    </div>
  </li>;
}

function NewDemoForm({ template, onStarted, onFailed, onCancel }: {
  template: DemoTemplate;
  onStarted: (operation: DemoOperationStatus) => void;
  onFailed: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  // One id per form, so a second click on Start resolves to the same
  // operation rather than preparing a second workspace.
  const [operationId] = useState(() => crypto.randomUUID());
  const [companyName, setCompanyName] = useState('');
  const [presenterUserId, setPresenterUserId] = useState(template.members[0]?.userId ?? '');
  const [cast, setCast] = useState<Record<string, string>>(() => emptyCast(template));
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');

  const roles = castRolesOf(template);
  const presenterName = template.members.find((member) => member.userId === presenterUserId)?.name ?? '';
  // The presenter is in the demo already, so they are not suggested for a part.
  const castable = template.castCandidates.filter((candidate) => candidate.userId !== presenterUserId);
  const typed = (role: string): string => (cast[role] ?? '').trim();
  const spoken = [...roles.map(typed), ...(template.pack.presenterRole ? [presenterName] : [])]
    .filter((name) => name !== '');
  const folded = spoken.map((name) => name.toLowerCase());
  const sharedName = spoken.find((_name, index) => folded.indexOf(folded[index]!) !== index) ?? '';
  const uncast = roles.filter((role) => typed(role) === '').length;
  const complete = companyName.trim().length > 0 && presenterUserId !== '' && uncast === 0 && sharedName === '';

  const start = async (): Promise<void> => {
    if (!complete || starting) return;
    setStarting(true); setError('');
    try {
      const response = await fetch('/api/demos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operationId,
          companyName: companyName.trim(),
          presenterUserId,
          cast: Object.fromEntries(roles.map((role) => [role, castEntryOf(typed(role), castable)])),
        }),
      });
      onStarted(await responseBody(response, (value) => DemoOperationStatusSchema.parse(value)));
    } catch (caught) {
      // The write may have landed before the answer was lost: the operation is
      // durable, so the list is re-read before the failure is shown.
      onFailed();
      setError(caught instanceof Error ? caught.message : 'The demo could not be started.');
    } finally { setStarting(false); }
  };

  return <form className="ace-form" aria-label="New demo" onSubmit={(event) => { event.preventDefault(); void start(); }}>
    <div className="section-title"><div><h3>New demo</h3><p>Pack {template.pack.version}. The workspace will be named after the company. The presenter is the person who will show the demo. Every other part can be any name: a colleague's name seats that colleague, who will see the demo in their own account; any other name is a placeholder person who cannot sign in.</p></div></div>
    <div className="demo-form-grid">
      <Field label="Company"><input maxLength={80} placeholder="Alto Capital" value={companyName} onChange={(event) => setCompanyName(event.target.value)} /></Field>
      <Field label="Presenter"><select value={presenterUserId} onChange={(event) => setPresenterUserId(event.target.value)}>
        {template.members.map((member) => <option key={member.userId} value={member.userId}>{member.name} · {member.email}</option>)}
      </select></Field>
      {roles.map((role, index) => <Field key={role} label={template.pack.roleLabels[role] ?? `User ${index + 1}`}>
        <input list="demo-cast-colleagues" maxLength={255} placeholder="Any name, e.g. Jane Doe" value={cast[role] ?? ''} onChange={(event) => setCast((current) => ({ ...current, [role]: event.target.value }))} />
        {typed(role) !== '' && <small className="ace-form-note">{castHint(typed(role), castable)}</small>}
      </Field>)}
      <datalist id="demo-cast-colleagues">
        {castable.map((candidate) => <option key={candidate.userId} value={candidate.name}>{candidate.email}</option>)}
      </datalist>
    </div>
    <p className="ace-form-note">Operation <code>{operationId}</code></p>
    {uncast > 0 && <p className="ace-form-note" role="status">{uncast} {uncast === 1 ? 'part is' : 'parts are'} still unnamed. Every part is played by somebody, and by somebody different.</p>}
    {sharedName !== '' && <p className="queue-error" role="alert">Two people in this demo are called {sharedName}. Nobody watching could tell which of them a mention names, so use a different name.</p>}
    {error && <p className="queue-error" role="alert">{error}</p>}
    <div className="ace-form-actions">
      <Button
        disabled={!complete || starting}
        title={complete || starting ? undefined
          : companyName.trim() === '' ? 'Name the company this demo is for'
            : uncast > 0 ? `${uncast} ${uncast === 1 ? 'part is' : 'parts are'} still unnamed`
              : 'Two people in this demo share a name'}
        type="submit"
        variant="primary"
      >{starting ? 'Starting…' : 'Start preparation'}</Button>
      <Button onClick={onCancel} type="button">Cancel</Button>
    </div>
  </form>;
}

type TemplateState =
  | { state: 'loading' }
  | { state: 'ready'; template: DemoTemplate }
  /** The template could not be read; Refresh is the remedy. */
  | { state: 'unavailable'; reason: string }
  /** It was read and there is nobody to present; Refresh changes nothing. */
  | { state: 'uncastable'; reason: string };

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
  const latestLoad = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    // A slow read must not overwrite a newer one: the page is the operator's
    // only view of a long preparation, and a phase cannot move backwards.
    const requestId = latestLoad.current + 1;
    latestLoad.current = requestId;
    try {
      const body = await responseBody(await fetch('/api/demos'), (value) => DemoOperationListSchema.parse(value));
      if (requestId !== latestLoad.current) return;
      setOperations(body.operations);
      setReadAt(new Date().toISOString());
      setOfflineSince(null);
      setListError('');
      setSelectedId((current) => current && body.operations.some((operation) => operation.operationId === current) ? current : body.operations[0]?.operationId ?? null);
    } catch (error) {
      if (requestId !== latestLoad.current) return;
      // Offline: keep what was last read, and say since when, rather than show
      // an empty page that reads as "no demos".
      setReadAt((current) => {
        if (current !== null) setOfflineSince((since) => since ?? new Date().toISOString());
        return current;
      });
      setListError(error instanceof Error ? error.message : 'Demos are unavailable.');
    } finally { setLoading(false); }
  }, []);

  const loadTemplate = useCallback(async (): Promise<void> => {
    setTemplate({ state: 'loading' });
    try {
      const template = await responseBody(await fetch('/api/demos/template'), (value) => DemoTemplateSchema.parse(value));
      // Two ways the form cannot be filled, both worth saying rather than
      // rendering. No template members is the first-run state before
      // `demo-template` is populated, and the presenter is cast from those
      // alone. Fewer colleagues than the pack has parts is a company that
      // has not signed in yet — nothing about the template, which read fine.
      if (template.members.length === 0) {
        setTemplate({ state: 'uncastable', reason: 'demo-template has no active members, and the presenter is cast from them.' });
        return;
      }
      setTemplate({ state: 'ready', template });
    } catch (error) {
      setTemplate({ state: 'unavailable', reason: error instanceof Error ? error.message : 'The template could not be read.' });
    }
  }, []);

  useEffect(() => { void load(); void loadTemplate(); }, [load, loadTemplate]);
  const anyRunning = operations.some((operation) => operation.status === 'running');
  // Re-read while anything runs, and while the page is offline — so "the page
  // keeps trying" is true whenever it is shown.
  useEffect(() => {
    if (!anyRunning && offlineSince === null) return undefined;
    const timer = window.setInterval(() => { void load(); }, RUNNING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [anyRunning, offlineSince, load]);

  const selected = useMemo(
    () => operations.find((operation) => operation.operationId === selectedId) ?? null,
    [operations, selectedId],
  );
  useEffect(() => { setAbandoning(false); setAbandonConfirmation(''); setActionError(''); }, [selectedId]);

  const act = async (action: 'retry' | 'abandon'): Promise<void> => {
    if (!selected) return;
    setActing(true); setActionError('');
    // A poll already in flight is older than what this action answers with;
    // discard it the way a superseded read is discarded.
    latestLoad.current += 1;
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
  // The current attempt's row for each phase where one exists, else the last
  // attempt's, so a retried operation shows what the new driver has reached
  // and what it has not.
  const phaseByName = new Map<DemoPreparationPhase, DemoOperationPhaseStatus>();
  for (const phase of selected?.phases ?? []) {
    const existing = phaseByName.get(phase.phase);
    if (!existing || phase.attempt >= existing.attempt) phaseByName.set(phase.phase, phase);
  }
  const canCompose = template.state === 'ready' && !composing;
  const refresh = (): void => { void load(); if (template.state !== 'ready') void loadTemplate(); };
  const connected = !listError && template.state !== 'unavailable';

  return <>
    <aside className="queue-list demo-list"><header><p>Demo workspaces</p><h1>Demos</h1><small>{loading ? 'Reading preparations…' : `${live} live · ${operations.length} ${operations.length === 1 ? 'operation' : 'operations'}`}</small></header>
      <div className="queue-list-actions">
        <Button disabled={!canCompose} onClick={() => { setComposing(true); setSelectedId(null); }} title={template.state === 'unavailable' || template.state === 'uncastable' ? template.reason : undefined} type="button" variant="primary">New demo</Button>
        <Button onClick={refresh} type="button">Refresh</Button>
      </div>
      {template.state === 'unavailable' && <p className="queue-error" role="alert">Template unavailable: {template.reason.replace(/\.?$/u, '.')} New demos cannot be started until it can be read; Refresh tries again.</p>}
      {template.state === 'uncastable' && <p className="queue-error" role="alert">Nobody to present: {template.reason.replace(/\.?$/u, '.')} The template read fine, so Refresh only helps once that has changed.</p>}
      {offlineSince && <p className="demo-stale" role="status">Offline since {formatClock(offlineSince)}. Showing the state read at {readAt ? formatClock(readAt) : '—'}; the page keeps trying every few seconds, or Refresh now.</p>}
      {listError && !offlineSince && <p className="queue-error" role="alert">{listError}</p>}
      <div className="queues demos">
        {operations.map((operation) => <button className={selectedId === operation.operationId && !composing ? 'selected' : ''} key={operation.operationId} onClick={() => { setComposing(false); setSelectedId(operation.operationId); }} type="button">
          <span className={`demo-state demo-state-${operation.status === 'abandoned' ? 'abandoned' : operation.retiredAt ? 'retired' : operation.status}`} aria-hidden="true" />
          <div><strong>{operation.companyName}-demo</strong><small>{operationHeadline(operation)}{operation.presenterName ? ` · ${operation.presenterName}` : ''} · started {formatClock(operation.createdAt)}</small></div>
          <b aria-hidden="true">›</b>
        </button>)}
        {!loading && operations.length === 0 && !listError && <EmptyState title="No demos yet" description={template.state === 'ready' ? "Start one with New demo. It is prepared from the template and published when the presenter's view matches the pack." : template.state === 'uncastable' ? 'Nothing has been prepared. New demo needs a presenter, and the template has no members.' : 'Nothing has been prepared. New demo needs the template, which could not be read.'} />}
      </div>
      <footer><span className={connected ? 'healthy-dot' : 'status-dot'} />{offlineSince ? 'Reconnecting…' : listError ? 'Regional API unavailable' : template.state === 'unavailable' ? 'Regional API connected · template unavailable' : template.state === 'uncastable' ? 'Regional API connected · nobody to present' : 'Regional API connected'}</footer>
    </aside>
    <main className="queue-detail demo-detail">
      {composing && template.state === 'ready' ? <div className="queue-messages"><NewDemoForm template={template.template} onCancel={() => setComposing(false)} onFailed={() => { void load(); }} onStarted={(operation) => {
        setComposing(false);
        setOperations((current) => [operation, ...current.filter((candidate) => candidate.operationId !== operation.operationId)]);
        setSelectedId(operation.operationId);
      }} /></div>
      : selected ? <>
        <header className="queue-detail-header"><div><p>{operationHeadline(selected)}</p><h2>{selected.companyName}-demo</h2><code>operation {selected.operationId}</code></div>
          <div className="demo-detail-actions">
            {(selected.status === 'failed' || selected.status === 'running') && <Button disabled={acting || selected.status === 'running'} onClick={() => void act('retry')} title={selected.status === 'running' ? 'A preparation that is still running cannot be retried; it becomes available if this one fails' : 'Starts the next attempt of this operation from where it stopped'} type="button" variant="primary">{acting ? 'Working…' : 'Retry'}</Button>}
            {(selected.status === 'failed' || selected.status === 'running') && !abandoning && <Button disabled={acting} onClick={() => setAbandoning(true)} type="button">Abandon…</Button>}
          </div>
        </header>
        <section className="queue-metrics" aria-label="Demo summary">
          <div><span>Presenter</span><strong>{selected.presenterName ?? selected.presenterUserId}</strong></div>
          <div><span>Cast</span><strong>{castOf(selected)}</strong></div>
          <div><span>Workspace</span><strong>{selected.workspaceName ?? 'Not yet allocated'}</strong>{selected.workspaceId && <code className="ace-id">{selected.workspaceId}</code>}</div>
          <div><span>{selected.readyAt ? 'Ready since' : 'Started'}</span><strong>{formatTime(selected.readyAt ?? selected.createdAt)}</strong></div>
        </section>
        {selected.status === 'ready' && selected.workspaceId && !selected.retiredAt && <section className="demo-next-step" role="status" aria-label="Next step">
          <p>Ready. Tell the presenter to switch to <strong>{selected.workspaceName ?? `${selected.companyName}-demo`}</strong> from the account menu at the foot of Rally's sidebar.</p>
          <small>There is no link to open it: the demo is the presenter's own view, and it is listed in their account menu now that it is published — provided their <code>multiple-workspaces-enabled</code> flag is on (Feature flags tab); without it the menu lists no workspaces at all.</small>
        </section>}
        {selected.error && <section className="queue-source demo-failure" role={selected.status === 'failed' ? 'alert' : 'note'}><span>{selected.status === 'failed' ? 'Failed' : 'Last failure'}</span><div><code>{selected.error.code}</code><span className="demo-failure-message">{selected.error.message}</span></div>{selected.status === 'failed' && <p>Retry runs the next attempt of this operation from where it stopped. Abandon retires the candidate workspace and touches nothing else.</p>}</section>}
        {selected.status === 'abandoned' && <section className="queue-source"><span>Abandoned</span><div><span className="demo-retired-note">{selected.retiredAt ? `Candidate workspace closed ${formatTime(selected.retiredAt)}; nothing in it answers, and nobody was ever offered it.` : selected.workspaceId ? 'The candidate workspace was allocated but never created, so there was nothing to close.' : 'No workspace had been allocated.'}</span></div></section>}
        {selected.status !== 'abandoned' && selected.retiredAt && <section className="queue-source"><span>Retired</span><div><span className="demo-retired-note">Closed from the Workspaces tab {formatTime(selected.retiredAt)}; nothing in it answers any more.</span></div></section>}
        {abandoning && <div className="demo-confirm" role="group" aria-label="Abandon this preparation">
          <p>This cannot be undone. Abandoning retires the candidate workspace <strong>{selected.workspaceName ?? `${selected.companyName}-demo`}</strong> permanently — every Canvas and Sidekick in it closes and nobody can open it — and closes this preparation. Type or paste the operation id to confirm.</p>
          <Field label="Operation id"><input aria-describedby="abandon-hint" autoComplete="off" placeholder="Paste the operation id" spellCheck={false} value={abandonConfirmation} onChange={(event) => setAbandonConfirmation(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && abandonConfirmation.trim() === selected.operationId && !acting) void act('abandon'); }} /></Field>
          <p className="ace-form-note" id="abandon-hint">The button enables only when the id matches exactly.</p>
          <div className="ace-form-actions">
            <Button disabled={acting || abandonConfirmation.trim() !== selected.operationId} onClick={() => void act('abandon')} type="button" variant="danger">{acting ? 'Working…' : 'Abandon preparation'}</Button>
            <Button disabled={acting} onClick={() => { setAbandoning(false); setAbandonConfirmation(''); }} type="button">Keep it</Button>
          </div>
        </div>}
        {actionError && <p className="queue-error" role="alert">{actionError}</p>}
        <section className="queue-messages"><div className="section-title"><div><h3>Phases</h3><p>Each phase's state comes from its own receipt. Attempt {selected.attempt}.{readAt && <> <span className={`demo-read-at${offlineSince ? ' stale' : ''}`}>{offlineSince ? `Stale: read at ${formatClock(readAt)}` : `Read at ${formatClock(readAt)}`}</span></>}</p></div><span>pack {selected.packVersion}</span></div>
          <ol className="demo-phases">
            {PHASES.map((definition) => <PhaseRow definition={definition} key={definition.phase} operation={selected} phase={phaseByName.get(definition.phase)} />)}
          </ol>
        </section>
      </>
      : <div className="queue-detail-empty">
        {listError && readAt === null
          ? <EmptyState title="Demos could not be read" description={<>{listError} <Button onClick={refresh} type="button">Try again</Button></>} />
          : template.state === 'loading'
            ? <EmptyState title="Reading the template…" description="The template's members are being read from the regional API." />
            : template.state === 'unavailable'
              ? <EmptyState title="The template could not be read" description={<>{template.reason.replace(/\.?$/u, '.')} New demos cannot be started until it can be read; Refresh tries again.{operations.length > 0 ? ' Existing preparations are listed on the left.' : ''}</>} />
              : template.state === 'uncastable'
                ? <EmptyState title="There is nobody to present" description={<>{template.reason.replace(/\.?$/u, '.')} The template itself read fine, so this changes when the people do.{operations.length > 0 ? ' Existing preparations are listed on the left.' : ''}</>} />
              : <EmptyState title="Select a demo" description={operations.length > 0 ? 'Choose a preparation on the left, or start a new one.' : 'Start one with New demo.'} />}
      </div>}
    </main>
  </>;
}
