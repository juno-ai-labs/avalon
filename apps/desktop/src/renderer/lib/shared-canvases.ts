import type { SharedCanvas, WorkspaceSharedCanvasesEvent } from '@rally/contracts/canvas-share-federation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { RallyApi } from './api';
import { useSocketOwnedList } from './sidebar-list-store';

/*
 * Canvases shared with this person as a guest in their other Organizations,
 * as the organization socket pushes them (`workspace_shared_canvases`,
 * `docs/canvas-share-federation.md`). The server builds them by asking each
 * Canvas's own Organization; the client only draws them.
 */

/** A Canvas from another Organization, and the Organization it belongs to. */
export type OtherOrganizationCanvas = SharedCanvas;

export const SHARED_CANVASES_QUERY_KEY = ['shared-canvases'] as const;
/** The switch as last read or pushed; the socket's event writes it too, so another device's change shows here. */
export const SHARED_CANVASES_SETTING_QUERY_KEY = ['shared-canvases-setting'] as const;
const SETTING_QUERY_KEY = SHARED_CANVASES_SETTING_QUERY_KEY;
const NONE: OtherOrganizationCanvas[] = [];
/** The event's own bound on `items` (`WorkspaceSharedCanvasesEventSchema`). */
const LIST_LIMIT = 250;

/**
 * The list a push leaves on screen. It replaces the last one whole, except
 * for the Organizations it names `unavailable`: those could not answer this
 * build, so what was last shown from them stays until a complete build lands.
 */
export function applySharedCanvasesEvent(previous: WorkspaceSharedCanvasesEvent | undefined, event: WorkspaceSharedCanvasesEvent): WorkspaceSharedCanvasesEvent {
  if (event.unavailable.length === 0 || !previous) return event;
  const unavailable = new Set<string>(event.unavailable);
  const kept = previous.items.filter((item) => unavailable.has(item.organization.id));
  if (kept.length === 0) return event;
  const items = [...event.items, ...kept]
    .sort((a, b) => Date.parse(b.canvas.updatedAt) - Date.parse(a.canvas.updatedAt))
    .slice(0, LIST_LIMIT);
  return { ...event, items };
}

/** The last push, newest first; empty before it arrives and while the setting is off. */
export function useOtherOrganizationCanvases(): OtherOrganizationCanvas[] {
  return useSocketOwnedList<WorkspaceSharedCanvasesEvent>(SHARED_CANVASES_QUERY_KEY).data?.items ?? NONE;
}

/**
 * Settings › Account › Preferences' switch, stored on the server for the
 * person so it covers every Organization. The switch moves at once; a failed save puts it
 * back. The socket then pushes the list it now allows.
 */
export function useSharedCanvasesSetting(api: Pick<RallyApi, 'getSharedCanvasesSetting' | 'setSharedCanvasesSetting'> | null) {
  const queryClient = useQueryClient();
  const setting = useQuery({
    queryKey: SETTING_QUERY_KEY,
    queryFn: ({ signal }) => api!.getSharedCanvasesSetting(signal),
    enabled: api !== null,
  });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api!.setSharedCanvasesSetting(enabled),
    onMutate: async (enabled) => {
      // A read in flight would land over the switch's new position.
      await queryClient.cancelQueries({ queryKey: SETTING_QUERY_KEY });
      const previous = queryClient.getQueryData<{ enabled: boolean }>(SETTING_QUERY_KEY);
      queryClient.setQueryData(SETTING_QUERY_KEY, { enabled });
      // Off hides the rows at once rather than when the server's empty list lands.
      if (!enabled) {
        queryClient.setQueryData<WorkspaceSharedCanvasesEvent>(SHARED_CANVASES_QUERY_KEY,
          (list) => list && { ...list, enabled: false, items: [], unavailable: [] });
      }
      return { previous };
    },
    // Put the switch back only if nothing newer, such as a push, moved it since.
    onError: (_error, enabled, context) => {
      if (queryClient.getQueryData<{ enabled: boolean }>(SETTING_QUERY_KEY)?.enabled === enabled) {
        queryClient.setQueryData(SETTING_QUERY_KEY, context?.previous);
      }
    },
    onSuccess: (saved) => queryClient.setQueryData(SETTING_QUERY_KEY, saved),
  });
  return {
    enabled: setting.data?.enabled,
    loading: setting.data === undefined && !setting.isError,
    error: setting.data === undefined && setting.isError ? setting.error : null,
    retry: () => { void setting.refetch(); },
    save,
  };
}
