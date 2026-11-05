import type { Region } from "@rally/contracts/regions";
/**
 * The artifact serving Worker.
 *
 * A **second entrypoint, deployed as its own Worker** on its own origin with
 * its own binding set — not a route on the API. Untrusted, model-authored code
 * executes here, so it shares nothing with the API's secrets or its blast
 * radius. What it shares with `apps/api` is the source tree, and only because
 * of one thing it genuinely needs from there:
 * `durableObjectStubForArtifact`, the supported resolver that encodes the
 * jurisdiction-before-`idFromName` rule. Reimplementing that in a second app
 * would put a second authority on jurisdiction routing in the tree, and a
 * divergence would surface as an artifact silently resolving to the
 * wrong-jurisdiction object.
 *
 * **Its waistline is the point.** It holds the Worker Loader, the region's
 * payload bucket, the artifact Durable Object namespace, and the content-free
 * shared D1 route index. No regional product D1, provider secrets, Flagship, or
 * queues. A compromise of artifact code is contained by the isolate; a
 * compromise of this Worker exposes artifact content and viewer sessions, not
 * workspace authority.
 *
 * Request flow, in the order the fences apply:
 *
 * ```
 * Host → stub route → artifact id ──▶ fetch-metadata fence
 *                                             │
 *                    ┌────────────────────────┴──────────────────────┐
 *                    ▼                                               ▼
 *          public anonymous read                         same-origin / navigation
 *          no cookie or identity                         valid session adds identity
 *                    └────────────────────────┬──────────────────────┘
 *                                             ▼
 *                                  assets, loader, or facet
 * ```
 *
 * See `docs/live-web-artifacts.md`.
 */
import {
  ARTIFACT_ANNOTATION_SCRIPT_PATH_PATTERN,
  ARTIFACT_RESERVED_PREFIX,
  ARTIFACT_SIGN_IN_PATH,
  artifactReturnPath,
  artifactSiteOpenPath,
  artifactManifestKey,
  asArtifactId,
  parseArtifactHost,
  type ArtifactManifest,
} from "@rally/contracts";

import { resolveArtifactHostname } from "./hostname-routes";
import { artifactHostDOName } from "../durable-objects/names";
import type { ArtifactHostDO } from "../durable-objects/artifact-host-do";
import { durableObjectStubForArtifact } from "../lib/durable-object-namespace";
import { diagnosticErrorCode, logWarn } from "../observability/logger";
import {
  ARTIFACT_CONTENT_SECURITY_POLICY,
  artifactContentSecurityPolicy,
  artifactSecurityHeaders,
  browserFrameAncestor,
  classifyFetchMetadata,
  injectVersionBase,
  isFramedHopFromAnotherArtifact,
  refuseUnsafeVersionRequest,
  resolveAssetPath,
  splitVersionMount,
  withViewerIdentity,
} from "./serving-policy";
import {
  ASSET_SHIM_MODULE,
  ASSET_SHIM_SOURCE,
  LOADER_ENTRY_MODULE,
  LOADER_ENTRY_SOURCE,
  ARTIFACT_COMPATIBILITY_DATE,
  statelessLoaderId,
} from "./asset-shim";
import {
  annotationScriptPathFor,
  annotationScriptResponse,
  injectAnnotationScriptIntoHtml,
  injectAnnotationScriptResponse,
} from "./annotation-script";
import { neutralPage, plainErrorPage, redeemBootstrapPage } from "./pages";
import {
  injectSocialPreviewIntoHtml,
  injectSocialPreviewResponse,
  socialPreviewMarkup,
} from "./social-preview";

/** The cookie one artifact origin's viewer session lives in. */
const SESSION_COOKIE = "__rally_artifact_session";

export interface ArtifactServingEnv {
  APP_ENV: "development" | "test" | "staging" | "production";
  AVALON_REGION: Region;
  ARTIFACT_SERVING_DOMAIN: string;
  /**
   * The browser client's origin: the one page allowed to frame an artifact for
   * its inline preview, and where a site sends a person to sign in. Unset,
   * nothing may frame one, `/__rally/sign-in` answers the neutral 404, and a
   * protected site's 401 is shown as it is.
   */
  BROWSER_APP_ORIGIN?: string;
  ARTIFACT_HOSTS: DurableObjectNamespace<ArtifactHostDO>;
  PLATFORM_DB: D1Database;
  PAYLOADS: R2Bucket;
  /** Cloudflare's Worker Loader, absent until the binding is provisioned. */
  ARTIFACT_LOADER?: {
    get(
      id: string,
      callback: () => Promise<unknown> | unknown,
    ): { getEntrypoint(): { fetch(request: Request): Promise<Response> } };
  };
}

