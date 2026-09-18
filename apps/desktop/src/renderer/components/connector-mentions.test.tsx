import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CONNECTOR_CONNECTION_CARD_WIRE_NAME } from '@rally/contracts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import {
  ConnectorConnectionCard,
  ConnectorConnectionsProvider,
  ConnectorEmbedCard,
  ConnectorMentionChip,
  connectorConnectionCardInput,
} from './connector-mentions';

const mocks = vi.hoisted(() => ({
  setupEnabled: true,
  getAvailableConnectorTypes: vi.fn(),
  getConnectorOAuthAttempt: vi.fn(),
  openExternal: vi.fn(),
  pendingConnectorOAuth: null as null | Record<string, unknown>,
  reconnectConnection: vi.fn(),
  // `workspaceRole` is what the card actually gates on: the role served by
  // `GET /workspace`, not the one stamped on the desktop session, because a
  // role changes while somebody is signed in and the session's copy does not
  // move until its token rotates. The session still carries one so the
  // placeholder path is exercised.
  session: {
    user: { id: 'user-one', name: 'Ada', email: 'ada@example.com', timezone: 'America/Los_Angeles' },
    workspace: { id: 'workspace-one', name: 'Rally', region: 'global', timezone: 'America/Los_Angeles', role: 'member' as 'owner' | 'admin' | 'member' },
  },
  workspaceRole: 'owner' as 'owner' | 'admin' | 'member',
  setPendingConnectorOAuth: vi.fn(),
  startProviderConnection: vi.fn(),
}));

vi.mock('../lib/collaboration-session', () => ({
  useOptionalCollaborationSession: () => ({
    api: {
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
    },
    session: mocks.session,
    connectorSetup: mocks.setupEnabled ? { pendingConnectorOAuth: mocks.pendingConnectorOAuth,
      setPendingConnectorOAuth: mocks.setPendingConnectorOAuth, openExternal: mocks.openExternal } : null,
  }),
}));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ openExternal: mocks.openExternal }),
  desktopServicesAvailable: () => false,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.pendingConnectorOAuth = null;
  mocks.setupEnabled = true;
  mocks.workspaceRole = 'owner';
  mocks.getAvailableConnectorTypes.mockResolvedValue(['google', 'github', 'granola', 'linear', 'notion', 'slack']);
  mocks.getConnectorOAuthAttempt.mockResolvedValue({ status: 'pending' });
  mocks.startProviderConnection.mockResolvedValue({
    attemptId: 'attempt-one',
    url: 'https://slack.com/oauth/test',
  });
  mocks.openExternal.mockResolvedValue(undefined);
});

describe('connector connection resolution', () => {
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

  it('latches Connected after socket-refreshed connection state first becomes healthy', async () => {
    const request = { connectorId: 'slack', scope: 'personal' } as const;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const Harness = ({ status }: { status?: 'healthy' | 'reconnect_required' }) => {
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
    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());

    view.rerender(<Harness status="reconnect_required" />);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('uses a feed-owned Connected latch after the card remounts', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const request = { connectorId: 'slack', scope: 'personal' } as const;
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ConnectorConnectionsProvider connections={[]}>
          <ConnectorConnectionCard latchedConnected request={request} />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    view.unmount();
  });

  it('restarts OAuth from a reconnect-required card', async () => {
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
          status: 'reconnect_required',
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

  it('disables workspace OAuth for members', async () => {
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
  it('lets an administrator promoted mid-session connect a workspace account', async () => {
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
