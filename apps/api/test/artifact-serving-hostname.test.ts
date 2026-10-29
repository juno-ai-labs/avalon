import "../../../tests/isolated-region";
/** Public hostname routing at the isolated artifact Worker boundary. */
import { artifactAnnotationScriptPath, asArtifactId, type ArtifactManifest } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

import artifactWorker, { type ArtifactServingEnv } from "../src/artifacts/index";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestDurableObjectId,
} from "./helpers/cloudflare-test";

const ARTIFACT = "00000000-0000-7000-8000-0000000000b1";
const STUB = "level-luminous-sequential-schrodinger";
const INDEX_HTML = "<!doctype html><html><head><title>Public artifact</title></head><body><h1>Public artifact</h1></body></html>";
const PRICING_HTML = "<!doctype html><html><head><meta property=\"og:title\" content=\"Pricing\"></head><body>Pricing</body></html>";
const PREVIEW_BYTES = new Uint8Array([137, 80, 78, 71]);

const MANIFEST: ArtifactManifest = {
  version: 1,
  artifactId: asArtifactId(ARTIFACT),
  artifactVersion: 1,
  mode: "static",
  stateful: false,
  serverModuleSha256: null,
  assets: [
    {
      path: "index.html",
      contentType: "text/html; charset=utf-8",
      sizeBytes: INDEX_HTML.length,
      sha256: "0".repeat(64),
    },
    {
      path: "pricing.html",
      contentType: "text/html; charset=utf-8",
      sizeBytes: PRICING_HTML.length,
      sha256: "3".repeat(64),
    },
    {
      path: ".rally/social-preview.png",
      contentType: "image/png",
      sizeBytes: PREVIEW_BYTES.length,
      sha256: "2".repeat(64),
    },
  ],
  socialPreview: {
    title: "Public artifact",
    description: "A public Rally artifact.",
    image: {
      path: ".rally/social-preview.png",
      contentType: "image/png",
      width: 1200,
      height: 630,
      alt: "Public artifact",
      generated: true,
    },
  },
  totalBytes: INDEX_HTML.length + PRICING_HTML.length + PREVIEW_BYTES.length,
  publishedAt: "2026-09-02T00:00:00.000Z",
};
const ACTIVE_MANIFEST: ArtifactManifest = {
  ...MANIFEST,
  mode: "active",
  serverModuleSha256: "1".repeat(64),
};

