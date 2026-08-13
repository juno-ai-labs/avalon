import {
  TerminalNetworkPolicyPreviewSchema,
  TerminalWorkspaceSettingsSchema,
  TerminalWorkstreamStateSchema,
} from "@avalon/contracts";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import type { Env, HonoAppEnv } from "../src/env";
import { errorHandler } from "../src/middleware/errors";
import { workspaceRoutes } from "../src/routes/workspace";
import { workstreamRoutes } from "../src/routes/workstreams";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const W = "72000000-0000-4000-8000-000000000001";
const S = "72000000-0000-4000-8000-000000000002";
const U = "72000000-0000-4000-8000-000000000003";
const databases: ReturnType<typeof migratedSqliteDatabase>[] = [];

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture(options: { authenticated?: boolean; role?: "owner" | "member" } = {}): { app: Hono<HonoAppEnv>; env: Env } {
  const database = migratedSqliteDatabase();
  databases.push(database);
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
  const env = createTestEnv({
    DB: sqliteD1(database),
    AVALON_REGION: "global",
    TERMINAL_REGION_CAPABILITY: "unsupported",
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
  app.route("/workstreams", workstreamRoutes);
  app.onError(errorHandler);
  return { app, env };
}

describe("Terminal HTTP route contracts", () => {
  it("serves workspace and work-stream state through the real route schemas", async () => {
    const { app, env } = fixture();
    const settings = await app.request("/workspace/terminal", undefined, env);
    expect(settings.status).toBe(200);
    const settingsBody = await settings.json() as Record<string, unknown>;
    expect(TerminalWorkspaceSettingsSchema.parse(settingsBody)).toMatchObject({
      availability: "unsupported", mode: "trusted_only", revision: 1,
    });
    expect(settingsBody).not.toHaveProperty("baselineGroups");
    expect(settingsBody).not.toHaveProperty("effectiveDomains");

    const state = await app.request(`/workstreams/${S}/terminal`, undefined, env);
    expect(state.status).toBe(200);
    expect(TerminalWorkstreamStateSchema.parse(await state.json())).toMatchObject({
      availability: "unsupported", state: "absent", repository: null, repositoryRequest: null,
    });
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
    expect(preview).toMatchObject({ proposedMode: "full_internet", affectedWorkstreams: [] });

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

  it("serves the disconnected repository catalog and start-fresh endpoint", async () => {
    const { app, env } = fixture();
    const catalog = await app.request(`/workstreams/${S}/terminal/repositories`, undefined, env);
    expect(catalog.status).toBe(200);
    expect(await catalog.json()).toMatchObject({ state: "disconnected", connections: [] });

    const fresh = await app.request(`/workstreams/${S}/terminal/start-fresh`, { method: "POST" }, env);
    expect(fresh.status).toBe(200);
    expect(TerminalWorkstreamStateSchema.parse(await fresh.json())).toMatchObject({ state: "absent" });
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
      [`/workstreams/${S}/terminal/repository`, { connectionId: "not-an-id", repositoryFullName: "invalid" }],
    ] as const) {
      const response = await owner.app.request(path, {
        method: path.includes("/repository") ? "PUT" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }, owner.env);
      expect(response.status).toBe(400);
    }
    expect((await owner.app.request("/workstreams/not-a-uuid/terminal", undefined, owner.env)).status).toBe(400);
  });
});
