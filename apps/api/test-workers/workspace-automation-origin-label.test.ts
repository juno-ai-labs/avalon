/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The title a generated work stream shows as its origin label.
 *
 * WorkstreamDO renders the summary and does not hold the automation's
 * directory row, so it asks WorkspaceDO. It used to ask as SQL through the
 * workspace runtime facade, which routes by table name and sends an
 * unrecognised one to the regional database: `automation_directory` was absent
 * from that allowlist, so every attempt to open an automation's run work
 * stream answered `no such table: automation_directory` from D1. The read is
 * now a typed method on the object that owns the table, and this is where what
 * that method decides is asserted — a Node suite reaches the object through a
 * stub, which can answer anything.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import { WorkspaceAutomationOriginLabelSchema } from "../src/durable-objects/workspace-directory-protocol";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000cb0");
const AUTHOR = asUserId("00000000-0000-7000-8000-000000000cb1");
const AUTOMATION_ID = "00000000-0000-7000-8000-0000000009c0";
const OTHER_AUTOMATION_ID = "00000000-0000-7000-8000-0000000009c1";

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

/**
 * Project one automation the way its AutomationAgent would.
 *
 * Through the projection rather than by writing `automation_directory`: a
 * projection that stopped applying would otherwise leave these passing.
 */
async function projectAutomation(input: {
  automationId?: string;
  lifecycle: "active" | "deleted";
  title: string;
  projectionVersion: number;
}): Promise<void> {
  await expect(workspace().applyAutomationProjection({
    schemaVersion: 1,
    automationId: input.automationId ?? AUTOMATION_ID,
    workspaceId: WORKSPACE_ID,
    authorUserId: AUTHOR,
    authorityGeneration: 1,
    projectionVersion: input.projectionVersion,
    payloadHash: `hash-${input.automationId ?? AUTOMATION_ID}-${input.projectionVersion}`,
    lifecycle: input.lifecycle,
    scope: "workspace",
    title: input.title,
    description: "",
    nextRunAt: null,
    attentionCode: null,
  })).resolves.toEqual({ applied: true });
}

async function originLabel(automationId: string): Promise<string | null> {
  return WorkspaceAutomationOriginLabelSchema.parse(
    await workspace().automationOriginLabel({ workspaceId: WORKSPACE_ID, automationId }),
  ).title;
}

beforeEach(async () => {
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  // The directory outlives a test, so each one starts from a known empty state
  // rather than from whatever the previous test projected.
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM automation_directory`);
  });
}, 30_000);

describe("automationOriginLabel", () => {
  it("answers the automation's current title", async () => {
    await projectAutomation({ lifecycle: "active", title: "Weekly revenue digest", projectionVersion: 1 });
    expect(await originLabel(AUTOMATION_ID)).toBe("Weekly revenue digest");
  });

  it("follows a rename rather than holding the title the run was created under", async () => {
    await projectAutomation({ lifecycle: "active", title: "Weekly digest", projectionVersion: 1 });
    await projectAutomation({ lifecycle: "active", title: "Weekly revenue digest", projectionVersion: 2 });
    expect(await originLabel(AUTOMATION_ID)).toBe("Weekly revenue digest");
  });

  it("goes quiet rather than naming a deleted automation", async () => {
    // The work stream outlives the automation that made it, so the label stops
    // naming something the workspace no longer has.
    await projectAutomation({ lifecycle: "active", title: "Retired sweep", projectionVersion: 1 });
    await projectAutomation({ lifecycle: "deleted", title: "Retired sweep", projectionVersion: 2 });
    expect(await originLabel(AUTOMATION_ID)).toBeNull();
  });

  it("answers null for an automation this workspace has never projected", async () => {
    await projectAutomation({ lifecycle: "active", title: "Weekly revenue digest", projectionVersion: 1 });
    expect(await originLabel(OTHER_AUTOMATION_ID)).toBeNull();
  });

  it("refuses a request addressed to a different workspace", async () => {
    // The object is reached by name, so a caller that computed the wrong name
    // would otherwise read one workspace's automations believing they were
    // another's.
    //
    // Settled once, by hand: an RPC promise is a pipelining thenable, and
    // `rejects.toThrow` reads through it a second time, which surfaces the same
    // rejection again as an unhandled error and fails the run.
    const outcome = await workspace().automationOriginLabel({
      workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000cb9"),
      automationId: AUTOMATION_ID,
    }).then(() => null, (error: unknown) => error);
    expect(String(outcome)).toContain("workspace_object_identity_mismatch");
  });
});
