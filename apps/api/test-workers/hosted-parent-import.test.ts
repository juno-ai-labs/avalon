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

import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { asSpaceId, asSubstreamId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import {
  conversationEffectHash,
  ParentEffectEnvelopeSchema,
  type ConversationEffect,
  type ConversationEffectEnvelope,
  type ParentEffect,
} from "@rally/contracts/conversation-effects";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  importLegacyParent,
  LEGACY_PARENT_EXPORT_TABLES,
  notePendingParentImport,
  parentImportState,
} from "../src/durable-objects/hosted-parent-import";
import { spaceDOName, workstreamDOName } from "../src/durable-objects/names";
import type { ScheduledAlarmStore } from "../src/durable-objects/scheduled-alarms";
import {
  PARTICIPANT_MIGRATION_ALARM,
  PARTICIPANT_PROJECTION_ALARM,
  participantMigrationAlarmKey,
  participantProjectionAlarmKey,
} from "../src/durable-objects/scope-grant-storage";
import { SCOPE_INVITATION_DELIVERY_ALARM, scopeInvitationAlarmKey } from "../src/durable-objects/scope-invitation-storage";
import { SPACE_BOOTSTRAP_PAGE_SIZE } from "../src/durable-objects/workspace-space-storage";
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

  it("retries a failed export on the next request instead of waiting out the alarm's backoff", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000f701";
    const parentId = "00000000-0000-7000-8000-00000000f702";
    const elsewhere = "00000000-0000-7000-8000-00000000f7ff";
    // Installed before the Organization exists: its alarm's import phase can
    // take the pending import before the first request does.
    const exports = vi.spyOn(WorkstreamDO.prototype, "exportParentState");
    await seedLegacyChannel(workspaceId, parentId);
    const legacy = legacyStub(workspaceId, parentId);
    await runInDurableObject(legacy, (_instance, state) => {
      state.storage.sql.exec("UPDATE workstream_metadata SET workspace_id = ? WHERE id = 1", elsewhere);
    });
    const workspace = await hostedWorkspace(workspaceId, parentId);
    const request = { workspaceId: asWorkspaceId(workspaceId), parentId };

    const first = await workspace.listChildren(request).then(() => null, (error: unknown) => error);
    // The code is in the message: `cause` does not cross the RPC hop.
    expect(String(first)).toContain("parent_import_unavailable:parent_export_identity_mismatch");
    const deferred = await ledgerRow(workspace, parentId);
    expect(deferred).toMatchObject({ state: "pending", last_error_code: "parent_export_identity_mismatch" });
    // The alarm's next attempt is scheduled; the request path does not wait for it.
    expect(deferred!.not_before).toBeGreaterThan(Date.now());
    const failedExports = exports.mock.calls.length;

    await runInDurableObject(legacy, (_instance, state) => {
      state.storage.sql.exec("UPDATE workstream_metadata SET workspace_id = ? WHERE id = 1", workspaceId);
    });
    const listed = await workspace.listChildren(request);
    expect(listed.children.map((child) => child.substreamId)).toEqual(["0", "00000000-0000-7000-8000-0000000b0001"]);
    expect(exports.mock.calls.length).toBe(failedExports + 1);
    expect(await ledgerRow(workspace, parentId)).toMatchObject({ state: "imported", last_error_code: null });
  });

  it("names an import that fails after the export and retries it on every request", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000f801";
    const parentId = "00000000-0000-7000-8000-00000000f802";
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
    expect(String(first)).toContain("parent_import_unavailable:parent_import_target_not_empty");
    const deferred = await ledgerRow(workspace, parentId);
    expect(deferred).toMatchObject({ state: "pending", last_error_code: "parent_import_target_not_empty" });

    const second = await workspace.listChildren(request).then(() => null, (error: unknown) => error);
    expect(String(second)).toContain("parent_import_unavailable:parent_import_target_not_empty");
    expect((await ledgerRow(workspace, parentId))!.attempts).toBeGreaterThan(deferred!.attempts);
  });

  it("imports once when two requests arrive for the same pending parent together", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000f901";
    const parentId = "00000000-0000-7000-8000-00000000f902";
    // Installed before the ledger row exists, so an export the alarm's import
    // phase makes first is counted too; single-flight allows exactly one.
    const exports = vi.spyOn(WorkstreamDO.prototype, "exportParentState");
    await seedLegacyChannel(workspaceId, parentId);
    const workspace = await hostedWorkspace(workspaceId, parentId);
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

  it("imports a parent in the alarm's pages and re-arms until the ledger has none pending", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000fa01";
    const workspace = await initializedWorkspace(workspaceId);
    // One more than a page. No legacy object holds any of them, so each import
    // is one export that answers "never held a parent".
    const parentIds = Array.from({ length: SPACE_BOOTSTRAP_PAGE_SIZE + 1 }, (_, index) =>
      `00000000-0000-7000-8000-0000fa${String(index).padStart(6, "0")}`);
    const dueAt = Date.now();
    const candidates = await runInDurableObject(workspace, async (instance, state) => {
      for (const parentId of parentIds) notePendingParentImport(state.storage.sql, parentId, "workstream");
      state.storage.sql.exec("UPDATE parent_imports SET not_before = ?", dueAt);
      await state.storage.setAlarm(dueAt);
      return (instance as unknown as { nextDerivedAlarmCandidates(): readonly number[] }).nextDerivedAlarmCandidates();
    });
    // What re-arms the alarm after a page: a pending import is a wake-up of its
    // own, not something another phase happens to cover.
    expect(candidates).toContain(dueAt);
    const pending = () => runInDurableObject(workspace, (_instance, state) => state.storage.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM parent_imports WHERE state = 'pending'",
    ).one().n);

    // Nothing but alarms moves these: no request names any of them.
    await expect.poll(async () => {
      await runDurableObjectAlarm(workspace);
      return pending();
    }, { timeout: 20_000, interval: 50 }).toBe(0);
    expect(await runInDurableObject(workspace, (_instance, state) => state.storage.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM parent_imports WHERE state = 'imported' AND source_rows = 0",
    ).one().n)).toBe(parentIds.length);
  });

  it("keeps a permanently failing import pending with its code on the alarm's retry schedule", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000fb01";
    const parentId = "00000000-0000-7000-8000-00000000fb02";
    await seedLegacyChannel(workspaceId, parentId);
    await runInDurableObject(legacyStub(workspaceId, parentId), (_instance, state) => {
      state.storage.sql.exec("UPDATE workstream_metadata SET workspace_id = ? WHERE id = 1",
        "00000000-0000-7000-8000-00000000fbff");
    });
    const workspace = await hostedWorkspace(workspaceId, parentId);
    await runInDurableObject(workspace, async (_instance, state) => {
      await state.storage.setAlarm(Date.now());
    });

    await expect.poll(async () => {
      await runDurableObjectAlarm(workspace);
      return (await ledgerRow(workspace, parentId))?.attempts ?? 0;
    }, { timeout: 10_000, interval: 50 }).toBeGreaterThan(0);
    const failed = await ledgerRow(workspace, parentId);
    const now = Date.now();
    expect(failed).toMatchObject({ state: "pending", last_error_code: "parent_export_identity_mismatch" });
    // `scheduledAlarmRetryDelay`: at least half a minute on the first attempt,
    // not the 5 s schedule the import used to keep for itself.
    expect(failed!.not_before).toBeGreaterThanOrEqual(now + 20_000);
    const armed = await runInDurableObject(workspace, (_instance, state) => state.storage.getAlarm());
    expect(armed).not.toBeNull();
    expect(armed!).toBeLessThanOrEqual(failed!.not_before);
  });

  it("names the table and rule that refused a row, and imports on an operator retry once it is repaired", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000fc01";
    const parentId = "00000000-0000-7000-8000-00000000fc02";
    const other = "00000000-0000-7000-8000-00000000fc03";
    await seedLegacyChannel(workspaceId, parentId);
    await runInDurableObject(legacyStub(workspaceId, parentId), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO workstream_state_changes (sequence, state_key, waterline, event_id, payload_hash, state_json, occurred_at)
         VALUES (1, 'common', 1, 'colliding-event', 'hash', '{}', 1000)`,
      );
    });
    const workspace = await hostedWorkspace(workspaceId, parentId);
    // `event_id` is unique across the Organization, not per parent.
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO parent_state_changes (parent_id, sequence, state_key, waterline, event_id, payload_hash, state_json, occurred_at)
         VALUES (?, 1, 'common', 1, 'colliding-event', 'hash', '{}', 1000)`,
        other,
      );
    });
    const request = { workspaceId: asWorkspaceId(workspaceId), parentId };

    const refused = await workspace.listChildren(request).then(() => null, (error: unknown) => error);
    expect(String(refused)).toContain("parent_import_unavailable:parent_import_row_rejected:parent_state_changes:unique");
    expect(await workspace.retryParentImport(request)).toMatchObject({
      state: "pending", lastErrorCode: "parent_import_row_rejected:parent_state_changes:unique",
    });
    // Nothing of the parent is here: the refused row rolled the whole import back.
    expect((await importedRows(workspace, parentId)).metadata).toEqual([]);

    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec("DELETE FROM parent_state_changes WHERE parent_id = ?", other);
    });
    expect(await workspace.retryParentImport(request)).toMatchObject({ state: "imported", lastErrorCode: null });
    expect((await importedRows(workspace, parentId)).children).toEqual(["0", "00000000-0000-7000-8000-0000000b0001"]);
  });

  it("runs the post-import replay in the import's transaction, so a replay that fails imports nothing", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000fd01";
    const parentId = "00000000-0000-7000-8000-00000000fd02";
    await seedLegacyChannel(workspaceId, parentId);
    await runInDurableObject(legacyStub(workspaceId, parentId), (_instance, state) => {
      // A direct grant the replay republishes, stored in a shape it refuses.
      state.storage.sql.exec(
        `INSERT INTO scope_grants (user_id, scope_kind, substream_id, grant_json) VALUES (?, 'workstream', '', '{}')`,
        GRANTEE,
      );
    });
    const workspace = await hostedWorkspace(workspaceId, parentId);

    const refused = await workspace.listChildren({ workspaceId: asWorkspaceId(workspaceId), parentId })
      .then(() => null, (error: unknown) => error);

    expect(String(refused)).toContain("parent_import_unavailable:parent_import_failed");
    expect(await importedRows(workspace, parentId)).toMatchObject({ metadata: [], grants: [], ledger: "pending" });
  });

  it("drains an outbox row the legacy object had in flight once the parent is imported", async () => {
    const workspaceId = "00000000-0000-7000-8000-00000000fe01";
    const parentId = "00000000-0000-7000-8000-00000000fe02";
    await seedLegacyChannel(workspaceId, parentId);
    const envelope = legacyCommonEnvelope(workspaceId, parentId, "workstream", "01999999-0000-7000-8000-00000000fe0a");
    await runInDurableObject(legacyStub(workspaceId, parentId), (_instance, state) => {
      // In flight, and backed off a day: the legacy drain had sent it and not
      // heard back. The import has to make it due here, not inherit the wait.
      state.storage.sql.exec(
        `INSERT INTO durable_outbox (message_id, partition_key, source_version, source_epoch, effect_kind,
           payload_json, payload_hash, state, attempts, not_before, created_at)
         VALUES (?, 'common', 1, 1, 'directory_common', ?, ?, 'inflight', 3, ?, 1000)`,
        envelope.messageId, JSON.stringify(envelope), envelope.payloadHash, Date.now() + 86_400_000,
      );
    });
    const workspace = await hostedWorkspace(workspaceId, parentId);

    await workspace.listChildren({ workspaceId: asWorkspaceId(workspaceId), parentId });

    await expect.poll(() => runInDurableObject(workspace, (_instance, state) => ({
      directory: state.storage.sql.exec("SELECT title FROM channels WHERE workstream_id = ?", parentId).toArray(),
      outbox: state.storage.sql.exec("SELECT * FROM parent_outbox WHERE parent_id = ?", parentId).toArray(),
    })), { timeout: 10_000, interval: 50 }).toEqual({ directory: [{ title: "From the legacy outbox" }], outbox: [] });
  });
});

