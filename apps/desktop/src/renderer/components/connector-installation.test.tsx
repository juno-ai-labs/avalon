import * as Tooltip from '@radix-ui/react-tooltip';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionSchema, ConnectorInstallationSchema, ConnectorRegistrationSchema } from '@rally/contracts';
import { RallyApi } from '../lib/api';
import { AshbyWorkspaceSetup, ConnectorInstallationDetails, FirefliesWorkspaceSetup } from './connector-installation';

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
const session = {
  accessToken: 'token', expiresAt: '2026-12-31T00:00:00.000Z', apiBaseUrl: 'https://api.example.test',
  user: { id: '00000000-0000-4000-8000-00000000000a', email: 'bob@acme.test', name: 'Bob' },
  workspace: { id: '00000000-0000-4000-8000-000000000002', name: 'Acme', region: 'global' as const, role: 'admin' as const },
};
function connectionFixture(connectorType: 'fireflies') {
  return ConnectionSchema.parse({ id: connectionId, modelPluginId: `plugin_${connectorType}_one`,
    workspaceId: '00000000-0000-4000-8000-000000000002', connectorType, scope: 'workspace',
    ownerUserId: null, ownerName: null, displayName: 'Fireflies · bob@acme.test',
    grantedCapabilities: [`${connectorType}.workspace.read`], status: 'healthy',
    lastSyncAt: null, createdAt: '2026-09-12T12:00:00.000Z' });
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

describe('Fireflies workspace setup', () => {
  const manualRegistration = {
    destination: 'https://api.example.test/ingest/fireflies/00000000-0000-4000-8000-000000000001',
    signingSecret: 'ssssssssssssssssssssssssssssssss',
  };
  /**
   * The real client, against a stubbed transport.
   *
   * Spying on `createFirefliesWorkspaceConnection` skips `RallyApi.request`,
   * which is where the response is parsed with the contract — so the response
   * shape the component depends on went unchecked by every test that mocked the
   * method. This drives the parse, which means the fixture below has to be a
   * response the server could actually send.
   */
  function apiReturning(body: unknown, status = 201) {
    const api = new RallyApi('https://api.example.test', session);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );
    return api;
  }
  const setupResponse = () => ({
    installation: { ...installation(), provider: 'fireflies', selectedEvents: ['meeting.transcribed', 'meeting.summarized'] },
    connection: connectionFixture('fireflies'),
    manualRegistration,
  });

  it('asks for one key with no event or consent boxes, then hands over the steps once', async () => {
    const api = apiReturning(setupResponse());
    const closed = vi.fn();
    show(<FirefliesWorkspaceSetup api={api} attemptId="00000000-0000-4000-8000-0000000000aa"
      onSuccess={() => {}} onClose={closed} onRecovered={() => {}} />);

    // The event set is the connector's, and consent is copy the admin reads.
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByText(/Every member of this workspace will be able to read these meetings/u)).toBeVisible();
    expect(screen.getByText(/Rally cannot tell which meetings this key covers/u)).toBeVisible();

    fireEvent.change(screen.getByLabelText(/Fireflies API key/u), { target: { value: 'a-workspace-key' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });

    // The one moment the secret is on screen, and the steps that need it.
    await screen.findByText('Finish in Fireflies');
    expect(screen.getByLabelText('Fireflies endpoint URL')).toHaveValue(manualRegistration.destination);
    expect(screen.getByLabelText('Fireflies signing secret')).toHaveValue(manualRegistration.signingSecret);
    expect(screen.getByText(/Rally will not show it again/u)).toBeVisible();
    expect(screen.getByText(/Fireflies holds one per account/u)).toBeVisible();
    // Fireflies' own labels, because that is what the administrator is reading
    // off the form — and the one field its form calls optional that Rally will
    // not work without.
    expect(screen.getByText('Configure')).toBeVisible();
    expect(screen.getByText('Webhook Configuration')).toBeVisible();
    expect(screen.getByText('Event Subscriptions')).toBeVisible();
    expect(screen.getByText('Meeting Transcribed')).toBeVisible();
    expect(screen.getByText('Meeting Summarized')).toBeVisible();
    expect(screen.getByText('Meeting Bot Joined')).toBeVisible();
    // The step that confirms the setup without waiting for a meeting. It is the
    // form's fifth action, so the list that mirrors the form has to carry it.
    expect(screen.getByText('Send test event')).toBeVisible();
    expect(screen.getByText(/labels the signing secret optional/u)).toBeVisible();
    expect(screen.getByText(/the connection changes to/u)).toHaveTextContent('changes to Connected as soon as the test event arrives');
    // Closing is the administrator's, not the setup's: the secret must not be
    // taken off screen by the mutation that produced it.
    expect(closed).not.toHaveBeenCalled();
  });

  it('refuses to close while the key is in flight, so the one-time secret cannot be lost', async () => {
    let release: ((value: Response) => void) | null = null;
    const api = new RallyApi('https://api.example.test', session);
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => { release = resolve; }));
    const closed = vi.fn();
    show(<FirefliesWorkspaceSetup api={api} attemptId="00000000-0000-4000-8000-0000000000ac"
      onSuccess={() => {}} onClose={closed} onRecovered={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Fireflies API key/u), { target: { value: 'a-workspace-key' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });

    // Cancel and Escape while the request is outstanding: the mutation keeps
    // running either way, so letting go here would create the connection and
    // throw away the secret the next stage exists to reveal.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled());
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape' });
    expect(closed).not.toHaveBeenCalled();

    await act(async () => {
      release?.(new Response(JSON.stringify(setupResponse()), { status: 201, headers: { 'content-type': 'application/json' } }));
    });
    await screen.findByText('Finish in Fireflies');
    expect(closed).not.toHaveBeenCalled();
  });

  it('will not let Escape take the signing secret off screen', async () => {
    const api = apiReturning(setupResponse());
    const closed = vi.fn();
    show(<FirefliesWorkspaceSetup api={api} attemptId="00000000-0000-4000-8000-0000000000ad"
      onSuccess={() => {}} onClose={closed} onRecovered={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Fireflies API key/u), { target: { value: 'a-workspace-key' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    await screen.findByText('Finish in Fireflies');

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape' });
    expect(closed).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Fireflies signing secret')).toHaveValue(manualRegistration.signingSecret);
    // Done is the way out, and it is deliberately the only one.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(closed).toHaveBeenCalled();
  });

  it('hands the endpoint and the secret out through icon copy controls beside their fields', async () => {
    const api = apiReturning(setupResponse());
    show(<FirefliesWorkspaceSetup api={api} attemptId="00000000-0000-4000-8000-0000000000af"
      onSuccess={() => {}} onClose={() => {}} onRecovered={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Fireflies API key/u), { target: { value: 'a-workspace-key' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    await screen.findByText('Finish in Fireflies');

    // An icon, named by its tooltip, rather than a sentence under the field.
    const copyEndpoint = screen.getByRole('button', { name: 'Copy endpoint' });
    expect(copyEndpoint).toHaveClass('icon-button');
    expect(copyEndpoint).toHaveTextContent('');
    fireEvent.click(copyEndpoint);
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(manualRegistration.destination));
    fireEvent.click(screen.getByRole('button', { name: 'Copy signing secret' }));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(manualRegistration.signingSecret));
  });

  it('says so when copying the secret fails, rather than claiming it worked', async () => {
    const api = apiReturning(setupResponse());
    copyText.mockRejectedValueOnce(new Error('clipboard unavailable'));
    show(<FirefliesWorkspaceSetup api={api} attemptId="00000000-0000-4000-8000-0000000000ae"
      onSuccess={() => {}} onClose={() => {}} onRecovered={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Fireflies API key/u), { target: { value: 'a-workspace-key' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    await screen.findByText('Finish in Fireflies');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy signing secret' })); });
    // The control itself carries the failure, and stays the way to try again.
    const failed = await screen.findByRole('button', { name: 'Copy failed — click to retry' });
    expect(failed).toBeEnabled();
    expect(screen.getByText('Copy failed. Try again.')).toBeInTheDocument();
    await act(async () => { fireEvent.click(failed); });
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Fireflies signing secret')).toHaveValue(manualRegistration.signingSecret);
  });

  it('keeps a rejected key in the form and stores nothing', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'createFirefliesWorkspaceConnection')
      .mockRejectedValue(new Error('Fireflies rejected this key. Check that you copied the whole key from the provider, then try again.'));
    vi.spyOn(api, 'getConnections').mockResolvedValue([]);
    const closed = vi.fn();
    show(<FirefliesWorkspaceSetup api={api} attemptId="00000000-0000-4000-8000-0000000000ab"
      onSuccess={() => {}} onClose={closed} onRecovered={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Fireflies API key/u), { target: { value: 'wrong-key' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
    await screen.findByText(/Fireflies rejected this key/u);
    expect(screen.getByLabelText(/Fireflies API key/u)).toHaveValue('wrong-key');
    expect(screen.queryByText('Finish in Fireflies')).toBeNull();
    expect(closed).not.toHaveBeenCalled();
  });

  it('offers no cleanup retry where no registration has a provider identity to remove', async () => {
    const api = new RallyApi('https://api.example.test', null);
    vi.spyOn(api, 'connectorInstallation').mockResolvedValue({ installation: {
      ...installation(), provider: 'fireflies', state: 'cleanup_pending',
      registrations: [registration('meeting.transcribed+meeting.summarized', 'action_required')],
    } });
    show(<ConnectorInstallationDetails api={api} connectionId={connectionId} onClose={() => {}} />);
    await screen.findByText(/Rally can't remove the webhook from your provider for you/u);
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
