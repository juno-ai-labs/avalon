/* global self, URL */
// Rally's service worker. It does one thing: show the Web Push notifications
// the API sends a signed-in member, and open the conversation on a click. It
// caches nothing and answers no requests.

function readMessage(data) {
  try { return data ? data.json() : null; } catch { return null; }
}

// The payload carries the canonical Channel link; open it on this host, which
// serves the same /app/... paths. Only the path and query are taken, set on
// this origin, so no link (not even a path starting "//") leaves the host.
function localUrl(canonical) {
  const local = new URL(self.location.origin);
  try {
    const target = new URL(canonical || "/", self.location.origin);
    local.pathname = target.pathname;
    local.search = target.search;
  } catch {
    // An unreadable link opens the app's root.
  }
  return local.href;
}

// The path a tab shows while in the notification's Organization, as the shell
// writes it: /app/workspaces/<region>/<workspaceId>.
function workspacePath(rally) {
  if (!rally || typeof rally.region !== "string" || typeof rally.workspaceId !== "string") return null;
  return `/app/workspaces/${encodeURIComponent(rally.region)}/${encodeURIComponent(rally.workspaceId)}`;
}

// Controls the tabs already open, so a click can navigate one of them.
self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  const message = readMessage(event.data);
  if (!message || typeof message.title !== "string") return;
  event.waitUntil(self.registration.showNotification(message.title, {
    body: typeof message.body === "string" ? message.body : "",
    tag: typeof message.tag === "string" ? message.tag : undefined,
    // Reply tags are reused after the server's batching/cooldown checks.
    renotify: message.rally?.kind === "new_message" && typeof message.tag === "string" && message.tag.length > 0,
    data: { url: localUrl(message.rally && message.rally.url), workspacePath: workspacePath(message.rally) },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = data.url || localUrl("/");
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const exact = windows.find((client) => client.url === url);
    if (exact) return exact.focus();
    // A tab already in the notification's Organization routes in place: the
    // page compares the link with its own Organization (`inPlaceHash` in
    // src/session.ts) and loads it instead when they differ.
    const path = (client) => new URL(client.url).pathname.replace(/\/$/u, "");
    const same = data.workspacePath && windows.find((client) => path(client) === data.workspacePath);
    if (same) {
      try {
        const focused = await same.focus();
        focused.postMessage({ type: "rally:open", url });
        return focused;
      } catch {
        // The tab closed since it was listed; fall through to the others.
      }
    }
    // Otherwise reuse a Rally tab on this host: loading the link switches it
    // to the link's Organization.
    const app = windows.find((client) => path(client).startsWith("/app/"));
    if (app) {
      try {
        const focused = await app.focus();
        return await focused.navigate(url);
      } catch {
        // An uncontrolled tab cannot be navigated from here; open a new one.
      }
    }
    return self.clients.openWindow(url);
  })());
});
