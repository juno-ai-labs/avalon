import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debouncePersist, useUiStore, WIDTH_PERSIST_DEBOUNCE_MS } from './ui-store';

/**
 * The enforcement tests docs/adding-security-defensive-and-other-limits.md
 * requires: they pass a finite delay into the guard directly, so the
 * coalescing behavior the open WIDTH_PERSIST_DEBOUNCE_MS will one day enable
 * is proved while the constant itself stays inert at 0. The flush test here
 * is also the proof behind setRailScope's flush-before-read and the resize
 * handles' flush-on-drag-end: at the open value those calls are no-ops by
 * construction, so their behavior can only be observed at a finite delay.
 */
describe('debouncePersist enforcement at a finite delay', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('coalesces a burst into one trailing write carrying the last value', () => {
    const persist = vi.fn();
    const { schedule } = debouncePersist(persist, 250);
    // The calls are spread in time, the way a drag's pointermoves are: only
    // reset-on-reschedule keeps the earlier calls' timers from landing while
    // the burst is still going.
    schedule('a');
    vi.advanceTimersByTime(200);
    schedule('b');
    vi.advanceTimersByTime(200);
    schedule('c');

    // The window is measured from the last call, not the first, so nothing
    // may land one tick before it closes.
    vi.advanceTimersByTime(249);
    expect(persist).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('c');
  });

  it('flushes the pending write immediately on demand, and is a no-op when nothing is pending', () => {
    const persist = vi.fn();
    const { flush, schedule } = debouncePersist(persist, 250);
    schedule('a');
    flush();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('a');

    // The flush consumed the pending write and cancelled its timer: nothing
    // further lands, and a second flush has nothing to do.
    flush();
    vi.advanceTimersByTime(1_000);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('persists synchronously with no timer at the open value', () => {
    const persist = vi.fn();
    const { schedule } = debouncePersist(persist, WIDTH_PERSIST_DEBOUNCE_MS);
    schedule('a');

    expect(persist).toHaveBeenCalledWith('a');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('context rail state', () => {
  beforeEach(() => {
    // The width setters now persist through a debounce (see ui-store.ts); fake
    // timers make that deterministic here rather than leaving a real pending
    // setTimeout to land at some unpredictable point relative to the next test.
    vi.useFakeTimers();
    window.localStorage.clear();
    useUiStore.setState({
      sidebarOpen: false,
      sidebarWidth: 300,
      railOpen: false,
      railVariant: 'context',
      railWidth: 360,
      inspector: null,
      blockDashboardOpen: false,
      blockDashboardWidth: 360,
      railScope: null,
    });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('clamps HyperSight to the same width range as the rail it shares the sidebar with', () => {
    useUiStore.getState().setBlockDashboardWidth(120);
    expect(useUiStore.getState().blockDashboardWidth).toBe(320);

    useUiStore.getState().setBlockDashboardWidth(900);
    expect(useUiStore.getState().blockDashboardWidth).toBe(560);

    useUiStore.getState().setBlockDashboardOpen(true);
    expect(useUiStore.getState().blockDashboardOpen).toBe(true);
  });

  it('keeps a separate remembered width per panel and per work stream', () => {
    useUiStore.getState().setRailScope('workstream-one');
    expect(useUiStore.getState()).toMatchObject({ railWidth: 360, blockDashboardWidth: 360 });

    useUiStore.getState().setRailWidth(420);
    useUiStore.getState().setBlockDashboardWidth(520);
    // Pins the exact storage keys `railWidthKey` produces, not only the
    // round trip through the store.
    expect(window.localStorage.getItem('rally.rail-width:workstream-one')).toBe('420');
    expect(window.localStorage.getItem('rally.block-dashboard-width:workstream-one')).toBe('520');

    // A work stream that has never opened either panel starts at the default.
    useUiStore.getState().setRailScope('workstream-two');
    expect(useUiStore.getState()).toMatchObject({ railWidth: 360, blockDashboardWidth: 360 });
    useUiStore.getState().setRailWidth(330);

    useUiStore.getState().setRailScope('workstream-one');
    expect(useUiStore.getState()).toMatchObject({ railWidth: 420, blockDashboardWidth: 520 });

    useUiStore.getState().setRailScope('workstream-two');
    expect(useUiStore.getState()).toMatchObject({ railWidth: 330, blockDashboardWidth: 360 });
  });

  it('clamps and persists sidebar resizing', () => {
    useUiStore.getState().setSidebarWidth(120);
    expect(useUiStore.getState().sidebarWidth).toBe(260);
    expect(window.localStorage.getItem('rally.sidebar-width')).toBe('260');

    useUiStore.getState().setSidebarWidth(900);
    expect(useUiStore.getState().sidebarWidth).toBe(480);
    expect(window.localStorage.getItem('rally.sidebar-width')).toBe('480');
  });

  // The open-value test docs/adding-security-defensive-and-other-limits.md
  // requires: at the constant's current value nothing is delayed. When the
  // team sets WIDTH_PERSIST_DEBOUNCE_MS, this is the test their change flips
  // to assert coalescing through the store instead.
  it('writes through synchronously while the persistence limit is open', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    useUiStore.getState().setSidebarWidth(310);
    useUiStore.getState().setSidebarWidth(320);
    useUiStore.getState().setSidebarWidth(330);

    expect(useUiStore.getState().sidebarWidth).toBe(330);
    // No timer advance: each write landed on its own call, exactly as the
    // code behaved before the debounce existed, and no timer was created.
    expect(setItem).toHaveBeenCalledTimes(3);
    expect(window.localStorage.getItem('rally.sidebar-width')).toBe('330');
  });

  it('opens the requested contextual variant and resets stale detail state', () => {
    useUiStore.getState().inspect({ type: 'resource', id: 'old-resource' });
    useUiStore.getState().openRail('runs');

    expect(useUiStore.getState()).toMatchObject({
      railOpen: true,
      railVariant: 'runs',
      inspector: null,
    });
  });

  it('clamps resizing and clears inspector state when closed', () => {
    useUiStore.getState().setRailWidth(120);
    expect(useUiStore.getState().railWidth).toBe(320);

    useUiStore.getState().setRailWidth(900);
    expect(useUiStore.getState().railWidth).toBe(560);

    // Closing leaves the detail on screen for the panel's fade-out; the next
    // open is what puts the rail back at its list.
    useUiStore.getState().inspect({ type: 'connection', id: 'google' });
    useUiStore.getState().closeRail();
    expect(useUiStore.getState()).toMatchObject({ railOpen: false, inspector: { type: 'connection', id: 'google' } });

    useUiStore.getState().openRail('context');
    expect(useUiStore.getState()).toMatchObject({ railOpen: true, inspector: null });
  });
});