function context(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function fixture(route: unknown | null, options: {
  checkSessionResult?: unknown;
  checkSessionError?: Error;
  currentStateResult?: unknown;
  loaderFetch?: (request: Request) => Promise<Response>;
} = {}): {
  env: ArtifactServingEnv;
  readRoute: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
  idFromName: ReturnType<typeof vi.fn>;
  redeemCode: ReturnType<typeof vi.fn>;
  checkSession: ReturnType<typeof vi.fn>;
  currentState: ReturnType<typeof vi.fn>;
  recordError: ReturnType<typeof vi.fn>;
} {
  const readRoute = vi.fn(async () => route === null ? null : route);
  const prepare = vi.fn((sql: string) => {
    expect(sql).toMatch(/FROM artifact_hostname_routes\s+WHERE region = \? AND hostname_stub = \?/u);
    return createTestD1PreparedStatement({
      bind: (region: string, hostnameStub: string) => {
        expect([region, hostnameStub]).toEqual(["global", STUB]);
        return createTestD1PreparedStatement({ first: readRoute });
      },
    });
  });
  const idFromName = vi.fn((name: string) => createTestDurableObjectId(name));
  const redeemCode = vi.fn();
  const checkSession = vi.fn(async () => {
    if (options.checkSessionError) throw options.checkSessionError;
    return options.checkSessionResult ?? null;
  });
  const currentState = vi.fn(async () => options.currentStateResult ?? null);
  const recordError = vi.fn(async () => undefined);
  const hosts = createCloudflareTestBinding<ArtifactServingEnv["ARTIFACT_HOSTS"]>({
    idFromName,
    get: () => ({ redeemCode, checkSession, currentState, recordError }),
  });
  return {
    readRoute,
    prepare,
    idFromName,
    redeemCode,
    checkSession,
    currentState,
    recordError,
    env: {
      APP_ENV: "test",
      AVALON_REGION: "global",
      ARTIFACT_SERVING_DOMAIN: "rallyusercontent.test",
      ARTIFACT_HOSTS: hosts,
      PLATFORM_DB: createTestD1Database({
        prepare,
      }),
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({
        get: async (key: string) => {
          const bytes = key.endsWith("/.rally/social-preview.png")
            ? PREVIEW_BYTES
            : new TextEncoder().encode(key.endsWith("/pricing.html") ? PRICING_HTML : INDEX_HTML);
          return {
            body: bytes,
            text: async () => new TextDecoder().decode(bytes),
          };
        },
      }),
      ...(options.loaderFetch
        ? {
            ARTIFACT_LOADER: {
              get: () => ({
                getEntrypoint: () => ({ fetch: options.loaderFetch! }),
              }),
            },
          }
        : {}),
    },
  };
}

describe("artifact serving hostname routes", () => {
  /**
   * A same-origin redemption: the first request of an open that resolves the
   * host. The bootstrap before it is served without one.
   */
  function redeem(host: string): Request {
    return new Request(`https://${host}.rallyusercontent.test/__rally/redeem`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
      },
      body: "code=one-shot",
    });
  }

  it("resolves a readable stub to the existing UUID-addressed supervisor", async () => {
    const { env, readRoute, idFromName, redeemCode } = fixture({
      hostname_stub: STUB,
      artifact_id: ARTIFACT,
      region: "global",
    });
    await artifactWorker.fetch(redeem(`${STUB}-g`), env, context());

    expect(readRoute).toHaveBeenCalledOnce();
    expect(idFromName).toHaveBeenCalledWith(expect.stringContaining(ARTIFACT));
    expect(redeemCode).toHaveBeenCalledWith("one-shot");
  });

  it("serves the bootstrap without reading the route, for any host", async () => {
    // The first step of every open: a D1 read here only delays it, and a 404
    // for an unknown host would tell it apart from a known one.
    const { env, readRoute, idFromName } = fixture(null);
    const response = await artifactWorker.fetch(new Request(
      `https://${STUB}-g.rallyusercontent.test/__rally/open`,
    ), env, context());

    expect(response.status).toBe(200);
    expect(readRoute).not.toHaveBeenCalled();
    expect(idFromName).not.toHaveBeenCalled();
  });

  it("keeps the Rally bootstrap same-origin without weakening artifact responses", async () => {
    const { env, redeemCode } = fixture({
      hostname_stub: STUB,
      artifact_id: ARTIFACT,
      region: "global",
    });
    const origin = `https://${STUB}-g.rallyusercontent.test`;

    const bootstrap = await artifactWorker.fetch(
      new Request(`${origin}/__rally/open`),
      env,
      context(),
    );
    const missingArtifact = await artifactWorker.fetch(
      new Request(`${origin}/`),
      env,
      context(),
    );
    const refusedOpaqueRedeem = await artifactWorker.fetch(
      new Request(`${origin}/__rally/redeem`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "null",
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "same-origin",
        },
        body: "code=unused",
      }),
      env,
      context(),
    );

    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.get("referrer-policy")).toBe("same-origin");
    expect(bootstrap.headers.get("content-security-policy")).toContain("form-action 'self'");
    expect(bootstrap.headers.get("x-content-type-options")).toBe("nosniff");
    expect(bootstrap.headers.get("x-frame-options")).toBe("DENY");
    expect(bootstrap.headers.get("cache-control")).toContain("private");
    expect(missingArtifact.status).toBe(404);
    expect(missingArtifact.headers.get("referrer-policy")).toBe("no-referrer");
    expect(refusedOpaqueRedeem.status).toBe(403);
    expect(redeemCode).not.toHaveBeenCalled();
  });

  it("lets only the browser client frame an artifact, and partitions a framed viewer session", async () => {
    const { env, redeemCode } = fixture({ hostname_stub: STUB, artifact_id: ARTIFACT, region: "global" });
    const origin = `https://${STUB}-g.rallyusercontent.test`;
    redeemCode.mockResolvedValue({ session: "viewer-session", expiresAt: Date.now() + 60_000 });
    const framing = { ...env, BROWSER_APP_ORIGIN: "https://app.example.test" };
    const redeem = (dest: string) => artifactWorker.fetch(new Request(`${origin}/__rally/redeem`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin,
        "sec-fetch-dest": dest, "sec-fetch-mode": "navigate", "sec-fetch-site": "same-origin" },
      body: "code=one-use",
    }), framing, context());

    const bootstrap = await artifactWorker.fetch(new Request(`${origin}/__rally/open`), framing, context());
    expect(bootstrap.headers.get("content-security-policy")).toContain("frame-ancestors https://app.example.test");
    expect(bootstrap.headers.get("content-security-policy")).not.toContain("frame-ancestors 'none'");
    expect(bootstrap.headers.get("x-frame-options")).toBeNull();

    const framed = await redeem("iframe");
    expect(framed.status).toBe(303);
    expect(framed.headers.get("set-cookie")).toContain("SameSite=None");
    expect(framed.headers.get("set-cookie")).toContain("Partitioned");
    const topLevel = await redeem("document");
    expect(topLevel.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(topLevel.headers.get("set-cookie")).not.toContain("Partitioned");

    // Without a configured browser origin nothing may frame an artifact.
    const unframed = await artifactWorker.fetch(new Request(`${origin}/__rally/open`), env, context());
    expect(unframed.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(unframed.headers.get("x-frame-options")).toBe("DENY");
    // A frame one artifact moves to another is refused before anything is served.
    const hop = await artifactWorker.fetch(new Request(`${origin}/__rally/open`, { headers: {
      "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "same-site" } }), framing, context());
    expect(hop.status).toBe(403);
    // Rally's own framed load comes from the app, cross-site, and is served.
    const fromApp = await artifactWorker.fetch(new Request(`${origin}/__rally/open`, { headers: {
      "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site" } }), framing, context());
    expect(fromApp.status).toBe(200);
    // Nor may anything when the configured origin cannot be read; serving goes on.
    const misconfigured = await artifactWorker.fetch(new Request(`${origin}/__rally/open`), { ...env, BROWSER_APP_ORIGIN: "not a url" }, context());
    expect(misconfigured.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(misconfigured.headers.get("x-frame-options")).toBe("DENY");
  });

  it("serves a public artifact to a crawler without a Rally session", async () => {
    const { env, checkSession, currentState } = fixture({
      hostname_stub: STUB,
      artifact_id: ARTIFACT,
      region: "global",
    }, {
      currentStateResult: {
        artifactId: ARTIFACT,
        workspaceId: "00000000-0000-7000-8000-0000000000c1",
        workstreamId: "00000000-0000-7000-8000-0000000000d1",
        resourceId: "00000000-0000-7000-8000-0000000000e1",
        version: 1,
        mode: "static",
        stateful: false,
        manifest: MANIFEST,
      },
    });

    const response = await artifactWorker.fetch(
      new Request(`https://${STUB}-g.rallyusercontent.test/`),
      env,
      context(),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("<title>Public artifact</title>");
    expect(body).toContain(`property="og:title" content="Public artifact"`);
    expect(body).toContain(
      `property="og:image" content="https://${STUB}-g.rallyusercontent.test/.rally/social-preview.png?v=1"`,
    );
    expect(body).toContain(`name="twitter:card" content="summary_large_image"`);
    expect(response.headers.get("content-security-policy")).toBeTruthy();
    expect(checkSession).not.toHaveBeenCalled();
    expect(currentState).toHaveBeenCalledOnce();

    const image = await artifactWorker.fetch(
      new Request(`https://${STUB}-g.rallyusercontent.test/.rally/social-preview.png?v=1`),
      env,
      context(),
    );
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(PREVIEW_BYTES);

    const pricing = await artifactWorker.fetch(
      new Request(`https://${STUB}-g.rallyusercontent.test/pricing.html`),
      env,
      context(),
    );
    const pricingBody = await pricing.text();
    expect(pricingBody).toBe(PRICING_HTML);
    expect(pricingBody).not.toContain(`content="Public artifact"`);
  });

  it("serves the annotation script without reading the route, for any host", async () => {
    const { env, readRoute, idFromName } = fixture(null);
    const response = await artifactWorker.fetch(new Request(
      `https://${STUB}-g.rallyusercontent.test${artifactAnnotationScriptPath("https://app.example.test")}`,
    ), { ...env, BROWSER_APP_ORIGIN: "https://app.example.test" }, context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(readRoute).not.toHaveBeenCalled();
    expect(idFromName).not.toHaveBeenCalled();
  });

  it("puts the annotation script first in a Rally viewer's page and nowhere in the public one", async () => {
    const state = {
      artifactId: ARTIFACT,
      workspaceId: "00000000-0000-7000-8000-0000000000c1",
      workstreamId: "00000000-0000-7000-8000-0000000000d1",
      resourceId: "00000000-0000-7000-8000-0000000000e1",
      version: 1,
      mode: "static",
      stateful: false,
      manifest: MANIFEST,
    };
    const { env } = fixture({ hostname_stub: STUB, artifact_id: ARTIFACT, region: "global" }, {
      checkSessionResult: { ok: true, viewerId: "user-1", viewerName: "Ada", version: 1, mode: "static", stateful: false, manifest: MANIFEST },
      currentStateResult: state,
    });
    const framing = { ...env, BROWSER_APP_ORIGIN: "https://app.example.test" };
    const origin = `https://${STUB}-g.rallyusercontent.test`;
    const path = artifactAnnotationScriptPath("https://app.example.test");

    // The desktop: a top-level navigation carrying the viewer cookie.
    const viewer = await (await artifactWorker.fetch(new Request(`${origin}/`, { headers: {
      cookie: "__rally_artifact_session=secret", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none",
    } }), framing, context())).text();
    expect(viewer.indexOf(`<head><script src="${path}"></script><title>`)).toBeGreaterThan(-1);
    expect(viewer).toContain(`property="og:title" content="Public artifact"`);

    // The browser client's frame, without the cookie Safari refuses.
    const framed = await (await artifactWorker.fetch(new Request(`${origin}/pricing.html`, { headers: {
      "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site",
    } }), framing, context())).text();
    expect(framed.startsWith(`<!doctype html><html><head><script src="${path}"></script>`)).toBe(true);

    // A public read, and a frame nobody configured an app for, get the page as published.
    const crawler = await (await artifactWorker.fetch(new Request(`${origin}/pricing.html`), framing, context())).text();
    expect(crawler).toBe(PRICING_HTML);
    const unconfigured = await (await artifactWorker.fetch(new Request(`${origin}/pricing.html`, { headers: {
      "sec-fetch-dest": "iframe", "sec-fetch-mode": "navigate", "sec-fetch-site": "cross-site",
    } }), env, context())).text();
    expect(unconfigured).toBe(PRICING_HTML);
  });

  it("does not attach a Rally session to a cross-site public read", async () => {
    const forwarded = vi.fn(async (request: Request) => Response.json({
      cookie: request.headers.get("cookie"),
      viewerId: request.headers.get("x-rally-viewer-id"),
      viewerName: request.headers.get("x-rally-viewer-name"),
    }));
    const { env, checkSession, currentState } = fixture({
      hostname_stub: STUB,
      artifact_id: ARTIFACT,
      region: "global",
    }, {
      currentStateResult: {
        artifactId: ARTIFACT,
        workspaceId: "00000000-0000-7000-8000-0000000000c1",
        workstreamId: "00000000-0000-7000-8000-0000000000d1",
        resourceId: "00000000-0000-7000-8000-0000000000e1",
        version: 1,
        mode: "active",
        stateful: false,
        manifest: ACTIVE_MANIFEST,
      },
      loaderFetch: forwarded,
    });

    const response = await artifactWorker.fetch(new Request(
      `https://${STUB}-g.rallyusercontent.test/`,
      {
        headers: {
          cookie: "__rally_artifact_session=secret",
          origin: "https://other-g.rallyusercontent.test",
          "sec-fetch-site": "same-site",
          "x-rally-viewer-id": "forged",
          "x-rally-viewer-name": "Forged",
        },
      },
    ), env, context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      cookie: null,
      viewerId: null,
      viewerName: null,
    });
    expect(forwarded).toHaveBeenCalledOnce();
    expect(checkSession).not.toHaveBeenCalled();
    expect(currentState).toHaveBeenCalledOnce();
  });

  it("keeps prior versions behind a valid Rally viewer session", async () => {
    const { env, checkSession } = fixture({
      hostname_stub: STUB,
      artifact_id: ARTIFACT,
      region: "global",
    }, {
      currentStateResult: {
        artifactId: ARTIFACT,
        workspaceId: "00000000-0000-7000-8000-0000000000c1",
        workstreamId: "00000000-0000-7000-8000-0000000000d1",
        resourceId: "00000000-0000-7000-8000-0000000000e1",
        version: 2,
        mode: "static",
        stateful: false,
        manifest: { ...MANIFEST, artifactVersion: 2 },
      },
    });

    const response = await artifactWorker.fetch(
      new Request(`https://${STUB}-g.rallyusercontent.test/__rally/v1/`),
      env,
      context(),
    );

    expect(response.status).toBe(401);
    expect(checkSession).not.toHaveBeenCalled();
  });

  it("fails a stateless active site closed when its handler cannot run", async () => {
    const { env } = fixture({
      hostname_stub: STUB,
      artifact_id: ARTIFACT,
      region: "global",
    }, {
      currentStateResult: {
        artifactId: ARTIFACT,
        workspaceId: "00000000-0000-7000-8000-0000000000c1",
        workstreamId: "00000000-0000-7000-8000-0000000000d1",
        resourceId: "00000000-0000-7000-8000-0000000000e1",
        version: 1,
        mode: "active",
        stateful: false,
        manifest: ACTIVE_MANIFEST,
      },
    });

    const response = await artifactWorker.fetch(
      new Request(`https://${STUB}-g.rallyusercontent.test/`),
      env,
      context(),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(INDEX_HTML);
  });

  it("attaches trusted identity only after validating a same-origin Rally session", async () => {
    const forwarded = vi.fn(async (request: Request) => Response.json({
      cookie: request.headers.get("cookie"),
      viewerId: request.headers.get("x-rally-viewer-id"),
      viewerName: request.headers.get("x-rally-viewer-name"),
    }));
    const { env, checkSession, currentState } = fixture({
      hostname_stub: STUB,
      artifact_id: ARTIFACT,
      region: "global",
    }, {
      checkSessionResult: {
        ok: true,
        viewerId: "user-1",
        viewerName: "Ada Lovelace",
        version: 1,
        mode: "active",
        stateful: false,
        manifest: ACTIVE_MANIFEST,
      },
      loaderFetch: forwarded,
    });

    const response = await artifactWorker.fetch(new Request(
      `https://${STUB}-g.rallyusercontent.test/`,
      {
        headers: {
          cookie: "__rally_artifact_session=secret",
          origin: `https://${STUB}-g.rallyusercontent.test`,
          "sec-fetch-site": "same-origin",
        },
      },
    ), env, context());

    expect(await response.json()).toEqual({
      cookie: null,
      viewerId: "user-1",
      viewerName: "Ada%20Lovelace",
    });
    expect(checkSession).toHaveBeenCalledWith("secret");
    expect(currentState).not.toHaveBeenCalled();
  });

  it("falls back to the public representation when identity validation is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env, checkSession, currentState } = fixture({
      hostname_stub: STUB,
      artifact_id: ARTIFACT,
      region: "global",
    }, {
      checkSessionError: new Error("visibility unavailable"),
      currentStateResult: {
        artifactId: ARTIFACT,
        workspaceId: "00000000-0000-7000-8000-0000000000c1",
        workstreamId: "00000000-0000-7000-8000-0000000000d1",
        resourceId: "00000000-0000-7000-8000-0000000000e1",
        version: 1,
        mode: "static",
        stateful: false,
        manifest: MANIFEST,
      },
    });

    const response = await artifactWorker.fetch(new Request(
      `https://${STUB}-g.rallyusercontent.test/`,
      {
        headers: {
          cookie: "__rally_artifact_session=stale",
          origin: `https://${STUB}-g.rallyusercontent.test`,
          "sec-fetch-site": "same-origin",
        },
      },
    ), env, context());

    expect(response.status).toBe(200);
    expect(checkSession).toHaveBeenCalledOnce();
    expect(currentState).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: "artifact_viewer_session_check_failed",
      artifact_id: ARTIFACT,
    }));
    warn.mockRestore();
  });

  it("falls back to public without identity after its viewer session is revoked", async () => {
    const { env, checkSession, currentState } = fixture({
      hostname_stub: STUB,
      artifact_id: ARTIFACT,
      region: "global",
    }, {
      checkSessionResult: { ok: false, reason: "no_session" },
      currentStateResult: {
        artifactId: ARTIFACT,
        workspaceId: "00000000-0000-7000-8000-0000000000c1",
        workstreamId: "00000000-0000-7000-8000-0000000000d1",
        resourceId: "00000000-0000-7000-8000-0000000000e1",
        version: 1,
        mode: "static",
        stateful: false,
        manifest: MANIFEST,
      },
    });
    const origin = `https://${STUB}-g.rallyusercontent.test`;

    const response = await artifactWorker.fetch(new Request(origin, {
      headers: {
        cookie: "__rally_artifact_session=revoked",
        origin,
        "sec-fetch-site": "same-origin",
      },
    }), env, context());

    expect(response.status).toBe(200);
    expect(checkSession).toHaveBeenCalledOnce();
    expect(currentState).toHaveBeenCalledOnce();
  });

  it("does not let anonymous failures evict the participant error ring", async () => {
    const { env, recordError } = fixture({
      hostname_stub: STUB,
      artifact_id: ARTIFACT,
      region: "global",
    }, {
      currentStateResult: {
        artifactId: ARTIFACT,
        workspaceId: "00000000-0000-7000-8000-0000000000c1",
        workstreamId: "00000000-0000-7000-8000-0000000000d1",
        resourceId: "00000000-0000-7000-8000-0000000000e1",
        version: 1,
        mode: "active",
        stateful: false,
        manifest: ACTIVE_MANIFEST,
      },
      loaderFetch: async () => { throw new Error("public failure"); },
    });

    const response = await artifactWorker.fetch(
      new Request(`https://${STUB}-g.rallyusercontent.test/throws`),
      env,
      context(),
    );

    expect(response.status).toBe(500);
    expect(recordError).not.toHaveBeenCalled();
  });

  it("returns the neutral 404 when the route is absent or crosses regions", async () => {
    const absent = fixture(null);
    expect((await artifactWorker.fetch(redeem(`${STUB}-g`), absent.env, context())).status).toBe(404);
    expect(absent.idFromName).not.toHaveBeenCalled();

    const crossed = fixture({
      hostname_stub: STUB,
      artifact_id: ARTIFACT,
      region: "enterprise",
    });
    expect((await artifactWorker.fetch(redeem(`${STUB}-g`), crossed.env, context())).status).toBe(404);
    expect(crossed.idFromName).not.toHaveBeenCalled();
  });

  it("keeps legacy UUID links working without a route lookup", async () => {
    const { env, readRoute, redeemCode } = fixture(null);
    await artifactWorker.fetch(redeem(`${ARTIFACT}-g`), env, context());
    expect(readRoute).not.toHaveBeenCalled();
    expect(redeemCode).toHaveBeenCalledWith("one-shot");
  });
});

