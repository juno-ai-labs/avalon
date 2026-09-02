/** Public hostname routing at the isolated artifact Worker boundary. */
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

function context(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

function fixture(route: unknown | null): {
  env: ArtifactServingEnv;
  readRoute: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
  idFromName: ReturnType<typeof vi.fn>;
  redeemCode: ReturnType<typeof vi.fn>;
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
  const hosts = createCloudflareTestBinding<ArtifactServingEnv["ARTIFACT_HOSTS"]>({
    idFromName,
    get: () => ({ redeemCode }),
  });
  return {
    readRoute,
    prepare,
    idFromName,
    redeemCode,
    env: {
      APP_ENV: "test",
      AVALON_REGION: "global",
      ARTIFACT_SERVING_DOMAIN: "rallyusercontent.test",
      ARTIFACT_HOSTS: hosts,
      PLATFORM_DB: createTestD1Database({
        prepare,
      }),
      PAYLOADS: createCloudflareTestBinding<R2Bucket>({}),
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
    const refusedArtifact = await artifactWorker.fetch(
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
    expect(refusedArtifact.headers.get("referrer-policy")).toBe("no-referrer");
    expect(refusedOpaqueRedeem.status).toBe(403);
    expect(redeemCode).not.toHaveBeenCalled();
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
