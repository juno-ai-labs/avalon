import { ShapeOutline } from '@rally/ui/components/identity-tile';
import { IconChecks, IconDeviceDesktopDown, IconHexagon, IconMenu2, IconPlus, IconSearch, IconX } from '@tabler/icons-react';
import clsx from 'clsx';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { canvasNeedsAttention, sidekickNeedsAttention } from '../../common/sidebar-attention';
import { useShellCapabilities } from '../lib/collaboration-session';
import { useCreateCanvas } from '../lib/canvases';
import { desktopBridge } from '../lib/platform';
import type { Workspace } from '../lib/types';
import { useUiStore, type SidebarSection } from '../lib/ui-store';
import { useCanvasList } from '../lib/canvases';
import { useDockBadge } from '../lib/dock-badge';
import { useOptionalWorkspaceSocket } from '../lib/workspace-socket';
import { ActivitySection, useActivityList } from './activity-sidebar-section';
import { CanvasesSection } from './canvas-sidebar-section';
import { ErrorNotice, IconButton } from './primitives';
import { RailItem } from './rail-item';
import { SidekicksSection, useSidekickList } from './sidekick-sidebar-section';
import { ResizableSidebar, SidebarFooterItems, SidebarScroll } from '@rally/ui/components/resizable-sidebar';
import { PHONE_LAYOUT_MAX_WIDTH, usePhoneLayout } from '@rally/ui/lib/phone-layout';

const NAVIGATION_SHEET_ID = 'rally-navigation-sheet';

/**
 * The rail's three sections. Canvases takes the page every artifact tile
 * draws; Sidekicks the hexagon a Sidekick is drawn in; Activity the triangle
 * it wore before the pivot. Settings sits at the bottom of the rail, in the
 * account menu.
 */
const SECTIONS: ReadonlyArray<{ id: SidebarSection; label: string; icon: ReactNode }> = [
  { id: 'canvases', label: 'Canvases', icon: <ShapeOutline shape="sheet" /> },
  { id: 'sidekicks', label: 'Sidekicks', icon: <IconHexagon aria-hidden="true" size={22} stroke={1.8} /> },
  { id: 'activity', label: 'Activity', icon: <ShapeOutline shape="triangle" /> },
];

/**
 * Each section's count, and whether both lists have arrived so the counts are
 * whole. Canvases counts each Canvas holding something this person has not
 * read; Sidekicks each Sidekick waiting on input or holding something unread
 * (`common/sidebar-attention.ts`, which the menu bar counts by too); Activity
 * each item this person has not seen (`docs/activity.md`). The rail draws
 * these; the dock badge adds up the first two only, as the menu bar does
 * (`docs/menu-bar.md`), so Activity never joins Needs attention.
 */
export function useSectionCounts(): { counts: Record<SidebarSection, number>; complete: boolean } {
  const canvases = useCanvasList();
  const sidekicks = useSidekickList();
  const activity = useActivityList();
  return {
    counts: {
      canvases: (canvases ?? []).filter((row) => canvasNeedsAttention(row)).length,
      sidekicks: (sidekicks ?? []).filter((row) => sidekickNeedsAttention(row)).length,
      activity: activity?.unseenCount ?? 0,
    },
    complete: canvases !== undefined && sidekicks !== undefined,
  };
}

/** The dock badge, or an installed browser app's icon badge: the Canvases and Sidekicks counts added up, not Activity's. */
export function useRailDockBadge(): void {
  const { counts, complete } = useSectionCounts();
  useDockBadge(counts.canvases + counts.sidekicks, complete);
}

/**
 * The sidebar: a rail of three sections (Canvases, Sidekicks, Activity) beside one list.
 * One list column with a tab switcher, never stacked hierarchy rails
 * (`docs/desktop-shell.md`). Shared by the Mac app and the browser.
 */
