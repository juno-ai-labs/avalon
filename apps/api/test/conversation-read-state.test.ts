/**
 * Which conversation a read acknowledgement moves the waterline on.
 *
 * Read state is substream-owned: every `SubstreamAgent` keeps its own attention
 * ordinals and its own `member_attention` row, and a child's ordinals are
 * deliberately not comparable to Main's
 * ([`workstream-durable-object.md`](../../../docs/workstream-durable-object.md)).
 * The acknowledgement was nonetheless addressed to the work stream, and
 * `PATCH /workstreams/:id/read-state` built its client with the substream id
 * hard-coded to `"0"`, so a read in a private substream could only ever advance
 * Main. The divider that child had already drawn from its own unread waterline
 * therefore stayed above the reply the person was reading, through reopens and
 * reconnects alike, and only sending another message there could clear it.
 *
 * These tests are about addressing, which is where that defect lived, so what
 * they read is the object the request reaches and what the parent was asked.
 * The arithmetic on the far side of it — the waterline, the manual mark's
 * generation, the derived unread pair — is the object's own and runs against
 * real Durable Object SQLite; nothing here models it.
 */
import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { conversationObjectName } from "../src/durable-objects/names";
import type { AuthContext, Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { conversationRoutes } from "../src/routes/conversations";
import { workstreamRoutes } from "../src/routes/workstreams";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";
import { testWorkstreamContract } from "./helpers/durable-authority";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000001");
const userId = asUserId("00000000-0000-7000-8000-000000000002");
const workstreamId = asWorkstreamId("00000000-0000-7000-8000-000000000003");
const substreamId = asSubstreamId("00000000-0000-7000-8000-000000000004");
const automationId = "00000000-0000-7000-8000-000000000005";
const auth: AuthContext = {
  sessionId: "session-1",
  userId,
  workspaceId,
  region: "global",
  role: "member",
};

type ParentKind = "workstream" | "automation";

interface Recorded {
  /**
   * Every conversation object the request addressed.
   *
   * A set because the resolver derives the id twice for one stub, once to
   * answer a self-address locally and once to place it; what these tests are
   * about is which objects were reached, not how many times.
   */
  objectNames: Set<string>;
  /** Every product request the addressed object received. */
  productRequests: Array<{ operation: string } & Record<string, unknown>>;
  authorizeViewer: ReturnType<typeof vi.fn>;
  /** Which parent claims the id, which is what `resolveParent` asks each in turn. */
  parentKind: ParentKind;
}

function environment(recorded: Recorded): Env {
  return createTestEnv({
    APP_ENV: "test",
    AVALON_REGION: "global",
    LOG_LEVEL: "error",
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
      get: () => ({
        authority: async () => ({
          exists: recorded.parentKind === "workstream",
          authorityGeneration: 7,
          archived: false,
        }),
        authorizeViewer: recorded.authorizeViewer,
      }),
    }),
    AUTOMATION_DOS: createCloudflareTestBinding<Env["AUTOMATION_DOS"]>({
      idFromName: () => createTestDurableObjectId("automation"),
      get: () => ({
        authority: async () => ({
          exists: recorded.parentKind === "automation",
          authorityGeneration: 7,
          archived: false,
        }),
        authorizeViewer: recorded.authorizeViewer,
      }),
    }),
    SUBSTREAM_AGENTS: createCloudflareTestBinding<Env["SUBSTREAM_AGENTS"]>({
      idFromName: (name: string) => {
        recorded.objectNames.add(name);
        return createTestDurableObjectId(name);
      },
      get: () => ({
        handleProductRequest: (request: { operation: string } & Record<string, unknown>) => {
          recorded.productRequests.push(request);
          return {
            status: 200,
            bodyJson: JSON.stringify(testWorkstreamContract({
              id: workstreamId,
              workspaceId,
              readThroughSequenceNumber: 6,
              latestAttentionSequenceNumber: 6,
            })),
          };
        },
        // An automation admits its conversation's readers through the parent's
        // own rule, so the seat is written on the way in; a work-stream parent
        // never reaches this.
        executeIdentityOperation: () => ({
          status: 200,
          bodyJson: JSON.stringify({ ok: true, value: null }),
        }),
      }),
    }),
  });
}

function recorder(authorized = true, parentKind: ParentKind = "workstream"): Recorded {
  return {
    objectNames: new Set<string>(),
    productRequests: [],
    authorizeViewer: vi.fn(async () => ({ authorized, archived: false, membershipVersion: 0 })),
    parentKind,
  };
}

