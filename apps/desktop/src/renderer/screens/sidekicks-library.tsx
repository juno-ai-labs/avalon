import { ChevronRight, Plus } from 'lucide-react';
import { AutomationScreen } from './automation';
import { SpeechPlaybackProvider } from '../components/speech-playback';
import { useEscapeClosesWindow } from '../lib/window-escape';
import { AutomationGlyph } from '../components/workstream-glyph';
import { SidebarSearch } from '../components/sidebar-search';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HashRouter, Link, Navigate, Route, Routes } from 'react-router-dom';
import { useAppSession } from '../lib/app-session';
import { useShellCapabilities } from '../lib/collaboration-session';
import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList } from '../lib/sidebar-list-store';
import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';
import { EmptyState, ErrorNotice, OpeningState } from '../components/primitives';
import { RelativeTime } from '../components/relative-time';
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

function statusLabel(item: AutomationSummary): string {
  if (item.needsInput) return 'Needs input';
  return item.status === 'draft' ? 'Draft' : item.status === 'paused' ? 'Paused' : 'Active';
}

function sharedWithLabel(item: AutomationSummary): string {
  if (item.audience === 'people') return 'Named people';
  return item.scope === 'you' ? 'Only you' : 'Organization';
}

/**
 * `/sidekicks`: every Sidekick this person can open, as rows saying where it
 * stands, who it is shared with and when it next wakes, with the ownership
 * chips and a search. It renders in the main window on both hosts, and in the
 * separate Sidekicks window until that window is removed (plan step B-2).
 */
export function SidekicksLibraryScreen(): React.JSX.Element {
  const { api } = useAppSession();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<SidekickFilter>('all');
  // The main window reads the list the workspace socket keeps: only its rows
  // carry the viewer's `needsInput` and `unread`, which `GET /sidekicks` never
  // does. REST remains only for a tree with no workspace socket mounted.
  const socket = useOptionalWorkspaceSocket();
  const pushed = useSocketOwnedList<AutomationSummary>(SIDEBAR_LIST_QUERY_KEYS.automations);
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
    <header className="sidekicks-library-heading window-drag"><div><h1>Sidekicks</h1><p>A little help that knows how you work.</p></div><div className="sidekicks-library-actions">{newSidekick}</div></header>
    <div className="sidekicks-library-controls">
      <SidebarSearch mode="input" aria-label="Search Sidekicks" placeholder="Search Sidekicks" value={search} onChange={(event) => setSearch(event.target.value)} />
    </div>
    <div className="sidekick-filters" role="group" aria-label="Sidekick ownership">
      {FILTERS.map(([value, label]) =>
        <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}
    </div>
    <section aria-labelledby="sidekick-results-title">
    <div className="sidekick-results-heading"><h2 id="sidekick-results-title">{search ? 'Search results' : 'Your Sidekicks'}</h2><span role="status" aria-label="Sidekick count">{query.isSuccess ? `${items.length} Sidekicks` : ''}</span></div>
    {query.isLoading ? <OpeningState label="Loading Sidekicks…" /> : query.error ? <ErrorNotice occurrence={query.error}>{query.error.message}</ErrorNotice> : items.length === 0 ? <EmptyState action={query.data?.length ? undefined : newSidekick} title={query.data?.length ? "No matching Sidekicks" : "No Sidekicks yet"} description={query.data?.length ? "Try a different search or ownership filter." : "Describe what you would like to delegate to create one."} /> :
      // The row's link is its title, stretched over the whole card in CSS.
      <ul className="sidekicks-library-list sidekicks-library-rows">{items.map((item) => <li key={item.id}>
        <span className="sidekick-list-glyph"><AutomationGlyph {...(item.appearance ? { appearance: item.appearance } : {})} id={item.id} /></span>
        <div className="sidekick-list-copy"><h3><Link className="sidekick-list-link" to={`/sidekicks/${item.id}`}>{item.name}</Link></h3><p>{item.description}</p></div>
        <dl className="sidekick-list-facts">
          <div><dt>Status</dt><dd>{statusLabel(item)}</dd></div>
          <div><dt>Shared with</dt><dd>{sharedWithLabel(item)}</dd></div>
          <div><dt>Next</dt><dd>{item.status === 'active' && item.nextRunAt ? <RelativeTime value={item.nextRunAt} /> : '—'}</dd></div>
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

/**
 * The main window's `/sidekicks`, in place on both hosts: the Mac app no
 * longer hands it to the Sidekicks window, whose own entry still works until
 * that window is removed (plan step B-2).
 */
export function SidekicksLibraryRoute(): React.JSX.Element {
  const { guest } = useShellCapabilities();
  return guest ? <GuestSidekicksLibrary /> : <SidekicksLibraryScreen />;
}

/**
 * The Sidekicks window's own routes.
 *
 * Here rather than beside the other surfaces in `App`, because the gesture below
 * only makes sense against these screens and is worth a test that renders them.
 *
 * Nothing is swept for unsaved text. The one writing surface in here is a
 * Sidekick's conversation composer, and its text and attachments are cached on
 * the device and restored on the next visit, so closing the window costs no
 * sentence; a sweep would only leave Escape dead in every Sidekick that holds a
 * draft. The library's search box still holds the keystroke while it has text,
 * where Escape clears the filter first.
 */
export function SidekicksWindow(): React.JSX.Element {
  const { api } = useAppSession();
  // A guest opens the Sidekicks a conversation offers them, one at a time. The
  // library lists the Organization's and creation makes one there; both routes
  // refuse a guest, so this window offers neither.
  const { guest } = useShellCapabilities();
  useEscapeClosesWindow();
  return (
    <SpeechPlaybackProvider api={api!}>
      <HashRouter useTransitions={false}>
        <Routes>
          <Route element={guest ? <GuestSidekicksLibrary /> : <SidekicksLibraryScreen />} path="/sidekicks" />
          {guest && <Route element={<Navigate replace to="/sidekicks" />} path="/sidekicks/new" />}
          <Route element={<AutomationScreen />} path="/sidekicks/:id" />
          <Route element={<AutomationScreen />} path="/automations/:id" />
          <Route element={<Navigate replace to="/sidekicks" />} path="*" />
        </Routes>
      </HashRouter>
    </SpeechPlaybackProvider>
  );
}
