import type { CanvasSidebarRow } from '@rally/contracts';
import { CANVAS_FILTERS, ELSEWHERE_CANVAS_FACTS, canvasFilterFacts, isReactiveCanvas, matchesCanvasFilter, type CanvasFilter } from '@rally/contracts/canvas-filters';
import { IconBolt, IconDatabase, IconHexagon } from '@tabler/icons-react';
import { SidekickStack } from '@rally/ui/components/sidekick-stack';
import { ChevronLeft, Plus, Sparkles, Store } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { canvasMark } from '../components/canvas-mark';
import { OrganizationCardBadge, sharedFromLabel, useOpenOtherOrganizationCanvas } from '../components/other-organization-canvas';
import { CanvasTemplateCard } from '../components/canvas-template-picker';
import { CanvasSharingStatus } from '../components/canvas-sharing-status';
import { AvatarStack, Button, EmptyState, TitleSkeleton } from '../components/primitives';
import { PushedListPending } from '../components/pushed-list-pending';
import { RelativeTime } from '../components/relative-time';
import { SidebarSearch } from '../components/sidebar-search';
import { CANVAS_TEMPLATE_CATEGORIES } from '../lib/canvas-template-categories';
import { CANVAS_TEMPLATES } from '../lib/canvas-templates';
import { canvasNaming, canvasRoute, othersPresent, useCanvasList, useCanvasNameSources, useCreateCanvas } from '../lib/canvases';
import { useCollaborationSession, useShellCapabilities } from '../lib/collaboration-session';
import { useDocumentTitle } from '../lib/document-title';
import { formatSidebarActivityTime } from '../lib/format';
import { useOtherOrganizationCanvases, type OtherOrganizationCanvas } from '../lib/shared-canvases';

/** A card: one of this Organization's Canvases, or one shared from another. */
type HomeCard = { kind: 'own'; row: CanvasSidebarRow } | { kind: 'shared'; item: OtherOrganizationCanvas };

function cardDate(card: HomeCard): string {
  return card.kind === 'own' ? card.row.updatedAt : card.item.canvas.updatedAt;
}

function cardTitle(card: HomeCard): string {
  return card.kind === 'own' ? card.row.title : card.item.canvas.title;
}

/**
 * `/canvases`: every Canvas this person can open, the list the workspace
 * socket keeps (`workspace_canvas_list`), laid out as the Sidekicks library is,
 * with the Canvases shared with them in their other Organizations among them
 * (`workspace_shared_canvases`, `docs/canvas-share-federation.md`).
 * Canvases stay in activity order; Live and Data match their card badges.
 * Members can start a Canvas from the Marketplace even before their list arrives.
 */
