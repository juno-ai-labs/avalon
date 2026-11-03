import { ARTIFACT_RESERVED_PREFIX, asUserId, asWorkspaceId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/lib/api-error";
import { AuthorizationService, type ResourceReadMetadata } from "../src/services/authorization-service";
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
const HOSTNAME_STUB = "level-luminous-sequential-schrodinger";

interface Fixture {
  registryRow?: ResourceReadMetadata["artifact"];
  canRead?: boolean;
  displayName?: string | null;
  profileError?: Error;
  placementError?: Error;
  page?: { rows?: Record<string, unknown>[]; ok?: boolean };
  /** Who the publishing run ran as: `resources.uploaded_by_user_id`. */
  author?: string | null;
}

/**
 * Unit coverage for URL, profile and inspection orchestration. Canonical
 * authorization is a controlled boundary here; the guest pipeline workerd
 * test proves actual attachment/grant admission and admitted-session behavior.
 */
function fixture(input: Fixture = {}) {
  const readProfile = vi.fn();
  const openForViewer = vi.fn(async () => ({ code: "c".repeat(64) }));
  const metadata: ResourceReadMetadata = { resource: { uploaded_by_user_id: input.author ?? null }, placementAffinity: input.placementError ? null : 'wnam', artifact: input.registryRow === undefined
    ? { artifact_id: ARTIFACT, workstream_id: WORKSTREAM, mode: "active", stateful: 1, hostname_stub: HOSTNAME_STUB }
    : input.registryRow };
  const checkAccess = vi.spyOn(AuthorizationService.prototype, "readResource").mockImplementation(async () => {
    if (input.canRead === false) throw new ApiError(404, "resource_not_found", "Resource not found");
    return metadata;
  });
  const other = vi.fn(async (): Promise<unknown> => null);
  const database = createTestD1Database({
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          if (sql.includes("FROM users")) {
            readProfile();
            if (input.profileError) throw input.profileError;
            return { name: input.displayName === undefined ? "Ada" : input.displayName };
          }
          if (sql.includes("SELECT placement_affinity FROM workspaces")) {
            if (input.placementError) throw input.placementError;
            return { placement_affinity: "wnam" };
          }
          return other();
        },
      }),
    }),
  });
  const hostStub = {
    openForViewer,
    readErrors: async () => [],
    describeData: vi.fn(async () => ({ tables: [] })),
    pageData: vi.fn(async () => (input.page?.ok === false
      ? { ok: false as const, reason: "table_refused" as const, detail: "no such table" }
      : { ok: true as const, rows: input.page?.rows ?? [] })),
  };
  const hosts: Env["ARTIFACT_HOSTS"] = createCloudflareTestBinding<Env["ARTIFACT_HOSTS"]>({
    idFromName: (name: string) => createTestDurableObjectId(name),
    get: () => hostStub,
    jurisdiction: (): Env["ARTIFACT_HOSTS"] => hosts,
  });
  const env = createTestEnv({
    DB: database,
    AVALON_REGION: "global",
    APP_ENV: input.placementError ? "production" : "test",
    ARTIFACT_SERVING_DOMAIN: "rallyusercontent.test",
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
  return { service: new ArtifactOpenService(env, auth), openForViewer, checkAccess, readProfile, metadata, hostStub };
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
    expect(beforeHash).toBe(`https://${HOSTNAME_STUB}-g.rallyusercontent.test${ARTIFACT_RESERVED_PREFIX}/open`);
    expect(afterHash).toBe("c".repeat(64));
    expect(beforeHash).not.toContain("c".repeat(64));
  });

  it("returns a canonical URL carrying no code at all", async () => {
    // This is the address people copy and cite, and it is useful precisely
    // because it grants nothing.
    const { service } = fixture();
    const result = await service.open(RESOURCE);
    expect(result.canonicalUrl).toBe(`https://${HOSTNAME_STUB}-g.rallyusercontent.test`);
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

  it("loads the viewer profile while canonical authorization is in flight", async () => {
    const { service, checkAccess, readProfile, metadata } = fixture();
    let releaseAuthorization: (() => void) | undefined;
    checkAccess.mockImplementationOnce(async () => await new Promise<ResourceReadMetadata>((resolve) => {
      releaseAuthorization = () => resolve(metadata);
    }));

    const opening = service.open(RESOURCE);
    await vi.waitFor(() => {
      expect(checkAccess).toHaveBeenCalledOnce();
      expect(readProfile).toHaveBeenCalledOnce();
    }, { timeout: 1_000 });
    releaseAuthorization?.();
    await expect(opening).resolves.toMatchObject({ artifactId: ARTIFACT });
  });
});

