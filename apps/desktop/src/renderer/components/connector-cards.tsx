import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowUpRight, Check, CircleAlert, LoaderCircle, Plug } from 'lucide-react';
import { useState } from 'react';
import { useAppSession } from '../lib/app-session';
import {
  connectorCardStatus,
  connectorOffering,
  connectorOfferingIcon,
  offeringCapabilities,
  offeringOAuthProvider,
  offeringScopes,
  offeringSupportsOAuth,
  type ConnectorCardState,
} from '../lib/connector-offerings';
import { desktopBridge } from '../lib/platform';
import type { ConnectorCardData, ConnectorCardsData, Scope, WorkstreamConnection } from '../lib/types';
import { useConnectorAuthorization, type ConnectorAuthorization } from '../lib/use-connector-authorization';
import { Button, InlineError } from './primitives';

const scopeLabel: Record<Scope, string> = { you: 'For you', workspace: 'For the workspace' };

const stateLabel: Record<ConnectorCardState, string> = {
  connected: 'Connected',
  needs_attention: 'Needs reconnecting',
  disconnected: 'Not connected',
  unknown: 'Checking…',
};

function openConnectionSettings(): void {
  void desktopBridge().openSettings('connections');
}

interface ConnectorCardProps {
  card: ConnectorCardData;
  connections: WorkstreamConnection[] | undefined;
  /** True while the connections this card reads have not been answered for. */
  loading: boolean;
  authorization: ConnectorAuthorization;
}

/**
 * One connector card: an offering, its live state, and the one action that
 * state implies.
 *
 * The scope shown is the card's when the block named one, and otherwise the
 * reader's choice among the offering's — which is why a scopeless card can be
 * connected personally by one member and for the workspace by an admin from the
 * same block, without either being told which one they were supposed to pick.
 */
function ConnectorCard({ authorization, card, connections, loading }: ConnectorCardProps): React.JSX.Element {
  const offering = connectorOffering(card.offeringId);
  const scopes = offeringScopes(offering);
  const [chosenScope, setChosenScope] = useState<Scope>(card.scope ?? scopes[0] ?? 'you');
  const scope = card.scope ?? chosenScope;
  const status = connectorCardStatus(offering, card.scope, loading ? undefined : connections);
  const Icon = connectorOfferingIcon(offering);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const waiting = authorization.pending?.provider === offering.connectorType;

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That connection could not be started.');
    } finally {
      setBusy(false);
    }
  };

  const connect = (): void => {
    const provider = offeringOAuthProvider(offering);
    // Everything an authorization redirect cannot finish — a signing secret to
    // copy, an admin API key to paste — goes to Settings rather than starting
    // something here that cannot be completed here.
    if (!provider || !offeringSupportsOAuth(offering, scope)) {
      openConnectionSettings();
      return;
    }
    void run(() => authorization.begin({
      provider,
      scope,
      capabilities: offeringCapabilities(offering, scope),
    }));
  };

  const action = (): React.JSX.Element => {
    if (status.state === 'unknown') {
      return <Button disabled><LoaderCircle aria-hidden="true" className="spin" size={13} /> Checking</Button>;
    }
    if (status.state === 'connected') {
      return (
        <Button onClick={openConnectionSettings}>
          Manage <ArrowUpRight aria-hidden="true" size={13} />
        </Button>
      );
    }
    if (status.state === 'needs_attention' && status.connection) {
      return (
        <Button
          className="button-primary"
          disabled={busy || waiting}
          onClick={() => void run(() => authorization.reconnect(status.connection!.id))}
        >
          {(busy || waiting) && <LoaderCircle aria-hidden="true" className="spin" size={13} />}
          Reconnect
        </Button>
      );
    }
    return (
      <Button className="button-primary" disabled={busy || waiting} onClick={connect}>
        {(busy || waiting) && <LoaderCircle aria-hidden="true" className="spin" size={13} />}
        Connect
      </Button>
    );
  };

  return (
    <article className={clsx('connector-card', `connector-card-${status.state}`)} data-offering={offering.id}>
      <span aria-hidden="true" className="connector-card-icon"><Icon size={17} /></span>
      <div className="connector-card-copy">
        <strong>{offering.name}</strong>
        <p>{card.note ?? offering.description}</p>
        {/* A card the block left scopeless is a real choice, so it is offered
            as one rather than resolved silently to the narrower grant. */}
        {!card.scope && scopes.length > 1 && status.state === 'disconnected' && (
          <div className="connector-card-scopes" role="group" aria-label={`${offering.name} connection scope`}>
            {scopes.map((option) => (
              <button
                aria-pressed={scope === option}
                className={clsx('connector-card-scope', scope === option && 'is-selected')}
                key={option}
                onClick={() => setChosenScope(option)}
                type="button"
              >
                {scopeLabel[option]}
              </button>
            ))}
          </div>
        )}
        {error && <InlineError>{error}</InlineError>}
      </div>
      <div className="connector-card-side">
        <span className="connector-card-state">
          {status.state === 'connected' && <Check aria-hidden="true" size={12} />}
          {status.state === 'needs_attention' && <CircleAlert aria-hidden="true" size={12} />}
          {stateLabel[status.state]}
          {status.state === 'connected' && status.connection && (
            <small>{status.connection.scope === 'workspace' ? 'Workspace' : 'You'}</small>
          )}
          {status.state !== 'connected' && card.scope && <small>{scopeLabel[card.scope]}</small>}
        </span>
        {action()}
      </div>
    </article>
  );
}

