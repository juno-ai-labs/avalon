/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { createExecutionContext, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import { EngineeringInspectionBridge } from "../src/engineering-inspection-bridge";
import type { Env } from "../src/env";
import { seedInspectableWorkspace } from "./helpers/engineering-inspection-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ef01");
const USER_ID = asUserId("00000000-0000-7000-8000-00000000ef02");
const SESSION_ID = "00000000-0000-7000-8000-00000000ef03";
const NOW = "2026-09-20T10:00:00.000Z";
const TEST_ENV: Env = env;

beforeEach(async () => {
  await reset();
  await seedInspectableWorkspace(env.DB, {
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    sessionId: SESSION_ID,
    at: NOW,
  });
  await env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)))
    .initializeWorkspace(WORKSPACE_ID, "wnam");
});

describe("engineering inspection of a workspace", () => {
  it("lists, resolves, and executes from regional identity alone", async () => {
    const inspection = new EngineeringInspectionBridge(createExecutionContext(), TEST_ENV);

    await expect(inspection.listWorkspaces({})).resolves.toMatchObject({
      region: "global",
      items: [{ workspaceId: WORKSPACE_ID, authorityState: "active" }],
    });

    const target = await inspection.resolveWorkspace({ workspaceId: WORKSPACE_ID });
    expect(target).toEqual({
      found: true,
      value: {
        region: "global",
        workspaceId: WORKSPACE_ID,
        authorityGeneration: 1,
      },
    });
    if (!target.found) throw new Error("Expected the workspace to resolve");

    await expect(inspection.runWorkspaceSql({
      workspaceId: WORKSPACE_ID,
      authorityGeneration: target.value.authorityGeneration,
      query: {
        sql: "SELECT workspace_id, placement_affinity FROM workspace_identity WHERE id = 1",
        bindings: [],
      },
    })).resolves.toMatchObject({
      found: true,
      value: {
        workspaceId: WORKSPACE_ID,
        result: {
          rows: [{ workspace_id: WORKSPACE_ID, placement_affinity: "wnam" }],
        },
      },
    });
  });

  it("retries a pending parent import through the bridge and answers with the ledger row", async () => {
    const inspection = new EngineeringInspectionBridge(createExecutionContext(), TEST_ENV);
    const parentId = "00000000-0000-7000-8000-00000000ef04";
    const target = await inspection.resolveWorkspace({ workspaceId: WORKSPACE_ID });
    if (!target.found) throw new Error("Expected the workspace to resolve");
    await inspection.runWorkspaceSql({
      workspaceId: WORKSPACE_ID,
      authorityGeneration: target.value.authorityGeneration,
      query: {
        sql: "INSERT INTO parent_imports (parent_id, parent_kind, state, attempts, not_before) VALUES (?, 'workstream', 'pending', 3, ?)",
        // Backed off far into the future: the retry does not wait for it.
        bindings: [parentId, Date.now() + 86_400_000],
      },
    });

    // No legacy object ever held this id, so the import closes it empty.
    await expect(inspection.retryParentImport({
      workspaceId: WORKSPACE_ID,
      authorityGeneration: target.value.authorityGeneration,
      parentId,
    })).resolves.toEqual({
      found: true,
      value: {
        region: "global", workspaceId: WORKSPACE_ID, parentId, state: "imported", attempts: 3, lastErrorCode: null,
      },
    });
    await expect(inspection.retryParentImport({
      workspaceId: WORKSPACE_ID,
      authorityGeneration: target.value.authorityGeneration + 1,
      parentId,
    })).resolves.toEqual({ found: false });
  });
});
