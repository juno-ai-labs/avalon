import {
  asSpaceId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type WorkstreamDetail,
} from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { ChannelAccessService } from "../src/services/channel-access-service";
import { runSpaceSourceRetraction } from "../src/services/space-source-operations";
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
 * what the service does when one of them refuses. Both halves are exercised
 * for real elsewhere — the plans in `test-workers/channel-access-sources.test.ts`,
 * the containment fence in the hosted parent's own suites.
 */
const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-0000000ca100");
const CHANNEL = asWorkstreamId("00000000-0000-7000-8000-0000000ca101");
const SPACE = asSpaceId("00000000-0000-7000-8000-0000000ca102");
const OTHER_SPACE = asSpaceId("00000000-0000-7000-8000-0000000ca108");
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
    // The Organization object hosts the Channel's parent, so one stub answers
    // both the parent's access-source calls and the directory observation.
    WORKSPACE_DOS: createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: (name: string) => createTestDurableObjectId(name),
      get: () => ({
        ...stub,
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


afterEach(() => vi.restoreAllMocks());

describe("withdrawing a Space source through the canonical operations", () => {
  it("given a narrowing retraction, when it runs, then survivors are seated before the scope changes and removals come last", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls);

    await runSpaceSourceRetraction({
      env: environment({ calls }),
      workspaceId: WORKSPACE,
      workstreamId: CHANNEL,
      client: new WorkstreamObjectClient(environment({ calls }), auth, CHANNEL),
      spaceId: SPACE,
      plan: { narrowScope: true, seatUserIds: [OTHER], removeUserIds: [READER] },
      // The Space that actually supplies the survivor once the departing
      // source is gone; WorkspaceDO recorded the attribution when it planned.
      remaining: [{ spaceId: OTHER_SPACE, scope: "personal", participantUserIds: [OTHER] }],
    });

    // Seating first is the whole point: a source applied while everybody could
    // read seated nobody, so narrowing before seating them revokes access a
    // surviving Space still provides. The revocation is published by whoever
    // wrote the removal, in the same request.
    expect(calls).toEqual([
      `canonical:add(${OTHER}:${OTHER_SPACE})`,
      "canonical:update(personal)",
      // The narrowing announces itself: the room closes sockets for somebody it
      // was told about, and the readers a narrowing drops are every member who
      // is not a participant, a set nothing here can name.
      "queue:workstream_audience_narrowed",
      `canonical:remove(${READER}:${SPACE})`,
      `queue:revoke(${READER})`,
    ]);
  });
});

describe("removing a direct reader", () => {
  it("given a private Channel whose Space lists the reader, then the reader is removed and access is lost", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls, { detail: detail("personal", [OWNER, READER]) });
    const service = new ChannelAccessService(environment({ calls }), auth);

    await expect(service.removeDirectReader(CHANNEL, READER)).resolves.toBe(true);
    expect(calls).toEqual([`canonical:remove(${READER})`]);
  });

  it("given an Organization-wide Channel, then the reader is removed and can still read", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls, { detail: detail("workspace", [OWNER, READER]) });
    const service = new ChannelAccessService(environment({ calls }), auth);

    await expect(service.removeDirectReader(CHANNEL, READER)).resolves.toBe(false);
    expect(calls).toEqual([`canonical:remove(${READER})`]);
  });
});
