import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';
import type { ClientSession } from '@rally/contracts/client-session';
import type { ConnectorOAuthProvider } from '@rally/contracts';
import type { Region } from '@rally/contracts/regions';
import type { RallyApi } from './api';

export interface PendingConnectorOAuth {
  source?: 'onboarding' | 'conversation';
  connectorId?: string;
  scope?: 'personal' | 'workspace';
  attemptId: string;
  provider: ConnectorOAuthProvider;
  region: Region;
  workspaceId: string;
}

export interface ConnectorSetupCapability {
  pendingConnectorOAuth: PendingConnectorOAuth | null;
  setPendingConnectorOAuth: (attempt: PendingConnectorOAuth | null) => void;
  openExternal: (url: string) => Promise<void>;
}

export interface CollaborationSessionValue {
  api: RallyApi | null;
  session: ClientSession | null;
  /** The lite browser uses existing connectors and supplies no setup capability. */
  connectorSetup: ConnectorSetupCapability | null;
  createSidekick: (() => Promise<void>) | null;
}

const CollaborationSessionContext = createContext<CollaborationSessionValue | null>(null);

export function CollaborationSessionProvider({ api, session, connectorSetup = null, createSidekick = null, children }:
  PropsWithChildren<Pick<CollaborationSessionValue, 'api' | 'session'> & Partial<Pick<CollaborationSessionValue, 'connectorSetup' | 'createSidekick'>>>): React.JSX.Element {
  const value = useMemo(() => ({ api, session, connectorSetup, createSidekick }), [api, session, connectorSetup, createSidekick]);
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
