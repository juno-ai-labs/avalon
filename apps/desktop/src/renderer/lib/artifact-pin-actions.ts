import type { CitationContext } from '../components/markdown-citations';
import type { ResourceAction } from '../components/resource-action-menu';
import type { WorkstreamResource } from './types';

type ResourceActions = NonNullable<CitationContext['actions']>;

/**
 * **Pin** or **Unpin** on the artifacts generated in a thread's Main.
 *
 * `threadResources` is Main's resource list: the server checks a pin against
 * the same links, so only what Main holds as an artifact is offered. In a
 * breakout that is what was attached to its thread; the breakout's own
 * artifacts are not projected where a pin is checked
 * (`docs/workstream-pinning.md`).
 */
export function artifactPinActions({ pinnedIds, setPinned, threadId, threadResources }: {
  pinnedIds: ReadonlySet<string>;
  setPinned: (resourceId: string, pinned: boolean, threadId: string) => void;
  threadId: string;
  threadResources: readonly Pick<WorkstreamResource, 'id' | 'direction'>[];
}): ResourceActions {
  const artifacts = new Set(threadResources
    .filter((resource) => resource.direction === 'artifact')
    .map((resource) => resource.id));
  return (resourceId) => {
    if (!artifacts.has(resourceId)) return undefined;
    const pinned = pinnedIds.has(resourceId);
    return [{
      id: 'pin',
      label: pinned ? 'Unpin' : 'Pin',
      icon: pinned ? 'unpin' : 'pin',
      onSelect: () => setPinned(resourceId, !pinned, threadId),
    }];
  };
}

/** Several hosts' actions for one resource, in order; none when no host offers any. */
export function combineResourceActions(...sources: readonly (ResourceActions | undefined)[]): ResourceActions | undefined {
  const present = sources.filter((source): source is ResourceActions => source !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return (resourceId) => {
    const actions: ResourceAction[] = present.flatMap((source) => source(resourceId) ?? []);
    return actions.length === 0 ? undefined : actions;
  };
}
