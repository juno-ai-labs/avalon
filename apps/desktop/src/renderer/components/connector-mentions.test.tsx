import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CONNECTOR_CONNECTION_CARD_WIRE_NAME, ConnectorResourceAuthorizationRequestSchema } from '@rally/contracts';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { DesktopUpdateStatus } from '../../common/desktop';
import {
  ConnectorConnectionCard,
  ConnectorConnectionUpdateCard,
  ConnectorResourceAuthorizationCard,
  ConnectorConnectionsProvider,
  ConnectorEmbedCard,
  ConnectorMentionChip,
  connectorConnectionCardInput,
  connectorResourceAuthorizationRequest,
} from './connector-mentions';

const mocks = vi.hoisted(() => ({
  setupEnabled: true,
  oauthWaterline: 0,
  desktop: true,
  getUpdateStatus: vi.fn(),
  checkForUpdates: vi.fn(),
  installDownloadedUpdate: vi.fn(),
  reload: vi.fn(),
  updateListeners: new Set<(status: DesktopUpdateStatus) => void>(),
  getAvailableConnectorTypes: vi.fn(),
  getConnectorOAuthAttempt: vi.fn(),
  openExternal: vi.fn(),
  pendingConnectorOAuth: null as null | Record<string, unknown>,
  resourceAuthorizationAttempts: {} as Record<string, Record<string, unknown>>,
  setResourceAuthorizationAttempt: vi.fn(),
  reconnectConnection: vi.fn(),
  // `workspaceRole` is what the card actually gates on: the role served by
  // `GET /workspace`, not the one stamped on the desktop session, because a
  // role changes while somebody is signed in and the session's copy does not
  // move until its token rotates. The session still carries one so the
  // placeholder path is exercised.
  session: {
    authentication: undefined as undefined | 'cookie',
    user: { id: 'user-one', name: 'Ada', email: 'ada@example.com', timezone: 'America/Los_Angeles' },
    workspace: { id: 'workspace-one', name: 'Rally', region: 'global', timezone: 'America/Los_Angeles', role: 'member' as 'owner' | 'admin' | 'member' },
  },
  workspaceRole: 'owner' as 'owner' | 'admin' | 'member',
  setPendingConnectorOAuth: vi.fn(),
  startProviderConnection: vi.fn(),
  startConnectorResourceAuthorization: vi.fn(),
}));

vi.mock('../lib/collaboration-session', () => {
  const api = {
    getAvailableConnectorTypes: mocks.getAvailableConnectorTypes,
    getConnectorOAuthAttempt: mocks.getConnectorOAuthAttempt,
    getWorkspace: async () => ({
      id: 'workspace-one',
      name: 'Rally',
      region: 'global',
      timezone: 'America/Los_Angeles',
      currentUser: {
        id: 'user-one',
        name: 'Ada',
        email: 'ada@example.com',
        timezone: 'America/Los_Angeles',
        role: mocks.workspaceRole,
      },
    }),
    reconnectConnection: mocks.reconnectConnection,
    startProviderConnection: mocks.startProviderConnection,
    startConnectorResourceAuthorization: mocks.startConnectorResourceAuthorization,
  };
  return { useOptionalCollaborationSession: () => ({
    api,
    session: mocks.session,
    connectorSetup: mocks.setupEnabled ? { pendingConnectorOAuth: mocks.pendingConnectorOAuth,
      setPendingConnectorOAuth: mocks.setPendingConnectorOAuth,
      resourceAuthorizationAttempts: mocks.resourceAuthorizationAttempts,
      setResourceAuthorizationAttempt: mocks.setResourceAuthorizationAttempt,
      openExternal: mocks.openExternal } : null,
  }),
  };
});
vi.mock('../lib/workspace-socket', () => ({
  useOptionalWorkspaceSocket: () => ({ state: 'connected', topicWaterlines: { connector_oauth_attempts: mocks.oauthWaterline } }),
}));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ openExternal: mocks.openExternal, getUpdateStatus: mocks.getUpdateStatus,
    checkForUpdates: mocks.checkForUpdates, installDownloadedUpdate: mocks.installDownloadedUpdate,
    onUpdateStatusChanged: (listener: (status: DesktopUpdateStatus) => void) => {
      mocks.updateListeners.add(listener);
      return () => mocks.updateListeners.delete(listener);
    },
  }),
  desktopServicesAvailable: () => mocks.desktop,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.oauthWaterline = 0;
  mocks.updateListeners.clear();
  mocks.desktop = false;
  vi.stubGlobal('location', { reload: mocks.reload });
  mocks.getUpdateStatus.mockResolvedValue({ kind: 'idle' });
  mocks.checkForUpdates.mockResolvedValue(undefined);
  mocks.installDownloadedUpdate.mockResolvedValue(undefined);
  mocks.pendingConnectorOAuth = null;
  mocks.resourceAuthorizationAttempts = {};
  mocks.setupEnabled = true;
  mocks.session.authentication = undefined;
  mocks.workspaceRole = 'owner';
  mocks.getAvailableConnectorTypes.mockResolvedValue(['google', 'github', 'granola', 'linear', 'notion', 'slack']);
  mocks.getConnectorOAuthAttempt.mockResolvedValue({ status: 'pending' });
  mocks.startProviderConnection.mockResolvedValue({
    attemptId: 'attempt-one',
    url: 'https://slack.com/oauth/test',
  });
  mocks.startConnectorResourceAuthorization.mockResolvedValue({
    attemptId: 'a'.repeat(43),
    status: 'pending',
    url: 'https://accounts.google.com/o/oauth2/v2/auth',
  });
  mocks.openExternal.mockResolvedValue(undefined);
});

