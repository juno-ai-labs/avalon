import { useEffect, useMemo, useState } from 'react';
import { WorkspaceRetirementResultSchema, type WorkspaceRetirementResult } from '@rally/contracts';
import type { DirectoryWorkspace } from '../directory';
import { Button, EmptyState, Field } from './components/ui';

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
 * retired stays marked, because the directory it searches does not know.
 */

interface RetiredWorkspace { workspace: DirectoryWorkspace; receipt: WorkspaceRetirementResult; at: string }

async function responseBody<Result>(response: Response, parse: (value: unknown) => Result): Promise<Result> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || body === null) {
    const failure = body as { error?: string; message?: string } | null;
    throw new Error(failure?.message ?? failure?.error ?? `Request failed (${response.status})`);
  }
  return parse(body);
}

function plural(count: number, noun: string, nouns = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : nouns}`;
}

export function WorkspacesView(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DirectoryWorkspace[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<DirectoryWorkspace | null>(null);
  const [confirmation, setConfirmation] = useState('');
  const [retiring, setRetiring] = useState(false);
  const [error, setError] = useState('');
  const [retired, setRetired] = useState<Map<string, RetiredWorkspace>>(new Map());

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); setSearchError(''); setSearched(false); return undefined; }
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      void fetch(`/api/directory/workspaces?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal })
        .then((response) => responseBody(response, (value) => (value as { results?: DirectoryWorkspace[] }).results ?? []))
        .then((next) => { setResults(next); setSearchError(''); setSearched(true); })
        .catch((caught: unknown) => {
          if (controller.signal.aborted) return;
          // Not "no matches": the previous query's rows would otherwise sit
          // under a new query, and a workspace picked from them is the wrong one.
          setResults([]);
          setSearched(true);
          setSearchError(caught instanceof Error ? caught.message : 'The directory could not be searched.');
        })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 180);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  const confirmed = useMemo(() => selected !== null && confirmation.trim() === selected.id, [confirmation, selected]);
  const selectedRetired = selected ? retired.get(selected.id) ?? null : null;

  const retire = async (): Promise<void> => {
    if (!selected || !confirmed || selectedRetired) return;
    setRetiring(true); setError('');
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(selected.id)}/retire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: selected.region, confirmWorkspaceId: confirmation.trim() }),
      });
      const receipt = await responseBody(response, (value) => WorkspaceRetirementResultSchema.parse(value));
      if (receipt.complete) {
        setRetired((current) => new Map(current).set(selected.id, { workspace: selected, receipt, at: new Date().toISOString() }));
      } else {
        setError(`${receipt.remaining} of the workspace's objects are still open${receipt.failed.length > 0 ? `: ${receipt.failed.map((node) => `${node.parentKind} ${node.parentId} (${node.error})`).join(', ')}` : ''}. Retire again to return to what remains.`);
      }
      setConfirmation('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The workspace could not be retired.');
    } finally { setRetiring(false); }
  };

  return <>
    <aside className="queue-list workspace-list"><header><p>Operator tools</p><h1>Workspaces</h1><small>Find a workspace by name or slug</small></header>
      <div className="queue-list-actions"><Field label="Search"><input placeholder="Alto Capital-demo" value={query} onChange={(event) => setQuery(event.target.value)} /></Field></div>
      {searchError && <p className="queue-error" role="alert">{searchError}</p>}
      <div className="queues workspaces">
        {results.map((workspace) => <button className={`${selected?.id === workspace.id ? 'selected' : ''}${retired.has(workspace.id) ? ' retired' : ''}`} key={`${workspace.region}:${workspace.id}`} onClick={() => { setSelected(workspace); setConfirmation(''); setError(''); }} type="button">
          <span className="queue-count">{workspace.region.toUpperCase()}</span>
          <div><strong>{workspace.name}</strong><small>{retired.has(workspace.id) ? 'Retired' : workspace.slug}</small></div>
          <b>›</b>
        </button>)}
        {searched && !searching && !searchError && results.length === 0 && <EmptyState title="No workspaces match" description="Search by the workspace's name or slug." />}
      </div>
      <footer><span className={searchError ? 'status-dot' : 'healthy-dot'} />{searchError ? 'Directory search failed' : searched ? 'Both regions searched' : 'Type to search both regions'}</footer>
    </aside>
    <main className="queue-detail workspace-detail">
      {selected ? <>
        <header className="queue-detail-header"><div><p>{selectedRetired ? `Retired ${new Date(selectedRetired.at).toLocaleString()}` : selected.region === 'eu' ? 'EU workspace' : 'Global workspace'}</p><h2>{selected.name}</h2><code>{selected.id}</code></div></header>
        <section className="queue-messages">
          {selectedRetired
            ? <section className="queue-source demo-receipt" role="status" aria-label="Retirement result">
              <span>Retired</span>
              <div>
                <p className="demo-receipt-title"><strong>{selectedRetired.workspace.name}</strong> <code className="demo-id">{selectedRetired.receipt.workspaceId}</code></p>
              </div>
              <p>Closed {plural(selectedRetired.receipt.retiredParents, 'work stream or automation', 'work streams and automations')} and {plural(selectedRetired.receipt.retiredChildren, 'conversation')} under them. {selectedRetired.receipt.retainedOutbox === 0 ? 'Nothing was left queued.' : `${plural(selectedRetired.receipt.retainedOutbox, 'queued effect')} will never publish.`} Messages, files and members were not deleted; nothing in this workspace answers any more.</p>
            </section>
            : <>
              <div className="section-title"><div><h3>Retire this workspace</h3><p>Every room, automation and socket in it closes and nothing reopens. Messages, files and members are kept but unreachable. A demo is retired the same way as any other workspace.</p></div></div>
              <div className="demo-form retire-form">
                <p className="retire-consequence">This cannot be undone. Type or paste the workspace id shown above to confirm that <strong>{selected.name}</strong> is the workspace to close.</p>
                <Field label="Workspace id"><input aria-describedby="retire-hint" autoComplete="off" placeholder="Paste the workspace id" spellCheck={false} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></Field>
                <p className="demo-form-note" id="retire-hint">The button enables only when the id matches exactly.</p>
                {error && <p className="queue-error" role="alert">{error}</p>}
                <div className="demo-form-actions"><Button disabled={!confirmed || retiring} onClick={() => void retire()} type="button" variant="danger">{retiring ? 'Retiring…' : 'Retire workspace'}</Button></div>
              </div>
            </>}
        </section>
      </>
      : <div className="queue-detail-empty"><EmptyState title="Select a workspace" description="Search on the left. Retirement asks you to type the workspace id before it closes anything." /></div>}
    </main>
  </>;
}
