import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectorConnectionCard,
  ConnectorConnectionsProvider,
  ConnectorEmbedCard,
  ConnectorMentionChip,
  connectorConnectionCardInput,
} from './connector-mentions';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(),
  setPendingConnectorOAuth: vi.fn(),
  startProviderConnection: vi.fn(),
}));

vi.mock('../lib/app-session', () => ({
  useAppSession: () => ({
    api: { startProviderConnection: mocks.startProviderConnection },
    pendingConnectorOAuth: null,
    session: { workspace: { id: 'workspace-one', region: 'global' } },
    setPendingConnectorOAuth: mocks.setPendingConnectorOAuth,
  }),
}));
vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ openExternal: mocks.openExternal }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startProviderConnection.mockResolvedValue({
    attemptId: 'attempt-one',
    url: 'https://slack.com/oauth/test',
  });
  mocks.openExternal.mockResolvedValue(undefined);
});

describe('connector connection resolution', () => {
  it('restores a completed card from its durable result or legacy exact summary', () => {
    expect(connectorConnectionCardInput({
      toolEvent: {
        name: 'core_show_connector_connection',
        status: 'completed',
        output: { connectorId: 'slack', scope: 'personal' },
      },
    })).toEqual({ connectorId: 'slack', scope: 'personal' });
    expect(connectorConnectionCardInput({
      toolEvent: {
        name: 'core_show_connector_connection',
        status: 'completed',
        summary: 'Presented the slack personal connection card',
      },
    })).toEqual({ connectorId: 'slack', scope: 'personal' });
    expect(connectorConnectionCardInput({
      toolEvent: {
        name: 'core_show_connector_connection',
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
        name: 'core_show_connector_connection',
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
    fireEvent.click(screen.getByRole('button', { name: 'Connect Slack' }));
    await waitFor(() => expect(mocks.startProviderConnection).toHaveBeenCalledWith(
      'slack',
      'you',
      ['slack.personal.mcp'],
    ));
    expect(mocks.openExternal).toHaveBeenCalledWith('https://slack.com/oauth/test');
    expect(mocks.setPendingConnectorOAuth).toHaveBeenCalledWith({
      attemptId: 'attempt-one',
      provider: 'slack',
      region: 'global',
      workspaceId: 'workspace-one',
    });
  });

  it('latches Connected after socket-refreshed connection state first becomes healthy', async () => {
    const request = { connectorId: 'slack', scope: 'personal' } as const;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const renderCard = (status?: 'healthy' | 'reconnect_required') => (
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
          <ConnectorConnectionCard request={request} />
        </ConnectorConnectionsProvider>
      </QueryClientProvider>
    );
    const view = render(renderCard());

    expect(screen.getByRole('button', { name: 'Connect Slack' })).toBeInTheDocument();
    view.rerender(renderCard('healthy'));
    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());

    view.rerender(renderCard('reconnect_required'));
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });
});
