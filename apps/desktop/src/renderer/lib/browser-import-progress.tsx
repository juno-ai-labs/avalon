import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { desktopBridge } from './platform';
import {
  addPendingWorkstream,
  confirmPendingWorkstream,
  discardPendingWorkstream,
  WORKSTREAMS_QUERY_KEY,
} from './workstreams-cache';

/**
 * The main window's half of an import made in the import window.
 *
 * The import window names the Channel's id before it sends the create. Here it
 * is listed as a pending row and opened, so the person sees the Channel they
 * asked for, as "Importing", while the history is written; a pending row opens
 * no socket and reads nothing, because its room refuses both until the create
 * answers. The success that follows confirms the row, and the deep link sent
 * after it lands on the route already open. A failure takes the row away and
 * goes back to where this window was, if it is still showing the import.
 */
export function BrowserImportProgress(): null {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const pathRef = useRef(location.pathname + location.search);
  pathRef.current = location.pathname + location.search;
  const returnTo = useRef(new Map<string, string>());

  useEffect(() => desktopBridge().onBrowserImportProgress((progress) => {
    const route = `/workstreams/${progress.workstreamId}`;
    if (progress.phase === 'importing') {
      const now = new Date().toISOString();
      addPendingWorkstream(queryClient, {
        id: progress.workstreamId,
        title: progress.title,
        spaceIds: [progress.spaceId],
        scope: 'personal',
        // An imported history starts no run; the client reads the server's idle as this.
        harnessStatus: 'completed',
        createdAt: now,
        origin: 'import',
      });
      if (pathRef.current !== route) {
        returnTo.current.set(progress.workstreamId, pathRef.current);
        void navigate(route);
      }
      return;
    }
    const previous = returnTo.current.get(progress.workstreamId);
    returnTo.current.delete(progress.workstreamId);
    if (progress.phase === 'imported') {
      confirmPendingWorkstream(queryClient, progress.workstreamId);
      void queryClient.invalidateQueries({ queryKey: WORKSTREAMS_QUERY_KEY });
      return;
    }
    discardPendingWorkstream(queryClient, progress.workstreamId);
    if (pathRef.current === route) void navigate(previous ?? '/', { replace: true });
  }), [navigate, queryClient]);

  return null;
}
