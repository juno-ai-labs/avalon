import type { SidekickActivityTarget } from '@rally/contracts';
import { skipToken, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useOptionalWorkspaceSocket } from './workspace-socket';

/** Counts are owned by the workspace socket; opening a composer registers its exact target. */
export function useSidekickActivity(target: SidekickActivityTarget | null): number | undefined {
  const watch = useOptionalWorkspaceSocket()?.watchSidekickActivity;
  const parentKind = target?.parentKind;
  const parentId = target?.parentId;
  const substreamId = target?.substreamId;
  useEffect(() => {
    if (watch && parentKind && parentId && substreamId) return watch({ parentKind, parentId, substreamId });
  }, [watch, parentKind, parentId, substreamId]);
  return useQuery({
    queryKey: ['sidekick-activity', parentKind, parentId, substreamId],
    queryFn: skipToken,
    select: (snapshot: { count: number; waterline: number }) => snapshot.count,
  }).data;
}
