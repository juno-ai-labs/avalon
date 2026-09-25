import { fireEvent, render, screen, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { describe, expect, it, vi } from 'vitest';
import type { EmbeddedBrowserCommand, EmbeddedBrowserState, EmbeddedBrowserTab } from '../../common/embedded-browser';
import { EmbeddedBrowserTabs } from './embedded-browser-view';

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

  it('hands closing the only blank tab to the host, and closes any other tab', () => {
    const command = vi.fn<(input: EmbeddedBrowserCommand) => Promise<void>>(async () => undefined);
    const onCloseLast = vi.fn();
    const only = (extra: Partial<EmbeddedBrowserTab>): EmbeddedBrowserState => ({ activeTabId: 'a', tabs: [tab('a', '', extra)] });
    const { rerender } = render(<Tooltip.Provider>
      <EmbeddedBrowserTabs command={command} onCloseLast={onCloseLast} onNewTab={vi.fn()} state={only({ url: 'about:blank' })} />
    </Tooltip.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Close New tab' }));
    expect(onCloseLast).toHaveBeenCalledOnce();
    expect(command).not.toHaveBeenCalled();
    rerender(<Tooltip.Provider>
      <EmbeddedBrowserTabs command={command} onCloseLast={onCloseLast} onNewTab={vi.fn()} state={only({})} />
    </Tooltip.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Close New tab' }));
    expect(command).toHaveBeenLastCalledWith({ action: 'close', tabId: 'a' });
    expect(onCloseLast).toHaveBeenCalledOnce();
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
