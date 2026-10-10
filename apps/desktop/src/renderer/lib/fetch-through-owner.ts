import type { QueryFunctionContext } from '@tanstack/react-query';

/**
 * The `queryFn` of an observer that only reads a cache entry: a socket-owned
 * entry's readers, and a list's readers beside the one hook that fetches it.
 *
 * Each observer's options become the query's when it renders, so whichever
 * observer rendered last is what an invalidation runs. A reader that passed a
 * placeholder made that placeholder the fetch, and its `undefined` failed the
 * query ("Query data cannot be undefined") instead of reading it again. This
 * runs the fetcher of the observer that has a real one. An entry with no such
 * observer is never refetched by an invalidation: every observer is disabled,
 * so the query is too.
 */
export function fetchThroughOwner<T>(context: QueryFunctionContext): Promise<T> {
  const query = context.client.getQueryCache().find({ queryKey: context.queryKey, exact: true });
  const owner = query?.observers.find((observer) => typeof observer.options.queryFn === 'function'
    && observer.options.queryFn !== fetchThroughOwner);
  const queryFn = owner?.options.queryFn;
  if (typeof queryFn !== 'function') throw new Error('query_has_no_owning_fetcher');
  return Promise.resolve(queryFn(context) as T);
}
