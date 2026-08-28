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
/** One arrow-key press moves either resize handle by this much, in px. */
export const KEYBOARD_RESIZE_STEP = 16;
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
 *
 * At a delay of 0 the guard is inert per
 * docs/adding-security-defensive-and-other-limits.md: `schedule` persists
 * synchronously and no timer is ever created, so the open value behaves
 * exactly as the code did before the debounce existed. Exported so the
 * enforcement can be proved against a finite delay while the constant below
 * stays open.
 *
 * `persist` must not throw: at a non-zero delay it runs inside a timer
 * callback where a throw surfaces as an uncaught error pointing at the timer,
 * not the scheduler. The width savers below swallow their own storage errors.
 */
export function debouncePersist<Args extends unknown[]>(
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
    if (delayMs <= 0) {
      persist(...args);
      return;
    }
    pending = args;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  };
  return { schedule, flush };
}

/**
 * LIMIT UNSET — open and inert: at 0, `schedule` persists synchronously and
 * creates no timer, so the code behaves exactly as it did before the debounce
 * existed. Awaiting a value from the team; see
 * docs/adding-security-defensive-and-other-limits.md.
 *
 * Bounds: milliseconds a sidebar/rail/HyperSight width write to localStorage
 *   is held after the caller's last update, before it is flushed.
 * Without it: setSidebarWidth, setRailWidth, and setBlockDashboardWidth each
 *   run a synchronous localStorage.setItem on every call, and a resize drag
 *   drives the pointermove path that calls them at 60-120/s — a storage write
 *   on every frame of the drag. Chromium serves localStorage from an
 *   in-renderer cache with an async commit, so each write is cheap; the same
 *   calls also run a zustand set and a React render, which bound the path
 *   regardless. The debounce removes the one per-frame cost that buys nothing
 *   (only the last width of a drag matters at next launch) — a tuning
 *   trade-off, not containment.
 * Who can cause it: only our own resize handlers, driven by the local
 *   pointer or keyboard — no untrusted caller, provider, or fan-out reaches
 *   these setters. Per the limits doc that means the team may reasonably
 *   answer by deleting this constant (fixing a first-party cost needs no
 *   runtime guard); the mechanism is kept behind it either way.
 * Direction: a wait; the open value is 0.
 * Trips: nothing is rejected or truncated. At a non-zero value the deferred
 *   write still lands: after the caller has been quiet for this many ms, or
 *   immediately when something needs it sooner — setRailScope flushes before
 *   it reads a scope-keyed width back, the sidebar and rail handles flush
 *   when a drag ends so the released width is durable at once, and a
 *   `pagehide` flush backstops quit and reload. The live width in the store
 *   updates on every call regardless of this constant.
 * Derive from: pointermove rate (60-120/s) × the window = writes coalesced
 *   per drag, against the drag-end and pagehide flushes bounding what a
 *   killed process can lose to the window itself. With those flushes wired,
 *   any value in the 100-250ms range coalesces a burst without observable
 *   cost; the in-tree precedent is SAVE_DEBOUNCE_MS = 250 in
 *   use-draft-text.ts.
 */
export const WIDTH_PERSIST_DEBOUNCE_MS = 0;

// Two debouncers deliberately wrap the same saver: the storage prefix arrives
// per call through `schedule(...)`, and the rail and HyperSight widths must
// not share a pending slot — one would swallow the other's trailing write.
const sidebarWidthPersist = debouncePersist(saveSidebarWidth, WIDTH_PERSIST_DEBOUNCE_MS);
const railWidthPersist = debouncePersist(saveRailWidth, WIDTH_PERSIST_DEBOUNCE_MS);
const blockDashboardWidthPersist = debouncePersist(saveRailWidth, WIDTH_PERSIST_DEBOUNCE_MS);

/**
 * Lands every pending width write now. Called when a resize drag ends — the
 * released width is final and must not sit in the persistence window — and on
 * `pagehide`, so a quit or reload inside that window cannot lose the last
 * width. Both are no-ops while the limit above is open (writes are already
 * synchronous); once the team sets a number, these two flushes are what keep
 * it free to choose — the window only ever trades away writes *within* a
 * burst, never the one that has to survive.
 */
export function flushWidthPersistence(): void {
  sidebarWidthPersist.flush();
  railWidthPersist.flush();
  blockDashboardWidthPersist.flush();
}

// Registered beside the store singleton it guards rather than in the shell:
// the renderer has one window, and `pagehide` is the last event a closing
// document reliably sees.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushWidthPersistence);
}

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
    // A no-op while the limit above is open (writes are synchronous); the
    // flush semantics are proved at a finite delay in ui-store.test.ts.
    railWidthPersist.flush();
    blockDashboardWidthPersist.flush();
    set({
      railScope,
      railWidth: loadRailWidth(RAIL_WIDTH_STORAGE_PREFIX, railScope),
      blockDashboardWidth: loadRailWidth(BLOCK_DASHBOARD_WIDTH_STORAGE_PREFIX, railScope),
    });
  },
}));