/**
 * Every legacy table a parent can hold, and the hosted table its rows land in.
 * Written out here rather than read from the import's own map, so a mapping
 * the import drops or points elsewhere fails this file instead of agreeing
 * with it.
 */
const HOSTED_TABLE: Record<(typeof LEGACY_PARENT_EXPORT_TABLES)[number], { table: string; where?: string }> = {
  workstream_metadata: { table: "parent_metadata" },
  conversation_children: { table: "parent_children" },
  substream_directory: { table: "parent_child_projections" },
  substream_user_directory: { table: "parent_child_viewer_projections" },
  projection_keys: { table: "parent_projection_keys" },
  workstream_state_clock: { table: "parent_state_clock" },
  workstream_state_changes: { table: "parent_state_changes" },
  durable_outbox: { table: "parent_outbox" },
  private_child_preparations: { table: "parent_breakout_preparations" },
  private_child_memberships: { table: "parent_breakout_members" },
  private_child_membership_effects: { table: "parent_breakout_member_effects" },
  scope_grant_revision: { table: "parent_grant_revision" },
  scope_grants: { table: "parent_grants" },
  scope_grant_operations: { table: "parent_grant_operations" },
  scope_grant_imports: { table: "parent_grant_imports" },
  participant_projection_targets: { table: "parent_participant_targets" },
  participant_projection_deliveries: { table: "parent_participant_deliveries" },
  main_participant_migration: { table: "parent_participant_migrations", where: "substream_id = '0'" },
  child_participant_migrations: { table: "parent_participant_migrations", where: "substream_id <> '0'" },
  scope_invitation_operations: { table: "parent_invitation_operations" },
  scope_invitations: { table: "parent_invitations" },
  connector_participant_admissions: { table: "parent_connector_admissions" },
  workstream_sidekick_attachments: { table: "parent_sidekicks" },
  workstream_direct_audience: { table: "parent_direct_audience" },
  workstream_space_access_sources: { table: "parent_space_sources" },
  workstream_space_supplied_readers: { table: "parent_space_readers" },
  workstream_access_operations: { table: "parent_access_operations" },
};