export function CanvasesHomeScreen(): React.JSX.Element {
  const { api, session } = useCollaborationSession();
  const { guest } = useShellCapabilities();
  const currentUserId = session?.user.id;
  const rows = useCanvasList();
  const elsewhere = useOtherOrganizationCanvases();
  const openElsewhere = useOpenOtherOrganizationCanvas();
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const showMarketplace = !guest && marketplaceOpen;
  useDocumentTitle(showMarketplace ? 'Marketplace' : 'Canvases');
  const { membersById } = useCanvasNameSources(api);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CanvasFilter>('all');
  const [draftPrompt, setDraftPrompt] = useState('');
  const create = useCreateCanvas();
  const needle = search.trim().toLocaleLowerCase();
  // This Organization's list is already in activity order; another's Canvas goes in by date.
  const cards: HomeCard[] = rows === undefined ? [] : elsewhere.length === 0 ? rows.map((row) => ({ kind: 'own', row }))
    : [...rows.map((row): HomeCard => ({ kind: 'own', row })), ...elsewhere.map((item): HomeCard => ({ kind: 'shared', item }))]
      .sort((a, b) => cardDate(b).localeCompare(cardDate(a)));
  const hasCanvases = cards.length > 0;
  const shown = cards.filter((card) => matchesCanvasFilter(card.kind === 'own' ? canvasFilterFacts(card.row, currentUserId) : ELSEWHERE_CANVAS_FACTS, filter)
    && (needle === '' || cardTitle(card).toLocaleLowerCase().includes(needle)));
  const sharedCard = ({ canvas, organization }: OtherOrganizationCanvas): React.JSX.Element => {
    const key = `${organization.region}:${organization.id}:${canvas.id}`;
    const { icon: Icon, ink, tint } = canvasMark(canvas.id, canvas.appearance);
    return <li className="dashboard-card" key={key}>
      <div aria-hidden="true" className="dashboard-card-preview" style={{ background: tint }}>
        <Icon aria-hidden="true" color={ink} size={44} />
        <span className="canvas-card-indicators"><OrganizationCardBadge id={`canvas-organization-${key}`} organization={organization} /></span>
      </div>
      <div className="canvas-card-body">
        {/* It opens in its own Organization, so it is a button that switches first. */}
        <h3><button aria-describedby={`canvas-organization-${key}`} className="dashboard-card-link" onClick={() => openElsewhere({ canvas, organization })} type="button">{canvas.title || 'Untitled canvas'}</button></h3>
        <small><span className="canvas-sharing-status">{sharedFromLabel(organization)}</span><RelativeTime format={formatSidebarActivityTime} value={canvas.updatedAt} /></small>
      </div>
    </li>;
  };
  const row = (canvas: CanvasSidebarRow): React.JSX.Element => {
    const present = othersPresent(canvas, currentUserId).flatMap((userId) => {
      const member = membersById.get(userId);
      return member ? [member] : [];
    });
    // A server older than attaching sends none.
    const attachedSidekicks = canvas.sidekicks ?? [];
    const reactive = isReactiveCanvas(canvas);
    const { icon: Icon, ink, tint } = canvasMark(canvas.id, canvas.appearance);
    return <li className="dashboard-card" key={canvas.id}>
      <div aria-hidden="true" className="dashboard-card-preview" style={{ background: tint }}>
        <Icon aria-hidden="true" color={ink} size={44} />
        {present.length > 0 && <span className="canvas-card-presence"><AvatarStack currentUserId={currentUserId} members={present} nameTooltip={false} presentUserIds={canvas.presentUserIds} showTooltip={false} /></span>}
        <span className="canvas-card-indicators">
          {reactive && <span className="canvas-card-badge" id={`canvas-reactive-${canvas.id}`}><IconBolt aria-hidden="true" size={16} stroke={1.9} />Reactive</span>}
          {canvas.hasStoredData && <span className="canvas-card-badge" id={`canvas-data-${canvas.id}`}><IconDatabase aria-hidden="true" size={16} stroke={1.9} />Data backed</span>}
          {attachedSidekicks.length > 0 && <Link className="canvas-card-badge canvas-card-sidekicks" tabIndex={-1} to={canvasRoute(canvas.id)}>
            <IconHexagon aria-hidden="true" size={16} stroke={1.9} />
            <SidekickStack id={`canvas-sidekicks-${canvas.id}`} sidekicks={attachedSidekicks} />
          </Link>}
        </span>
      </div>
      <div className="canvas-card-body">
        <h3><Link aria-describedby={[reactive ? `canvas-reactive-${canvas.id}` : null, canvas.hasStoredData ? `canvas-data-${canvas.id}` : null,
          attachedSidekicks.length > 0 ? `canvas-sidekicks-${canvas.id}` : null].filter(Boolean).join(' ') || undefined} className="dashboard-card-link" to={canvasRoute(canvas.id)}>{canvasNaming(canvas) ? <TitleSkeleton /> : canvas.title}</Link></h3>
        <small><CanvasSharingStatus canvas={canvas} currentUserId={currentUserId} /><RelativeTime format={formatSidebarActivityTime} value={canvas.updatedAt} /></small>
      </div>
    </li>;
  };
  // A guest makes no Canvas (`canvas_create_member_required`), so is offered none.
  const newCanvas = guest ? null : <Button className="button-primary canvases-home-new" onClick={() => create()}>
    <Plus aria-hidden="true" size={16} />New Canvas
  </Button>;
  // The Marketplace is a place, not a filter of this person's Canvases, so it
  // is opened from the header and replaces the page rather than adding a
  // second row of pills under the filters.
  return <main className="sidekicks-library dashboard-home">
    {showMarketplace ? <header className="sidekicks-library-heading canvases-home-heading window-drag">
      <div className="canvases-home-title">
        <button className="canvases-home-back window-no-drag" onClick={() => setMarketplaceOpen(false)} type="button"><ChevronLeft aria-hidden="true" size={16} />Canvases</button>
        <h1>Marketplace</h1><p>Templates to start a Canvas from. Pick one and Rally builds it with you.</p>
      </div>
      <div className="sidekicks-library-actions window-no-drag">{newCanvas}</div>
    </header> : <header className="sidekicks-library-heading canvases-home-heading window-drag">
      <div className="canvases-home-title is-collapsible"><h1>Canvases</h1><p>Reactive pages your team and Rally build together.</p></div>
      <div className="sidekicks-library-actions window-no-drag">
        {!guest && <Button className="button-secondary" onClick={() => setMarketplaceOpen(true)}><Store aria-hidden="true" size={16} />Marketplace</Button>}
        {newCanvas}
      </div>
    </header>}
    {hasCanvases && !showMarketplace && <div className="sidekicks-library-controls">
      <SidebarSearch aria-label="Search Canvases" mode="input" onChange={(event) => setSearch(event.target.value)} placeholder="Search Canvases" value={search} />
    </div>}
    {hasCanvases && !showMarketplace && <div aria-label="Canvas filter" className="sidekick-filters canvas-dashboard-filters" role="group">
      {CANVAS_FILTERS.map(([value, label]) => <button aria-pressed={filter === value} key={value} onClick={() => setFilter(value)} type="button">{label}</button>)}
    </div>}
    {showMarketplace ? <CanvasMarketplace onStart={create} />
      : rows === undefined ? <PushedListPending label="Loading Canvases…" noun="Canvases" />
      : cards.length === 0 ? <CanvasesEmptyState guest={guest} onPromptChange={setDraftPrompt} onStart={create} prompt={draftPrompt} />
        : <section aria-labelledby="canvases-recent-title" className="canvases-home-group">
          <div className="sidekick-results-heading"><h2 id="canvases-recent-title">{needle ? 'Search results' : 'Recent'}</h2><span>{`${shown.length} ${shown.length === 1 ? 'Canvas' : 'Canvases'}`}</span></div>
          {shown.length === 0
            ? <EmptyState description="Try a different search or filter." title="No matching Canvases" />
            : <ul className="dashboard-grid">{shown.map((card) => card.kind === 'own' ? row(card.row) : sharedCard(card.item))}</ul>}
        </section>}
  </main>;
}

