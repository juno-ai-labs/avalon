import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openRailAtEvenSplit } from './rail-split';
import { useUiStore } from './ui-store';

// Layout is the browser's, which jsdom does not do: the main pane starts 200px
// into a 1024px window, so the conversation is 824px wide.
describe('the width a panel opens at', () => {
  let pane: HTMLElement;
  const open = (scope = 'conversation-a'): void => useUiStore.getState().setRailScope(scope);
  const openRail = (): void => {
    useUiStore.getState().setRailScope('conversation-a');
    useUiStore.getState().openRail();
  };

  beforeEach(() => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1_024);
    pane = document.createElement('main');
    pane.className = 'main-pane';
    pane.getBoundingClientRect = () => DOMRect.fromRect({ x: 200, width: 824, height: 800 });
    document.body.append(pane);
    window.localStorage.clear();
    useUiStore.setState({ railOpen: false, railWidth: 320, railScope: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    pane.remove();
  });

  it('splits the main pane in half', () => {
    openRailAtEvenSplit('conversation-a', openRail);
    expect(useUiStore.getState().railWidth).toBe(412);
  });

  it('keeps a dragged width when switching items in a panel already open', () => {
    openRail();
    useUiStore.getState().setRailWidth(700);
    openRailAtEvenSplit('conversation-a', openRail);
    expect(useUiStore.getState().railWidth).toBe(700);
  });

  it('splits the whole pane when taking over the panel beside it', () => {
    // The Channel's panel is open and the pane keeps 600px clear for it; the
    // Breakout's panel takes that room over rather than adding to it.
    pane.style.paddingRight = '600px';
    useUiStore.setState({ railOpen: true, railScope: 'channel', railWidth: 600 });
    openRailAtEvenSplit('breakout', () => open('breakout'));
    expect(useUiStore.getState().railWidth).toBe(412);
  });

  it('leaves the dragged width saved for a restored panel', () => {
    openRail();
    useUiStore.getState().setRailWidth(500);
    useUiStore.setState({ railOpen: false });
    openRailAtEvenSplit('conversation-a', openRail);
    useUiStore.getState().setRailScope('conversation-a');
    expect(useUiStore.getState().railWidth).toBe(500);
  });
});
