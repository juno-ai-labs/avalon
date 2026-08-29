/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The Terminal network policy's revision fence, against the object that holds it.
 *
 * Applying a policy is a claim: the preview must still match the revision it
 * was taken against, and taking the policy row and taking the preview row has
 * to be one decision. As statements through the workspace runtime facade it was
 * four round trips, and the service carried a `restoreCurrentPolicy`
 * compensation for the window where the first claim landed and the second did
 * not — a window a transaction does not have.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import {
  WorkspaceTerminalNetworkModeSchema,
  WorkspaceTerminalNetworkSettingsSchema,
  WorkspaceTerminalPolicyClaimResultSchema,
} from "../src/durable-objects/workspace-terminal-network-protocol";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ab0");
const ADMIN = asUserId("00000000-0000-7000-8000-000000000ab1");
const OTHER_ADMIN = asUserId("00000000-0000-7000-8000-000000000ab2");
const MUTATION = "00000000-0000-7000-8000-000000000ac0";
const AT = "2026-08-29T00:00:00.000Z";

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

async function settings() {
  return WorkspaceTerminalNetworkSettingsSchema.parse(await workspace().terminalNetworkSettings({
    workspaceId: WORKSPACE_ID,
    baselineManifestVersion: "manifest-1",
    defaultEffectiveDomains: ["registry.npmjs.org"],
    at: AT,
  }));
}

async function preview(input: {
  mutationId?: string;
  expectedRevision?: number;
  requestedByUserId?: string;
} = {}) {
  await workspace().recordTerminalPolicyPreview({
    workspaceId: WORKSPACE_ID,
    mutationId: input.mutationId ?? MUTATION,
    requestedByUserId: input.requestedByUserId ?? ADMIN,
    expectedRevision: input.expectedRevision ?? 1,
    proposedMode: "full_internet",
    proposedDomains: [],
    effectiveDomains: [],
    affectedWorkstreamIds: [],
    at: AT,
  });
}

async function claim(input: {
  mutationId?: string;
  expectedRevision?: number;
  requestedByUserId?: string;
} = {}) {
  return WorkspaceTerminalPolicyClaimResultSchema.parse(
    await workspace().claimTerminalPolicyApplication({
      workspaceId: WORKSPACE_ID,
      mutationId: input.mutationId ?? MUTATION,
      requestedByUserId: input.requestedByUserId ?? ADMIN,
      expectedRevision: input.expectedRevision ?? 1,
      at: AT,
    }),
  );
}

