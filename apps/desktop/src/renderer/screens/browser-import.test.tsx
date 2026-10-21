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
    getRuntimeConfig: vi.fn(async () => ({ platform: 'linux', webBaseUrl: 'https://rallywith.ai' })),
    copyText: vi.fn(async () => undefined),
    getBrowserImportContext: vi.fn(async () => state.context),
    onBrowserImportContextChanged: vi.fn((listener: () => void) => {
      state.contextChanged = listener;
      return () => undefined;
    }),
    completeBrowserImport: vi.fn(async () => undefined),
    reportBrowserImport: vi.fn(async () => undefined),
    commandEmbeddedBrowser: vi.fn(async () => ({ kind: 'screenshot', mimeType: 'image/jpeg', data: 'cGFnZQ==', width: 800, height: 600 })),
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
vi.mock('../lib/app-session', () => ({ useAppSession: () => ({
  api: harness.api,
  session: { workspace: { region: 'global', id: '00000000-0000-7000-8000-000000000009' } },
}) }));
vi.mock('../lib/platform', () => ({ desktopBridge: () => harness.bridge }));

import { BrowserImportWindow } from './browser-import';

describe('browser import window', () => {
  it('moves an open sheet to the Space a reused window is locked to', async () => {
    harness.state.context = { spaces: [{ id: 'space-a', name: 'Alpha' }, { id: 'space-b', name: 'Beta' }] };
    render(<Tooltip.Provider><BrowserImportWindow /></Tooltip.Provider>);
    await waitFor(() => expect(harness.bridge.getBrowserImportContext).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const sheet = await screen.findByRole('dialog', { name: 'Import thread' });
    expect(within(sheet).getByRole('combobox', { name: 'Channel' })).toHaveTextContent('Alpha');

    // Main reuses this window for an import started from Beta's channel list.
    harness.state.context = { spaces: [{ id: 'space-b', name: 'Beta' }], spaceLocked: true };
    await act(async () => { harness.state.contextChanged?.(); });

    const picker = within(sheet).getByRole('combobox', { name: 'Channel' });
    await waitFor(() => expect(picker).toHaveTextContent('Beta'));
    expect(picker).toBeDisabled();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(harness.startSessionImportRun).toHaveBeenCalledWith(expect.objectContaining({
      tabId: 'tab-1',
      sourceUrl: 'https://claude.ai/chat/4f2b7c1e-9a3d-4e8b-b1c2-0d9e8f7a6b5c',
      mode: { kind: 'create', title: 'Launch plan', spaceIds: ['space-b'], clientMessageId: expect.any(String) },
    })));
    const progress = await screen.findByRole('dialog', { name: 'Importing conversation' });
    expect(within(progress).getByText('Starting the import…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import', hidden: true })).toBeDisabled();

    // Each step is listed in the harness's words, then in the tool's summary of what it did.
    const { onSteps } = (harness.startSessionImportRun.mock.lastCall as unknown as [{ onSteps: (steps: unknown[]) => void }])[0];
    await act(async () => {
      onSteps([
        { id: 'call-1', label: 'Read the page outline', status: 'done' },
        { id: 'call-2', label: 'Running a script in the page', status: 'running' },
      ]);
    });
    expect(within(progress).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Read the page outline',
      'Running a script in the page',
    ]);
    // Between tools, the model is deciding; the list says so rather than looking stalled.
    await act(async () => {
      onSteps([
        { id: 'call-1', label: 'Read the page outline', status: 'done' },
        { id: 'call-2', label: 'Ran a script in the page', status: 'done' },
      ]);
    });
    expect(within(progress).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Read the page outline',
      'Ran a script in the page',
      'Deciding the next step…',
    ]);
    // Past three, the oldest fold into a count so the latest stay in view.
    await act(async () => {
      onSteps(['outline', 'click', 'script-1', 'script-2', 'script-3'].map((id) => (
        { id, label: id === 'outline' ? 'Read the page outline' : id === 'click' ? 'Clicked in the page' : 'Ran a script in the page', status: 'done' as const })));
    });
    expect(within(progress).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      '2 previous actions',
      'Ran a script in the page',
      'Ran a script in the page',
      'Ran a script in the page',
      'Deciding the next step…',
    ]);
    // Behind the blur is the page as the agent last left it.
    await waitFor(() => expect(document.querySelector('.browser-import-mirror')).toHaveAttribute('src', 'data:image/jpeg;base64,cGFnZQ=='));

    // The API reserved the Channel: the main window lists it as importing.
    const { onStarted } = (harness.startSessionImportRun.mock.lastCall as unknown as [{ onStarted: (run: { workstreamId: string; substreamId: string }) => void }])[0];
    await act(async () => { onStarted({ workstreamId: 'w-reserved', substreamId: 'c-agent' }); });
    expect(harness.bridge.reportBrowserImport).toHaveBeenLastCalledWith({ phase: 'importing', workstreamId: 'w-reserved', title: 'Launch plan', spaceId: 'space-b' });

    // The agent reports the page asks for sign-in; the person reads Rally's words for it.
    await act(async () => { harness.settle({ kind: 'failed', reason: 'sign_in_required' }); });
    // The Channel will not open, so the main window takes its row away.
    expect(harness.bridge.reportBrowserImport).toHaveBeenLastCalledWith({ phase: 'failed', workstreamId: 'w-reserved' });
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Sign in to the conversation’s site in this window, then import again.');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled();
  });

  it('imports as a breakout of the thread it was opened from, and opens that breakout', async () => {
    harness.startSessionImportRun.mockClear();
    harness.bridge.reportBrowserImport.mockClear();
    harness.state.context = { spaces: [], breakout: { workstreamId: 'w-thread', title: 'Garden' } };
    render(<Tooltip.Provider><BrowserImportWindow /></Tooltip.Provider>);
    await waitFor(() => expect(harness.bridge.getBrowserImportContext).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const sheet = await screen.findByRole('dialog', { name: 'Import as breakout' });
    // Where the Breakout lands is the thread it was opened from, not a choice here.
    expect(within(sheet).queryByRole('combobox', { name: 'Channel' })).toBeNull();
    expect(within(sheet).getByRole('textbox', { name: 'Thread' })).toHaveValue('Garden');
    expect(within(sheet).getByRole('textbox', { name: 'Name of breakout' })).toHaveValue('Launch plan');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Import' }));
    await waitFor(() => expect(harness.startSessionImportRun).toHaveBeenCalledWith(expect.objectContaining({
      mode: { kind: 'breakout', workstreamId: 'w-thread', title: 'Launch plan', clientMessageId: expect.any(String) },
    })));
    const { onStarted } = (harness.startSessionImportRun.mock.lastCall as unknown as [{ onStarted: (run: { workstreamId: string; substreamId: string }) => void }])[0];
    await act(async () => { onStarted({ workstreamId: 'w-thread', substreamId: 'c-agent' }); });
    // The thread already exists, so the main window lists nothing as importing.
    expect(harness.bridge.reportBrowserImport).not.toHaveBeenCalled();

    await act(async () => { harness.settle({ kind: 'imported', workstreamId: 'w-thread', substreamId: 'b-new' }); });
    expect(harness.bridge.completeBrowserImport).toHaveBeenLastCalledWith('w-thread', 'b-new');
  });

  it('chooses the first Channel for a sheet opened before the window learned its Channels', async () => {
    harness.state.context = { spaces: [{ id: 'space-a', name: 'Alpha' }] };
    let deliver!: (context: typeof harness.state.context) => void;
    harness.bridge.getBrowserImportContext.mockImplementationOnce(() => new Promise((resolve) => { deliver = resolve; }));
    render(<Tooltip.Provider><BrowserImportWindow /></Tooltip.Provider>);
    await waitFor(() => expect(harness.bridge.getBrowserImportContext).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const sheet = await screen.findByRole('dialog', { name: 'Import thread' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(within(sheet).getByRole('button', { name: 'Import' })).toBeDisabled();

    await act(async () => { deliver(harness.state.context); });

    expect(within(sheet).getByRole('combobox', { name: 'Channel' })).toHaveTextContent('Alpha');
    expect(within(sheet).getByRole('button', { name: 'Import' })).toBeEnabled();
  });

  it('copies the running import’s address for a bug report', async () => {
    harness.state.context = { spaces: [{ id: 'space-a', name: 'Alpha' }] };
    render(<Tooltip.Provider><BrowserImportWindow /></Tooltip.Provider>);
    await waitFor(() => expect(harness.bridge.getBrowserImportContext).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Import thread' })).getByRole('button', { name: 'Import' }));
    const progress = await screen.findByRole('dialog', { name: 'Importing conversation' });

    // Before the API answers there is no import to name.
    fireEvent.pointerDown(within(progress).getByRole('button', { name: 'More import actions' }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole('menuitem', { name: 'Copy import id' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });

    const { onStarted } = (harness.startSessionImportRun.mock.lastCall as unknown as [{ onStarted: (run: { workstreamId: string; substreamId: string }) => void }])[0];
    await act(async () => { onStarted({ workstreamId: '019fec70-fba0-7b0e-9f7a-3dd1ef56520f', substreamId: '00000000-0000-7000-8000-0000000000a9' }); });
    fireEvent.pointerDown(within(progress).getByRole('button', { name: 'More import actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy import id' }));
    await waitFor(() => expect(harness.bridge.copyText)
      .toHaveBeenCalledWith('https://rallywith.ai/app/global/1111117Hxt1fAWDjN7Te/i/1111117Hxt1fAWDjN7WQ/c/CduMrko5vpzwph2okTVLJ'));
    expect(within(progress).queryByText('The import id could not be copied.')).toBeNull();

    // A copy that does not reach the clipboard says so, rather than leaving a stale one to paste.
    harness.bridge.copyText.mockRejectedValueOnce(new Error('clipboard denied'));
    fireEvent.pointerDown(within(progress).getByRole('button', { name: 'More import actions' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Copy import id' }));
    expect(await screen.findByText('The import id could not be copied.')).toBeVisible();
  });
});
