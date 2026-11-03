/**
 * The rules the artifact serving Worker applies to every request, before any
 * model-authored code runs.
 *
 * Separated from the Worker's entry point because each of these is a security
 * boundary that has to be testable on its own, and because reading them
 * together is the only way to see that the fence has no gaps: the page is
 * fenced by CSP, the request is fenced by fetch metadata, and the module is
 * fenced by the loader's own capability model.
 *
 * See `docs/live-web-artifacts.md`.
 */
import {
  ARTIFACT_RESERVED_PREFIX,
  ARTIFACT_VIEWER_ID_HEADER,
  ARTIFACT_VIEWER_NAME_HEADER,
} from "@rally/contracts";
import { rallyHeaderAliases } from "@rally/contracts/http-headers";

/**
 * The Content-Security-Policy every artifact response carries.
 *
 * **`globalOutbound: null` fences the server module; it says nothing about the
 * page that module serves**, which runs in a browser with ordinary network
 * access. Without this header, model-authored page code could `fetch` any host,
 * load a remote script, beacon, open a WebSocket, or point a form off-origin —
 * carrying whatever the page can see with it. This is what makes the skill's
 * "no network" and "carry your own assets" rules *true* rather than advisory,
 * and it is why a CDN link in a page would not load even if the skill said
 * nothing.
 *
 * An artifact cannot relax it: a page's own `<meta>` CSP can only further
 * restrict, and where a meta policy and a header policy disagree the stricter
 * one applies.
 *
 * **`script-src` and `style-src` are written out rather than left to
 * `default-src`, and that is load-bearing.** `'self'` does not permit inline
 * code. Inheriting `default-src` would refuse the inline `<script>` and
 * `<style>` that model-authored pages are overwhelmingly built from, and every
 * artifact would fail on its first load. `'unsafe-inline'` is named
 * deliberately: the threat this policy exists to stop is *egress*, not
 * injection into a page whose author is already the model, and the egress
 * directives are untouched by it. Per-response nonces are the tighter design
 * and would mean rewriting model-authored HTML on the serving path — a
 * follow-up, for a threat that is not V1's.
 *
 * `img-src` gains `data:` for the same reason: a model embedding a small inline
 * image is ordinary, and `'self'` alone would drop it silently.
 *
 * `frame-ancestors` is `'none'` by default. The desktop never frames an
 * artifact: its rail preview is a top-level `WebContentsView` and the pop-out
 * is a window. The one exception is the browser client's inline preview:
 * `artifactContentSecurityPolicy(frameAncestor)` names exactly that origin,
 * from `browserFrameAncestor`, so the default stays closed wherever
 * `BROWSER_APP_ORIGIN` is unset or unreadable.
 */
export function artifactContentSecurityPolicy(frameAncestor: string | null = null): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "media-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestor ?? "'none'"}`,
    // Written out, like the two above, because inheriting `default-src 'self'`
    // would *permit* a same-origin service worker — and a service worker is the
    // one thing an artifact can install that answers requests without reaching
    // Rally. A root-scoped one could cache authenticated responses and keep
    // serving them after the viewer's session ended, after their work-stream
    // visibility was revoked, and after a republish: it would silently defeat
    // revocation, the current-version guarantee, and the offline honesty all at
    // once. Nothing an artifact does needs one.
    "worker-src 'none'",
  ].join("; ");
}

export const ARTIFACT_CONTENT_SECURITY_POLICY = artifactContentSecurityPolicy();

/**
 * The one origin that may frame an artifact: the browser client's, when it is
 * configured. A value that is not an http(s) URL frames nothing, so a bad
 * setting keeps the default closed rather than failing every response.
 */
