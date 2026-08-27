import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore, WIDTH_PERSIST_DEBOUNCE_MS } from './ui-store';

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
    vi.advanceTimersByTime(WIDTH_PERSIST_DEBOUNCE_MS);
    expect(window.localStorage.getItem('rally.sidebar-width')).toBe('260');

    useUiStore.getState().setSidebarWidth(900);
    expect(useUiStore.getState().sidebarWidth).toBe(480);
    vi.advanceTimersByTime(WIDTH_PERSIST_DEBOUNCE_MS);
    expect(window.localStorage.getItem('rally.sidebar-width')).toBe('480');
  });

  it('debounces the persisted write behind rapid width updates, but never the live value', () => {
    useUiStore.getState().setSidebarWidth(310);
    useUiStore.getState().setSidebarWidth(320);
    useUiStore.getState().setSidebarWidth(330);

    // The pointermove path this stands in for updates the live value on every
    // call, whatever becomes of the write behind it.
    expect(useUiStore.getState().sidebarWidth).toBe(330);
    // Nothing has been written yet — three rapid calls are still one pending
    // write, not three.
    expect(window.localStorage.getItem('rally.sidebar-width')).toBeNull();

    vi.advanceTimersByTime(WIDTH_PERSIST_DEBOUNCE_MS);

    // The write that lands is the last width, not the first or a stale one.
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
