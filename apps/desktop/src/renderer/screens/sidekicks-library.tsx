import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAppSession } from '../lib/app-session';
import { EmptyState, InlineError, OpeningState } from '../components/primitives';

export function SidekicksLibraryScreen(): React.JSX.Element {
  const { api } = useAppSession();
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('all');
  const query = useQuery({ queryKey: ['sidekicks-library'], queryFn: ({ signal }) => api!.getSidekicks(signal), enabled: Boolean(api) });
  const items = (query.data ?? []).filter((item) =>
    (scope === 'all' || item.scope === scope)
    && `${item.name} ${item.description}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return <main className="sidekicks-library">
    <header className="window-drag"><h1>Sidekicks</h1><p>Delegate work or knowledge.</p></header>
    <div className="sidekicks-library-controls">
      <input aria-label="Search Sidekicks" placeholder="Search Sidekicks" value={search} onChange={(event) => setSearch(event.target.value)} />
      <select aria-label="Sidekick ownership" value={scope} onChange={(event) => setScope(event.target.value)}>
        <option value="all">Everyone</option><option value="you">Only you</option><option value="workspace">Workspace</option><option value="workstream">Work streams</option>
      </select>
      <Link className="button button-primary" to="/sidekicks/new">New Sidekick</Link>
    </div>
    {query.isLoading ? <OpeningState label="Loading Sidekicks…" /> : query.error ? <InlineError>{query.error.message}</InlineError> : items.length === 0 ? <EmptyState title="No Sidekicks yet" description="Describe what you would like to delegate to create one." /> :
      <ul className="sidekicks-library-list">{items.map((item) => <li key={item.id}><Link to={`/sidekicks/${item.id}`}>
        <h2>{item.name}</h2><p>{item.description}</p><small>{item.status === 'draft' ? 'Draft' : item.status === 'paused' ? 'Paused' : item.loadable ? 'Available in conversations' : 'Delegated work'}</small>
      </Link></li>)}</ul>}
  </main>;
}
