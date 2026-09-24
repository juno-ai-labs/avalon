import { desktopBridge } from './platform';

/**
 * Where a clicked web link goes. On the desktop, while a Channel is on screen,
 * an http or https link opens as a tab in the right-rail browser; anywhere else,
 * and for every other scheme, it goes to the system browser as before.
 *
 * The conversation surface registers itself as the host while mounted, since it
 * is the only screen that draws the browser rail.
 */
type BrowserRailHost = (url: string) => void;

let host: BrowserRailHost | null = null;

export function registerBrowserRailHost(next: BrowserRailHost): () => void {
  host = next;
  return () => {
    if (host === next) host = null;
  };
}

function webUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Opens `url` in the browser rail when one is on screen, else externally. */
export function openLink(url: string): Promise<void> {
  const web = webUrl(url);
  if (web && host) {
    host(web);
    return Promise.resolve();
  }
  return desktopBridge().openExternal(url);
}

/**
 * Routes clicks on anchors that leave Rally through `openLink`. Listens in the
 * bubble phase so a component that handles its own click, and prevents the
 * default, keeps it. A same-origin anchor is Rally's own route and is left alone.
 */
export function captureLinkClicks(root: Document): () => void {
  const onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || (event.type === 'auxclick' && event.button !== 1)) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) return;
    const web = webUrl(anchor.href);
    if (!web || new URL(web).origin === root.location.origin) return;
    event.preventDefault();
    void openLink(web);
  };
  root.addEventListener('click', onClick);
  root.addEventListener('auxclick', onClick);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('auxclick', onClick);
  };
}
