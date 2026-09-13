import * as Tooltip from '@radix-ui/react-tooltip';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorInstallationSchema, ConnectorRegistrationSchema } from '@rally/contracts';
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
function registration(key: string, state: string, providerId: string | null = null) {
  return ConnectorRegistrationSchema.parse({ key, state, providerId, events: [key],
    destination: 'https://api.example.test/ingest', enabled: null, action: 'create', stepId: crypto.randomUUID(),
    verifiedAt: null, error: null, rotation: 'stable', rotationGeneration: 0, activeSecretRef: null, pendingSecretRef: null });
}
function show(element: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Tooltip.Provider>{element}</Tooltip.Provider>
  </QueryClientProvider>);
}

describe('workspace event controls', () => {
  it.each(['current', 'action_required'] as const)('keeps %s technical recovery controls out of the main view', async (state) => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: { ...installation(), state,
      registrations: [registration('applicationSubmit', state === 'current' ? 'current' : 'unknown')] } });
    const test = vi.spyOn(api, 'testConnection');
    const change = vi.spyOn(api, 'changeConnectorInstallation');
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    await screen.findByText(state === 'current' ? 'Connected' : 'Needs attention');
    expect(screen.getByRole('button', { name: 'Test' })).toBeVisible();
    expect(screen.queryByLabelText('Existing provider webhook ID')).toBeNull();
    expect(screen.queryByText('Replace workspace API key')).toBeNull();
    expect(screen.queryByText(/Configuration/u)).toBeNull();
    expect(screen.queryByText(/Destination:/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Replace workspace API key')).toBeVisible();
    expect(test).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
  });

  it('reads installation status without repair and reserves repair for explicit Test', async () => {
    const api = new RallyApi('https://api.example.test', null);
    const read = vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: installation() });
    const change = vi.spyOn(api, 'changeConnectorInstallation');
    const test = vi.spyOn(api, 'testConnection').mockResolvedValue({ ok: true, message: 'Verified' });
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    await screen.findByText('Setting up');
    expect(change).not.toHaveBeenCalled(); expect(test).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    fireEvent.click(screen.getByText('Signing-key rotation guidance'));
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(change).not.toHaveBeenCalled(); expect(test).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await screen.findByText('Verified');
    expect(test).toHaveBeenCalledWith(connectionId);
    expect(change).not.toHaveBeenCalled();
  });

  it('adopts an enabled legacy connection only after explicit Test', async () => {
    const api = new RallyApi('https://api.example.test', null);
    const read = vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: null });
    const test = vi.spyOn(api, 'testConnection').mockImplementation(async () => {
      read.mockResolvedValue({ installation: { ...installation(), provider: 'granola', state: 'current', appliedVersion: 1 } });
      return { ok: true, message: 'Existing webhook verified' };
    });
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} connectionEnabled onClose={() => {}} />);
    await screen.findByText(/Test this connection/u);
    expect(test).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await screen.findByText('Connected');
    expect(test).toHaveBeenCalledWith(connectionId);
  });

  it('disables provider controls offline and never queues a delayed Test', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: installation() });
    const test = vi.spyOn(api, 'testConnection');
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    await screen.findByText('Setting up');
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
    await screen.findByText('Disconnected');
    expect(screen.getByRole('button', { name: 'Get help' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry cleanup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test' })).toBeNull();
  });

  it('retries automatic event setup with the same attempt using a password-only key field', async () => {
    const api = new RallyApi('https://api.example.test', null);
    const create = vi.spyOn(api, 'createAshbyWorkspaceConnection').mockRejectedValue(new Error('Connection unavailable'));
    vi.spyOn(api, 'getConnections').mockResolvedValue([]);
    const attemptId = installation().attemptId;
    show(<AshbyWorkspaceSetup api={api} attemptId={attemptId} onSuccess={() => {}} onClose={() => {}} onRecovered={() => {}} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    const input = document.querySelector('input[type="password"]');
    if (!input) throw new Error('The API key must use a password field');
    fireEvent.change(input, { target: { value: 'fixture-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect for workspace' }));
    await screen.findByText('Connection unavailable');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect for workspace' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Connect for workspace' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls).toEqual([['fixture-key', attemptId], ['fixture-key', attemptId]]);
  });

  it('recovers a reserved setup after a lost response without creating another installation', async () => {
    const api = new RallyApi('https://api.example.test', null);
    const create = vi.spyOn(api, 'createAshbyWorkspaceConnection').mockRejectedValue(new Error('Response lost'));
    vi.spyOn(api, 'getConnections').mockResolvedValue([{ id: connectionId, modelPluginId: 'plugin_ashby_fixture', connectorType: 'ashby', scope: 'workspace', displayName: 'Ashby workspace events', status: 'healthy', capabilities: ['ashby.workspace.events'] }]);
    const recovered = vi.fn();
    show(<AshbyWorkspaceSetup api={api} attemptId={installation().attemptId} onSuccess={() => {}} onClose={() => {}} onRecovered={recovered} />);
    fireEvent.change(screen.getByLabelText('Ashby workspace API key'), { target: { value: 'fixture-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect for workspace' }));
    await waitFor(() => expect(recovered).toHaveBeenCalledWith(connectionId));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('requires recovery lookup after an ambiguous failure even when the input changes', async () => {
    const api = new RallyApi('https://api.example.test', null);
    const create = vi.spyOn(api, 'createAshbyWorkspaceConnection').mockRejectedValue(new Error('Response lost'));
    const read = vi.spyOn(api, 'getConnections').mockRejectedValue(new Error('Offline'));
    const recovered = vi.fn();
    show(<AshbyWorkspaceSetup api={api} attemptId={installation().attemptId} onSuccess={() => {}} onClose={() => {}} onRecovered={recovered} />);
    fireEvent.change(screen.getByLabelText('Ashby workspace API key'), { target: { value: 'fixture-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect for workspace' }));
    await screen.findByText('Existing installations could not be checked. Check again before retrying setup.');
    fireEvent.change(screen.getByLabelText('Ashby workspace API key'), { target: { value: 'corrected-key' } });
    expect(screen.getByRole('button', { name: 'Connect for workspace' })).toBeDisabled();
    read.mockResolvedValue([{ id: connectionId, modelPluginId: 'plugin_ashby_fixture', connectorType: 'ashby', scope: 'workspace', displayName: 'Ashby workspace events', status: 'healthy', capabilities: ['ashby.workspace.events'] }]);
    fireEvent.click(screen.getByRole('button', { name: 'Find existing installation' }));
    await waitFor(() => expect(recovered).toHaveBeenCalledWith(connectionId));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('offers only unconfirmed registrations and clears reconciliation inputs on target change and success', async () => {
    const api = new RallyApi('https://api.example.test', null);
    const data = { ...installation(), registrations: [registration('applicationSubmit', 'unknown'), registration('candidateStageChange', 'action_required'),
      registration('dispatched', 'dispatched'), registration('pending', 'pending'), registration('failed', 'failed'), registration('known', 'unknown', 'provider-id')] };
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: data });
    const change = vi.spyOn(api, 'changeConnectorInstallation').mockResolvedValue({ installation: data });
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    const select = await screen.findByRole('combobox', { name: 'Registration' });
    expect([...select.querySelectorAll('option')].map((option) => option.value)).toEqual(['', 'applicationSubmit', 'candidateStageChange', 'dispatched']);
    fireEvent.change(select, { target: { value: 'applicationSubmit' } });
    fireEvent.change(screen.getByLabelText('Existing provider webhook ID'), { target: { value: 'first-id' } });
    fireEvent.change(select, { target: { value: 'candidateStageChange' } });
    expect(screen.getByLabelText('Existing provider webhook ID')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Existing provider webhook ID'), { target: { value: 'second-id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify existing webhook' }));
    await waitFor(() => expect(select).toHaveValue(''));
    expect(screen.getByLabelText('Existing provider webhook ID')).toHaveValue('');
    expect(change).toHaveBeenCalledWith(connectionId, { action: 'reconcile', key: 'candidateStageChange', providerId: 'second-id' });
  });

  it('uses readable Granola event names in registration headings and recovery choices', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: { ...installation(), provider: 'granola', registrations:
      [{ ...registration('notes', 'unknown'), events: ['note.access_granted', 'note.edited', 'note.generated', 'note.regenerated'] }] } });
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    fireEvent.click(screen.getByText('Subscription details'));
    const fullLabel = 'Note access granted, Note edited, Note generated, Note regenerated';
    expect(await screen.findByRole('heading', { name: fullLabel })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Granola note events' })).toHaveAttribute('title', fullLabel);
  });
});
