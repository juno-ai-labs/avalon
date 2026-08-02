import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from './ui-store';

describe('context rail state', () => {
  beforeEach(() => {
    useUiStore.setState({
      sidebarOpen: false,
      railOpen: false,
      railVariant: 'context',
      railWidth: 360,
      railExpanded: false,
      inspector: null,
    });
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
