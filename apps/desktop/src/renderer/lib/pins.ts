import type { PinKind, PinList } from '@rally/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { ApiError, type RallyApi } from './api';
import { fetchThroughOwner } from './fetch-through-owner';
import { reportTelemetryProductIntent, telemetryVisibility } from './telemetry';
import type { WorkstreamSummary } from './types';
import { MY_THREADS_QUERY_KEY, PINS_QUERY_KEY } from './sidebar-list-store';

/**
 * This person's pins, as one list for every surface that shows or acts on
 * them: the sidebar's Pinned sections, the title menus, the landing, and the
 * socket pool that keeps pinned threads connected. `workspace_pins` is the
 * one source; the list arrives on the per-person snapshot and in each write's
 * answer, so nothing here fetches it (`docs/workstream-pinning.md`).
 */
export function usePins(): PinList {
  return useQuery<PinList>({ queryKey: PINS_QUERY_KEY, queryFn: fetchThroughOwner, enabled: false }).data ?? [];
}

/** The ids pinned under one kind. */
export function usePinnedIds(kind: PinKind): ReadonlySet<string> {
  const pins = usePins();
  return useMemo(() => new Set(pins.flatMap((pin) => pin.kind === kind ? [pin.id] : [])), [kind, pins]);
}

export const PIN_FAILURE_QUERY_KEY = ['navigation', 'pin-failure'] as const;

function pinFailureCopy(error: unknown): string {
  return error instanceof ApiError && error.code === 'pin_limit_reached'
    ? 'You’ve pinned as many items as Rally allows. Unpin one first.'
    : 'That pin didn’t save. Try again.';
}

/** Why the last pin write failed, until a later one succeeds. */
export function usePinFailure(): string | null {
  return useQuery<string | null>({ queryKey: PIN_FAILURE_QUERY_KEY, queryFn: () => null, enabled: false }).data ?? null;
}

/** How many pin writes this window has started; only the newest one's answer is held. */
let pinWritesStarted = 0;

/**
 * Hold a pin write's answer, or say why it failed. Each answer is the whole
 * list, and two writes in flight can answer in either order, so an answer is
 * held only when no later write has started; the later one's answer, or the
 * snapshot every write republishes, carries what the older one would have.
 * A failure is shown on the same terms, so an older failure never covers a
 * newer success.
 */
export function usePinWrite(): (write: Promise<PinList>) => void {
  const queryClient = useQueryClient();
  return (write) => {
    const issued = ++pinWritesStarted;
    void write.then((list) => {
      if (issued !== pinWritesStarted) return;
      queryClient.setQueryData(PINS_QUERY_KEY, list);
      queryClient.setQueryData(PIN_FAILURE_QUERY_KEY, null);
      // A pin can add a thread this person does not take part in, which only
      // the Threads list's own read brings.
      void queryClient.invalidateQueries({ queryKey: MY_THREADS_QUERY_KEY });
    }, (error: unknown) => {
      if (issued !== pinWritesStarted) return;
      queryClient.setQueryData(PIN_FAILURE_QUERY_KEY, pinFailureCopy(error));
    });
  };
}

/** The fields `workstream_action_completed` reports for a thread. */
export type PinnedThread = Pick<WorkstreamSummary, 'id' | 'scope' | 'systemKind'>;

/**
 * Report a saved thread pin or unpin. Only threads: the event is about work
 * streams, and a breakout or a Channel is not one.
 */
export function reportThreadPin(thread: PinnedThread, pinned: boolean): void {
  reportTelemetryProductIntent({
    kind: 'workstream_action_completed',
    workstreamId: thread.id,
    action: pinned ? 'pin' : 'unpin',
    visibility: telemetryVisibility(thread.scope),
    origin: thread.systemKind ? 'system' : 'ad_hoc',
    pinned,
  });
}

/**
 * Pin or unpin, answered with the whole list, which replaces what is held.
 * The caller passes its API client, because the thread screen reads its
 * session from the collaboration context rather than the app session. A
 * thread pin passes the thread, and is reported once it saves.
 */
export function usePinAction(api: RallyApi | null): (kind: PinKind, id: string, pinned: boolean, parentId?: string, thread?: PinnedThread) => void {
  const write = usePinWrite();
  return (kind, id, pinned, parentId, thread) => {
    if (!api) return;
    write(api.setPinned(kind, id, pinned, parentId).then((list) => {
      if (kind === 'thread' && thread) reportThreadPin(thread, pinned);
      return list;
    }));
  };
}