type SqlRow = Record<string, SqlStorageValue>;

/** Hosted columns whose value is not the legacy column of the same name. */
function hostedOverrides(legacy: string, row: SqlRow, kind: "workstream" | "space"): SqlRow {
  switch (legacy) {
    case "workstream_metadata": return { parent_kind: kind };
    // Whatever the legacy drain was doing with it, it is due again here.
    case "durable_outbox": return { state: "pending", not_before: 0, last_error_code: null };
    case "private_child_membership_effects":
      return { state: row.state === "delivered" ? "delivered" : "pending", not_before: 0 };
    case "main_participant_migration": return { substream_id: "0" };
    case "child_participant_migrations": return { incarnations_json: null };
    default: return {};
  }
}

/**
 * A parent's own directory row as a legacy parent held it in `durable_outbox`.
 * A directory row's source identity is a UUIDv7, as the legacy parent minted it.
 */
function legacyCommonEnvelope(workspaceId: string, parentId: string, parentKind: "workstream" | "space", messageId: string) {
  const effect: ParentEffect = {
    kind: "directory_common",
    title: "From the legacy outbox",
    description: "",
    preview: "",
    scope: "workspace",
    state: "idle",
    systemKind: null,
    lastActivityAt: "2026-09-25T12:00:00.000Z",
    completedAt: null,
    archivedAt: null,
  };
  return ParentEffectEnvelopeSchema.parse({
    kind: "parent_effect",
    contractVersion: 1,
    region: REGION,
    workspaceId,
    parentKind,
    parentId,
    generation: 1,
    messageId,
    partitionKey: "common",
    sourceVersion: 1,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  });
}

