import * as Tooltip from '@radix-ui/react-tooltip';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EmbeddedBrowserState } from '../../common/embedded-browser';
import { EmbeddedBrowserRail } from './embedded-browser-rail';

const blank: EmbeddedBrowserState = {
  activeTabId: 'a',
  tabs: [{ id: 'a', title: '', url: 'about:blank', loading: false, canGoBack: false, canGoForward: false, favicon: null }],
};
const commandEmbeddedBrowser = vi.fn(async () => ({ kind: 'state' as const, state: blank }));

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({
    commandEmbeddedBrowser,
    getEmbeddedBrowserState: async () => blank,
    onEmbeddedBrowserState: () => () => undefined,
    onEmbeddedBrowserHostRequest: () => () => undefined,
    setEmbeddedBrowserVisible: async () => undefined,
    setEmbeddedBrowserBounds: async () => undefined,
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
});
