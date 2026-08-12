import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectorCardsData, WorkstreamConnection } from '../lib/types';
import type { ConnectorAuthorization } from '../lib/use-connector-authorization';
import { ConnectorCardsBlock } from './connector-cards';

const openSettings = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock('../lib/platform', () => ({
  desktopBridge: () => ({ openSettings }),
}));

function authorization(overrides: Partial<ConnectorAuthorization> = {}): ConnectorAuthorization {
  return {
    pending: null,
    message: null,
    error: null,
    begin: vi.fn(async () => undefined),
    reconnect: vi.fn(async () => undefined),
    reset: vi.fn(),
    ...overrides,
  };
}

function connection(overrides: Partial<WorkstreamConnection> = {}): WorkstreamConnection {
  return {
    id: 'connection-one',
    modelPluginId: 'plugin',
    connectorType: 'slack',
    displayName: 'Slack',
    scope: 'workspace',
    status: 'healthy',
    capabilities: ['slack.agent', 'slack.notifications.write'],
    ...overrides,
  };
}

function card(offeringId: ConnectorCardsData['cards'][number]['offeringId'], rest: Partial<ConnectorCardsData['cards'][number]> = {}) {
  return { offeringId, ...rest };
}

function cardElement(offeringId: string): HTMLElement {
  const element = document.querySelector(`[data-offering="${offeringId}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`No card for ${offeringId}`);
  return element;
}

describe('ConnectorCardsBlock', () => {
  it('shows connected and not-connected connectors side by side in one block', () => {
    render(
      <ConnectorCardsBlock
        authorization={authorization()}
        block={{ heading: 'Connect what you already use', cards: [card('slack', { scope: 'workspace' }), card('github')] }}
        connections={[connection()]}
        loading={false}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Connect what you already use' })).toBeInTheDocument();
    expect(within(cardElement('slack')).getByText('Connected')).toBeInTheDocument();
    expect(within(cardElement('github')).getByText('Not connected')).toBeInTheDocument();
    // A connected card still offers the one action that state implies, rather
    // than becoming inert: this is the surface people arrive at.
    expect(within(cardElement('slack')).getByRole('button', { name: /Manage/u })).toBeInTheDocument();
    expect(within(cardElement('github')).getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  it('offers to reconnect a connection the provider stopped honouring', async () => {
    const auth = authorization();
    render(
      <ConnectorCardsBlock
        authorization={auth}
        block={{ cards: [card('slack', { scope: 'workspace' })] }}
        connections={[connection({ status: 'reconnect_required' })]}
        loading={false}
      />,
    );

    expect(screen.getByText('Needs reconnecting')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(auth.reconnect).toHaveBeenCalledWith('connection-one'));
  });

  it('does not let one Google offering report the other as connected', () => {
    render(
      <ConnectorCardsBlock
        authorization={authorization()}
        block={{ cards: [card('google-mail-calendar'), card('google-drive-workspace')] }}
        connections={[connection({
          id: 'google-mail',
          connectorType: 'google',
          displayName: 'Google',
          scope: 'you',
          capabilities: ['gmail.read', 'calendar.read'],
        })]}
        loading={false}
      />,
    );

    // One connector type, one OAuth client, two grants. Matching on the type
    // alone would hide the authorization that reads documents behind a card
    // claiming it was already given.
    expect(within(cardElement('google-mail-calendar')).getByText('Connected')).toBeInTheDocument();
    expect(within(cardElement('google-drive-workspace')).getByText('Not connected')).toBeInTheDocument();
  });

  it('treats a disabled connection as something to connect again', () => {
    render(
      <ConnectorCardsBlock
        authorization={authorization()}
        block={{ cards: [card('slack', { scope: 'workspace' })] }}
        connections={[connection({ status: 'disabled' })]}
        loading={false}
      />,
    );

    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  it('starts the authorization with the offering’s own capabilities', async () => {
    const auth = authorization();
    render(
      <ConnectorCardsBlock
        authorization={auth}
        block={{ cards: [card('google-drive-workspace', { scope: 'you' })] }}
        connections={[]}
        loading={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(auth.begin).toHaveBeenCalledWith({
      provider: 'google',
      scope: 'you',
      capabilities: ['drive.read', 'docs.read', 'docs.write', 'sheets.read', 'sheets.write'],
    }));
  });

  it('lets the reader pick the scope when the block did not name one', async () => {
    const auth = authorization();
    render(
      <ConnectorCardsBlock
        authorization={auth}
        block={{ cards: [card('github')] }}
        connections={[]}
        loading={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'For the workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(auth.begin).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'github',
      scope: 'workspace',
    })));
  });

  it('offers no scope choice for a card that already names one', () => {
    render(
      <ConnectorCardsBlock
        authorization={authorization()}
        block={{ cards: [card('github', { scope: 'you' })] }}
        connections={[]}
        loading={false}
      />,
    );

    expect(screen.queryByRole('button', { name: 'For the workspace' })).not.toBeInTheDocument();
    expect(screen.getByText('For you')).toBeInTheDocument();
  });

  it('sends a connector that cannot be authorized in a browser redirect to Settings', () => {
    const auth = authorization();
    render(
      <ConnectorCardsBlock
        authorization={auth}
        block={{ cards: [card('generic-webhook', { scope: 'workspace' })] }}
        connections={[]}
        loading={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    // Creating one mints a signing secret that has to be copied, and there is
    // nowhere in a transcript to show a credential exactly once.
    expect(openSettings).toHaveBeenCalledWith('connections');
    expect(auth.begin).not.toHaveBeenCalled();
  });

  it('claims no state at all when the connections could not be read', () => {
    render(
      <ConnectorCardsBlock
        authorization={authorization()}
        block={{ cards: [card('slack', { scope: 'workspace' })] }}
        connections={undefined}
        loading={false}
        unavailable
      />,
    );

    expect(screen.getByText('Checking…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Checking/u })).toBeDisabled();
    expect(screen.getByText(/could not check which of these are connected/u)).toBeInTheDocument();
  });

  it('shows the note the block gave a card instead of the connector’s own blurb', () => {
    render(
      <ConnectorCardsBlock
        authorization={authorization()}
        block={{ cards: [card('slack', { note: 'So Avalon can answer in #support' })] }}
        connections={[]}
        loading={false}
      />,
    );

    expect(screen.getByText('So Avalon can answer in #support')).toBeInTheDocument();
    expect(screen.queryByText(/Messages, files, people, canvases/u)).not.toBeInTheDocument();
  });

  it('reports an authorization that failed in the browser', () => {
    render(
      <ConnectorCardsBlock
        authorization={authorization({ error: 'Slack authorization was cancelled.' })}
        block={{ cards: [card('slack', { scope: 'workspace' })] }}
        connections={[]}
        loading={false}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Slack authorization was cancelled.');
  });
});
