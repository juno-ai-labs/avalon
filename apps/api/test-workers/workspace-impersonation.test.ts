/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { WorkspaceImpersonationStorage } from "../src/durable-objects/workspace-impersonation-storage";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";

const workspaceId = "00000000-0000-7000-8000-00000000a001";
const alice = "00000000-0000-7000-8000-00000000a002";
const bob = "00000000-0000-7000-8000-00000000a003";

beforeEach(async () => { await reset(); });

describe("workspace impersonation authority", () => {
  it("keeps direction and self-pairs exact, makes setup idempotent, and revokes by authority basis", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("workspace-impersonation");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: "workspace_do",
        workerVersionId: "impersonation-test",
        now: 1,
      });
      state.storage.sql.exec(
        `INSERT INTO workspace_identity
           (id, workspace_id, region, placement_affinity, created_at, updated_at)
         VALUES (1, ?, 'global', 'wnam', 1, 1)`,
        workspaceId,
      );
      const store = new WorkspaceImpersonationStorage(state.storage);
      const relationships = [
        { impersonatorUserId: alice, representedUserId: alice, authorityBasis: "demo:operation" },
        { impersonatorUserId: alice, representedUserId: bob, authorityBasis: "demo:operation" },
      ];

      store.upsert({ workspaceId, relationships, now: "2026-09-21T00:00:00.000Z" });
      store.upsert({ workspaceId, relationships, now: "2026-09-21T00:01:00.000Z" });

      expect(store.list(workspaceId, alice)).toHaveLength(2);
      expect(store.authorize(workspaceId, alice, alice)).toMatchObject({ representedUserId: alice });
      expect(store.authorize(workspaceId, alice, bob)).toMatchObject({ representedUserId: bob });
      expect(store.authorize(workspaceId, bob, alice)).toBeNull();
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS count FROM workspace_impersonation_relationships",
      ).one().count).toBe(2);

      expect(store.revoke({
        workspaceId,
        authorityBasis: "demo:operation",
        now: "2026-09-21T00:02:00.000Z",
      })).toEqual({ revoked: 2 });
      expect(store.list(workspaceId, alice)).toEqual([]);
    });
  });
});