type ArtifactSecurityHeaderOptions = Readonly<{
  referrerPolicy?: "same-origin";
}>;

function withSecurityHeaders(
  response: Response,
  options: ArtifactSecurityHeaderOptions = {},
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(artifactSecurityHeaders())) headers.set(name, value);
  if (options.referrerPolicy === "same-origin") {
    headers.set("referrer-policy", options.referrerPolicy);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function html(
  body: string,
  status: number,
  securityOptions: ArtifactSecurityHeaderOptions = {},
): Response {
  return withSecurityHeaders(new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  }), securityOptions);
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}


/**
 * Exported here as well as from the API Worker's entry, because `ctx.exports`
 * is the running Worker's own exports: the facet is minted by the supervisor
 * inside the API Worker, and a stateless active site's isolate is minted here.
 */
export { ArtifactAssetLoopback } from "./asset-loopback";

export default {
  async fetch(request: Request, env: ArtifactServingEnv, ctx: ExecutionContext): Promise<Response> {
    return allowBrowserFraming(await artifactServer.fetch(request, env, ctx), browserFrameAncestor(env.BROWSER_APP_ORIGIN));
  },
};

const artifactServer = {
  async fetch(request: Request, env: ArtifactServingEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const host = parseArtifactHost(url.host);
    // Not an artifact host at all. Answered as the neutral page rather than an
    // error naming what was expected: this is the public edge of an untrusted
    // origin, and it owes a stranger nothing.
    if (!host) return html(neutralPage(), 404);
    // A region-distinct wildcard routes each region's hosts to its own Worker,
    // so a mismatch here means a misconfigured route rather than a bad request
    // — and serving it would move workspace content across a boundary
    // regionalization says has no path.
    if (host.region !== env.AVALON_REGION) return html(neutralPage(), 404);
    if (isFramedHopFromAnotherArtifact(request)) return html(neutralPage(), 403);

    // Sign-in hands the person to the browser client, which signs them in if
    // needed and opens this site at `return`. Answered before the hostname
    // lookup, the same for every host, so it says nothing about what exists.
    if (url.pathname === ARTIFACT_SIGN_IN_PATH) {
      const target = signInUrl(env, host, url.searchParams.get("return"));
      return target ? redirect(target) : html(neutralPage(), 404);
    }

    // The bootstrap page is the one path served before a session exists, and it
    // is Rally's own HTML rather than artifact content. It reads the code from
    // `location.hash` — which a browser never sends to a server — and POSTs it
    // in a body, so the proof stays out of Cloudflare's invocation log, the
    // Logpush export, and every trace span.
    //
    // Served before the hostname lookup: the page is the same for every host
    // and reads nothing about the artifact, so the D1 read would only delay the
    // first step of every open. It also stops this path telling a known host
    // from an unknown one; redemption, next, still resolves the artifact.
    if (url.pathname === `${ARTIFACT_RESERVED_PREFIX}/open`) {
      return html(
        redeemBootstrapPage(`${ARTIFACT_RESERVED_PREFIX}/redeem`),
        200,
        {
          // The default no-referrer policy serializes this same-origin form
          // POST's Origin as `null` in Chromium. The redeem fence correctly
          // rejects that opaque origin. This Rally-authored page only posts to
          // itself, fragments never enter a Referer, and the artifact document
          // loaded after redemption returns to the default no-referrer policy.
          referrerPolicy: "same-origin",
        },
      );
    }

    // Rally's annotation script, also served before the hostname lookup: it
    // is the same file for every artifact and reads nothing about one. The
    // hash in its path only busts caches, so any spelling serves the current
    // script. See `annotation-script.ts`.
    if (ARTIFACT_ANNOTATION_SCRIPT_PATH_PATTERN.test(url.pathname)) {
      return annotationScriptResponse(browserFrameAncestor(env.BROWSER_APP_ORIGIN), url.pathname);
    }

    let artifactId = host.legacyArtifactId;
    if (!artifactId && host.hostnameStub) {
      artifactId = await resolveArtifactHostname(env, host.hostnameStub);
    }
    if (!artifactId) return html(neutralPage(), 404);

    const origin = url.origin;
    const artifact = durableObjectStubForArtifact(
      env as never,
      env.ARTIFACT_HOSTS,
      artifactHostDOName(env.AVALON_REGION, asArtifactId(artifactId)),
    );

    // **This endpoint never serves artifact content.** It consumes the code,
    // sets the cookie, and redirects, so no artifact document is ever loaded at
    // a location that held the code: nothing lands in history, in a copied URL,
    // or in a screenshot, and same-origin model code has no `location` to read
    // it from.
    if (url.pathname === `${ARTIFACT_RESERVED_PREFIX}/redeem`) {
      if (request.method !== "POST") return html(neutralPage(), 405);
      if (classifyFetchMetadata(request, origin) === "refused") return html(neutralPage(), 403);
      const form = new URLSearchParams(await request.text().catch(() => ""));
      const code = form.get("code") ?? "";
      const redeemed = code ? await artifact.redeemCode(code) : null;
      if (!redeemed) return html(neutralPage(), 403);
      // Back to where the person was going when they signed in. Reduced to a
      // path on this site, so the redirect cannot leave it.
      const headers = new Headers({ location: artifactReturnPath(form.get("return")) });
      // Redeemed inside the browser client's preview frame, the artifact is a
      // cross-site frame, and a `Lax` cookie would never be sent with its
      // requests. A partitioned `None` cookie is kept only for this artifact
      // under that one top-level site, so it is no wider than the frame.
      const framed = request.headers.get("sec-fetch-dest") === "iframe" && Boolean(env.BROWSER_APP_ORIGIN);
      headers.append("set-cookie", [
        `${SESSION_COOKIE}=${redeemed.session}`,
        "Path=/",
        "HttpOnly",
        "Secure",
        // `Lax` rather than `Strict` so the desktop's own top-level navigation
        // to the artifact carries the cookie it just set.
        ...(framed ? ["SameSite=None", "Partitioned"] : ["SameSite=Lax"]),
        `Max-Age=${Math.max(0, Math.floor((redeemed.expiresAt - Date.now()) / 1_000))}`,
      ].join("; "));
      return withSecurityHeaders(new Response(null, { status: 303, headers }));
    }

    // Every remaining path is artifact content, and any request may reach it.
    // Fetch metadata decides only whether it may carry a viewer identity:
    // same-origin requests and top-level navigations may; everything else,
    // any method from any origin, arrives anonymous. So a sibling artifact can
    // never act with a viewer's identity, and the site's code decides what an
    // anonymous request may do.
    const verdict = classifyFetchMetadata(request, origin);
    let admitted: Admitted | null = null;
    // Whether sending this person to sign in could help. Not when their
    // session could not be checked: signing in again would only come back to
    // the same failed check, round and round.
    let signInCanHelp = true;
    if (verdict === "same_origin" || verdict === "top_level") {
      const session = readCookie(request, SESSION_COOKIE);
      // Identity is an optional enhancement to a public response. If the
      // visibility hop fails, degrade to anonymous rather than making a viewer
      // with an old cookie less able to open the site than a crawler is.
      let checked: Awaited<ReturnType<ArtifactHostDO["checkSession"]>> | null = null;
      if (session) {
        try {
          checked = await artifact.checkSession(session);
        } catch (error) {
          signInCanHelp = false;
          logWarn({
            LOG_LEVEL: "info",
            AVALON_REGION: env.AVALON_REGION,
          }, "artifact_viewer_session_check_failed", {
            artifact_id: artifactId,
            code: diagnosticErrorCode(error, "session_check_failed"),
          });
        }
      }
      if (
        checked?.ok
        && checked.viewerId
        && checked.viewerName !== undefined
        && checked.version !== undefined
        && checked.mode !== undefined
        && checked.stateful !== undefined
        && checked.manifest
      ) {
        admitted = {
          viewerId: checked.viewerId,
          viewerName: checked.viewerName,
          version: checked.version,
          mode: checked.mode,
          stateful: checked.stateful,
          manifest: checked.manifest,
        };
      }
    }
    if (!admitted) {
      const state = await artifact.currentState();
      if (!state) return html(neutralPage(), 404);
      admitted = {
        viewerId: null,
        viewerName: null,
        version: state.version,
        mode: state.mode,
        stateful: state.stateful,
        manifest: state.manifest,
      };
    }

    // Anyone may submit to a site. A request without a session reaches the
    // handler with no viewer headers, and the site's own code decides whether
    // to require them: a protected site answers 401, which a page load turns
    // into sign-in below.

    const mount = splitVersionMount(url.pathname);
    if (mount.version !== null && mount.version !== admitted.version) {
      // Historical active versions cannot run their protection guard, and a
      // historical static version has no guard at all. Keep version browsing
      // behind the Rally session even though the current site is public.
      if (!admitted.viewerId) {
        const target = signInCanHelp && isDocumentNavigation(request)
          ? signInUrl(env, host, url.pathname + url.search)
          : null;
        return target ? redirect(target) : html(neutralPage(), 401);
      }
      const refusal = refuseUnsafeVersionRequest(request);
      if (refusal) return html(plainErrorPage(refusal), 405);
      return servePriorVersion(env, artifactId, mount.version, mount.path, admitted);
    }

    const response = await serveCurrent(env, ctx, artifact, artifactId, request, url, admitted);
    // A protected site answers a visitor with no session 401. When that visitor
    // is loading a page, send them to sign in and back here instead, so a
    // direct link to a protected site works. The handler still decided the
    // refusal; only its page is replaced, and only for a page load.
    if (response.status === 401 && !admitted.viewerId && signInCanHelp && isDocumentNavigation(request)) {
      const target = signInUrl(env, host, url.pathname + url.search);
      if (target) return redirect(target);
    }
    return response;
  },
};