export function NavigationSidebar({
  accountMenu,
  downloadedUpdate,
  footerItems,
  onOpenSearch,
  workspace,
}: {
  accountMenu: ReactNode;
  downloadedUpdate: string | null;
  footerItems?: ReactNode;
  onOpenSearch?: (() => void) | undefined;
  workspace: Workspace;
}): React.JSX.Element {
  const { host } = useShellCapabilities();
  const section = useUiStore((state) => state.sidebarSection);
  const setSection = useUiStore((state) => state.setSidebarSection);
  const sidebarOpen = useUiStore((state) => state.sidebarOpen);
  const setSidebarOpen = useUiStore((state) => state.setSidebarOpen);
  const sidebarWidth = useUiStore((state) => state.sidebarWidth);
  const setSidebarWidth = useUiStore((state) => state.setSidebarWidth);
  const menuToggle = useRef<HTMLButtonElement>(null);
  const { pathname } = useLocation();
  // The phone sheet. Escape closes it as it would any menu and hands focus
  // back to the button (the app shell then moves it on to a pane header's
  // menu mark, when that is what opened the sheet); widening past the phone
  // layout closes it, so an open sheet never leaves the pane behind it inert
  // at a width that draws no sheet.
  useEffect(() => {
    if (!sidebarOpen) return undefined;
    // Opened from a pane header, focus fell with the pane as it went inert;
    // it lands on the close button, where the sheet starts.
    if (!panel.current?.contains(document.activeElement)) menuToggle.current?.focus();
    const closeOnEscape = (event: KeyboardEvent): void => {
      // A menu or dialog open over the sheet takes this Escape for itself.
      if (event.key !== 'Escape' || document.querySelector('[role="menu"], [role="dialog"], [role="alertdialog"]')) return;
      setSidebarOpen(false);
      menuToggle.current?.focus();
    };
    const closeWhenWide = (): void => {
      if (window.innerWidth > PHONE_LAYOUT_MAX_WIDTH) setSidebarOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape, true);
    window.addEventListener('resize', closeWhenWide);
    return () => {
      window.removeEventListener('keydown', closeOnEscape, true);
      window.removeEventListener('resize', closeWhenWide);
    };
  }, [setSidebarOpen, sidebarOpen]);
  // A shut sheet's bar is the top bar of a screen without a pane header, so it
  // names that screen's section: closing the sheet on a list the person only
  // looked at returns it to the section the route belongs to.
  // Activity is the exception it is everywhere: opening one of its rows keeps
  // it open, so a close that came with a navigation leaves it be.
  const sheetOpenedAt = useRef<string | null>(sidebarOpen ? pathname : null);
  useEffect(() => {
    const openedAt = sheetOpenedAt.current;
    sheetOpenedAt.current = sidebarOpen ? openedAt ?? pathname : null;
    if (sidebarOpen || openedAt === null || window.innerWidth > PHONE_LAYOUT_MAX_WIDTH) return;
    if (openedAt !== pathname && useUiStore.getState().sidebarSection === 'activity') return;
    const owner = sectionForPath(pathname);
    if (owner) setSection(owner);
  }, [pathname, setSection, sidebarOpen]);
  // Opening anything closes the sheet, whoever navigated: a row, a search
  // result, a new Canvas. Switching sections does not navigate, so the sheet
  // stays open on the list just picked. A navigation that asked for the sheet
  // (`sheetAfterNavigation`) opens it here instead, once.
  useEffect(() => {
    const { sheetAfterNavigation, setSheetAfterNavigation } = useUiStore.getState();
    if (sheetAfterNavigation) setSheetAfterNavigation(false);
    setSidebarOpen(sheetAfterNavigation);
  }, [pathname, setSidebarOpen]);
  // Whatever opened it (a row, a deep link, a memory source, the account
  // menu), arriving at a Canvas or a Sidekick shows its section, so the list
  // beside it holds the row that is open. Only a navigation moves it:
  // switching sections while one is open does not navigate.
  // Activity is a list of things to go to, so opening one of its rows keeps
  // it open, the next row a click away.
  // The landing is the window's first route that belongs to a section: a
  // launch starts at "/" and the landing redirects to `/canvases`, which is
  // where it landed, not a navigation. A section home there names no row, so
  // the section the person left open is kept; only a Canvas or a Sidekick the
  // landing opens moves it. Read from the route rather than counted in the
  // effect, which StrictMode runs twice.
  const landedOn = useRef<string | null>(null);
  const navigated = useRef(false);
  if (landedOn.current === null) {
    if (sectionForPath(pathname)) landedOn.current = pathname;
  } else if (pathname !== landedOn.current) navigated.current = true;
  useEffect(() => {
    const opened = sectionForPath(pathname);
    const current = useUiStore.getState().sidebarSection;
    if (!opened || opened === current || current === 'activity') return;
    if (!navigated.current && !routeNamesItem(pathname)) return;
    setSection(opened);
  }, [pathname, setSection]);
  const panel = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLElement | null>(null);
  const guest = workspace.currentUser.accessClass === 'guest';
  const badges = useSectionCounts().counts;
  // On a phone the shut sheet's bar is a section home's only header, so it
  // names the home the route shows, whichever list was left open: a link or a
  // restored route that lands on the Canvases home while Activity is the
  // stored section read "Activity" over it. The list itself keeps the stored
  // choice (desktop-shell.md, "landing on a section home keeps the stored
  // choice"); only the bar, its title and its actions, follow the route.
  const phone = usePhoneLayout();
  const homeSection = routeNamesItem(pathname) ? null : sectionForPath(pathname);
  const barSection = phone && !sidebarOpen && homeSection ? homeSection : section;
  const title = SECTIONS.find((candidate) => candidate.id === barSection)?.label ?? 'Canvases';
  const createCanvas = useCreateCanvas();
  const [createCanvasError, setCreateCanvasError] = useState<Error | null>(null);
  const navigate = useNavigate();
  const workspaceSocket = useOptionalWorkspaceSocket();
  return <ResizableSidebar
    aria-label="Rally navigation"
    className={clsx('sidebar single-sidebar navigation-sidebar', sidebarOpen && 'is-mobile-open')}
    id={NAVIGATION_SHEET_ID}
    onResize={setSidebarWidth}
    resizeLabel="Resize navigation"
    sidebarRef={panel}
    width={sidebarWidth}
  >
    <div className="navigation-body">
      <nav aria-label="Sections" className="navigation-rail">
        {host === 'desktop' && <div className="navigation-rail-top window-drag" />}
        {SECTIONS.map((candidate) => <RailItem
          active={candidate.id === section}
          aria-current={candidate.id === section ? 'page' : undefined}
          // Named section first, then its count: "Canvases, 10 unread".
          aria-label={badges[candidate.id] > 0 ? `${candidate.label}, ${badgeLabel(candidate.id, badges[candidate.id])}` : candidate.label}
          badge={<RailBadge count={badges[candidate.id]} />}
          icon={candidate.icon}
          key={candidate.id}
          label={candidate.label}
          onClick={() => setSection(candidate.id)}
        />)}
        <div className="navigation-rail-spacer" />
        {accountMenu}
      </nav>
      <div className="navigation-panel">
        <header className="navigation-panel-header window-drag">
          <IconButton
            aria-controls={NAVIGATION_SHEET_ID}
            aria-expanded={sidebarOpen}
            className="sidebar-menu-toggle window-no-drag"
            label={sidebarOpen ? 'Close navigation' : 'Open navigation'}
            onClick={() => setSidebarOpen(!sidebarOpen)}
            ref={menuToggle}
            showTooltip={false}
          >
            {sidebarOpen
              ? <IconX aria-hidden="true" size={18} stroke={1.8} />
              : <IconMenu2 aria-hidden="true" size={18} stroke={1.8} />}
          </IconButton>
          <h1 className="navigation-panel-title">{title}</h1>
          <div className="navigation-panel-actions window-no-drag">
            {downloadedUpdate !== null && <IconButton className="navigation-update" label={`Restart to update to Rally ${downloadedUpdate}`} onClick={() => void desktopBridge().installDownloadedUpdate()}>
              <IconDeviceDesktopDown aria-hidden="true" size={17} stroke={1.8} />
            </IconButton>}
            {barSection === 'canvases' && !guest && <IconButton label="New Canvas" onClick={() => { setCreateCanvasError(null); void createCanvas().catch((cause: unknown) => setCreateCanvasError(cause instanceof Error ? cause : new Error('The Canvas could not be made.'))); }}>
              <IconPlus aria-hidden="true" size={18} stroke={1.8} />
            </IconButton>}
            {barSection === 'sidekicks' && !guest && <IconButton label="New Sidekick" onClick={() => void navigate('/sidekicks/new')}>
              <IconPlus aria-hidden="true" size={18} stroke={1.8} />
            </IconButton>}
            {barSection === 'activity' && <IconButton disabled={badges.activity === 0 || !workspaceSocket} label="Mark all seen" onClick={() => workspaceSocket?.markAllActivitySeen()}>
              <IconChecks aria-hidden="true" size={18} stroke={1.8} />
            </IconButton>}
            <IconButton disabled={!onOpenSearch} label="Search organization" onClick={onOpenSearch}>
              <IconSearch aria-hidden="true" size={18} stroke={1.8} />
            </IconButton>
          </div>
        </header>
        <SidebarScroll className="navigation-panel-scroll" scrollRef={scroll}>
          {section === 'canvases' && createCanvasError && <ErrorNotice occurrence={createCanvasError}>The Canvas could not be made. Try again.</ErrorNotice>}
          {section === 'canvases' && <CanvasesSection scroll={scroll} />}
          {section === 'sidekicks' && <SidekicksSection scroll={scroll} />}
          {section === 'activity' && <ActivitySection scroll={scroll} />}
        </SidebarScroll>
        {footerItems && <SidebarFooterItems>{footerItems}</SidebarFooterItems>}
      </div>
    </div>
  </ResizableSidebar>;
}