const BREAKOUT = "00000000-0000-7000-8000-0000000b0001";
const MEMBER = "00000000-0000-7000-8000-0000000c0011";
const TRANSFER = "00000000-0000-7000-8000-0000000c0012";
const INVITATION = "00000000-0000-7000-8000-0000000c0013";
const SIDEKICK = "00000000-0000-7000-8000-0000000c0014";
const SPACE_SOURCE = "00000000-0000-7000-8000-0000000c0015";

/**
 * At least one row in every table the export carries, beyond the metadata and
 * children `seedLegacyParent` writes: a pending outbox row, a breakout member
 * whose participants then migrated, an undelivered participant projection,
 * and an unsent invitation.
 */
function seedEveryLegacyTable(sql: SqlStorage, workspaceId: string, parentId: string, kind: "workstream" | "space"): void {
  const outbox = legacyCommonEnvelope(workspaceId, parentId, kind, "01999999-0000-7000-8000-00000000ff0a");
  const statements: Array<[string, ...SqlStorageValue[]]> = [
    [`INSERT INTO substream_directory VALUES (?, 2, 'hash-common', '{"kind":"directory_common"}', 1100)`, BREAKOUT],
    [`INSERT INTO substream_user_directory VALUES (?, ?, 1, 'hash-user', '{"kind":"directory_user"}', 1100)`, BREAKOUT, MEMBER],
    [`INSERT INTO projection_keys VALUES ('common', 3, 'hash-key', 1200)`],
    [`INSERT OR REPLACE INTO workstream_state_clock VALUES (1, 7, 1300)`],
    [`INSERT INTO workstream_state_changes VALUES (6, 'common', 2, 'every-table-event', 'hash-state', '{"a":1}', 1300)`],
    [`INSERT INTO durable_outbox (message_id, partition_key, source_version, source_epoch, effect_kind, payload_json,
        payload_hash, state, attempts, not_before, created_at)
      VALUES (?, 'common', 1, 1, 'directory_common', ?, ?, 'inflight', 4, 99999, 1400)`,
      outbox.messageId, JSON.stringify(outbox), outbox.payloadHash],
    [`INSERT INTO private_child_preparations VALUES ('prep-op', ?, ?, '{}', NULL, '[]', NULL, 'ready', NULL, 1500, 1500, NULL)`,
      BREAKOUT, MEMBER],
    [`INSERT INTO private_child_memberships VALUES (?, ?, 1, 2, ?, 1500, NULL, 1600)`, BREAKOUT, MEMBER, CREATOR],
    [`INSERT INTO private_child_membership_effects VALUES ('member-op', ?, ?, ?, 1, 2, 'inflight', 1, 88888, 1600)`,
      BREAKOUT, MEMBER, CREATOR],
    [`INSERT OR REPLACE INTO scope_grant_revision VALUES (1, 5)`],
    [`INSERT INTO scope_grants (user_id, scope_kind, substream_id, grant_json, source_kind, source_id)
      VALUES (?, 'conversation', ?, '{"c":3}', 'space', ?)`, MEMBER, BREAKOUT, SPACE_SOURCE],
    [`INSERT INTO scope_grant_operations VALUES ('grant-op', '{"d":4}', '{"e":5}', 1700)`],
    [`INSERT INTO scope_grant_imports VALUES ('workstream', '', '{"f":6}', '{"g":7}')`],
    [`INSERT INTO participant_projection_targets VALUES (?, ?)`, BREAKOUT, TRANSFER],
    [`INSERT INTO participant_projection_deliveries VALUES (?, ?, 1, ?, NULL)`, BREAKOUT, MEMBER, JSON.stringify({
      substreamId: BREAKOUT,
      projection: {
        transferId: TRANSFER, userId: MEMBER, revision: 1, active: true, reason: "explicit",
        addedByUserId: CREATOR, changedAt: 1800,
      },
    })],
    [`INSERT INTO main_participant_migration VALUES (1, ?, '{"h":8}', 'complete')`, TRANSFER],
    // After the membership: the legacy freeze trigger refuses a member of a
    // conversation whose participants already migrated, and so does the hosted one.
    [`INSERT INTO child_participant_migrations VALUES (?, ?, 'pending')`, BREAKOUT, TRANSFER],
    [`INSERT INTO scope_invitation_operations VALUES ('invite-op', '{"i":9}', ?)`, JSON.stringify([INVITATION])],
    [`INSERT INTO scope_invitations VALUES (?, 'invite-op', ?, 'incarnation-1', '{"status":"pending"}', 'token-hash-every',
        'sealed', '[]', NULL, NULL, 1900)`, INVITATION, CREATOR],
    [`INSERT INTO connector_participant_admissions VALUES ('connector-event', '{"j":10}')`],
    [`INSERT INTO workstream_sidekick_attachments VALUES (?, 2000)`, SIDEKICK],
    [`INSERT OR REPLACE INTO workstream_direct_audience VALUES (1, 'personal', 2100)`],
    [`INSERT INTO workstream_space_access_sources VALUES (?, 'workspace', '[]', 3, 2, 'space-op', 2200, 2300)`, SPACE_SOURCE],
    [`INSERT INTO workstream_space_supplied_readers VALUES (?, ?)`, SPACE_SOURCE, MEMBER],
    [`INSERT INTO workstream_access_operations VALUES ('access-op', '{"k":11}', '{"l":12}', 2400)`],
  ];
  for (const [statement, ...bindings] of statements) sql.exec(statement, ...bindings);
}

