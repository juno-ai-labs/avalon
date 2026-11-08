import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mainPaneWidth, openRailAtEvenSplit, railFillsPane, restoreRail, useRailFillsPane } from './rail-split';
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
    useUiStore.getState().setRailWidth(360);
    openRailAtEvenSplit('conversation-a', openRail);
    expect(useUiStore.getState().railWidth).toBe(360);
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
    useUiStore.getState().setRailWidth(380);
    useUiStore.setState({ railOpen: false });
    openRailAtEvenSplit('conversation-a', openRail);
    useUiStore.getState().setRailScope('conversation-a');
    expect(useUiStore.getState().railWidth).toBe(380);
  });

  it('restores a panel nobody resized at the even split', () => {
    restoreRail('conversation-a', openRail);
    expect(useUiStore.getState().railWidth).toBe(412);
  });

  it('restores a resized panel at the width it was dragged to', () => {
    openRail();
    useUiStore.getState().setRailWidth(380);
    useUiStore.setState({ railOpen: false, railScope: null });
    restoreRail('conversation-a', openRail);
    expect(useUiStore.getState().railWidth).toBe(380);
  });

  // The same drag, read back in a window of another width.
  const resizeWindow = (width: number, paneLeft: number): void => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width);
    pane.getBoundingClientRect = () => DOMRect.fromRect({ x: paneLeft, width: width - paneLeft, height: 800 });
  };

  it('restores a panel dragged in a narrow window at the same share of a wide one', () => {
    // A 1,000px window beside the 416px sidebar: a 584px pane, dragged to 292.
    resizeWindow(1_000, 416);
    openRail();
    useUiStore.getState().setRailWidth(292);
    useUiStore.setState({ railOpen: false, railScope: null });

    // At 1,440 the pane is 1,024px: half of it, inside 280 to 1,024 - 424.
    resizeWindow(1_440, 416);
    restoreRail('conversation-a', openRail);
    expect(useUiStore.getState().railWidth).toBe(512);
  });

  it('restores a width stored in a 390px window within the bounds of a 1,440px one', () => {
    // A phone-width tab has no sidebar beside the pane.
    resizeWindow(390, 0);
    openRail();
    useUiStore.getState().setRailWidth(390);
    useUiStore.setState({ railOpen: false, railScope: null });

    resizeWindow(1_440, 416);
    restoreRail('conversation-a', openRail);
    expect(useUiStore.getState().railWidth).toBe(600);
  });

  it('keeps a pixel width saved before shares, inside the pane it now opens in', () => {
    window.localStorage.setItem('rally.rail-width:conversation-a', '900');
    restoreRail('conversation-a', openRail);
    expect(useUiStore.getState().railWidth).toBe(400);
  });
});

describe('whether the panel takes the whole pane', () => {
  // The panel opens at half the pane, and each half keeps the conversation's 424px.
  it('sits beside the conversation while half the pane holds its minimum', () => {
    expect(railFillsPane(1_264, 416)).toBe(false);
  });

  it('takes the pane once the even split would drop the conversation under its minimum', () => {
    expect(railFillsPane(1_263, 416)).toBe(true);
    expect(railFillsPane(1_180, 416)).toBe(true);
  });

  it('measures the pane after a sidebar that gave way in a narrow tab', () => {
    // 700 - 424 = 276px of sidebar, not the 416 stored.
    expect(mainPaneWidth(700, 416)).toBe(424);
    expect(mainPaneWidth(1_440, 416)).toBe(1_024);
  });

  it('re-renders a reader only when a resize changes the answer', () => {
    let width = 1_500;
    vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => width);
    const resize = (to: number): void => act(() => {
      width = to;
      window.dispatchEvent(new Event('resize'));
    });
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useRailFillsPane(416);
    });
    const before = renders;

    resize(1_400);
    resize(1_300);
    expect(renders).toBe(before);
    expect(result.current).toBe(false);

    resize(900);
    expect(result.current).toBe(true);
    expect(renders).toBe(before + 1);
    vi.restoreAllMocks();
  });
});