/**
 * The browser client's page that signs a person in and opens this site at
 * `returnTo`, or `null` where there is none to send them to: no browser
 * client is configured (or the setting is not a URL), or a legacy UUID host
 * has no hostname to name.
 */
function signInUrl(
  env: ArtifactServingEnv,
  host: NonNullable<ReturnType<typeof parseArtifactHost>>,
  returnTo: string | null,
): string | null {
  const browserOrigin = browserFrameAncestor(env.BROWSER_APP_ORIGIN);
  if (!browserOrigin || !host.hostnameStub) return null;
  return new URL(artifactSiteOpenPath(host.region, host.hostnameStub, returnTo ?? "/"), browserOrigin).toString();
}

/** A person loading a page, as opposed to a script, an image or a crawler. */
function isDocumentNavigation(request: Request): boolean {
  return request.method === "GET"
    && request.headers.get("sec-fetch-mode") === "navigate"
    && request.headers.get("sec-fetch-dest") === "document";
}

function redirect(location: string): Response {
  return withSecurityHeaders(new Response(null, { status: 303, headers: { location } }));
}

type Admitted = {
  viewerId: string | null;
  viewerName: string | null;
  version: number;
  mode: "static" | "active";
  stateful: boolean;
  manifest: ArtifactManifest;
};

