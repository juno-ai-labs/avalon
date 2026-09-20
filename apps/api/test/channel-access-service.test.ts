import {
  asSpaceId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type WorkstreamDetail,
} from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { ApiError } from "../src/lib/api-error";
import { ChannelAccessService } from "../src/services/channel-access-service";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";

/**
 * What the service does between the Channel's authority and the Channel's
 * canonical operations.
 *
 * Doubles rather than the real pipeline, because what is being proved is the
 * *order and the recovery*: which canonical operation runs before which, and
 * what the service does when one of them refuses. Both objects are exercised
 * for real elsewhere — the plans in `test-workers/channel-access-sources.test.ts`,
 * the containment fence in the work-stream object's own suites.
 */
const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-0000000ca100");
const CHANNEL = asWorkstreamId("00000000-0000-7000-8000-0000000ca101");
const SPACE = asSpaceId("00000000-0000-7000-8000-0000000ca102");
const OTHER_SPACE = asSpaceId("00000000-0000-7000-8000-0000000ca108");
const THIRD_SPACE = asSpaceId("00000000-0000-7000-8000-0000000ca10c");
const OWNER = asUserId("00000000-0000-7000-8000-0000000ca103");
const READER = asUserId("00000000-0000-7000-8000-0000000ca104");
const OTHER = asUserId("00000000-0000-7000-8000-0000000ca105");

const auth: AuthContext = {
  sessionId: "session",
  userId: OWNER,
  workspaceId: WORKSPACE,
  region: "global",
  role: "member",
};

type ApplyResult = { ok: true; plan: { widenScope: boolean; seatUserIds: string[] } }
  | { ok: false; code: string };
type RetractResult = { ok: true; plan: { narrowScope: boolean; seatUserIds: string[]; removeUserIds: string[] } }
  | { ok: false; code: string };

function environment(input: {
  calls: string[];
  apply?: ApplyResult;
  confirm?: { ok: true; suppliedUserIds: string[] } | { ok: false; code: "space_revision_conflict" };
  retract?: RetractResult;
  sources?: {
    direct: { scope: "personal" | "workspace"; participantUserIds: string[] };
    spaces: Array<{ spaceId: string; scope: "personal" | "workspace"; participantUserIds: string[] }>;
  };
  workspaceObservation?: {
    found: true;
    archived: boolean;
    title: string;
    channel: { readers: { scope: "personal"; userIds: string[] }; participantUserIds: string[] };
  };
}): Env {
  const stub = {
    readManagementAccess: async () => ({ allowed: true, writable: true, grantIds: [], workspaceMemberAccess: false }),
    readAccessSources: async () => {
      input.calls.push("object:sources");
      return input.sources ?? { direct: { scope: "personal", participantUserIds: [] }, spaces: [] };
    },
    // Two modes on one RPC, and the call log says which: `born` is the
    // creation path asserting there is nothing to seat between the plan and
    // the commit, so the object commits the source here and no confirmation
    // follows. Every other caller has a canonical operation in between and
    // still takes both calls.
    applySpaceAccessSource: async (request: { bornWithSourceApplied?: boolean }) => {
      const applied = input.apply ?? { ok: true, plan: { widenScope: false, seatUserIds: [] } };
      if (!request.bornWithSourceApplied) {
        input.calls.push("object:apply");
        return applied;
      }
      input.calls.push("object:apply(born)");
      return applied.ok ? { ...applied, suppliedUserIds: applied.plan.seatUserIds } : applied;
    },
    confirmSpaceAccessSource: async (request: { spaceId: string; seatedUserIds: string[] }) => {
      input.calls.push(`object:confirm(${request.spaceId}:${request.seatedUserIds.join(",") || "none"})`);
      return input.confirm ?? { ok: true, suppliedUserIds: request.seatedUserIds };
    },
    retractSpaceAccessSource: async () => {
      input.calls.push("object:retract");
      return input.retract ?? { ok: true, plan: { narrowScope: false, seatUserIds: [], removeUserIds: [] } };
    },
  };
  return createTestEnv({
    APP_ENV: "test",
    AVALON_REGION: "global",
    DB: createTestD1Database({
      prepare: () => createTestD1PreparedStatement({
        bind: () => createTestD1PreparedStatement({
          first: async () => ({ placement_affinity: "wnam" }),
        }),
      }),
    }),
    WORKSTREAM_DOS: createCloudflareTestBinding<Env["WORKSTREAM_DOS"]>({
      idFromName: (name: string) => createTestDurableObjectId(name),
      get: () => stub,
    }),
    WORKSPACE_DOS: createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: (name: string) => createTestDurableObjectId(name),
      get: () => ({
        channelAccessObservation: async () => input.workspaceObservation ?? { found: false },
      }),
    }),
    ACCESS_REVOCATION_QUEUE: createCloudflareTestBinding<Env["ACCESS_REVOCATION_QUEUE"]>({
      send: async (body: unknown) => {
        const message = body as { userId: string | null; target: { scope: string } };
        input.calls.push(message.userId === null
          ? `queue:${message.target.scope}`
          : `queue:revoke(${message.userId})`);
      },
    }),
  });
}