describe('connector connection resolution', () => {
  it('omits the update card for guests and hosts without connector setup', () => {
    mocks.setupEnabled = false;
    const { container } = render(<ConnectorConnectionUpdateCard />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.getUpdateStatus).not.toHaveBeenCalled();
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
  });

  it.each([
    ['checking', 'Checking…'],
    ['downloading', 'Downloading…'],
  ] as const)('shows %s progress and switches to restart when ready', async (kind, label) => {
    mocks.desktop = true;
    mocks.getUpdateStatus.mockResolvedValue({ kind });
    render(<QueryClientProvider client={new QueryClient()}><ConnectorConnectionUpdateCard /></QueryClientProvider>);
    expect(await screen.findByRole('button', { name: label })).toBeDisabled();
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    mocks.getUpdateStatus.mockResolvedValue({ kind: 'downloaded', version: '2.0.0' });
    act(() => {
      for (const listener of mocks.updateListeners) listener({ kind: 'downloaded', version: '2.0.0' });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    await waitFor(() => expect(mocks.installDownloadedUpdate).toHaveBeenCalledOnce());
  });

  it('checks for a desktop update when none has been downloaded', async () => {
    mocks.desktop = true;
    render(<QueryClientProvider client={new QueryClient()}><ConnectorConnectionUpdateCard /></QueryClientProvider>);
    expect(screen.getByText('Connector not recognized')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Update Rally' }));
    await waitFor(() => expect(mocks.checkForUpdates).toHaveBeenCalledOnce());
    expect(mocks.installDownloadedUpdate).not.toHaveBeenCalled();
    expect(mocks.startProviderConnection).not.toHaveBeenCalled();
  });

  it('installs an already-downloaded desktop update', async () => {
    mocks.desktop = true;
    mocks.getUpdateStatus.mockResolvedValue({ kind: 'downloaded', version: '2.0.0' });
    render(<QueryClientProvider client={new QueryClient()}><ConnectorConnectionUpdateCard /></QueryClientProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart to update' }));
    await waitFor(() => expect(mocks.installDownloadedUpdate).toHaveBeenCalledOnce());
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.startProviderConnection).not.toHaveBeenCalled();
  });

  it('offers a browser reload without trying to install a desktop update', async () => {
    render(<QueryClientProvider client={new QueryClient()}><ConnectorConnectionUpdateCard /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Reload Rally' }));
    await waitFor(() => expect(mocks.reload).toHaveBeenCalledOnce());
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.getUpdateStatus).not.toHaveBeenCalled();
    expect(mocks.installDownloadedUpdate).not.toHaveBeenCalled();
  });

  it('shows a failed update action so the person can retry', async () => {
    mocks.desktop = true;
    mocks.checkForUpdates.mockRejectedValueOnce(new Error('Unable to check for updates.'));
    render(<QueryClientProvider client={new QueryClient()}><ConnectorConnectionUpdateCard /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Update Rally' }));
    expect(await screen.findByText('Unable to check for updates.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('button', { name: 'Update Rally' })).toBeEnabled();
  });

  it('restores a resource authorization card only from a valid failed tool result', () => {
    const recovery = {
      kind: 'connector_resource_authorization',
      provider: 'google',
      connectionId: '00000000-0000-7000-8000-000000000001',
      capability: 'sheets.write',
      operation: 'edit',
      resource: { id: 'sheet-1', type: 'document', name: 'Ellen Buckley Assessment' },
      parentKind: 'canvas',
      parentId: '00000000-0000-7000-8000-000000000002',
      substreamId: '0',
      failedToolInvocationId: '00000000-0000-7000-8000-000000000003:turn:1:tool:0',
      continuationId: '00000000-0000-4000-8000-000000000040',
    };
    expect(connectorResourceAuthorizationRequest({
      toolEvent: { status: 'failed', output: { recovery } },
    })).toEqual(recovery);
    expect(connectorResourceAuthorizationRequest({
      toolEvent: { status: 'completed', output: { recovery } },
    })).toBeNull();
    expect(connectorResourceAuthorizationRequest({
      toolEvent: { status: 'failed', output: { recovery: { ...recovery, operation: 'delete' } } },
    })).toBeNull();
  });

  it('renders and starts the generic resource authorization recovery', async () => {
    const request = ConnectorResourceAuthorizationRequestSchema.parse({
      kind: 'connector_resource_authorization' as const,
      provider: 'google',
      connectionId: '00000000-0000-7000-8000-000000000001',
      capability: 'sheets.write',
      operation: 'edit' as const,
      resource: { id: 'sheet-1', type: 'document', name: 'Ellen Buckley Assessment' },
      parentKind: 'canvas' as const,
      parentId: '00000000-0000-7000-8000-000000000002',
      substreamId: '0',
      failedToolInvocationId: '00000000-0000-7000-8000-000000000003:turn:1:tool:0',
      continuationId: '00000000-0000-4000-8000-000000000040',
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectorConnectionsProvider connections={[{
          id: request.connectionId,
          modelPluginId: 'plugin_google',
          connectorType: 'google',
          displayName: 'Google Drive + Docs + Sheets',
          scope: 'you',
          ownerUserId: 'user-one',
          status: 'healthy',
          capabilities: ['sheets.write'],
        }]}>
          <ConnectorResourceAuthorizationCard request={request} />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText('Google needs you to allow Rally to edit this file.')).toBeInTheDocument();
    expect(screen.getByText('Ellen Buckley Assessment')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Allow editing' }));
    await waitFor(() => expect(mocks.startConnectorResourceAuthorization).toHaveBeenCalledWith(request), { timeout: 5_000 });
    expect(mocks.openExternal).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth');
  });

  it('omits connector setup and its discovery request in a lite collaboration host', () => {
    mocks.setupEnabled = false;
    const { container } = render(<ConnectorConnectionCard request={{ connectorId: 'slack', scope: 'personal' }} />);
    expect(container).toBeEmptyDOMElement();
    expect(mocks.getAvailableConnectorTypes).not.toHaveBeenCalled();
    expect(mocks.startProviderConnection).not.toHaveBeenCalled();
  });

  it('restores a completed card from its durable result or legacy exact summary', () => {
    expect(connectorConnectionCardInput({
      toolEvent: {
        name: CONNECTOR_CONNECTION_CARD_WIRE_NAME,
        status: 'completed',
        output: { connectorId: 'slack', scope: 'personal' },
      },
    })).toEqual({ connectorId: 'slack', scope: 'personal' });
    expect(connectorConnectionCardInput({
      toolEvent: {
        name: CONNECTOR_CONNECTION_CARD_WIRE_NAME,
        status: 'completed',
        summary: 'Presented the slack personal connection card',
      },
    })).toEqual({ connectorId: 'slack', scope: 'personal' });
    expect(connectorConnectionCardInput({
      toolEvent: {
        name: CONNECTOR_CONNECTION_CARD_WIRE_NAME,
        status: 'completed',
        summary: 'Please present the slack personal connection card',
      },
    })).toBeNull();
  });

  it('makes no status claim while the connections query is unresolved', () => {
    render(
      <ConnectorConnectionsProvider connections={undefined}>
        <ConnectorMentionChip connectorType="google" label="@Gmail" />
        <ConnectorEmbedCard connectorType="google" label="Google Drive" />
      </ConnectorConnectionsProvider>,
    );

    const chip = screen.getByText('Gmail').closest('.mention-chip');
    const card = screen.getByText('Google Drive').closest('.citation-connector-card');
    expect(chip).not.toHaveAttribute('data-connector-status');
    expect(chip?.querySelector('.mention-chip-status')).not.toBeInTheDocument();
    expect(card?.querySelector('.citation-connector-card-meta')).not.toBeInTheDocument();
    expect(card?.querySelector('.citation-connector-card-scopes')).not.toBeInTheDocument();
  });

  it('shows missing only after an empty connections result resolves', () => {
    render(
      <ConnectorConnectionsProvider connections={[]}>
        <ConnectorMentionChip connectorType="google" label="@Gmail" />
      </ConnectorConnectionsProvider>,
    );

    const chip = screen.getByText('Gmail').closest('.mention-chip');
    expect(chip).toHaveAttribute('data-connector-status', 'missing');
    expect(chip?.querySelector('.mention-chip-status')).toHaveTextContent('Not connected');
  });

  it('renders the Slack personal card from the core tool and starts trusted OAuth', async () => {
    const request = connectorConnectionCardInput({
      toolEvent: {
        name: CONNECTOR_CONNECTION_CARD_WIRE_NAME,
        status: 'completed',
        input: { connectorId: 'slack', scope: 'personal' },
      },
    });
    expect(request).toEqual({ connectorId: 'slack', scope: 'personal' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectorConnectionsProvider connections={[]}>
          <ConnectorConnectionCard request={request!} />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByText('Slack')).toBeInTheDocument();
    expect(screen.getByText('Personal connection')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Slack' }));
    await waitFor(() => expect(mocks.startProviderConnection).toHaveBeenCalledWith(
      'slack',
      'you',
      ['slack.personal.mcp'],
    ));
    expect(mocks.openExternal).toHaveBeenCalledWith('https://slack.com/oauth/test');
    expect(mocks.setPendingConnectorOAuth).toHaveBeenCalledWith({
      attemptId: 'attempt-one',
      connectorId: 'slack',
      provider: 'slack',
      region: 'global',
      scope: 'personal',
      source: 'conversation',
      workspaceId: 'workspace-one',
    });
  });

  it('shows live status and keeps re-connect available after connection success', async () => {
    const request = { connectorId: 'slack', scope: 'personal' } as const;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Harness = ({ status }: { status?: 'healthy' | 'reconnect_required' | 'disabled' }) => {
      const [connected, setConnected] = useState(false);
      return (
      <QueryClientProvider client={queryClient}>
        <ConnectorConnectionsProvider connections={status ? [{
          id: 'connection-one',
          modelPluginId: 'plugin_slack',
          connectorType: 'slack',
          displayName: 'Slack',
          scope: 'you',
          status,
          capabilities: ['slack.personal.mcp'],
        }] : []}>
          <ConnectorConnectionCard
            latchedConnected={connected}
            onConnected={() => setConnected(true)}
            request={request}
          />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>
      );
    };
    const view = render(<Harness />);

    expect(await screen.findByRole('button', { name: 'Connect Slack' })).toBeInTheDocument();
    view.rerender(<Harness status="healthy" />);
    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument(), { timeout: 5_000 });

    view.rerender(<Harness status="reconnect_required" />);
    expect(screen.getByText('Reconnect required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled();
    view.rerender(<Harness status="disabled" />);
    expect(screen.queryByText('Connected')).not.toBeInTheDocument();
    expect(screen.getByText('Disabled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeEnabled();
  });

  it('reports a connection made while the card is open, once, and never one connected when it opened', async () => {
    const request = { connectorId: 'slack', scope: 'personal' } as const;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onNewlyConnected = vi.fn();
    const Harness = ({ status }: { status?: 'healthy' }) => (
      <QueryClientProvider client={queryClient}>
        <ConnectorConnectionsProvider connections={status ? [{
          id: 'connection-one', modelPluginId: 'plugin_slack', connectorType: 'slack', displayName: 'Slack',
          scope: 'you', status, capabilities: ['slack.personal.mcp'],
        }] : []}>
          <ConnectorConnectionCard onNewlyConnected={onNewlyConnected} request={request} />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>
    );
    const view = render(<Harness />);
    expect(await screen.findByRole('button', { name: 'Connect Slack' })).toBeInTheDocument();
    view.rerender(<Harness status="healthy" />);
    await waitFor(() => expect(onNewlyConnected).toHaveBeenCalledTimes(1));
    view.rerender(<Harness status="healthy" />);
    expect(onNewlyConnected).toHaveBeenCalledTimes(1);
    view.unmount();

    // Already connected for this viewer when it opened: nothing to report, so
    // a question the card answers does not answer itself.
    const already = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectorConnectionsProvider connections={[{
          id: 'connection-one', modelPluginId: 'plugin_slack', connectorType: 'slack', displayName: 'Slack',
          scope: 'you', status: 'healthy', capabilities: ['slack.personal.mcp'],
        }]}>
          <ConnectorConnectionCard onNewlyConnected={already} request={request} />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(already).not.toHaveBeenCalled();
  });

  it('uses a feed-owned Connected latch only while live connections are loading', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const request = { connectorId: 'slack', scope: 'personal' } as const;
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConnectorConnectionsProvider connections={undefined}>
          <ConnectorConnectionCard latchedConnected request={request} />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    view.unmount();
  });

  it.each(['healthy', 'reconnect_required'] as const)('restarts OAuth from a %s card', async (status) => {
    mocks.reconnectConnection.mockResolvedValue({
      attemptId: 'attempt-reconnect',
      url: 'https://slack.com/oauth/reconnect',
    });
    mocks.getConnectorOAuthAttempt.mockResolvedValue({ provider: 'slack', status: 'pending' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectorConnectionsProvider connections={[{
          id: 'connection-one',
          modelPluginId: 'plugin_slack',
          connectorType: 'slack',
          displayName: 'Slack',
          scope: 'you',
          status,
          capabilities: ['slack.personal.mcp'],
        }]}>
          <ConnectorConnectionCard request={{ connectorId: 'slack', scope: 'personal' }} />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(mocks.reconnectConnection).toHaveBeenCalledWith(
      'connection-one',
      'slack',
      'you',
      1,
    ));
    expect(mocks.openExternal).toHaveBeenCalledWith('https://slack.com/oauth/reconnect');
    expect(mocks.setPendingConnectorOAuth).toHaveBeenCalledWith({
      attemptId: 'attempt-reconnect',
      connectorId: 'slack',
      provider: 'slack',
      region: 'global',
      scope: 'personal',
      source: 'conversation',
      workspaceId: 'workspace-one',
    });
  });

  it('keeps reauthorization pending while the existing connection remains healthy', async () => {
    mocks.pendingConnectorOAuth = {
      attemptId: 'attempt-reconnect', connectorId: 'slack', provider: 'slack',
      region: 'global', scope: 'personal', source: 'conversation', workspaceId: 'workspace-one',
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectorConnectionsProvider connections={[{
          id: 'connection-one', modelPluginId: 'plugin_slack', connectorType: 'slack',
          displayName: 'Slack', scope: 'you', status: 'healthy', capabilities: ['slack.personal.mcp'],
        }]}>
          <ConnectorConnectionCard request={{ connectorId: 'slack', scope: 'personal' }} />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
    expect(screen.getByRole('button', { name: 'Waiting…' })).toBeDisabled();
    expect(mocks.setPendingConnectorOAuth).not.toHaveBeenCalled();
    mocks.getConnectorOAuthAttempt.mockResolvedValue({ status: 'succeeded' });
    fireEvent.focus(window);
    await waitFor(() => expect(mocks.setPendingConnectorOAuth).toHaveBeenCalledWith(null));
  });

  it.each(['connections', 'oauth topic', 'remount'] as const)('reconciles completed browser OAuth on %s without focus', async (signal) => {
    mocks.session.authentication = 'cookie';
    mocks.pendingConnectorOAuth = {
      attemptId: 'attempt-reconnect', connectorId: 'slack', provider: 'slack',
      region: 'global', scope: 'personal', source: 'conversation', workspaceId: 'workspace-one',
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const emptyConnections = [] as const;
    const Harness = ({ refreshed = false }: { refreshed?: boolean }) => (
      <QueryClientProvider client={queryClient}>
        <ConnectorConnectionsProvider connections={refreshed ? [{
          id: 'connection-one', modelPluginId: 'plugin_slack', connectorType: 'slack',
          displayName: 'Slack', scope: 'you', status: 'healthy', capabilities: ['slack.personal.mcp'],
        }] : emptyConnections}>
          <ConnectorConnectionCard request={{ connectorId: 'slack', scope: 'personal' }} />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>
    );
    const view = render(<Harness />);
    await waitFor(() => expect(mocks.getConnectorOAuthAttempt).toHaveBeenCalledWith('attempt-reconnect'));
    expect(mocks.setPendingConnectorOAuth).not.toHaveBeenCalled();
    mocks.getConnectorOAuthAttempt.mockResolvedValue({ status: 'succeeded' });
    if (signal === 'remount') {
      view.unmount();
      render(<Harness />);
    } else {
      if (signal === 'oauth topic') mocks.oauthWaterline += 1;
      view.rerender(<Harness refreshed={signal === 'connections'} />);
    }
    await waitFor(() => expect(mocks.setPendingConnectorOAuth).toHaveBeenCalledWith(null));
  });

  it('requires an explicit account choice before reconnecting multiple matching accounts', async () => {
    mocks.reconnectConnection.mockResolvedValue({ attemptId: 'attempt-reconnect', url: 'https://slack.com/oauth/reconnect' });
    mocks.getConnectorOAuthAttempt.mockResolvedValue({ provider: 'slack', status: 'pending' });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectorConnectionsProvider connections={['Work Slack', 'Community Slack'].map((displayName, index) => ({
          id: `connection-${index}`, modelPluginId: 'plugin_slack', connectorType: 'slack',
          displayName, scope: 'you', status: 'healthy', capabilities: ['slack.personal.mcp'],
        }))}>
          <ConnectorConnectionCard request={{ connectorId: 'slack', scope: 'personal' }} />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Reconnect' })).toBeDisabled();
    expect(mocks.reconnectConnection).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Account to reconnect' }), { target: { value: 'connection-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(mocks.reconnectConnection).toHaveBeenCalledWith('connection-1', 'slack', 'you', 1));
    expect(mocks.openExternal).toHaveBeenCalledWith('https://slack.com/oauth/reconnect');
  });

  it('shows unavailable rather than checking indefinitely when connection data is absent', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectorConnectionsProvider connections={undefined}>
          <ConnectorConnectionCard request={{ connectorId: 'slack', scope: 'personal' }} />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Unavailable' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Unavailable');
  });

  it('points a browser at the Mac app for a desktop-only connector, reconnect included', async () => {
    mocks.session.authentication = 'cookie';
    mocks.getAvailableConnectorTypes.mockResolvedValue(['canva']);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectorConnectionsProvider connections={[{
          id: 'connection-canva',
          modelPluginId: 'plugin_canva',
          connectorType: 'canva',
          displayName: 'Canva',
          scope: 'you',
          status: 'reconnect_required',
          capabilities: ['canva.personal.mcp'],
        }]}>
          <ConnectorConnectionCard request={{ connectorId: 'canva', scope: 'personal' }} />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('link', { name: 'Download the Mac app to connect this.' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(mocks.reconnectConnection).not.toHaveBeenCalled();
    expect(mocks.startProviderConnection).not.toHaveBeenCalled();
  });

  it('disables organization OAuth for members', async () => {
    mocks.workspaceRole = 'member';
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectorConnectionsProvider connections={[]}>
          <ConnectorConnectionCard request={{ connectorId: 'slack', scope: 'workspace' }} />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('button', { name: 'Admin required' })).toBeDisabled();
  });

  /**
   * The flow this gate exists for, and the one it used to get wrong.
   *
   * Somebody is promoted to administrator precisely so they can connect a
   * workspace account. The session they are holding still says `member` and
   * will keep saying it until its access token rotates; the served workspace
   * says `admin` on the next read. The card has to believe the second one.
   */
  it('lets an administrator promoted mid-session connect an organization account', async () => {
    mocks.workspaceRole = 'admin';
    expect(mocks.session.workspace.role).toBe('member');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ConnectorConnectionsProvider connections={[]}>
          <ConnectorConnectionCard request={{ connectorId: 'slack', scope: 'workspace' }} />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByRole('button', { name: 'Connect Slack' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Admin required' })).not.toBeInTheDocument();
  });
});
