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
  listSpaceMembers: ReturnType<typeof vi.fn>;
  prepareSpaceMembershipRemoval: ReturnType<typeof vi.fn>;
  moveSpaceMembership: ReturnType<typeof vi.fn>;
  replanSpaceMembershipMoveForAudience: ReturnType<typeof vi.fn>;
  finalizeSpaceMembershipMove: ReturnType<typeof vi.fn>;
  finalizeSpaceMembershipRemoval: ReturnType<typeof vi.fn>;
  noteSpaceAudience: ReturnType<typeof vi.fn>;
  reserveSpace: ReturnType<typeof vi.fn>;
  recordSpaceIntentReceipt: ReturnType<typeof vi.fn>;
  prepareSpaceArchive: ReturnType<typeof vi.fn>;
  finalizeSpaceArchive: ReturnType<typeof vi.fn>;
  restoreSpace: ReturnType<typeof vi.fn>;
  addSpaceChannel: ReturnType<typeof vi.fn>;
  removeSpaceChannel: ReturnType<typeof vi.fn>;
  walkSpaceMembers: ReturnType<typeof vi.fn>;
  resumeSpaceIntent: ReturnType<typeof vi.fn>;
}

function workspaceDouble(overrides: Partial<WorkspaceDouble> = {}): WorkspaceDouble {
  return {
    spaceSummary: vi.fn(async () => ({ ok: true, space: summary() })),
    listSpaceMembers: vi.fn(async () => ({
      ok: true, members: [{ workstreamId: CHANNEL_ID, membershipGeneration: 4 }], nextCursor: null,
    })),
    prepareSpaceMembershipRemoval: vi.fn(async () => ({
      ok: true, space: summary(), membershipGeneration: 4,
    })),
    moveSpaceMembership: vi.fn(async () => ({ ok: true, moved: false })),
    replanSpaceMembershipMoveForAudience: vi.fn(async () => ({
      ok: true,
      equivalentAudience: true,
      operationId: "00000000-0000-7000-8000-0000000000e2",
      source: summary({ name: "Source" }),
      target: summary({ id: TARGET_SPACE_ID, name: "Target" }),
      sourceMembershipGeneration: 4,
      targetMembershipGeneration: 2,
    })),
    finalizeSpaceMembershipMove: vi.fn(async () => ({
      ok: true,
      source: summary({ channelCount: 0 }),
      target: summary({ id: TARGET_SPACE_ID }),
    })),
    finalizeSpaceMembershipRemoval: vi.fn(async () => ({ ok: true, space: summary() })),
    noteSpaceAudience: vi.fn(async () => ({ ok: true, space: summary({ revision: 4 }) })),
    reserveSpace: vi.fn(async (): Promise<WorkspaceSpaceReserveResult> => ({ ok: true, space: summary(), created: true })),
    recordSpaceIntentReceipt: vi.fn(async () => ({ recorded: true })),
    prepareSpaceArchive: vi.fn(async () => ({ ok: true, space: summary() })),
    finalizeSpaceArchive: vi.fn(async () => ({ ok: true, space: summary({ status: "archived" }) })),
    restoreSpace: vi.fn(async () => ({ ok: true, space: summary() })),
    addSpaceChannel: vi.fn(async () => ({ ok: true, space: summary() })),
    removeSpaceChannel: vi.fn(async () => ({ ok: true, space: summary() })),
    walkSpaceMembers: vi.fn(async () => ({ ok: true, outcome: "walked", space: summary() })),
    resumeSpaceIntent: vi.fn(async () => ({ ok: true, outcome: "settled" })),
    ...overrides,
  };
}

/**
 * The Channel's own authorities, recording what order the Space reached them
 * in and with which arguments.
 *
 * Both halves are needed for a fan-out to run at all:
 * `ChannelAccessService` reads the conversation for the Channel's readers and
 * then asks the Channel's parent, hosted in `WorkspaceDO`, for the delta its
 * provenance implies. The plans are
 * empty on purpose — what this file can prove is which authority is asked,
 * about which Channel, and in what order.
 */
