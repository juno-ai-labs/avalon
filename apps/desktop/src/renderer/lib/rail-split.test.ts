import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sizeRailToEvenSplit } from './rail-split';
import { useUiStore } from './ui-store';

// Layout is the browser's, which jsdom does not do: the main pane starts 200px
// into jsdom's 1024px window, so the conversation is 824px wide.
describe('the even split a panel opens at', () => {
  let pane: HTMLElement;
  beforeEach(() => {
    pane = document.createElement('main');
    pane.className = 'main-pane';
    pane.getBoundingClientRect = () => DOMRect.fromRect({ x: 200, width: 824, height: 800 });
    document.body.append(pane);
    useUiStore.setState({ railWidth: 320, railScope: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    pane.remove();
  });

  it('matches the conversation when the window can grow to fit the panel', () => {
    vi.spyOn(window.screen, 'availWidth', 'get').mockReturnValue(2_000);
    sizeRailToEvenSplit();
    expect(useUiStore.getState().railWidth).toBe(824);
  });

  it('splits what the screen allows when the window can only partly grow', () => {
    vi.spyOn(window.screen, 'availWidth', 'get').mockReturnValue(1_400);
    sizeRailToEvenSplit();
    expect(useUiStore.getState().railWidth).toBe(600);
  });

  it('splits the window in half when it cannot grow', () => {
    vi.spyOn(window.screen, 'availWidth', 'get').mockReturnValue(1_024);
    sizeRailToEvenSplit();
    expect(useUiStore.getState().railWidth).toBe(412);
  });

  it('narrows a panel left wider than an even split', () => {
    vi.spyOn(window.screen, 'availWidth', 'get').mockReturnValue(1_024);
    useUiStore.setState({ railWidth: 700 });
    sizeRailToEvenSplit();
    expect(useUiStore.getState().railWidth).toBe(412);
  });
});
