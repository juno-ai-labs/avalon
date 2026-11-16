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
const SETTING_QUERY_KEY = ['shared-canvases-setting'] as const;
const NONE: OtherOrganizationCanvas[] = [];

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
    onMutate: (enabled) => {
      const previous = queryClient.getQueryData(SETTING_QUERY_KEY);
      queryClient.setQueryData(SETTING_QUERY_KEY, { enabled });
      return { previous };
    },
    onError: (_error, _enabled, context) => queryClient.setQueryData(SETTING_QUERY_KEY, context?.previous),
    onSuccess: (saved) => queryClient.setQueryData(SETTING_QUERY_KEY, saved),
  });
  return { enabled: setting.data?.enabled, loading: setting.data === undefined, save };
}
