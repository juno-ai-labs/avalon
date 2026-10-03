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
    data: { url: localUrl(message.rally && message.rally.url) },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || localUrl("/");
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const exact = windows.find((client) => client.url === url);
    if (exact) return exact.focus();
    // Reuse a Rally tab on this host rather than opening another.
    const app = windows.find((client) => new URL(client.url).pathname.startsWith("/app/"));
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