describe("signing in from a site's own URL", () => {
  const BROWSER = "https://app.rally.test";
  const origin = `https://${STUB}-g.rallyusercontent.test`;
  const route = { hostname_stub: STUB, artifact_id: ARTIFACT, region: "global" };
  const signedOutState = {
    artifactId: ARTIFACT,
    workspaceId: "00000000-0000-7000-8000-0000000000c1",
    workstreamId: "00000000-0000-7000-8000-0000000000d1",
    resourceId: "00000000-0000-7000-8000-0000000000e1",
    version: 1,
    mode: "active",
    stateful: false,
    manifest: ACTIVE_MANIFEST,
  };
  /** A protected site's handler, as the skill teaches it: 401 with no viewer. */
  const protectedHandler = async (request: Request) => request.headers.get("x-rally-viewer-id")
    ? new Response("hello")
    : new Response("Open this site from Rally.", { status: 401 });
  const pageLoad = (path: string) => new Request(`${origin}${path}`, {
    headers: { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "sec-fetch-site": "none" },
  });

  it("sends the sign-in route to the browser client's site page without reading the route", async () => {
    const { env, readRoute } = fixture(route);
    const response = await artifactWorker.fetch(
      new Request(`${origin}/__rally/sign-in?return=${encodeURIComponent("/rsvp?week=2")}`),
      { ...env, BROWSER_APP_ORIGIN: BROWSER },
      context(),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location"))
      .toBe(`${BROWSER}/app/sites/global/${STUB}/%2Frsvp%3Fweek%3D2`);
    expect(readRoute).not.toHaveBeenCalled();
  });

  it("turns a protected site's 401 into sign-in for a page load, and only for one", async () => {
    const { env } = fixture(route, { currentStateResult: signedOutState, loaderFetch: protectedHandler });
    const withBrowser = { ...env, BROWSER_APP_ORIGIN: BROWSER };

    const page = await artifactWorker.fetch(pageLoad("/journal?day=3"), withBrowser, context());
    expect(page.status).toBe(303);
    expect(page.headers.get("location")).toBe(`${BROWSER}/app/sites/global/${STUB}/%2Fjournal%3Fday%3D3`);

    // A script's fetch keeps the handler's own 401, so the page can show its
    // own sign-in prompt rather than receiving a redirect it cannot follow.
    const script = await artifactWorker.fetch(new Request(`${origin}/api/entries`, {
      headers: { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", "sec-fetch-site": "same-origin" },
    }), withBrowser, context());
    expect(script.status).toBe(401);

    // With no browser client configured there is nowhere to send them.
    expect((await artifactWorker.fetch(pageLoad("/"), env, context())).status).toBe(401);
  });

  it("shows a signed-in viewer the handler's own 401, rather than sign-in again", async () => {
    const refuseEveryone = async () => new Response("Not for you.", { status: 401 });
    const { env } = fixture(route, {
      checkSessionResult: {
        ok: true,
        viewerId: "user-1",
        viewerName: "Ada",
        version: 1,
        mode: "active",
        stateful: false,
        manifest: ACTIVE_MANIFEST,
      },
      loaderFetch: refuseEveryone,
    });
    const signedIn = new Request(`${origin}/`, {
      headers: {
        cookie: "__rally_artifact_session=secret",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-site": "none",
      },
    });

    const response = await artifactWorker.fetch(signedIn, { ...env, BROWSER_APP_ORIGIN: BROWSER }, context());
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not send a viewer to sign in when their session could not be checked", async () => {
    // Signing in again would return to the same failed check, so the person
    // would go round sign-in forever.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { env } = fixture(route, {
      checkSessionError: new Error("supervisor unavailable"),
      currentStateResult: signedOutState,
      loaderFetch: protectedHandler,
    });
    const withCookie = new Request(`${origin}/`, {
      headers: {
        cookie: "__rally_artifact_session=secret",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
        "sec-fetch-site": "none",
      },
    });

    const response = await artifactWorker.fetch(withCookie, { ...env, BROWSER_APP_ORIGIN: BROWSER }, context());
    expect(response.status).toBe(401);
    expect(response.headers.get("location")).toBeNull();
    warn.mockRestore();
  });

  it("answers the sign-in route with the neutral 404 when the browser origin is not a URL", async () => {
    const { env } = fixture(route);
    const response = await artifactWorker.fetch(
      new Request(`${origin}/__rally/sign-in`),
      { ...env, BROWSER_APP_ORIGIN: "not a url" },
      context(),
    );
    expect(response.status).toBe(404);
  });

  it("returns a redeemed viewer to the path they asked for, and never off the site", async () => {
    const { env, redeemCode } = fixture(route);
    redeemCode.mockResolvedValue({ session: "s".repeat(43), expiresAt: Date.now() + 60_000 });
    const redeemWith = (back: string) => artifactWorker.fetch(new Request(`${origin}/__rally/redeem`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({ code: "one-shot", return: back }).toString(),
    }), env, context());

    expect((await redeemWith("/journal?day=3")).headers.get("location")).toBe("/journal?day=3");
    expect((await redeemWith("https://evil.example/")).headers.get("location")).toBe("/");
    expect((await redeemWith("//evil.example/")).headers.get("location")).toBe("/");
  });
});

