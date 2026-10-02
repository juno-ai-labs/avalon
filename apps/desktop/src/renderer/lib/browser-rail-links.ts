import { useEffect } from 'react';
import { desktopBridge } from './platform';
import { useUiStore } from './ui-store';

/**
 * Where a clicked web link goes. On the desktop, while a Channel is on screen,
 * an http or https link opens as a tab in the right-rail browser. Anything else
 * takes the `openExternal` path it took before, and main's allowlist there,
 * which admits only web URLs, still decides whether it opens.
 *
 * A Channel's conversation surface registers itself as the host while mounted
 * (`useBrowserRailLinks`); a Sidekick's, which shares the component, does not.
 */
type BrowserRailHost = (url: string) => void;

/**
 * Every mounted host, newest last. A Channel and its open Breakout are two
 * conversations on screen at once, and a link belongs to the one it was
 * clicked in: each host names the element it covers, and a link with no such
 * element — a menu portalled out of both panes — goes to the newest.
 */
const hosts: { open: BrowserRailHost; element: () => Element | null }[] = [];

export function registerBrowserRailHost(next: BrowserRailHost, element: () => Element | null = () => null): () => void {
  const entry = { open: next, element };
  hosts.push(entry);
  return () => {
    const index = hosts.indexOf(entry);
    if (index >= 0) hosts.splice(index, 1);
  };
}

function hostFor(origin: EventTarget | null | undefined): BrowserRailHost | null {
  const node = origin instanceof Node ? origin : null;
  const containing = node ? hosts.find((candidate) => candidate.element()?.contains(node)) : undefined;
  return (containing ?? hosts[hosts.length - 1])?.open ?? null;
}

function webUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Opens `url` in the browser rail when one is on screen, else through
 * `openExternal`. `origin` is what was clicked, which picks the pane's rail.
 */
export function openLink(url: string, origin?: EventTarget | null): Promise<void> {
  const web = webUrl(url);
  const host = hostFor(origin);
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
    void openLink(web, anchor);
  };
  root.addEventListener('click', onClick);
  root.addEventListener('auxclick', onClick);
  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('auxclick', onClick);
  };
}

/**
 * Makes the mounted screen the rail host while `enabled`, on the desktop only:
 * the web host has no local browser and keeps opening new tabs.
 */
export function useBrowserRailLinks(
  enabled: boolean,
  element: () => Element | null = () => null,
  claimRail: () => void = () => undefined,
): void {
  useEffect(() => {
    if (!enabled || !window.rally) return;
    const unregister = registerBrowserRailHost((url) => {
      claimRail();
      const ui = useUiStore.getState();
      ui.setRailWidth(Math.max(ui.railWidth, 600));
      ui.openRail('browser');
      // A page that fails to load says so in its own tab.
      void desktopBridge().commandEmbeddedBrowser({ action: 'open', url }).catch(() => undefined);
    }, element);
    // One document listener however many hosts are mounted, so a click is
    // routed once rather than once per conversation on screen.
    if (linkCaptureCount++ === 0) releaseLinkCapture = captureLinkClicks(document);
    return () => {
      if (--linkCaptureCount === 0) {
        releaseLinkCapture?.();
        releaseLinkCapture = null;
      }
      unregister();
    };
  }, [claimRail, element, enabled]);
}

let linkCaptureCount = 0;
let releaseLinkCapture: (() => void) | null = null;
