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

function show(connections: WorkstreamConnection[], options: { catalog?: string[]; guest?: boolean } = {}) {
  const api = Object.assign(new RallyApi(session.apiBaseUrl, session), {
    getConnections: vi.fn(async () => connections),
    getAvailableConnectorTypes: vi.fn(async () => options.catalog ?? ['google']),
    startProviderConnection: calls.startProviderConnection,
  });
  const setup: ConnectorSetupCapability = { pendingConnectorOAuth: null, setPendingConnectorOAuth: vi.fn(), resourceAuthorizationAttempts: {},
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
