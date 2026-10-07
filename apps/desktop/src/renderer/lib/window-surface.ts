import { useCallback } from 'react';
import { useShellCapabilities } from './collaboration-session';

/**
 * Surfaces the Mac app opens in a window of their own: Settings, and the
 * Sidekicks library with each Sidekick's screen. A browser tab cannot open a
 * window it may keep, so there each is a route of the main window instead, and
 * the shell gives it the whole tab, as the window would have, rather than a
 * pane beside the sidebar. One list, so a surface added here is both.
 *
 * `/automations/:id` is a Sidekick's screen under its older name; links and
 * the sidebar's "run" still open it.
 */
export function isWindowSurfaceRoute(pathname: string): boolean {
  return pathname === '/settings'
    || pathname === '/sidekicks'
    || pathname.startsWith('/sidekicks/')
    || pathname.startsWith('/automations/');
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
