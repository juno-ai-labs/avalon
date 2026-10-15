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

  it('matches the conversation when the window can grow to fit the panel', () => {
    vi.spyOn(window.screen, 'availWidth', 'get').mockReturnValue(2_000);
    openRailAtEvenSplit('conversation-a', openRail, true);
    expect(useUiStore.getState().railWidth).toBe(824);
  });

  it('splits what the screen allows when the window can only partly grow', () => {
    vi.spyOn(window.screen, 'availWidth', 'get').mockReturnValue(1_400);
    openRailAtEvenSplit('conversation-a', openRail, true);
    expect(useUiStore.getState().railWidth).toBe(600);
  });

  it('splits the window in half when it cannot grow', () => {
    vi.spyOn(window.screen, 'availWidth', 'get').mockReturnValue(1_024);
    openRailAtEvenSplit('conversation-a', openRail, true);
    expect(useUiStore.getState().railWidth).toBe(412);
  });

  it('splits a browser tab in half, since a tab cannot widen its window', () => {
    vi.spyOn(window.screen, 'availWidth', 'get').mockReturnValue(2_000);
    openRailAtEvenSplit('conversation-a', openRail, false);
    expect(useUiStore.getState().railWidth).toBe(412);
  });

  it('keeps a dragged width when switching items in a panel already open', () => {
    vi.spyOn(window.screen, 'availWidth', 'get').mockReturnValue(2_000);
    openRail();
    useUiStore.getState().setRailWidth(700);
    openRailAtEvenSplit('conversation-a', openRail, true);
    expect(useUiStore.getState().railWidth).toBe(700);
  });

  it('measures only the conversation when taking over the panel beside it', () => {
    // The Channel's panel is open and has widened the window by 600px; the
    // conversation is what the pane keeps clear of it.
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1_624);
    vi.spyOn(window.screen, 'availWidth', 'get').mockReturnValue(2_560);
    pane.style.paddingRight = '600px';
    useUiStore.setState({ railOpen: true, railScope: 'channel', railWidth: 600 });
    openRailAtEvenSplit('breakout', () => open('breakout'), true);
    expect(useUiStore.getState().railWidth).toBe(824);
  });

  it('leaves the dragged width saved for a restored panel', () => {
    vi.spyOn(window.screen, 'availWidth', 'get').mockReturnValue(2_000);
    openRail();
    useUiStore.getState().setRailWidth(500);
    useUiStore.setState({ railOpen: false });
    openRailAtEvenSplit('conversation-a', openRail, true);
    useUiStore.getState().setRailScope('conversation-a');
    expect(useUiStore.getState().railWidth).toBe(500);
  });
});
