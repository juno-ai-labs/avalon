import * as Tooltip from '@radix-ui/react-tooltip';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { EmbeddedBrowserState } from '../../common/embedded-browser';
import { EmbeddedBrowserRail } from './embedded-browser-rail';

const blank: EmbeddedBrowserState = {
  activeTabId: 'a',
  tabs: [{ id: 'a', title: '', url: 'about:blank', loading: false, canGoBack: false, canGoForward: false, favicon: null }],
};
const commandEmbeddedBrowser = vi.fn(async () => ({ kind: 'state' as const, state: blank }));
const setEmbeddedBrowserBounds = vi.fn(async () => undefined);
/** What main reports the browser holds; a test that needs a page on screen replaces it. */
let held: EmbeddedBrowserState = blank;

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    commandEmbeddedBrowser,
    getEmbeddedBrowserState: async () => held,
    onEmbeddedBrowserState: () => () => undefined,
    onEmbeddedBrowserHostRequest: () => () => undefined,
    setEmbeddedBrowserVisible: async () => undefined,
    setEmbeddedBrowserBounds,
  }),
}));

describe('the browser rail', () => {
  it('closes on the close shortcut while the rail itself holds focus over its only blank tab', async () => {
    const onClose = vi.fn();
    render(<Tooltip.Provider><EmbeddedBrowserRail onClose={onClose} onResize={vi.fn()} width={420} /></Tooltip.Provider>);
    await screen.findByRole('tab');
    const surface = screen.getByRole('complementary', { name: 'Browser' });
    surface.focus();
    await waitFor(() => expect(document.activeElement).toBe(surface));
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW', ctrlKey: true, metaKey: true });
    expect(onClose).toHaveBeenCalledOnce();
    expect(commandEmbeddedBrowser).not.toHaveBeenCalledWith({ action: 'close', tabId: 'a' });
  });

  it('holds the native page to its panel’s frame as it slides open, and moves it with the panel when the sidebar is resized', async () => {
    // jsdom lays nothing out and observes nothing: supply the geometry, and
    // an observer that reports to whoever watches the element that changed.
    const observers: { targets: Set<Element>; report: () => void }[] = [];
    vi.stubGlobal('ResizeObserver', class {
      private readonly targets = new Set<Element>();
      constructor(callback: ResizeObserverCallback) { observers.push({ targets: this.targets, report: () => callback([], this as unknown as ResizeObserver) }); }
      observe(target: Element): void { this.targets.add(target); }
      unobserve(): void {}
      disconnect(): void { this.targets.clear(); }
    });
    // A leading frame: anchored at the pane's left edge, its content held to its far edge.
    let paneLeft = 400;
    let shown = 200;
    const geometry = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('embedded-browser-page')) return DOMRect.fromRect({ x: paneLeft + shown - 500, y: 88, width: 500, height: 600 });
      if (this.classList.contains('rail-surface')) return DOMRect.fromRect({ x: paneLeft, y: 0, width: shown, height: 700 });
      return DOMRect.fromRect({});
    });
    const report = (selector: string): void => {
      const target = document.querySelector(selector)!;
      act(() => { for (const observer of observers) if (observer.targets.has(target)) observer.report(); });
    };
    // The native page is placed only over a real address.
    held = { activeTabId: 'a', tabs: [{ ...blank.tabs[0]!, title: 'Example', url: 'https://example.com/' }] };
    onTestFinished(() => {
      held = blank;
      geometry.mockRestore();
      vi.unstubAllGlobals();
    });
    render(<Tooltip.Provider><main className="main-pane"><EmbeddedBrowserRail onClose={vi.fn()} onResize={vi.fn()} width={500} /></main></Tooltip.Provider>);
    // Partway through the slide, the page's own box reaches back under the sidebar.
    await waitFor(() => expect(setEmbeddedBrowserBounds).toHaveBeenLastCalledWith({ x: 400, y: 88, width: 200, height: 600 }));
    shown = 500;
    report('.rail-surface');
    expect(setEmbeddedBrowserBounds).toHaveBeenLastCalledWith({ x: 400, y: 88, width: 500, height: 600 });
    // The sidebar narrows by 60px: the pane's box changes, the panel's and the page's do not.
    paneLeft = 340;
    report('.main-pane');
    expect(setEmbeddedBrowserBounds).toHaveBeenLastCalledWith({ x: 340, y: 88, width: 500, height: 600 });
  });
});
