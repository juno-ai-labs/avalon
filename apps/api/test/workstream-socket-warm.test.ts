import {
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
} from "@rally/contracts";
import { describe, expect, it, vi } from "vitest";

import type { AuthContext, Env } from "../src/env";
import { substreamAgentName } from "../src/durable-objects/names";
import { WorkstreamService } from "../src/services/workstream-service";
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

function environment(
  prepareSocketAdmission: (input: unknown) => Promise<{ outcome: "snapshot_prepared" }>,
  substreamObjectName: (name: string) => DurableObjectId = () =>
    createTestDurableObjectId("substream"),
  getSubstream: (id: DurableObjectId) => object = () => ({ prepareSocketAdmission }),
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
      get: () => ({ canReadWorkstream: async () => true }),
    }),
    SUBSTREAM_AGENTS: createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>({
      idFromName: substreamObjectName,
      get: getSubstream,
    }),
  });
}

describe("work-stream socket ticket preparation", () => {
  it("defers measurable admission and snapshot preparation for the main feed object", async () => {
    const prepareSocketAdmission = vi.fn(async () => ({ outcome: "snapshot_prepared" as const }));
    const substreamObjectName = vi.fn(() => createTestDurableObjectId("substream"));
    const deferred: Promise<unknown>[] = [];
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const service = new WorkstreamService(
      environment(prepareSocketAdmission, substreamObjectName),
      auth,
      (promise) => deferred.push(promise),
    );

    const ticket = await service.socketTicket(workstreamId);

    expect(ticket.url).toContain(`/socket/workstreams/${workstreamId}/substreams/0`);
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
      },
    });
    expect(deferred).toHaveLength(1);
    await expect(deferred[0]).resolves.toBeUndefined();
    expect(substreamObjectName).toHaveBeenCalledWith(
      substreamAgentName("global", workspaceId, workstreamId),
    );
    expect(prepareSocketAdmission).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId,
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
    const service = new WorkstreamService(env, auth, (promise) => deferred.push(promise));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const ticket = await service.socketTicket(workstreamId);
    await expect(deferred[0]).resolves.toBeUndefined();
    expect(substreamObjectName).toHaveBeenCalledWith(
      substreamAgentName("global", workspaceId, workstreamId),
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

  it("does not materialize an unrecorded non-main substream from a ticket request", async () => {
    const prepareSocketAdmission = vi.fn(async () => ({ outcome: "snapshot_prepared" as const }));
    const substreamObjectName = vi.fn(() => createTestDurableObjectId("substream"));
    const getSubstream = vi.fn(() => ({ prepareSocketAdmission }));
    const deferred: Promise<unknown>[] = [];
    const service = new WorkstreamService(
      environment(prepareSocketAdmission, substreamObjectName, getSubstream),
      auth,
      (promise) => deferred.push(promise),
    );

    const ticket = await service.socketTicket(workstreamId, substreamId);

    expect(ticket.url).toContain(`/socket/workstreams/${workstreamId}/substreams/${substreamId}`);
    expect(deferred).toEqual([]);
    expect(substreamObjectName).not.toHaveBeenCalled();
    expect(getSubstream).not.toHaveBeenCalled();
    expect(prepareSocketAdmission).not.toHaveBeenCalled();
  });
});
