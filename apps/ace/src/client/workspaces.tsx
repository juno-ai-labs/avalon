import { useEffect, useMemo, useRef, useState } from 'react';
import { WorkspaceRetirementResultSchema, type WorkspaceRetirementResult } from '@rally/contracts';
import { PLAN_IDS, PLANS, PlanIdSchema, WorkspacePlanResultSchema, type PlanId } from '@rally/contracts/usage';
import { WorkspaceSearchResultSchema, type DirectoryRegion, type DirectoryWorkspace } from '../directory';
import { Button, EmptyState, Field } from './components/ui';
import { responseBody } from './response';

/** A retirement node's kind as the product names it. */
const RETIREMENT_PARENT_LABELS: Record<WorkspaceRetirementResult['failed'][number]['parentKind'], string> = {
  canvas: 'Canvas', automation: 'Sidekick', space: 'Channel', workstream: 'Thread',
};

/**
 * The workspaces tab: find a workspace, and retire it.
 *
 * Retirement is irreversible and takes any workspace, demo or not; nothing
 * gates it but the operator's Access admission and the confirmation this page
 * asks for. So the confirmation is not a click beside a name: the operator
 * types or pastes the workspace id, and the button stays disabled until it
 * matches. The id travels with the request, and both Ace and the regional API
 * refuse a retirement whose confirmation names another workspace. A search
 * that fails says so — a failed search shown as "no matches" is how the wrong
 * workspace gets retired with full ceremony — and a workspace this page has
 * retired stays marked for the rest of the session, because the directory it
 * searches does not know. The mark lives in the app, not this view, so it
 * survives a switch to another tab and back.
 */

export interface RetiredWorkspace { workspace: DirectoryWorkspace; receipt: WorkspaceRetirementResult; at: string }

function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}

function regionLabel(region: DirectoryRegion): string {
  return region === 'global' ? 'Global' : region;
}