function canonical(rows: SqlRow[]): string[] {
  return rows.map((row) => JSON.stringify(Object.keys(row).sort().map((key) => [key, row[key]]))).sort();
}

describe.each([
  { kind: "workstream" as const, component: "workstream_do" as const, suffix: "10" },
  { kind: "space" as const, component: "space_do" as const, suffix: "20" },
])("hosted parent import of every legacy $kind table", ({ kind, component, suffix }) => {
  it("copies every row of every exported table and re-arms the work the legacy alarm owed", async () => {
    const workspaceId = `00000000-0000-7000-8000-00000000ff${suffix}`;
    const parentId = `00000000-0000-7000-8000-00000000ff${suffix.replace("0", "1")}`;
    const legacy = kind === "space" ? legacySpaceStub(workspaceId, parentId) : legacyStub(workspaceId, parentId);
    await seedLegacyParent(legacy, component, workspaceId, parentId);
    const legacyRows = await runInDurableObject(legacy, (_instance, state) => {
      seedEveryLegacyTable(state.storage.sql, workspaceId, parentId, kind);
      return Object.fromEntries(LEGACY_PARENT_EXPORT_TABLES.map((table) => [
        table, state.storage.sql.exec<SqlRow>(`SELECT * FROM ${table}`).toArray(),
      ])) as Record<keyof typeof HOSTED_TABLE, SqlRow[]>;
    });
    // The fixture keeps up with the export: a table added to it without a
    // row here, or without a line in HOSTED_TABLE, fails first.
    expect(Object.keys(HOSTED_TABLE).sort()).toEqual([...LEGACY_PARENT_EXPORT_TABLES].sort());
    for (const table of LEGACY_PARENT_EXPORT_TABLES) expect({ table, rows: legacyRows[table].length > 0 }).toEqual({ table, rows: true });
    const exported = await legacy.exportParentState({ workspaceId: asWorkspaceId(workspaceId), parentId });
    const workspace = await initializedWorkspace(workspaceId);
    const now = Date.now();

    // One synchronous block: nothing the imported alarms or rows start can
    // run between the import and the reads.
    const hosted = await runInDurableObject(workspace, (instance, state) => {
      const alarms = (instance as unknown as { scheduledAlarms: ScheduledAlarmStore }).scheduledAlarms;
      importLegacyParent(state.storage, alarms, parentId, kind, exported, now);
      const tables = Object.fromEntries(LEGACY_PARENT_EXPORT_TABLES.map((legacyTable) => {
        const { table, where } = HOSTED_TABLE[legacyTable];
        return [legacyTable, {
          columns: state.storage.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((column) => column.name),
          rows: state.storage.sql.exec<SqlRow>(
            `SELECT * FROM ${table} WHERE parent_id = ?${where ? ` AND ${where}` : ""}`, parentId,
          ).toArray(),
        }];
      }));
      const armed = state.storage.sql.exec<{ kind: string; alarm_key: string; due_at: number }>(
        "SELECT kind, alarm_key, due_at FROM _internal_durable_alarms WHERE alarm_key LIKE ? ORDER BY kind, alarm_key",
        `${parentId}:%`,
      ).toArray();
      return { tables, armed };
    });

    for (const legacyTable of LEGACY_PARENT_EXPORT_TABLES) {
      const { columns, rows } = hosted.tables[legacyTable]!;
      const expected = legacyRows[legacyTable].map((row) => {
        const overrides = hostedOverrides(legacyTable, row, kind);
        return Object.fromEntries(columns.map((column) => [column,
          column === "parent_id" ? parentId
            : column in overrides ? overrides[column]!
              : column in row ? row[column]!
                : `unmapped:${column}`]));
      });
      expect({ table: legacyTable, rows: canonical(rows) }).toEqual({ table: legacyTable, rows: canonical(expected) });
    }
    const byKey = (left: { kind: string; alarm_key: string }, right: { kind: string; alarm_key: string }) =>
      left.kind.localeCompare(right.kind) || left.alarm_key.localeCompare(right.alarm_key);
    expect([...hosted.armed].sort(byKey)).toEqual([
      { kind: PARTICIPANT_MIGRATION_ALARM, alarm_key: participantMigrationAlarmKey(parentId, BREAKOUT), due_at: now },
      {
        kind: PARTICIPANT_PROJECTION_ALARM,
        alarm_key: participantProjectionAlarmKey(parentId, BREAKOUT, MEMBER, 1),
        due_at: now,
      },
      { kind: SCOPE_INVITATION_DELIVERY_ALARM, alarm_key: scopeInvitationAlarmKey(parentId, INVITATION), due_at: now },
    ].sort(byKey));
  });
});