export interface ConnectorCardsBlockProps {
  block: ConnectorCardsData;
  /** Every connection this member can see; `undefined` until they are known. */
  connections: WorkstreamConnection[] | undefined;
  loading: boolean;
  /** Set when the connections could not be loaded, so no card can claim a state. */
  unavailable?: boolean;
  authorization: ConnectorAuthorization;
}

/**
 * The transcript block. Presentational on purpose — it is handed the
 * connections and the authorization rather than fetching either, so its states
 * can be rendered directly in a test without a live session.
 */
export function ConnectorCardsBlock({
  authorization,
  block,
  connections,
  loading,
  unavailable = false,
}: ConnectorCardsBlockProps): React.JSX.Element {
  return (
    <section aria-label={block.heading ?? 'Connections'} className="connector-cards-block">
      <header>
        <span aria-hidden="true"><Plug size={14} /></span>
        <div>
          <small>Connections</small>
          {block.heading && <h3>{block.heading}</h3>}
        </div>
      </header>
      <div className="connector-card-list">
        {block.cards.map((card) => (
          <ConnectorCard
            authorization={authorization}
            card={card}
            connections={connections}
            key={`${card.offeringId}:${card.scope ?? 'any'}`}
            loading={loading || unavailable}
          />
        ))}
      </div>
      {/* A failed connections read is said once for the block. Each card
          reporting it separately would repeat the same sentence up to six
          times, and none of them would be about that card. */}
      {unavailable && (
        <p className="connector-cards-notice">
          Avalon could not check which of these are connected. Open Settings to see the current state.
        </p>
      )}
      {authorization.error && <InlineError>{authorization.error}</InlineError>}
      {authorization.message && <p className="connector-cards-confirmation"><Check aria-hidden="true" size={12} /> {authorization.message}</p>}
    </section>
  );
}

/**
 * The block as the transcript renders it, wired to this member's connections.
 *
 * The query is keyed `['connections']` — the same key the Settings pane and the
 * authorization hook use — so every card in every open work stream shares one
 * fetch and one cache entry, and a connection made anywhere updates all of them
 * without a reload. That shared key is why a card's state is never stored in
 * the message it came from.
 */
export function ConnectorCardsMessage({ block }: { block: ConnectorCardsData }): React.JSX.Element {
  const { api } = useAppSession();
  const authorization = useConnectorAuthorization(api);
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: ({ signal }) => api!.getConnections(signal),
    enabled: Boolean(api),
    refetchOnWindowFocus: 'always',
    staleTime: 5_000,
  });
  return (
    <ConnectorCardsBlock
      authorization={authorization}
      block={block}
      connections={connections.data}
      loading={connections.isLoading || !api}
      unavailable={connections.isError}
    />
  );
}
