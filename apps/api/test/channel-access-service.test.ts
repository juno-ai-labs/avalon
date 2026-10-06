import {
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  type WorkstreamDetail,
} from "@rally/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { ChannelAccessService } from "../src/services/channel-access-service";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import { WorkstreamService } from "../src/services/workstream-service";
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
 * *order*: which canonical operation runs, and what is published after it. The
 * operations themselves are exercised for real in the hosted parent's suites.
 */
const WORKSPACE = asWorkspaceId("00000000-0000-7000-8000-0000000ca100");
const CHANNEL = asWorkstreamId("00000000-0000-7000-8000-0000000ca101");
const OWNER = asUserId("00000000-0000-7000-8000-0000000ca103");
const READER = asUserId("00000000-0000-7000-8000-0000000ca104");

const auth: AuthContext = {
  sessionId: "session",
  userId: OWNER,
  workspaceId: WORKSPACE,
  region: "global",
  role: "member",
};

function environment(input: {
  calls: string[];
  manages?: boolean;
  workspaceObservation?: {
    found: true;
    archived: boolean;
    title: string;
    channel: { readers: { scope: "personal"; userIds: string[] }; participantUserIds: string[] };
  };
}): Env {
  const stub = {
    readManagementAccess: async () => ({
      allowed: input.manages ?? true, writable: true, grantIds: [], workspaceMemberAccess: false,
    }),
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
    // both the management check and the directory observation.
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
  vi.spyOn(WorkstreamObjectClient.prototype, "addParticipant").mockImplementation(async (userId) => {
    calls.push(`canonical:add(${userId})`);
    if (options.addParticipantThrows) throw options.addParticipantThrows;
    return {} as never;
  });
  vi.spyOn(WorkstreamObjectClient.prototype, "removeParticipant").mockImplementation(async (userId) => {
    calls.push(`canonical:remove(${userId})`);
  });
}

afterEach(() => vi.restoreAllMocks());

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

  // The conversation's own check is read and collaborate; changing who else is
  // in the Channel is management, and a reader who lacks it is told nothing.
  it("given a caller who may not manage the channel, then nothing is removed and it answers as not found", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls, { detail: detail("personal", [OWNER, READER]) });
    const service = new ChannelAccessService(environment({ calls, manages: false }), auth);

    await expect(service.removeDirectReader(CHANNEL, READER)).rejects.toMatchObject({
      status: 404, code: "workstream_not_found",
    });
    expect(calls).toEqual([]);
  });
});

describe("making a Channel private", () => {
  // A Channel born in General before this change recorded `personal` as its
  // own scope while General made it public. The narrowing is decided from the
  // audience the Channel actually had, so its non-participants' sockets close.
  it("given a public channel, when it is made private, then the narrowing is published after the update", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls, { detail: detail("workspace", [OWNER]) });

    await new WorkstreamService(environment({ calls }), auth).update(CHANNEL, { scope: "personal" });

    expect(calls).toEqual(["canonical:update(personal)", "queue:workstream_audience_narrowed"]);
  });

  it("given a private channel, when it is made private again, then nothing is published", async () => {
    const calls: string[] = [];
    stubCanonicalOperations(calls, { detail: detail("personal", [OWNER]) });

    await new WorkstreamService(environment({ calls }), auth).update(CHANNEL, { scope: "personal" });

    expect(calls).toEqual(["canonical:update(personal)"]);
  });
});
