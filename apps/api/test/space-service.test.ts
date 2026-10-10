/**
 * `SpaceService` against capability doubles for the objects it orders.
 *
 * What is provable here is the *ordering*: which authority is asked first, what
 * is not written when an earlier step refuses, and how a closed refusal code
 * becomes a sentence. The authority behavior itself — the fences, the
 * discoverability test, the membership invariant — is proved against real
 * objects in `test-workers/space-authority.test.ts`, because those are
 * properties of real storage rather than of this file's arithmetic.
 */
import { asSpaceId, asUserId, asWorkspaceId, asWorkstreamId, type SpaceSummary } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import type { WorkspaceSpaceReserveResult } from "../src/durable-objects/workspace-space-protocol";
import type { AuthContext, Env } from "../src/env";
import { ApiError } from "../src/lib/api-error";
import { SpaceService, spaceRefusal } from "../src/services/space-service";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestEnv,
} from "./helpers/cloudflare-test";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000000d1");
const OWNER = asUserId("00000000-0000-7000-8000-0000000000d2");
const MEMBER = asUserId("00000000-0000-7000-8000-0000000000d3");
const SPACE_ID = asSpaceId("00000000-0000-7000-8000-0000000000d4");
const TARGET_SPACE_ID = asSpaceId("00000000-0000-7000-8000-0000000000d7");
const CHANNEL_ID = asWorkstreamId("00000000-0000-7000-8000-0000000000d5");

function summary(overrides: Partial<SpaceSummary> = {}): SpaceSummary {
  return {
    id: SPACE_ID,
    name: "Company",
    iconKey: "briefcase",
    colorKey: "blue",
    scope: "workspace",
    status: "active",
    systemRole: null,
    revision: 3,
    reach: "participant" as const,
    participants: [{ userId: OWNER }, { userId: MEMBER }],
    channelCount: 1,
    defaultResourceIds: [],
    defaultSidekickIds: [],
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

interface WorkspaceDouble {
  spaceSummary: ReturnType<typeof vi.fn>;
  moveSpaceMembership: ReturnType<typeof vi.fn>;
  noteSpaceAudience: ReturnType<typeof vi.fn>;
  admitSpaceCreation: ReturnType<typeof vi.fn>;
  reserveSpace: ReturnType<typeof vi.fn>;
  recordSpaceIntentReceipt: ReturnType<typeof vi.fn>;
  archiveSpace: ReturnType<typeof vi.fn>;
  restoreSpace: ReturnType<typeof vi.fn>;
  addSpaceChannel: ReturnType<typeof vi.fn>;
  removeSpaceChannel: ReturnType<typeof vi.fn>;
  resumeSpaceIntent: ReturnType<typeof vi.fn>;
}

function workspaceDouble(overrides: Partial<WorkspaceDouble> = {}): WorkspaceDouble {
  return {
    spaceSummary: vi.fn(async () => ({ ok: true, space: summary() })),
    moveSpaceMembership: vi.fn(async () => ({ ok: true, moved: false })),
    noteSpaceAudience: vi.fn(async () => ({ ok: true, space: summary({ revision: 4 }) })),
    admitSpaceCreation: vi.fn(async () => ({ ok: true })),
    reserveSpace: vi.fn(async (): Promise<WorkspaceSpaceReserveResult> => ({ ok: true, space: summary(), created: true })),
    recordSpaceIntentReceipt: vi.fn(async () => ({ recorded: true })),
    archiveSpace: vi.fn(async () => ({ ok: true, space: summary({ status: "archived" }) })),
    restoreSpace: vi.fn(async () => ({ ok: true, space: summary() })),
    addSpaceChannel: vi.fn(async () => ({ ok: true, space: summary() })),
    removeSpaceChannel: vi.fn(async () => ({ ok: true, space: summary() })),
    resumeSpaceIntent: vi.fn(async () => ({ ok: true, outcome: "settled" })),
    ...overrides,
  };
}

/**
 * A Channel's conversation that records whether anything reached it. A Space
 * grants no reader, so no Space operation should.
 */
function conversationDouble() {
  return { handleProductRequest: vi.fn(async () => ({ status: 200, bodyJson: "{}" })) };
}

/**
 * A namespace whose `get` always answers with the same stand-in.
 *
 * The double stands in for the *stub*, never for the namespace: the resolver
 * derives an id from a name and then asks for the object, and both halves have
 * to behave for the service under test to reach anything at all.
 */
function namespaceDouble<
  T extends Env["WORKSPACE_DOS"] | Env["SUBSTREAM_AGENTS"],
>(stub: object): T {
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => stub,
    jurisdiction: () => namespace,
  };
  return createCloudflareTestBinding<T>(namespace as never);
}

function serviceEnv(input: {
  workspace: WorkspaceDouble;
  conversation?: object;
  batch?: () => Promise<unknown>;
  revocationQueue?: object;
}): Env {
  const conversation = input.conversation ?? conversationDouble();
  return createTestEnv({
    APP_ENV: "test",
    AVALON_REGION: "global",
    DB: createTestD1Database({
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
        first: async () => null,
      }),
      batch: input.batch ?? (async () => []),
    }),
    WORKSPACE_DOS: namespaceDouble<Env["WORKSPACE_DOS"]>(input.workspace),
    SUBSTREAM_AGENTS: namespaceDouble<Env["SUBSTREAM_AGENTS"]>(conversation),
    ACCESS_REVOCATION_QUEUE: createCloudflareTestBinding<Env["ACCESS_REVOCATION_QUEUE"]>(
      (input.revocationQueue ?? { send: vi.fn(async () => undefined) }) as never,
    ),
  });
}

