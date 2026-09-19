/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Space on real workerd.
 *
 * `SpaceDO` is `WorkstreamDO` under a role, and every difference between them
 * is a field of that role rather than a method. So what has to be proved here
 * is not that a Space behaves like a Channel — it runs the same code — but the
 * four places where the role makes it behave differently, and the one place
 * where inheriting the Channel's behavior would be wrong.
 *
 * All four need the runtime: a migration ledger the object applies in its
 * constructor, a WebSocket upgrade, a durable outbox row, and a retirement
 * tombstone that survives the object being rebuilt from storage.
 */
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  asSpaceId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
} from "@rally/contracts";
import {
  ConversationEffectEnvelopeSchema,
  conversationEffectHash,
  type ConversationEffect,
  type ConversationEffectEnvelope,
} from "@rally/contracts/conversation-effects";
import type { ScopeGrantMutation, ScopeGrantMutationResult } from "@rally/contracts/scope-grants";

import { spaceDOName, workstreamDOName } from "../src/durable-objects/names";
import type { ScopeGrantStorage } from "../src/durable-objects/scope-grant-storage";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ce01");
const SPACE_ID = asSpaceId("00000000-0000-7000-8000-00000000ce02");
const CHANNEL_ID = asWorkstreamId("00000000-0000-7000-8000-00000000ce03");
const USER_ID = asUserId("00000000-0000-7000-8000-00000000ce04");
const ACTOR_ID = asUserId("00000000-0000-7000-8000-00000000ce05");

const spaceName = spaceDOName("global", WORKSPACE_ID, SPACE_ID);
const channelName = workstreamDOName("global", WORKSPACE_ID, CHANNEL_ID);
const space = () => env.SPACE_DOS.getByName(spaceName);
const channel = () => env.WORKSTREAM_DOS.getByName(channelName);

/**
 * The private seam these tests reach through, the way the other object suites
 * do: the grant store is built by the object, and *which writer it is built
 * with* is the whole difference the role makes here.
 */
interface ParentInternals {
  scopeGrants(address: { workspaceId: string; parentId: string }): ScopeGrantStorage;
}

function internals(instance: object): ParentInternals {
  return instance as unknown as ParentInternals;
}

/** The identity row every effect and projection path reads its address from. */
function seedIdentity(state: DurableObjectState, parentId: string, title: string): void {
  state.storage.sql.exec(
    `INSERT INTO workstream_metadata
       (id, workspace_id, workstream_id, region, authority_generation, title,
        description, preview, scope, exact_state, last_activity_at,
        created_at, updated_at)
     VALUES (1, ?, ?, 'global', 1, ?, '', '', 'workspace', 'idle', 1, 1, 1)`,
    WORKSPACE_ID,
    parentId,
    title,
  );
  state.storage.sql.exec(
    `INSERT INTO conversation_children
       (substream_id, kind, created_by_user_id, created_at, status, updated_at)
     VALUES ('0', 'main', ?, 1, 'ready', 1)`,
    ACTOR_ID,
  );
}

function grantMutation(parentId: string): ScopeGrantMutation {
  return {
    operationId: parentId === SPACE_ID
      ? "00000000-0000-7000-8000-00000000ce07"
      : "00000000-0000-7000-8000-00000000ce08",
    actorUserId: ACTOR_ID,
    userId: USER_ID,
    target: { kind: "workstream", workspaceId: WORKSPACE_ID, parentId },
    active: true,
    expectedRevision: 0,
  } as ScopeGrantMutation;
}

function outboxKinds(state: DurableObjectState): string[] {
  return state.storage.sql.exec<{ effect_kind: string }>(
    "SELECT effect_kind FROM durable_outbox ORDER BY effect_kind",
  ).toArray().map((row) => row.effect_kind);
}

function childEffect(
  parentKind: "space" | "workstream",
  parentId: string,
  effect: ConversationEffect,
  sourceVersion: number,
): ConversationEffectEnvelope {
  return ConversationEffectEnvelopeSchema.parse({
    kind: "conversation_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind,
    parentId,
    substreamId: "0",
    generation: 1,
    messageId: crypto.randomUUID(),
    partitionKey: `${effect.kind}:0`,
    sourceVersion,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(effect),
    effect,
  });
}

const DIRECTORY_EFFECT: ConversationEffect = {
  kind: "directory_common",
  title: "Hiring",
  description: "",
  preview: "",
  scope: "workspace",
  state: "idle",
  systemKind: null,
  lastActivityAt: "2026-09-19T00:00:00.000Z",
  completedAt: null,
  archivedAt: null,
};

const ACTIVITY_EFFECT: ConversationEffect = {
  kind: "activity_event",
  eventId: "00000000-0000-7000-8000-00000000ce06",
  eventType: "message_created",
  subjectSequenceNumber: null,
  actorType: "user",
  actorUserId: ACTOR_ID,
  actorLabel: "Someone",
  title: "Said something",
  body: "",
  canonicalUrl: null,
  digestible: true,
  occurredAt: "2026-09-19T00:00:00.000Z",
  sourceKind: "conversation",
  sourceId: null,
  dedupeKey: "space-activity-1",
  metadata: {},
  targets: [],
};

beforeEach(async () => {
  await reset();
});

