/** Public hostname routing at the isolated artifact Worker boundary. */
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

import artifactWorker, { type ArtifactServingEnv } from "../src/artifacts/index";
import {
  createCloudflareTestBinding,
  createTestD1Database,
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
  idFromName: ReturnType<typeof vi.fn>;
} {
  const readRoute = vi.fn(async () => route === null ? null : route);
  const idFromName = vi.fn((name: string) => createTestDurableObjectId(name));
  const hosts = createCloudflareTestBinding<ArtifactServingEnv["ARTIFACT_HOSTS"]>({
    idFromName,
    get: () => ({}),
  });
  return {
    readRoute,
    idFromName,
    env: {
      APP_ENV: "test",
      AVALON_REGION: "global",
      ARTIFACT_SERVING_DOMAIN: "rallyusercontent.test",
      ARTIFACT_HOSTS: hosts,
      PLATFORM_DB: createTestD1Database({
        prepare: () => ({ bind: () => ({ first: readRoute }) }),
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