function auth(role: AuthContext["role"] = "owner"): AuthContext {
  return {
    sessionId: "space-service-test",
    userId: OWNER,
    workspaceId: WORKSPACE_ID,
    region: "global",
    role,
    analyticsWorkspaceId: null,
  } satisfies AuthContext;
}

describe("SpaceService audience changes", () => {
  it("given member Channels, when the participants change, then the authority records it and no Channel is asked", async () => {
    const workspace = workspaceDouble();
    const conversation = conversationDouble();
    const env = serviceEnv({ workspace, conversation });

    await expect(new SpaceService(env, auth()).updateAudience(SPACE_ID, {
      scope: "workspace",
      participantUserIds: [OWNER, MEMBER],
    })).resolves.toMatchObject({ revision: 4 });

    // A Space grants no reader to its Channels, so changing who edits it has
    // nothing to ask a Channel and nothing to carry to one.
    expect(workspace.noteSpaceAudience).toHaveBeenCalledTimes(1);
    expect(conversation.handleProductRequest).not.toHaveBeenCalled();
  });

  it("given an ordinary member, when they remove somebody else, then the role gate refuses it", async () => {
    const workspace = workspaceDouble();

    await expect(new SpaceService(serviceEnv({ workspace }), auth("member")).updateAudience(SPACE_ID, {
      scope: "workspace",
      participantUserIds: [OWNER],
    })).rejects.toMatchObject({ code: "participant_removal_denied", status: 403 });
    expect(workspace.noteSpaceAudience).not.toHaveBeenCalled();
  });
});

