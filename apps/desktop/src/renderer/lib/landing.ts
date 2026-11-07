import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Where Rally opens, and where a screen leaves for when what it was showing is
 * no longer there to show (a deleted Sidekick, a Canvas the viewer lost): the
 * Canvases home.
 */
export const LANDING_ROUTE = '/canvases';

/**
 * Whether a route saved as `last-route` may be reopened at launch: a Canvas or
 * a Sidekick, or either home. Anything else, including a Channel or Thread
 * route saved before the 2026-11 cutover, opens the landing instead.
 */
export function restorableRoute(saved: string | null): string | null {
  if (!saved) return null;
  return /^\/(canvases|sidekicks)(\/[^/?#]+)?$/.test(saved) ? saved : null;
}

/** Leave for the landing. Replaces, so Back cannot return to a screen the API no longer serves. */
export function useOpenLanding(): () => void {
  const navigate = useNavigate();
  return useCallback(() => { void navigate(LANDING_ROUTE, { replace: true }); }, [navigate]);
}
