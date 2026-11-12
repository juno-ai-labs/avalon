import * as usageMetering from "../src/services/usage-metering";
/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { createExecutionContext, reset, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import { seedInspectableWorkspace } from "./helpers/engineering-inspection-fixture";
import usageMigration from "../../../packages/db/usage-migrations/0001_usage_ledger.sql?raw";

const ORG = "00000000-0000-7000-8000-00000000fca1";
const USER = "00000000-0000-7000-8000-00000000fca2";
const OPERATOR = { subject: "engineer", email: "engineer@example.test", audience: "engineering-mcp" };

beforeEach(async () => {
  await reset();
  await seedInspectableWorkspace(env.DB, { workspaceId: ORG, userId: USER, sessionId: "usage-operator", at: "2026-11-01T00:00:00Z" });
  await env.DB.batch([
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN plan TEXT NOT NULL DEFAULT 'starter'"),
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN created_at TEXT NOT NULL DEFAULT '2026-11-01T00:00:00Z'"),
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN updated_at TEXT"),
    env.DB.prepare("ALTER TABLE workspaces ADD COLUMN billing_plan_override INTEGER NOT NULL DEFAULT 0"),
  ]);
  await env.USAGE_DB.exec(usageMigration.replace(/--[^\n]*\n/g, "").replace(/\s*\n\s*/g, " "));
});

it("reads the current plan and records an audited plan change in both authorities", async () => {
  const context = createExecutionContext();
  const bridge = new EngineeringInspectionBridge(context, env);
  expect(await bridge.inspectOrganizationUsage({ orgId: ORG })).toMatchObject({ region: "global", usage: { plan: "starter", quotaRemainingPercent: 100 } });
  expect(await bridge.changeOrganizationPlan({ orgId: ORG, plan: "growth" }, OPERATOR)).toMatchObject({ orgId: ORG, usage: { plan: "growth" } });
  await waitOnExecutionContext(context);
  expect(await env.DB.prepare("SELECT plan FROM workspaces WHERE id = ?").bind(ORG).first()).toEqual({ plan: "growth" });
  expect((await env.USAGE_DB.prepare("SELECT plan, previous_plan FROM usage_plan_changes WHERE workspace_id = ?").bind(ORG).all()).results).toEqual([{ plan: "growth", previous_plan: "starter" }]);
  const audit = await env.AUDIT_DB.prepare("SELECT action, metadata_json FROM audit_events WHERE workspace_id = ? AND action LIKE 'engineering.change_usage_plan.%' ORDER BY action").bind(ORG).all<{ action: string; metadata_json: string }>();
  expect(audit.results.map((row) => row.action)).toEqual(["engineering.change_usage_plan.attempt", "engineering.change_usage_plan.result"]);
  expect(JSON.parse(audit.results[1]!.metadata_json)).toMatchObject({ operator: OPERATOR, outcome: "admitted", plan: "growth" });
});

it("refuses an invalid plan and a workspace not owned by this region", async () => {
  const bridge = new EngineeringInspectionBridge(createExecutionContext(), env);
  await expect(bridge.changeOrganizationPlan({ orgId: ORG, plan: "invalid" }, OPERATOR)).rejects.toThrow(/plan/);
  await env.DB.prepare("UPDATE workspaces SET region = 'enterprise' WHERE id = ?").bind(ORG).run();
  await expect(bridge.changeOrganizationPlan({ orgId: ORG, plan: "growth" }, OPERATOR)).rejects.toThrow(/organization_not_found/);
  expect(await env.DB.prepare("SELECT plan FROM workspaces WHERE id = ?").bind(ORG).first()).toEqual({ plan: "starter" });
});


afterEach(() => vi.restoreAllMocks());

it("audits the requested plan even when another operator changes it before the snapshot", async () => {
  const readUsage = usageMetering.readOrganizationUsage;
  let concurrentChange: Promise<boolean> | undefined;
  vi.spyOn(usageMetering, "readOrganizationUsage").mockImplementation(async (...args) => {
    concurrentChange ??= usageMetering.setWorkspacePlan(env, ORG, "starter", Date.now() + 1);
    await concurrentChange;
    return readUsage(...args);
  });
  const context = createExecutionContext();
  const bridge = new EngineeringInspectionBridge(context, env);
  const result = await bridge.changeOrganizationPlan({ orgId: ORG, plan: "growth" }, OPERATOR);
  await waitOnExecutionContext(context);
  expect(result.usage.plan).toBe("starter");
  const row = await env.AUDIT_DB.prepare("SELECT metadata_json FROM audit_events WHERE workspace_id = ? AND action = 'engineering.change_usage_plan.result'").bind(ORG).first<{ metadata_json: string }>();
  expect(JSON.parse(row!.metadata_json)).toMatchObject({ operator: OPERATOR, plan: "growth" });
});
