import { beforeEach, describe, expect, it } from 'vitest';
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

  it('keeps a separate remembered width per work stream', () => {
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
    expect(useUiStore.getState().sidebarWidth).toBe(240);
    expect(window.localStorage.getItem('rally.sidebar-width')).toBe('240');

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