describe("a Space's Durable Object", () => {
  it("applies its own migration component and answers a forced migration as a SpaceDO", async () => {
    const result = await space().forceMigration({
      commandId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      className: "SpaceDO",
      objectId: env.SPACE_DOS.idFromName(spaceName).toString(),
      objectName: spaceName,
      region: "global",
      requestedAt: Date.now(),
    });
    // The role's migration identity, not the class it extends. A plan that
    // reported `workstream_do` would file every Space's schema version under
    // the Channel rollup, and one that reported `WorkstreamDO` would make this
    // object refuse the command the tracker sends it.
    expect(result).toMatchObject({ className: "SpaceDO", component: "space_do", schemaVersion: 1 });

    await runInDurableObject(space(), (_instance, state) => {
      // One version, and the whole shape: the ledger renders what the Channel
      // ledger's seventeen versions end at, so an inherited method never meets
      // a missing table.
      expect(state.storage.sql.exec<{ version: number }>(
        "SELECT version FROM _sql_schema_migrations ORDER BY version",
      ).toArray()).toEqual([{ version: 1 }]);
      for (const table of ["scope_grants", "conversation_children", "durable_outbox", "object_retirement"]) {
        expect(state.storage.sql.exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?", table,
        ).toArray()).toHaveLength(1);
      }
    });
  });

  it("refuses a client socket upgrade", async () => {
    const response = await space().fetch("https://space.test/socket", {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "space_socket_refused" });
    expect(response.webSocket).toBeNull();
  });

  it("commits a grant without publishing it to the shared scope-grant directory", async () => {
    let spaceResult: ScopeGrantMutationResult | null = null;
    await runInDurableObject(space(), (instance, state) => {
      seedIdentity(state, SPACE_ID, "Hiring");
      spaceResult = internals(instance)
        .scopeGrants({ workspaceId: WORKSPACE_ID, parentId: SPACE_ID })
        .mutate(grantMutation(SPACE_ID));
      // The grant itself commits. Only its discovery is suppressed: a Space is
      // found through the Organization's Space directory, and a row in the
      // shared work-stream grant directory would make its hidden conversation
      // reachable from a surface with no business listing it.
      expect(state.storage.sql.exec("SELECT user_id FROM scope_grants").toArray())
        .toEqual([{ user_id: USER_ID }]);
      expect(outboxKinds(state)).toEqual([]);
    });
    expect(spaceResult).toMatchObject({ status: "committed" });

    // The same call on a Channel, so the absence above is the role's doing and
    // not a grant that failed to commit or a path that never runs.
    await runInDurableObject(channel(), (instance, state) => {
      seedIdentity(state, CHANNEL_ID, "Hiring");
      internals(instance)
        .scopeGrants({ workspaceId: WORKSPACE_ID, parentId: CHANNEL_ID })
        .mutate(grantMutation(CHANNEL_ID));
      expect(outboxKinds(state)).toEqual(["scope_grant_directory"]);
    });
  });

  it("forwards its directory effects to the workspace and drops everything else", async () => {
    await runInDurableObject(space(), (_instance, state) => seedIdentity(state, SPACE_ID, "Hiring"));

    await space().receiveChildEffects({
      substreamId: "0",
      envelopes: [
        childEffect("space", SPACE_ID, DIRECTORY_EFFECT, 1),
        childEffect("space", SPACE_ID, ACTIVITY_EFFECT, 2),
      ],
    });

    await runInDurableObject(space(), (_instance, state) => {
      // The directory effect is what the Organization's Space directory is
      // built from and has to leave. The activity event has nowhere to go: no
      // product surface opens a Space's conversation, so a feed row for it
      // would be an entry nobody asked for that nothing can navigate to. It is
      // dropped here because anything that reaches this outbox is delivered.
      expect(outboxKinds(state)).toEqual(["directory_common"]);
      // Still recorded locally: the parent aggregates its child's state whether
      // or not it republishes it.
      expect(state.storage.sql.exec("SELECT substream_id FROM substream_directory").toArray())
        .toEqual([{ substream_id: "0" }]);
    });

    // A Channel forwards both, which is what makes the list above a decision.
    await runInDurableObject(channel(), (_instance, state) => seedIdentity(state, CHANNEL_ID, "Hiring"));
    await channel().receiveChildEffects({
      substreamId: "0",
      envelopes: [
        childEffect("workstream", CHANNEL_ID, DIRECTORY_EFFECT, 1),
        childEffect("workstream", CHANNEL_ID, ACTIVITY_EFFECT, 2),
      ],
    });
    await runInDurableObject(channel(), (_instance, state) => {
      expect(outboxKinds(state)).toEqual(["activity_event", "directory_common"]);
    });
  });

  it("refuses a child effect stamped with another parent kind", async () => {
    await runInDurableObject(space(), (_instance, state) => seedIdentity(state, SPACE_ID, "Hiring"));
    // Asserted inside the object rather than across the RPC boundary: a
    // rejection returned over a stub is also reported to the harness as an
    // unhandled error in the object, which is noise rather than a finding.
    await expect(runInDurableObject(space(), (instance) => instance.receiveChildEffects({
      substreamId: "0",
      envelopes: [childEffect("workstream", SPACE_ID, DIRECTORY_EFFECT, 1)],
    }))).rejects.toThrow(/workstream_effect_parent_kind_mismatch/u);
  });

  it("answers as retired once its workspace is closed, through the inherited gate", async () => {
    await space().retireObject({
      retiredAt: Date.now(),
      operationId: crypto.randomUUID(),
      actorUserId: ACTOR_ID,
      reason: "demo_replaced",
    });
    // The gate classifies `fetch` as a dropped door rather than a refused one,
    // so a retired Space answers instead of throwing at its caller. A subclass
    // is where that is easiest to lose: every method it is gated on is one it
    // inherits.
    const response = await space().fetch("https://space.test/socket", {
      headers: { upgrade: "websocket" },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "workspace_retired" });
  });
});
