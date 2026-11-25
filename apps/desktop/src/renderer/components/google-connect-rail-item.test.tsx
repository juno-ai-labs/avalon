import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CookieClientSession } from '@rally/contracts/client-session';
import { RallyApi } from '../lib/api';
import type * as Platform from '../lib/platform';
import { CollaborationSessionProvider, type ConnectorSetupCapability } from '../lib/collaboration-session';
import type { WorkstreamConnection } from '../lib/types';
import { GoogleConnectRailItem } from './google-connect-rail-item';
import { ROLLING_CYCLE_PERIOD_MS } from './rolling-cycle';

const calls = vi.hoisted(() => ({ startProviderConnection: vi.fn(), openExternal: vi.fn() }));
vi.mock('../lib/platform', async (original) => ({
  ...await original<typeof Platform>(),
  desktopBridge: () => ({ openExternal: calls.openExternal }),
}));

const session: CookieClientSession = { authentication: 'cookie', expiresAt: '2099-01-01T00:00:00.000Z', apiBaseUrl: 'https://api.example.com',
  user: { id: 'user-1', email: 'person@example.com', name: 'Person' }, workspace: { id: 'workspace-1', name: 'Team', region: 'global', role: 'member' } };
const PENDING_BASE = { attemptId: 'attempt-1', region: 'global' as const, scope: 'personal' as const, source: 'conversation' as const, workspaceId: 'workspace-1' };

function google(id: string, capabilities: string[], status: WorkstreamConnection['status'] = 'healthy'): WorkstreamConnection {
  return { id, modelPluginId: `plugin_${id}`, connectorType: 'google', displayName: `Google · ${id}@example.com`, scope: 'you', status, capabilities };
}
const MAIL = ['gmail.read', 'calendar.read'];
const DRIVE = ['drive.read', 'docs.read', 'sheets.read'];

function show(connections: WorkstreamConnection[], options: { catalog?: string[]; guest?: boolean; pending?: ConnectorSetupCapability['pendingConnectorOAuth'] } = {}) {
  const getConnections = vi.fn(async () => connections);
  const getAvailableConnectorTypes = vi.fn(async () => options.catalog ?? ['google']);
  const api = Object.assign(new RallyApi(session.apiBaseUrl, session), {
    getConnections, getAvailableConnectorTypes,
    getWorkspace: vi.fn(async () => ({ id: 'workspace-1', currentUser: { id: 'user-1', role: 'member' } })),
    startProviderConnection: calls.startProviderConnection,
  });
  const setup: ConnectorSetupCapability = { pendingConnectorOAuth: options.pending ?? null, setPendingConnectorOAuth: vi.fn(), resourceAuthorizationAttempts: {},
    setResourceAuthorizationAttempt: vi.fn(), openExternal: calls.openExternal };
  const shown = options.guest ? { ...session, workspace: { ...session.workspace!, accessClass: 'guest' as const } } : session;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><Tooltip.Provider>
    <CollaborationSessionProvider api={api} session={shown} connectorSetup={setup}><GoogleConnectRailItem /></CollaborationSessionProvider>
  </Tooltip.Provider></QueryClientProvider>);
  /** Resolves once both reads the tile waits on have answered, so absence means hidden rather than loading. */
  const loaded = async () => {
    await waitFor(() => expect(client.getQueryState(['connections'])?.status).toBe('success'));
    await waitFor(() => expect(client.getQueryState(['connector-catalog'])?.status).toBe('success'));
  };
  return { ...view, client, loaded, getConnections, getAvailableConnectorTypes };
}