function CanvasMarketplace({ onStart }: { onStart: (prompt: string) => void }): React.JSX.Element {
  const [category, setCategory] = useState<(typeof CANVAS_TEMPLATE_CATEGORIES)[number]['tag']>(CANVAS_TEMPLATE_CATEGORIES[0].tag);
  const templates = CANVAS_TEMPLATES.filter((template) => template.tags.includes(category));
  return <section aria-label="Canvas templates" className="canvas-marketplace">
    <div aria-label="Template category" className="sidekick-filters canvas-template-categories" role="group">
      {CANVAS_TEMPLATE_CATEGORIES.map(({ tag, label }) => <button aria-pressed={category === tag} key={tag} onClick={() => setCategory(tag)} type="button">{label}</button>)}
    </div>
    <ul className="dashboard-grid">
      {templates.map((template) => <li key={template.name}>
        <CanvasTemplateCard onStart={onStart} template={template} />
      </li>)}
    </ul>
  </section>;
}

/**
 * A first-run Canvases page: New Canvas, and a card that starts one from a
 * prompt, which becomes the Chat's first message.
 */
function CanvasesEmptyState({ guest, onPromptChange, onStart, prompt }: {
  guest: boolean;
  onPromptChange: (prompt: string) => void;
  onStart: (prompt?: string) => void;
  prompt: string;
}): React.JSX.Element {
  if (guest) return <EmptyState description="A Canvas someone shares with you appears here." title="No Canvases yet" />;
  return <section aria-label="Start from a prompt" className="canvas-prompt-card">
    <h2><Sparkles aria-hidden="true" size={16} />Start from a prompt</h2>
    <p>Say what you want to make, and Rally starts it in a new Canvas.</p>
    <form onSubmit={(event) => {
      event.preventDefault();
      if (prompt.trim()) onStart(prompt);
    }}>
      <textarea aria-label="Prompt" onChange={(event) => onPromptChange(event.target.value)} placeholder="A tracker for our Q1 hiring plan" rows={3} value={prompt} />
      <Button className="button-primary" disabled={!prompt.trim()} type="submit">Start</Button>
    </form>
  </section>;
}