function channelDoubles(log: string[]) {
  const detail = (workstreamId: string) => ({
    id: workstreamId,
    workspaceId: WORKSPACE_ID,
    title: "Member Channel",
    titleStatus: "settled",
    objective: "",
    emailAddress: null,
    createdByUserId: OWNER,
    harnessStatus: "idle",
    latestAttentionSequenceNumber: 0,
    readThroughSequenceNumber: 0,
    manualUnreadFromSequenceNumber: null,
    manualUnreadGeneration: 0,
    hasUnread: false,
    firstUnreadSequenceNumber: null,
    lastActivityAt: "2026-09-19T00:00:00.000Z",
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    archivedAt: null,
    scope: "workspace",
    participants: [],
    viewers: [],
    resources: [],
    connections: [],
    openElicitations: [],
    latestHarnessRunId: null,
  });
  return {
    conversation: {
      previewAudienceContainment: vi.fn(async () => true),
      // Every product operation a retraction or an application reaches here is
      // a read of the Channel; the detail is what both of them observe.
      handleProductRequest: vi.fn(async () => ({
        status: 200,
        bodyJson: JSON.stringify(detail(CHANNEL_ID)),
      })),
    },
    room: {
      readManagementAccess: vi.fn(async () => ({ allowed: true })),
      readAccessSources: vi.fn(async () => ({
        direct: { scope: "workspace", participantUserIds: [], observed: true },
        spaces: [] as Array<{
          spaceId: typeof SPACE_ID;
          scope: "personal" | "workspace";
          participantUserIds: Array<typeof OWNER>;
        }>,
      })),
      readPersistedSpaceAccessSources: vi.fn(async () => [] as Array<{
        spaceId: typeof SPACE_ID;
        scope: "personal" | "workspace";
        participantUserIds: Array<typeof OWNER>;
      }>),
      retractSpaceAccessSource: vi.fn(async (input: { parentId: string }) => {
        log.push(`retract:${input.parentId}`);
        return { ok: true, plan: { narrowScope: false, seatUserIds: [], removeUserIds: [] } };
      }),
      applySpaceAccessSource: vi.fn(async (input: { parentId: string; membershipGeneration: number }) => {
        log.push(`apply:${input.parentId}:${input.membershipGeneration}`);
        return { ok: true, plan: { widenScope: false, seatUserIds: [] } };
      }),
      replaceEquivalentSpaceAccessSource: vi.fn(async (input: {
        sourceSpaceId: string;
        targetSpaceId: string;
      }) => {
        log.push(`replace:${input.sourceSpaceId}:${input.targetSpaceId}`);
        return { ok: true };
      }),
      confirmSpaceAccessSource: vi.fn(async () => ({ ok: true, suppliedUserIds: [] })),
    },
  };
}

/**
 * A namespace whose `get` always answers with the same stand-in.
 *
 * The double stands in for the *stub*, never for the namespace: the resolver
 * derives an id from a name and then asks for the object, and both halves have
 * to behave for the service under test to reach anything at all.
 */
function namespaceDouble<
  T extends Env["WORKSPACE_DOS"] | Env["SUBSTREAM_AGENTS"] | Env["SPACE_DOS"]
  | Env["AUTOMATION_DOS"] | Env["WORKSTREAM_DOS"],
>(stub: object): T {
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: () => stub,
    jurisdiction: () => namespace,
  };
  return createCloudflareTestBinding<T>(namespace as never);
}

/**
 * The Organization object as one stub: its own Space methods and the hosted
 * Channel parent's, which production reaches on the same `WorkspaceDO`.
 *
 * Resolved on each read, because a test reassigns a room method after the
 * fixture is built, and the room wins so a Channel double is never shadowed.
 */
function organizationObject(workspace: object, room: object | undefined): object {
  return new Proxy(workspace, {
    get: (target, property) => (room && property in room
      ? (room as Record<PropertyKey, unknown>)[property]
      : (target as Record<PropertyKey, unknown>)[property]),
  });
}

