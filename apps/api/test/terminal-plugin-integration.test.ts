import { asWorkspaceId, asWorkstreamId } from "@avalon/contracts";
import { asHarnessRunId, asUserId } from "@avalon/contracts";
import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { __integrationTesting } from "../src/services/integrations";
import { withWorkstreamRuntimeDatabase } from "../src/services/workstream-runtime-database";
import { createTestEnv } from "./helpers/cloudflare-test";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import type { DatabaseSync } from "node:sqlite";
import {
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  workstreamObjectRun,
} from "./helpers/durable-authority";

const W = asWorkspaceId("30000000-0000-4000-8000-000000000001");
const S = asWorkstreamId("30000000-0000-4000-8000-000000000002");
const R = asHarnessRunId("30000000-0000-4000-8000-000000000003");
const U = asUserId("30000000-0000-4000-8000-000000000004");

const openDatabases: ReturnType<typeof preRetirementProductSqliteDatabase>[] = [];
afterEach(() => { for (const database of openDatabases.splice(0)) database.close(); });

function fixture(capability: "supported" | "unsupported", emergencyDisabled = false) {
  const database = preRetirementProductSqliteDatabase();
  openDatabases.push(database);
  // Tool loading routes work-stream state through the object port once the
  // authority is open; the run row lives only there since migration 0090.
  openWorkstreamAuthorityForTest(database);
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
  `);
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId: S, workspaceId: W });
  const objectStores = new Map<string, DatabaseSync>([[S, objectStore]]);
  workstreamObjectRun(
    objectStore,
    `INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
    VALUES (?, ?, ?, 'test', ?, 'running', '2026-08-13')`,
    R, W, S, JSON.stringify({ type: "user", userId: U }),
  );
  const env = createTestEnv({
    DB: sqliteD1(database), AVALON_REGION: "global",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(database, { objectStores }),
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
  return { database, objectStore, env, input };
}

describe("Terminal Bind integration", () => {
  it("registers the complete deferred plugin without allocating a sandbox", async () => {
    const { objectStore, env, input } = fixture("supported");
    const tools = await __integrationTesting.loadHarnessTools(withWorkstreamRuntimeDatabase(env, W, S), input);
    const plugin = tools.plugins.find((candidate) => candidate.canonicalId === "avalon:terminal");

    expect(plugin).toMatchObject({ preload: false, explicit: false, shortWireName: "terminal" });
    expect(plugin?.tools.map((tool) => tool.definition.name)).toEqual([
      "read_file", "edit_file", "write_file", "apply_patch", "run_command",
      "checkout_repository", "import_resource", "publish_resource", "publish_branch_and_pr",
    ]);
    expect(workstreamObjectGet(objectStore, "SELECT COUNT(*) AS count FROM workstream_sandboxes")).toEqual({ count: 0 });
  });

  it("omits Terminal in unsupported regions", async () => {
    const { env, input } = fixture("unsupported");
    const tools = await __integrationTesting.loadHarnessTools(withWorkstreamRuntimeDatabase(env, W, S), input);
    expect(tools.plugins.some((plugin) => plugin.canonicalId === "avalon:terminal")).toBe(false);
  });

  it("omits Terminal without crashing when an opted-in development environment is incomplete", async () => {
    const { env, input } = fixture("supported");
    delete env.DAYTONA_API_KEY;
    delete env.DAYTONA_TARGET;
    const tools = await __integrationTesting.loadHarnessTools(withWorkstreamRuntimeDatabase(env, W, S), input);
    expect(tools.plugins.some((plugin) => plugin.canonicalId === "avalon:terminal")).toBe(false);
  });

  it("keeps the complete plugin visible while the emergency breaker blocks provider operations", async () => {
    const { env, input } = fixture("supported", true);
    const tools = await __integrationTesting.loadHarnessTools(withWorkstreamRuntimeDatabase(env, W, S), input);
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
