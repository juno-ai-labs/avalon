import { ErrorNoticeProvider } from '@rally/ui/components/error-notice';
import * as Tooltip from '@radix-ui/react-tooltip';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectorInstallationSchema, ConnectorRegistrationSchema } from '@rally/contracts';
import { RallyApi } from '../lib/api';
import { AshbyWorkspaceSetup, ConnectorInstallationDetails } from './connector-installation';

const copyText = vi.hoisted(() => vi.fn(async () => undefined));
const openExternal = vi.hoisted(() => vi.fn(async () => undefined));
const reportTelemetryProductIntent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ copyText, openExternal, reportTelemetryProductIntent }),
  desktopServicesAvailable: () => true,
}));

afterEach(() => { cleanup(); onlineManager.setOnline(true); vi.restoreAllMocks(); copyText.mockReset().mockResolvedValue(undefined); });

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
    <Tooltip.Provider><ErrorNoticeProvider>{element}</ErrorNoticeProvider></Tooltip.Provider>
  </QueryClientProvider>);
}

describe('organization event controls', () => {
  it('opens stored installation and subscription failures only on request', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: {
      ...installation(), error: 'Stored installation failure',
      registrations: [{ ...registration('applicationSubmit', 'unknown'), error: 'Stored subscription failure' }],
    } });
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    await screen.findByText('Setting up');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    screen.getByText('Subscription details', { selector: 'summary' }).parentElement?.setAttribute('open', '');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Installation details' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Stored installation failure');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    fireEvent.click(screen.getByRole('button', { name: 'Subscription details' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Stored subscription failure');
  });

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
    expect(screen.queryByText('Replace organization API key')).toBeNull();
    expect(screen.queryByText(/Configuration/u)).toBeNull();
    expect(screen.queryByText(/Destination:/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Replace organization API key')).toBeVisible();
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
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(change).not.toHaveBeenCalled(); expect(test).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    await screen.findByText('Verified');
    expect(test).toHaveBeenCalledWith(connectionId);
    expect(change).not.toHaveBeenCalled();
  });

  it('shows the Test verdict as a pass or a failure rather than one more sentence', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: { ...installation(), state: 'current',
      registrations: [registration('applicationSubmit', 'current')] } });
    const test = vi.spyOn(api, 'testConnection')
      .mockResolvedValueOnce({ ok: false, message: 'Invalid API key format. Webhook repair needs attention; inspect installation details' })
      .mockResolvedValueOnce({ ok: true, message: 'Granola authorization is healthy. Approved webhook configuration is verified' });
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    await screen.findByText('Connected');
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    const failed = await screen.findByRole('alertdialog');
    expect(failed).toHaveTextContent('Connection test failed');
    expect(failed).toHaveTextContent('Invalid API key format');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    const passed = (await screen.findByText('Connection test passed')).closest('.connection-test-outcome');
    expect(passed).toHaveClass('is-passed');
    expect(passed).toHaveTextContent('Approved webhook configuration is verified');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(test).toHaveBeenCalledTimes(2);
  });

  it('says the test could not run when the request fails, rather than that the connection failed it', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: { ...installation(), state: 'current',
      registrations: [registration('applicationSubmit', 'current')] } });
    vi.spyOn(api, 'testConnection').mockRejectedValueOnce(new Error('The regional service could not be reached'));
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    await screen.findByText('Connected');
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    const outcome = await screen.findByRole('alertdialog');
    expect(outcome).toHaveTextContent('Couldn’t run the connection test');
    expect(outcome).toHaveTextContent('could not be reached');
    expect(screen.queryByText('Connection test failed')).toBeNull();
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
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('Connect to the internet to manage this connection. Saved status may be out of date.')).toBeVisible();
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
    fireEvent.click(screen.getByRole('button', { name: 'Connect for organization' }));
    await screen.findByText('Connection unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect for organization' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Connect for organization' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls).toEqual([['fixture-key', attemptId], ['fixture-key', attemptId]]);
  });

  it('recovers a reserved setup after a lost response without creating another installation', async () => {
    const api = new RallyApi('https://api.example.test', null);
    const create = vi.spyOn(api, 'createAshbyWorkspaceConnection').mockRejectedValue(new Error('Response lost'));
    vi.spyOn(api, 'getConnections').mockResolvedValue([{ id: connectionId, modelPluginId: 'plugin_ashby_fixture', connectorType: 'ashby', scope: 'workspace', displayName: 'Ashby organization events', status: 'healthy', capabilities: ['ashby.workspace.events'] }]);
    const recovered = vi.fn();
    show(<AshbyWorkspaceSetup api={api} attemptId={installation().attemptId} onSuccess={() => {}} onClose={() => {}} onRecovered={recovered} />);
    fireEvent.change(screen.getByLabelText('Ashby organization API key'), { target: { value: 'fixture-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect for organization' }));
    await waitFor(() => expect(recovered).toHaveBeenCalledWith(connectionId));
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('requires recovery lookup after an ambiguous failure even when the input changes', async () => {
    const api = new RallyApi('https://api.example.test', null);
    const create = vi.spyOn(api, 'createAshbyWorkspaceConnection').mockRejectedValue(new Error('Response lost'));
    const read = vi.spyOn(api, 'getConnections').mockRejectedValue(new Error('Offline'));
    const recovered = vi.fn();
    show(<AshbyWorkspaceSetup api={api} attemptId={installation().attemptId} onSuccess={() => {}} onClose={() => {}} onRecovered={recovered} />);
    fireEvent.change(screen.getByLabelText('Ashby organization API key'), { target: { value: 'fixture-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect for organization' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Response lost');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await screen.findByText('Existing installations could not be checked. Check again before retrying setup.');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    fireEvent.change(screen.getByLabelText('Ashby organization API key'), { target: { value: 'corrected-key' } });
    expect(screen.getByRole('button', { name: 'Connect for organization' })).toBeDisabled();
    read.mockResolvedValue([{ id: connectionId, modelPluginId: 'plugin_ashby_fixture', connectorType: 'ashby', scope: 'workspace', displayName: 'Ashby organization events', status: 'healthy', capabilities: ['ashby.workspace.events'] }]);
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
      [{ ...registration('notes', 'unknown'), events: ['note.access_granted', 'note.edited', 'note.generated'] }] } });
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    fireEvent.click(screen.getByText('Subscription details'));
    const fullLabel = 'Note access granted, Note edited, Note generated';
    expect(await screen.findByRole('heading', { name: fullLabel })).toBeVisible();
    expect(screen.getByRole('option', { name: 'Granola note events' })).toHaveAttribute('title', fullLabel);
  });

  // Replacing a live workspace key is the path where getting this wrong is
  // most expensive — a workspace whose key cannot be rotated from the UI — and
  // it is the one input this change tightened: it used to accept anything
  // non-empty.
  it('refuses a replacement key that cannot be the provider\u2019s, and says why', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: { ...installation(), provider: 'granola',
      state: 'current', selectedEvents: ['note.generated'], registrations: [registration('note.generated', 'current', 'whe_1')] } });
    const replace = vi.spyOn(api, 'replaceInstallationApiKey').mockResolvedValue(undefined as never);
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    fireEvent.click(screen.getByText('Replace organization API key'));
    const field = screen.getByLabelText('New API key');

    fireEvent.paste(field);
    fireEvent.change(field, { target: { value: 'sk-live-wrong-provider-key' } });
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Granola keys start with grn_');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('button', { name: 'Replace API key' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Replace API key' }));
    expect(replace).not.toHaveBeenCalled();

    const key = `grn_${'b'.repeat(24)}`;
    fireEvent.change(field, { target: { value: key } });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Replace API key' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(connectionId, key));
  });

  // `format: null` is what keeps a provider that documents no key shape
  // working exactly as it did: any non-empty paste is accepted, with nothing
  // guessed about it.
  it('accepts an opaque replacement key for a provider that documents no format', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: { ...installation(),
      state: 'current', registrations: [registration('applicationSubmit', 'current', 'whe_2')] } });
    const replace = vi.spyOn(api, 'replaceInstallationApiKey').mockResolvedValue(undefined as never);
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    fireEvent.click(screen.getByText('Replace organization API key'));
    const field = screen.getByLabelText('New API key');
    fireEvent.paste(field);
    fireEvent.change(field, { target: { value: 'opaque-ashby-key' } });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Replace API key' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(connectionId, 'opaque-ashby-key'));
  });

  // The server refuses a replacement credential for a scope the connector no
  // longer connects, before it is validated or stored, so offering the field
  // would be offering a paste that comes back 422. Fireflies is the connector
  // that is in that state: its workspace installations survive, its key cannot
  // be replaced, and it is deliberately absent from the API-key catalog.
  it('offers no key replacement for an installation whose provider takes no key', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: { ...installation(), provider: 'fireflies',
      state: 'current', selectedEvents: ['meeting.transcribed'], registrations: [registration('meeting.transcribed', 'current', 'whe_2')] } });
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    expect(screen.getByRole('button', { name: 'Refresh status' })).toBeVisible();
    expect(screen.queryByText('Replace organization API key')).toBeNull();
  });

  // Typing a key is not pasting a wrong one: the verdict waits for the field
  // to settle, so the message cannot sit on screen saying something untrue of
  // a half-typed key.
  it('holds the mismatch back until the key is pasted or the field is left', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: { ...installation(), provider: 'granola',
      state: 'current', selectedEvents: ['note.generated'], registrations: [registration('note.generated', 'current', 'whe_1')] } });
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Advanced' }));
    fireEvent.click(screen.getByText('Replace organization API key'));
    const field = screen.getByLabelText('New API key');
    for (const typed of ['g', 'gr', 'grn']) fireEvent.change(field, { target: { value: typed } });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    fireEvent.blur(field);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Granola keys start with grn_');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
  });
});

describe('organization installation cleanup', () => {
  it('offers no cleanup retry where no registration has a provider identity to remove', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: {
      ...installation(), provider: 'granola', state: 'cleanup_pending',
      registrations: [registration('note.access_granted+note.edited+note.generated', 'action_required')],
    } });
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    await screen.findByText(/Rally can't remove the webhook from your provider for you/u);
    expect(screen.queryByRole('button', { name: 'Retry cleanup' })).toBeNull();
  });

  it('offers no cleanup retry for a provider identity inspection never verified', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: {
      ...installation(), state: 'cleanup_pending',
      registrations: [{ ...registration('applicationSubmit', 'action_required', 'webhook-1'), providerIdVerified: false }],
    } });
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    await screen.findByText('Disconnected');
    expect(screen.queryByRole('button', { name: 'Retry cleanup' })).toBeNull();
  });

  it('still offers cleanup retry where a recorded provider identity exists', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: {
      ...installation(), state: 'cleanup_pending',
      registrations: [registration('applicationSubmit', 'pending', 'webhook-1')],
    } });
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Retry cleanup' })).toBeVisible();
    expect(screen.queryByText(/Rally can't remove the webhook from your provider for you/u)).toBeNull();
  });
});
