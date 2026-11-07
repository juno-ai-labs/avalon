import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { logWarn } from '../../common/logger';
import { ApiError } from './api';

/**
 * Where Rally opens, and where a screen leaves for when what it was showing is
 * no longer there to show (a deleted Sidekick, a Canvas the viewer lost): the
 * Canvases home.
 */
export const LANDING_ROUTE = '/canvases';

/**
 * Whether a route saved as `last-route` may be reopened at launch: a Canvas or
 * a Sidekick by its id, or either home. Anything else opens the landing
 * instead: a Channel or Thread route saved before the 2026-11 cutover, and
 * `/sidekicks/new`, whose screen creates a Sidekick as it mounts, so reopening
 * it would make one on every launch.
 */
export function restorableRoute(saved: string | null): string | null {
  if (!saved) return null;
  return /^\/(canvases|sidekicks)(\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i.test(saved) ? saved : null;
}

/**
 * The `location.state` the landing opens a restored route with. It is what
 * tells the screen that nobody clicked this: the address came from storage on
 * this device, so an object that is gone is stale state, not news.
 */
export const RESTORED_ROUTE = { restoredRoute: true } as const;

function isRestoredRoute(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'restoredRoute' in state && state.restoredRoute === true;
}

/**
 * On a route the landing restored, an object that answers not found sends the
 * screen to its section home, replacing the entry, with one named log line and
 * no dialog: the Sidekick or Canvas was deleted, or the stored route came from
 * an earlier database, and the person never asked for it. A route someone
 * opened deliberately keeps the screen's error, because that one is news.
 * Returns true while leaving, so the screen draws nothing of its own.
 */
export function useRestoredRouteFallback(error: unknown, home: '/canvases' | '/sidekicks'): boolean {
  const location = useLocation();
  const navigate = useNavigate();
  const leaving = isRestoredRoute(location.state) && error instanceof ApiError && error.status === 404;
  useEffect(() => {
    if (!leaving) return;
    logWarn('rally', 'restored_route_not_found', { route: location.pathname, home, code: (error as ApiError).code });
    void navigate(home, { replace: true });
  }, [error, home, leaving, location.pathname, navigate]);
  return leaving;
}

/** Leave for the landing. Replaces, so Back cannot return to a screen the API no longer serves. */
export function useOpenLanding(): () => void {
  const navigate = useNavigate();
  return useCallback(() => { void navigate(LANDING_ROUTE, { replace: true }); }, [navigate]);
}
