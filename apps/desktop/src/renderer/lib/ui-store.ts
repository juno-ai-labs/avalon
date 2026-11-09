import { create } from 'zustand';

export type RailVariant = 'context' | 'browser';
/**
 * Which list the sidebar's rail shows. A section stored before the 2026-11
 * cutover (`channels`, `threads`, `pinned`, `artifacts`) reads as the default,
 * Canvases; `activity` opens Activity again.
 */
export type SidebarSection = 'canvases' | 'sidekicks' | 'activity';
/** The panel occupying the right sidebar slot. */
export interface RailInspector {
  type: 'resource' | 'connection' | 'task' | 'run';
  id: string;
}

interface UiState {
  sidebarOpen: boolean;
  /**
   * Open the phone sheet once the navigation under way lands. The sidebar
   * closes the sheet on every mount and route change; a deep link that both
   * navigates and wants the sheet open sets this instead, and that reset reads it.
   */
  sheetAfterNavigation: boolean;
  sidebarWidth: number;
  sidebarSection: SidebarSection;
  railOpen: boolean;
  /** The open panel is expanded over its conversation, taking the whole pane. */
  railExpanded: boolean;
  railVariant: RailVariant;
  railWidth: number;
  inspector: RailInspector | null;
  railLeaving: boolean;
  railScope: string | null;
  setSidebarOpen: (open: boolean) => void;
  setSheetAfterNavigation: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setSidebarSection: (section: SidebarSection) => void;
  openRail: (variant?: RailVariant) => void;
  closeRail: () => void;
  setRailExpanded: (expanded: boolean) => void;
  setRailVariant: (variant: RailVariant) => void;
  // `remember: false` sizes this opening only, leaving the width the person
  // last dragged to as what a restored panel comes back at.
  setRailWidth: (width: number, options?: { remember?: boolean }) => void;
  inspect: (inspector: RailInspector | null) => void;
  // A panel that has lost the slot is still on screen for its fade, so the
  // shell has to keep laying out against it; dropping the room it occupies
  // would reflow the screen underneath something the person can still see.
  setRailLeaving: (leaving: boolean) => void;
  // The inspector keeps its width per work stream. Screens outside a work
  // stream pass null and share one bucket.
  setRailScope: (scope: string | null) => void;
}

export const MIN_RAIL_WIDTH = 280;
export const DEFAULT_RAIL_WIDTH = 320;
/** GrokBot's compact rail and expanded-sidebar geometry. */
export { COLLAPSED_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH, SINGLE_SIDEBAR_DEFAULT_WIDTH, SIDEBAR_CONTENT_MIN_WIDTH, SIDEBAR_COLLAPSE_DRAG_THRESHOLD, SIDEBAR_EXPAND_DRAG_THRESHOLD } from '@rally/ui/lib/sidebar-geometry';
import { clampSidebarWidth, loadSidebarWidth, saveSidebarPreference } from '@rally/ui/lib/sidebar-preferences';
import { SIDEBAR_CONTENT_MIN_WIDTH as CONVERSATION_MIN_WIDTH } from '@rally/ui/lib/sidebar-geometry';
import { SINGLE_SIDEBAR_DEFAULT_WIDTH } from '@rally/ui/lib/sidebar-geometry';
const SIDEBAR_WIDTH_STORAGE_KEY = 'rally.sidebar-width';
/** Pixels, as written before 2026-11-08; still read where no share is stored. */
const RAIL_WIDTH_STORAGE_PREFIX = 'rally.rail-width';
/** The panel's share of the main pane, which is what a drag now saves. */
const RAIL_SHARE_STORAGE_PREFIX = 'rally.rail-share';
const SIDEBAR_SECTION_STORAGE_KEY = 'rally.sidebar-section';

/** A device preference read once; storage that throws or holds junk reads as the fallback. */
function loadPreference<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const stored = window.localStorage.getItem(key);
    return allowed.find((value) => value === stored) ?? fallback;
  } catch {
    return fallback;
  }
}

function savePreference(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Best-effort device preference; it still applies for this session.
  }
}

function clampRailWidth(width: number): number {
  // Grok preserves the preferred width; the host caps its visible width to
  // the space left after navigation and the conversation minimum.
  return Number.isFinite(width) ? Math.max(MIN_RAIL_WIDTH, width) : DEFAULT_RAIL_WIDTH;
}

function railWidthKey(prefix: string, scope: string | null): string {
  return `${prefix}:${scope ?? 'default'}`;
}

/**
 * The main pane's width, which the panel and the conversation share: the
 * window less everything left of the pane. Null with no pane on screen.
 */
