import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { SidekickDelegationList } from '@rally/ui/components/sidekick-delegation';
import { ErrorNotice } from './primitives';
import { useCollaborationSession } from '../lib/collaboration-session';
import { useOnline } from '../lib/use-online';

export function SidekickDelegation({ id }: { id: string }): React.JSX.Element {
  const { api } = useCollaborationSession();
  const online = useOnline();
  const client = useQueryClient();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const query = useQuery({ queryKey: ['automation', id, 'delegation'],
    queryFn: ({ signal }) => api!.getSidekickDelegates(id, signal), enabled: Boolean(api),
    refetchOnReconnect: true, refetchOnWindowFocus: true,
  });
  const refresh = async (): Promise<void> => {
    const result = await query.refetch();
    if (!result.error) setUncertain(false);
  };
  const act = async (userId: string, write: () => Promise<unknown>): Promise<void> => {
    if (!api || !navigator.onLine || uncertain || inFlight.current.has(userId)) return;
    inFlight.current.add(userId);
    setPending((current) => new Set([...current, userId]));
    setError(null);
    try {
      await write();
    } catch (cause) {
      setUncertain(true);
      setError(cause instanceof Error ? cause : new Error('The delegation change could not be confirmed.'));
    } finally {
      // Reads reconcile both acknowledged and uncertain writes. A failed read
      // leaves the last confirmed list and blocks another change until refresh.
      const result = await query.refetch();
      setUncertain(Boolean(result.error));
      inFlight.current.delete(userId);
      setPending((current) => new Set([...current].filter((key) => key !== userId)));
      void client.invalidateQueries({ queryKey: ['account-sidekick-delegations'] });
      void client.invalidateQueries({ queryKey: ['automation', id], exact: true });
    }
  };
  return <>
    <SidekickDelegationList data={query.data} loading={query.isPending} offline={!online}
      needsRefresh={uncertain || Boolean(query.error)} pendingUserIds={pending}
      onRefresh={() => void refresh()}
      onSetOwn={(allowed) => {
        if (query.data) void act(query.data.you.userId, () => api!.setMySidekickDelegation(id, allowed, crypto.randomUUID()));
      }}
      onRemove={(userId) => void act(userId, () => api!.removeSidekickDelegate(id, userId, crypto.randomUUID()))} />
    {(error || query.error) && <ErrorNotice occurrence={error ?? query.error}>{(error ?? query.error)?.message}</ErrorNotice>}
  </>;
}
