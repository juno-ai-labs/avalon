import { useLayoutEffect } from 'react';
import { useNavigate, type NavigateFunction } from 'react-router-dom';

let activeNavigate: NavigateFunction | null = null;

/** Route session and IPC actions through the mounted main-window router. */
export function navigateAppRoute(path: string, state?: unknown): void {
  // Hash assignment did not add a visit when the destination was already open.
  if (window.location.hash === `#${path}` && state === undefined) return;
  if (activeNavigate) void activeNavigate(path, state === undefined ? undefined : { state });
  // Before sign-in there is no router yet. Its first mount indexes this route.
  else window.location.hash = path;
}

/** Kept above the shell so deep links also work while the organization loads. */
export function AppRouteNavigation(): null {
  const navigate = useNavigate();
  useLayoutEffect(() => {
    activeNavigate = navigate;
    return () => {
      if (activeNavigate === navigate) activeNavigate = null;
    };
  }, [navigate]);
  return null;
}
