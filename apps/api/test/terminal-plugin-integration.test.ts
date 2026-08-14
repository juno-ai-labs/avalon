import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { __integrationTesting } from "../src/services/integrations";
import { createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const W = "30000000-0000-4000-8000-000000000001";
const S = "30000000-0000-4000-8000-000000000002";
const R = "30000000-0000-4000-8000-000000000003";
const U = "30000000-0000-4000-8000-000000000004";

const openDatabases: ReturnType<typeof migratedSqliteDatabase>[] = [];
afterEach(() => { for (const database of openDatabases.splice(0)) database.close(); });

function fixture(capability: "supported" | "unsupported", emergencyDisabled = false) {
  const database = migratedSqliteDatabase();
  openDatabases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${U}', 'plugin-user', 'plugin@example.com', 'Plugin', '2026-08-13', '2026-08-13');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${W}', 'Plugin', 'terminal-plugin', 'global', '${U}', '2026-08-13', '2026-08-13');
    INSERT INTO workspace_members (workspace_id, user_id, role, status, joined_at)
    VALUES ('${W}', '${U}', 'owner', 'active', '2026-08-13');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${S}', '${W}', 'Plugin', 'Plugin', 'ad_hoc', '${U}', 'idle',
            '2026-08-13', '2026-08-13', '2026-08-13');
    INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
    VALUES ('${R}', '${W}', '${S}', 'test', '{"type":"user","userId":"${U}"}', 'running', '2026-08-13');
  `);
  const env = createTestEnv({
    DB: sqliteD1(database), AVALON_REGION: "global",
    PUBLIC_API_BASE_URL: "https://api.with-avalon.com",
    TERMINAL_REGION_CAPABILITY: capability,
    DAYTONA_API_KEY: "daytona-key", DAYTONA_API_URL: "https://app.daytona.io/api",
    DAYTONA_TARGET: "us", DAYTONA_TERMINAL_SNAPSHOT: "terminal-snapshot",
    TERMINAL_EMERGENCY_DISABLED: emergencyDisabled ? "true" : "false",
  });
  const input: WorkstreamWorkflowInput = {
    region: "global", workspaceId: W, workstreamId: S, harnessRunId: R,
    triggerMessageId: null, automationSubscriptionId: null, activityId: null,
    executionPrincipal: { type: "user", userId: U }, reason: "user_message",
  };
  return { database, env, input };
}

describe("Terminal Bind integration", () => {
  it("registers the complete deferred plugin without allocating a sandbox", async () => {
    const { database, env, input } = fixture("supported");
    const tools = await __integrationTesting.loadHarnessTools(env, input);
    const plugin = tools.plugins.find((candidate) => candidate.canonicalId === "avalon:terminal");

    expect(plugin).toMatchObject({ preload: false, explicit: false, shortWireName: "terminal" });
    expect(plugin?.tools.map((tool) => tool.definition.name)).toEqual([
      "read_file", "edit_file", "write_file", "apply_patch", "run_command",
      "checkout_repository", "import_resource", "publish_resource", "publish_branch_and_pr",
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM workstream_sandboxes").get()).toEqual({ count: 0 });
  });

  it("omits Terminal in unsupported regions", async () => {
    const { env, input } = fixture("unsupported");
    const tools = await __integrationTesting.loadHarnessTools(env, input);
    expect(tools.plugins.some((plugin) => plugin.canonicalId === "avalon:terminal")).toBe(false);
  });

  it("omits Terminal without crashing when an opted-in development environment is incomplete", async () => {
    const { env, input } = fixture("supported");
    delete env.DAYTONA_API_KEY;
    delete env.DAYTONA_TARGET;
    const tools = await __integrationTesting.loadHarnessTools(env, input);
    expect(tools.plugins.some((plugin) => plugin.canonicalId === "avalon:terminal")).toBe(false);
  });

  it("keeps the complete plugin visible while the emergency breaker blocks provider operations", async () => {
    const { env, input } = fixture("supported", true);
    const tools = await __integrationTesting.loadHarnessTools(env, input);
    const plugin = tools.plugins.find((candidate) => candidate.canonicalId === "avalon:terminal");
    expect(plugin?.tools).toHaveLength(9);
    await expect(plugin!.tools.find((tool) => tool.definition.name === "read_file")!.execute!(
      { filePath: "README.md" },
      {
        workspaceId: W, workstreamId: S, harnessRunId: R, toolCallId: "breaker-call",
        executionPrincipal: { type: "user", userId: U }, signal: new AbortController().signal,
      },
    )).rejects.toMatchObject({
      code: "sandbox_unavailable",
      details: { reason: "Wait for an operator to re-enable Terminal before trying another tool." },
    });
  });
});
