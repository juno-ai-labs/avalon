import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { fetchThroughOwner } from './fetch-through-owner';

describe('fetchThroughOwner', () => {
  it('refetches with the owner\'s fetcher when a reader set its options last', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const owner = new QueryObserver(client, {
      queryKey: ['rows'],
      queryFn: async () => ['fetched'],
      staleTime: Number.POSITIVE_INFINITY,
    });
    const unsubscribeOwner = owner.subscribe(() => undefined);
    await owner.refetch();
    const reader = new QueryObserver(client, { queryKey: ['rows'], queryFn: fetchThroughOwner, enabled: false });
    const unsubscribeReader = reader.subscribe(() => undefined);
    client.setQueryData(['rows'], ['pushed']);

    await client.invalidateQueries({ queryKey: ['rows'] });

    expect(client.getQueryState(['rows'])).toMatchObject({ status: 'success', data: ['fetched'] });
    unsubscribeReader();
    unsubscribeOwner();
  });

  it('leaves an entry with only readers alone on invalidation', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const reader = new QueryObserver(client, { queryKey: ['socket'], queryFn: fetchThroughOwner, enabled: false });
    const unsubscribe = reader.subscribe(() => undefined);
    client.setQueryData(['socket'], ['pushed']);

    await client.invalidateQueries({ queryKey: ['socket'] });

    expect(client.getQueryState(['socket'])).toMatchObject({ status: 'success', data: ['pushed'] });
    unsubscribe();
  });
});
