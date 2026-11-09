import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';
import type { ClientSession } from '@rally/contracts/client-session';
import type { ConnectorOAuthProvider } from '@rally/contracts';
import type { Region } from '@rally/contracts/regions';
import type { RallyApi } from './api';

export interface PendingConnectorOAuth {
  source?: 'conversation' | 'resource';
  connectorId?: string;
  scope?: 'personal' | 'workspace';
  attemptId: string;
  provider: ConnectorOAuthProvider;
  region: Region;
  workspaceId: string;
  resourceAuthorizationKey?: string;
  resourceAuthorizationStatus?: 'pending' | 'succeeded' | 'denied' | 'failed';
}

export interface ConnectorSetupCapability {
  pendingConnectorOAuth: PendingConnectorOAuth | null;
  setPendingConnectorOAuth: (attempt: PendingConnectorOAuth | null) => void;
  resourceAuthorizationAttempts: Readonly<Record<string, PendingConnectorOAuth>>;
  setResourceAuthorizationAttempt: (key: string, attempt: PendingConnectorOAuth | null) => void;
  openExternal: (url: string) => Promise<void>;
}

export interface CollaborationSessionValue {
  api: RallyApi | null;
  session: ClientSession | null;
  /** Which app is drawing this: the Mac app or a browser tab. */
  host: 'desktop' | 'browser';
  /** Absent where a host cannot start a connection; existing connectors still work. */
  connectorSetup: ConnectorSetupCapability | null;
}

const CollaborationSessionContext = createContext<CollaborationSessionValue | null>(null);

export function CollaborationSessionProvider({ api, session, host = 'desktop', connectorSetup = null, children }:
  PropsWithChildren<Pick<CollaborationSessionValue, 'api' | 'session'> & Partial<Pick<CollaborationSessionValue, 'host' | 'connectorSetup'>>>): React.JSX.Element {
  const value = useMemo(() => ({ api, session, host, connectorSetup }), [api, session, host, connectorSetup]);
  return <CollaborationSessionContext.Provider value={value}>{children}</CollaborationSessionContext.Provider>;
}

export function useOptionalCollaborationSession(): CollaborationSessionValue | null {
  return useContext(CollaborationSessionContext);
}

export function useCollaborationSession(): CollaborationSessionValue {
  const context = useOptionalCollaborationSession();
  if (!context) throw new Error('Collaboration requires a CollaborationSessionProvider');
  return context;
}

/**
 * What the person in front of this shell can do, from the two facts that
 * decide it: which app is drawing (`host`) and whether they belong to the
 * Organization or were shared into some of its conversations (`guest`).
 *
 * The one place a surface asks. Members and guests, in the Mac app or a tab,
 * mount the same shell; what differs is read here rather than by a second
 * shell. The server still authorizes every call; this only keeps the shell
 * from making ones that would be refused.
 */
export interface ShellCapabilities {
  host: 'desktop' | 'browser';
  guest: boolean;
}

export function shellCapabilities(value: Pick<CollaborationSessionValue, 'host' | 'session'> | null): ShellCapabilities {
  return {
    host: value?.host ?? 'desktop',
    guest: value?.session?.workspace?.accessClass === 'guest',
  };
}

export function useShellCapabilities(): ShellCapabilities {
  const value = useOptionalCollaborationSession();
  return useMemo(() => shellCapabilities(value), [value?.host, value?.session?.workspace?.accessClass]);
}