/**
 * Serve one asset out of a version's immutable bucket prefix.
 *
 * The manifest is the only index: nothing resolves a path this Worker cannot
 * find in it, which is what makes the server module's absence from `assets` a
 * real 404 rather than a convention a bug could undo.
 */
async function serveAsset(
  env: ArtifactServingEnv,
  artifactId: string,
  version: number,
  manifest: ArtifactManifest,
  path: string,
  rewriteHtmlForVersion: number | null,
  socialPageUrl: URL | null,
  annotationScriptPath: string | null,
): Promise<Response> {
  const assetPaths = new Set(manifest.assets.map((asset) => asset.path));
  const resolved = resolveAssetPath(path, assetPaths);
  if (!resolved) return html(plainErrorPage("This page does not exist in the artifact."), 404);
  const asset = manifest.assets.find((entry) => entry.path === resolved)!;
  const object = await env.PAYLOADS.get(`artifact/${artifactId}/v${version}/assets/${resolved}`);
  if (!object) return html(plainErrorPage("This page is temporarily unavailable."), 503);
  const htmlAsset = asset.contentType.toLowerCase().startsWith("text/html");
  const social = htmlAsset && socialPageUrl !== null && manifest.socialPreview !== undefined && resolved === "index.html";
  if (htmlAsset && (rewriteHtmlForVersion !== null || social || annotationScriptPath !== null)) {
    // Static HTML is bounded by the publish ceiling, so it is rewritten as
    // text. The annotation script goes in last so it ends up first in `<head>`.
    let source = await object.text();
    if (rewriteHtmlForVersion !== null) source = injectVersionBase(source, rewriteHtmlForVersion);
    if (social) {
      source = injectSocialPreviewIntoHtml(
        source,
        socialPreviewMarkup(manifest.socialPreview!, socialPageUrl, manifest.artifactVersion),
      );
    }
    if (annotationScriptPath !== null) source = injectAnnotationScriptIntoHtml(source, annotationScriptPath);
    return withSecurityHeaders(new Response(source, {
      status: 200,
      headers: { "content-type": asset.contentType },
    }));
  }
  return withSecurityHeaders(new Response(object.body, {
    status: 200,
    headers: { "content-type": asset.contentType },
  }));
}

