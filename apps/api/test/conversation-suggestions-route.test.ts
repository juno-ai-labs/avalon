/**
 * The dismiss route for a conversation suggestion: which object it reaches,
 * how it is admitted, and what it answers. The row's lifecycle itself runs
 * against real Durable Object SQLite in `conversation-suggestions.test.ts`;
 * what this file reads is the addressing and the admission, the two things a
 * route can get wrong on its own.
 */
import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { conversationObjectName } from "../src/durable-objects/names";
import type { AuthContext, Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { conversationRoutes } from "../src/routes/conversations";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-000000000011");
const userId = asUserId("00000000-0000-7000-8000-000000000012");
const workstreamId = asWorkstreamId("00000000-0000-7000-8000-000000000013");
const substreamId = asSubstreamId("00000000-0000-7000-8000-000000000014");
const suggestionId = "00000000-0000-7000-8000-000000000015";
const auth: AuthContext = { sessionId: "session-1", userId, workspaceId, region: "global", role: "member" };

interface Recorded {
  objectNames: Set<string>;
  productRequests: Array<{ operation: string } & Record<string, unknown>>;
  authorizeViewer: ReturnType<typeof vi.fn>;
  objectAnswer: { status: number; body: unknown };
}

function environment(recorded: Recorded): Env {
  return createTestEnv({
    APP_ENV: "test",
    AVALON_REGION: "global",
    LOG_LEVEL: "error",
    DB: createTestD1Database({
      prepare: () => createTestD1PreparedStatement({
        first: async () => ({ phase: "durable_object_open", generation: 7, required_serving_contract_version: 1, serving_contract_version: 1 }),
      }),
    }),
    WORKSPACE_DOS: createCloudflareTestBinding<Env["WORKSPACE_DOS"]>({
      idFromName: () => createTestDurableObjectId("workspace"),
      get: () => ({
        resolveHostedParent: async () => ({ kind: "workstream", authority: { exists: true, authorityGeneration: 7, archived: false } }),
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
          return { status: recorded.objectAnswer.status, bodyJson: JSON.stringify(recorded.objectAnswer.body) };
        },
      }),
    }),
  });
}

function recorder(authorized = true, objectAnswer: Recorded["objectAnswer"] = {
  status: 200, body: { suggestionId, status: "dismissed", replayed: false },
}): Recorded {
  return {
    objectNames: new Set<string>(),
    productRequests: [],
    authorizeViewer: vi.fn(async () => ({ authorized, archived: false, membershipVersion: 0 })),
    objectAnswer,
  };
}

async function dismiss(recorded: Recorded, substream: string, action = "dismiss"): Promise<{ status: number; code: unknown; body: Record<string, unknown> | null }> {
  const app = new Hono<HonoAppEnv>();
  app.use("*", async (c, next) => { c.set("auth", auth); await next(); });
  app.route("/conversations", conversationRoutes);
  app.onError(errorHandler);
  const response = await app.request(
    `https://api.example.com/conversations/${workstreamId}/substreams/${substream}/suggestions/${suggestionId}/${action}`,
    { method: "POST", headers: { "content-type": "application/json" } },
    environment(recorded),
  );
  const payload = await response.json().catch(() => null) as (Record<string, unknown> & { error?: { code?: unknown } }) | null;
  return { status: response.status, code: payload?.error?.code, body: payload };
}

describe("POST /conversations/:parentId/substreams/:substreamId/suggestions/:suggestionId/dismiss", () => {
  it("routes resolution to the readable writable conversation", async () => {
    const recorded = recorder(true, { status: 200, body: { suggestionId, status: "accepted", replayed: false } });
    const result = await dismiss(recorded, substreamId, "resolve");
    expect(result.status).toBe(200);
    expect(recorded.productRequests).toEqual([expect.objectContaining({ operation: "resolve_suggestion", suggestionId })]);
    expect([...recorded.objectNames]).toEqual([conversationObjectName("global", workspaceId, workstreamId, substreamId)]);
  });

  it("reaches the Breakout's own object as a read and answers the resolution", async () => {
    const recorded = recorder();
    const result = await dismiss(recorded, substreamId);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ suggestionId, status: "dismissed", replayed: false });
    expect([...recorded.objectNames]).toEqual([conversationObjectName("global", workspaceId, workstreamId, substreamId)]);
    expect(recorded.productRequests.map((request) => request.operation)).toEqual(["dismiss_suggestion"]);
    expect(recorded.productRequests[0]!.suggestionId).toBe(suggestionId);
    // Admitted as a read: the parent is asked whether this person may view, and
    // nothing about writability is checked, so a reader of an archived
    // conversation can still clear a line only readers see.
    expect(recorded.authorizeViewer).toHaveBeenCalledWith(expect.objectContaining({ userId, parentId: workstreamId, substreamId }));
  });

  it("addresses Main for substream 0", async () => {
    const recorded = recorder();
    await dismiss(recorded, "0");
    expect([...recorded.objectNames]).toEqual([conversationObjectName("global", workspaceId, workstreamId, asSubstreamId("0"))]);
  });

  it("refuses a viewer the parent does not admit, before any object is asked", async () => {
    const recorded = recorder(false);
    const result = await dismiss(recorded, substreamId);
    expect(result.status).toBe(404);
    expect(result.code).toBe("conversation_not_found");
    expect(recorded.productRequests).toEqual([]);
  });

  it("passes a suggestion the object does not hold through as the object's refusal", async () => {
    const recorded = recorder(true, { status: 404, body: { error: "suggestion_not_found" } });
    const result = await dismiss(recorded, substreamId);
    expect(result.status).toBe(404);
  });
});
