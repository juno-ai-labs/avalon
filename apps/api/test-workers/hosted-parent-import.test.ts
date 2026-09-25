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
import { asSpaceId, asSubstreamId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import {
  conversationEffectHash,
  type ConversationEffect,
  type ConversationEffectEnvelope,
} from "@rally/contracts/conversation-effects";
import { afterEach, describe, expect, it, vi } from "vitest";

import { notePendingParentImport, parentImportState } from "../src/durable-objects/hosted-parent-import";
import { spaceDOName, workstreamDOName } from "../src/durable-objects/names";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSTREAM_DO_SCHEMA_MIGRATIONS, WorkstreamDO } from "../src/durable-objects/workstream-do";
import { hostedParentStub } from "./helpers/hosted-parent";

const REGION = "global";

function legacyStub(workspaceId: string, parentId: string) {
  return env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
    workstreamDOName(REGION, asWorkspaceId(workspaceId), asWorkstreamId(parentId)),
  ));
}

function legacySpaceStub(workspaceId: string, spaceId: string) {
  return env.SPACE_DOS.get(env.SPACE_DOS.idFromName(
    spaceDOName(REGION, asWorkspaceId(workspaceId), asSpaceId(spaceId)),
  ));
}

/** A deployed legacy Channel: its ledger, its metadata, Main and one breakout. */
async function seedLegacyChannel(workspaceId: string, parentId: string): Promise<void> {
  await seedLegacyParent(legacyStub(workspaceId, parentId), "workstream_do", workspaceId, parentId);
}

