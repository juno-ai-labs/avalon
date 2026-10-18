import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openRailAtEvenSplit, railFillsPane, useRailFillsPane } from './rail-split';
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

describe('whether the panel takes the whole pane', () => {
  // The conversation keeps 424px beside a panel no narrower than 280px.
  it('sits beside the conversation while the pane holds both minimums', () => {
    expect(railFillsPane(1_044, 340)).toBe(false);
  });

  it('takes the pane once the conversation would drop under its minimum', () => {
    expect(railFillsPane(1_043, 340)).toBe(true);
  });

  it('re-renders a reader only when a resize changes the answer', () => {
    let width = 1_400;
    vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => width);
    const resize = (to: number): void => act(() => {
      width = to;
      window.dispatchEvent(new Event('resize'));
    });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useRailFillsPane(340);
    });
    const before = renders;

    resize(1_300);
    resize(1_200);
    expect(renders).toBe(before);
    expect(result.current).toBe(false);

    resize(900);
    expect(result.current).toBe(true);
    expect(renders).toBe(before + 1);
    vi.restoreAllMocks();
  });
});
