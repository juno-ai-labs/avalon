import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { asWorkspaceId, asUserId } from "@rally/contracts";
import { ScopeGrantSchema } from "@rally/contracts/scope-grants";
import { ParentEffectEnvelopeSchema, conversationEffectHash } from "@rally/contracts/conversation-effects";
import { workspaceDOName } from "../src/durable-objects/names";
import { consumeEffectBodies } from "./helpers/conversation-effects";

const workspaceId = asWorkspaceId("00000000-0000-4000-8000-000000000081");
const parentId = "00000000-0000-4000-8000-000000000082";
const userId = asUserId("00000000-0000-4000-8000-000000000083");
const childId = "00000000-0000-4000-8000-000000000084";
const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", workspaceId));
const candidates = (membershipIncarnation = "first") => workspace().listScopeGrantCandidates({ workspaceId, userId, membershipIncarnation, accessClass: "guest" });
function envelope(version: number, active = true, incarnation = "first", generation = 1, parentKind: "canvas" | "workstream" = "canvas") {
  const grant = ScopeGrantSchema.parse({ id: "00000000-0000-4000-8000-000000000085", userId,
    target: { kind: "conversation", workspaceId, parentId, substreamId: childId },
    active, revision: version, membershipIncarnation: incarnation });
  const effect = { kind: "scope_grant_directory" as const, grant };
  return ParentEffectEnvelopeSchema.parse({ kind: "parent_effect", contractVersion: 1, region: "global", workspaceId,
    parentKind, parentId, generation, messageId: crypto.randomUUID(), partitionKey: `grant:${userId}:conversation:${childId}`,
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

it("refuses a directory grant from any parent but a Canvas by name, and applies nothing", async () => {
  // A Thread's grant still parses at the Queue boundary, so its refusal is
  // named here; only a Canvas grants a `workstream`-kind target now.
  await expect(runInDurableObject(workspace(), (instance) =>
    instance.applyScopeGrantDirectory(envelope(1, true, "first", 1, "workstream")))).rejects.toThrow("scope_grant_directory_effect_invalid");
  expect(await candidates()).toEqual([]);
  await workspace().applyScopeGrantDirectory(envelope(1));
  expect(await candidates()).toEqual([parentId]);
});