describe("submissions from people who are not signed in", () => {
  const origin = `https://${STUB}-g.rallyusercontent.test`;
  const route = { hostname_stub: STUB, artifact_id: ARTIFACT, region: "global" };
  const state = {
    artifactId: ARTIFACT,
    workspaceId: "00000000-0000-7000-8000-0000000000c1",
    workstreamId: "00000000-0000-7000-8000-0000000000d1",
    resourceId: "00000000-0000-7000-8000-0000000000e1",
    version: 1,
    mode: "active",
    stateful: false,
    manifest: ACTIVE_MANIFEST,
  };
  const vote = (headers: Record<string, string>) => new Request(`${origin}/api/vote`, {
    method: "POST",
    headers: { "x-rally-viewer-id": "forged", ...headers },
    body: "choice=yes",
  });

  it("reach every site's handler, from its own page or another site, with no identity", async () => {
    const seen: (string | null)[] = [];
    const forwarded = vi.fn(async (request: Request) => {
      seen.push(request.headers.get("x-rally-viewer-id"));
      return Response.json({ ok: true });
    });
    const { env } = fixture(route, { currentStateResult: state, loaderFetch: forwarded });

    const own = await artifactWorker.fetch(vote({ origin, "sec-fetch-site": "same-origin" }), env, context());
    const elsewhere = await artifactWorker.fetch(vote({ origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" }), env, context());

    expect([own.status, elsewhere.status]).toEqual([200, 200]);
    // A forged viewer header is stripped, so the handler decides with no identity.
    expect(seen).toEqual([null, null]);
  });
  it("never carry a signed-in viewer's identity from a sibling artifact", async () => {
    // A sibling artifact is same-site, so the viewer's Lax cookie rides along
    // on its POST. The handler must still see an anonymous request.
    const forwarded = vi.fn(async (request: Request) => Response.json({
      viewerId: request.headers.get("x-rally-viewer-id"),
      cookie: request.headers.get("cookie"),
    }));
    const { env, checkSession } = fixture(route, {
      currentStateResult: state,
      checkSessionResult: {
        ok: true,
        viewerId: "user-1",
        viewerName: "Ada",
        version: 1,
        mode: "active",
        stateful: false,
        manifest: ACTIVE_MANIFEST,
      },
      loaderFetch: forwarded,
    });

    const response = await artifactWorker.fetch(vote({
      cookie: "__rally_artifact_session=secret",
      origin: "https://other-g.rallyusercontent.test",
      "sec-fetch-site": "same-site",
    }), env, context());

    expect(await response.json()).toEqual({ viewerId: null, cookie: null });
    expect(checkSession).not.toHaveBeenCalled();
  });
});
