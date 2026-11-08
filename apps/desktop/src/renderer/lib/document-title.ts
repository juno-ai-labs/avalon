import { useEffect } from 'react';

/** What the window is called with nothing open that has a name of its own. */
export const APP_TITLE = 'Rally';

/** `Q4 revenue review · Rally`, or `Rally` for nothing named. */
export function documentTitle(name: string | undefined): string {
  return name ? `${name} · ${APP_TITLE}` : APP_TITLE;
}

/**
 * Name the window after what is open in it, for as long as it is open. The
 * document's title is the window's in both hosts: Electron's main window
 * follows `page-title-updated`, and the browser's tab reads it directly.
 */
export function useDocumentTitle(name: string | undefined): void {
  useEffect(() => {
    document.title = documentTitle(name);
  }, [name]);
  useEffect(() => () => { document.title = APP_TITLE; }, []);
}
