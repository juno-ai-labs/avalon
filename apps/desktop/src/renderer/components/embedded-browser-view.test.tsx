import { fireEvent, render, screen, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { describe, expect, it, vi } from 'vitest';
import type { EmbeddedBrowserCommand, EmbeddedBrowserHostRequest, EmbeddedBrowserState, EmbeddedBrowserTab } from '../../common/embedded-browser';
import { useRef } from 'react';
import { EmbeddedBrowserTabs, useEmbeddedBrowserShortcuts } from './embedded-browser-view';

const hostRequests = vi.hoisted(() => new Set<(request: EmbeddedBrowserHostRequest) => void>());
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    onEmbeddedBrowserHostRequest: (listener: (request: EmbeddedBrowserHostRequest) => void) => {
      hostRequests.add(listener);
      return () => hostRequests.delete(listener);
    },
  }),
}));

const tab = (id: string, title: string, extra: Partial<EmbeddedBrowserTab> = {}): EmbeddedBrowserTab => ({
  id, title, url: `https://${id}.example/`, loading: false, canGoBack: false, canGoForward: false, favicon: null, ...extra,
});
const state: EmbeddedBrowserState = {
  activeTabId: 'b',
  tabs: [tab('a', 'Alpha', { favicon: 'https://a.example/favicon.ico' }), tab('b', 'Beta', { loading: true }), tab('c', 'Gamma')],
};

function renderTabs() {
  const command = vi.fn<(input: EmbeddedBrowserCommand) => Promise<void>>(async () => undefined);
  const onNewTab = vi.fn();
  render(<Tooltip.Provider><EmbeddedBrowserTabs command={command} onNewTab={onNewTab} state={state} /></Tooltip.Provider>);
  return { command, onNewTab };
}

describe('the browser tab strip', () => {
  it('shows each tab’s icon or loading state and title, with one tab stop on the active tab', () => {
    renderTabs();
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((element) => element.textContent)).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(tabs.map((element) => element.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(tabs[0]!.querySelector('img')).toHaveAttribute('src', 'https://a.example/favicon.ico');
    expect(tabs[1]!.querySelector('.embedded-browser-tab-spinner')).not.toBeNull();
    expect(tabs[2]!.closest('.embedded-browser-tab')).toHaveAttribute('title', 'Gamma\nhttps://c.example/');
  });

  it('selects, moves between, and closes tabs from the keyboard and pointer', () => {
    const { command, onNewTab } = renderTabs();
    const [alpha, beta, gamma] = screen.getAllByRole('tab');
    fireEvent.click(alpha!);
    expect(command).toHaveBeenLastCalledWith({ action: 'select', tabId: 'a' });
    fireEvent.keyDown(beta!, { key: 'ArrowRight' });
    expect(command).toHaveBeenLastCalledWith({ action: 'select', tabId: 'c' });
    fireEvent.keyDown(beta!, { key: 'Home' });
    expect(command).toHaveBeenLastCalledWith({ action: 'select', tabId: 'a' });
    fireEvent.keyDown(beta!, { key: 'Delete' });
    expect(command).toHaveBeenLastCalledWith({ action: 'close', tabId: 'b' });
    fireEvent(gamma!.closest('.embedded-browser-tab')!, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    expect(command).toHaveBeenLastCalledWith({ action: 'close', tabId: 'c' });
    fireEvent.click(within(alpha!.closest('.embedded-browser-tab') as HTMLElement).getByRole('button', { name: 'Close Alpha' }));
    expect(command).toHaveBeenLastCalledWith({ action: 'close', tabId: 'a' });
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    expect(onNewTab).toHaveBeenCalledOnce();
  });

  it('hands closing the only tab to the host, closing it first unless it is blank', () => {
    const command = vi.fn<(input: EmbeddedBrowserCommand) => Promise<void>>(async () => undefined);
    const onCloseLast = vi.fn();
    const only = (extra: Partial<EmbeddedBrowserTab>): EmbeddedBrowserState => ({ activeTabId: 'a', tabs: [tab('a', '', extra)] });
    const { rerender } = render(<Tooltip.Provider>
      <EmbeddedBrowserTabs command={command} onCloseLast={onCloseLast} onNewTab={vi.fn()} state={only({ url: 'about:blank' })} />
    </Tooltip.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Close New tab' }));
    fireEvent(screen.getByRole('tab').closest('.embedded-browser-tab')!, new MouseEvent('auxclick', { bubbles: true, button: 1 }));
    fireEvent.keyDown(screen.getByRole('tab'), { key: 'Delete' });
    expect(onCloseLast).toHaveBeenCalledTimes(3);
    expect(command).not.toHaveBeenCalled();
    rerender(<Tooltip.Provider>
      <EmbeddedBrowserTabs command={command} onCloseLast={onCloseLast} onNewTab={vi.fn()} state={only({})} />
    </Tooltip.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Close New tab' }));
    expect(command).toHaveBeenLastCalledWith({ action: 'close', tabId: 'a' });
    expect(onCloseLast).toHaveBeenCalledTimes(4);
  });

  it('hands the close shortcut on the only tab to the host, closing it first unless it is blank', () => {
    const command = vi.fn<(input: EmbeddedBrowserCommand) => Promise<void>>(async () => undefined);
    const onCloseLast = vi.fn();
    function Host({ state }: { state: EmbeddedBrowserState }): React.JSX.Element {
      const scope = useRef<HTMLDivElement>(null);
      const addressRef = useRef<HTMLInputElement>(null);
      useEmbeddedBrowserShortcuts({ state, command, addressRef, scope, onCloseLast });
      return <div ref={scope}><input aria-label="Website address" ref={addressRef} /></div>;
    }
    const only = (extra: Partial<EmbeddedBrowserTab>): EmbeddedBrowserState => ({ activeTabId: 'a', tabs: [tab('a', '', extra)] });
    const { rerender } = render(<Host state={only({ url: 'about:blank' })} />);
    screen.getByRole('textbox', { name: 'Website address' }).focus();
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW', ctrlKey: true, metaKey: true });
    expect(onCloseLast).toHaveBeenCalledOnce();
    expect(command).not.toHaveBeenCalled();
    rerender(<Host state={only({})} />);
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW', ctrlKey: true, metaKey: true });
    expect(command).toHaveBeenLastCalledWith({ action: 'close', tabId: 'a' });
    expect(onCloseLast).toHaveBeenCalledTimes(2);
    // ⌘W inside the page reaches the host as a request from main.
    command.mockClear();
    for (const listener of hostRequests) listener('close-last-tab');
    expect(command).toHaveBeenCalledExactlyOnceWith({ action: 'close', tabId: 'a' });
    expect(onCloseLast).toHaveBeenCalledTimes(3);
  });

  it('moves a dragged tab to where it is dropped', () => {
    const { command } = renderTabs();
    const [alpha, , gamma] = screen.getAllByRole('tab').map((element) => element.closest('.embedded-browser-tab') as HTMLElement);
    vi.spyOn(gamma!, 'getBoundingClientRect').mockReturnValue({ left: 200, width: 100 } as DOMRect);
    fireEvent.dragStart(alpha!, { dataTransfer: { effectAllowed: '' } });
    fireEvent.dragOver(gamma!, { clientX: 290 });
    fireEvent.drop(gamma!);
    expect(command).toHaveBeenLastCalledWith({ action: 'move', tabId: 'a', index: 2 });
  });
});
