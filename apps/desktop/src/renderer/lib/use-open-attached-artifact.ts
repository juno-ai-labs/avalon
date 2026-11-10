import type { WorkstreamResource } from '@rally/contracts';
import { useEffect, useRef } from 'react';

/** Follow newly attached artifacts; initial panel restoration belongs to the host. */
export function useOpenAttachedArtifact(
  conversationKey: string,
  resources: readonly Pick<WorkstreamResource, 'id' | 'direction'>[] | undefined,
  visible: boolean,
  open: (resourceId: string) => void,
  snapshotGeneration: number,
): void {
  const previous = useRef<{ key: string; generation: number; ids: Set<string> } | null>(null);
  useEffect(() => {
    if (previous.current?.key !== conversationKey || previous.current.generation !== snapshotGeneration) previous.current = null;
    // Undefined means the live conversation has not answered yet. A device
    // cache is not a baseline. A replacement snapshot is a new baseline, not
    // an attachment: retained data from a previous visit must not turn its
    // refresh into an automatic open over a saved panel or explicit link.
    if (!resources) return;
    const artifacts = resources.filter((resource) => resource.direction === 'artifact');
    const priorIds = previous.current?.ids;
    const added = priorIds
      ? artifacts.find((resource) => !priorIds.has(resource.id))
      : undefined;
    previous.current = { key: conversationKey, generation: snapshotGeneration, ids: new Set(artifacts.map((resource) => resource.id)) };
    // Resources arrive newest attachment first. Open once even if a render
    // batches several additions, and never steal the rail from a visible Chat.
    if (visible && added) open(added.id);
  }, [conversationKey, resources, visible, open, snapshotGeneration]);
}