describe("SpaceService lifecycle", () => {
  it("refuses an invalid move source before touching either placement", async () => {
    const workspace = workspaceDouble({
      moveSpaceMembership: vi.fn(async () => ({
        ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [],
      })),
    });

    await expect(new SpaceService(serviceEnv({ workspace }), auth()).moveChannel(
      SPACE_ID,
      TARGET_SPACE_ID,
      CHANNEL_ID,
    )).rejects.toMatchObject({ code: "space_not_found" });

    expect(workspace.addSpaceChannel).not.toHaveBeenCalled();
    expect(workspace.removeSpaceChannel).not.toHaveBeenCalled();
  });

  it("moves a Channel in one WorkspaceDO call without reaching the Channel", async () => {
    const log: string[] = [];
    const source = summary();
    const target = summary({ id: TARGET_SPACE_ID, name: "Product", channelCount: 0 });
    const workspace = workspaceDouble({
      moveSpaceMembership: vi.fn(async () => {
        log.push("move");
        return {
          ok: true,
          moved: true,
          source: { ...source, channelCount: 0 },
          target: { ...target, channelCount: 1 },
        };
      }),
    });
    const conversation = conversationDouble();

    await expect(new SpaceService(serviceEnv({ workspace, conversation }), auth())
      .moveChannel(SPACE_ID, TARGET_SPACE_ID, CHANNEL_ID)).resolves.toMatchObject({
      source: { id: SPACE_ID, channelCount: 0 },
      target: { id: TARGET_SPACE_ID, channelCount: 1 },
    });

    expect(log).toEqual(["move"]);
    expect(workspace.moveSpaceMembership).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      userId: OWNER,
      sourceSpaceId: SPACE_ID,
      targetSpaceId: TARGET_SPACE_ID,
      workstreamId: CHANNEL_ID,
    });
    expect(conversation.handleProductRequest).not.toHaveBeenCalled();
  });

  it("given an archive and a restore, when each runs, then it is one WorkspaceDO call as the requesting user", async () => {
    const workspace = workspaceDouble({
      restoreSpace: vi.fn(async () => ({ ok: true, space: summary({ revision: 7 }) })),
    });
    const conversation = conversationDouble();
    const service = new SpaceService(serviceEnv({ workspace, conversation }), auth());

    await expect(service.archive(SPACE_ID)).resolves.toMatchObject({ status: "archived" });
    await expect(service.restore(SPACE_ID)).resolves.toMatchObject({ revision: 7 });

    const request = { workspaceId: WORKSPACE_ID, userId: OWNER, spaceId: SPACE_ID };
    expect(workspace.archiveSpace).toHaveBeenCalledWith(request);
    expect(workspace.restoreSpace).toHaveBeenCalledWith(request);
    expect(conversation.handleProductRequest).not.toHaveBeenCalled();
  });
});

describe("SpaceService membership changes", () => {
  it("given an add, when it runs, then it is one WorkspaceDO call as the requesting session", async () => {
    const workspace = workspaceDouble();
    const conversation = conversationDouble();

    await expect(new SpaceService(serviceEnv({ workspace, conversation }), auth())
      .addChannel(SPACE_ID, CHANNEL_ID)).resolves.toMatchObject({ id: SPACE_ID });

    expect(workspace.addSpaceChannel).toHaveBeenCalledTimes(1);
    expect(workspace.addSpaceChannel).toHaveBeenCalledWith({
      auth: {
        sessionId: "space-service-test",
        userId: OWNER,
        workspaceId: WORKSPACE_ID,
        region: "global",
        role: "owner",
      },
      spaceId: SPACE_ID,
      workstreamId: CHANNEL_ID,
    });
    expect(conversation.handleProductRequest).not.toHaveBeenCalled();
  });

  it("given each kind of refusal WorkspaceDO answers, when it reaches the service, then it is rendered with its own code", async () => {
    const refusals = [
      { about: "space", code: "space_membership_final", subject: "Company", unreachableUserIds: [], blockedWorkstreamIds: [] },
      { about: "channel", code: "space_membership_content_fence", subject: "Hiring plan" },
      { about: "conversation", status: 503, code: "channel_narrowing_publish_failed", message: "Not announced" },
    ];
    const workspace = workspaceDouble({
      removeSpaceChannel: vi.fn(async () => ({ ok: false, refusal: refusals.shift() })),
    });
    const service = new SpaceService(serviceEnv({ workspace }), auth());
    const refused = async () => service.removeChannel(SPACE_ID, CHANNEL_ID).then(() => null, (error: unknown) => error);

    expect(await refused()).toMatchObject({
      status: 409, code: "space_membership_final", message: expect.stringContaining("Company"),
    });
    expect(await refused()).toMatchObject({
      status: 409, code: "space_membership_content_fence", message: expect.stringContaining("Hiring plan"),
    });
    // The Channel conversation's own refusal keeps its code and status, which
    // is what reached the route when the Worker made these calls itself.
    expect(await refused()).toMatchObject({
      status: 503, code: "channel_narrowing_publish_failed", message: "Not announced",
    });
  });
});

