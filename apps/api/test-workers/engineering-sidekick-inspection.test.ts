/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Which SidekickDO the engineering MCP is allowed to open, against real objects.
 *
 * The fence is the interesting part. A Sidekick and a work stream share one
 * parent-id namespace in `workstream_authority_routes`, so an active route
 * cannot tell them apart, and naming a SidekickDO for a work stream's id would
 * create an object that never existed. The workspace's `automation_directory`
 * is what separates them, and these tests drive it through the real creation
 * path — `createAutomation` plus the effect leg that lands the row — rather
 * than writing the table, so a projection that stopped applying cannot pass.
 */

import { env } from "cloudflare:workers";
import { createExecutionContext, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asAutomationId, asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { automationDOName, workspaceDOName, workstreamDOName } from "../src/durable-objects/names";
import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import type { Env } from "../src/env";
import { createAutomation } from "../src/services/automation-service";
import { deliverParentEffects } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
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

function sidekickStub(sidekickId: string) {
  return env.AUTOMATION_DOS.get(env.AUTOMATION_DOS.idFromName(
    automationDOName("global", WORKSPACE_ID, asAutomationId(sidekickId)),
  ));
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
  const room = env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(workstreamDOName("global", WORKSPACE_ID, ROOM_ID)));
  await room.reserveChild({
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
  expect(created.created).toBe(true);
  const delivered = await deliverParentEffects(TEST_ENV, sidekickStub(SIDEKICK_ID));
  expect(delivered.map((envelope) => envelope.effect.kind)).toEqual(["directory_automation"]);
}

beforeEach(async () => {
  await reset();
  await seedRegionalDatabase();
  await env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)))
    .initializeWorkspace(WORKSPACE_ID, "wnam");
  await seedRoom();
});

describe("engineering inspection of a Sidekick's own object", () => {
  it("lists a Sidekick and runs SQL against the SidekickDO its directory row names", async () => {
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

    const target = await inspection.resolveSidekick({ workspaceId: WORKSPACE_ID, sidekickId: SIDEKICK_ID });
    expect(target).toMatchObject({ found: true, value: { authorityGeneration: 1 } });
    if (!target.found) throw new Error("Expected the Sidekick to resolve");

    // `automation` holds the object's own single identity row, so reading it
    // back proves the named object is the Sidekick that was created and not a
    // freshly migrated empty one.
    const executed = await inspection.runSidekickSql({
      workspaceId: WORKSPACE_ID,
      sidekickId: SIDEKICK_ID,
      authorityGeneration: target.value.authorityGeneration,
      query: { sql: "SELECT automation_id, lifecycle FROM automation WHERE id = 1", bindings: [] },
    });
    expect(executed).toMatchObject({
      found: true,
      value: {
        workspaceId: WORKSPACE_ID,
        workstreamId: null,
        substreamId: null,
        sidekickId: SIDEKICK_ID,
        result: { rows: [{ automation_id: SIDEKICK_ID, lifecycle: "draft" }] },
      },
    });
  });

  it("refuses a work stream that holds an active route but no directory row", async () => {
    await createSidekick();
    const inspection = bridge();
    const roomAsSidekick = asAutomationId(ROOM_ID);

    expect(await inspection.resolveSidekick({ workspaceId: WORKSPACE_ID, sidekickId: roomAsSidekick }))
      .toEqual({ found: false });
    expect(await inspection.runSidekickSql({
      workspaceId: WORKSPACE_ID,
      sidekickId: roomAsSidekick,
      authorityGeneration: 1,
      query: { sql: "CREATE TABLE inspection_should_never_run (id INTEGER)", bindings: [] },
    })).toEqual({ found: false });

    // Nothing ran against the object that name would have addressed. Opening it
    // here migrates it, so its emptiness proves nothing on its own — the
    // statement's own table is what a routed call would have left behind.
    const tables = await sidekickStub(ROOM_ID).runInspectionSql({
      sql: "SELECT name FROM sqlite_schema WHERE name = 'inspection_should_never_run'",
      bindings: [],
    });
    expect(tables.rows).toEqual([]);
  });

  it("refuses a stale caller generation and a Sidekick read from another workspace", async () => {
    await createSidekick();
    const inspection = bridge();

    expect(await inspection.runSidekickSql({
      workspaceId: WORKSPACE_ID,
      sidekickId: SIDEKICK_ID,
      authorityGeneration: 2,
      query: { sql: "SELECT 1 AS answer", bindings: [] },
    })).toEqual({ found: false });

    await env.DB.prepare(`UPDATE workspace_product_authority_routes SET state = 'quarantined' WHERE workspace_id = ?`)
      .bind(WORKSPACE_ID).run();
    expect(await inspection.resolveSidekick({ workspaceId: WORKSPACE_ID, sidekickId: SIDEKICK_ID }))
      .toEqual({ found: false });
  });
});
