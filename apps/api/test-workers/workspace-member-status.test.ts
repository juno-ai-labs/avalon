/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The Organization object's copy of each workspace relationship, on real
 * workerd (docs/hosted-conversation-parents.md, "Workspace relationships are
 * local").
 *
 * Access checks answer from `workspace_member_status`, so what matters is
 * which writer may replace a row: an event in D1's sequence order, or a
 * relationship a request has just read from or written to D1, which may only
 * replace a row it is provably newer than. And the relationship consumer
 * records a removal before it walks the revocation, so a walk that fails does
 * not leave the copy saying active.
 */
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { WorkspaceRelationship } from "@rally/contracts/scope-grants";

import { createTestEnv } from "../test/helpers/cloudflare-test";
import { applyWorkspaceRelationshipChange } from "../src/queues/access-revocation-consumer";
import { hostedParentStub } from "./helpers/hosted-parent";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000e00");
const OWNER_ID = asUserId("00000000-0000-7000-8000-000000000e01");
const SESSION_ID = "00000000-0000-7000-8000-000000000e02";
const GUEST_ID = asUserId("00000000-0000-7000-8000-000000000e03");

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: OWNER_ID, sessionId: SESSION_ID });
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}, 30_000);

function workspace() {
  return hostedParentStub(env, WORKSPACE_ID);
}

function guest(incarnation: string, revision: number, status: WorkspaceRelationship["status"] = "active"): WorkspaceRelationship {
  return { workspaceId: WORKSPACE_ID, userId: GUEST_ID, accessClass: "guest", role: null, status, incarnation, revision };
}

interface RelationshipTable {
  noteRelationship(relationship: WorkspaceRelationship): void;
  readRelationship(workspaceId: string, userId: string): Promise<WorkspaceRelationship | null>;
}

/** Note what a request read from D1, then answer the way every access check does. */
async function noteThenRead(relationship: WorkspaceRelationship | null): Promise<WorkspaceRelationship | null> {
  return runInDurableObject(workspace(), async (instance) => {
    const table = instance as unknown as RelationshipTable;
    if (relationship) table.noteRelationship(relationship);
    return table.readRelationship(WORKSPACE_ID, GUEST_ID);
  });
}

async function sequenceOf(): Promise<number> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ sequence: number }>(
    "SELECT sequence FROM workspace_member_status WHERE user_id = ?", GUEST_ID,
  ).one().sequence);
}

describe("a relationship a request read from D1", () => {
  it("replaces a removed row with a new incarnation, and never brings the removed one back", async () => {
    expect(await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 1, removed: false, relationship: guest("first", 1),
    })).toEqual({ applied: true });
    expect(await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 2, removed: true, relationship: guest("first", 2),
    })).toEqual({ applied: true });
    expect(await noteThenRead(null)).toBeNull();

    // A read that raced the removal still holds the removed incarnation.
    expect(await noteThenRead(guest("first", 1))).toBeNull();

    // Invited again: D1 created a new incarnation, and the request that
    // created it is answered by it at once rather than after the next event.
    expect(await noteThenRead(guest("second", 1))).toEqual(guest("second", 1));
    // The sequence is the removal's, so the new incarnation's own event applies.
    expect(await sequenceOf()).toBe(2);
    expect(await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 3, removed: false, relationship: guest("second", 1),
    })).toEqual({ applied: true });
  });

  it("replaces a row of its own incarnation only at a higher revision, and an older event does not move it back", async () => {
    await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 10, removed: false, relationship: guest("first", 2),
    });
    // An older revision, and a live row of another incarnation, cannot be
    // ordered as newer: the event's answer stands.
    expect(await noteThenRead(guest("first", 1, "suspended"))).toEqual(guest("first", 2));
    expect(await noteThenRead(guest("other", 5))).toEqual(guest("first", 2));

    expect(await noteThenRead(guest("first", 4, "suspended"))).toEqual(guest("first", 4, "suspended"));
    expect(await sequenceOf()).toBe(10);

    // The event for revision 3 is still on its way; it takes its place in the
    // order without moving the answer back to active.
    expect(await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 11, removed: false, relationship: guest("first", 3),
    })).toEqual({ applied: true });
    expect(await noteThenRead(null)).toEqual(guest("first", 4, "suspended"));
    expect(await sequenceOf()).toBe(11);
  });
});

describe("the relationship consumer", () => {
  it("records a removal in the Organization's table even when the revocation walk fails", async () => {
    await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID, sequence: 20, removed: false, relationship: guest("first", 1),
    });
    // Every call into the Organization object answers as usual except the
    // revocation's own hop, which fails the way an unavailable hop does.
    const failingEnv = {
      ...env,
      WORKSPACE_DOS: createTestEnv({ WORKSPACE_DOS: new Proxy(env.WORKSPACE_DOS, {
        get(namespace, property) {
          if (property === "get") {
            return (id: DurableObjectId, options?: DurableObjectNamespaceGetDurableObjectOptions) => new Proxy(
              namespace.get(id, options), {
                get: (stub, method) => method === "revokeSocketAccess"
                  ? () => Promise.reject(new Error("revocation_hop_failed_by_test"))
                  : Reflect.get(stub, method),
              });
          }
          const value: unknown = Reflect.get(namespace, property);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(namespace) : value;
        },
      }) }).WORKSPACE_DOS,
    };

    const failure = await applyWorkspaceRelationshipChange(failingEnv, {
      kind: "workspace_relationship_changed", sequence: 21, removed: true, relationship: guest("first", 2),
    }).then(() => null, (error: unknown) => error);
    expect(String(failure)).toContain("revocation_hop_failed_by_test");

    // The message will retry, but every check made meanwhile refuses them.
    expect(await noteThenRead(null)).toBeNull();
    expect(await sequenceOf()).toBe(21);
  });
});
