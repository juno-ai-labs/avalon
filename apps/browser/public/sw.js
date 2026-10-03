/* global self, URL */
// Rally's service worker. It does one thing: show the Web Push notifications
// the API sends a signed-in member, and open the conversation on a click. It
// caches nothing and answers no requests.

function readMessage(data) {
  try { return data ? data.json() : null; } catch { return null; }
}

// The payload carries the canonical Channel link; open it on this host, which
// serves the same /app/... paths.
function localUrl(canonical) {
  try {
    const target = new URL(canonical || "/", self.location.origin);
    return new URL(target.pathname + target.search, self.location.origin).href;
  } catch {
    return new URL("/", self.location.origin).href;
  }
}

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
    const open = windows.find((client) => client.url === url);
    if (open) return open.focus();
    return self.clients.openWindow(url);
  })());
});
