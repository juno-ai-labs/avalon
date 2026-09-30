import { create } from 'zustand';

/** The general channel context rail remains retired; artifact reading uses the slot directly. */
export const CONTEXT_SIDEBAR_ENABLED = false;

export type RailVariant = 'context' | 'browser';
/** The panel occupying the right sidebar slot. */
export interface RailInspector {
  type: 'resource' | 'connection' | 'task' | 'run';
  id: string;
}

interface UiState {
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  spacesSidebarWidth: number;
  spacesSidebarCollapsed: boolean;
  railOpen: boolean;
  railVariant: RailVariant;
  railWidth: number;
  inspector: RailInspector | null;
  railLeaving: boolean;
  railScope: string | null;
  setSidebarOpen: (open: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setSpacesSidebarWidth: (width: number) => void;
  setSpacesSidebarCollapsed: (collapsed: boolean) => void;
  openRail: (variant?: RailVariant) => void;
  closeRail: () => void;
  setRailVariant: (variant: RailVariant) => void;
  setRailWidth: (width: number) => void;
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
export { COLLAPSED_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH, SIDEBAR_CONTENT_MIN_WIDTH, SIDEBAR_COLLAPSE_DRAG_THRESHOLD, SIDEBAR_EXPAND_DRAG_THRESHOLD } from '@rally/ui/lib/sidebar-geometry';
import { clampSidebarWidth, loadSidebarCollapsed, loadSidebarWidth, saveSidebarPreference } from '@rally/ui/lib/sidebar-preferences';
export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'rally.sidebar-collapsed';
const SIDEBAR_WIDTH_STORAGE_KEY = 'rally.sidebar-width';
const SPACES_SIDEBAR_WIDTH_STORAGE_KEY = 'rally.spaces-sidebar-width';
const SPACES_SIDEBAR_COLLAPSED_STORAGE_KEY = 'rally.spaces-sidebar-collapsed';
const RAIL_WIDTH_STORAGE_PREFIX = 'rally.rail-width';

function clampRailWidth(width: number): number {
  // Grok preserves the preferred width; the host caps its visible width to
  // the space left after navigation and the conversation minimum.
  return Number.isFinite(width) ? Math.max(MIN_RAIL_WIDTH, width) : DEFAULT_RAIL_WIDTH;
}

function railWidthKey(prefix: string, scope: string | null): string {
  return `${prefix}:${scope ?? 'default'}`;
}

function loadRailWidth(prefix: string, scope: string | null): number {
  if (typeof window === 'undefined') return DEFAULT_RAIL_WIDTH;

  try {
    const storedWidth = Number.parseFloat(window.localStorage.getItem(railWidthKey(prefix, scope)) ?? '');
    return Number.isFinite(storedWidth) ? clampRailWidth(storedWidth) : DEFAULT_RAIL_WIDTH;
  } catch {
    return DEFAULT_RAIL_WIDTH;
  }
}

function saveRailWidth(prefix: string, scope: string | null, width: number): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(railWidthKey(prefix, scope), String(width));
  } catch {
    // Local persistence is best-effort; resizing should still work when storage is unavailable.
  }
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarOpen: false,
  sidebarCollapsed: loadSidebarCollapsed(SIDEBAR_COLLAPSED_STORAGE_KEY),
  sidebarWidth: loadSidebarWidth(SIDEBAR_WIDTH_STORAGE_KEY),
  spacesSidebarWidth: loadSidebarWidth(SPACES_SIDEBAR_WIDTH_STORAGE_KEY),
  spacesSidebarCollapsed: loadSidebarCollapsed(SPACES_SIDEBAR_COLLAPSED_STORAGE_KEY),
  railOpen: false,
  railVariant: 'context',
  railWidth: loadRailWidth(RAIL_WIDTH_STORAGE_PREFIX, null),
  inspector: null,
  railLeaving: false,
  railScope: null,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setSidebarCollapsed: (sidebarCollapsed) => {
    saveSidebarPreference(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed);
    set({ sidebarCollapsed });
  },
  setSidebarWidth: (width) => {
    const sidebarWidth = clampSidebarWidth(width);
    saveSidebarPreference(SIDEBAR_WIDTH_STORAGE_KEY, sidebarWidth);
    set({ sidebarWidth });
  },
  setSpacesSidebarWidth: (width) => {
    const spacesSidebarWidth = clampSidebarWidth(width);
    saveSidebarPreference(SPACES_SIDEBAR_WIDTH_STORAGE_KEY, spacesSidebarWidth);
    set({ spacesSidebarWidth });
  },
  setSpacesSidebarCollapsed: (spacesSidebarCollapsed) => {
    saveSidebarPreference(SPACES_SIDEBAR_COLLAPSED_STORAGE_KEY, spacesSidebarCollapsed);
    set({ spacesSidebarCollapsed });
  },
  openRail: (railVariant = 'context') => set({ railOpen: true, railVariant, inspector: null }),
  // The detail view is cleared when the rail is next opened rather than as it
  // closes: the panel is still on screen fading out, and swapping its contents
  // under the fade would be the last thing seen of it.
  closeRail: () => set({ railOpen: false }),
  setRailVariant: (railVariant) => set({ railVariant, inspector: null }),
  setRailWidth: (width) => {
    const railWidth = clampRailWidth(width);
    saveRailWidth(RAIL_WIDTH_STORAGE_PREFIX, get().railScope, railWidth);
    set({ railWidth });
  },
  inspect: (inspector) => set({ inspector }),
  setRailLeaving: (railLeaving) => set({ railLeaving }),
  setRailScope: (railScope) => set({
    railScope,
    railWidth: loadRailWidth(RAIL_WIDTH_STORAGE_PREFIX, railScope),
  }),
}));