export function measuredPaneWidth(): number | null {
  if (typeof document === 'undefined') return null;
  const pane = document.querySelector<HTMLElement>('.main-pane');
  if (!pane) return null;
  return window.innerWidth - pane.getBoundingClientRect().left;
}

/**
 * The widths a panel can take in a pane this wide: the minimum, up to what
 * leaves the conversation its minimum (`--rail-max-slot` in CSS, which caps
 * what is drawn the same way).
 */
function clampToPane(width: number, pane: number): number {
  return Math.max(MIN_RAIL_WIDTH, Math.min(Math.round(width), pane - CONVERSATION_MIN_WIDTH));
}

function loadRailWidth(scope: string | null): number {
  return savedWidth(scope) ?? DEFAULT_RAIL_WIDTH;
}

function readNumber(key: string): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = Number.parseFloat(window.localStorage.getItem(key) ?? '');
    return Number.isFinite(stored) ? stored : null;
  } catch {
    return null;
  }
}

/**
 * The width `scope`'s panel comes back at in the pane as it is now. A share
 * is the person's split of whatever pane they were in, so a panel dragged in a
 * narrow window comes back proportionally wide in a wide one; a pixel width
 * stored before shares were saved is kept, held inside the pane's bounds.
 */
function savedWidth(scope: string | null): number | null {
  const pane = measuredPaneWidth();
  const share = readNumber(railWidthKey(RAIL_SHARE_STORAGE_PREFIX, scope));
  if (pane !== null && share !== null && share > 0) return clampToPane(share * pane, pane);
  const pixels = readNumber(railWidthKey(RAIL_WIDTH_STORAGE_PREFIX, scope));
  if (pixels === null) return null;
  return pane === null ? clampRailWidth(pixels) : clampToPane(pixels, pane);
}

/** The width the person last set for `scope`'s panel, or null when they never have. */
export function savedRailWidth(scope: string | null): number | null {
  return savedWidth(scope);
}

/** Save the width as its share of the pane, or as pixels when there is no pane to measure. */
function saveRailWidth(scope: string | null, width: number): void {
  if (typeof window === 'undefined') return;
  const pane = measuredPaneWidth();
  try {
    if (pane !== null && pane > 0) {
      window.localStorage.setItem(railWidthKey(RAIL_SHARE_STORAGE_PREFIX, scope), String(width / pane));
      window.localStorage.removeItem(railWidthKey(RAIL_WIDTH_STORAGE_PREFIX, scope));
    } else {
      window.localStorage.setItem(railWidthKey(RAIL_WIDTH_STORAGE_PREFIX, scope), String(width));
    }
  } catch {
    // Local persistence is best-effort; resizing should still work when storage is unavailable.
  }
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarOpen: false,
  sheetAfterNavigation: false,
  sidebarWidth: loadSidebarWidth(SIDEBAR_WIDTH_STORAGE_KEY, SINGLE_SIDEBAR_DEFAULT_WIDTH),
  sidebarSection: loadPreference<SidebarSection>(SIDEBAR_SECTION_STORAGE_KEY, ['canvases', 'sidekicks', 'activity'], 'canvases'),
  railOpen: false,
  railExpanded: false,
  railVariant: 'context',
  railWidth: loadRailWidth(null),
  inspector: null,
  railLeaving: false,
  railScope: null,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setSheetAfterNavigation: (sheetAfterNavigation) => set({ sheetAfterNavigation }),
  setSidebarWidth: (width) => {
    const sidebarWidth = clampSidebarWidth(width);
    saveSidebarPreference(SIDEBAR_WIDTH_STORAGE_KEY, sidebarWidth);
    set({ sidebarWidth });
  },
  setSidebarSection: (sidebarSection) => {
    savePreference(SIDEBAR_SECTION_STORAGE_KEY, sidebarSection);
    set({ sidebarSection });
  },
  openRail: (railVariant = 'context') => set({ railOpen: true, railVariant, inspector: null }),
  // The detail view is cleared when the rail is next opened rather than as it
  // closes: the panel is still on screen fading out, and swapping its contents
  // under the fade would be the last thing seen of it.
  closeRail: () => set({ railOpen: false }),
  setRailExpanded: (railExpanded) => set({ railExpanded }),
  setRailVariant: (railVariant) => set({ railVariant, inspector: null }),
  setRailWidth: (width, { remember = true } = {}) => {
    const railWidth = clampRailWidth(width);
    if (remember) saveRailWidth(get().railScope, railWidth);
    set({ railWidth });
  },
  inspect: (inspector) => set({ inspector }),
  setRailLeaving: (railLeaving) => set({ railLeaving }),
  setRailScope: (railScope) => set({
    railScope,
    railWidth: loadRailWidth(railScope),
  }),
}));
