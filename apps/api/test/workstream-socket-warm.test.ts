import {
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
} from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { conversationObjectName } from "../src/durable-objects/names";
import { ConversationService } from "../src/services/conversation-service";
import { verifySocketTicket } from "../src/services/socket-service";
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
const substreamId = asSubstreamId("00000000-0000-7000-8000-000000000004");
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
 * the real `WorkstreamDO`'s in `test-workers/conversation-parent-contract`;
 * here they are the seam, so the Worker-side sequence is what is under test.
 */
function parentDecisions(authorized = true, archived = false, membershipVersion = 0) {
  return {
    authority: vi.fn(async () => ({ exists: true, authorityGeneration: 7, archived })),
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
    WORKSTREAM_DOS: createCloudflareTestBinding<Env["WORKSTREAM_DOS"]>({
      idFromName: () => createTestDurableObjectId("workstream"),
      get: () => parent,
    }),
    SUBSTREAM_AGENTS: createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>({
      idFromName: substreamObjectName,
      get: getSubstream,
    }),
  });
}

describe("conversation socket ticket preparation", () => {
  it("defers measurable admission and snapshot preparation for the main feed object", async () => {
    const prepareSocketAdmission = vi.fn(async () => ({ outcome: "snapshot_prepared" as const }));
    const substreamObjectName = vi.fn(() => createTestDurableObjectId("substream"));
    const deferred: Promise<unknown>[] = [];
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const parent = parentDecisions();
    const service = new ConversationService(
      environment(prepareSocketAdmission, substreamObjectName, undefined, parent),
      auth,
      (promise) => deferred.push(promise),
    );

    const ticket = await service.socketTicket(workstreamId);

    expect(ticket.url).toContain(`/socket/conversations/${workstreamId}/0`);
    await expect(verifySocketTicket(
      environment(prepareSocketAdmission, substreamObjectName),
      ticket.ticket,
    )).resolves.toMatchObject({
      ticketId: ticket.ticketId,
      admission: {
        version: 1,
        authorityGeneration: 7,
        role: "member",
        analyticsWorkspaceId: null,
        parentArchived: false,
      },
    });
    // The parent decided before anything was issued, and it was asked about
    // this person, not merely whether the work stream exists.
    expect(parent.authorizeViewer).toHaveBeenCalledWith({
      workspaceId, parentId: workstreamId, substreamId: "0", userId,
    });
    expect(deferred).toHaveLength(1);
    await expect(deferred[0]).resolves.toBeUndefined();
    expect(substreamObjectName).toHaveBeenCalledWith(
      conversationObjectName("global", workspaceId, workstreamId),
    );
    expect(prepareSocketAdmission).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
      parentKind: "workstream",
      workstreamId,
      substreamId: "0",
      userId,
      sessionId: auth.sessionId,
      ticketId: ticket.ticketId,
      ticketIssuedAt: expect.any(Number),
      ticketExpiresAt: expect.any(Number),
      authorityGeneration: 7,
      role: "member",
      speculative: false,
    }));
    const preparation = (prepareSocketAdmission as unknown as {
      mock: { calls: Array<[{ ticketIssuedAt: number; ticketExpiresAt: number }]> };
    }).mock.calls[0]![0];
    expect(preparation.ticketExpiresAt - preparation.ticketIssuedAt).toBe(60);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      event: "workstream_socket_ticket_warm_finished",
      workspace_id: workspaceId,
      workstream_id: workstreamId,
      parent_kind: "workstream",
      substream_id: "0",
      ticket_id: ticket.ticketId,
      duration_ms: expect.any(Number),
      outcome: "success",
      preparation_outcome: "snapshot_prepared",
    }));
  });

  it("returns the ticket when best-effort preparation fails", async () => {
    const prepareSocketAdmission = vi.fn(async () => { throw new Error("probe wake failed"); });
    const substreamObjectName = vi.fn(() => createTestDurableObjectId("substream"));
    const deferred: Promise<unknown>[] = [];
    const env = environment(prepareSocketAdmission, substreamObjectName);
    const service = new ConversationService(env, auth, (promise) => deferred.push(promise));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const ticket = await service.socketTicket(workstreamId);
    await expect(deferred[0]).resolves.toBeUndefined();
    expect(substreamObjectName).toHaveBeenCalledWith(
      conversationObjectName("global", workspaceId, workstreamId),
    );
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({
      event: "workstream_socket_ticket_warm_finished",
      workspace_id: workspaceId,
      workstream_id: workstreamId,
      substream_id: "0",
      ticket_id: ticket.ticketId,
      duration_ms: expect.any(Number),
      outcome: "failure",
      error_name: "Error",
    }));
  });

  it("carries exact child membership without warming a non-main substream", async () => {
    const prepareSocketAdmission = vi.fn(async () => ({ outcome: "snapshot_prepared" as const }));
    const substreamObjectName = vi.fn(() => createTestDurableObjectId("substream"));
    const getSubstream = vi.fn(() => ({ prepareSocketAdmission }));
    const deferred: Promise<unknown>[] = [];
    const parent = parentDecisions(true, false, 3);
    const ticketEnv = environment(prepareSocketAdmission, substreamObjectName, getSubstream, parent);
    const service = new ConversationService(
      ticketEnv,
      auth,
      (promise) => deferred.push(promise),
    );

    const ticket = await service.socketTicket(workstreamId, substreamId);

    expect(ticket.url).toContain(`/socket/conversations/${workstreamId}/${substreamId}`);
    await expect(verifySocketTicket(ticketEnv, ticket.ticket)).resolves.toMatchObject({
      substreamId,
      admission: { membershipVersion: 3 },
    });
    expect(parent.authorizeViewer).toHaveBeenCalledWith({
      workspaceId, parentId: workstreamId, substreamId, userId,
    });
    expect(deferred).toEqual([]);
    expect(substreamObjectName).not.toHaveBeenCalled();
    expect(getSubstream).not.toHaveBeenCalled();
    expect(prepareSocketAdmission).not.toHaveBeenCalled();
  });

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

  it("refuses a ticket for an archived work stream the way its boot does, before any object is touched", async () => {
    // The work-stream object refuses every read of an archived room, so a
    // ticket would open a socket that never gets a frame. The archived
    // admission flag is for an automation's conversation, which stays
    // readable; that path is proved on workerd in
    // `test-workers/conversation-parent-contract.test.ts`.
    const prepareSocketAdmission = vi.fn(async () => ({ outcome: "snapshot_prepared" as const }));
    const parent = parentDecisions(true, true);
    const env = environment(prepareSocketAdmission, undefined, undefined, parent);
    const service = new ConversationService(env, auth, () => undefined);

    await expect(service.socketTicket(workstreamId)).rejects.toMatchObject({
      status: 404,
      code: "conversation_not_found",
    });
    expect(prepareSocketAdmission).not.toHaveBeenCalled();
  });
});