function detail(scope: "personal" | "workspace", participantIds: string[]): WorkstreamDetail {
  return {
    title: "Hiring",
    scope,
    participants: participantIds.map((id) => ({
      user: { id },
      participationReason: "explicit",
      joinedAt: "2026-09-19T00:00:00.000Z",
    })),
  } as WorkstreamDetail;
}

function stubCanonicalOperations(
  calls: string[],
  options: { addParticipantThrows?: Error; detail?: WorkstreamDetail } = {},
): void {
  vi.spyOn(WorkstreamObjectClient.prototype, "get").mockResolvedValue(options.detail ?? detail("personal", [OWNER]));
  vi.spyOn(WorkstreamObjectClient.prototype, "update").mockImplementation(async (patch) => {
    calls.push(`canonical:update(${patch.scope})`);
    return {} as never;
  });
  vi.spyOn(WorkstreamObjectClient.prototype, "addParticipant").mockImplementation(async (userId, opts) => {
    calls.push(`canonical:add(${userId}${opts?.spaceSourceId ? `:${opts.spaceSourceId}` : ""})`);
    if (options.addParticipantThrows) throw options.addParticipantThrows;
    return {} as never;
  });
  vi.spyOn(WorkstreamObjectClient.prototype, "removeParticipant").mockImplementation(async (userId, opts) => {
    calls.push(`canonical:remove(${userId}${opts?.spaceSourceId ? `:${opts.spaceSourceId}` : ""})`);
  });
}

const source = {
  spaceId: SPACE,
  scope: "personal" as const,
  participantUserIds: [READER],
  spaceRevision: 1,
  membershipGeneration: 1,
  operationId: "00000000-0000-7000-8000-0000000ca106",
};

afterEach(() => vi.restoreAllMocks());