function serviceEnv(input: {
  workspace: WorkspaceDouble;
  conversation?: object;
  room?: object;
  batch?: () => Promise<unknown>;
  revocationQueue?: object;
}): Env {
  const conversation = input.conversation ?? {
    previewAudienceContainment: vi.fn(async () => true),
  };
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
    WORKSPACE_DOS: namespaceDouble<Env["WORKSPACE_DOS"]>(organizationObject(input.workspace, input.room)),
    SUBSTREAM_AGENTS: namespaceDouble<Env["SUBSTREAM_AGENTS"]>(conversation),
    SPACE_DOS: namespaceDouble<Env["SPACE_DOS"]>({}),
    AUTOMATION_DOS: namespaceDouble<Env["AUTOMATION_DOS"]>({}),
    // The legacy parent objects answer nothing: every Channel and Space parent
    // is hosted in WorkspaceDO, so a call that still reached one would throw.
    WORKSTREAM_DOS: namespaceDouble<Env["WORKSTREAM_DOS"]>({}),
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
  it("given a member Channel with a content fence, when the audience widens, then nothing is written", async () => {
    const workspace = workspaceDouble();
    const env = serviceEnv({
      workspace,
      conversation: { previewAudienceContainment: vi.fn(async () => false) },
    });

    await expect(new SpaceService(env, auth()).updateAudience(SPACE_ID, {
      scope: "workspace",
      participantUserIds: [OWNER, MEMBER],
    })).rejects.toMatchObject({ code: "space_membership_content_fence", status: 409 });

    // The whole point of preflighting every member before changing any of them:
    // widening cannot be taken back, so a fence found on one Channel must stop
    // the Space's own authority from accepting the change at all.
    expect(workspace.noteSpaceAudience).not.toHaveBeenCalled();
  });

  it("given General, when its audience is made personal, then the authority's refusal is surfaced", async () => {
    const workspace = workspaceDouble({
      spaceSummary: vi.fn(async () => ({ ok: true, space: summary({ systemRole: "general" }) })),
      noteSpaceAudience: vi.fn(async () => ({
        ok: false, code: "space_protected", unreachableUserIds: [],
      })),
    });

    await expect(new SpaceService(serviceEnv({ workspace }), auth()).updateAudience(SPACE_ID, {
      scope: "personal",
      participantUserIds: [OWNER],
    })).rejects.toMatchObject({ code: "space_protected", status: 409 });
  });

  it("given an ordinary member, when they remove somebody else, then the role gate refuses it", async () => {
    const workspace = workspaceDouble();

    await expect(new SpaceService(serviceEnv({ workspace }), auth("member")).updateAudience(SPACE_ID, {
      scope: "personal",
      participantUserIds: [OWNER],
    })).rejects.toMatchObject({ code: "participant_removal_denied", status: 403 });
    expect(workspace.noteSpaceAudience).not.toHaveBeenCalled();
  });
});

