import { Check, AlertTriangle, Minus } from 'lucide-react';
import { createContext, useContext } from 'react';
import {
  connectorAggregateStatus,
  connectorPresentation,
  connectorScopeLabel,
  connectorScopeStates,
  connectorStatusLabel,
  type ConnectorScopeStatus,
} from '../lib/connector-presentation';
import type { PluginBrandMark } from '../lib/plugin-marks';
import type { WorkstreamConnection } from '../lib/types';
import { ConnectorMark } from './primitives';

const ConnectorConnectionsContext = createContext<readonly WorkstreamConnection[]>([]);

export function ConnectorConnectionsProvider({
  children,
  connections,
}: {
  children: React.ReactNode;
  connections: readonly WorkstreamConnection[];
}): React.JSX.Element {
  return (
    <ConnectorConnectionsContext.Provider value={connections}>
      {children}
    </ConnectorConnectionsContext.Provider>
  );
}

export function useConnectorConnections(): readonly WorkstreamConnection[] {
  return useContext(ConnectorConnectionsContext);
}

/** Same mark chip as Settings → Connections provider cards (`.provider-icon`). */
function ConnectorProviderIcon({
  className,
  mark,
}: {
  className?: string;
  mark: PluginBrandMark;
}): React.JSX.Element {
  return (
    <span aria-hidden="true" className={className ? `provider-icon ${className}` : 'provider-icon'}>
      <ConnectorMark mark={mark} />
    </span>
  );
}

function StatusGlyph({ status }: { status: ConnectorScopeStatus }): React.JSX.Element {
  if (status === 'healthy') return <Check aria-hidden="true" size={12} strokeWidth={2.5} />;
  if (status === 'reconnect_required') return <AlertTriangle aria-hidden="true" size={12} strokeWidth={2.5} />;
  return <Minus aria-hidden="true" size={12} strokeWidth={2.5} />;
}

/**
 * Inline connector mention: brand mark, name, and one aggregate connection status.
 */
export function ConnectorMentionChip({
  connectorType,
  label,
}: {
  connectorType: string;
  label: string;
}): React.JSX.Element {
  const connections = useConnectorConnections();
  const presentation = connectorPresentation(connectorType, label);
  const status = connectorAggregateStatus(connectorScopeStates(connectorType, connections));
  const displayLabel = label.replace(/^@/u, '');
  return (
    <span
      className="mention-chip mention-chip-connector"
      data-connector-status={status}
      data-connector-type={connectorType}
    >
      {presentation.mark ? (
        <ConnectorProviderIcon className="mention-chip-connector-icon" mark={presentation.mark} />
      ) : null}
      <span className="mention-chip-label">{displayLabel}</span>
      <span className={`mention-chip-status mention-chip-status-${status}`}>
        <StatusGlyph status={status} />
        <span>{connectorStatusLabel(status)}</span>
      </span>
    </span>
  );
}

/**
 * Block connector announcement — horizontal card taking colour/radius cues from
 * `.citation-card`, content shaped like the settings provider row: mark, name,
 * description, and personal + workspace connection state.
 */
export function ConnectorEmbedCard({
  connectorType,
  label,
}: {
  connectorType: string;
  label?: string;
}): React.JSX.Element {
  const connections = useConnectorConnections();
  const presentation = connectorPresentation(connectorType, label);
  const scopes = connectorScopeStates(connectorType, connections);
  const title = label?.replace(/^@/u, '') || presentation.name;
  const capabilityCount = scopes
    .flatMap((scope) => scope.connection?.capabilities ?? [])
    .filter((value, index, all) => all.indexOf(value) === index)
    .length;

  return (
    <article
      className="citation-connector-card"
      data-connector-type={connectorType}
    >
      {presentation.mark ? <ConnectorProviderIcon mark={presentation.mark} /> : null}
      <div className="citation-connector-card-body">
        <strong className="citation-connector-card-title">{title}</strong>
        <p className="citation-connector-card-description">{presentation.description}</p>
        <p className="citation-connector-card-meta">
          {capabilityCount > 0
            ? `${capabilityCount} ${capabilityCount === 1 ? 'capability' : 'capabilities'}`
            : 'No capabilities on a connected account yet'}
        </p>
      </div>
      <ul className="citation-connector-card-scopes">
        {scopes.map((scope) => (
          <li
            className={`citation-connector-status citation-connector-status-${scope.status}`}
            key={scope.scope}
          >
            <StatusGlyph status={scope.status} />
            <span>
              {connectorScopeLabel(scope.scope)}
              {' · '}
              {connectorStatusLabel(scope.status)}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}