describe("applying a Space access source", () => {
  it("given a seating plan, when it is applied, then the canonical add runs and the source is confirmed", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls);
    const service = new ChannelAccessService(
      environment({ calls, apply: { ok: true, plan: { widenScope: false, seatUserIds: [READER] } } }),
      auth,
    );

    await service.applySpaceSource(CHANNEL, source);

    // The add carries the Space, which is what keeps the resulting grant out of
    // the shared scope-grant directory; the confirmation records exactly what
    // the canonical operation seated rather than what the plan asked for.
    expect(calls).toEqual([
      "object:apply",
      `canonical:add(${READER}:${SPACE})`,
      `object:confirm(${SPACE}:${READER})`,
    ]);
  });

  it("given a widening plan, when it is applied, then the scope change is the canonical update", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls);
    const service = new ChannelAccessService(
      environment({ calls, apply: { ok: true, plan: { widenScope: true, seatUserIds: [] } } }),
      auth,
    );

    await service.applySpaceSource(CHANNEL, source);

    // Through `update`, because that is where `assertRetainedContentContains`
    // runs. A service that wrote the scope itself would be a second place an
    // audience could widen without the fence.
    expect(calls).toEqual(["object:apply", "canonical:update(workspace)", `object:confirm(${SPACE}:none)`]);
  });

  it("given retained content the wider audience cannot read, when a Space is applied, then it rolls back and names the Channel", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls, {
      addParticipantThrows: new ApiError(
        409,
        "workstream_audience_restricted_content",
        "This work stream contains retained content that the wider audience cannot view",
      ),
    });
    const service = new ChannelAccessService(
      environment({ calls, apply: { ok: true, plan: { widenScope: false, seatUserIds: [READER] } } }),
      auth,
    );

    await expect(service.applySpaceSource(CHANNEL, source)).rejects.toMatchObject({
      status: 409,
      code: "space_membership_content_fence",
      message: expect.stringContaining("Hiring"),
    } satisfies Partial<ApiError> & { message: unknown });

    // Nothing was seated, and the application recorded no source, so there is
    // nothing to withdraw: the Channel is exactly as it was. The confirmation
    // is what commits provenance, which is why a failure before it needs no
    // unwind at all.
    expect(calls).toEqual([
      "object:apply",
      `canonical:add(${READER}:${SPACE})`,
    ]);
  });

  it("given a seating that fails after one reader, when it rolls back, then that reader is attributed and withdrawn", async () => {
    const calls: string[] = [];
    let added = 0;
    stubCanonicalOperations(calls);
    vi.spyOn(WorkstreamObjectClient.prototype, "addParticipant").mockImplementation(async (userId, opts) => {
      calls.push(`canonical:add(${userId}${opts?.spaceSourceId ? `:${opts.spaceSourceId}` : ""})`);
      if (++added > 1) throw new ApiError(409, "workstream_audience_restricted_content", "Retained content");
      return {} as never;
    });
    const service = new ChannelAccessService(
      environment({
        calls,
        apply: { ok: true, plan: { widenScope: false, seatUserIds: [READER, OTHER] } },
        retract: { ok: true, plan: { narrowScope: false, seatUserIds: [], removeUserIds: [READER] } },
      }),
      auth,
    );

    await expect(service.applySpaceSource(CHANNEL, source)).rejects.toMatchObject({
      code: "space_membership_content_fence",
    } satisfies Partial<ApiError>);

    // What did get seated is committed as this source's — the successful path
    // would have committed it too — and then withdrawn through the retraction
    // the product path uses, so a reader another Space supplies survives.
    expect(calls).toEqual([
      "object:apply",
      `canonical:add(${READER}:${SPACE})`,
      `canonical:add(${OTHER}:${SPACE})`,
      `object:confirm(${SPACE}:${READER})`,
      "object:retract",
      `canonical:remove(${READER}:${SPACE})`,
      `queue:revoke(${READER})`,
    ]);
  });

  it("given a refused application, when the Space moved under it, then the fence code reaches the caller", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls);
    const service = new ChannelAccessService(
      environment({ calls, apply: { ok: false, code: "space_revision_conflict" } }),
      auth,
    );

    await expect(service.applySpaceSource(CHANNEL, source)).rejects.toMatchObject({
      status: 409,
      code: "space_revision_conflict",
    } satisfies Partial<ApiError>);
    expect(calls).toEqual(["object:apply"]);
  });

  it("given confirmation loses its fence, when this attempt seated a reader no live source retains, then it removes that seat", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls);
    const service = new ChannelAccessService(
      environment({
        calls,
        apply: { ok: true, plan: { widenScope: false, seatUserIds: [READER] } },
        confirm: { ok: false, code: "space_revision_conflict" },
        sources: { direct: { scope: "personal", participantUserIds: [OWNER] }, spaces: [] },
      }),
      auth,
    );

    await expect(service.applySpaceSource(CHANNEL, source)).rejects.toMatchObject({
      code: "space_revision_conflict",
    } satisfies Partial<ApiError>);
    expect(calls).toEqual([
      "object:apply",
      `canonical:add(${READER}:${SPACE})`,
      `object:confirm(${SPACE}:${READER})`,
      "object:sources",
      `canonical:remove(${READER}:${SPACE})`,
    ]);
  });
});

