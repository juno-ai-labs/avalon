import { isConfiguredRegion, regionConfiguration } from "@rally/contracts/regions";

const unavailable = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const regional = /^\/regional\/([^/]+)(\/.*)$/u.exec(url.pathname);
    if (regional) {
      const region = regional[1]!;
      const path = regional[2]!;
      if (!isConfiguredRegion(region) || region !== "global") return unavailable();
      const socket = path.startsWith("/socket/");
      if (!path.startsWith("/browser/") && !socket) return unavailable();
      if (socket && (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")) return unavailable();
      if (socket && request.headers.get("Origin") !== url.origin) return new Response("Origin required", { status: 403 });
      // This is a configured service binding, never a client-chosen proxy host.
      const upstream = new URL(regionConfiguration(region).apiUrl);
      upstream.pathname = path;
      upstream.search = url.search;
      const forwarded = new Request(upstream, request);
      if (socket) {
        // The API consumes the single-use ticket in Sec-WebSocket-Protocol.
        // Forward the upgrade itself, without creating a frame relay or
        // interpreting browser cookies as socket authorization.
        forwarded.headers.delete("Cookie");
        forwarded.headers.delete("Authorization");
      }
      const upstreamResponse = await env.GLOBAL_API.fetch(forwarded);
      if (socket) return upstreamResponse;
      // Resource bytes can also be opened as a document on this cookie origin.
      // Sandbox that document without altering streamed XHR/blob consumers.
      const response = new Response(upstreamResponse.body, upstreamResponse);
      response.headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
      response.headers.set("X-Content-Type-Options", "nosniff");
      return response;
    }
    if (url.pathname.startsWith("/assets/")) return env.ASSETS.fetch(request);
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    if (!(url.pathname === "/" || url.pathname === "/login/email" || url.pathname === "/invite" || url.pathname.startsWith("/app/"))) return unavailable();
    const index = new URL("/index.html", url.origin);
    const asset = await env.ASSETS.fetch(new Request(index));
    if (!asset.ok) return new Response("Rally is temporarily unavailable", { status: 503 });
    const response = new Response(asset.body, asset);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Content-Type-Options", "nosniff");
    const socketOrigin = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
    // Shared dialogs inject scroll-lock CSS and components use dynamic styles,
    // matching the desktop renderer's style policy. Scripts remain self-only.
    response.headers.set("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' blob:; connect-src 'self' ${socketOrigin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    return response;
  },
} satisfies ExportedHandler<Cloudflare.Env>;