beforeEach(() => {
  calls.startProviderConnection.mockResolvedValue({ attemptId: 'attempt-1', url: 'https://accounts.google.com/o/oauth2/v2/auth' });
  calls.openExternal.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

const shownName = (tile: HTMLElement): string | null | undefined => tile.querySelector('.navigation-rail-label .rolling-slot-item:last-child')?.textContent;

describe('the rail Google quick action', () => {
  it('offers Gmail while the person has no Gmail connection, and starts only the Mail and Calendar sign-in', async () => {
    show([google('drive-a', DRIVE)]);
    const tile = await screen.findByRole('button', { name: 'Connect Gmail and Calendar' });
    expect(within(tile).getByText('Gmail', { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(tile).toBeEnabled());
    fireEvent.click(tile);
    await waitFor(() => expect(calls.startProviderConnection).toHaveBeenCalledWith('google', 'you', expect.arrayContaining(['gmail.read', 'calendar.read'])));
    expect(calls.startProviderConnection.mock.calls[0]![2]).not.toContain('drive.read');
  });

  it('offers Drive once Gmail is connected, counting one that needs reconnecting, and starts only the Drive sign-in', async () => {
    show([google('mail-a', MAIL, 'reconnect_required')]);
    const tile = await screen.findByRole('button', { name: 'Connect Drive, Sheets and Docs' });
    expect(within(tile).getByText('Drive', { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(tile).toBeEnabled());
    fireEvent.click(tile);
    await waitFor(() => expect(calls.startProviderConnection).toHaveBeenCalledWith('google', 'you', expect.arrayContaining(['drive.read'])));
    expect(calls.startProviderConnection.mock.calls[0]![2].some((capability: string) => capability.startsWith('gmail.'))).toBe(false);
  });

  it('switches from Gmail to Drive in place when the Gmail connection lands', async () => {
    const view = show([]);
    expect(await screen.findByRole('button', { name: 'Connect Gmail and Calendar' })).toBeInTheDocument();
    await act(async () => { view.client.setQueryData(['connections'], [google('mail-a', MAIL)]); });
    expect(await screen.findByRole('button', { name: 'Connect Drive, Sheets and Docs' })).toBeInTheDocument();
  });

  it('is gone once both are connected', async () => {
    const view = show([google('mail-a', MAIL), google('drive-a', DRIVE)]);
    await view.loaded();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('respects a disconnect: a Drive connection the person disconnected does not bring the tile back', async () => {
    const view = show([google('mail-a', MAIL), google('drive-a', DRIVE, 'disabled')]);
    await view.loaded();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('is not offered to a guest', async () => {
    const view = show([], { guest: true });
    await act(async () => { await Promise.resolve(); });
    expect(view.getConnections).not.toHaveBeenCalled();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('is not offered where the region has no Google client', async () => {
    const view = show([], { catalog: ['slack'] });
    await view.loaded();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says why when the sign-in could not start, instead of only re-enabling', async () => {
    calls.startProviderConnection.mockRejectedValue(new Error('Rally could not reach Google. Check your connection and try again.'));
    show([]);
    const tile = await screen.findByRole('button', { name: 'Connect Gmail and Calendar' });
    await waitFor(() => expect(tile).toBeEnabled());
    fireEvent.click(tile);
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Rally could not reach Google. Check your connection and try again.');
  });

  it('is held while another sign-in is pending, since one is tracked at a time', async () => {
    const view = show([], { pending: { ...PENDING_BASE, connectionId: null, connectorId: 'slack', provider: 'slack' } });
    await view.loaded();
    expect(screen.getByRole('button', { name: 'Connect Gmail and Calendar' })).toBeDisabled();
  });

  it('keeps the Gmail tile while its sign-in is pending, even once Gmail is listed, so the attempt can be settled', async () => {
    show([google('mail-a', MAIL)], { pending: { ...PENDING_BASE, connectionId: null, connectorId: 'google-mail-calendar', provider: 'google' } });
    expect(await screen.findByRole('button', { name: 'Connect Gmail and Calendar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Drive, Sheets and Docs' })).not.toBeInTheDocument();
  });

  it('rolls its mark and its name together, Gmail then Calendar then Gmail', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    show([]);
    const tile = await screen.findByRole('button', { name: 'Connect Gmail and Calendar' });
    const mark = () => tile.querySelector('.navigation-rail-google-mark .rolling-slot-item:last-child title')?.textContent;
    expect([shownName(tile), mark()]).toEqual(['Gmail', 'Gmail']);
    await act(async () => { vi.advanceTimersByTime(ROLLING_CYCLE_PERIOD_MS); });
    expect([shownName(tile), mark()]).toEqual(['Calendar', 'Google Calendar']);
    await act(async () => { vi.advanceTimersByTime(ROLLING_CYCLE_PERIOD_MS); });
    expect(shownName(tile)).toBe('Gmail');
  });

  it('holds its mark while the window is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    show([]);
    const tile = await screen.findByRole('button', { name: 'Connect Gmail and Calendar' });
    await act(async () => { vi.advanceTimersByTime(3 * ROLLING_CYCLE_PERIOD_MS); });
    expect(shownName(tile)).toBe('Gmail');
    vi.restoreAllMocks();
  });

  it('stops on its first mark when reduced motion is turned on while it is rolling', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const listeners = new Set<() => void>();
    const query = { matches: false, media: '(prefers-reduced-motion: reduce)',
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
    vi.stubGlobal('matchMedia', () => query);
    show([]);
    const tile = await screen.findByRole('button', { name: 'Connect Gmail and Calendar' });
    await act(async () => { vi.advanceTimersByTime(ROLLING_CYCLE_PERIOD_MS); });
    expect(shownName(tile)).toBe('Calendar');
    query.matches = true;
    await act(async () => { for (const listener of listeners) listener(); });
    expect(shownName(tile)).toBe('Gmail');
    await act(async () => { vi.advanceTimersByTime(3 * ROLLING_CYCLE_PERIOD_MS); });
    expect(shownName(tile)).toBe('Gmail');
  });
});
