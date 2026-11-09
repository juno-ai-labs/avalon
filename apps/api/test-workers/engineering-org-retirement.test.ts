/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Retiring an Organization from the engineering MCP, against real objects.
 *
 * The bridge calls the same operator door as Ace's Retire button, so these
 * tests check what that door owes: the D1 fence, the tombstone, and an audit
 * pair naming the Access operator.
 */

import { env } from "cloudflare:workers";
import { createExecutionContext, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import type { Env } from "../src/env";
import { ensureAuditSchema } from "./helpers/audit-fixture";
import { seedInspectableWorkspace } from "./helpers/engineering-inspection-fixture";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ef40");
const USER_ID = asUserId("00000000-0000-7000-8000-00000000ef41");
const OTHER_WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ef42");
const NOW = "2026-11-09T10:00:00.000Z";
const OPERATOR = { subject: "access-engineer", email: "engineer@example.com", audience: "engineering-mcp" };
const TEST_ENV: Env = env;

function bridge(): EngineeringInspectionBridge {
  return new EngineeringInspectionBridge(createExecutionContext(), TEST_ENV);
}

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

beforeEach(async () => {
  await reset();
  await seedInspectableWorkspace(env.DB, {
    workspaceId: WORKSPACE_ID, userId: USER_ID, sessionId: "00000000-0000-7000-8000-00000000ef43", at: NOW,
  });
  // The door's fence write stamps `updated_at`, which the shared fixture leaves out.
  await env.DB.prepare("ALTER TABLE workspaces ADD COLUMN updated_at TEXT").run();
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await ensureAuditSchema();
  await env.AUDIT_DB.prepare("DELETE FROM audit_events WHERE workspace_id IN (?, ?)")
    .bind(WORKSPACE_ID, OTHER_WORKSPACE_ID).run();
});

describe("engineering retirement of an Organization", () => {
  it("closes the Organization through the operator door and audits the Access operator", async () => {
    const receipt = await bridge().retireOrg({ orgId: WORKSPACE_ID }, OPERATOR);
    expect(receipt).toMatchObject({ region: "global", workspaceId: WORKSPACE_ID, complete: true, remaining: 0, failed: [] });

    const row = await env.DB.prepare("SELECT abandoned_at FROM workspaces WHERE id = ?")
      .bind(WORKSPACE_ID).first<{ abandoned_at: string | null }>();
    expect(row?.abandoned_at).not.toBeNull();
    expect(await workspace().objectRetirementState()).toMatchObject({ retired: true });

    const audits = (await env.AUDIT_DB.prepare(
      "SELECT action, target_type, target_id, metadata_json FROM audit_events WHERE workspace_id = ? ORDER BY action",
    ).bind(WORKSPACE_ID).all<{ action: string; target_type: string; target_id: string; metadata_json: string }>()).results;
    expect(audits.map(({ action, target_type, target_id }) => ({ action, target_type, target_id }))).toEqual([
      { action: "engineering.retire_org.attempt", target_type: "workspace", target_id: WORKSPACE_ID },
      { action: "engineering.retire_org.result", target_type: "workspace", target_id: WORKSPACE_ID },
    ]);
    expect(JSON.parse(audits[1]!.metadata_json)).toMatchObject({ operator: OPERATOR, outcome: "admitted", complete: true });
  });

  it("refuses an Organization this region does not hold, by its code, and closes nothing", async () => {
    await expect(bridge().retireOrg({ orgId: OTHER_WORKSPACE_ID }, OPERATOR))
      .rejects.toThrow("engineering_operation_failed:workspace_not_found");
    const result = await env.AUDIT_DB.prepare(
      "SELECT metadata_json FROM audit_events WHERE workspace_id = ? AND action = 'engineering.retire_org.result'",
    ).bind(OTHER_WORKSPACE_ID).first<{ metadata_json: string }>();
    expect(JSON.parse(result!.metadata_json)).toMatchObject({ outcome: "failed_or_uncertain", errorCode: "workspace_not_found" });
  });
});
