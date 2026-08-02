import { create } from 'zustand';

export type RailVariant = 'context' | 'background' | 'runs';
export interface RailInspector {
  type: 'resource' | 'connection' | 'task' | 'run';
  id: string;
}

interface UiState {
  sidebarOpen: boolean;
  railOpen: boolean;
  railVariant: RailVariant;
  railWidth: number;
  railExpanded: boolean;
  inspector: RailInspector | null;
  setSidebarOpen: (open: boolean) => void;
  openRail: (variant?: RailVariant) => void;
  closeRail: () => void;
  setRailVariant: (variant: RailVariant) => void;
  setRailWidth: (width: number) => void;
  toggleRailExpanded: () => void;
  inspect: (inspector: RailInspector | null) => void;
}

const MIN_RAIL_WIDTH = 320;
const MAX_RAIL_WIDTH = 560;

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: false,
  railOpen: false,
  railVariant: 'context',
  railWidth: 360,
  railExpanded: false,
  inspector: null,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  openRail: (railVariant = 'context') => set({ railOpen: true, railVariant, inspector: null }),
  closeRail: () => set({ railOpen: false, railExpanded: false, inspector: null }),
  setRailVariant: (railVariant) => set({ railVariant, inspector: null }),
  setRailWidth: (railWidth) =>
    set({ railWidth: Math.max(MIN_RAIL_WIDTH, Math.min(MAX_RAIL_WIDTH, railWidth)) }),
  toggleRailExpanded: () => set((state) => ({ railExpanded: !state.railExpanded })),
  inspect: (inspector) => set({ inspector }),
}));
