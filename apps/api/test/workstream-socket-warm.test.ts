import {
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
} from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";

import { ConversationService } from "../src/services/conversation-service";

import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const userId = asUserId("00000000-0000-7000-8000-000000000002");
const workstreamId = asWorkstreamId("00000000-0000-7000-8000-000000000003");
const auth: AuthContext = {
  sessionId: "session-1",
  userId,
  workspaceId,
  region: "global",
  role: "member",
};

/**
 * The parent's two answers the ticket path depends on: that this id names a
 * work stream, and whether this person may read its conversations. Both are
 * the real parent's, hosted in `WorkspaceDO`, in
 * `test-workers/conversation-parent-contract`; here they are the seam, so
 * the Worker-side sequence is what is under test.
 */
function parentDecisions(authorized = true, archived = false, membershipVersion = 0) {
  return {
    resolveHostedParent: vi.fn(async () => ({
      kind: "canvas" as const,
      authority: { exists: true, authorityGeneration: 7, archived },
    })),
    authorizeViewer: vi.fn(async () => ({ authorized, archived, membershipVersion })),
  };
}

function environment(
  prepareSocketAdmission: (input: unknown) => Promise<{ outcome: "snapshot_prepared" }>,
  substreamObjectName: (name: string) => DurableObjectId = () =>
    createTestDurableObjectId("substream"),
  getSubstream: (id: DurableObjectId) => object = () => ({ prepareSocketAdmission }),
  parent: ReturnType<typeof parentDecisions> = parentDecisions(),
): Env {
  return createTestEnv({
    APP_ENV: "test",
    AVALON_REGION: "global",
    PUBLIC_API_BASE_URL: "https://api.rallywith.ai",
    SESSION_SIGNING_KEY: "socket-warm-test-signing-key",
    DB: createTestD1Database({
      prepare: () => createTestD1PreparedStatement({
        first: async () => ({
          phase: "durable_object_open",
          generation: 7,
          required_serving_contract_version: 1,
          serving_contract_version: 1,
        }),
      }),
    }),
    WORKSPACE_DOS: createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: () => createTestDurableObjectId("workspace"),
      get: () => parent,
    }),
    SUBSTREAM_AGENTS: createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>({
      idFromName: substreamObjectName,
      get: getSubstream,
    }),
  });
}

describe("conversation socket ticket preparation", () => {

  it("refuses a ticket to somebody the parent does not admit, before any object is touched", async () => {
    const prepareSocketAdmission = vi.fn(async () => ({ outcome: "snapshot_prepared" as const }));
    const substreamObjectName = vi.fn(() => createTestDurableObjectId("substream"));
    const getSubstream = vi.fn(() => ({ prepareSocketAdmission }));
    const deferred: Promise<unknown>[] = [];
    const parent = parentDecisions(false);
    const service = new ConversationService(
      environment(prepareSocketAdmission, substreamObjectName, getSubstream, parent),
      auth,
      (promise) => deferred.push(promise),
    );

    // A 404 rather than a 403: whether a work stream exists is itself something
    // a non-participant is not told.
    await expect(service.socketTicket(workstreamId)).rejects.toMatchObject({
      status: 404,
      code: "conversation_not_found",
    });
    expect(parent.authorizeViewer).toHaveBeenCalledWith({
      workspaceId, parentId: workstreamId, substreamId: "0", userId,
    });
    expect(deferred).toEqual([]);
    expect(getSubstream).not.toHaveBeenCalled();
    expect(prepareSocketAdmission).not.toHaveBeenCalled();
  });

});
