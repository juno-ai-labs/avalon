import { create } from 'zustand';

export type RailVariant = 'context';
/** The panel occupying the right sidebar slot. */
export interface RailInspector {
  type: 'resource' | 'connection' | 'task' | 'run';
  id: string;
}

interface UiState {
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  railOpen: boolean;
  railVariant: RailVariant;
  railWidth: number;
  inspector: RailInspector | null;
  railLeaving: boolean;
  railScope: string | null;
  setSidebarOpen: (open: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;
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

export const MIN_RAIL_WIDTH = 320;
export const MAX_RAIL_WIDTH = 560;
export const DEFAULT_RAIL_WIDTH = 360;
/** GrokBot's compact rail and expanded-sidebar geometry. */
export const COLLAPSED_SIDEBAR_WIDTH = 88;
export const MIN_SIDEBAR_WIDTH = 240;
export const MAX_SIDEBAR_WIDTH = 400;
export const DEFAULT_SIDEBAR_WIDTH = 280;
/** The main conversation width GrokBot protects before forcing the icon rail. */
export const SIDEBAR_CONTENT_MIN_WIDTH = 424;
/** Drag thresholds include GrokBot's ten-pixel hysteresis on expansion. */
export const SIDEBAR_COLLAPSE_DRAG_THRESHOLD = 210;
export const SIDEBAR_EXPAND_DRAG_THRESHOLD = 220;
export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'rally.sidebar-collapsed';
const SIDEBAR_WIDTH_STORAGE_KEY = 'rally.sidebar-width';
const RAIL_WIDTH_STORAGE_PREFIX = 'rally.rail-width';

function clampSidebarWidth(width: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
}

function clampRailWidth(width: number): number {
  return Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, width));
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

function loadSidebarWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH;

  try {
    const storedWidth = Number.parseFloat(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) ?? '');
    return Number.isFinite(storedWidth) ? clampSidebarWidth(storedWidth) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function saveSidebarWidth(width: number): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // Local persistence is best-effort; resizing should still work when storage is unavailable.
  }
}

function loadSidebarCollapsed(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

function saveSidebarCollapsed(collapsed: boolean): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
  } catch {
    // Local persistence is best-effort; compacting should still work when storage is unavailable.
  }
}

export const useUiStore = create<UiState>((set, get) => ({
  sidebarOpen: false,
  sidebarCollapsed: loadSidebarCollapsed(),
  sidebarWidth: loadSidebarWidth(),
  railOpen: false,
  railVariant: 'context',
  railWidth: loadRailWidth(RAIL_WIDTH_STORAGE_PREFIX, null),
  inspector: null,
  railLeaving: false,
  railScope: null,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setSidebarCollapsed: (sidebarCollapsed) => {
    saveSidebarCollapsed(sidebarCollapsed);
    set({ sidebarCollapsed });
  },
  setSidebarWidth: (width) => {
    const sidebarWidth = clampSidebarWidth(width);
    saveSidebarWidth(sidebarWidth);
    set({ sidebarWidth });
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
