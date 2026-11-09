import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ConnectedMcpApp } from '@rally/contracts/mcp-oauth';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';
import { connectedAppDestination, ConnectedAppsSetting, type ConnectedAppsApi } from './connected-apps-setting';

const ACME = '01a11778-2de8-72ed-9c2e-51284f2010c7';

function app(id: string, extra: Partial<ConnectedMcpApp> = {}): ConnectedMcpApp {
  return {
    id, clientName: 'Claude', redirectOrigins: ['https://claude.ai'], loopback: false,
    workspaceId: ACME as ConnectedMcpApp['workspaceId'], workspaceName: 'Acme',
    connectedAt: '2026-11-01T12:00:00.000Z', lastActiveAt: '2026-11-01T12:00:00.000Z',
    ...extra,
  };
}

function fakeApi(apps: ConnectedMcpApp[], disconnect: (id: string) => Promise<void> = async () => undefined) {
  return {
    getConnectedApps: vi.fn(async () => ({ apps })),
    disconnectConnectedApp: vi.fn(disconnect),
  } satisfies ConnectedAppsApi;
}

function show(api: ConnectedAppsApi) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><ConnectedAppsSetting api={api} workspaceId={ACME} /></QueryClientProvider>);
}

afterEach(() => { cleanup(); });

describe('where a connected app returns to', () => {
  it('names hosted origins by host, and a loopback redirect as the computer it was connected from', () => {
    expect(connectedAppDestination({ redirectOrigins: ['https://claude.ai', 'https://claude.com'], loopback: false }))
      .toBe('Returns to claude.ai, claude.com');
    expect(connectedAppDestination({ redirectOrigins: [], loopback: true })).toBe('Returns to the computer it was connected from');
  });
});

describe('ConnectedAppsSetting', () => {
  it('says nothing is connected when the person has connected no app', async () => {
    show(fakeApi([]));
    expect(await screen.findByText('No apps are connected. When you connect Claude, ChatGPT or another app to Rally, it shows here.')).toBeInTheDocument();
  });

  it('shows each app by the name it gave itself, where it returns to, its Organization and when it connected', async () => {
    show(fakeApi([
      app('one'),
      app('two', { clientName: 'Claude Code', redirectOrigins: [], loopback: true, workspaceName: 'Globex',
        lastActiveAt: new Date(Date.now() - 3 * 60 * 60 * 1_000).toISOString() }),
    ]));
    const list = await screen.findByRole('region', { name: 'Connected apps' });
    await within(list).findByText('Claude Code');
    const rows = list.querySelectorAll('.connected-app-row');
    expect([...rows].map((row) => row.querySelector('strong')?.textContent)).toEqual([
      'Claudethe name the app gave itself', 'Claude Codethe name the app gave itself',
    ]);
    expect(rows[0]).toHaveTextContent('Returns to claude.ai');
    expect(rows[0]).toHaveTextContent(`Acme · Connected ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date('2026-11-01T12:00:00.000Z'))}`);
    expect(rows[0]).not.toHaveTextContent('Last used');
    expect(rows[1]).toHaveTextContent('Returns to the computer it was connected from');
    expect(rows[1]).toHaveTextContent('Last used 3 hours ago');
  });

  it('removes a row once its app is disconnected, and treats one already gone as disconnected', async () => {
    const api = fakeApi([app('one'), app('two', { clientName: 'ChatGPT', redirectOrigins: ['https://chatgpt.com'] })], async (id) => {
      if (id === 'two') throw new ApiError('This app is not connected to your account', 404, 'connected_app_not_found');
    });
    show(api);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Claude from Acme' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Disconnect Claude from Acme' })).toBeNull());
    expect(api.disconnectConnectedApp).toHaveBeenCalledWith('one');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect ChatGPT from Acme' }));
    expect(await screen.findByText('No apps are connected. When you connect Claude, ChatGPT or another app to Rally, it shows here.')).toBeInTheDocument();
  });

  it('keeps the row and says why when a disconnect is refused', async () => {
    show(fakeApi([app('one')], async () => { throw new ApiError('Rally is unavailable', 503, 'unavailable'); }));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Claude from Acme' }));
    // The refusal is an acknowledged error popup over the page; the row is still under it.
    expect(within(await screen.findByRole('alertdialog')).getByText('Rally is unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect Claude from Acme', hidden: true })).toBeEnabled();
  });
});
