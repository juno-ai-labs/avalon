import { IconPlayerPause } from '@tabler/icons-react';
import { Plus } from 'lucide-react';
import { AutomationGlyph, resolveWorkstreamAppearance } from '../components/workstream-glyph';
import { SidebarSearch } from '../components/sidebar-search';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAppSession } from '../lib/app-session';
import { useShellCapabilities } from '../lib/collaboration-session';
import { SIDEBAR_LIST_QUERY_KEYS, useSocketOwnedList } from '../lib/sidebar-list-store';
import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';
import { AvatarStack, EmptyState, ErrorNotice, OpeningState } from '../components/primitives';
import { PushedListPending } from '../components/pushed-list-pending';
import { sidekickNext, sidekickStatus } from '../lib/sidekick-status';
import type { AutomationSummary, WorkspaceMember } from '../lib/types';
import { useDocumentTitle } from '../lib/document-title';
import { useWorkspaceMembers } from '../lib/workspace-members';

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

function sharedWith(item: AutomationSummary, membersById: ReadonlyMap<string, WorkspaceMember>): React.ReactNode {
  if (item.audience !== 'people') return item.scope === 'you' ? 'Only you' : 'Organization';
  const ids = item.sharedWithUserIds ?? [];
  if (ids.length === 0) return 'People';
  const members = ids.flatMap((id) => {
    const member = membersById.get(id);
    return member ? [member] : [];
  });
  if (members.length === 0) return ids.length === 1 ? '1 person' : `${ids.length} people`;

  const missing = ids.length - members.length;
  const names = members.map((member) => member.name);
  if (missing > 0) names.push(`and ${missing} more`);
  const limit = 4;
  return <span aria-label={names.join(', ')} role="img">
    <AvatarStack members={members} limit={limit} extraCount={ids.length - Math.min(members.length, limit)} />
  </span>;
}

/**
 * `/sidekicks`: the Canvas dashboard’s card layout, with each Sidekick’s
 * hexagon, status, sharing and next wake. Search and ownership chips come
 * from the old library. Both hosts use the same live directory.
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
  const { data: members } = useWorkspaceMembers(api, {
    enabled: items.some((item) => item.audience === 'people' && item.sharedWithUserIds?.length),
  });
  const membersById = new Map(members?.map((member) => [member.id, member]));
  const newSidekick = <Link className="button button-primary window-no-drag" to="/sidekicks/new"><Plus aria-hidden="true" size={16} />New Sidekick</Link>;
  return <main className="sidekicks-library dashboard-home">
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
      <ul className="dashboard-grid">{items.map((item) => <SidekickCard item={item} key={item.id} membersById={membersById} />)}</ul>}
    </section>
  </main>;
}

/** The whole card is one link, so hovering an avatar can show a name and clicking it still opens the Sidekick. */
function SidekickCard({ item, membersById }: { item: AutomationSummary; membersById: ReadonlyMap<string, WorkspaceMember> }): React.JSX.Element {
  const { tint } = resolveWorkstreamAppearance(item.id, item.appearance ?? undefined);
  return <li className="dashboard-card">
    <Link aria-label={item.name} className="dashboard-card-link sidekick-card-link" to={`/sidekicks/${encodeURIComponent(item.id)}`}>
      <div className="dashboard-card-preview" style={{ background: `color-mix(in srgb, ${tint} 45%, var(--av-sys-color-surface-raised))` }}>
        <span className="sidekick-card-glyph"><AutomationGlyph {...(item.appearance ? { appearance: item.appearance } : {})} id={item.id} /></span>
        {item.status === 'paused' && <span className="sidekick-card-status"><span className="sidekick-status-pill is-paused"><IconPlayerPause aria-hidden="true" size={13} stroke={1.8} />Paused</span></span>}
        {sidekickStatus(item) === 'needs_input' && <span className="sidekick-needs-input-badge">Needs input</span>}
      </div>
      <div className="sidekick-card-body">
        <h3>{item.name}</h3>
        <p>{item.description}</p>
        <dl className="sidekick-card-facts">
          <div><dt>Shared with</dt><dd>{sharedWith(item, membersById)}</dd></div>
          <div><dt>Next</dt><dd>{sidekickNext(item)}</dd></div>
        </dl>
      </div>
    </Link>
  </li>;
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
  useDocumentTitle('Sidekicks');
  return guest ? <GuestSidekicksLibrary /> : <SidekicksLibraryScreen />;
}