describe("narrowing the Channel's own scope", () => {
  it("given a Space applied while everybody could read, when the Channel narrows, then its readers are seated and attributed first", async () => {
    const calls: string[] = [];
    // Organization-wide with one participant: the Space's readers were never
    // seated, because everybody could already read.
    stubCanonicalOperations(calls, { detail: detail("workspace", [OWNER]) });
    const service = new ChannelAccessService(
      environment({
        calls,
        sources: {
          direct: { scope: "workspace", participantUserIds: [OWNER] },
          spaces: [{ spaceId: SPACE, scope: "personal", participantUserIds: [READER, OTHER] }],
        },
      }),
      auth,
    );

    expect(await service.narrowDirectScope(CHANNEL)).toEqual([READER, OTHER]);

    // Seated through the canonical add, carrying the Space, and attributed to
    // it in one confirmation — without which the next retraction of that Space
    // reads them as the Channel's own and leaves them behind.
    expect(calls).toEqual([
      "object:sources",
      `canonical:add(${READER}:${SPACE})`,
      `canonical:add(${OTHER}:${SPACE})`,
      `object:confirm(${SPACE}:${READER},${OTHER})`,
    ]);
  });

  it("given a Space that is still Organization-wide, when the Channel narrows, then nobody is seated", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls, { detail: detail("workspace", [OWNER]) });
    const service = new ChannelAccessService(
      environment({
        calls,
        sources: {
          direct: { scope: "workspace", participantUserIds: [OWNER] },
          spaces: [{ spaceId: SPACE, scope: "workspace", participantUserIds: [READER] }],
        },
      }),
      auth,
    );

    // The audience stays Organization-wide whatever the Channel records, so
    // seating anybody would claim this source supplied access it did not, and
    // `recordDirectScope` refuses the narrowing a moment later anyway.
    expect(await service.narrowDirectScope(CHANNEL)).toEqual([]);
    expect(calls).toEqual(["object:sources"]);
  });

  it("given a reader the Channel already seats, when it narrows, then nothing is added for them", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls, { detail: detail("workspace", [OWNER, READER]) });
    const service = new ChannelAccessService(
      environment({
        calls,
        sources: {
          direct: { scope: "workspace", participantUserIds: [OWNER] },
          spaces: [{ spaceId: SPACE, scope: "personal", participantUserIds: [READER] }],
        },
      }),
      auth,
    );

    expect(await service.narrowDirectScope(CHANNEL)).toEqual([]);
    expect(calls).toEqual(["object:sources"]);
  });
});

