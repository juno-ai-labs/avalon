import type { CanvasDetail } from '@rally/contracts/canvases';
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAppSession } from '../../desktop/src/renderer/lib/app-session';
import { canvasDetailQueryKey, useCanvasList } from '../../desktop/src/renderer/lib/canvases';
import { useWorkspaceSocket } from '../../desktop/src/renderer/lib/workspace-socket';

/** One owner invalidates detail queries, even when a pin and its view both observe them. */
export function useMobileCanvasUpdates() {
  const queryClient = useQueryClient();
  const rows = useCanvasList();
  const { sidebarConnect } = useWorkspaceSocket();
  const previous = useRef<{ rows: Map<string, string>; generation: number | undefined } | null>(null);
  useEffect(() => {
    if (!rows) return;
    const next = new Map<string, string>(rows.map(row => [row.id, `${row.updatedAt}:${row.artifactKind}:${row.title}:${row.visibility}`]));
    const before = previous.current;
    previous.current = { rows: next, generation: sidebarConnect?.generation };
    // A reconnect can cover missed events, including deletion or revoked access.
    if (before?.generation !== undefined && before.generation !== sidebarConnect?.generation) {
      void queryClient.invalidateQueries({ queryKey: ['canvas'] });
    } else if (!before) {
      // A deep link can read its detail before the first directory arrives.
      for (const row of rows) {
        const detail = queryClient.getQueryData<CanvasDetail>(canvasDetailQueryKey(row.id));
        if (detail && (detail.updatedAt !== row.updatedAt || Boolean(detail.artifacts.length) !== Boolean(row.artifactKind))) {
          void queryClient.invalidateQueries({ queryKey: canvasDetailQueryKey(row.id) });
        }
      }
    } else if (before) {
      for (const [id, revision] of before.rows) {
        if (next.get(id) !== revision) void queryClient.invalidateQueries({ queryKey: canvasDetailQueryKey(id) });
      }
    }
  }, [queryClient, rows, sidebarConnect?.generation]);
}

/** Publication rows discover new artifacts; resource heads advance existing versions. */
export function useMobileCanvasDetail(id: string, active = true) {
  const { api } = useAppSession();
  return useQuery({ queryKey: canvasDetailQueryKey(id), queryFn: ({ signal }) => api!.getCanvas(id, signal), enabled: Boolean(api && active), staleTime: Infinity });
}
