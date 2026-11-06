/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * What the engineering MCP sees of a Sidekick, against real objects.
 *
 * A Sidekick and a work stream share one parent-id namespace in
 * `workstream_authority_routes`, so an active route cannot tell them apart.
 * The listing reads the workspace's `automation_directory`, and a run
 * conversation is reached only through the Sidekick's own registry. These
 * tests drive both through the real creation path, `createAutomation`, rather
 * than writing the tables.
 */

import { env } from "cloudflare:workers";
import { createExecutionContext, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asAutomationId, asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId, type AutomationDraft } from "@rally/contracts";

import { AUTOMATION_SCHEDULE_ALARM_KIND } from "../src/durable-objects/automation-do-protocol";
import { workspaceDOName } from "../src/durable-objects/names";
import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import type { Env } from "../src/env";
import { createAutomation } from "../src/services/automation-service";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { hostedParentStub } from "./helpers/hosted-parent";
import { seedInspectableWorkspace } from "./helpers/engineering-inspection-fixture";
import { ensureAuditSchema } from "./helpers/audit-fixture";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ef10");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-00000000ef11");
const ROOM_ID = asWorkstreamId("00000000-0000-7000-8000-00000000ef12");
const SIDEKICK_ID = asAutomationId("00000000-0000-7000-8000-00000000ef13");
const SESSION_ID = "00000000-0000-7000-8000-00000000ef14";
const NOW = "2026-09-17T10:00:00.000Z";
const BYSTANDER_ID = asUserId("00000000-0000-7000-8000-00000000ef18");
const OPERATOR = { subject: "access-engineer", email: "engineer@example.com", audience: "engineering-mcp" };
const HOURLY: AutomationDraft = {
  name: "Hourly digest", description: "Summarizes the hour", overview: "Runs every hour",
  instructions: "Say what happened in one sentence.",
  triggers: [{ type: "interval", intervalSeconds: 3_600, summary: "Every hour" }],
  requiredCapabilities: [], expectedOutputs: [], defaultBehavior: {}, recommendedPlugins: [],
  memoryTables: [], customTools: [], suggestedScope: "personal", followUpQuestion: null, elicitation: null, ready: true,
};
const TEST_ENV: Env = env;

useHeldEffectQueue();

function bridge(): EngineeringInspectionBridge {
  return new EngineeringInspectionBridge(createExecutionContext(), TEST_ENV);
}

async function seedRegionalDatabase(): Promise<void> {
  await seedInspectableWorkspace(env.DB, {
    workspaceId: WORKSPACE_ID,
    userId: AUTHOR_ID,
    sessionId: SESSION_ID,
    at: NOW,
  });
}

/**
 * A work stream that owns an active route and no directory row: the id shape
 * the Sidekick tools must refuse.
 */
async function seedRoom(): Promise<void> {
  await hostedParentStub(env, WORKSPACE_ID).reserveChild({
    workspaceId: WORKSPACE_ID,
    parentId: ROOM_ID,
    substreamId: asSubstreamId("0"),
    kind: "main",
    createdByUserId: AUTHOR_ID,
    authorityGeneration: 1,
    directory: {
      title: "Release room",
      description: "",
      scope: "personal",
      systemKind: null,
      emailAddress: null,
      titleStatus: "settled",
      createdAt: NOW,
    },
  });
  await env.DB.prepare(`INSERT INTO workstream_authority_routes
    (workspace_id, workstream_id, generation, object_name, state, source_fence_sequence, updated_at)
    VALUES (?, ?, 1, ?, 'active', 0, ?)`)
    .bind(WORKSPACE_ID, ROOM_ID, `global:${WORKSPACE_ID}:${ROOM_ID}`, NOW).run();
}

/** `create`, then the one effect leg that lands the workspace directory row. */
async function createSidekick(): Promise<void> {
  const created = await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID,
    authorUserId: AUTHOR_ID,
    scope: "personal",
    owningWorkstreamId: null,
    automationId: SIDEKICK_ID,
  });
  // Its directory row is written in the Organization object by the create
  // itself; there is no copy to deliver.
  expect(created.created).toBe(true);
}

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

/** Published through the same submit and apply the drafting conversation uses. */
async function activeHourlySidekick(): Promise<void> {
  await createSidekick();
  await workspace().sidekickSubmitDefinition({
    workspaceId: WORKSPACE_ID, automationId: SIDEKICK_ID, draft: HOURLY, evaluatorRules: null, submittedByRunId: null,
  });
  await runInDurableObject(workspace(), (instance) => instance.sidekickApply({
    workspaceId: WORKSPACE_ID, automationId: SIDEKICK_ID,
    actor: { userId: AUTHOR_ID, actorRole: "member", participantOfOwningWorkstream: false },
  }));
}

async function sidekickState(): Promise<{ lifecycle: string; paused_by: string | null; schedule_alarms: number }> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
    lifecycle: string; paused_by: string | null; schedule_alarms: number;
  }>(
    `SELECT lifecycle, paused_by,
            (SELECT COUNT(*) FROM _internal_durable_alarms WHERE kind = ?) AS schedule_alarms
       FROM automation_directory WHERE automation_id = ?`,
    AUTOMATION_SCHEDULE_ALARM_KIND, SIDEKICK_ID,
  ).one());
}

