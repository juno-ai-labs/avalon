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
import { asSpaceId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

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
const CHANNEL_ID = asWorkstreamId("00000000-0000-7000-8000-0000000000d5");
const SECOND_CHANNEL_ID = asWorkstreamId("00000000-0000-7000-8000-0000000000d6");

function summary(overrides: Record<string, unknown> = {}) {
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
  preflightSpaceMembershipMoveSource: ReturnType<typeof vi.fn>;
  finalizeSpaceMembershipRemoval: ReturnType<typeof vi.fn>;
  noteSpaceAudience: ReturnType<typeof vi.fn>;
  reserveSpace: ReturnType<typeof vi.fn>;
  cancelSpaceReservation: ReturnType<typeof vi.fn>;
  recordSpaceIntentReceipt: ReturnType<typeof vi.fn>;
  prepareSpaceArchive: ReturnType<typeof vi.fn>;
  finalizeSpaceArchive: ReturnType<typeof vi.fn>;
  restoreSpace: ReturnType<typeof vi.fn>;
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
    preflightSpaceMembershipMoveSource: vi.fn(async () => ({ ok: true, space: summary() })),
    finalizeSpaceMembershipRemoval: vi.fn(async () => ({ ok: true, space: summary() })),
    noteSpaceAudience: vi.fn(async () => ({ ok: true, space: summary({ revision: 4 }) })),
    reserveSpace: vi.fn(async () => ({ ok: true, space: summary() })),
    cancelSpaceReservation: vi.fn(async () => ({ cancelled: true })),
    recordSpaceIntentReceipt: vi.fn(async () => ({ recorded: true })),
    prepareSpaceArchive: vi.fn(async () => ({ ok: true, space: summary() })),
    finalizeSpaceArchive: vi.fn(async () => ({ ok: true, space: summary({ status: "archived" }) })),
    restoreSpace: vi.fn(async () => ({ ok: true, space: summary() })),
    ...overrides,
  };
}