describe("retracting a Space access source", () => {
  it("given an archived Channel, when its Space source is retracted, then the directory observation carries the operation", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls);
    vi.spyOn(WorkstreamObjectClient.prototype, "get").mockRejectedValue(
      new ApiError(404, "workstream_not_found", "Channel not found"),
    );
    const service = new ChannelAccessService(environment({
      calls,
      workspaceObservation: {
        found: true,
        archived: true,
        title: "Archived hiring",
        channel: { readers: { scope: "personal", userIds: [OWNER] }, participantUserIds: [OWNER] },
      },
    }), auth);

    await service.retractSpaceSource(CHANNEL, SPACE, "00000000-0000-7000-8000-0000000ca106");

    expect(calls).toEqual(["object:retract"]);
  });

  it("given a narrowing retraction, when it is applied, then survivors are seated before the scope changes and removals come last", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls);
    const service = new ChannelAccessService(
      environment({
        calls,
        retract: { ok: true, plan: { narrowScope: true, seatUserIds: [OTHER], removeUserIds: [READER] } },
        // What the Channel's authority answers once the departing source is
        // gone: the Space that actually supplies the survivor.
        sources: {
          direct: { scope: "personal", participantUserIds: [OWNER] },
          spaces: [{ spaceId: OTHER_SPACE, scope: "personal", participantUserIds: [OTHER] }],
        },
      }),
      auth,
    );

    await service.retractSpaceSource(CHANNEL, SPACE, "00000000-0000-7000-8000-0000000ca107");

    // Seating first is the whole point: a source applied while everybody could
    // read seated nobody, so narrowing before seating them revokes access a
    // surviving Space still provides. The revocation is published by whoever
    // wrote the removal, in the same request.
    expect(calls).toEqual([
      "object:retract",
      "object:sources",
      `canonical:add(${OTHER}:${OTHER_SPACE})`,
      `object:confirm(${OTHER_SPACE}:${OTHER})`,
      "canonical:update(personal)",
      // The narrowing announces itself: the room closes sockets for somebody it
      // was told about, and the readers a narrowing drops are every member who
      // is not a participant — a set nothing here can name. The hop asks the
      // room which of them is still reading.
      "queue:workstream_audience_narrowed",
      `canonical:remove(${READER}:${SPACE})`,
      `queue:revoke(${READER})`,
    ]);
  });

  it("given a survivor another Space supplies, when the first is retracted, then they are seated and attributed under that Space", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls);
    const service = new ChannelAccessService(
      environment({
        calls,
        retract: { ok: true, plan: { narrowScope: false, seatUserIds: [OTHER], removeUserIds: [] } },
        sources: {
          direct: { scope: "personal", participantUserIds: [OWNER] },
          spaces: [{ spaceId: OTHER_SPACE, scope: "personal", participantUserIds: [OTHER] }],
        },
      }),
      auth,
    );

    await service.retractSpaceSource(CHANNEL, SPACE, "00000000-0000-7000-8000-0000000ca109");

    // Both halves name the *surviving* Space. Naming the departing one would
    // not merely mislabel: its source row is gone by now, so the attribution
    // could not commit at all, and the Space that really supplies `OTHER`
    // would later retract with no provenance for them and leave behind a
    // reader nobody can account for.
    expect(calls).toEqual([
      "object:retract",
      "object:sources",
      `canonical:add(${OTHER}:${OTHER_SPACE})`,
      `object:confirm(${OTHER_SPACE}:${OTHER})`,
    ]);
  });

  it("given a survivor no remaining Space supplies, when a Space is retracted, then they are seated as the Channel's own", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls);
    const service = new ChannelAccessService(
      environment({
        calls,
        retract: { ok: true, plan: { narrowScope: true, seatUserIds: [OWNER], removeUserIds: [] } },
        sources: { direct: { scope: "personal", participantUserIds: [OWNER] }, spaces: [] },
      }),
      auth,
    );

    await service.retractSpaceSource(CHANNEL, SPACE, "00000000-0000-7000-8000-0000000ca10a");

    // No `spaceSourceId` and no attribution: this reader is the direct
    // source's, and recording a Space as their supplier would hand the next
    // retraction of that Space a licence to take them out.
    expect(calls).toEqual([
      "object:retract",
      "object:sources",
      `canonical:add(${OWNER})`,
      "canonical:update(personal)",
      "queue:workstream_audience_narrowed",
    ]);
  });

  it("given two remaining Spaces that both supply a survivor, when one is retracted, then each of them is told", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls);
    const service = new ChannelAccessService(
      environment({
        calls,
        retract: { ok: true, plan: { narrowScope: false, seatUserIds: [OTHER], removeUserIds: [] } },
        sources: {
          direct: { scope: "personal", participantUserIds: [OWNER] },
          spaces: [
            { spaceId: OTHER_SPACE, scope: "personal", participantUserIds: [OTHER] },
            { spaceId: THIRD_SPACE, scope: "personal", participantUserIds: [OTHER] },
          ],
        },
      }),
      auth,
    );

    await service.retractSpaceSource(CHANNEL, SPACE, "00000000-0000-7000-8000-0000000ca10b");

    // Seated once, attributed to both. Access is the live union, so either
    // Space departing has to leave the other's claim standing; attributing to
    // only the first would make the second's departure withdraw a reader it
    // still supplies.
    expect(calls).toEqual([
      "object:retract",
      "object:sources",
      `canonical:add(${OTHER}:${OTHER_SPACE})`,
      `object:confirm(${OTHER_SPACE}:${OTHER})`,
      `object:confirm(${THIRD_SPACE}:${OTHER})`,
    ]);
  });
});

describe("removing a direct reader", () => {
  it("given a Space still supplies the reader, then the reader is restored under that source and access survives", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls);
    const service = new ChannelAccessService(environment({
      calls,
      sources: {
        direct: { scope: "personal", participantUserIds: [OWNER, READER] },
        spaces: [{ spaceId: SPACE, scope: "personal", participantUserIds: [READER] }],
      },
    }), auth);

    await expect(service.removeDirectReader(CHANNEL, READER)).resolves.toBe(false);
    expect(calls).toEqual([
      "object:sources",
      `canonical:remove(${READER})`,
      `canonical:add(${READER}:${SPACE})`,
      `object:confirm(${SPACE}:${READER})`,
    ]);
  });
});
