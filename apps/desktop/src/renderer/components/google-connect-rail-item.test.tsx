import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CookieClientSession } from '@rally/contracts/client-session';
import { RallyApi } from '../lib/api';
import type * as Platform from '../lib/platform';
import { CollaborationSessionProvider, type ConnectorSetupCapability } from '../lib/collaboration-session';
import type { WorkstreamConnection } from '../lib/types';
import { GoogleConnectRailItem } from './google-connect-rail-item';
import { ROLLING_CYCLE_HOLD_MS } from './rolling-cycle';

const calls = vi.hoisted(() => ({ startProviderConnection: vi.fn(), openExternal: vi.fn() }));
vi.mock('../lib/platform', async (original) => ({
  ...await original<typeof Platform>(),
  desktopBridge: () => ({ openExternal: calls.openExternal }),
}));

const session: CookieClientSession = { authentication: 'cookie', expiresAt: '2099-01-01T00:00:00.000Z', apiBaseUrl: 'https://api.example.com',
  user: { id: 'user-1', email: 'person@example.com', name: 'Person' }, workspace: { id: 'workspace-1', name: 'Team', region: 'global', role: 'member' } };

function google(id: string, capabilities: string[], status: WorkstreamConnection['status'] = 'healthy'): WorkstreamConnection {
  return { id, modelPluginId: `plugin_${id}`, connectorType: 'google', displayName: `Google · ${id}@example.com`, scope: 'you', status, capabilities };
}
const MAIL = ['gmail.read', 'calendar.read'];
const DRIVE = ['drive.read', 'docs.read', 'sheets.read'];

function show(connections: WorkstreamConnection[], options: { catalog?: string[]; guest?: boolean; pending?: ConnectorSetupCapability['pendingConnectorOAuth'] } = {}) {
  const api = Object.assign(new RallyApi(session.apiBaseUrl, session), {
    getConnections: vi.fn(async () => connections),
    getAvailableConnectorTypes: vi.fn(async () => options.catalog ?? ['google']),
    startProviderConnection: calls.startProviderConnection,
  });
  const setup: ConnectorSetupCapability = { pendingConnectorOAuth: options.pending ?? null, setPendingConnectorOAuth: vi.fn(), resourceAuthorizationAttempts: {},
    setResourceAuthorizationAttempt: vi.fn(), openExternal: calls.openExternal };
  const shown = options.guest ? { ...session, workspace: { ...session.workspace!, accessClass: 'guest' as const } } : session;
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <CollaborationSessionProvider api={api} session={shown} connectorSetup={setup}><GoogleConnectRailItem /></CollaborationSessionProvider>
  </QueryClientProvider>);
}

