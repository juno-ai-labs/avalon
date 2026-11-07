import type { MemoryReview, MemoryReviewSource } from '@rally/contracts';
import { MemoryFactRows, type MemoryFactRemoval, type MemoryFactsState } from '@rally/ui/components/memory-fact-rows';
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../lib/api';
import { canvasRoute, CANVASES_ROUTE } from '../lib/canvases';
import { desktopBridge } from '../lib/platform';
import { ErrorNotice, LoadingState } from './primitives';

/** One scope's facts, with `onOpen` for a host that reads them only once they are asked for. */
export interface MemoryFacts extends MemoryFactsState {
  onOpen: () => void;
}

/**
 * Reads one scope's remembered facts and removes one: the person's own or the
 * Organization's. Every review surface goes through this, so a removal behaves
 * the same everywhere: the row leaves the cache on success, a 404 is treated as
 * already removed (by another window, or by the agent), and any other refusal
 * stays on its row. Each fact keeps its own removal state, so removing two at
 * once reports each.
 *
 * Every open reads afresh, so what a person sees is what the store holds when
 * they look; the cached list shows meanwhile. `lazy` holds the first read
 * until `onOpen`, for a title-menu level the person may never open, and each
 * later `onOpen` reads again. Nothing polls.
 */
export function useMemoryFacts({ enabled = true, forget, lazy = false, queryKey, read }: {
  enabled?: boolean;
  forget: (factId: string) => Promise<unknown>;
  lazy?: boolean;
  queryKey: QueryKey;
  read: (signal: AbortSignal) => Promise<MemoryReview>;
}): MemoryFacts {
  const queryClient = useQueryClient();
  // Which scope was asked for: moving to another conversation does not read
  // that one's facts until its level opens.
  const scope = JSON.stringify(queryKey);
  const [openedScope, setOpenedScope] = useState<string | null>(null);
  const review = useQuery({
    queryKey,
    queryFn: ({ signal }) => read(signal),
    enabled: enabled && (!lazy || openedScope === scope),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const [removals, setRemovals] = useState<Record<string, MemoryFactRemoval>>({});
  const settle = (factId: string, removal: MemoryFactRemoval | null): void => setRemovals((current) => {
    const next = { ...current };
    if (removal) next[factId] = removal;
    else delete next[factId];
    return next;
  });
  // Off the scope the removal was asked in, should the host have moved on. A
  // read still in flight would land after this and bring the row back, so it
  // is cancelled first.
  const dropFact = async (key: QueryKey, factId: string): Promise<void> => {
    await queryClient.cancelQueries({ queryKey: key, exact: true });
    queryClient.setQueryData<MemoryReview>(key, (current) => current && { facts: current.facts.filter((fact) => fact.factId !== factId) });
  };
  const remove = async (factId: string): Promise<void> => {
    const key = queryKey;
    settle(factId, { pending: true });
    try {
      await forget(factId);
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'memory_fact_not_found')) {
        settle(factId, { pending: false, refusal: refusalCopy(error) });
        return;
      }
    }
    await dropFact(key, factId);
    settle(factId, null);
  };
  return {
    facts: review.data?.facts,
    failure: review.data === undefined && review.error ? 'What Rally remembers couldn’t be loaded.' : undefined,
    onRemove: (factId) => { void remove(factId); },
    removals,
    onOpen: () => {
      if (openedScope === scope) void review.refetch();
      else setOpenedScope(scope);
    },
  };
}

function refusalCopy(error: unknown): string {
  if (error instanceof ApiError && error.code === 'memory_fact_not_removable') return 'You can’t remove this.';
  return error instanceof ApiError ? error.message : 'Rally could not remove this. Try again.';
}

/**
 * Where a fact's source opens in the main window. A Canvas's facts are stored
 * under the `thread` subject kind until the memory rebuild (plan step C-5), so
 * a thread or breakout source is a Canvas; a Channel has no screen any more and
 * opens the Canvases home.
 */
export function memorySourceRoute(source: MemoryReviewSource): string {
  if (source.kind === 'sidekick') return `/sidekicks/${encodeURIComponent(source.automationId)}`;
  if (source.kind === 'thread' || source.kind === 'breakout') return canvasRoute(source.workstreamId);
  return CANVASES_ROUTE;
}

/** Opens a fact's source from the main window, by its route. */
export function openMemorySource(source: MemoryReviewSource, navigate: (to: string) => void): void {
  navigate(memorySourceRoute(source));
}

/**
 * Opens a fact's source from a window surface such as Settings, which cannot
 * route the main window itself: a Sidekick through the bridge. A Canvas has no
 * such hand-off until it has a link form (plan step B-5), and a Channel none at
 * all, so both are named without a link.
 */
function SurfaceSourceLink({ source, title }: { source: MemoryReviewSource; title: string }): React.JSX.Element {
  if (source.kind !== 'sidekick') return <span>{title}</span>;
  return <button className="memory-review-source" onClick={() => void desktopBridge().openSidekick(source.automationId)} type="button">{title}</button>;
}

/**
 * One scope's remembered facts on a settings page: the rows, or why there are
 * none. The caller heads it and decides the scope.
 */
export function MemoryFactList({ emptyCopy, label, ...state }: MemoryFactsState & {
  emptyCopy: string;
  /** The list's accessible name, e.g. the heading above it. */
  label: string;
}): React.JSX.Element {
  const { facts, failure } = state;
  return <section aria-label={label} className="memory-review">
    {facts === undefined
      ? failure ? <ErrorNotice>{failure}</ErrorNotice> : <LoadingState label="Loading what Rally remembers…" />
      : facts.length === 0
        ? <p className="memory-review-empty">{emptyCopy}</p>
        : <MemoryFactRows
          facts={facts}
          onRemove={state.onRemove}
          removals={state.removals}
          renderSource={(source, title) => <SurfaceSourceLink source={source} title={title} />}
        />}
  </section>;
}
