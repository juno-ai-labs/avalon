import { asUserId, asWorkspaceId } from "@rally/contracts";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { workOpportunityRoutes } from "../src/routes/work-opportunities";
import { WorkOpportunityService } from "../src/services/work-opportunity-service";
import {
  createCloudflareTestBinding,
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestDurableObjectId,
  createTestEnv,
} from "./helpers/cloudflare-test";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000008a0");
const USER_ID = asUserId("00000000-0000-7000-8000-0000000008a1");
const OPPORTUNITY_ID = "00000000-0000-7000-8000-0000000008a2";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000008a3";
const MESSAGE_ID = "00000000-0000-7000-8000-0000000008a4";
const CREATED_AT = "2026-08-24T18:00:00.000Z";

const CONTEXT = {
  opportunityId: OPPORTUNITY_ID,
  version: 3,
  audienceScope: "workspace" as const,
  createdAt: CREATED_AT,
  impressionCount: 2,
  firstImpressedAt: "2026-08-24T18:05:00.000Z",
  connectorTypes: ["github" as const],
};

function fixture(context: typeof CONTEXT | null = CONTEXT): {
  app: Hono<HonoAppEnv>;
  env: Env;
  recordOpportunityImpressions: ReturnType<typeof vi.fn>;
  dismissOpportunity: ReturnType<typeof vi.fn>;
} {
  const recordOpportunityImpressions = vi.fn(async () => context ? [context] : []);
  const dismissOpportunity = vi.fn(async () => ({ dismissed: true, telemetryContext: context }));
  const stub = { recordOpportunityImpressions, dismissOpportunity };
  const workspaceObjects = createCloudflareTestBinding<DurableObjectNamespace>({
    idFromName: vi.fn((name: string) => createTestDurableObjectId(name)),
    get: vi.fn(() => stub),
  });
  // D1 remains the control-plane source for immutable object placement. Every
  // other statement fails so this route test catches any attempt to restore a
  // regional product-state read after migration 0090.
  const database = createTestD1Database({
    prepare: vi.fn((sql: string) => {
      if (!sql.includes("SELECT placement_affinity FROM workspaces")) {
        throw new Error(`regional_product_read:${sql}`);
      }
      return createTestD1PreparedStatement({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn(async () => ({ placement_affinity: "wnam" })),
      });
    }),
  });
  const env = createTestEnv({
    APP_ENV: "development",
    AVALON_REGION: "global",
    DB: database,
    WORKSPACE_DOS: workspaceObjects,
  });
  const app = new Hono<HonoAppEnv>();
  app.use("*", async (contextValue, next) => {
    contextValue.set("auth", {
      sessionId: "session",
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      region: "global",
      role: "member",
    });
    await next();
  });
  app.route("/work-opportunities", workOpportunityRoutes);
  app.onError(errorHandler);
  return { app, env, recordOpportunityImpressions, dismissOpportunity };
}

describe("suggested-work HTTP product actions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not use the Electron visibility flag as API authorization", async () => {
    const { app, env, recordOpportunityImpressions } = fixture();
    const evaluate = vi.fn(async (flagKey: string) => ({
      flagKey, value: false, variant: "off", reason: "STATIC",
    }));
    env.FLAGS = createCloudflareTestBinding<Flagship>({ getBooleanDetails: evaluate });

    const response = await app.request("/work-opportunities/impressions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opportunityIds: [OPPORTUNITY_ID], surface: "workspace_home" }),
    }, env);

    expect(response.status).toBe(204);
    expect(recordOpportunityImpressions).toHaveBeenCalledOnce();
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("records impressions without reading retired D1 product tables", async () => {
    const { app, env, recordOpportunityImpressions } = fixture();

    const response = await app.request("/work-opportunities/impressions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opportunityIds: [OPPORTUNITY_ID], surface: "workspace_home" }),
    }, env);

    expect(response.status).toBe(204);
    expect(recordOpportunityImpressions).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      opportunityIds: [OPPORTUNITY_ID],
    }));
  });

  it("dismisses when WorkspaceDO cannot supply optional telemetry context", async () => {
    const { app, env, dismissOpportunity } = fixture(null);

    const response = await app.request(
      `/work-opportunities/${OPPORTUNITY_ID}?surface=workspace_home&version=3&position=1`,
      { method: "DELETE" },
      env,
    );

    expect(response.status).toBe(204);
    expect(dismissOpportunity).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      opportunityId: OPPORTUNITY_ID,
    }));
  });

  it("starts work without reading retired D1 product tables", async () => {
    const { app, env } = fixture();
    const start = vi.spyOn(WorkOpportunityService.prototype, "start").mockResolvedValue({
      workstream: {
        id: WORKSTREAM_ID,
        workspaceId: WORKSPACE_ID,
        title: "Follow up",
        objective: "Follow up",
        originType: "ad_hoc",
        originLabel: null,
        createdByUserId: USER_ID,
        automationSubscriptionId: null,
        automationRunId: null,
        plannedFor: null,
        harnessStatus: "scheduled",
        latestAttentionSequenceNumber: 0,
        readThroughSequenceNumber: 0,
        manualUnreadFromSequenceNumber: null,
        manualUnreadGeneration: 0,
        hasUnread: false,
        firstUnreadSequenceNumber: null,
        lastActivityAt: CREATED_AT,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        archivedAt: null,
      },
      turnId: MESSAGE_ID,
      harnessRunId: null,
      telemetryContext: CONTEXT,
    } as never);

    const response = await app.request(`/work-opportunities/${OPPORTUNITY_ID}/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 3,
        idempotencyKey: "start-once",
        surface: "workspace_home",
        position: 1,
      }),
    }, env);

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ turnId: MESSAGE_ID });
    expect(start).toHaveBeenCalledWith(OPPORTUNITY_ID, 3, "start-once");
  });
});