beforeEach(async () => {
  await reset();
  await seedRegionalDatabase();
  await env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)))
    .initializeWorkspace(WORKSPACE_ID, "wnam");
  await seedRoom();
  await ensureAuditSchema();
  await env.AUDIT_DB.prepare("DELETE FROM audit_events WHERE workspace_id = ?").bind(WORKSPACE_ID).run();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', ?)`).bind(WORKSPACE_ID, BYSTANDER_ID, NOW),
    // Publishing reserves the Sidekick's email address.
    env.DB.prepare(`CREATE TABLE workstream_email_routes (
      email_address TEXT PRIMARY KEY COLLATE NOCASE, address_source TEXT NOT NULL,
      region TEXT NOT NULL, workspace_id TEXT NOT NULL, workstream_id TEXT,
      automation_subscription_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (region, workspace_id, workstream_id)
    )`),
  ]);
});

describe("engineering inspection of a Sidekick", () => {
  it("lists a Sidekick from its directory row", async () => {
    await createSidekick();
    const inspection = bridge();

    const listed = await inspection.listSidekicks({ workspaceId: WORKSPACE_ID });
    expect(listed).toMatchObject({
      found: true,
      value: {
        region: "global",
        workspaceId: WORKSPACE_ID,
        items: [{ sidekickId: SIDEKICK_ID, lifecycle: "draft", scope: "personal", owningWorkstreamId: null }],
      },
    });
  });

  it("reaches a Sidekick's run conversation through its own registry, and nothing it has not registered", async () => {
    await createSidekick();
    const runId = asSubstreamId("00000000-0000-7000-8000-00000000ef16");
    // Registered where the Sidekick's parent lives: its Organization object.
    await env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID))).reserveChild({
      workspaceId: WORKSPACE_ID, parentId: SIDEKICK_ID, substreamId: runId, kind: "child",
      createdByUserId: AUTHOR_ID, authorityGeneration: 1,
    });
    const inspection = bridge();
    const query = { sql: "SELECT 1 AS one", bindings: [] };

    expect(await inspection.runSubstreamSql({
      workspaceId: WORKSPACE_ID, workstreamId: SIDEKICK_ID, substreamId: runId, authorityGeneration: 1, query,
    })).toMatchObject({ found: true, value: { workstreamId: SIDEKICK_ID, substreamId: runId, result: { rows: [{ one: 1 }] } } });
    expect(await inspection.runSubstreamSql({
      workspaceId: WORKSPACE_ID, workstreamId: SIDEKICK_ID, substreamId: "00000000-0000-7000-8000-00000000ef17", authorityGeneration: 1, query,
    })).toEqual({ found: false });
    // A room's unregistered conversation is not looked up as a Sidekick's.
    expect(await inspection.runSubstreamSql({
      workspaceId: WORKSPACE_ID, workstreamId: ROOM_ID, substreamId: runId, authorityGeneration: 1, query,
    })).toEqual({ found: false });
  });

  it("pauses and resumes a Sidekick as a user who manages it, through the app's own path", async () => {
    await activeHourlySidekick();
    expect(await sidekickState()).toEqual({ lifecycle: "active", paused_by: null, schedule_alarms: 1 });

    expect(await bridge().setSidekickPaused({ orgId: WORKSPACE_ID, userId: AUTHOR_ID, sidekickId: SIDEKICK_ID, paused: true }, OPERATOR))
      .toEqual({ region: "global", orgId: WORKSPACE_ID, sidekickId: SIDEKICK_ID, lifecycle: "paused" });
    expect(await sidekickState()).toEqual({ lifecycle: "paused", paused_by: "person", schedule_alarms: 0 });

    expect(await bridge().setSidekickPaused({ orgId: WORKSPACE_ID, userId: AUTHOR_ID, sidekickId: SIDEKICK_ID, paused: false }, OPERATOR))
      .toEqual({ region: "global", orgId: WORKSPACE_ID, sidekickId: SIDEKICK_ID, lifecycle: "active" });
    expect(await sidekickState()).toEqual({ lifecycle: "active", paused_by: null, schedule_alarms: 1 });

    const audits = (await env.AUDIT_DB.prepare(
      "SELECT action, target_id, metadata_json FROM audit_events WHERE workspace_id = ? ORDER BY created_at, action",
    ).bind(WORKSPACE_ID).all<{ action: string; target_id: string; metadata_json: string }>()).results;
    expect(audits.map(({ action, target_id }) => ({ action, target_id }))).toEqual([
      { action: "engineering.pause_sidekick.attempt", target_id: AUTHOR_ID },
      { action: "engineering.pause_sidekick.result", target_id: AUTHOR_ID },
      { action: "engineering.resume_sidekick.attempt", target_id: AUTHOR_ID },
      { action: "engineering.resume_sidekick.result", target_id: AUTHOR_ID },
    ]);
    expect(JSON.parse(audits[1]!.metadata_json)).toMatchObject({
      operator: OPERATOR, sidekickId: SIDEKICK_ID, outcome: "admitted", lifecycle: "paused",
    });
  });

  it("refuses a pause by a member who cannot manage the Sidekick, and leaves it running", async () => {
    await activeHourlySidekick();

    await expect(bridge().setSidekickPaused({ orgId: WORKSPACE_ID, userId: BYSTANDER_ID, sidekickId: SIDEKICK_ID, paused: true }, OPERATOR))
      .rejects.toThrow("engineering_operation_failed:sidekick_forbidden");
    expect(await sidekickState()).toEqual({ lifecycle: "active", paused_by: null, schedule_alarms: 1 });
  });
});
