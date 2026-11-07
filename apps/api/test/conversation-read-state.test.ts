/**
 * Which conversation a read acknowledgement moves the waterline on.
 *
 * Read state is substream-owned: every `AgentLoopDO` keeps its own attention
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
  /** Which parent claims the id, which is what `resolveParent` asks the Organization, then the Sidekick. */
  parentKind: ParentKind;
  /** Whether the parent reports itself archived, which only a write is refused for. */
  archived: boolean;
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
    // The Organization object hosts every Channel parent and names the kind in
    // the same read that returns its authority; an id it does not host falls
    // through to the Sidekick's own object.
    WORKSPACE_DOS: createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: () => createTestDurableObjectId("workspace"),
      get: () => ({
        // Every parent, a Sidekick's included, is answered by the Organization.
        resolveHostedParent: async () => ({
          kind: recorded.parentKind,
          authority: { exists: true, authorityGeneration: 7, archived: recorded.archived },
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
          if (request.operation === "create_message") {
            return {
              status: 200,
              bodyJson: JSON.stringify({
                turn: {
                  turnId: "00000000-0000-7000-8000-000000000006",
                  clientMessageId: "00000000-0000-7000-8000-000000000007",
                  createdAt: "2026-09-22T12:00:00.000Z",
                },
                deliveryState: "pending",
              }),
            };
          }
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

function recorder(
  authorized = true,
  parentKind: ParentKind = "workstream",
  archived = false,
): Recorded {
  return {
    objectNames: new Set<string>(),
    productRequests: [],
    authorizeViewer: vi.fn(async () => ({ authorized, archived, membershipVersion: 0 })),
    parentKind,
    archived,
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
  method = "PATCH",
  headers: Record<string, string> = {},
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
      method,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    environment(recorded),
  );
  const payload = await response.json().catch(() => null) as
    (Record<string, unknown> & { error?: { code?: unknown } }) | null;
  return { status: response.status, code: payload?.error?.code, body: payload };
}

const read = { readThroughSequenceNumber: 6, observedManualUnreadGeneration: 2 };

describe("ordinary message admission", () => {
  it("sends a non-socket client through the authenticated conversation authority", async () => {
    const recorded = recorder();
    const clientMessageId = "00000000-0000-7000-8000-000000000007";

    const answer = await request(
      recorded,
      `/conversations/${workstreamId}/substreams/${substreamId}/messages`,
      { text: "Sent through the ordinary API", clientMessageId },
      "POST",
      { "x-rally-operation-id": clientMessageId },
    );

    expect(answer.status).toBe(201);
    expect(answer.body).toEqual({
      turn: {
        turnId: "00000000-0000-7000-8000-000000000006",
        clientMessageId,
        createdAt: "2026-09-22T12:00:00.000Z",
      },
      deliveryState: "pending",
    });
    expect([...recorded.objectNames]).toEqual([
      conversationObjectName("global", workspaceId, workstreamId, substreamId),
    ]);
    expect(recorded.productRequests).toEqual([expect.objectContaining({
      operation: "create_message",
      input: expect.objectContaining({
        text: "Sent through the ordinary API",
        clientMessageId,
        telemetryOperationId: clientMessageId,
        telemetryJourney: "message_send",
      }),
      auth: expect.objectContaining({ userId, workspaceId }),
    })]);
    expect(recorded.authorizeViewer).toHaveBeenCalledWith({
      workspaceId, parentId: workstreamId, substreamId, userId,
    });
  });
});

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

  it("still answers a released desktop on the work-stream route, for Main and only Main", async () => {
    // The Worker deploys ahead of the desktop and the updater installs on quit,
    // so a build that is open while this ships keeps sending here. A 404 would
    // not just leave its dividers up: the client re-requests a socket snapshot
    // on a failed acknowledgement and the snapshot re-runs the send. The shim
    // answers Main, which is all that client ever addressed.
    const recorded = recorder();

    const answer = await request(recorded, `/workstreams/${workstreamId}/read-state`, read);

    expect(answer.status).toBe(200);
    expect([...recorded.objectNames]).toEqual([
      conversationObjectName("global", workspaceId, workstreamId),
    ]);
    expect(recorded.productRequests).toEqual([expect.objectContaining({
      operation: "acknowledge_read",
      input: read,
    })]);
    // It goes through the parent rather than straight to the object, which is
    // the `authorizeViewer` the route it replaces skipped.
    expect(recorded.authorizeViewer).toHaveBeenCalledWith({
      workspaceId, parentId: workstreamId, substreamId: "0", userId,
    });
  });

  it("records a read in an archived automation's conversation, which stays readable", async () => {
    // The route resolves a read-authorized client on purpose. An automation's
    // conversation is still readable once the automation is archived, and a
    // reader who can see a divider has to be able to clear it; `writableClient`
    // would answer 409 here and strand that divider the way this change exists
    // to stop. Swapping the route to it turns this test red and nothing else.
    const recorded = recorder(true, "automation", true);

    const answer = await request(
      recorded,
      `/conversations/${automationId}/substreams/0/read-state`,
      read,
    );

    expect(answer.status).toBe(200);
    expect(recorded.productRequests).toEqual([expect.objectContaining({
      operation: "acknowledge_read",
    })]);
  });
});