/** The section a route belongs to, or null for one that belongs to neither. */
export function sectionForPath(pathname: string): SidebarSection | null {
  if (/^\/canvases(\/|$)/.test(pathname)) return 'canvases';
  if (/^\/(sidekicks|automations)(\/|$)/.test(pathname)) return 'sidekicks';
  return null;
}

/** Whether a route opens one Canvas or one Sidekick, rather than a section's home. */
function routeNamesItem(pathname: string): boolean {
  return /^\/(canvases|sidekicks|automations)\/[^/]+/.test(pathname);
}

/** What a section's count says it counts, for its accessible name. */
const BADGE_NOUNS: Record<SidebarSection, string> = { canvases: 'unread', sidekicks: 'waiting', activity: 'unseen' };

/** What a section's count says, for its accessible name: "3 waiting". */
function badgeLabel(section: SidebarSection, count: number): string {
  return `${count} ${BADGE_NOUNS[section]}`;
}

/**
 * A red count over a section button's corner; nothing at zero, `99+` past two
 * digits. The button's own name says the count after the section, so the
 * badge is decoration to a screen reader.
 */
function RailBadge({ count }: { count: number }): React.JSX.Element | null {
  if (count <= 0) return null;
  return <span aria-hidden="true" className="navigation-rail-badge">{count > 99 ? '99+' : count}</span>;
}
