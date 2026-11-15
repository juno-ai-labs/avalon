import type { MobileSnapshot } from './protocol';

/** Whether Home's native dashboard covers its page. It shows from the saved
 * directory before the page answers, and whenever the page is on its own
 * dashboard; never over an inline chat, or while a tapped canvas or the create
 * flow is opening in the page. */
export function dashboardVisible({ home, chatOpen, opening, snapshot, hasDirectory }: {
  home: boolean; chatOpen: boolean; opening: boolean; snapshot: Pick<MobileSnapshot, 'view'> | null; hasDirectory: boolean;
}): boolean {
  if (!home || chatOpen || opening) return false;
  return snapshot ? snapshot.view === 'home' : hasDirectory;
}
