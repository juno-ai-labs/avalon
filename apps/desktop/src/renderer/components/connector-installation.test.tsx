import * as Tooltip from '@radix-ui/react-tooltip';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorInstallationSchema } from '@rally/contracts';
import { RallyApi } from '../lib/api';
import { AshbyWorkspaceSetup, ConnectorInstallationDetails } from './connector-installation';

afterEach(() => { cleanup(); onlineManager.setOnline(true); vi.restoreAllMocks(); });

const connectionId = '00000000-0000-4000-8000-000000000001';
function installation() {
  return ConnectorInstallationSchema.parse({ connectionId, workspaceId: '00000000-0000-4000-8000-000000000002',
    provider: 'ashby', attemptId: '00000000-0000-4000-8000-000000000003', generation: 1,
    desiredVersion: 1, appliedVersion: null, state: 'setting_up', selectedEvents: ['applicationSubmit'], registrations: [],
    createdAt: '2026-09-12T12:00:00.000Z', updatedAt: '2026-09-12T12:00:00.000Z', lastReceivedAt: null, error: null });
}
function show(element: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Tooltip.Provider>{element}</Tooltip.Provider>
  </QueryClientProvider>);
}

describe('workspace event controls', () => {
  it('reads installation status without repair and reserves repair for explicit Test', async () => {
    const api = new RallyApi('https://api.example.test', null);
    const read = vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: installation() });
    const change = vi.spyOn(api, 'changeConnectorInstallation');
    const test = vi.spyOn(api, 'testConnection').mockResolvedValue({ ok: true, message: 'Verified' });
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    await screen.findByText(/Status: setting up/u);
    expect(change).not.toHaveBeenCalled(); expect(test).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(change).not.toHaveBeenCalled(); expect(test).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await screen.findByText('Verified');
    expect(test).toHaveBeenCalledWith(connectionId);
    expect(change).not.toHaveBeenCalled();
  });

  it('disables provider controls offline and never queues a delayed Test', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: installation() });
    const test = vi.spyOn(api, 'testConnection');
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    await screen.findByText(/Status: setting up/u);
    act(() => onlineManager.setOnline(false));
    expect(screen.getByRole('button', { name: 'Test' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    act(() => onlineManager.setOnline(true));
    expect(test).not.toHaveBeenCalled();
  });

  it('offers no local cleanup retry after the administrator forgot the credential', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: { ...installation(), state: 'cleanup_pending', cleanupCredentialForgotten: true,
      error: 'Remove remaining registrations in the provider dashboard.' } });
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    await screen.findByText('Remove remaining registrations in the provider dashboard.');
    expect(screen.queryByRole('button', { name: 'Retry cleanup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test' })).toBeNull();
  });

  it('retries setup with the same attempt and selected events using a password-only key field', async () => {
    const api = new RallyApi('https://api.example.test', null);
    const create = vi.spyOn(api, 'createAshbyWorkspaceConnection').mockRejectedValue(new Error('Connection unavailable'));
    const attemptId = installation().attemptId;
    show(<AshbyWorkspaceSetup api={api} attemptId={attemptId} onSuccess={() => {}} onClose={() => {}} />);
    const input = document.querySelector('input[type="password"]');
    if (!input) throw new Error('The API key must use a password field');
    fireEvent.change(input, { target: { value: 'fixture-key' } });
    fireEvent.click(screen.getByLabelText('Application stage changed'));
    fireEvent.click(screen.getByRole('button', { name: 'Connect for workspace' }));
    await screen.findByText('Connection unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Connect for workspace' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls).toEqual([['fixture-key', ['applicationSubmit'], attemptId], ['fixture-key', ['applicationSubmit'], attemptId]]);
  });
});
