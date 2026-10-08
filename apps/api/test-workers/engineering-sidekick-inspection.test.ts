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
import { createExecutionContext, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asAutomationId, asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import type { Env } from "../src/env";
import { createAutomation } from "../src/services/automation-service";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { hostedParentStub } from "./helpers/hosted-parent";
import { seedInspectableWorkspace } from "./helpers/engineering-inspection-fixture";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ef10");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-00000000ef11");
const ROOM_ID = asWorkstreamId("00000000-0000-7000-8000-00000000ef12");
const SIDEKICK_ID = asAutomationId("00000000-0000-7000-8000-00000000ef13");
const SESSION_ID = "00000000-0000-7000-8000-00000000ef14";
const NOW = "2026-09-17T10:00:00.000Z";
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

beforeEach(async () => {
  await reset();
  await seedRegionalDatabase();
  await env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)))
    .initializeWorkspace(WORKSPACE_ID, "wnam");
  await seedRoom();
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
});
