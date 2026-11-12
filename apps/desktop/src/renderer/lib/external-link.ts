import { desktopBridge, desktopServicesAvailable } from './platform';

/** Reserve a browser tab during the click, before an async URL request loses user activation. */
export function prepareExternalLink() {
  const desktop = desktopServicesAvailable();
  const tab = desktop ? null : window.open('', '_blank');
  if (!desktop && !tab) {
    throw new Error('Allow pop-ups for Rally in this browser, then try again.');
  }
  if (tab) tab.opener = null;
  let pending = true;
  return {
    async open(url: string) {
      if (!pending) return;
      if (tab) {
        if (tab.closed) throw new Error('The new tab was closed. Please try again.');
        tab.location.href = url;
      } else {
        await desktopBridge().openExternal(url);
      }
      pending = false;
    },
    cancel() {
      if (pending) tab?.close();
      pending = false;
    },
  };
}