export function WorkspacesView({ retired, onRetired }: {
  retired: ReadonlyMap<string, RetiredWorkspace>;
  onRetired: (record: RetiredWorkspace) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DirectoryWorkspace[]>([]);
  const [unavailableRegions, setUnavailableRegions] = useState<DirectoryRegion[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<DirectoryWorkspace | null>(null);
  const [confirmation, setConfirmation] = useState('');
  // Scoped to a workspace id rather than global: rows stay clickable while a
  // retirement is in flight, and a status shown under whichever row is
  // selected would be shown under the wrong workspace.
  const [retiringId, setRetiringId] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [incomplete, setIncomplete] = useState<{ id: string; receipt: WorkspaceRetirementResult } | null>(null);
  const receiptRef = useRef<HTMLElement | null>(null);
  // Plans saved this session, so a row keeps showing what was just set
  // without another search.
  const [savedPlans, setSavedPlans] = useState<ReadonlyMap<string, PlanId>>(new Map());
  const [planDraft, setPlanDraft] = useState<PlanId | null>(null);
  const [planSaving, setPlanSaving] = useState(false);
  const [planError, setPlanError] = useState<{ id: string; message: string } | null>(null);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]); setUnavailableRegions([]); setSearchError(''); setSearched(false); setSearching(false);
      return undefined;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      void fetch(`/api/directory/workspaces?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal })
        .then((response) => responseBody(response, (value) => WorkspaceSearchResultSchema.parse(value)))
        .then((next) => { setResults(next.results); setUnavailableRegions(next.unavailableRegions); setSearchError(''); setSearched(true); })
        .catch((caught: unknown) => {
          if (controller.signal.aborted) return;
          // Not "no matches": the previous query's rows would otherwise sit
          // under a new query, and a workspace picked from them is the wrong one.
          setResults([]);
          setUnavailableRegions([]);
          setSearched(true);
          setSearchError(caught instanceof Error ? caught.message : 'The directory could not be searched.');
        })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  const confirmed = useMemo(() => selected !== null && confirmation.trim() === selected.id, [confirmation, selected]);
  const selectedRetired = selected ? retired.get(selected.id) ?? null : null;
  const selectedError = selected && error?.id === selected.id ? error.message : '';
  const selectedIncomplete = selected && incomplete?.id === selected.id ? incomplete.receipt : null;
  const retiring = selected !== null && retiringId === selected.id;
  const currentPlan = selected ? savedPlans.get(selected.id) ?? selected.plan : null;
  const chosenPlan = planDraft ?? currentPlan;
  const selectedPlanError = selected && planError?.id === selected.id ? planError.message : '';

  const savePlan = async (): Promise<void> => {
    if (!selected || !chosenPlan || chosenPlan === currentPlan || planSaving) return;
    const target = selected;
    setPlanSaving(true); setPlanError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(target.id)}/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: target.region, plan: chosenPlan }),
      });
      const result = await responseBody(response, (value) => WorkspacePlanResultSchema.parse(value));
      setSavedPlans((previous) => new Map(previous).set(result.workspaceId, result.plan));
      setPlanDraft(null);
    } catch (caught) {
      setPlanError({ id: target.id, message: caught instanceof Error ? caught.message : 'The plan could not be changed.' });
    } finally { setPlanSaving(false); }
  };

  // The receipt replaces the form the operator was focused in; without this,
  // focus falls to the document body and a screen reader announces nothing.
  useEffect(() => {
    if (selectedRetired) receiptRef.current?.focus();
  }, [selectedRetired]);

  const retire = async (): Promise<void> => {
    if (!selected || !confirmed || selectedRetired || retiringId !== null) return;
    const target = selected;
    setRetiringId(target.id); setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(target.id)}/retire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: target.region, confirmWorkspaceId: confirmation.trim() }),
      });
      const receipt = await responseBody(response, (value) => WorkspaceRetirementResultSchema.parse(value));
      if (receipt.complete) {
        onRetired({ workspace: target, receipt, at: new Date().toISOString() });
        setIncomplete(null);
        setConfirmation('');
      } else {
        // The confirmation stays typed and the button stays armed: the next
        // click returns to exactly the nodes this pass could not close.
        setIncomplete({ id: target.id, receipt });
      }
    } catch (caught) {
      setError({ id: target.id, message: caught instanceof Error ? caught.message : 'The workspace could not be retired.' });
    } finally { setRetiringId(null); }
  };

  const footer = searchError
    ? { dot: 'status-dot', text: 'Directory search failed' }
    : unavailableRegions.length > 0
      ? { dot: 'status-dot', text: `${unavailableRegions.map(regionLabel).join(' and ')} directory did not answer` }
      : searched
        ? { dot: 'healthy-dot', text: 'Both regions searched' }
        : { dot: 'status-dot', text: 'Type to search both regions' };

  return <>
    <aside className="queue-list workspace-list"><header><p>Operator tools</p><h1>Workspaces</h1><small>Find a workspace by name, slug or id</small></header>
      <div className="queue-list-actions"><Field label="Search"><input placeholder="Name, slug or workspace id" value={query} onChange={(event) => setQuery(event.target.value)} /></Field></div>
      {searchError && <p className="queue-error" role="alert">{searchError}</p>}
      {!searchError && unavailableRegions.length > 0 && <p className="directory-notice" role="alert">The {unavailableRegions.map(regionLabel).join(' and ')} directory did not answer, so a workspace there would not be listed. Only the other region was searched.</p>}
      <div className="queues workspaces">
        {results.map((workspace) => <button className={`${selected?.id === workspace.id ? 'selected' : ''}${retired.has(workspace.id) ? ' retired' : ''}`} disabled={searching} key={`${workspace.region}:${workspace.id}`} onClick={() => { setSelected(workspace); setConfirmation(''); setPlanDraft(null); }} type="button">
          <span className="queue-count">{workspace.region.toUpperCase()}</span>
          <div><strong>{workspace.name}</strong><small>{retired.has(workspace.id) ? 'Retired this session' : workspace.slug}</small></div>
          <b aria-hidden="true">›</b>
        </button>)}
        {searched && !searching && !searchError && results.length === 0 && <EmptyState title="No workspaces match" description="Search by the workspace's name, slug or id." />}
      </div>
      <footer><span className={footer.dot} />{searching ? 'Searching…' : footer.text}</footer>
    </aside>
    <main className="queue-detail workspace-detail">
      {selected ? <>
        <header className="queue-detail-header"><div><p>{selectedRetired ? `Retired ${new Date(selectedRetired.at).toLocaleString()} · ${regionLabel(selected.region)} workspace` : `${regionLabel(selected.region)} workspace`}</p><h2>{selected.name}</h2><code>{selected.id}</code></div></header>
        <section className="queue-messages">
          {selectedRetired
            ? <section className="queue-source retire-receipt" ref={receiptRef} role="status" aria-label="Retirement result" tabIndex={-1}>
              <span>Retired</span>
              <div>
                <p className="retire-receipt-title"><strong>{selectedRetired.workspace.name}</strong> <code className="ace-id">{selectedRetired.receipt.workspaceId}</code></p>
              </div>
              <p>All {plural(selectedRetired.receipt.parents, 'Canvas, Sidekick, Channel or Thread', 'Canvases, Sidekicks, Channels and Threads')} in the {regionLabel(selected.region)} workspace are closed; this pass closed {selectedRetired.receipt.retiredParents} of them, with {plural(selectedRetired.receipt.retiredChildren, 'conversation')} under them. {selectedRetired.receipt.retainedOutbox === 0 ? 'Nothing was left queued.' : `${plural(selectedRetired.receipt.retainedOutbox, 'queued effect')} will never publish.`} Messages, files and members were not deleted; nothing in this workspace answers any more, and nobody can sign in to it.</p>
            </section>
            : <>
              <div className="section-title"><div><h3>Plan</h3><p>Sets the weekly usage quota everyone in this workspace shares. A change applies to the current week at once.</p></div></div>
              <div className="ace-form plan-form">
                <Field label="Plan"><select aria-label="Plan" value={chosenPlan ?? ''} onChange={(event) => setPlanDraft(PlanIdSchema.parse(event.target.value))}>
                  {PLAN_IDS.map((plan) => <option key={plan} value={plan}>{PLANS[plan].name} (${PLANS[plan].monthlyPriceUsd} a month)</option>)}
                </select></Field>
                {selectedPlanError && <p className="queue-error" role="alert">{selectedPlanError}</p>}
                <div className="ace-form-actions"><Button disabled={planSaving || chosenPlan === currentPlan} onClick={() => void savePlan()} type="button">{planSaving ? 'Saving…' : 'Save plan'}</Button></div>
              </div>
              <div className="section-title"><div><h3>Retire this workspace</h3><p>Every Canvas, Sidekick and socket in it closes and nothing reopens. Members can no longer sign in to it. Messages, files and members are kept but unreachable.</p></div></div>
              <div className="ace-form retire-form">
                <p className="retire-consequence">This cannot be undone. Type or paste the workspace id shown above to confirm that <strong>{selected.name}</strong> is the workspace to close.</p>
                <Field label="Workspace id"><input aria-describedby="retire-hint" autoComplete="off" placeholder="Paste the workspace id" spellCheck={false} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Field>
                <p className="ace-form-note" id="retire-hint">The button enables only when the id matches exactly.</p>
                {selectedIncomplete && <div className="retire-incomplete" role="status">
                  <strong>{selectedIncomplete.remaining} of {plural(selectedIncomplete.parents, 'Canvas, Sidekick, Channel or Thread', 'Canvases, Sidekicks, Channels and Threads')} {selectedIncomplete.remaining === 1 ? 'is' : 'are'} still open</strong> after this pass, which closed {selectedIncomplete.retiredParents} of them and {plural(selectedIncomplete.retiredChildren, 'conversation')} under them. Retire again to return to what remains.
                  {selectedIncomplete.failed.length > 0 && <ul>{selectedIncomplete.failed.map((node) => <li key={`${node.parentKind}:${node.parentId}`}>{RETIREMENT_PARENT_LABELS[node.parentKind]} <code className="ace-id">{node.parentId}</code>: {node.error.replaceAll('_', ' ')}</li>)}</ul>}
                </div>}
                {selectedError && <p className="queue-error" role="alert">{selectedError}</p>}
                <div className="ace-form-actions"><Button disabled={!confirmed || retiring} onClick={() => void retire()} type="button" variant="danger">{retiring ? 'Retiring…' : selectedIncomplete ? 'Retire again' : 'Retire workspace'}</Button></div>
              </div>
            </>}
        </section>
      </>
      : <div className="queue-detail-empty"><EmptyState title="Select a workspace" description="Search on the left. Retirement asks you to type the workspace id before it closes anything." /></div>}
    </main>
  </>;
}