async function serveCurrent(
  env: ArtifactServingEnv,
  ctx: ExecutionContext,
  artifact: DurableObjectStub<ArtifactHostDO>,
  artifactId: string,
  request: Request,
  url: URL,
  admitted: Admitted,
): Promise<Response> {
  const manifest = admitted.manifest;
  // Only a Rally viewer's page carries the annotation script; see
  // `annotationScriptPathFor` for who counts as one.
  const annotationScriptPath = annotationScriptPathFor({
    viewerId: admitted.viewerId,
    request,
    parentOrigin: browserFrameAncestor(env.BROWSER_APP_ORIGIN),
  });
  if (manifest.mode === "static") {
    return serveAsset(env, artifactId, manifest.artifactVersion, manifest, url.pathname, null, url, annotationScriptPath);
  }
  // A stateful site runs through the supervisor's facet and needs no loader
  // binding here. A stateless active site cannot safely fall back to assets:
  // its handler may be the access control protecting those same files.
  if (!env.ARTIFACT_LOADER && !manifest.stateful) {
    return html(plainErrorPage("This artifact is temporarily unavailable."), 503);
  }
  try {
    const response = await runArtifactModule(env, ctx, artifact, artifactId, request, admitted);
    const withPreview = manifest.socialPreview
      ? injectSocialPreviewResponse(
          response,
          socialPreviewMarkup(manifest.socialPreview, url, manifest.artifactVersion),
        )
      : response;
    const rewritten = annotationScriptPath !== null
      ? injectAnnotationScriptResponse(withPreview, annotationScriptPath)
      : withPreview;
    return withSecurityHeaders(rewritten);
  } catch (error) {
    // The viewer never sees a stack trace. For an identified participant it
    // lands in the rail, where it can be pasted back into chat for the model.
    // The rail error ring is participant-facing and bounded. Letting an
    // anonymous caller append would let 50 crafted failures evict every useful
    // diagnosis and plant attacker-chosen paths in a surface people paste back
    // into chat.
    if (admitted.viewerId) {
      await artifact.recordError({
        version: manifest.artifactVersion,
        requestPath: url.pathname,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? (error.stack ?? null) : null,
      }).catch(() => undefined);
    }
    return html(plainErrorPage("This artifact hit an error. Ask Rally in the thread to fix it."), 500);
  }
}

async function servePriorVersion(
  env: ArtifactServingEnv,
  artifactId: string,
  version: number,
  path: string,
  admitted: Admitted,
): Promise<Response> {
  // A prior version of a *stateful* artifact is source-only, never live: one
  // facet runs one class, so serving old code would abort the facet under
  // current viewers, and old code against the live schema is undefined besides.
  if (admitted.stateful) {
    return html(plainErrorPage("Earlier versions of this artifact open as source, not as a live page."), 409);
  }
  const object = await env.PAYLOADS.get(artifactManifestKey(artifactId, version));
  if (!object) return html(plainErrorPage("That version is no longer available."), 404);
  const manifest = JSON.parse(await object.text()) as ArtifactManifest;
  // A prior *static* version serves its frozen assets exactly. A prior
  // stateless-active version would run its frozen module over its frozen
  // assets; until the loader binding exists, its assets are what render.
  return serveAsset(env, artifactId, version, manifest, path, version, null, null);
}

