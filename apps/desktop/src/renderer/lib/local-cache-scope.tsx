import { createContext, useContext, type PropsWithChildren } from 'react';

const LocalCacheScopeContext = createContext<string | null>(null);

/**
 * Names the regional workspace every local-cache row below this provider is
 * read from and written to. Outside one — a standalone screen test, an
 * embedding with no workspace — the scope is null and every consumer behaves
 * as if there were no cache, which is exactly the behavior that existed before
 * it.
 */
export function LocalCacheScopeProvider({ children, scope }: PropsWithChildren<{ scope: string }>): React.JSX.Element {
  return <LocalCacheScopeContext.Provider value={scope}>{children}</LocalCacheScopeContext.Provider>;
}

export function useLocalCacheScope(): string | null {
  return useContext(LocalCacheScopeContext);
}