/**
 * The Channel's own authorities, recording what order the Space reached them
 * in and with which arguments.
 *
 * Both halves are needed for a fan-out to run at all:
 * `ChannelAccessService` reads the conversation for the Channel's readers and
 * then asks `WorkstreamDO` for the delta its provenance implies. The plans are
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
        spaces: [],
      })),
      retractSpaceAccessSource: vi.fn(async (input: { parentId: string }) => {
        log.push(`retract:${input.parentId}`);
        return { ok: true, plan: { narrowScope: false, seatUserIds: [], removeUserIds: [] } };
      }),
      applySpaceAccessSource: vi.fn(async (input: { parentId: string; membershipGeneration: number }) => {
        log.push(`apply:${input.parentId}:${input.membershipGeneration}`);
        return { ok: true, plan: { widenScope: false, seatUserIds: [] } };
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
    WORKSPACE_DOS: namespaceDouble<Env["WORKSPACE_DOS"]>(input.workspace),
    SUBSTREAM_AGENTS: namespaceDouble<Env["SUBSTREAM_AGENTS"]>(conversation),
    SPACE_DOS: namespaceDouble<Env["SPACE_DOS"]>({}),
    AUTOMATION_DOS: namespaceDouble<Env["AUTOMATION_DOS"]>({}),
    WORKSTREAM_DOS: namespaceDouble<Env["WORKSTREAM_DOS"]>(input.room ?? {}),
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
  it("refuses an invalid move source before reserving the destination", async () => {
    const workspace = workspaceDouble({
      preflightSpaceMembershipMoveSource: vi.fn(async () => ({
        ok: false, code: "space_not_found", unreachableUserIds: [], blockedWorkstreamIds: [],
      })),
    });

    await expect(new SpaceService(serviceEnv({ workspace }), auth()).moveChannel(
      SPACE_ID,
      asSpaceId("00000000-0000-7000-8000-0000000000d7"),
      CHANNEL_ID,
    )).rejects.toMatchObject({ code: "space_not_found" });

    expect(workspace.reserveSpace).not.toHaveBeenCalled();
  });

  it("given an archive, when it runs, then reached Channel retractions overlap and all settle before finalization", async () => {
    const log: string[] = [];
    const workspace = workspaceDouble({
      prepareSpaceArchive: vi.fn(async () => {
        log.push("prepare");
        return { ok: true, space: summary() };
      }),
      listSpaceMembers: vi.fn(async (input: { reach?: string }) => {
        log.push(`members:${input.reach}`);
        return {
          ok: true,
          members: [
            { workstreamId: CHANNEL_ID, membershipGeneration: 4 },
            { workstreamId: SECOND_CHANNEL_ID, membershipGeneration: 2 },
          ],
          nextCursor: null,
        };
      }),
      finalizeSpaceArchive: vi.fn(async () => {
        log.push("finalize");
        return { ok: true, space: summary({ status: "archived" }) };
      }),
    });
    const channels = channelDoubles(log);
    const release = new Map<string, () => void>();
    channels.room.retractSpaceAccessSource = vi.fn((input: { parentId: string }) => new Promise((resolve) => {
      log.push(`retract:${input.parentId}`);
      release.set(input.parentId, () => resolve({
        ok: true,
        plan: { narrowScope: false, seatUserIds: [], removeUserIds: [] },
      }));
    }));

    const archive = new SpaceService(serviceEnv({
      workspace, conversation: channels.conversation, room: channels.room,
    }), auth()).archive(SPACE_ID);

    await vi.waitFor(
      () => expect([...release.keys()]).toEqual([CHANNEL_ID, SECOND_CHANNEL_ID]),
      { timeout: 1_000 },
    );
    expect(workspace.finalizeSpaceArchive).not.toHaveBeenCalled();
    release.get(CHANNEL_ID)?.();
    release.get(SECOND_CHANNEL_ID)?.();

    await expect(archive).resolves.toMatchObject({ status: "archived" });

    // `prepareSpaceArchive` flips every membership to `removing`, so the
    // fan-out has to ask which Channels this Space still *reaches*. Asking for
    // its active members here walks nothing and leaves the access source live
    // on every Channel the Space had.
    expect(log).toEqual([
      "prepare",
      "members:reaching",
      `retract:${CHANNEL_ID}`,
      `retract:${SECOND_CHANNEL_ID}`,
      "finalize",
    ]);
  });

  it("given one failed retraction, waits for its started sibling before rejecting and never finalizes", async () => {
    const workspace = workspaceDouble({
      listSpaceMembers: vi.fn(async () => ({
        ok: true,
        members: [
          { workstreamId: CHANNEL_ID, membershipGeneration: 4 },
          { workstreamId: SECOND_CHANNEL_ID, membershipGeneration: 2 },
        ],
        nextCursor: null,
      })),
    });
    const channels = channelDoubles([]);
    let rejectFirst: ((reason: Error) => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    channels.room.retractSpaceAccessSource = vi.fn((input: { parentId: string }) => new Promise((resolve, reject) => {
      if (input.parentId === CHANNEL_ID) rejectFirst = reject;
      else {
        releaseSecond = () => resolve({
          ok: true,
          plan: { narrowScope: false, seatUserIds: [], removeUserIds: [] },
        });
      }
    }));

    let settled = false;
    const archive = new SpaceService(serviceEnv({
      workspace, conversation: channels.conversation, room: channels.room,
    }), auth()).archive(SPACE_ID);
    const observed = archive.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    ).finally(() => {
      settled = true;
    });

    await vi.waitFor(
      () => expect(channels.room.retractSpaceAccessSource).toHaveBeenCalledTimes(2),
      { timeout: 1_000 },
    );
    rejectFirst?.(new Error("channel_retraction_failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(workspace.finalizeSpaceArchive).not.toHaveBeenCalled();

    releaseSecond?.();
    await expect(observed).resolves.toMatchObject({
      error: expect.objectContaining({ message: "channel_retraction_failed" }),
    });
    expect(workspace.finalizeSpaceArchive).not.toHaveBeenCalled();
  });
});

describe("SpaceService restore", () => {
  it("given an archived Space, when it is restored, then its memberships return before the source does", async () => {
    const log: string[] = [];
    const workspace = workspaceDouble({
      restoreSpace: vi.fn(async () => {
        log.push("restore");
        return { ok: true, space: summary({ revision: 7 }) };
      }),
      listSpaceMembers: vi.fn(async (input: { reach?: string }) => {
        log.push(`members:${input.reach}`);
        return {
          ok: true,
          members: [{ workstreamId: CHANNEL_ID, membershipGeneration: 6 }],
          nextCursor: null,
        };
      }),
    });
    const channels = channelDoubles(log);

    await new SpaceService(serviceEnv({
      workspace, conversation: channels.conversation, room: channels.room,
    }), auth()).restore(SPACE_ID);

    // The memberships come back first — the archive is what took them out —
    // and the members are read *after* the restore, so each application is
    // fenced on the generation that restore advanced the row to rather than on
    // a literal.
    expect(log).toEqual(["restore", "members:active", `apply:${CHANNEL_ID}:6`]);
    expect(channels.room.applySpaceAccessSource)
      .toHaveBeenCalledWith(expect.objectContaining({ spaceRevision: 7, membershipGeneration: 6 }));
  });
});

describe("SpaceService retraction announcements", () => {
  it("given a narrowing whose announcement is refused, when the removal runs, then the membership is not settled", async () => {
    const log: string[] = [];
    const workspace = workspaceDouble();
    const channels = channelDoubles(log);
    // The retraction takes the Channel back to personal, which is the case the
    // announcement exists for: the readers it drops are every member who is not
    // a participant, and the room is told about none of them.
    channels.room.retractSpaceAccessSource = vi.fn(async (input: { parentId: string }) => {
      log.push(`retract:${input.parentId}`);
      return { ok: true, plan: { narrowScope: true, seatUserIds: [], removeUserIds: [] } };
    });
    const env = serviceEnv({
      workspace,
      conversation: channels.conversation,
      room: channels.room,
      revocationQueue: { send: vi.fn(async () => { throw new Error("queue unavailable"); }) },
    });

    await expect(new SpaceService(env, auth()).removeChannel(SPACE_ID, CHANNEL_ID))
      .rejects.toMatchObject({ code: "channel_narrowing_publish_failed" });

    // The settlement is what takes the `remove` intent out of the alarm's
    // claim. Recording a retraction as delivered when nothing was sent would
    // leave every non-participant reader's socket open until they reconnect,
    // with nothing left to republish it.
    expect(workspace.finalizeSpaceMembershipRemoval).not.toHaveBeenCalled();
  });
});

describe("SpaceService intent resumption", () => {
  it("given a superseded audience intent, when it resumes, then it converges on the current Space", async () => {
    const log: string[] = [];
    const workspace = workspaceDouble({
      // The Space has moved since the intent was staged: a later audience
      // change accepted while this one was half way through its walk.
      spaceSummary: vi.fn(async () => ({ ok: true, space: summary({ revision: 9 }) })),
      listSpaceMembers: vi.fn(async () => ({
        ok: true, members: [{ workstreamId: CHANNEL_ID, membershipGeneration: 4 }], nextCursor: null,
      })),
      recordSpaceIntentReceipt: vi.fn(async (input: { receipt: string }) => {
        log.push(`receipt:${input.receipt}`);
        return { recorded: true };
      }),
    });
    const channels = channelDoubles(log);

    await new SpaceService(serviceEnv({
      workspace, conversation: channels.conversation, room: channels.room,
    }), auth()).resumeIntent({
      operationId: "00000000-0000-7000-8000-0000000000e1",
      kind: "audience",
      spaceId: SPACE_ID,
      workstreamId: null,
      spaceRevision: 4,
      membershipGeneration: null,
      cursor: null,
    });

    // The interrupted walk left some Channels on the old roster and some on
    // the new one. Settling without converging left them split, so the resume
    // re-applies the Space as it is now — against the current revision, which
    // is also what fences it against the newer change's own walk.
    expect(log).toEqual([
      `retract:${CHANNEL_ID}`,
      `apply:${CHANNEL_ID}:4`,
      "receipt:audience_superseded",
    ]);
    expect(channels.room.retractSpaceAccessSource)
      .toHaveBeenCalledWith(expect.objectContaining({ expectedSpaceRevision: 9 }));
    expect(channels.room.applySpaceAccessSource)
      .toHaveBeenCalledWith(expect.objectContaining({ spaceRevision: 9 }));
  });
});

describe("SpaceService creation", () => {
  it("given a Space whose object cannot be opened, when creation fails, then the reservation is cancelled", async () => {
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

    // A reservation left behind would be a Space in every member's sidebar that
    // answers nothing, because the object it names was never opened.
    expect(workspace.cancelSpaceReservation).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: SPACE_ID }),
    );
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