/**
 * Materialize the model's module and hand it the request.
 *
 * The isolate id is version-scoped, so a republish that changed content mints a
 * new isolate while an unchanged one reuses the warm cache — the loader's own
 * documented contract, expressed in the key rather than managed.
 *
 * The module receives exactly one binding and no ambient authority:
 * `globalOutbound: null` makes `fetch()` and `connect()` throw, so a page's
 * server half cannot reach the network at all, and the viewer cookie is
 * stripped before the request crosses into it — artifact code never sees a
 * credential. For a request carrying a valid Rally session it sees the viewer's
 * identity as two trusted headers injected after every inbound header of those
 * names has been stripped; a public request sees neither header.
 */
async function runArtifactModule(
  env: ArtifactServingEnv,
  ctx: ExecutionContext,
  artifact: DurableObjectStub<ArtifactHostDO>,
  artifactId: string,
  request: Request,
  admitted: Admitted,
): Promise<Response> {
  const manifest = admitted.manifest;
  // A stateful artifact's requests route through the supervisor: facet stubs
  // cannot travel over RPC, so the object that owns the facet is the only place
  // that can forward into it. That is a platform constraint rather than a
  // routing preference, and the hop costs nothing extra — the serving Worker
  // already consulted this object for the session check.
  if (manifest.stateful) {
    return await artifact.fetchThroughFacet(forwardable(request, admitted));
  }
  const loader = env.ARTIFACT_LOADER!;
  const worker = loader.get(statelessLoaderId(artifactId, manifest.artifactVersion), async () => {
    const module = await env.PAYLOADS.get(`artifact/${artifactId}/v${manifest.artifactVersion}/assets/index.js`);
    if (!module) throw new Error("artifact_server_module_missing");
    return {
      compatibilityDate: ARTIFACT_COMPATIBILITY_DATE,
      // Rally's module is the main one and imports the site's, so `env.ASSETS`
      // is the wrapped reader by the time the site's handler runs — the same
      // shape the facet gives a stateful site, so one contract covers both.
      mainModule: LOADER_ENTRY_MODULE,
      modules: {
        [LOADER_ENTRY_MODULE]: LOADER_ENTRY_SOURCE,
        [ASSET_SHIM_MODULE]: ASSET_SHIM_SOURCE,
        "index.js": await module.text(),
      },
      env: { ASSETS: assetLoopback(ctx, artifactId, manifest) },
      globalOutbound: null,
    };
  });
  return await worker.getEntrypoint().fetch(forwardable(request, admitted));
}

/**
 * The request as artifact code receives it: viewer identity in, credential out.
 *
 * The strip runs before the set, and covers every alias of both header names —
 * canonical and superseded — because every product header reader widens to the
 * superseded spelling. A family whose readers widen and whose stripper does not
 * has a forgeable back door, and this is the entire anti-spoof mechanism.
 */
function forwardable(request: Request, admitted: Admitted): Request {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  const stripped = new Request(request, { headers });
  return withViewerIdentity(
    stripped,
    admitted.viewerId ? { id: admitted.viewerId, name: admitted.viewerName ?? "" } : null,
  );
}

/**
 * The one binding an artifact's module holds: its own published files.
 *
 * An RPC stub for an exported entrypoint, not an object with a method: the
 * loader's env serializer clones what it is given and rejects a value carrying
 * a function with `DataCloneError`. The previous shape here was that value, and
 * it threw on the first request of every stateless active site.
 */
function assetLoopback(ctx: ExecutionContext, artifactId: string, manifest: ArtifactManifest) {
  return ctx.exports.ArtifactAssetLoopback({
    props: {
      artifactId,
      version: manifest.artifactVersion,
      assets: manifest.assets.map((asset) => ({
        path: asset.path,
        contentType: asset.contentType,
      })),
    },
  });
}

/**
 * Lets exactly the browser client frame an artifact, for its inline preview.
 *
 * Every response leaves `artifactServer` with `artifactSecurityHeaders()`,
 * which refuses all framing. With a frame ancestor configured, a response
 * carrying exactly that default policy gets the same policy naming the one
 * origin, and loses the legacy `X-Frame-Options`, which cannot name an origin.
 * A response with any other policy is left closed. Another artifact still cannot frame this one: its host is not
 * that origin.
 */
export function allowBrowserFraming(response: Response, frameAncestor: string | null): Response {
  if (!frameAncestor || response.status === 101) return response;
  if (response.headers.get("content-security-policy") !== ARTIFACT_CONTENT_SECURITY_POLICY) return response;
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", artifactContentSecurityPolicy(frameAncestor));
  headers.delete("x-frame-options");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