export function browserFrameAncestor(browserOrigin: string | undefined): string | null {
  if (!browserOrigin) return null;
  try {
    const url = new URL(browserOrigin);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Headers every artifact response carries, whatever it is serving.
 *
 * `Referrer-Policy` is not decoration here: an artifact page that linked out
 * would otherwise leak its own URL — which identifies a work stream's
 * artifact — to whatever it linked to.
 */
export function artifactSecurityHeaders(): Record<string, string> {
  return {
    "content-security-policy": ARTIFACT_CONTENT_SECURITY_POLICY,
    "referrer-policy": "no-referrer",
    // A shareable or unfurlable URL is not an invitation to place work-stream
    // output in a public search index. Link-preview crawlers still read it.
    "x-robots-tag": "noindex",
    "x-content-type-options": "nosniff",
    // An artifact origin is never a legitimate frame parent either; a page that
    // framed another artifact would be a same-site credentialed load.
    "x-frame-options": "DENY",
    // Active artifacts may vary a response by authenticated viewer identity,
    // and the canonical URL is version-mutable. A shared cache cannot know
    // which responses are anonymous and which are personalized.
    "cache-control": "private, no-store",
  };
}

export type FetchMetadataVerdict = "same_origin" | "top_level" | "anonymous_read" | "refused";

/**
 * Whether a request may carry Rally's trusted viewer identity into an artifact.
 *
 * **Separate origins do not close this on their own, and that is the whole
 * reason this exists.** Every artifact is a subdomain of one registrable
 * domain, so two artifacts are same-*site*. `SameSite` is a site-level control,
 * so it does not stop script in artifact A sending a *credentialed* request to
 * artifact B: B's cookie rides along, and while CORS stops A reading the
 * response, a simple `POST` needs no preflight — so B's model-written handler
 * still runs, and can still write to B's database.
 *
 * The serving Worker closes it before untrusted code runs, which is the only
 * place it can be closed once, for every artifact, without trusting
 * model-written handlers to defend themselves.
 *
 * Only `same_origin` and `top_level` may carry an identity. Every other
 * request still reaches the artifact, but anonymous: the serving Worker
 * ignores any cookie and injects no viewer headers, so public pages, unfurl
 * crawlers and public submissions work without letting a sibling artifact
 * exercise another artifact's handler with the victim's identity.
 * `anonymous_read` and `refused` differ only at `/__rally/redeem`, which
 * refuses the latter outright.
 */
export function classifyFetchMetadata(
  request: Request,
  artifactOrigin: string,
): FetchMetadataVerdict {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  const anonymousRead = request.method === "GET" || request.method === "HEAD";
  // An `Origin` that disagrees with this artifact settles it regardless of what
  // `Sec-Fetch-Site` says. It may still read the public representation, but it
  // must never carry a viewer session into model-authored code.
  if (origin !== null && origin !== artifactOrigin) {
    return anonymousRead ? "anonymous_read" : "refused";
  }
  if (site === "same-origin") return "same_origin";
  // A genuine top-level navigation, identified by what it *is* rather than
  // where it came from. `Sec-Fetch-Site: none` alone is the wrong test: it
  // covers an address bar and a bookmark, but a link click or a redirect from
  // anywhere else sends `cross-site`, and refusing those would break the
  // ordinary act of following a link to an artifact you can already see.
  //
  // `Sec-Fetch-Mode: navigate` with `Sec-Fetch-Dest: document` is the shape
  // that matters, and it keeps the CSRF boundary intact: a document navigation
  // cannot carry a body a page composed, and the sub-resource requests that
  // *are* the attack — a form post, a fetch, an image — are `no-cors`, `cors`,
  // or `same-origin` mode and never reach this branch.
  const navigation = request.headers.get("sec-fetch-mode") === "navigate"
    && request.headers.get("sec-fetch-dest") === "document";
  if (navigation && request.method === "GET") return "top_level";
  if (anonymousRead) return "anonymous_read";
  return "refused";
}

/**
 * Whether a frame is being navigated here from another artifact.
 *
 * The browser client frames an artifact, and its own shell CSP lets that frame
 * hold any page on the artifact domain. So script in one artifact could move
 * its frame to another, carrying page data in the URL, while Rally's chrome
 * still names the first. The desktop refuses that hop in
 * `confineToArtifactOrigin`; a browser gives the parent no such hook, so the
 * server refuses it. Rally's own framed load comes from the app (`cross-site`)
 * and an artifact's own navigations are `same-origin`; only a hop between two
 * artifact hosts arrives framed and `same-site`.
 */
export function isFramedHopFromAnotherArtifact(request: Request): boolean {
  return request.headers.get("sec-fetch-dest") === "iframe"
    && request.headers.get("sec-fetch-mode") === "navigate"
    && request.headers.get("sec-fetch-site") === "same-site";
}

/**
 * Split a request path into the version it is mounted under and the path the
 * module should see.
 *
 * **The prefix has to be invisible to the page in both directions or it
 * silently serves the wrong version.** Inbound, a frozen module routes on
 * `url.pathname` and knows nothing of versions: handed `/__rally/v3/api/search`
 * it would match no route and fall through to assets, so the prefix is stripped
 * before forwarding and the module sees `/api/search`, exactly as it did when
 * it was current.
 *
 * Outbound is the page's problem and is solved by an injected `<base>`, because
 * a page's own root-absolute `fetch("/api/search")` would resolve against the
 * origin rather than the mount and query the *current* version's live handler.
 */
export function splitVersionMount(pathname: string): { version: number | null; path: string } {
  const prefix = `${ARTIFACT_RESERVED_PREFIX}/v`;
  if (!pathname.startsWith(prefix)) return { version: null, path: pathname };
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  const digits = slash === -1 ? rest : rest.slice(0, slash);
  if (!/^[1-9][0-9]{0,8}$/u.test(digits)) return { version: null, path: pathname };
  const remainder = slash === -1 ? "/" : rest.slice(slash);
  return { version: Number(digits), path: remainder === "" ? "/" : remainder };
}

/**
 * Whether a request under a prior-version mount is allowed at all.
 *
 * `<base>` and relative paths fix well-behaved pages; they do not stop old code
 * from leaving the mount, and an old page shares an origin — cookies, storage —
 * with the current one. **A root-absolute `fetch("/api/…")` from a historical
 * render does not pass through here at all**: it is an ordinary same-origin
 * request to the canonical path, indistinguishable from one the current page
 * made, and `Referrer-Policy: no-referrer` on every artifact response means
 * there is not even a `Referer` to tell them apart.
 *
 * That is why a prior version renders its **frozen assets only** and its module
 * is never loaded: the escape cannot be closed at the request path, so the
 * class of problem is removed instead. What is left is a page whose own client
 * script may query the current version's data — a wrong reading, not an
 * unauthorized one, since the viewer is admitted to the current version anyway.
 * These two rules bound what such a page may *do*.
 *
 * A service worker is refused specifically because its scope would outlive the
 * view and interpose on the canonical origin: registering one from a historical
 * render would let V3's code answer requests for V4 indefinitely.
 */
export function refuseUnsafeVersionRequest(request: Request): string | null {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return "A prior version of an artifact is read-only.";
  }
  if (request.headers.get("service-worker") !== null) {
    return "A prior version of an artifact cannot register a service worker.";
  }
  return null;
}

/**
 * Rewrite a prior version's HTML so its own relative URLs resolve inside the
 * mount.
 *
 * Injected rather than expected of the page, because the page was written when
 * it *was* current and had no mount to know about. Placed immediately after
 * `<head>` so it precedes every element that could resolve a URL — a `<base>`
 * after the first `<link>` is a `<base>` that arrived too late.
 */
export function injectVersionBase(html: string, version: number): string {
  const base = `<base href="${ARTIFACT_RESERVED_PREFIX}/v${version}/">`;
  const head = /<head(\s[^>]*)?>/iu.exec(html);
  if (head?.index === undefined) return `${base}${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}${base}${html.slice(at)}`;
}

/**
 * Resolve a request path against a manifest, with static-site conventions.
 *
 * `/` means `/index.html`, and so does a directory-shaped path — the two
 * conventions every static host implements and every model writes against.
 * Nothing here reaches outside the manifest, which is what makes the server
 * module's absence from `assets` an actual 404 rather than a convention.
 */
export function resolveAssetPath(pathname: string, assetPaths: ReadonlySet<string>): string | null {
  const trimmed = pathname.replace(/^\/+/u, "");
  if (trimmed === "") return assetPaths.has("index.html") ? "index.html" : null;
  if (assetPaths.has(trimmed)) return trimmed;
  const indexed = trimmed.endsWith("/") ? `${trimmed}index.html` : `${trimmed}/index.html`;
  if (assetPaths.has(indexed)) return indexed;
  // A path with no extension is very often a route a static page expects the
  // host to resolve to its own HTML file.
  const withHtml = `${trimmed}.html`;
  return assetPaths.has(withHtml) ? withHtml : null;
}

/**
 * The two headers artifact code is allowed to trust, and the strip that earns
 * that trust.
 *
 * Exported from here rather than inlined at the injection site because the
 * strip *is* the anti-spoof mechanism and has its own test: a page or proxy
 * that sends these names must never have them survive into the module. It
 * removes every alias, canonical and superseded alike, because every product
 * header reader widens to the superseded spelling — a family whose readers
 * widen and whose stripper does not has a forgeable back door.
 */
export function withViewerIdentity(
  request: Request,
  viewer: { id: string; name: string } | null,
): Request {
  const headers = new Headers(request.headers);
  for (const header of [ARTIFACT_VIEWER_ID_HEADER, ARTIFACT_VIEWER_NAME_HEADER]) {
    headers.delete(header);
    // `rallyHeaderAliases` is the one place the superseded prefixes live, so
    // the strip reads them from there rather than restating the list.
    for (const alias of rallyHeaderAliases(header)) headers.delete(alias);
  }
  if (viewer) {
    headers.set(ARTIFACT_VIEWER_ID_HEADER, viewer.id);
    // A header value is ASCII-only by RFC 7230, so a display name needs *some*
    // encoding. This is deliberately the `decodeURIComponent` idiom rather than
    // RFC 8187's `UTF-8''…` form — chosen for how reliably a small model
    // decodes it, and named here so nobody mistakes a house convention for a
    // standard header encoding.
    headers.set(ARTIFACT_VIEWER_NAME_HEADER, encodeURIComponent(viewer.name));
  }
  return new Request(request, { headers });
}