describe("SpaceService intent resumption", () => {
  it("given a queued intent, when it resumes, then WorkspaceDO takes it a step at a time until it stops progressing", async () => {
    const steps = [
      { ok: true, outcome: "progressed" },
      { ok: true, outcome: "abandoned", reason: "add_superseded" },
    ];
    const workspace = workspaceDouble({
      resumeSpaceIntent: vi.fn(async () => steps.shift()),
    });
    await expect(new SpaceService(serviceEnv({ workspace }), auth()).resumeIntent("00000000-0000-7000-8000-0000000000e1"))
      .resolves.toEqual({ outcome: "abandoned", reason: "add_superseded" });

    expect(workspace.resumeSpaceIntent).toHaveBeenCalledTimes(2);
    expect(workspace.resumeSpaceIntent).toHaveBeenCalledWith({
      auth: expect.objectContaining({ userId: OWNER }),
      operationId: "00000000-0000-7000-8000-0000000000e1",
    });
    expect(workspace.spaceSummary).not.toHaveBeenCalled();
  });
});

describe("SpaceService creation", () => {
  it("given a caller WorkspaceDO refuses, when they create a Space, then nothing is anchored, bootstrapped or reserved", async () => {
    const workspace = workspaceDouble({
      admitSpaceCreation: vi.fn(async () => ({ ok: false, code: "space_access_denied" })),
    });
    const batch = vi.fn(async () => []);
    const env = serviceEnv({ workspace, batch });

    await expect(new SpaceService(env, auth()).create({
      name: "Company", iconKey: "briefcase", colorKey: "blue", scope: "workspace",
    })).rejects.toMatchObject({ status: 403, code: "space_access_denied" });

    expect(batch).not.toHaveBeenCalled();
    expect(workspace.reserveSpace).not.toHaveBeenCalled();
  });

  it("given a D1 anchor that cannot be written, when creation fails, then nothing was reserved", async () => {
    const workspace = workspaceDouble();
    const env = serviceEnv({
      workspace,
      batch: async () => { throw new Error("d1_unavailable"); },
    });

    // Named rather than propagated: the D1 message is a diagnostic for a log,
    // and `internal_error` is what the caller used to be handed instead.
    await expect(new SpaceService(env, auth()).create({
      name: "Company", iconKey: "briefcase", colorKey: "blue", scope: "workspace",
    })).rejects.toMatchObject({ status: 503, code: "space_authority_unreachable" });

    // The anchor comes first, so a failure there leaves no Space in any
    // member's sidebar and no reservation to cancel.
    expect(workspace.reserveSpace).not.toHaveBeenCalled();
  });
});

describe("Space refusals", () => {
  it("given each closed code, when it is rendered, then it names the Space and its status", () => {
    expect(spaceRefusal("space_membership_final", "Company")).toMatchObject({
      status: 409,
      code: "space_membership_final",
      message: expect.stringContaining("Company"),
    });
    expect(spaceRefusal("space_audience_incompatible", "Company", [MEMBER])).toMatchObject({
      status: 409,
      message: expect.stringContaining("1 of its readers"),
    });
    // Without a name in hand the sentence says "this channel" rather than
    // rendering an empty pair of quotation marks.
    expect(spaceRefusal("space_membership_final", "").message).toContain("this channel");
    expect(spaceRefusal("space_access_denied", "Company")).toBeInstanceOf(ApiError);
    expect(spaceRefusal("space_access_denied", "Company").status).toBe(403);
    expect(spaceRefusal("space_not_found", "Company").status).toBe(404);
  });
});
