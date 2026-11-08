import { ChevronRight, Plus } from 'lucide-react';
import { AutomationGlyph } from '../components/workstream-glyph';
import { SidebarSearch } from '../components/sidebar-search';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAppSession } from '../lib/app-session';
import { useShellCapabilities } from '../lib/collaboration-session';
import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList } from '../lib/sidebar-list-store';
import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';
import { EmptyState, ErrorNotice, OpeningState } from '../components/primitives';
import { PushedListPending } from '../components/pushed-list-pending';
import { formatNextRun, sidekickStatus, type SidekickStatus } from '../lib/sidekick-status';
import type { AutomationSummary } from '../lib/types';

type SidekickFilter = 'all' | 'you' | 'workspace' | 'paused';

const FILTERS: ReadonlyArray<readonly [SidekickFilter, string]> = [
  ['all', 'Everyone'],
  ['you', 'Only you'],
  ['workspace', 'Organization'],
  ['paused', 'Paused'],
];

function matchesFilter(item: AutomationSummary, filter: SidekickFilter): boolean {
  switch (filter) {
    case 'all': return true;
    // A Sidekick shared with named people is stored personal, but it is not only its author's.
    case 'you': return item.scope === 'you' && item.audience !== 'people';
    case 'workspace': return item.scope === 'workspace';
    case 'paused': return item.status === 'paused';
  }
}

/**
 * The Status column's pill, as design.html §3 colours it. Waiting on someone is
 * the badge beside the name, so that row's pill says what it is otherwise.
 */
const STATUS_PILL: Record<SidekickStatus, string> = {
  needs_input: 'Active',
  working: 'Working',
  paused: 'Paused',
  draft: 'Draft',
  active: 'Active',
};

function StatusPill({ item }: { item: AutomationSummary }): React.JSX.Element {
  const status = sidekickStatus(item);
  const tone = status === 'needs_input' ? 'active' : status;
  return <span className={`sidekick-status-pill is-${tone}`}>
    {status === 'working' && <span aria-hidden="true" className="sidekick-working-dot" />}
    {STATUS_PILL[status]}
  </span>;
}

function sharedWithLabel(item: AutomationSummary): string {
  if (item.audience === 'people') return 'Named people';
  return item.scope === 'you' ? 'Only you' : 'Organization';
}

/**
 * `/sidekicks`: every Sidekick this person can open, as rows saying where it
 * stands, who it is shared with and when it next wakes, with the ownership
 * chips and a search. It renders in the main window on both hosts.
 */
export function SidekicksLibraryScreen(): React.JSX.Element {
  const { api } = useAppSession();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<SidekickFilter>('all');
  // The main window reads the list the workspace socket keeps: only its rows
  // carry the viewer's `needsInput` and `unread`, which `GET /sidekicks` never
  // does. REST remains only for a tree with no workspace socket mounted.
  const socket = useOptionalWorkspaceSocket();
  const pushed = useSocketOwnedList<AutomationSummary[]>(SIDEBAR_LIST_QUERY_KEYS.automations);
  const fetched = useQuery({ queryKey: ['sidekicks-library'], queryFn: ({ signal }) => api!.getSidekicks(signal), enabled: Boolean(api) && !socket });
  const query = socket
    ? { data: pushed.data, isLoading: pushed.data === undefined, isSuccess: pushed.data !== undefined, error: null }
    : fetched;
  const items = (query.data ?? []).filter((item) =>
    matchesFilter(item, filter)
    && `${item.name} ${item.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const newSidekick = <Link className="button button-primary window-no-drag" to="/sidekicks/new"><Plus aria-hidden="true" size={16} />New Sidekick</Link>;
  return <main className="sidekicks-library">
    <header className="sidekicks-library-heading window-drag"><div><h1>Sidekicks</h1><p>AI teammates your whole team can talk to.</p></div><div className="sidekicks-library-actions">{newSidekick}</div></header>
    <div className="sidekicks-library-controls">
      <SidebarSearch mode="input" aria-label="Search Sidekicks" placeholder="Search Sidekicks" value={search} onChange={(event) => setSearch(event.target.value)} />
    </div>
    <div className="sidekick-filters" role="group" aria-label="Sidekick ownership">
      {FILTERS.map(([value, label]) =>
        <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
    </div>
    <section aria-labelledby="sidekick-results-title">
    <div className="sidekick-results-heading"><h2 id="sidekick-results-title">{search ? 'Search results' : 'Your Sidekicks'}</h2><span role="status" aria-label="Sidekick count">{query.isSuccess ? `${items.length} ${items.length === 1 ? 'Sidekick' : 'Sidekicks'}` : ''}</span></div>
    {query.isLoading ? (socket ? <PushedListPending label="Loading Sidekicks…" noun="Sidekicks" /> : <OpeningState label="Loading Sidekicks…" />) : query.error ? <ErrorNotice occurrence={query.error}>{query.error.message}</ErrorNotice> : items.length === 0 ? <EmptyState action={query.data?.length ? undefined : newSidekick} title={query.data?.length ? "No matching Sidekicks" : "No Sidekicks yet"} description={query.data?.length ? "Try a different search or ownership filter." : "Describe what you would like to delegate to create one."} /> :
      // The row's link is its title, stretched over the whole card in CSS.
      <ul className="sidekicks-library-list sidekicks-library-rows">{items.map((item) => <li key={item.id}>
        <span className="sidekick-list-glyph"><AutomationGlyph {...(item.appearance ? { appearance: item.appearance } : {})} id={item.id} /></span>
        <div className="sidekick-list-copy"><h3><Link className="sidekick-list-link" to={`/sidekicks/${item.id}`}>{item.name}</Link>{sidekickStatus(item) === 'needs_input' && <span className="sidekick-needs-input-badge">Needs input</span>}</h3><p>{item.description}</p></div>
        <dl className="sidekick-list-facts">
          <div><dt>Status</dt><dd><StatusPill item={item} /></dd></div>
          <div><dt>Shared with</dt><dd>{sharedWithLabel(item)}</dd></div>
          <div><dt>Next</dt><dd>{item.status === 'active' && item.nextRunAt ? formatNextRun(item.nextRunAt) : '—'}</dd></div>
        </dl>
        <ChevronRight className="sidekick-list-chevron" aria-hidden="true" size={18} />
      </li>)}</ul>}
    </section>
  </main>;
}

function GuestSidekicksLibrary(): React.JSX.Element {
  return <main className="sidekicks-library">
    <header className="sidekicks-library-heading window-drag"><div><h1>Sidekicks</h1></div></header>
    <EmptyState title="Sidekicks open from conversations" description="Open a Sidekick from a conversation shared with you to see it here." />
  </main>;
}

/** The main window's `/sidekicks`, on both hosts. */
export function SidekicksLibraryRoute(): React.JSX.Element {
  const { guest } = useShellCapabilities();
  return guest ? <GuestSidekicksLibrary /> : <SidekicksLibraryScreen />;
}