/**
 * Both families under one app, authenticated the way the middleware would.
 *
 * The auth middleware itself is not in front of them: what these tests read is
 * the addressing each route chooses once a session is established, and a route
 * that answered without one would be a different finding entirely.
 */
async function request(
  recorded: Recorded,
  path: string,
  body: unknown,
): Promise<{ status: number; code: unknown; body: Record<string, unknown> | null }> {
  const app = new Hono<HonoAppEnv>();
  app.use("*", async (c, next) => {
    c.set("auth", auth);
    await next();
  });
  app.route("/workstreams", workstreamRoutes);
  app.route("/conversations", conversationRoutes);
  app.onError(errorHandler);
  const response = await app.request(
    `https://api.example.com${path}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    environment(recorded),
  );
  const payload = await response.json().catch(() => null) as
    (Record<string, unknown> & { error?: { code?: unknown } }) | null;
  return { status: response.status, code: payload?.error?.code, body: payload };
}

const read = { readThroughSequenceNumber: 6, observedManualUnreadGeneration: 2 };

describe("acknowledging a read", () => {
  it("moves the waterline on the private substream that was read, not on Main", async () => {
    const recorded = recorder();

    const answer = await request(
      recorded,
      `/conversations/${workstreamId}/substreams/${substreamId}/read-state`,
      read,
    );

    expect(answer.status).toBe(200);
    // The child's own object, and only it. Main's name is this name without the
    // trailing substream, so a request that reached Main would appear here too.
    expect([...recorded.objectNames]).toEqual([
      conversationObjectName("global", workspaceId, workstreamId, substreamId),
    ]);
    expect(recorded.productRequests).toEqual([expect.objectContaining({
      operation: "acknowledge_read",
      input: read,
      auth: expect.objectContaining({ userId, workspaceId }),
    })]);
    // Addressed as itself: the parent is asked about this child's membership
    // rather than about the work stream around it.
    expect(recorded.authorizeViewer).toHaveBeenCalledWith({
      workspaceId, parentId: workstreamId, substreamId, userId,
    });
  });

  it("moves Main's waterline when Main is the conversation on screen", async () => {
    const recorded = recorder();

    const answer = await request(
      recorded,
      `/conversations/${workstreamId}/substreams/0/read-state`,
      read,
    );

    expect(answer.status).toBe(200);
    expect([...recorded.objectNames]).toEqual([
      conversationObjectName("global", workspaceId, workstreamId),
    ]);
    expect(recorded.productRequests).toEqual([expect.objectContaining({
      operation: "acknowledge_read",
      input: read,
    })]);
  });

  it("refuses a substream the parent does not admit this person to, before the object is touched", async () => {
    const recorded = recorder(false);

    const answer = await request(
      recorded,
      `/conversations/${workstreamId}/substreams/${substreamId}/read-state`,
      read,
    );

    // A 404 rather than a 403: whether a private substream exists is itself
    // something somebody outside it is not told.
    expect(answer.status).toBe(404);
    expect(answer.code).toBe("conversation_not_found");
    expect([...recorded.objectNames]).toEqual([]);
    expect(recorded.productRequests).toEqual([]);
  });

  it("records a read in an automation's conversation through the automation that owns it", async () => {
    // The old route resolved every parent id as a work stream, so a Sidekick's
    // conversation recorded its reads without its own parent ever deciding
    // whether this person may read them. It now takes the path its boot takes.
    const recorded = recorder(true, "automation");

    const answer = await request(
      recorded,
      `/conversations/${automationId}/substreams/0/read-state`,
      read,
    );

    expect(answer.status).toBe(200);
    expect([...recorded.objectNames]).toEqual([
      conversationObjectName("global", workspaceId, automationId),
    ]);
    expect(recorded.productRequests).toEqual([expect.objectContaining({
      operation: "acknowledge_read",
      input: read,
    })]);
    expect(recorded.authorizeViewer).toHaveBeenCalledWith({
      workspaceId, parentId: automationId, substreamId: "0", userId,
    });
  });

  it("is no longer answered by the work stream, which could only ever advance Main", async () => {
    const recorded = recorder();

    const answer = await request(recorded, `/workstreams/${workstreamId}/read-state`, read);

    expect(answer.status).toBe(404);
    expect([...recorded.objectNames]).toEqual([]);
    expect(recorded.productRequests).toEqual([]);
  });
});
