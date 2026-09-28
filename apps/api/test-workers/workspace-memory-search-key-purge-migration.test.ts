/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * WorkspaceDO migration 83 deletes the search-authorization keys memory search
 * registered once per agent run, and the rows hanging off them, from an object
 * that still holds every other key of the old store. The store is found only
 * through the delegation inside each snapshot's JSON, so this runs a populated
 * object through the real migration runner on workerd, as
 * `durable-object-sqlite.md` asks of a migration that deletes.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";

const PURGE_MIGRATION = 83;
const COMPONENT = "workspace_do";
const WORKSPACE_ID = "00000000-0000-7000-8000-000000000a83";
const USER_ID = "00000000-0000-7000-8000-000000000a84";
const CHANNEL_ID = "channel-1";
const SCOPE_ID = "scope-channel";
/** A scope a memory key names alongside a key under some other delegation. */
const SHARED_SCOPE_ID = "scope-shared";
const RESOURCE_ID = "resource-1";

function memoryDelegation(runId: string): string {
  return `memory-search:v1:${JSON.stringify({ workspaceId: WORKSPACE_ID, parentId: CHANNEL_ID,
    parentKind: "workstream", harnessRunId: runId, executionPrincipal: { type: "user", userId: USER_ID } })}`;
}

interface SeedKey {
  key: string;
  delegation: string | null;
  resource: Record<string, string>;
  resourceId: string | null;
  parentId: string | null;
  dependsOn: string;
}

const KEYS: SeedKey[] = [
  // Two runs' keys on one scope: what hundreds of runs left behind.
  { key: "search-authz:v1:memory-run-1", delegation: memoryDelegation("run-1"), resourceId: SCOPE_ID, parentId: CHANNEL_ID,
    resource: { kind: "memory", workspaceId: WORKSPACE_ID, scopeId: SCOPE_ID, parentId: CHANNEL_ID }, dependsOn: CHANNEL_ID },
  { key: "search-authz:v1:memory-run-2", delegation: memoryDelegation("run-2"), resourceId: SCOPE_ID, parentId: CHANNEL_ID,
    resource: { kind: "memory", workspaceId: WORKSPACE_ID, scopeId: SCOPE_ID, parentId: CHANNEL_ID }, dependsOn: CHANNEL_ID },
  { key: "search-authz:v1:memory-run-3", delegation: memoryDelegation("run-3"), resourceId: SHARED_SCOPE_ID, parentId: CHANNEL_ID,
    resource: { kind: "memory", workspaceId: WORKSPACE_ID, scopeId: SHARED_SCOPE_ID, parentId: CHANNEL_ID }, dependsOn: CHANNEL_ID },
  // A person's own search keys, which the purge must leave exactly as they are.
  { key: "search-authz:v1:member-resource", delegation: null, resourceId: RESOURCE_ID, parentId: null,
    resource: { kind: "resource", workspaceId: WORKSPACE_ID, resourceId: RESOURCE_ID }, dependsOn: CHANNEL_ID },
  { key: "search-authz:v1:member-conversation", delegation: null, resourceId: null, parentId: CHANNEL_ID,
    resource: { kind: "conversation", workspaceId: WORKSPACE_ID, parentId: CHANNEL_ID, substreamId: "0" }, dependsOn: CHANNEL_ID },
  // The prefix, but not at the start: not a memory-search key.
  { key: "search-authz:v1:other-delegation", delegation: `other:${memoryDelegation("run-4")}`, resourceId: SHARED_SCOPE_ID, parentId: CHANNEL_ID,
    resource: { kind: "memory", workspaceId: WORKSPACE_ID, scopeId: SHARED_SCOPE_ID, parentId: CHANNEL_ID }, dependsOn: CHANNEL_ID },
];
const SURVIVORS = KEYS.filter((seed) => !seed.delegation?.startsWith("memory-search:v1:")).map((seed) => seed.key).sort();

describe("the WorkspaceDO memory-search key purge on workerd", () => {
  it("given a populated old search store, when 83 applies, then only memory search's keys and the rows keyed by them are gone", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("workspace-memory-search-key-purge");
    await stub.ping();

    // Commit the old schema and its rows in a separate object event, as in an upgrade.
    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version < PURGE_MIGRATION);
      expect(before.length).toBe(WORKSPACE_DO_SCHEMA_MIGRATIONS.length - 1);
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: before, component: COMPONENT,
        workerVersionId: "before-memory-search-key-purge", now: 1,
      });
      const sql = state.storage.sql;
      for (const seed of KEYS) {
        sql.exec("INSERT INTO search_authorization_keys (cache_key, generation, resource_id, parent_id) VALUES (?, 1, ?, ?)",
          seed.key, seed.resourceId, seed.parentId);
        sql.exec("INSERT INTO authorization_snapshots (cache_key, snapshot_json, validated_at) VALUES (?, ?, 10)", seed.key,
          JSON.stringify({ version: 1, generation: 1, observedAt: 10,
            subject: { workspaceId: WORKSPACE_ID, userId: USER_ID, delegation: seed.delegation },
            resource: seed.resource, decision: { status: "allowed", evidence: [] } }));
        sql.exec("INSERT INTO search_authorization_dependencies (parent_id, cache_key) VALUES (?, ?)", seed.dependsOn, seed.key);
      }
      // Pending pushes: one per target, as the write path and the triggers leave them.
      for (const [kind, target] of [["resource", SCOPE_ID], ["resource", SHARED_SCOPE_ID], ["resource", RESOURCE_ID], ["parent", CHANNEL_ID]]) {
        sql.exec("INSERT INTO search_authorization_push VALUES (?, ?, 1, 0, NULL, 'cache_fill')", kind, target);
      }
    });

    await runInDurableObject(stub, (_instance, state) => {
      const applied = applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS, component: COMPONENT,
        workerVersionId: "with-memory-search-key-purge", now: 2,
      });
      expect(applied).toEqual([PURGE_MIGRATION]);
      const sql = state.storage.sql;
      const keys = (query: string) => sql.exec<{ cache_key: string }>(query).toArray().map((row) => row.cache_key).sort();
      expect(keys("SELECT cache_key FROM search_authorization_keys")).toEqual(SURVIVORS);
      expect(keys("SELECT cache_key FROM authorization_snapshots")).toEqual(SURVIVORS);
      expect(keys("SELECT cache_key FROM search_authorization_dependencies")).toEqual(SURVIVORS);
      // The scope only memory search named loses its push; a scope another key
      // still names, a resource, and a parent keep theirs.
      expect(sql.exec<{ kind: string; target_id: string }>(
        "SELECT kind, target_id FROM search_authorization_push ORDER BY kind, target_id",
      ).toArray()).toEqual([
        { kind: "parent", target_id: CHANNEL_ID },
        { kind: "resource", target_id: RESOURCE_ID },
        { kind: "resource", target_id: SHARED_SCOPE_ID },
      ]);
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
  });
});
