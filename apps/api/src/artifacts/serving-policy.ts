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
import { ARTIFACT_RESERVED_PREFIX } from "@rally/contracts";

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
 * `frame-ancestors` is `'none'` rather than an allowlist of Rally surfaces,
 * because nothing Rally owns ever frames an artifact: the rail preview is a
 * top-level `WebContentsView` and the pop-out is a window. An allowlist here
 * would be a standing invitation to reintroduce the `<iframe>` that design
 * deliberately rejects.
 */
export const ARTIFACT_CONTENT_SECURITY_POLICY = [
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
  "frame-ancestors 'none'",
].join("; ");

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
    "x-content-type-options": "nosniff",
    // An artifact origin is never a legitimate frame parent either; a page that
    // framed another artifact would be a same-site credentialed load.
    "x-frame-options": "DENY",
    // Artifact content is per-viewer authorized and version-mutable at its
    // canonical URL. A shared cache holding one viewer's response would serve
    // it to another.
    "cache-control": "private, no-store",
  };
}

export type FetchMetadataVerdict = "same_origin" | "top_level" | "refused";

/**
 * Whether a credentialed request genuinely belongs to this artifact.
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
 * A `same-site` or `cross-site` request is refused **including GETs**, because
 * artifact code may treat any method as a write and nothing about a
 * model-written handler makes it safe by method. Fetch metadata is unforgeable
 * by page script — it is a browser-set forbidden header — and a client that
 * sends none, such as a non-browser caller, is treated as not same-origin and
 * refused rather than admitted.
 */
export function classifyFetchMetadata(
  request: Request,
  artifactOrigin: string,
): FetchMetadataVerdict {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  // An `Origin` that disagrees with this artifact settles it regardless of what
  // `Sec-Fetch-Site` says: browsers send `null` for opaque origins, and a
  // literal mismatch is never legitimate here.
  if (origin !== null && origin !== artifactOrigin) return "refused";
  if (site === "same-origin") return "same_origin";
  // `none` is a genuine top-level navigation: an address bar, a bookmark, or
  // the desktop opening the artifact itself.
  if (site === "none" && request.method === "GET") return "top_level";
  return "refused";
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
 * from reaching the live artifact deliberately or by accident, and an old page
 * shares an origin — cookies, storage, service-worker scope — with the current
 * one. So "read-only" here describes what the request path *enforces*, not what
 * frozen bytes are assumed to do.
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
