import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { asWorkspaceId, asUserId } from "@rally/contracts";
import { ScopeGrantSchema } from "@rally/contracts/scope-grants";
import { ParentEffectEnvelopeSchema, conversationEffectHash } from "@rally/contracts/conversation-effects";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSTREAM_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-do";
import { workspaceDOName } from "../src/durable-objects/names";
import { consumeEffectBodies } from "./helpers/conversation-effects";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-000000000081");
const parentId = "00000000-0000-4000-8000-000000000082";
const userId = asUserId("00000000-0000-4000-8000-000000000083");
const childId = "00000000-0000-4000-8000-000000000084";
const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", workspaceId));
const candidates = (membershipIncarnation = "first") => workspace().listScopeGrantCandidates({ workspaceId, userId, membershipIncarnation });
function envelope(version: number, active = true, incarnation = "first", generation = 1) {
  const grant = ScopeGrantSchema.parse({ id: "00000000-0000-4000-8000-000000000085", userId,
    target: { kind: "conversation", workspaceId, parentId, substreamId: childId },
    active, revision: version, membershipIncarnation: incarnation });
  const effect = { kind: "scope_grant_directory" as const, grant };
  return ParentEffectEnvelopeSchema.parse({ kind: "parent_effect", contractVersion: 1, region: "global", workspaceId,
    parentKind: "workstream", parentId, generation, messageId: crypto.randomUUID(), partitionKey: `grant:${userId}:conversation:${childId}`,
    sourceVersion: version, requiredProjectionVersion: null, payloadHash: conversationEffectHash(effect), effect });
}

beforeEach(async () => {
  await reset();
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE workspaces(id TEXT PRIMARY KEY,region TEXT,abandoned_at TEXT)"),
    env.DB.prepare("INSERT INTO workspaces(id,region) VALUES (?,'global')").bind(workspaceId),
  ]);
  await workspace().initializeWorkspace(workspaceId, "wnam");
});

it("projects queue grants without allowing late additions to undo revocation", async () => {
  const added = envelope(1), removed = envelope(2, false);
  expect(await consumeEffectBodies(env, [added])).toEqual({ acked: 1, retried: 0 });
  expect(await candidates()).toEqual([parentId]);
  expect(await candidates("replacement")).toEqual([]);
  expect(await consumeEffectBodies(env, [removed, added])).toEqual({ acked: 2, retried: 0 });
  expect(await candidates()).toEqual([]);
  expect(await workspace().applyScopeGrantDirectory(removed)).toEqual({ applied: false });
  await expect(runInDurableObject(workspace(), (instance) => instance.applyScopeGrantDirectory(envelope(2, true)))).rejects.toThrow("version_conflict");
});

it("isolates membership incarnations and fences previous parent generations", async () => {
  await workspace().applyScopeGrantDirectory(envelope(7));
  await workspace().applyScopeGrantDirectory(envelope(1, true, "replacement", 2));
  expect(await candidates()).toEqual([]);
  expect(await candidates("replacement")).toEqual([parentId]);
  await workspace().applyScopeGrantDirectory(envelope(8, false));
  expect(await candidates("replacement")).toEqual([parentId]);
  await expect(runInDurableObject(workspace(), (instance) => instance.applyScopeGrantDirectory({ ...envelope(2), parentId: childId }))).rejects.toThrow("address_invalid");
  await expect(runInDurableObject(workspace(), (instance) => instance.applyScopeGrantDirectory({ ...envelope(2), payloadHash: `fnv1a64:${'0'.repeat(16)}` }))).rejects.toThrow("address_invalid");
});


it("preserves pending and inflight deliveries while upgrading the parent outbox", async () => {
  const probe = env.MIGRATION_PROBE_DO!.getByName("scope-grant-outbox-upgrade");
  await probe.ping();
  await runInDurableObject(probe, (_instance, state) => {
    const options = { storage: state.storage, component: "workstream_do", workerVersionId: "test" };
    applyDurableObjectSqliteMigrations({ ...options,
      migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 14) });
    for (const deliveryState of ["pending", "inflight"]) {
      state.storage.sql.exec(`INSERT INTO durable_outbox VALUES (?, 'old', 1, 1,
        'directory_user', '{}', 'hash', ?, 3, 100, 10)`, deliveryState, deliveryState);
    }
    const before = state.storage.sql.exec("SELECT * FROM durable_outbox ORDER BY message_id").toArray();
    applyDurableObjectSqliteMigrations({ ...options, migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS });
    expect(state.storage.sql.exec("SELECT * FROM durable_outbox ORDER BY message_id").toArray()).toEqual(before);
    state.storage.sql.exec(`INSERT INTO durable_outbox VALUES ('grant', 'new', 1, 1,
      'scope_grant_directory', '{}', 'hash', 'pending', 0, 100, 10)`);
    expect(state.storage.sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
  });
});


it("retains legacy grants without a current relationship without making them discoverable", async () => {
  const pending = envelope(1);
  if (pending.effect.kind !== "scope_grant_directory") throw new Error("expected grant effect");
  pending.effect.grant.membershipIncarnation = null;
  pending.payloadHash = conversationEffectHash(pending.effect);
  expect(await consumeEffectBodies(env, [pending])).toEqual({ acked: 1, retried: 0 });
  expect(await candidates()).toEqual([]);
  await workspace().applyScopeGrantDirectory(envelope(2));
  expect(await candidates()).toEqual([parentId]);
});
