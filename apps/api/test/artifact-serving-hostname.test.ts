/** Public hostname routing at the isolated artifact Worker boundary. */
import { asArtifactId, type ArtifactManifest } from "@rally/contracts";
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
  it("resolves a readable stub to the existing UUID-addressed supervisor", async () => {
    const { env, readRoute, idFromName } = fixture({
      hostname_stub: STUB,
      artifact_id: ARTIFACT,
      region: "global",
    });
    const response = await artifactWorker.fetch(new Request(
      `https://${STUB}-g.rallyusercontent.test/__rally/open`,
    ), env, context());

    expect(response.status).toBe(200);
    expect(readRoute).toHaveBeenCalledOnce();
    expect(idFromName).toHaveBeenCalledWith(expect.stringContaining(ARTIFACT));
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

  it("keeps unsafe methods behind a valid Rally viewer session", async () => {
    const forwarded = vi.fn(async () => Response.json({ ok: true }));
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
    const origin = `https://${STUB}-g.rallyusercontent.test`;

    const response = await artifactWorker.fetch(new Request(`${origin}/api/vote`, {
      method: "POST",
      headers: {
        origin,
        "sec-fetch-site": "same-origin",
      },
    }), env, context());

    expect(response.status).toBe(401);
    expect(checkSession).not.toHaveBeenCalled();
    expect(currentState).toHaveBeenCalledOnce();
    expect(forwarded).not.toHaveBeenCalled();
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
    expect(checkSession).toHaveBeenCalledWith("secret", 0);
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

  it("falls back to public without identity after work-stream visibility is lost", async () => {
    const { env, checkSession, currentState } = fixture({
      hostname_stub: STUB,
      artifact_id: ARTIFACT,
      region: "global",
    }, {
      checkSessionResult: { ok: false, reason: "not_visible" },
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
    expect((await artifactWorker.fetch(new Request(
      `https://${STUB}-g.rallyusercontent.test/__rally/open`,
    ), absent.env, context())).status).toBe(404);
    expect(absent.idFromName).not.toHaveBeenCalled();

    const crossed = fixture({
      hostname_stub: STUB,
      artifact_id: ARTIFACT,
      region: "eu",
    });
    expect((await artifactWorker.fetch(new Request(
      `https://${STUB}-g.rallyusercontent.test/__rally/open`,
    ), crossed.env, context())).status).toBe(404);
    expect(crossed.idFromName).not.toHaveBeenCalled();
  });

  it("keeps legacy UUID links working without a route lookup", async () => {
    const { env, readRoute } = fixture(null);
    const response = await artifactWorker.fetch(new Request(
      `https://${ARTIFACT}-g.rallyusercontent.test/__rally/open`,
    ), env, context());
    expect(response.status).toBe(200);
    expect(readRoute).not.toHaveBeenCalled();
  });
});