beforeEach(async () => {
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM workspace_sandbox_network_policy_mutations`);
    state.storage.sql.exec(`DELETE FROM workspace_sandbox_network_domains`);
    state.storage.sql.exec(`DELETE FROM workspace_sandbox_network_policies`);
  });
}, 30_000);

describe("Terminal network policy", () => {
  it("creates the workspace's default policy on the first read, once", async () => {
    const first = await settings();
    expect(first.policy).toMatchObject({
      mode: "trusted_only",
      revision: 1,
      verificationState: "verified",
      failureCode: null,
    });
    expect(first.customDomains).toEqual([]);
    // A second read must not start a second revision.
    expect((await settings()).policy.revision).toBe(1);
  });

  it("answers the mode without creating anything, for the agent path", async () => {
    expect(WorkspaceTerminalNetworkModeSchema.parse(
      await workspace().terminalNetworkMode({ workspaceId: WORKSPACE_ID }),
    )).toEqual({ mode: null });
    await settings();
    expect(WorkspaceTerminalNetworkModeSchema.parse(
      await workspace().terminalNetworkMode({ workspaceId: WORKSPACE_ID }),
    )).toEqual({ mode: "trusted_only" });
  });

  it("claims the policy and its preview together", async () => {
    await settings();
    await preview();
    const claimed = await claim();
    expect(claimed.outcome).toBe("claimed");
    expect(claimed.mutation?.proposedMode).toBe("full_internet");
    expect((await settings()).policy.verificationState).toBe("pending");
  });

  it("refuses a second claim of the same preview", async () => {
    // Two administrators confirming the same preview must not both start an
    // application: the second finds the preview no longer in `preview` state.
    await settings();
    await preview();
    expect((await claim()).outcome).toBe("claimed");
    expect((await claim()).outcome).toBe("preview_stale");
  });

  it("refuses a preview whose revision the policy has moved past, and burns it", async () => {
    // The preview and the request agree on revision 2; the policy is still at
    // 1, so the change was taken against a revision this workspace never had.
    // The preview is marked `conflict` so a later confirm cannot pick it up.
    await settings();
    await preview({ expectedRevision: 2 });
    expect((await claim({ expectedRevision: 2 })).outcome).toBe("revision_conflict");
    expect((await claim({ expectedRevision: 2 })).outcome).toBe("preview_stale");
    expect((await settings()).policy.verificationState).toBe("verified");
  });

  it("refuses somebody else's preview", async () => {
    await settings();
    await preview();
    expect((await claim({ requestedByUserId: OTHER_ADMIN })).outcome).toBe("preview_stale");
  });

  it("leaves the policy verified when a claim is refused", async () => {
    // The point of one transaction: a refusal writes nothing, so there is no
    // half-claimed policy for a compensating write to repair.
    await settings();
    await preview({ mutationId: "00000000-0000-7000-8000-000000000ac1" });
    expect((await claim({ mutationId: "00000000-0000-7000-8000-000000000ac9" })).outcome)
      .toBe("preview_stale");
    expect((await settings()).policy.verificationState).toBe("verified");
  });

  it("publishes the applied policy, its revision, and its domains together", async () => {
    await settings();
    await preview();
    const claimed = await claim();
    await workspace().commitTerminalPolicyApplication({
      workspaceId: WORKSPACE_ID,
      mutationId: MUTATION,
      createdByUserId: ADMIN,
      mode: "full_internet",
      claimedRevision: claimed.current!.revision,
      resultingRevision: claimed.current!.revision + 1,
      customDomains: ["docs.example.com", "api.example.com"],
      effectiveDomains: ["docs.example.com"],
      at: AT,
    });
    const after = await settings();
    expect(after.policy).toMatchObject({
      mode: "full_internet",
      revision: 2,
      verificationState: "verified",
      failureCode: null,
      effectiveDomains: ["docs.example.com"],
    });
    // Sorted by the object, so the caller's order is not the stored order.
    expect(after.customDomains).toEqual(["api.example.com", "docs.example.com"]);
  });

  it("replaces the domain list rather than appending to it", async () => {
    await settings();
    await preview();
    const claimed = await claim();
    const commit = (customDomains: string[], resultingRevision: number, claimedRevision: number) =>
      workspace().commitTerminalPolicyApplication({
        workspaceId: WORKSPACE_ID,
        mutationId: MUTATION,
        createdByUserId: ADMIN,
        mode: "trusted_only",
        claimedRevision,
        resultingRevision,
        customDomains,
        effectiveDomains: customDomains,
        at: AT,
      });
    await commit(["one.example.com"], claimed.current!.revision + 1, claimed.current!.revision);
    expect((await settings()).customDomains).toEqual(["one.example.com"]);
    await commit(["two.example.com"], 3, 2);
    expect((await settings()).customDomains).toEqual(["two.example.com"]);
  });

  it("gives a failed application back as verified, with its reason", async () => {
    await settings();
    await preview();
    const claimed = await claim();
    await workspace().failTerminalPolicyApplication({
      workspaceId: WORKSPACE_ID,
      mutationId: MUTATION,
      revision: claimed.current!.revision,
      failureCode: "provider_policy_mismatch",
      at: AT,
    });
    expect((await settings()).policy).toMatchObject({
      mode: "trusted_only",
      revision: 1,
      verificationState: "verified",
      failureCode: "provider_policy_mismatch",
    });
  });

  it("refuses a request addressed to a different workspace", async () => {
    // Settled once, by hand: an RPC promise is a pipelining thenable, and
    // `rejects.toThrow` reads through it a second time, which surfaces the same
    // rejection again as an unhandled error and fails the run.
    const outcome = await workspace().terminalNetworkMode({
      workspaceId: asWorkspaceId("00000000-0000-7000-8000-000000000abe"),
    }).then(() => null, (error: unknown) => error);
    expect(String(outcome)).toContain("workspace_object_identity_mismatch");
  });
});
