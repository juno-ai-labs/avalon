import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserImportContext } from '../../common/browser-import';
import type * as SessionImportRunModule from '../lib/session-import-run';

const harness = vi.hoisted(() => {
  const state = {
    context: null as BrowserImportContext | null,
    contextChanged: null as (() => void) | null,
  };
  const api = {};
  let settle: (result: unknown) => void = () => undefined;
  const startSessionImportRun = vi.fn(() => ({
    done: new Promise((resolve) => { settle = resolve; }),
    cancel: vi.fn(async () => undefined),
  }));
  const bridge = {
    getRuntimeConfig: vi.fn(async () => ({ platform: 'linux' })),
    getBrowserImportContext: vi.fn(async () => state.context),
    onBrowserImportContextChanged: vi.fn((listener: () => void) => {
      state.contextChanged = listener;
      return () => undefined;
    }),
    completeBrowserImport: vi.fn(async () => undefined),
  };
  return { api, bridge, state, startSessionImportRun, settle: (result: unknown) => settle(result) };
});

vi.mock('../components/embedded-browser-view', () => ({
  EmbeddedBrowserNavigation: () => null,
  EmbeddedBrowserTabs: () => null,
  focusAddress: vi.fn(),
  useEmbeddedBrowser: () => ({
    state: { tabs: [] },
    active: { id: 'tab-1', url: 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c', title: 'Launch plan' },
    error: null,
    command: vi.fn(async () => undefined),
  }),
  useEmbeddedBrowserPlacement: vi.fn(),
  useEmbeddedBrowserShortcuts: vi.fn(),
}));
vi.mock('../lib/session-import-run', async (actual) => ({
  ...await actual<typeof SessionImportRunModule>(),
  startSessionImportRun: harness.startSessionImportRun,
}));
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({ api: harness.api }) }));
vi.mock('../lib/platform', () => ({ desktopBridge: () => harness.bridge }));

import { BrowserImportWindow } from './browser-import';

describe('browser import window', () => {
  it('moves an open sheet to the Space a reused window is locked to', async () => {
    harness.state.context = { spaces: [{ id: 'space-a', name: 'Alpha' }, { id: 'space-b', name: 'Beta' }] };
    render(<Tooltip.Provider><BrowserImportWindow /></Tooltip.Provider>);
    await waitFor(() => expect(harness.bridge.getBrowserImportContext).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const sheet = await screen.findByRole('dialog', { name: 'Import channel' });
    expect(within(sheet).getByRole('combobox', { name: 'Space' })).toHaveTextContent('Alpha');

    // Main reuses this window for an import started from Beta's channel list.
    harness.state.context = { spaces: [{ id: 'space-b', name: 'Beta' }], spaceLocked: true };
    await act(async () => { harness.state.contextChanged?.(); });

    const picker = within(sheet).getByRole('combobox', { name: 'Space' });
    await waitFor(() => expect(picker).toHaveTextContent('Beta'));
    expect(picker).toBeDisabled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(harness.startSessionImportRun).toHaveBeenCalledWith(expect.objectContaining({
      tabId: 'tab-1',
      sourceUrl: 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c',
      mode: { kind: 'create', title: 'Launch plan', spaceIds: ['space-b'], clientMessageId: expect.any(String) },
    })));
    expect(await screen.findByText('Starting the import…')).toBeInTheDocument();

    // The agent reports the page asks for sign-in; the person reads Rally's words for it.
    await act(async () => { harness.settle({ kind: 'failed', reason: 'sign_in_required' }); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign in to the conversation’s site in this window, then import again.');
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
  });
});