/** The same rows in any legacy parent object; a Space's ledger is the Channel's under its own component. */
async function seedLegacyParent(
  stub: DurableObjectStub,
  component: "workstream_do" | "space_do",
  workspaceId: string,
  parentId: string,
): Promise<void> {
  await runInDurableObject(stub, (instance, state) => {
    applyDurableObjectSqliteMigrations({
      storage: state.storage,
      migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS,
      component,
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

/** The Organization object, initialized, with no row and no ledger entry for any parent. */
async function initializedWorkspace(workspaceId: string) {
  const workspace = hostedParentStub(env, workspaceId, REGION);
  await workspace.initializeWorkspace(workspaceId, "wnam");
  return workspace;
}

const CREATOR = "00000000-0000-7000-8000-0000000c0001";
const GRANTEE = "00000000-0000-7000-8000-0000000c0002";

/** The legacy Channel's creator and one direct grant: what a fresh metadata row would lose. */
async function seedLegacyCreatorAndGrant(workspaceId: string, parentId: string): Promise<void> {
  await runInDurableObject(legacyStub(workspaceId, parentId), (_instance, state) => {
    state.storage.sql.exec("UPDATE workstream_metadata SET created_by_user_id = ? WHERE id = 1", CREATOR);
    state.storage.sql.exec(
      `INSERT INTO scope_grants (user_id, scope_kind, substream_id, grant_json) VALUES (?, 'workstream', '', ?)`,
      GRANTEE,
      JSON.stringify({
        id: "00000000-0000-7000-8000-0000000c0003",
        userId: GRANTEE,
        target: { kind: "workstream", workspaceId, parentId },
        membershipIncarnation: null,
        active: true,
        revision: 1,
      }),
    );
  });
}

/** Main's directory row, as a conversation addresses it to its Channel. */
function mainCommonEnvelope(workspaceId: string, parentId: string, messageId: string): ConversationEffectEnvelope {
  const effect: ConversationEffect = {
    kind: "directory_common",
    title: "From Main",
    description: "",
    preview: "",
    scope: "workspace",
    state: "idle",
    systemKind: null,
    lastActivityAt: "2026-09-25T12:00:00.000Z",
    completedAt: null,
    archivedAt: null,
    // Main carries its creator on every directory row, so this is not what
    // tells an imported row from a fresh one: `created_at` is, below.
    createdByUserId: CREATOR,
  };
  return {
    kind: "conversation_effect",
    contractVersion: 1,
    region: REGION,
    workspaceId: asWorkspaceId(workspaceId),
    parentKind: "workstream",
    parentId,
    substreamId: asSubstreamId("0"),
    generation: 1,
    messageId,
    partitionKey: "common",
    sourceVersion: 1,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  };
}

type LedgerRow = {
  state: string; attempts: number; not_before: number; last_error_code: string | null;
};

async function ledgerRow(workspace: DurableObjectStub, parentId: string): Promise<LedgerRow | undefined> {
  return runInDurableObject(workspace, (_instance, state) => state.storage.sql.exec<LedgerRow>(
    "SELECT state, attempts, not_before, last_error_code FROM parent_imports WHERE parent_id = ?", parentId,
  ).toArray()[0]);
}

/** The rows the Organization object holds for one parent, for the orphan and single-flight checks. */
async function importedRows(workspace: DurableObjectStub, parentId: string) {
  return runInDurableObject(workspace, (_instance, state) => ({
    metadata: state.storage.sql.exec(
      "SELECT parent_kind, created_by_user_id, created_at FROM parent_metadata WHERE parent_id = ?", parentId,
    ).toArray(),
    children: state.storage.sql.exec(
      "SELECT substream_id FROM parent_children WHERE parent_id = ? ORDER BY substream_id", parentId,
    ).toArray().map((row) => row.substream_id),
    grants: state.storage.sql.exec(
      "SELECT user_id FROM parent_grants WHERE parent_id = ?", parentId,
    ).toArray().map((row) => row.user_id),
    ledger: parentImportState(state.storage.sql, parentId),
  }));
}

describe("hosted parent import", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
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

    const refused = await workspace.listChildren({ workspaceId: asWorkspaceId(workspaceId), parentId })
      .then(() => null, (error: unknown) => error);
    expect(String(refused)).toContain("conversation_parent_missing");

    await runInDurableObject(workspace, (_instance, state) => {
      expect(parentImportState(state.storage.sql, parentId)).toBe("imported");
    });
    await runInDurableObject(legacyStub(workspaceId, parentId), (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'",
      ).toArray()).toEqual([]);
    });
  });

  it("imports an orphan Channel's legacy rows before applying a child effect the Queue delivers straight to it", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000f401";
    const parentId = "00000000-0000-7000-8000-00000000f402";
    await seedLegacyChannel(workspaceId, parentId);
    await seedLegacyCreatorAndGrant(workspaceId, parentId);
    const workspace = await initializedWorkspace(workspaceId);
    const envelope = mainCommonEnvelope(workspaceId, parentId, "orphan-common");

    const result = await workspace.receiveChildEffects({ substreamId: asSubstreamId("0"), envelopes: [envelope] });

    expect(result.accepted).toEqual([{ messageId: envelope.messageId, payloadHash: envelope.payloadHash }]);
    expect(await importedRows(workspace, parentId)).toEqual({
      // The legacy row's `created_at`: a row the effect created would carry now.
      metadata: [{ parent_kind: "workstream", created_by_user_id: CREATOR, created_at: 1000 }],
      children: ["0", "00000000-0000-7000-8000-0000000b0001"],
      grants: [GRANTEE],
      ledger: "imported",
    });
    await runInDurableObject(legacyStub(workspaceId, parentId), (_instance, state) => {
      expect(state.storage.sql.exec("SELECT parent_id FROM parent_authority_moved").toArray())
        .toEqual([{ parent_id: parentId }]);
    });
  });

  it("forwards a child effect sent to the legacy Channel to the Organization object, which imports it first", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000f501";
    const parentId = "00000000-0000-7000-8000-00000000f502";
    await seedLegacyChannel(workspaceId, parentId);
    await seedLegacyCreatorAndGrant(workspaceId, parentId);
    const workspace = await initializedWorkspace(workspaceId);
    const envelope = mainCommonEnvelope(workspaceId, parentId, "forwarded-common");

    const result = await legacyStub(workspaceId, parentId).receiveChildEffects({
      substreamId: asSubstreamId("0"), envelopes: [envelope],
    });

    expect(result.accepted).toEqual([{ messageId: envelope.messageId, payloadHash: envelope.payloadHash }]);
    expect(await importedRows(workspace, parentId)).toEqual({
      // The legacy row's `created_at`: a row the effect created would carry now.
      metadata: [{ parent_kind: "workstream", created_by_user_id: CREATOR, created_at: 1000 }],
      children: ["0", "00000000-0000-7000-8000-0000000b0001"],
      grants: [GRANTEE],
      ledger: "imported",
    });
  });

  it("imports a legacy Space into the Organization object as a Space and freezes the SpaceDO", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000f601";
    const spaceId = "00000000-0000-7000-8000-00000000f602";
    const legacy = legacySpaceStub(workspaceId, spaceId);
    await seedLegacyParent(legacy, "space_do", workspaceId, spaceId);
    const workspace = await initializedWorkspace(workspaceId);
    await runInDurableObject(workspace, (_instance, state) => {
      notePendingParentImport(state.storage.sql, spaceId, "space");
    });

    const authority = await workspace.authority({ workspaceId: asWorkspaceId(workspaceId), parentId: spaceId });

    expect(authority).toMatchObject({ exists: true, authorityGeneration: 1 });
    await runInDurableObject(workspace, (_instance, state) => {
      expect(parentImportState(state.storage.sql, spaceId)).toBe("imported");
      expect(state.storage.sql.exec(
        "SELECT parent_kind, title FROM parent_metadata WHERE parent_id = ?", spaceId,
      ).toArray()).toEqual([{ parent_kind: "space", title: "Launch plan" }]);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS n FROM parent_children WHERE parent_id = ?", spaceId,
      ).one().n).toBe(2);
    });
    const response = await legacy.fetch("https://parent.test/space");
    expect(response.status).toBe(410);
  });

  it("waits out a failed export's backoff on the request path without asking the legacy object again", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000f701";
    const parentId = "00000000-0000-7000-8000-00000000f702";
    const elsewhere = "00000000-0000-7000-8000-00000000f7ff";
    await seedLegacyChannel(workspaceId, parentId);
    const legacy = legacyStub(workspaceId, parentId);
    await runInDurableObject(legacy, (_instance, state) => {
      state.storage.sql.exec("UPDATE workstream_metadata SET workspace_id = ? WHERE id = 1", elsewhere);
    });
    const workspace = await hostedWorkspace(workspaceId, parentId);
    const exports = vi.spyOn(WorkstreamDO.prototype, "exportParentState");
    const request = { workspaceId: asWorkspaceId(workspaceId), parentId };

    const first = await workspace.listChildren(request).then(() => null, (error: unknown) => error);
    expect(String(first)).toContain("parent_import_unavailable");
    expect(exports).toHaveBeenCalledTimes(1);
    const deferred = await ledgerRow(workspace, parentId);
    expect(deferred).toMatchObject({ state: "pending", attempts: 1, last_error_code: "parent_export_identity_mismatch" });
    expect(deferred!.not_before).toBeGreaterThan(Date.now());

    // The legacy object would now export cleanly. Inside the backoff the
    // request still fails, and the legacy object is not asked.
    await runInDurableObject(legacy, (_instance, state) => {
      state.storage.sql.exec("UPDATE workstream_metadata SET workspace_id = ? WHERE id = 1", workspaceId);
    });
    const second = await workspace.listChildren(request).then(() => null, (error: unknown) => error);
    expect(String(second)).toContain("parent_import_unavailable");
    expect(exports).toHaveBeenCalledTimes(1);
    expect(await ledgerRow(workspace, parentId)).toMatchObject({ state: "pending", attempts: 1 });

    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec("UPDATE parent_imports SET not_before = 0 WHERE parent_id = ?", parentId);
    });
    const listed = await workspace.listChildren(request);
    expect(listed.children.map((child) => child.substreamId)).toEqual(["0", "00000000-0000-7000-8000-0000000b0001"]);
    expect(exports).toHaveBeenCalledTimes(2);
    expect(await ledgerRow(workspace, parentId)).toMatchObject({ state: "imported", last_error_code: null });
  });

  it("defers an import that fails after the export, with its code, instead of retrying it per request", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000f801";
    const parentId = "00000000-0000-7000-8000-00000000f802";
    // Counted from before the Organization exists: its alarm's import phase
    // can take the pending import before the first request does, and that
    // export is the one attempt this case allows.
    const exports = vi.spyOn(WorkstreamDO.prototype, "exportParentState");
    await seedLegacyChannel(workspaceId, parentId);
    const workspace = await hostedWorkspace(workspaceId, parentId);
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO parent_metadata (parent_id, parent_kind, workspace_id, region, authority_generation, title,
           description, preview, scope, exact_state, last_activity_at, created_at, updated_at)
         VALUES (?, 'workstream', ?, ?, 1, 'Already here', '', '', 'workspace', 'idle', 1000, 1000, 1000)`,
        parentId, workspaceId, REGION,
      );
    });
    const request = { workspaceId: asWorkspaceId(workspaceId), parentId };

    const first = await workspace.listChildren(request).then(() => null, (error: unknown) => error);
    expect(String(first)).toContain("parent_import_unavailable");
    const deferred = await ledgerRow(workspace, parentId);
    expect(deferred).toMatchObject({ state: "pending", attempts: 1, last_error_code: "parent_import_target_not_empty" });
    expect(deferred!.not_before).toBeGreaterThan(Date.now());

    const second = await workspace.listChildren(request).then(() => null, (error: unknown) => error);
    expect(String(second)).toContain("parent_import_unavailable");
    expect(exports).toHaveBeenCalledTimes(1);
    expect(await ledgerRow(workspace, parentId)).toMatchObject({ attempts: 1 });
  });

  it("imports once when two requests arrive for the same pending parent together", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000f901";
    const parentId = "00000000-0000-7000-8000-00000000f902";
    await seedLegacyChannel(workspaceId, parentId);
    const workspace = await hostedWorkspace(workspaceId, parentId);
    const exports = vi.spyOn(WorkstreamDO.prototype, "exportParentState");
    const request = { workspaceId: asWorkspaceId(workspaceId), parentId };

    const [left, right] = await Promise.all([workspace.listChildren(request), workspace.listChildren(request)]);

    expect(left.children).toHaveLength(2);
    expect(right.children).toEqual(left.children);
    expect(exports).toHaveBeenCalledTimes(1);
    await runInDurableObject(workspace, (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT state, attempts, source_rows FROM parent_imports WHERE parent_id = ?", parentId,
      ).toArray()).toEqual([{ state: "imported", attempts: 0, source_rows: expect.any(Number) }]);
      expect(state.storage.sql.exec(
        "SELECT COUNT(*) AS n FROM parent_children WHERE parent_id = ?", parentId,
      ).one().n).toBe(2);
    });
  });
});
