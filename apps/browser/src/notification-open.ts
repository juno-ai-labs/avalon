import { inPlaceHash } from "./session";

// Whether the shell is mounted and so routes a hash change. Until then (the
// session restoring, the shell downloading, the sign-in screen) a link loads.
let shellMounted = false;

export function setShellMounted(mounted: boolean): void {
  shellMounted = mounted;
}

/**
 * Opens a notification click the service worker posts to this tab
 * (`public/sw.js`). Installed when the page's first script runs: the worker's
 * message waits in the client's queue until the document has loaded, so no
 * state of the page drops it. A link in this tab's Organization routes in
 * place once the shell is up; anything else loads the link, which switches
 * to its Organization.
 */
export function installNotificationOpen(): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent<unknown>) => {
    const data = event.data;
    if (!data || typeof data !== "object" || !("type" in data) || data.type !== "rally:open"
      || !("url" in data) || typeof data.url !== "string") return;
    const hash = shellMounted ? inPlaceHash(location.pathname, data.url) : null;
    if (hash) location.hash = hash;
    else location.assign(data.url);
  });
}
