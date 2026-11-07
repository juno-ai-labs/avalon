import { useCallback } from 'react';
import { useShellCapabilities } from './collaboration-session';

/**
 * Surfaces the Mac app opens in a window of their own: Settings. A browser
 * tab cannot open a window it may keep, so there it is a route of the main
 * window instead, and the shell gives it the whole tab, as the window would
 * have, rather than a pane beside the sidebar.
 *
 * The Sidekicks library and each Sidekick's screen were here until they moved
 * into the main window (plan step A-13): they are panes beside the sidebar on
 * both hosts now, and the Mac app's separate Sidekicks window keeps its own
 * entry until it is removed.
 */
export function isWindowSurfaceRoute(pathname: string): boolean {
  return pathname === '/settings';
}

/**
 * Leave a window surface: close the window, or, in a browser tab where the
 * surface is a route, return to the workspace. The sidebar is still mounted
 * under the surface, so that return draws no loading state.
 */
export function useCloseWindowSurface(): () => void {
  const { host } = useShellCapabilities();
  return useCallback(() => {
    if (host === 'browser') window.location.hash = '#/';
    else window.close();
  }, [host]);
}
