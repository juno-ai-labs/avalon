import { isConfiguredRegion, regionConfiguration } from "@rally/contracts/regions";

/** The service binding for a deployment, `<bindingPrefix>_API`, when this Worker has one. */
function regionalApi(env: object, bindingPrefix: string): Fetcher | null {
  const binding: unknown = Reflect.get(env, `${bindingPrefix}_API`);
  return typeof binding === "object" && binding !== null && "fetch" in binding && typeof binding.fetch === "function" ? binding as Fetcher : null;
}

/**
 * Only this deployment's cookies, so a request to one deployment never carries
 * another's session: `rally-browser-<region>` (with `__Host-` on https) and the
 * Google state cookies named after it.
 */
function deploymentCookies(header: string | null, region: string): string | null {
  if (!header) return null;
  const kept = header.split(";").map((part) => part.trim()).filter((part) => {
    const name = part.split("=", 1)[0]!.replace(/^__Host-/u, "");
    return name === `rally-browser-${region}` || name.startsWith(`rally-browser-${region}-google-`);
  });
  return kept.length > 0 ? kept.join("; ") : null;
}

/** The favicon, install manifest and icons, which a browser reads from the root. */
const INSTALL_FILES = new Set(["/favicon.svg", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"]);

const unavailable = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const regional = /^\/regional\/([^/]+)(\/.*)$/u.exec(url.pathname);
    if (regional) {
      const region = regional[1]!;
      const path = regional[2]!;
      if (!isConfiguredRegion(region)) return unavailable();
      // One service binding per deployment, named from config/regions.json. A
      // configured region whose binding this Worker lacks is not reachable yet.
      const api = regionalApi(env, regionConfiguration(region).bindingPrefix);
      if (!api) return unavailable();
      const socket = path.startsWith("/socket/");
      if (!path.startsWith("/browser/") && !socket) return unavailable();
      if (socket && (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket")) return unavailable();
      if (socket && request.headers.get("Origin") !== url.origin) return new Response("Origin required", { status: 403 });
      // This is a configured service binding, never a client-chosen proxy host.
      const upstream = new URL(regionConfiguration(region).apiUrl);
      upstream.pathname = path;
      upstream.search = url.search;
      const forwarded = new Request(upstream, request);
      const cookies = deploymentCookies(request.headers.get("Cookie"), region);
      forwarded.headers.delete("Cookie");
      forwarded.headers.delete("Authorization");
      // The API consumes a socket's single-use ticket in Sec-WebSocket-Protocol,
      // so the upgrade carries no cookie. HTTP carries this deployment's only.
      if (!socket && cookies) forwarded.headers.set("Cookie", cookies);
      const upstreamResponse = await api.fetch(forwarded);
      if (socket) return upstreamResponse;
      // Resource bytes can also be opened as a document on this cookie origin.
      // Sandbox that document without altering streamed XHR/blob consumers.
      const response = new Response(upstreamResponse.body, upstreamResponse);
      response.headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
      response.headers.set("X-Content-Type-Options", "nosniff");
      return response;
    }
    if (url.pathname.startsWith("/assets/") || INSTALL_FILES.has(url.pathname)) return env.ASSETS.fetch(request);
    if (url.pathname === "/annotation-frame.js") {
      // The annotation script an HTML file's opaque preview frame loads from
      // this origin under its nonce. Revalidated on every check so a deploy
      // reaches open tabs, and never sniffed into something else.
      const script = await env.ASSETS.fetch(request);
      const response = new Response(script.body, script);
      response.headers.set("Cache-Control", "no-cache");
      response.headers.set("X-Content-Type-Options", "nosniff");
      return response;
    }
    if (url.pathname === "/sw.js") {
      // The push service worker, served from the root so its scope covers /app/.
      // Revalidated on every check so a deploy reaches open browsers.
      const worker = await env.ASSETS.fetch(request);
      const response = new Response(worker.body, worker);
      response.headers.set("Cache-Control", "no-cache");
      response.headers.set("X-Content-Type-Options", "nosniff");
      return response;
    }
    if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    if (!(url.pathname === "/" || url.pathname === "/login/email" || url.pathname === "/invite" || url.pathname === "/connections/complete" || url.pathname.startsWith("/app/"))) return unavailable();
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
    response.headers.set("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' blob:; connect-src 'self' ${socketOrigin}; worker-src 'self'; frame-src https://*.${env.ARTIFACT_SERVING_DOMAIN}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    return response;
  },
} satisfies ExportedHandler<Cloudflare.Env>;
