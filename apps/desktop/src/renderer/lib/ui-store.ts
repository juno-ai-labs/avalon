import { create } from 'zustand';

export type RailVariant = 'context' | 'background' | 'runs';
export interface RailInspector {
  type: 'resource' | 'connection' | 'task' | 'run';
  id: string;
}

interface UiState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  railOpen: boolean;
  railVariant: RailVariant;
  railWidth: number;
  railExpanded: boolean;
  inspector: RailInspector | null;
  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  openRail: (variant?: RailVariant) => void;
  closeRail: () => void;
  setRailVariant: (variant: RailVariant) => void;
  setRailWidth: (width: number) => void;
  toggleRailExpanded: () => void;
  inspect: (inspector: RailInspector | null) => void;
}

const MIN_RAIL_WIDTH = 320;
const MAX_RAIL_WIDTH = 560;
export const MIN_SIDEBAR_WIDTH = 260;
export const MAX_SIDEBAR_WIDTH = 480;
export const DEFAULT_SIDEBAR_WIDTH = 300;
const SIDEBAR_WIDTH_STORAGE_KEY = 'avalon.sidebar-width';

function clampSidebarWidth(width: number): number {
  return Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, width));
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

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: false,
  sidebarWidth: loadSidebarWidth(),
  railOpen: false,
  railVariant: 'context',
  railWidth: 360,
  railExpanded: false,
  inspector: null,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setSidebarWidth: (width) => {
    const sidebarWidth = clampSidebarWidth(width);
    saveSidebarWidth(sidebarWidth);
    set({ sidebarWidth });
  },
  openRail: (railVariant = 'context') => set({ railOpen: true, railVariant, inspector: null }),
  closeRail: () => set({ railOpen: false, railExpanded: false, inspector: null }),
  setRailVariant: (railVariant) => set({ railVariant, inspector: null }),
  setRailWidth: (railWidth) =>
    set({ railWidth: Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, railWidth)) }),
  toggleRailExpanded: () => set((state) => ({ railExpanded: !state.railExpanded })),
  inspect: (inspector) => set({ inspector }),
}));
