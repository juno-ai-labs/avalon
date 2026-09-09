import { ChevronRight, Plus } from 'lucide-react';
import { AutomationGlyph } from '../components/workstream-glyph';
import { SidebarSearch } from '../components/sidebar-search';
import { desktopBridge } from '../lib/platform';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useAppSession } from '../lib/app-session';
import { useOpenFirstWorkstream } from '../lib/workstream-landing';
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
    <header className="sidekicks-library-heading window-drag"><div><h1>Sidekicks</h1><p>A little help that knows how you work.</p></div><Link className="button button-primary window-no-drag" to="/sidekicks/new"><Plus aria-hidden="true" size={16} />New Sidekick</Link></header>
    <div className="sidekicks-library-controls">
      <SidebarSearch mode="input" aria-label="Search Sidekicks" placeholder="Search Sidekicks" value={search} onChange={(event) => setSearch(event.target.value)} />
    </div>
    <div className="sidekick-filters" role="group" aria-label="Sidekick ownership">
      {([['all', 'Everyone'], ['you', 'Only you'], ['workspace', 'Workspace'], ['workstream', 'Work streams']] as const).map(([value, label]) =>
        <button key={value} type="button" aria-pressed={scope === value} onClick={() => setScope(value)}>{label}</button>)}
    </div>
    <section aria-labelledby="sidekick-results-title">
    <div className="sidekick-results-heading"><h2 id="sidekick-results-title">{search ? 'Search results' : 'Your Sidekicks'}</h2><span role="status" aria-label="Sidekick count">{query.isSuccess ? `${items.length} Sidekicks` : ''}</span></div>
    {query.isLoading ? <OpeningState label="Loading Sidekicks…" /> : query.error ? <InlineError>{query.error.message}</InlineError> : items.length === 0 ? <EmptyState title={query.data?.length ? "No matching Sidekicks" : "No Sidekicks yet"} description={query.data?.length ? "Try a different search or ownership filter." : "Describe what you would like to delegate to create one."} /> :
      <ul className="sidekicks-library-list">{items.map((item) => <li key={item.id}><Link to={`/sidekicks/${item.id}`}>
        <span className="sidekick-list-glyph"><AutomationGlyph id={item.id} /></span>
        <div className="sidekick-list-copy"><h3>{item.name}</h3><p>{item.description}</p><small>{item.status === 'draft' ? 'Draft' : item.status === 'paused' ? 'Paused' : item.loadable ? 'Available in conversations' : 'Delegated work'} · {item.scope === 'you' ? 'Only you' : item.scope === 'workspace' ? 'Workspace' : 'Work stream'}</small></div>
        <ChevronRight className="sidekick-list-chevron" aria-hidden="true" size={18} />
      </Link></li>)}</ul>}
    </section>
  </main>;
}

/** Retained main-window links hand library navigation to its dedicated window. */
export function SidekicksWindowRedirect(): React.JSX.Element {
  const openFirstWorkstream = useOpenFirstWorkstream();
  useEffect(() => {
    void desktopBridge().openSidekicks().then(() => openFirstWorkstream());
  }, [openFirstWorkstream]);
  return <OpeningState label="Opening Sidekicks…" />;
}