describe("SpaceService lifecycle fan-out", () => {
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

    expect(workspace.prepareSpaceMembershipRemoval).not.toHaveBeenCalled();
  });

  it("moves equal-audience provenance in one WorkspaceDO call without reading or rewriting the Channel audience", async () => {
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
    const channels = channelDoubles(log);

    await expect(new SpaceService(serviceEnv({
      workspace, conversation: channels.conversation, room: channels.room,
    }), auth()).moveChannel(SPACE_ID, TARGET_SPACE_ID, CHANNEL_ID)).resolves.toMatchObject({
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
    expect(channels.conversation.handleProductRequest).not.toHaveBeenCalled();
    expect(channels.room.replaceEquivalentSpaceAccessSource).not.toHaveBeenCalled();
    expect(channels.room.applySpaceAccessSource).not.toHaveBeenCalled();
    expect(channels.room.retractSpaceAccessSource).not.toHaveBeenCalled();
  });

  it("given an archive, when it runs, then WorkspaceDO walks its reaching members a page per call until the walk finalizes it", async () => {
    const log: string[] = [];
    const workspace = workspaceDouble({
      prepareSpaceArchive: vi.fn(async () => {
        log.push("prepare");
        return { ok: true, space: summary() };
      }),
      walkSpaceMembers: vi.fn(async (input: { kind: string; cursor: string | null }) => {
        log.push(`walk:${input.kind}:${input.cursor}`);
        return input.cursor === null
          ? { ok: true, outcome: "page", cursor: "second-page" }
          : { ok: true, outcome: "walked", space: summary({ status: "archived" }) };
      }),
    });
    const channels = channelDoubles(log);

    await expect(new SpaceService(serviceEnv({
      workspace, conversation: channels.conversation, room: channels.room,
    }), auth()).archive(SPACE_ID)).resolves.toMatchObject({ status: "archived" });

    // The prepare stages the intent the walk's pages write their cursor to,
    // and the last page is what finalizes the archive; the Worker reaches no
    // Channel and no Channel parent itself.
    expect(log).toEqual(["prepare", "walk:archive:null", "walk:archive:second-page"]);
    expect(workspace.walkSpaceMembers).toHaveBeenCalledWith(expect.objectContaining({
      auth: expect.objectContaining({ userId: OWNER, sessionId: "space-service-test" }),
      spaceId: SPACE_ID,
      expectedSpaceRevision: null,
    }));
    expect(workspace.finalizeSpaceArchive).not.toHaveBeenCalled();
    expect(channels.conversation.handleProductRequest).not.toHaveBeenCalled();
    expect(channels.room.retractSpaceAccessSource).not.toHaveBeenCalled();
  });
});

describe("SpaceService restore", () => {
  it("given an archived Space, when it is restored, then its memberships return before WorkspaceDO re-applies the source", async () => {
    const log: string[] = [];
    const workspace = workspaceDouble({
      restoreSpace: vi.fn(async () => {
        log.push("restore");
        return { ok: true, space: summary({ revision: 7 }) };
      }),
      walkSpaceMembers: vi.fn(async (input: { kind: string }) => {
        log.push(`walk:${input.kind}`);
        return { ok: true, outcome: "walked", space: summary({ revision: 7 }) };
      }),
    });

    await expect(new SpaceService(serviceEnv({ workspace }), auth()).restore(SPACE_ID))
      .resolves.toMatchObject({ revision: 7 });

    // The restore is what puts the memberships back, so the walk that reads
    // them (and fences each application on the generation the restore wrote)
    // runs after it.
    expect(log).toEqual(["restore", "walk:restore"]);
  });
});

