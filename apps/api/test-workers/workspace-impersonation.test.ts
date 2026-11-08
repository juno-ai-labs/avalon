/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import { WorkspaceImpersonationStorage } from "../src/durable-objects/workspace-impersonation-storage";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000a001");
const alice = "00000000-0000-7000-8000-00000000a002";
const bob = "00000000-0000-7000-8000-00000000a003";

beforeEach(async () => { await reset(); });

describe("workspace impersonation authority", () => {
  it("keeps direction, self-pairs, and producer grants exact through the public RPC boundary", async () => {
    const stub = env.WORKSPACE_DOS.getByName(workspaceDOName("global", workspaceId));
    await stub.initializeWorkspace(workspaceId, "wnam");
    const relationships = [
      { impersonatorUserId: alice, representedUserId: alice, authorityBasis: "operator:grant" },
      { impersonatorUserId: alice, representedUserId: bob, authorityBasis: "operator:grant" },
    ];

    await stub.upsertImpersonationRelationships({ workspaceId, relationships });
    await stub.upsertImpersonationRelationships({ workspaceId, relationships });
    await stub.upsertImpersonationRelationships({
      workspaceId,
      relationships: [{ impersonatorUserId: alice, representedUserId: bob, authorityBasis: "support:approved" }],
    });

    expect((await stub.listImpersonationRelationships({ workspaceId, impersonatorUserId: alice })).relationships)
      .toHaveLength(2);
    expect((await stub.authorizeImpersonation({
      workspaceId, impersonatorUserId: alice, representedUserId: alice,
    })).relationship).toMatchObject({ representedUserId: alice });
    expect((await stub.authorizeImpersonation({
      workspaceId, impersonatorUserId: alice, representedUserId: bob,
    })).relationship).toMatchObject({ representedUserId: bob });
    expect((await stub.authorizeImpersonation({
      workspaceId, impersonatorUserId: bob, representedUserId: alice,
    })).relationship).toBeNull();
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM workspace_impersonation_relationships",
      ).one().count).toBe(3);
      expect(() => new WorkspaceImpersonationStorage(state.storage).revoke({
        workspaceId,
        now: "2026-09-21T00:02:00.000Z",
      })).toThrow("impersonation_revocation_filter_required");
    });

    expect(await stub.revokeImpersonationRelationships({
      workspaceId,
      authorityBasis: "operator:grant",
    })).toEqual({ revoked: 2 });
    expect((await stub.listImpersonationRelationships({ workspaceId, impersonatorUserId: alice })).relationships)
      .toEqual([expect.objectContaining({ representedUserId: bob, authorityBasis: "support:approved" })]);
    await stub.beginWorkspaceRetirement({
      retiredAt: Date.parse("2026-09-21T00:03:00.000Z"),
      operationId: "retirement",
      actorUserId: null,
      reason: "test",
      impersonationRevocation: { workspaceId, authorityBasis: "support:approved" },
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec<{ revoked_at: string | null }>(
        "SELECT revoked_at FROM workspace_impersonation_relationships WHERE authority_basis = 'support:approved'",
      ).one().revoked_at).not.toBeNull();
    });
  });
});
