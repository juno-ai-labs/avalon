import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SidekickDelegatesResult, SidekickDelegationMutationResult } from '@rally/contracts';
import { SidekickDelegationList } from '@rally/ui/components/sidekick-delegation';
import { Button, ErrorNotice } from './primitives';
import { useCollaborationSession } from '../lib/collaboration-session';
import { useOnline } from '../lib/use-online';

export function useSidekickDelegates(id: string) {
  const { api } = useCollaborationSession();
  return useQuery({ queryKey: ['automation', id, 'delegation'],
    queryFn: ({ signal }) => api!.getSidekickDelegates(id, signal), enabled: Boolean(api),
    refetchOnReconnect: true, refetchOnWindowFocus: true,
  });
}

export function SidekickDelegation({ id }: { id: string }): React.JSX.Element {
  const { api, session } = useCollaborationSession();
  const online = useOnline();
  const client = useQueryClient();
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const query = useSidekickDelegates(id);
  const refresh = async (): Promise<void> => {
    const result = await query.refetch();
    if (!result.error) setUncertain(false);
  };
  const act = async (userId: string, write: () => Promise<SidekickDelegationMutationResult>): Promise<void> => {
    if (!api || !navigator.onLine || uncertain || inFlight.current.has(userId)) return;
    inFlight.current.add(userId);
    setPending((current) => new Set([...current, userId]));
    setError(null);
    try {
      const result = await write();
      const queryKey = ['automation', id, 'delegation'];
      await client.cancelQueries({ queryKey });
      client.setQueryData<SidekickDelegatesResult>(queryKey, (current) => {
        if (!current) return current;
        const identity = current.delegates.find((delegate) => delegate.userId === userId)
          ?? (current.creator?.userId === userId ? current.creator : {
            userId: current.you.userId, displayName: session?.user.name ?? 'You',
            ...(session?.user.avatarUrl ? { avatarUrl: session.user.avatarUrl } : {}),
          });
        return { ...current,
          you: { ...current.you, allowed: current.you.userId === userId ? result.allowed : current.you.allowed },
          delegates: result.allowed
            ? [...current.delegates.filter((delegate) => delegate.userId !== userId), { ...identity, eligible: true }]
            : current.delegates.filter((delegate) => delegate.userId !== userId),
        };
      });
      void client.invalidateQueries({ queryKey });
    } catch (cause) {
      setUncertain(true);
      setError(cause instanceof Error ? cause : new Error('The delegation change could not be confirmed.'));
      // Only a response whose outcome is unknown requires reconciliation before
      // another change. An acknowledged mutation is already confirmed authority.
      const result = await query.refetch();
      setUncertain(Boolean(result.error));
    } finally {
      inFlight.current.delete(userId);
      setPending((current) => new Set([...current].filter((key) => key !== userId)));
      void client.invalidateQueries({ queryKey: ['automation', id], exact: true });
    }
  };
  return <>
    <SidekickDelegationList data={query.data} loading={query.isPending} offline={!online}
      needsRefresh={uncertain} pendingUserIds={pending}
      onRefresh={() => void refresh()}
      onSetOwn={(allowed) => {
        if (query.data) void act(query.data.you.userId, () => api!.setMySidekickDelegation(id, allowed, crypto.randomUUID()));
      }}
      onRemove={(userId) => void act(userId, () => api!.removeSidekickDelegate(id, userId, crypto.randomUUID()))} />
    {query.error && !uncertain && <Button disabledReason={!online ? 'Go online to refresh delegation.' : undefined}
      onClick={() => void refresh()}>Refresh delegation</Button>}
    {(error || query.error) && <ErrorNotice occurrence={error ?? query.error}>{(error ?? query.error)?.message}</ErrorNotice>}
  </>;
}
