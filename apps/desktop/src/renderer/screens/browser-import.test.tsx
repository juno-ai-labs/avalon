import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserImportContext } from '../../common/browser-import';

const harness = vi.hoisted(() => {
  const state = {
    context: null as BrowserImportContext | null,
    contextChanged: null as (() => void) | null,
  };
  const api = {
    previewSessionImport: vi.fn(async () => ({ title: 'Launch plan' })),
    importSession: vi.fn(async () => 'workstream-1'),
  };
  const bridge = {
    getRuntimeConfig: vi.fn(async () => ({ platform: 'linux' })),
    getBrowserImportContext: vi.fn(async () => state.context),
    onBrowserImportContextChanged: vi.fn((listener: () => void) => {
      state.contextChanged = listener;
      return () => undefined;
    }),
    completeBrowserImport: vi.fn(async () => undefined),
  };
  return { api, bridge, state };
});

vi.mock('../components/embedded-browser-view', () => ({
  EmbeddedBrowserNavigation: () => null,
  EmbeddedBrowserTabs: () => null,
  focusAddress: vi.fn(),
  useEmbeddedBrowser: () => ({
    state: { tabs: [] },
    active: { id: 'tab-1', url: 'https://claude.ai/chat/1', title: 'Launch plan' },
    error: null,
    command: vi.fn(async () => undefined),
  }),
  useEmbeddedBrowserPlacement: vi.fn(),
  useEmbeddedBrowserShortcuts: vi.fn(),
}));
vi.mock('../lib/browser-conversation-import', () => ({
  browserConversation: (tab: { url: string; title: string }) => ({ url: tab.url, title: tab.title }),
  readBrowserConversation: vi.fn(async () => ({ provider: 'claude', text: 'transcript' })),
}));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api: harness.api }) }));
vi.mock('../lib/platform', () => ({ desktopBridge: () => harness.bridge }));

import { BrowserImportWindow } from './browser-import';
import { useEmbeddedBrowserPlacement } from '../components/embedded-browser-view';
import { readBrowserConversation } from '../lib/browser-conversation-import';

describe('browser import window', () => {
  it('moves an open sheet to the Space a reused window is locked to', async () => {
    harness.state.context = { spaces: [{ id: 'space-a', name: 'Alpha' }, { id: 'space-b', name: 'Beta' }] };
    render(<Tooltip.Provider><BrowserImportWindow /></Tooltip.Provider>);
    await waitFor(() => expect(harness.bridge.getBrowserImportContext).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const sheet = await screen.findByRole('dialog', { name: 'Import channel' });
    expect(useEmbeddedBrowserPlacement).toHaveBeenLastCalledWith(expect.anything(), false);
    expect(within(sheet).getByRole('combobox', { name: 'Space' })).toHaveTextContent('Alpha');

    // Main reuses this window for an import started from Beta's channel list.
    harness.state.context = { spaces: [{ id: 'space-b', name: 'Beta' }], spaceLocked: true };
    await act(async () => { harness.state.contextChanged?.(); });

    const picker = within(sheet).getByRole('combobox', { name: 'Space' });
    await waitFor(() => expect(picker).toHaveTextContent('Beta'));
    expect(picker).toBeDisabled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(harness.api.importSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      { title: 'Launch plan', spaceIds: ['space-b'] },
    ));
  });

  it('shows a read failure on an empty page so ChatGPT cannot cover it', async () => {
    harness.state.context = { spaces: [{ id: 'space-a', name: 'Alpha' }] };
    vi.mocked(readBrowserConversation).mockRejectedValueOnce(new Error('ChatGPT could not return this conversation.'));
    render(<Tooltip.Provider><BrowserImportWindow /></Tooltip.Provider>);
    await waitFor(() => expect(harness.bridge.getBrowserImportContext).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ChatGPT could not return this conversation.');
    expect(screen.queryByRole('dialog', { name: 'Import channel' })).toBeNull();
    expect(useEmbeddedBrowserPlacement).toHaveBeenLastCalledWith(expect.anything(), false);
  });
});
