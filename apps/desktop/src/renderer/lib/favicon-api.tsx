import { createContext, type PropsWithChildren, useContext } from 'react';
import type { RallyApi } from './api';
import { useAppSession } from './app-session';

const FaviconApiContext = createContext<RallyApi | null>(null);

/**
 * Narrows the broad session context to the one stable capability every
 * Markdown body may read. Workspace/session metadata changes therefore do not
 * re-render every finished message merely because it contains a web link.
 */
export function FaviconApiProvider({ children }: PropsWithChildren): React.JSX.Element {
  const { api } = useAppSession();
  return <FaviconApiContext.Provider value={api}>{children}</FaviconApiContext.Provider>;
}

/** Null in detached still exports and focused component tests. */
export function useFaviconApi(): RallyApi | null {
  return useContext(FaviconApiContext);
}