describe("SpaceService membership changes", () => {
  it("given an add, when it runs, then it is one WorkspaceDO call as the requesting session", async () => {
    const workspace = workspaceDouble();
    const channels = channelDoubles([]);

    await expect(new SpaceService(serviceEnv({
      workspace, conversation: channels.conversation, room: channels.room,
    }), auth()).addChannel(SPACE_ID, CHANNEL_ID)).resolves.toMatchObject({ id: SPACE_ID });

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
    expect(channels.conversation.handleProductRequest).not.toHaveBeenCalled();
    expect(channels.room.applySpaceAccessSource).not.toHaveBeenCalled();
    expect(channels.room.confirmSpaceAccessSource).not.toHaveBeenCalled();
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
  it("replays an interrupted equivalent-audience move from its durable fences", async () => {
    const log: string[] = [];
    const workspace = workspaceDouble({
      spaceSummary: vi.fn(async (input: { spaceId: SpaceSummary["id"] }) => ({
        ok: true,
        space: summary({ id: input.spaceId, name: input.spaceId === SPACE_ID ? "Source" : "Target" }),
      })),
      finalizeSpaceMembershipMove: vi.fn(async () => {
        log.push("finalize");
        return {
          ok: true,
          source: summary({ channelCount: 0 }),
          target: summary({ id: TARGET_SPACE_ID, channelCount: 1 }),
        };
      }),
    });
    const channels = channelDoubles(log);
    channels.room.readPersistedSpaceAccessSources = vi.fn(async () => [{
      spaceId: TARGET_SPACE_ID,
      scope: "personal" as const,
      participantUserIds: [OWNER],
    }]);

    await expect(new SpaceService(serviceEnv({
      workspace, conversation: channels.conversation, room: channels.room,
    }), auth()).resumeIntent({
      operationId: "00000000-0000-7000-8000-0000000000e2",
      kind: "move",
      spaceId: TARGET_SPACE_ID,
      workstreamId: CHANNEL_ID,
      spaceRevision: 3,
      membershipGeneration: 2,
      sourceSpaceId: SPACE_ID,
      sourceSpaceRevision: 3,
      sourceMembershipGeneration: 4,
      cursor: null,
    })).resolves.toEqual({ outcome: "settled" });

    expect(log).toEqual([
      `apply:${CHANNEL_ID}:4`,
      `retract:${CHANNEL_ID}`,
      `apply:${CHANNEL_ID}:2`,
      `retract:${CHANNEL_ID}`,
      "finalize",
    ]);
    expect(channels.room.applySpaceAccessSource.mock.calls[0]?.[0]).toMatchObject({
      spaceId: SPACE_ID,
      participantUserIds: [OWNER],
    });
    expect(channels.room.applySpaceAccessSource.mock.calls[1]?.[0]).toMatchObject({
      spaceId: TARGET_SPACE_ID,
      participantUserIds: [OWNER, MEMBER],
    });
    expect(workspace.finalizeSpaceMembershipMove).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "00000000-0000-7000-8000-0000000000e2",
      sourceSpaceRevision: 3,
      sourceMembershipGeneration: 4,
      targetSpaceRevision: 3,
      targetMembershipGeneration: 2,
    }));
  });

  it("acks a resumed move that a competing destination already superseded", async () => {
    const workspace = workspaceDouble({
      replanSpaceMembershipMoveForAudience: vi.fn(async () => ({
        ok: false,
        code: "space_revision_conflict",
        unreachableUserIds: [],
        blockedWorkstreamIds: [],
      })),
    });

    await expect(new SpaceService(serviceEnv({ workspace }), auth()).resumeIntent({
      operationId: "00000000-0000-7000-8000-0000000000e3",
      kind: "move",
      spaceId: TARGET_SPACE_ID,
      workstreamId: CHANNEL_ID,
      spaceRevision: 3,
      membershipGeneration: 2,
      sourceSpaceId: SPACE_ID,
      sourceSpaceRevision: 3,
      sourceMembershipGeneration: 4,
      cursor: null,
    })).resolves.toEqual({ outcome: "abandoned", reason: "move_superseded" });
  });

  it("given an intent other than a move, when it resumes, then WorkspaceDO finishes it from its row", async () => {
    const workspace = workspaceDouble({
      resumeSpaceIntent: vi.fn(async () => ({ ok: true, outcome: "abandoned", reason: "add_superseded" })),
    });
    const channels = channelDoubles([]);

    await expect(new SpaceService(serviceEnv({
      workspace, conversation: channels.conversation, room: channels.room,
    }), auth()).resumeIntent({
      operationId: "00000000-0000-7000-8000-0000000000e1",
      kind: "audience",
      spaceId: SPACE_ID,
      workstreamId: null,
      spaceRevision: 4,
      membershipGeneration: null,
      cursor: null,
    })).resolves.toEqual({ outcome: "abandoned", reason: "add_superseded" });

    expect(workspace.resumeSpaceIntent).toHaveBeenCalledWith({
      auth: expect.objectContaining({ userId: OWNER }),
      operationId: "00000000-0000-7000-8000-0000000000e1",
    });
    expect(channels.room.retractSpaceAccessSource).not.toHaveBeenCalled();
    expect(workspace.spaceSummary).not.toHaveBeenCalled();
  });
});

describe("SpaceService creation", () => {
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
    // Without a name in hand the sentence says "this Space" rather than
    // rendering an empty pair of quotation marks.
    expect(spaceRefusal("space_membership_final", "").message).toContain("this Space");
    expect(spaceRefusal("space_access_denied", "Company")).toBeInstanceOf(ApiError);
    expect(spaceRefusal("space_access_denied", "Company").status).toBe(403);
    expect(spaceRefusal("space_not_found", "Company").status).toBe(404);
  });
});