beforeEach(() => {
  calls.startProviderConnection.mockResolvedValue({ attemptId: 'attempt-1', url: 'https://accounts.google.com/o/oauth2/v2/auth' });
  calls.openExternal.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('the rail Google quick action', () => {
  it('offers Gmail while the person has no Gmail connection, and starts the Mail and Calendar sign-in', async () => {
    show([google('drive-a', DRIVE)]);
    const tile = await screen.findByRole('button', { name: 'Connect Gmail' });
    expect(tile).toHaveTextContent('Gmail');
    await waitFor(() => expect(tile).toBeEnabled());
    fireEvent.click(tile);
    await waitFor(() => expect(calls.startProviderConnection).toHaveBeenCalledWith('google', 'you', expect.arrayContaining(['gmail.read', 'calendar.read'])));
    expect(calls.startProviderConnection.mock.calls[0]![2]).not.toContain('drive.read');
  });

  it('says why when the sign-in could not start, instead of only re-enabling', async () => {
    calls.startProviderConnection.mockRejectedValue(new Error('Rally could not reach Google. Check your connection and try again.'));
    show([]);
    const tile = await screen.findByRole('button', { name: 'Connect Gmail' });
    await waitFor(() => expect(tile).toBeEnabled());
    fireEvent.click(tile);
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Rally could not reach Google. Check your connection and try again.');
  });

  it('offers Drive once Gmail is connected, counting a connection that needs reconnecting', async () => {
    show([google('mail-a', MAIL, 'reconnect_required')]);
    expect(await screen.findByRole('button', { name: 'Connect Google Drive' })).toHaveTextContent('Drive');
    expect(screen.queryByRole('button', { name: 'Connect Gmail' })).not.toBeInTheDocument();
  });

  it('is gone once both are connected, and for a disconnected one only counts again when connected', async () => {
    const view = show([google('mail-a', MAIL), google('drive-a', DRIVE)]);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    view.unmount();
    show([google('mail-a', MAIL), google('drive-a', DRIVE, 'disabled')]);
    expect(await screen.findByRole('button', { name: 'Connect Google Drive' })).toBeInTheDocument();
  });

  it('is not offered to a guest, or where the region has no Google client', async () => {
    show([], { guest: true });
    show([], { catalog: ['slack'] });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('is held while another sign-in is pending, since one is tracked at a time', async () => {
    show([], { pending: { attemptId: 'attempt-slack', connectionId: null, connectorId: 'slack', provider: 'slack', region: 'global',
      scope: 'personal', source: 'conversation', workspaceId: 'workspace-1' } });
    const tile = await screen.findByRole('button', { name: 'Connect Gmail' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(tile).toBeDisabled();
  });

  it('keeps the Gmail tile while its sign-in is pending, even once Gmail is listed, so the attempt can be settled', async () => {
    show([google('mail-a', MAIL)], { pending: { attemptId: 'attempt-1', connectionId: null, connectorId: 'google-mail-calendar', provider: 'google',
      region: 'global', scope: 'personal', source: 'conversation', workspaceId: 'workspace-1' } });
    expect(await screen.findByRole('button', { name: 'Connect Gmail' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect Google Drive' })).not.toBeInTheDocument();
  });

  it('stops on its first mark when reduced motion is turned on while it is rolling', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const listeners = new Set<() => void>();
    const query = { matches: false, media: '(prefers-reduced-motion: reduce)',
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener) };
    vi.stubGlobal('matchMedia', () => query);
    show([]);
    const tile = await screen.findByRole('button', { name: 'Connect Gmail' });
    const name = () => tile.querySelector('.navigation-rail-label .rolling-slot-item:last-child')?.textContent;
    await act(async () => { vi.advanceTimersByTime(ROLLING_CYCLE_HOLD_MS + 280); });
    expect(name()).toBe('Calendar');
    query.matches = true;
    await act(async () => { for (const listener of listeners) listener(); });
    expect(name()).toBe('Gmail');
    await act(async () => { vi.advanceTimersByTime(3 * (ROLLING_CYCLE_HOLD_MS + 280)); });
    expect(name()).toBe('Gmail');
    vi.unstubAllGlobals();
  });

  it('holds its mark while the window is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    show([]);
    const tile = await screen.findByRole('button', { name: 'Connect Gmail' });
    await act(async () => { vi.advanceTimersByTime(3 * (ROLLING_CYCLE_HOLD_MS + 280)); });
    expect(tile.querySelector('.navigation-rail-label .rolling-slot-item:last-child')?.textContent).toBe('Gmail');
    hidden.mockRestore();
  });

  it('rolls its mark and its name together, Gmail then Calendar', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    show([]);
    const tile = await screen.findByRole('button', { name: 'Connect Gmail' });
    const name = () => tile.querySelector('.navigation-rail-label .rolling-slot-item:last-child')?.textContent;
    const mark = () => tile.querySelector('.navigation-rail-google-mark .rolling-slot-item:last-child title')?.textContent;
    expect([name(), mark()]).toEqual(['Gmail', 'Gmail']);
    await act(async () => { vi.advanceTimersByTime(ROLLING_CYCLE_HOLD_MS + 280); });
    expect([name(), mark()]).toEqual(['Calendar', 'Google Calendar']);
    await act(async () => { vi.advanceTimersByTime(ROLLING_CYCLE_HOLD_MS + 280); });
    expect(name()).toBe('Gmail');
  });
});
