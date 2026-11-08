import type { CanvasSidebarRow } from '@rally/contracts';
import { Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { CanvasMark } from '../components/canvas-mark';
import { AvatarStack, Button, EmptyState, ErrorNotice, TitleSkeleton } from '../components/primitives';
import { PushedListPending } from '../components/pushed-list-pending';
import { RelativeTime } from '../components/relative-time';
import { SidebarSearch } from '../components/sidebar-search';
import { canvasNaming, canvasRoute, canvasRowDetail, othersPresent, useCanvasList, useCanvasNameSources, useCreateCanvas } from '../lib/canvases';
import { useCollaborationSession, useShellCapabilities } from '../lib/collaboration-session';
import { formatSidebarActivityTime } from '../lib/format';

type CanvasFilter = 'all' | 'mine' | 'shared' | 'sidekicks';

const FILTERS: ReadonlyArray<readonly [CanvasFilter, string]> = [
  ['all', 'Everyone'],
  ['mine', 'Made by me'],
  ['shared', 'Shared with me'],
  ['sidekicks', 'From Sidekicks'],
];

function matchesFilter(row: CanvasSidebarRow, filter: CanvasFilter, currentUserId: string | undefined): boolean {
  switch (filter) {
    case 'all': return true;
    case 'mine': return row.createdByUserId === currentUserId;
    case 'shared': return row.sharedWithMe;
    case 'sidekicks': return row.writerSidekickId !== null;
  }
}

/**
 * `/canvases`: every Canvas this person can open, the list the workspace
 * socket keeps (`workspace_canvas_list`), laid out as the Sidekicks library is.
 * The people in a Canvas now lift it into Live now; the rest are Recent, most
 * recently active first. With none at all, the page is only how to make one.
 */
export function CanvasesHomeScreen(): React.JSX.Element {
  const { api, session } = useCollaborationSession();
  const { guest } = useShellCapabilities();
  const currentUserId = session?.user.id;
  const rows = useCanvasList();
  const { membersById, sidekicksById } = useCanvasNameSources(api);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CanvasFilter>('all');
  const create = useCreateCanvas();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<Error | null>(null);
  const start = (prompt?: string): void => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    create(prompt).catch((cause: unknown) => setCreateError(cause instanceof Error ? cause : new Error('The Canvas could not be made.'))).finally(() => setCreating(false));
  };
  const needle = search.trim().toLocaleLowerCase();
  const shown = (rows ?? []).filter((row) => matchesFilter(row, filter, currentUserId)
    && (needle === '' || row.title.toLocaleLowerCase().includes(needle)));
  const live = shown.filter((row) => othersPresent(row, currentUserId).length > 0);
  const recent = shown.filter((row) => othersPresent(row, currentUserId).length === 0);
  const row = (canvas: CanvasSidebarRow): React.JSX.Element => {
    const present = othersPresent(canvas, currentUserId).flatMap((userId) => {
      const member = membersById.get(userId);
      return member ? [member] : [];
    });
    return <li key={canvas.id}>
      <span className="canvas-list-mark"><CanvasMark kind={canvas.artifactKind} size={44} /></span>
      <div className="sidekick-list-copy">
        <h3><Link className="sidekick-list-link" to={canvasRoute(canvas.id)}>{canvasNaming(canvas) ? <TitleSkeleton /> : canvas.title}</Link></h3>
        <small>{canvasRowDetail(canvas, membersById, sidekicksById, currentUserId)} · <RelativeTime format={formatSidebarActivityTime} value={canvas.updatedAt} /></small>
      </div>
      {present.length > 0 && <span className="canvas-list-present"><AvatarStack members={present} nameTooltip={false} showTooltip={false} /><span className="canvas-live-badge">Live</span></span>}
    </li>;
  };
  // A guest makes no Canvas (`canvas_create_member_required`), so is offered none.
  const newCanvas = guest ? null : <Button className="button-primary" disabled={creating} onClick={() => start()}>
    <Plus aria-hidden="true" size={16} />New Canvas
  </Button>;
  return <main className="sidekicks-library canvases-home">
    <header className="sidekicks-library-heading window-drag">
      <div><h1>Canvases</h1><p>Pages your team and Rally make together.</p></div>
      <div className="sidekicks-library-actions window-no-drag">{newCanvas}</div>
    </header>
    {createError && <ErrorNotice occurrence={createError}>{createError.message}</ErrorNotice>}
    {rows === undefined ? <PushedListPending label="Loading Canvases…" noun="Canvases" />
      : rows.length === 0 ? <CanvasesEmptyState creating={creating} guest={guest} onStart={start} />
        : <>
          <div className="sidekicks-library-controls">
            <SidebarSearch aria-label="Search Canvases" mode="input" onChange={(event) => setSearch(event.target.value)} placeholder="Search Canvases" value={search} />
          </div>
          <div aria-label="Canvas filter" className="sidekick-filters" role="group">
            {FILTERS.map(([value, label]) => <button aria-pressed={filter === value} key={value} onClick={() => setFilter(value)} type="button">{label}</button>)}
          </div>
          {live.length > 0 && <section aria-labelledby="canvases-live-title" className="canvases-home-group">
            <div className="sidekick-results-heading"><h2 id="canvases-live-title">Live now</h2><span>{`${live.length} ${live.length === 1 ? 'Canvas' : 'Canvases'}`}</span></div>
            <ul className="sidekicks-library-list canvases-home-list">{live.map(row)}</ul>
          </section>}
          <section aria-labelledby="canvases-recent-title" className="canvases-home-group">
            <div className="sidekick-results-heading"><h2 id="canvases-recent-title">{needle ? 'Search results' : 'Recent'}</h2><span>{`${recent.length} ${recent.length === 1 ? 'Canvas' : 'Canvases'}`}</span></div>
            {recent.length === 0
              ? <EmptyState description="Try a different search or filter." title={live.length > 0 ? 'Nothing else here' : 'No matching Canvases'} />
              : <ul className="sidekicks-library-list canvases-home-list">{recent.map(row)}</ul>}
          </section>
        </>}
  </main>;
}

/**
 * A first-run Canvases page: New Canvas, and a card that starts one from a
 * prompt, which becomes the Chat's first message.
 */
function CanvasesEmptyState({ creating, guest, onStart }: {
  creating: boolean;
  guest: boolean;
  onStart: (prompt?: string) => void;
}): React.JSX.Element {
  const [prompt, setPrompt] = useState('');
  if (guest) return <EmptyState description="A Canvas someone shares with you appears here." title="No Canvases yet" />;
  return <section aria-label="Start from a prompt" className="canvas-prompt-card">
    <h2><Sparkles aria-hidden="true" size={16} />Start from a prompt</h2>
    <p>Say what you want to make, and Rally starts it in a new Canvas.</p>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (prompt.trim()) onStart(prompt);
    }}>
      <textarea aria-label="Prompt" disabled={creating} onChange={(event) => setPrompt(event.target.value)} placeholder="A tracker for our Q1 hiring plan" rows={3} value={prompt} />
      <Button className="button-primary" disabled={creating || !prompt.trim()} type="submit">{creating ? 'Starting…' : 'Start'}</Button>
    </form>
  </section>;
}
