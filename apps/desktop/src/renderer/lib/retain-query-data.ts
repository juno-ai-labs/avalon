import { QueryObserver, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query';

/**
 * A producer owns its pushed state even while no screen renders it.
 * Hold existing and subsequently created entries until the producer stops;
 * normal garbage collection resumes on release. Explicit eviction still wins.
 * See docs/local-cache.md for the socket/cache lifetime contract.
 */
export function retainQueryData(client: QueryClient, keys: readonly QueryKey[]): () => void {
  const cache = client.getQueryCache();
  const hashes = new Set(keys.map((queryKey) => client.defaultQueryOptions({ queryKey }).queryHash));
  const retained = new Map<Query, () => void>();
  const retain = (query: Query): void => {
    if (!hashes.has(query.queryHash) || retained.has(query)) return;
    const observer = new QueryObserver(client, {
      ...query.options,
      queryKey: query.queryKey,
      enabled: false,
      notifyOnChangeProps: [],
    });
    retained.set(query, observer.subscribe(() => undefined));
  };
  const unsubscribe = cache.subscribe((event) => {
    if (event.type === 'added') retain(event.query);
    if (event.type === 'removed') {
      retained.get(event.query)?.();
      retained.delete(event.query);
    }
  });
  for (const hash of hashes) {
    const query = cache.get(hash);
    if (query) retain(query);
  }
  return () => {
    unsubscribe();
    for (const release of retained.values()) release();
    retained.clear();
  };
}
