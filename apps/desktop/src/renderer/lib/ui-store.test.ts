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
      railExpanded: false,
      inspector: null,
    });
  });

  it('clamps and persists sidebar resizing', () => {
    useUiStore.getState().setSidebarWidth(120);
    expect(useUiStore.getState().sidebarWidth).toBe(260);
    expect(window.localStorage.getItem('avalon.sidebar-width')).toBe('260');

    useUiStore.getState().setSidebarWidth(900);
    expect(useUiStore.getState().sidebarWidth).toBe(480);
    expect(window.localStorage.getItem('avalon.sidebar-width')).toBe('480');
  });

  it('opens the requested contextual variant and resets stale detail state', () => {
    useUiStore.getState().inspect({ type: 'resource', id: 'old-resource' });
    useUiStore.getState().openRail('background');

    expect(useUiStore.getState()).toMatchObject({
      railOpen: true,
      railVariant: 'background',
      inspector: null,
    });
  });

  it('clamps resizing and clears inspector state when closed', () => {
    useUiStore.getState().setRailWidth(120);
    expect(useUiStore.getState().railWidth).toBe(320);

    useUiStore.getState().setRailWidth(900);
    expect(useUiStore.getState().railWidth).toBe(560);

    useUiStore.getState().inspect({ type: 'connection', id: 'google' });
    useUiStore.getState().closeRail();
    expect(useUiStore.getState()).toMatchObject({ railOpen: false, inspector: null, railExpanded: false });
  });
});
