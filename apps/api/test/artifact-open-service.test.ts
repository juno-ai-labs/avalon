import { ARTIFACT_RESERVED_PREFIX, asUserId, asWorkspaceId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/lib/api-error";
import { ArtifactOpenService } from "../src/services/artifact-open-service";
import type { AuthContext, Env } from "../src/env";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";

const WORKSPACE = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const WORKSTREAM = "3f2504e0-4f89-41d3-9a0c-0305e82c3302";
const RESOURCE = "3f2504e0-4f89-41d3-9a0c-0305e82c3303";
const ARTIFACT = "3f2504e0-4f89-41d3-9a0c-0305e82c3304";
const USER = "3f2504e0-4f89-41d3-9a0c-0305e82c3305";

interface Fixture {
  registryRow?: Record<string, unknown> | null;
  canRead?: boolean;
  displayName?: string | null;
}

/**
 * D1, the work stream, and the artifact object all stand in.
 *
 * What is under test is the *authorization shape* — which authority answers
 * which question, and what a refusal looks like — not the storage beneath it.
 * The visibility answer this service depends on is proven against a real
 * `WorkstreamDO` in the workers suite.
 */
function fixture(input: Fixture = {}) {
  const openForViewer = vi.fn(async () => ({ code: "c".repeat(64) }));
  const canReadWorkstream = vi.fn(async () => input.canRead ?? true);
  const other = vi.fn(async (): Promise<unknown> => null);
  const database = createTestD1Database({
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (sql.includes("artifact_registry")) {
            return input.registryRow === undefined
              ? {
                  artifact_id: ARTIFACT,
                  workstream_id: WORKSTREAM,
                  mode: "active",
                  stateful: 1,
                }
              : input.registryRow;
          }
          if (sql.includes("FROM users")) {
            return { name: input.displayName === undefined ? "Ada" : input.displayName };
          }
          return other();
        },
      }),
    }),
  });
  const workstreamStub = { canReadWorkstream };
  const workstreams: Env["WORKSTREAM_DOS"] = createCloudflareTestBinding<Env["WORKSTREAM_DOS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => workstreamStub,
    jurisdiction: (): Env["WORKSTREAM_DOS"] => workstreams,
  });
  const hostStub = { openForViewer, readErrors: async () => [] };
  const hosts: Env["ARTIFACT_HOSTS"] = createCloudflareTestBinding<Env["ARTIFACT_HOSTS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => hostStub,
    jurisdiction: (): Env["ARTIFACT_HOSTS"] => hosts,
  });
  const env = createTestEnv({
    DB: database,
    AVALON_REGION: "global",
    APP_ENV: "test",
    ARTIFACT_SERVING_DOMAIN: "rallyusercontent.test",
    WORKSTREAM_DOS: workstreams,
    ARTIFACT_HOSTS: hosts,
  });
  const auth: AuthContext = {
    userId: asUserId(USER),
    workspaceId: asWorkspaceId(WORKSPACE),
    sessionId: "session-one",
    region: "global",
    role: "member",
    analyticsWorkspaceId: null,
  };
  return { service: new ArtifactOpenService(env, auth), openForViewer, canReadWorkstream };
}

async function refusal(run: () => Promise<unknown>): Promise<ApiError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected an ApiError");
}

describe("minting access to a live artifact", () => {
  it("puts the code in the fragment and nowhere else", async () => {
    // A fragment is never sent to a server, which is what keeps the code out of
    // the invocation log, Logpush, and every trace span.
    const { service } = fixture();
    const result = await service.open(RESOURCE);
    const [beforeHash, afterHash] = result.openUrl.split("#");
    expect(beforeHash).toBe(`https://${ARTIFACT}-g.rallyusercontent.test${ARTIFACT_RESERVED_PREFIX}/open`);
    expect(afterHash).toBe("c".repeat(64));
    expect(beforeHash).not.toContain("c".repeat(64));
  });

  it("returns a canonical URL carrying no code at all", async () => {
    // This is the address people copy and cite, and it is useful precisely
    // because it grants nothing.
    const { service } = fixture();
    const result = await service.open(RESOURCE);
    expect(result.canonicalUrl).toBe(`https://${ARTIFACT}-g.rallyusercontent.test`);
    expect(result.canonicalUrl).not.toContain("#");
  });

  it("carries the session so one revoked window does not close the others", async () => {
    const { service, openForViewer } = fixture();
    await service.open(RESOURCE);
    expect(openForViewer).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER,
      appSessionId: "session-one",
      displayName: "Ada",
    }));
  });

  it("sends an empty display name rather than omitting it", async () => {
    // Absence of the header is reserved to mean an anonymous viewer, so a
    // missing profile must not accidentally claim that meaning.
    const { service, openForViewer } = fixture({ displayName: null });
    await service.open(RESOURCE);
    expect(openForViewer).toHaveBeenCalledWith(expect.objectContaining({ displayName: "" }));
  });
});

describe("who is refused, and how indistinguishably", () => {
  it("asks the work stream rather than inferring visibility", async () => {
    // Work-stream visibility is not a D1 fact — it lives in that object's own
    // SQL — so no query here could answer it.
    const { service, canReadWorkstream } = fixture();
    await service.open(RESOURCE);
    expect(canReadWorkstream).toHaveBeenCalledWith(USER);
  });

  it("refuses, and mints nothing, when the work stream says no", async () => {
    const { service, openForViewer } = fixture({ canRead: false });
    const error = await refusal(() => service.open(RESOURCE));
    expect(error.status).toBe(404);
    expect(openForViewer).not.toHaveBeenCalled();
  });

  it("answers a nonexistent artifact and an invisible one identically", async () => {
    // Distinguishing them would leak which artifacts exist in work streams the
    // caller cannot see.
    const missing = await refusal(() => fixture({ registryRow: null }).service.open(RESOURCE));
    const invisible = await refusal(() => fixture({ canRead: false }).service.open(RESOURCE));
    expect(missing.status).toBe(invisible.status);
    expect(missing.code).toBe(invisible.code);
    expect(missing.message).toBe(invisible.message);
  });

  it("refuses to read the error log without the visibility that opening needs", async () => {
    // An error log names request paths a page defines; it is not something to
    // hand to somebody who may not see the work stream.
    const { service } = fixture({ canRead: false });
    const error = await refusal(() => service.errors(RESOURCE));
    expect(error.status).toBe(404);
  });
});
