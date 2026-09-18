/* global WebSocketPair */
// A real Worker that exposes transport input; product authorization is covered
// against the actual API and migrations in api/test/browser-sessions.test.ts.
export default {
  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener("message", (event) => pair[1].send(JSON.stringify({
        message: event.data, path: new URL(request.url).pathname,
        cookie: request.headers.get("cookie"), authorization: request.headers.get("authorization"),
        origin: request.headers.get("origin"), protocols: request.headers.get("sec-websocket-protocol"),
      })));
      return new Response(null, { status: 101, webSocket: pair[0], headers: { "Sec-WebSocket-Protocol": "rally.ticket.v1" } });
    }
    return Response.json({ url: request.url, method: request.method,
      cookie: request.headers.get("cookie"), origin: request.headers.get("origin"),
      body: await request.text() }, { headers: {
      "Set-Cookie": "__Host-rally-browser-global=opaque; Secure; HttpOnly; Path=/; SameSite=Lax",
      "Cache-Control": "no-store",
    } });
  },
};
