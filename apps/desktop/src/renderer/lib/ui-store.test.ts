import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from './ui-store';

describe('context rail state', () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({
      sidebarOpen: false,
      sidebarWidth: 300,
      railOpen: false,
      railVariant: 'context',
      railWidth: 360,
      inspector: null,
      railScope: null,
    });
  });

  it('keeps a separate remembered width per channel', () => {
    useUiStore.getState().setRailScope('workstream-one');
    expect(useUiStore.getState()).toMatchObject({ railWidth: 320 });

    useUiStore.getState().setRailWidth(420);

    // A work stream that has never opened the panel starts at the default.
    useUiStore.getState().setRailScope('workstream-two');
    expect(useUiStore.getState()).toMatchObject({ railWidth: 320 });
    useUiStore.getState().setRailWidth(330);

    useUiStore.getState().setRailScope('workstream-one');
    expect(useUiStore.getState()).toMatchObject({ railWidth: 420 });

    useUiStore.getState().setRailScope('workstream-two');
    expect(useUiStore.getState()).toMatchObject({ railWidth: 330 });
  });

  it('clamps and persists sidebar resizing', () => {
    useUiStore.getState().setSidebarWidth(120);
    expect(useUiStore.getState().sidebarWidth).toBe(306);
    expect(window.localStorage.getItem('rally.sidebar-width')).toBe('306');

    useUiStore.getState().setSidebarWidth(900);
    expect(useUiStore.getState().sidebarWidth).toBe(400);
    expect(window.localStorage.getItem('rally.sidebar-width')).toBe('400');
  });

  it('opens the requested contextual variant and resets stale detail state', () => {
    useUiStore.getState().inspect({ type: 'resource', id: 'old-resource' });
    useUiStore.getState().openRail('context');

    expect(useUiStore.getState()).toMatchObject({
      railOpen: true,
      railVariant: 'context',
      inspector: null,
    });
  });

  it('clamps resizing and clears inspector state when closed', () => {
    useUiStore.getState().setRailWidth(120);
    expect(useUiStore.getState().railWidth).toBe(280);

    useUiStore.getState().setRailWidth(900);
    expect(useUiStore.getState().railWidth).toBe(900);

    // Closing leaves the detail on screen for the panel's fade-out; the next
    // open is what puts the rail back at its list.
    useUiStore.getState().inspect({ type: 'connection', id: 'google' });
    useUiStore.getState().closeRail();
    expect(useUiStore.getState()).toMatchObject({ railOpen: false, inspector: { type: 'connection', id: 'google' } });

    useUiStore.getState().openRail('context');
    expect(useUiStore.getState()).toMatchObject({ railOpen: true, inspector: null });
  });
});

describe('sidebar width', () => {
  // Each test reads the store as a fresh device would, so the module is
  // re-imported over its own storage and both are put back afterwards.
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  it('starts a device that never resized the sidebar at the design width', async () => {
    const { useUiStore: fresh } = await import('./ui-store');
    expect(fresh.getState().sidebarWidth).toBe(340);
  });

  it('keeps a width the person dragged to over the design width', async () => {
    window.localStorage.setItem('rally.sidebar-width', '320');
    const { useUiStore: fresh } = await import('./ui-store');
    expect(fresh.getState().sidebarWidth).toBe(320);
  });
});

describe('sidebar section', () => {
  // Read as a restarted app would: the module is re-imported over storage the
  // previous run left behind.
  beforeEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });
  afterEach(() => {
    window.localStorage.clear();
    vi.resetModules();
  });

  it('starts on Canvases on a device that never chose', async () => {
    const { useUiStore: fresh } = await import('./ui-store');
    expect(fresh.getState().sidebarSection).toBe('canvases');
  });

  it('comes back to the section chosen before a restart', async () => {
    const { useUiStore: first } = await import('./ui-store');
    first.getState().setSidebarSection('sidekicks');

    vi.resetModules();
    const { useUiStore: restarted } = await import('./ui-store');
    expect(restarted.getState().sidebarSection).toBe('sidekicks');
  });

  it('opens on Canvases where a section the rail no longer has was stored', async () => {
    window.localStorage.setItem('rally.sidebar-section', 'channels');
    const { useUiStore: fresh } = await import('./ui-store');
    expect(fresh.getState().sidebarSection).toBe('canvases');
  });
});
