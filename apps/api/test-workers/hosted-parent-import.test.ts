/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Moving a Channel parent out of its legacy `WorkstreamDO` and into the
 * Organization object, on real workerd.
 *
 * The legacy object is seeded the way a deployed one looks: its own migration
 * ledger applied, a metadata row, and a child registry. The first request the
 * Organization object serves for that parent pulls the rows across; from then
 * on the legacy object is frozen and the Organization object answers alone.
 * `docs/hosted-conversation-parents.md` owns the procedure.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import { describe, expect, it } from "vitest";

import { notePendingParentImport, parentImportState } from "../src/durable-objects/hosted-parent-import";
import { workstreamDOName } from "../src/durable-objects/names";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSTREAM_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-do";
import { hostedParentStub } from "./helpers/hosted-parent";

const REGION = "global";

function legacyStub(workspaceId: string, parentId: string) {
  return env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
    workstreamDOName(REGION, asWorkspaceId(workspaceId), asWorkstreamId(parentId)),
  ));
}

/** A deployed legacy Channel: its ledger, its metadata, Main and one breakout. */
async function seedLegacyChannel(workspaceId: string, parentId: string): Promise<void> {
  await runInDurableObject(legacyStub(workspaceId, parentId), (instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage,
      migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS,
      component: "workstream_do",
      workerVersionId: "test",
    });
    state.storage.sql.exec(
      `INSERT INTO workstream_metadata (
         id, workspace_id, workstream_id, region, authority_generation, title, description, preview,
         scope, exact_state, last_activity_at, created_at, updated_at)
       VALUES (1, ?, ?, ?, 1, 'Launch plan', '', '', 'workspace', 'idle', 1000, 1000, 1000)`,
      workspaceId, parentId, REGION,
    );
    state.storage.sql.exec(
      `INSERT INTO conversation_children (substream_id, kind, created_by_user_id, created_at)
       VALUES ('0', 'main', NULL, 1000), ('00000000-0000-7000-8000-0000000b0001', 'child', 'user-1', 2000)`,
    );
    // The instance decided it was empty when it started, before the ledger
    // above existed. A deployed object with this ledger starts not empty.
    (instance as unknown as { empty: boolean }).empty = false;
  });
}

async function hostedWorkspace(workspaceId: string, parentId: string) {
  const workspace = hostedParentStub(env, workspaceId, REGION);
  await workspace.initializeWorkspace(workspaceId, "wnam");
  await runInDurableObject(workspace, (_instance, state) => {
    notePendingParentImport(state.storage.sql, parentId, "workstream");
  });
  return workspace;
}

describe("hosted parent import", () => {
  it("serves a legacy Channel's children from the Organization object after the first request", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000f101";
    const parentId = "00000000-0000-7000-8000-00000000f102";
    await seedLegacyChannel(workspaceId, parentId);
    const workspace = await hostedWorkspace(workspaceId, parentId);

    const listed = await workspace.listChildren({ workspaceId: asWorkspaceId(workspaceId), parentId });

    expect(listed.children).toEqual([
      { substreamId: "0", kind: "main", createdAt: 1000 },
      { substreamId: "00000000-0000-7000-8000-0000000b0001", kind: "child", createdAt: 2000 },
    ]);
    await runInDurableObject(workspace, (_instance, state) => {
      expect(parentImportState(state.storage.sql, parentId)).toBe("imported");
      expect(state.storage.sql.exec(
        "SELECT title, parent_kind FROM parent_metadata WHERE parent_id = ?", parentId,
      ).toArray()).toEqual([{ title: "Launch plan", parent_kind: "workstream" }]);
    });
  });

  it("freezes the legacy object, which then refuses every product request", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000f201";
    const parentId = "00000000-0000-7000-8000-00000000f202";
    await seedLegacyChannel(workspaceId, parentId);
    const workspace = await hostedWorkspace(workspaceId, parentId);
    await workspace.listChildren({ workspaceId: asWorkspaceId(workspaceId), parentId });

    const legacy = legacyStub(workspaceId, parentId);
    await runInDurableObject(legacy, (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT workspace_id, parent_id FROM parent_authority_moved",
      ).toArray()).toEqual([{ workspace_id: workspaceId, parent_id: parentId }]);
    });
    const response = await legacy.fetch("https://parent.test/workstream");
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "conversation_parent_moved" });
  });

  it("closes the ledger for a parent whose legacy object never held one, without creating it", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000f301";
    const parentId = "00000000-0000-7000-8000-00000000f302";
    const workspace = await hostedWorkspace(workspaceId, parentId);

    await expect(workspace.listChildren({ workspaceId: asWorkspaceId(workspaceId), parentId }))
      .rejects.toThrow("conversation_parent_missing");

    await runInDurableObject(workspace, (_instance, state) => {
      expect(parentImportState(state.storage.sql, parentId)).toBe("imported");
    });
    await runInDurableObject(legacyStub(workspaceId, parentId), (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'",
      ).toArray()).toEqual([]);
    });
  });
});
