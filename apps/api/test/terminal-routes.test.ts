import { asUserId, asWorkspaceId } from "@rally/contracts";
import {
  TerminalNetworkPolicyPreviewSchema,
  TerminalWorkspaceSettingsSchema,
} from "@rally/contracts";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import type { Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { workspaceRoutes } from "../src/routes/workspace";
import { createTestEnv } from "./helpers/cloudflare-test";
import {
  createTestWorkspaceDO,
  workspaceObjectRpcs,
} from "./helpers/workspace-object-rpcs";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import type { DatabaseSync } from "node:sqlite";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamContract,
  testWorkstreamObjectStore,
  seedWorkstreamObjectParticipant,
} from "./helpers/durable-authority";

const W = asWorkspaceId("72000000-0000-4000-8000-000000000001");
const S = "72000000-0000-4000-8000-000000000002";
const U = asUserId("72000000-0000-4000-8000-000000000003");
const databases: ReturnType<typeof preRetirementProductSqliteDatabase>[] = [];
const objectDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const database of objectDatabases.splice(0)) database.close();
});

function fixture(options: { authenticated?: boolean; role?: "owner" | "member" } = {}): { app: Hono<HonoAppEnv>; env: Env } {
  const database = preRetirementProductSqliteDatabase();
  databases.push(database);
  // Terminal state and the settings walk read through the object port and the
  // WorkspaceDO directory once the authority is open; the D1 copies are gone.
  openWorkstreamAuthorityForTest(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${U}', 'terminal-route', 'route@example.com', 'Route', '2026-08-13', '2026-08-13');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${W}', 'Route', 'terminal-route', 'global', '${U}', '2026-08-13', '2026-08-13');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${W}', '${U}', 'owner', 'active', '2026-08-13');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${S}', '${W}', 'Terminal route', 'Route', 'ad_hoc', '${U}', 'idle',
            '2026-08-13', '2026-08-13', '2026-08-13');
    INSERT INTO workstream_participants
      (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
    VALUES ('${S}', '${U}', '${U}', 'creator', '2026-08-13');
  `);
  const objectStore = testWorkstreamObjectStore();
  databases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId: S, workspaceId: W });
  // The participant gate reads through the object port, so the creator's
  // membership has to exist there, not only in the regional index.
  seedWorkstreamObjectParticipant(objectStore, {
    userId: U,
    participationReason: "creator",
    addedAt: Date.parse("2026-08-13T00:00:00.000Z"),
  });
  const objectStores = new Map<string, DatabaseSync>([[S, objectStore]]);
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    TERMINAL_REGION_CAPABILITY: "unsupported",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: {
        // The settings preview asks each work stream's parent, hosted here,
        // which conversations own a sandbox. This fixture seeds one, the main
        // conversation's.
        childTerminalDeadlines: async (input: { parentId: string }) => ({
          items: objectStores.has(input.parentId)
            ? [{ substreamId: "0", nextTerminalActionAt: "2026-08-13T00:00:00.000Z" }]
            : [],
        }),
        // A real WorkspaceDO decides the network policy, so the route test
        // exercises the object's revision fencing rather than a stand-in.
        ...workspaceObjectRpcs(createTestWorkspaceDO({
          workspaceId: W,
          regionalDatabase: database,
          register: (created) => { objectDatabases.push(created); },
        }).instance, [
          "terminalNetworkSettings",
          "terminalNetworkMode",
          "recordTerminalPolicyPreview",
          "claimTerminalPolicyApplication",
          "failTerminalPolicyApplication",
          "commitTerminalPolicyApplication",
        ]),
        canReadWorkstream: async () => true,
        listWorkstreams: async () => ({
          items: [testWorkstreamContract({
            id: S, workspaceId: W, title: "Terminal route", harnessStatus: "idle",
          })],
          stateVersions: [{
            workstreamId: S,
            commonEventId: "00000000-0000-7000-8000-0000000000e1",
            viewerEventId: null,
            authorityGeneration: 1,
            commonWaterline: 1,
            viewerWaterline: 0,
          }],
          nextCursor: null,
          directoryWaterline: 0,
        }),
      },
    }),
  });
  const app = new Hono<HonoAppEnv>();
  app.use("*", async (context, next) => {
    if (options.authenticated !== false) {
      context.set("auth", {
        sessionId: "session", workspaceId: W, userId: U, region: "global", role: options.role ?? "owner",
      });
    }
    await next();
  });
  app.route("/workspace", workspaceRoutes);
  app.onError(errorHandler);
  return { app, env };
}

describe("Terminal HTTP route contracts", () => {
  it("serves workspace settings through the real route schema", async () => {
    const { app, env } = fixture();
    const settings = await app.request("/workspace/terminal", undefined, env);
    expect(settings.status).toBe(200);
    const settingsBody = await settings.json() as Record<string, unknown>;
    expect(TerminalWorkspaceSettingsSchema.parse(settingsBody)).toMatchObject({
      availability: "unsupported", mode: "trusted_only", revision: 1,
    });
    expect(settingsBody).not.toHaveProperty("baselineGroups");
    expect(settingsBody).not.toHaveProperty("effectiveDomains");
  });

  it("previews and applies a revision-fenced network policy through HTTP", async () => {
    const { app, env } = fixture();
    const previewResponse = await app.request("/workspace/terminal/network-policy/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, mode: "full_internet", customDomains: [] }),
    }, env);
    expect(previewResponse.status).toBe(200);
    const preview = TerminalNetworkPolicyPreviewSchema.parse(await previewResponse.json());
    expect(preview).toMatchObject({ proposedMode: "full_internet" });

    const applyResponse = await app.request("/workspace/terminal/network-policy/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mutationId: preview.mutationId, expectedRevision: 1, confirmed: true }),
    }, env);
    expect(applyResponse.status).toBe(200);
    expect(TerminalWorkspaceSettingsSchema.parse(await applyResponse.json())).toMatchObject({
      mode: "full_internet", revision: 2, verificationState: "verified",
    });
  });

  it("rejects unauthenticated, non-admin, malformed, and invalid-id requests", async () => {
    const unauthenticated = fixture({ authenticated: false });
    expect((await unauthenticated.app.request("/workspace/terminal", undefined, unauthenticated.env)).status).toBe(401);

    const member = fixture({ role: "member" });
    expect((await member.app.request("/workspace/terminal/network-policy/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 1, mode: "full_internet", customDomains: [] }),
    }, member.env)).status).toBe(403);

    const owner = fixture();
    for (const [path, body] of [
      ["/workspace/terminal/network-policy/preview", { mode: "trusted_only" }],
      ["/workspace/terminal/network-policy/apply", {}],
    ] as const) {
      const response = await owner.app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, owner.env);
      expect(response.status).toBe(400);
    }
  });
});