describe("who is refused, and how indistinguishably", () => {
  it("asks canonical resource authorization rather than legacy parent visibility", async () => {
    // The resource check composes identity, grants and attachment exposure.
    const { service, checkAccess } = fixture();
    await service.open(RESOURCE);
    expect(checkAccess).toHaveBeenCalledWith({ workspaceId: WORKSPACE, userId: USER, delegation: null },
      RESOURCE);
  });

  it("refuses, and mints nothing, when resource access is denied", async () => {
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

  it("preserves a concealed denial when the concurrent profile read fails", async () => {
    const error = await refusal(() => fixture({
      canRead: false,
      profileError: new Error("profile unavailable"),
    }).service.open(RESOURCE));
    expect(error).toMatchObject({ status: 404, code: "artifact_not_found" });
  });

  it("preserves a concealed denial when the concurrent placement read fails", async () => {
    const error = await refusal(() => fixture({
      canRead: false,
      placementError: new Error("placement unavailable"),
    }).service.open(RESOURCE));
    expect(error).toMatchObject({ status: 404, code: "artifact_not_found" });
  });

  it("surfaces auxiliary failures after authorization succeeds", async () => {
    await expect(fixture({ profileError: new Error("profile unavailable") }).service.open(RESOURCE))
      .rejects.toThrow("profile unavailable");
    await expect(fixture({ placementError: new Error("placement unavailable") }).service.open(RESOURCE))
      .rejects.toThrow("placement unavailable");
  });

  it("refuses to read the error log without the visibility that opening needs", async () => {
    // An error log names request paths a page defines; it is not something to
    // hand to somebody who may not see the work stream.
    const { service } = fixture({ canRead: false });
    const error = await refusal(() => service.errors(RESOURCE));
    expect(error.status).toBe(404);
  });
});

describe("the CSV an export hands somebody", () => {
  it("quotes every field rather than deciding per value which needs it", async () => {
    // Model-designed columns holding visitor-written values: deciding per field
    // gets one case wrong, and the wrong case breaks a row apart.
    const { service } = fixture({ page: { rows: [{ name: "Ada", note: "plain" }] } });
    const { csv } = await service.pageData(RESOURCE, "rsvps", 0);
    expect(csv).toBe('"name","note"\r\n"Ada","plain"');
  });

  it("keeps a value containing a comma, a quote, or a newline in one field", async () => {
    const { service } = fixture({
      page: { rows: [{ note: 'a,b "c"\nd' }] },
    });
    const { csv } = await service.pageData(RESOURCE, "rsvps", 0);
    expect(csv).toBe('"note"\r\n"a,b ""c""\nd"');
  });

  it("defuses a value a spreadsheet would run as a formula", async () => {
    // A visitor who types this into a sign-up sheet is writing a formula into
    // whoever opens the export.
    const { service } = fixture({
      page: { rows: [{ a: "=1+1", b: "+x", c: "-y", d: "@z" }] },
    });
    const { csv } = await service.pageData(RESOURCE, "rsvps", 0);
    expect(csv.split("\r\n")[1]).toBe(`"'=1+1","'+x","'-y","'@z"`);
  });

  it("writes an empty field for a null rather than the word null", async () => {
    const { service } = fixture({ page: { rows: [{ name: null }] } });
    const { csv } = await service.pageData(RESOURCE, "rsvps", 0);
    expect(csv).toBe('"name"\r\n""');
  });

  it("returns nothing at all for an empty table", async () => {
    const { service } = fixture({ page: { rows: [] } });
    expect((await service.pageData(RESOURCE, "rsvps", 0)).csv).toBe("");
  });

  it("refuses a table the live schema does not have", async () => {
    const { service } = fixture({ page: { ok: false } });
    const error = await refusal(() => service.pageData(RESOURCE, "sqlite_master", 0));
    expect(error.status).toBe(404);
  });

  it("reads nothing for a site that keeps no data", async () => {
    const { service } = fixture({ registryRow: {
      artifact_id: ARTIFACT, workstream_id: WORKSTREAM, mode: "static", stateful: 0,
      hostname_stub: HOSTNAME_STUB,
    } });
    expect(await service.describeData(RESOURCE)).toEqual({ tables: [] });
    expect(await service.pageData(RESOURCE, "rsvps", 0)).toEqual({ rows: [], csv: "" });
  });
});

describe("whose rows the Data view shows", () => {
  it("shows the site's author every row", async () => {
    const { service, hostStub } = fixture({ author: USER });
    await service.describeData(RESOURCE);
    await service.pageData(RESOURCE, "entries", 0);
    expect(hostStub.describeData).toHaveBeenCalledWith({ rows: "all" });
    expect(hostStub.pageData).toHaveBeenCalledWith("entries", 0, 200, { rows: "all" });
  });

  it("shows anyone else only their own rows, including when no author was recorded", async () => {
    for (const author of ["3f2504e0-4f89-41d3-9a0c-0305e82c3399", null]) {
      const { service, hostStub } = fixture({ author });
      await service.describeData(RESOURCE);
      await service.pageData(RESOURCE, "entries", 0);
      expect(hostStub.describeData).toHaveBeenCalledWith({ rows: "viewer", viewerId: USER });
      expect(hostStub.pageData).toHaveBeenCalledWith("entries", 0, 200, { rows: "viewer", viewerId: USER });
    }
  });
});

describe("artifact inspection does not create browser sessions", () => {
  it("authorizes every inspection without minting unused navigation grants", async () => {
    const { service, openForViewer, checkAccess, readProfile } = fixture();
    await service.describeData(RESOURCE);
    await service.pageData(RESOURCE, "votes", 0);
    await service.errors(RESOURCE);
    expect(checkAccess).toHaveBeenCalledTimes(3);
    expect(openForViewer).not.toHaveBeenCalled();
    expect(readProfile).not.toHaveBeenCalled();
  });
});
