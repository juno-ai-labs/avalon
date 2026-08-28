/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { asWorkspaceId } from "@rally/contracts";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { workspaceDOName } from "../src/durable-objects/names";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000000d1");
const USER_ID = "00000000-0000-7000-8000-0000000000d2";
const AUTOMATION_ID = "00000000-0000-7000-8000-0000000000d3";
const TEMPLATE_ID = "00000000-0000-7000-8000-0000000000d4";
const VERSION_ID = "00000000-0000-7000-8000-0000000000d5";

function workspaceStub() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

beforeEach(async () => reset());

describe("automation authority cutover", () => {
  it("gives a fresh WorkspaceDO the final schema without legacy lifecycle tables", async () => {
    await runInDurableObject(workspaceStub(), async (instance: WorkspaceDO, state) => {
      (instance as unknown as {
        ensureIdentity(workspaceId: string, placement: "wnam"): void;
      }).ensureIdentity(WORKSPACE_ID, "wnam");
      const tables = new Set(state.storage.sql.exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table'`,
      ).toArray().map((row) => row.name));
      expect(tables.has("automation_subscriptions")).toBe(false);
      expect(tables.has("automation_runs")).toBe(false);
      expect(tables.has("automation_delivery_targets")).toBe(false);
      expect(state.storage.sql.exec<{ state: string }>(
        `SELECT state FROM automation_cutover_campaign WHERE id = 1`,
      ).one().state).toBe("completed");
      expect(state.storage.sql.exec<{ name: string }>(
        `PRAGMA table_info(schedules)`,
      ).toArray().map((column) => column.name)).not.toContain("automation_subscription_id");
    });
  });

  it("imports accepted rows, discards audited drafts, and makes cleanup replay safe", async () => {
    const stub = workspaceStub();
    await runInDurableObject(stub, async (_instance: WorkspaceDO, state) => {
      const now = "2026-08-28T09:00:00.000Z";
      state.storage.sql.exec(
        `INSERT INTO workspace_identity
           (id, workspace_id, region, placement_affinity, created_at, updated_at)
         VALUES (1, ?, 'global', 'wnam', ?, ?)`, WORKSPACE_ID, Date.parse(now), Date.parse(now),
      );
      state.storage.sql.exec(
        `INSERT INTO automation_templates
           (id, workspace_id, owner_user_id, name, description, sharing_state,
            latest_version_number, created_at, updated_at)
         VALUES (?, ?, ?, 'Imported helper', 'Runs on request', 'private', 1, ?, ?)`,
        TEMPLATE_ID, WORKSPACE_ID, USER_ID, now, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_template_versions
           (id, template_id, version_number, instructions, trigger_definitions_json,
            required_capabilities_json, expected_outputs_json, default_behavior_json,
            created_by_user_id, created_at, overview, recommended_plugins_json,
            memory_tables_json)
         VALUES (?, ?, 1, 'Do the requested work.', '[{"type":"manual"}]', '[]', '[]',
                 '{}', ?, ?, 'A manual automation', '[]', '[]')`,
        VERSION_ID, TEMPLATE_ID, USER_ID, now,
      );
      state.storage.sql.exec(
        `INSERT INTO automation_subscriptions
           (id, workspace_id, template_id, template_version_id, scope, owner_user_id,
            execution_principal_json, connector_bindings_json, overrides_json, status,
            created_at, updated_at, default_plugins_json, activity_trigger_bindings_json,
            lifecycle_state)
         VALUES (?, ?, ?, ?, 'personal', ?, ?, '{}', '{}', 'active', ?, ?, '[]', '{}', 'visible')`,
        AUTOMATION_ID, WORKSPACE_ID, TEMPLATE_ID, VERSION_ID, USER_ID,
        JSON.stringify({ type: "user", userId: USER_ID }), now, now,
      );
    });

    await expect(stub.finalizeAutomationCutover({
      workspaceId: WORKSPACE_ID,
      expectedDraftIds: [],
    })).resolves.toMatchObject({ state: "completed", imported: 1, discardedDrafts: 0 });
    await expect(stub.finalizeAutomationCutover({
      workspaceId: WORKSPACE_ID,
      expectedDraftIds: [],
    })).resolves.toMatchObject({ state: "completed", imported: 1 });

    await runInDurableObject(stub, async (_instance: WorkspaceDO, state) => {
      expect(state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM automation_directory WHERE automation_id = ?`, AUTOMATION_ID,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec<{ state: string }>(
        `SELECT state FROM automation_cutover_campaign WHERE id = 1`,
      ).one().state).toBe("completed");
      expect(state.storage.sql.exec<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automation_subscriptions'`,
      ).toArray()).toHaveLength(0);
    });
  });
});
