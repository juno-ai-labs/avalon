import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BrowserImportContext } from '../../common/browser-import';

const harness = vi.hoisted(() => {
  const state = {
    context: null as BrowserImportContext | null,
    contextChanged: null as (() => void) | null,
  };
  const api = {
    previewSessionImport: vi.fn(async () => ({ title: 'Launch plan' })),
    // The server creates the Channel under the id the caller names.
    importSession: vi.fn(async (_preview: unknown, _key: string, input: { workstreamId?: string }) => input.workstreamId ?? 'workstream-1'),
  };
  const bridge = {
    getRuntimeConfig: vi.fn(async () => ({ platform: 'linux' })),
    getBrowserImportContext: vi.fn(async () => state.context),
    onBrowserImportContextChanged: vi.fn((listener: () => void) => {
      state.contextChanged = listener;
      return () => undefined;
    }),
    completeBrowserImport: vi.fn(async () => undefined),
    reportBrowserImport: vi.fn(async () => undefined),
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

describe('browser import window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.context = { spaces: [{ id: 'space-a', name: 'Alpha' }] };
  });

  async function submit(): Promise<void> {
    render(<Tooltip.Provider><BrowserImportWindow /></Tooltip.Provider>);
    await waitFor(() => expect(harness.bridge.getBrowserImportContext).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const sheet = await screen.findByRole('dialog', { name: 'Import channel' });
    await waitFor(() => expect(within(sheet).getByRole('combobox', { name: 'Space' })).toHaveTextContent('Alpha'));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Import' }));
  }

  it('names the Channel to the main window before creating it under that id', async () => {
    await submit();

    await waitFor(() => expect(harness.bridge.completeBrowserImport).toHaveBeenCalled());
    expect(harness.bridge.reportBrowserImport).toHaveBeenCalledTimes(1);
    const [[announced]] = harness.bridge.reportBrowserImport.mock.calls as unknown as [[{ phase: string; workstreamId: string; title: string; spaceId: string }]];
    expect(harness.bridge.completeBrowserImport).toHaveBeenCalledWith(announced.workstreamId);
    expect(announced).toMatchObject({ phase: 'importing', title: 'Launch plan', spaceId: 'space-a' });
    expect(harness.api.importSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      { title: 'Launch plan', spaceIds: ['space-a'], workstreamId: announced.workstreamId },
    );
    expect(harness.bridge.reportBrowserImport.mock.invocationCallOrder[0])
      .toBeLessThan(harness.api.importSession.mock.invocationCallOrder[0]!);
  });

  // The Channel exists, so the main window must settle it rather than wait.
  it('settles the main window\'s row when the hand-off fails after the create landed', async () => {
    harness.bridge.completeBrowserImport.mockRejectedValueOnce(new Error('The main window did not answer.'));

    await submit();

    expect(await screen.findByText('The main window did not answer.')).toBeInTheDocument();
    const [[announced], [settled]] = harness.bridge.reportBrowserImport.mock.calls as unknown as [[{ workstreamId: string }], [{ phase: string; workstreamId: string }]];
    expect(settled).toEqual({ phase: 'imported', workstreamId: announced.workstreamId });
  });

  // A receipt reserved before `workstreamId` existed replays under its own id.
  it('takes the announced row away when the Channel was created under another id', async () => {
    harness.api.importSession.mockResolvedValueOnce('workstream-legacy');

    await submit();

    await waitFor(() => expect(harness.bridge.completeBrowserImport).toHaveBeenCalledWith('workstream-legacy'));
    const [[announced], [dropped]] = harness.bridge.reportBrowserImport.mock.calls as unknown as [[{ workstreamId: string }], [{ phase: string; workstreamId: string }]];
    expect(dropped).toEqual({ phase: 'failed', workstreamId: announced.workstreamId });
    expect(harness.bridge.reportBrowserImport.mock.invocationCallOrder[1])
      .toBeLessThan(harness.bridge.completeBrowserImport.mock.invocationCallOrder[0]!);
  });

  it('tells the main window the Channel is gone when the create fails, and keeps the sheet', async () => {
    harness.api.importSession.mockRejectedValueOnce(new Error('The import was refused.'));

    await submit();

    expect(await screen.findByText('The import was refused.')).toBeInTheDocument();
    const [[announced], [failed]] = harness.bridge.reportBrowserImport.mock.calls as unknown as [[{ workstreamId: string }], [{ phase: string; workstreamId: string }]];
    expect(failed).toEqual({ phase: 'failed', workstreamId: announced.workstreamId });
    expect(harness.bridge.completeBrowserImport).not.toHaveBeenCalled();
  });

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
    await waitFor(() => expect(harness.api.importSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      { title: 'Launch plan', spaceIds: ['space-b'], workstreamId: expect.any(String) },
    ));
  });
});
