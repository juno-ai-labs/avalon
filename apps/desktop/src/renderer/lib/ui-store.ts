import { create } from 'zustand';

export type RailVariant = 'context' | 'runs';
/** Which of the two panels the right sidebar's one slot is being laid out for. */
export type RailPanel = 'block-dashboard' | 'inspector';
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
  inspector: RailInspector | null;
  blockDashboardOpen: boolean;
  blockDashboardWidth: number;
  railLeaving: RailPanel | null;
  railScope: string | null;
  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  openRail: (variant?: RailVariant) => void;
  closeRail: () => void;
  setRailVariant: (variant: RailVariant) => void;
  setRailWidth: (width: number) => void;
  inspect: (inspector: RailInspector | null) => void;
  // HyperSight and the inspector rail share the right sidebar slot, and only
  // one of them is ever open. Which one is open is a personal, per-work-stream
  // preference the API owns, so the work-stream screen mirrors it here for the
  // shell to lay out against rather than deciding it.
  setBlockDashboardOpen: (open: boolean) => void;
  setBlockDashboardWidth: (width: number) => void;
  // A panel that has lost the slot is still on screen for its fade, so the
  // shell has to keep laying out against it: dropping the room it occupies, or
  // re-targeting the slot at the other panel's width, would reflow the screen
  // underneath something the person can still see.
  setRailLeaving: (panel: RailPanel | null) => void;
  // Each panel keeps its own width per work stream: a wide HyperSight in one
  // stream must not narrow the inspector in another. Screens outside a work
  // stream pass null and share one bucket.
  setRailScope: (scope: string | null) => void;
}

export const MIN_RAIL_WIDTH = 320;
export const MAX_RAIL_WIDTH = 560;
export const DEFAULT_RAIL_WIDTH = 360;
export const MIN_SIDEBAR_WIDTH = 260;
export const MAX_SIDEBAR_WIDTH = 480;
export const DEFAULT_SIDEBAR_WIDTH = 300;
const SIDEBAR_WIDTH_STORAGE_KEY = 'rally.sidebar-width';
const RAIL_WIDTH_STORAGE_PREFIX = 'rally.rail-width';
const BLOCK_DASHBOARD_WIDTH_STORAGE_PREFIX = 'rally.block-dashboard-width';

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

/**
 * Coalesces rapid calls to a persistence function into one trailing call, and
 * exposes `flush` so a caller that is about to *read* what this writes can
 * force it out first rather than race it.
 *
 * `set({ width })` still runs on every call — only the localStorage write
 * scheduled here is deferred, so the live value a drag tracks is never
 * delayed; only the copy that survives to the next launch is.
 */
function debouncePersist<Args extends unknown[]>(
  persist: (...args: Args) => void,
  delayMs: number,
): { schedule: (...args: Args) => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Args | undefined;
  const flush = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    const args = pending;
    pending = undefined;
    if (args) persist(...args);
  };
  const schedule = (...args: Args): void => {
    pending = args;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  };
  return { schedule, flush };
}

/**
 * LIMIT UNSET — open, enforcing no delay: every scheduled width write reaches
 * localStorage on its own turn of the event loop, matching the previously-
 * synchronous behavior as closely as a deferred write can. Awaiting a value
 * from the team; see docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: milliseconds a sidebar/rail/HyperSight width write to localStorage
 *   is held after the caller's last update, before it is flushed.
 * Without it: setSidebarWidth, setRailWidth, and setBlockDashboardWidth each
 *   ran a synchronous localStorage.setItem on every call, and a resize drag
 *   drives the pointermove path that calls them at 60-120/s — a blocking
 *   main-thread write on every frame of the drag.
 * Direction: a wait; the open value is 0.
 * Trips: nothing is rejected or truncated. The deferred write still lands —
 *   after the caller has been quiet for this many ms, or immediately if
 *   something needs to read the value back first (setRailScope flushes
 *   before it reads) — while the live width in the store updates on every
 *   call regardless of this constant.
 * Derive from: how much of a gap between the pointer settling and the write
 *   landing is acceptable against how often a drag calls the setter, since a
 *   longer wait coalesces more writes per drag at the cost of a wider window
 *   in which a killed process loses the latest width.
 */
export const WIDTH_PERSIST_DEBOUNCE_MS = 0;

const sidebarWidthPersist = debouncePersist(saveSidebarWidth, WIDTH_PERSIST_DEBOUNCE_MS);
const railWidthPersist = debouncePersist(saveRailWidth, WIDTH_PERSIST_DEBOUNCE_MS);
const blockDashboardWidthPersist = debouncePersist(saveRailWidth, WIDTH_PERSIST_DEBOUNCE_MS);

export const useUiStore = create<UiState>((set, get) => ({
  sidebarOpen: false,
  sidebarWidth: loadSidebarWidth(),
  railOpen: false,
  railVariant: 'context',
  railWidth: loadRailWidth(RAIL_WIDTH_STORAGE_PREFIX, null),
  inspector: null,
  blockDashboardOpen: false,
  blockDashboardWidth: loadRailWidth(BLOCK_DASHBOARD_WIDTH_STORAGE_PREFIX, null),
  railLeaving: null,
  railScope: null,
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setSidebarWidth: (width) => {
    const sidebarWidth = clampSidebarWidth(width);
    sidebarWidthPersist.schedule(sidebarWidth);
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
    railWidthPersist.schedule(RAIL_WIDTH_STORAGE_PREFIX, get().railScope, railWidth);
    set({ railWidth });
  },
  inspect: (inspector) => set({ inspector }),
  setBlockDashboardOpen: (blockDashboardOpen) => set({ blockDashboardOpen }),
  setBlockDashboardWidth: (width) => {
    const blockDashboardWidth = clampRailWidth(width);
    blockDashboardWidthPersist.schedule(BLOCK_DASHBOARD_WIDTH_STORAGE_PREFIX, get().railScope, blockDashboardWidth);
    set({ blockDashboardWidth });
  },
  setRailLeaving: (railLeaving) => set({ railLeaving }),
  setRailScope: (railScope) => {
    // The width this is about to read back is keyed by scope, so a write for
    // the scope being left that is still sitting in the debounce window has
    // to land before the read or switching away and back inside that window
    // would find the value the drag was replacing rather than the one it left.
    railWidthPersist.flush();
    blockDashboardWidthPersist.flush();
    set({
      railScope,
      railWidth: loadRailWidth(RAIL_WIDTH_STORAGE_PREFIX, railScope),
      blockDashboardWidth: loadRailWidth(BLOCK_DASHBOARD_WIDTH_STORAGE_PREFIX, railScope),
    });
  },
}));
