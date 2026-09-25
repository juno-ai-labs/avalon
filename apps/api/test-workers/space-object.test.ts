/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Space on real workerd.
 *
 * A Space's parent is hosted by the Organization's `WorkspaceDO` under the
 * Space role, and every difference from a Channel is a field of that role
 * rather than a method (`docs/hosted-conversation-parents.md`). So what has to
 * be proved here is not that a Space behaves like a Channel (it runs the same
 * code) but the places where the role makes it behave differently, and the
 * one place where inheriting the Channel's behavior would be wrong. The legacy
 * `SpaceDO` survives only to export, and its migration identity is proved here
 * too because the tracker still rolls it up.
 *
 * All of these need the runtime: a migration ledger the legacy object applies
 * in its constructor, a WebSocket upgrade, a durable outbox row, and a
 * retirement tombstone on the Organization object.
 */
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  asSpaceId,
  asSubstreamId,
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

import { ParentEffectEnvelopeSchema } from "@rally/contracts/conversation-effects";
import { RALLY_HEADERS } from "@rally/contracts/http-headers";

import { latestMigrationVersion } from "../src/durable-objects/migration-reporting";
import { conversationObjectName, spaceDOName } from "../src/durable-objects/names";
import type { ScopeGrantStorage } from "../src/durable-objects/scope-grant-storage";
import { SpaceDO } from "../src/durable-objects/space-do";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSTREAM_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-do-schema";
import { consumeEffectBodies } from "./helpers/conversation-effects";
import { hostedParentStub, withHostedParent } from "./helpers/hosted-parent";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ce01");
const SPACE_ID = asSpaceId("00000000-0000-7000-8000-00000000ce02");
const CHANNEL_ID = asWorkstreamId("00000000-0000-7000-8000-00000000ce03");
const USER_ID = asUserId("00000000-0000-7000-8000-00000000ce04");
const ACTOR_ID = asUserId("00000000-0000-7000-8000-00000000ce05");

const spaceName = spaceDOName("global", WORKSPACE_ID, SPACE_ID);
/** The legacy Space object, which now only exports and reports its migration identity. */
const legacySpace = () => env.SPACE_DOS.getByName(spaceName);
/** The Organization object, which hosts both the Space's and the Channel's parent. */
const workspace = () => hostedParentStub(env, WORKSPACE_ID);

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

/**
 * The conversation object's identity store.
 *
 * Reached the same way, and for the same reason: what a conversation's
 * `parent_kind` says is the whole subject of the product-request case below,
 * and there is no public RPC that sets it without also provisioning a
 * work stream.
 */
interface ConversationInternals {
  objectStore: {
    ensureIdentity(
      identity: { workspaceId: string; parentKind: "workstream" | "automation" | "space"; parentId: string },
      region: string,
    ): void;
  };
}

function conversationInternals(instance: object): ConversationInternals {
  return instance as unknown as ConversationInternals;
}

/**
 * The identity row every effect and projection path reads its address from.
 * `parent_kind` is what makes the Organization object host this id under the
 * Space role or the Channel one.
 */
function seedIdentity(
  state: DurableObjectState,
  parentId: string,
  parentKind: "space" | "workstream",
  title: string,
): void {
  state.storage.sql.exec(
    `INSERT INTO parent_metadata
       (parent_id, parent_kind, workspace_id, region, authority_generation, title,
        description, preview, scope, exact_state, last_activity_at,
        created_at, updated_at)
     VALUES (?, ?, ?, 'global', 1, ?, '', '', 'workspace', 'idle', 1, 1, 1)`,
    parentId,
    parentKind,
    WORKSPACE_ID,
    title,
  );
  state.storage.sql.exec(
    `INSERT INTO parent_children
       (parent_id, substream_id, kind, created_by_user_id, created_at, status, updated_at)
     VALUES (?, '0', 'main', ?, 1, 'ready', 1)`,
    parentId,
    ACTOR_ID,
  );
}

/** Both parents, seeded into the one Organization object that hosts them. */
async function seedParents(): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    seedIdentity(state, SPACE_ID, "space", "Hiring");
    seedIdentity(state, CHANNEL_ID, "workstream", "Hiring");
  });
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

function outboxKinds(state: DurableObjectState, parentId: string): string[] {
  return state.storage.sql.exec<{ effect_kind: string }>(
    "SELECT effect_kind FROM parent_outbox WHERE parent_id = ? ORDER BY effect_kind",
    parentId,
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

/**
 * The same directory effect a Space publishes, addressed at the workspace.
 *
 * A fixed UUIDv7 rather than `crypto.randomUUID()`: the workspace handoff
 * refuses a directory effect whose message id is not one, and a v4 here would
 * be refused for the wrong reason.
 */
function spaceDirectoryEnvelope() {
  return ParentEffectEnvelopeSchema.parse({
    kind: "parent_effect",
    contractVersion: 1,
    region: "global",
    workspaceId: WORKSPACE_ID,
    parentKind: "space",
    parentId: SPACE_ID,
    generation: 1,
    messageId: "00000000-0000-7000-8000-00000000ce09",
    partitionKey: "common",
    sourceVersion: 1,
    requiredProjectionVersion: null,
    payloadHash: conversationEffectHash(DIRECTORY_EFFECT),
    effect: DIRECTORY_EFFECT,
  });
}

beforeEach(async () => {
  await reset();
  // The Organization object learns its placement from D1 on its first parent
  // request, as it does in production.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workspaces(id TEXT PRIMARY KEY, region TEXT DEFAULT 'global',
      placement_affinity TEXT DEFAULT 'wnam', analytics_workspace_id TEXT, abandoned_at TEXT)`),
    env.DB.prepare("INSERT INTO workspaces(id, region) VALUES (?, 'global')").bind(WORKSPACE_ID),
  ]);
});

describe("a Space's hosted parent", () => {
  it("applies its own migration component and answers a forced migration as a SpaceDO", async () => {
    const command = {
      commandId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      className: "SpaceDO",
      objectId: env.SPACE_DOS.idFromName(spaceName).toString(),
      objectName: spaceName,
      region: "global",
      requestedAt: Date.now(),
    };
    // A legacy Space that was never created still answers the tracker under
    // its own identity, and stays uncreated: applying the ledger would turn
    // the question into a stored object.
    expect(await legacySpace().forceMigration(command)).toMatchObject({
      className: "SpaceDO",
      component: "space_do",
      schemaVersion: 0,
    });

    // A deployed legacy Space: its ledger was applied under its own component
    // up to some earlier version. Rebuilt from that storage, the constructor
    // applies the rest under the same component. The role's migration
    // identity, not the class it extends: a plan that reported `workstream_do`
    // would file every Space's schema version under the Channel rollup, and
    // one that reported `WorkstreamDO` would make this object refuse the
    // command the tracker sends it. The *ledger* is the Channel's, which is
    // why the version is the Channel's head.
    const result = await runInDurableObject(legacySpace(), async (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSTREAM_DO_SCHEMA_MIGRATIONS.slice(0, 1),
        component: "space_do",
        workerVersionId: "test",
      });
      return new SpaceDO(state, env).forceMigration(command);
    });
    expect(result).toMatchObject({
      className: "SpaceDO",
      component: "space_do",
      schemaVersion: latestMigrationVersion(WORKSTREAM_DO_SCHEMA_MIGRATIONS),
    });

    await runInDurableObject(legacySpace(), (_instance, state) => {
      // Every version the Channel ledger holds, receipted under this object's
      // own component. A Space replays history it never had, because one
      // array applied twice is what keeps a table added for a Channel from
      // having to be written a second time for a Space.
      expect(state.storage.sql.exec<{ version: number }>(
        "SELECT version FROM _sql_schema_migrations ORDER BY version",
      ).toArray()).toEqual(WORKSTREAM_DO_SCHEMA_MIGRATIONS.map(({ version }) => ({ version })));
      for (const table of ["scope_grants", "conversation_children", "durable_outbox", "object_retirement"]) {
        expect(state.storage.sql.exec(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?", table,
        ).toArray()).toHaveLength(1);
      }
    });
  });

  it("refuses a client socket upgrade", async () => {
    await seedParents();
    const response = await workspace().fetch("https://workspace.test/parent-socket", {
      headers: { upgrade: "websocket", [RALLY_HEADERS.WORKSTREAM_ID]: SPACE_ID },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "space_socket_refused" });
    expect(response.webSocket).toBeNull();
  });

  it("commits a grant without publishing it to the shared scope-grant directory", async () => {
    await seedParents();
    let spaceResult: ScopeGrantMutationResult | null = null;
    await withHostedParent(workspace(), SPACE_ID, (parent, state) => {
      spaceResult = internals(parent)
        .scopeGrants({ workspaceId: WORKSPACE_ID, parentId: SPACE_ID })
        .mutate(grantMutation(SPACE_ID));
      // The grant itself commits. Only its discovery is suppressed: a Space is
      // found through the Organization's Space directory, and a row in the
      // shared work-stream grant directory would make its hidden conversation
      // reachable from a surface with no business listing it.
      expect(state.storage.sql.exec("SELECT user_id FROM parent_grants WHERE parent_id = ?", SPACE_ID).toArray())
        .toEqual([{ user_id: USER_ID }]);
      expect(outboxKinds(state, SPACE_ID)).toEqual([]);
    });
    expect(spaceResult).toMatchObject({ status: "committed" });

    // The same call on a Channel, so the absence above is the role's doing and
    // not a grant that failed to commit or a path that never runs.
    await withHostedParent(workspace(), CHANNEL_ID, (parent, state) => {
      internals(parent)
        .scopeGrants({ workspaceId: WORKSPACE_ID, parentId: CHANNEL_ID })
        .mutate(grantMutation(CHANNEL_ID));
      expect(outboxKinds(state, CHANNEL_ID)).toEqual(["scope_grant_directory"]);
    });
  });

  it("applies its directory effects to the Space directory and drops everything else", async () => {
    await seedParents();

    await workspace().receiveChildEffects({
      substreamId: "0",
      envelopes: [
        childEffect("space", SPACE_ID, DIRECTORY_EFFECT, 1),
        childEffect("space", SPACE_ID, ACTIVITY_EFFECT, 2),
      ],
    });

    await runInDurableObject(workspace(), (_instance, state) => {
      // The directory effect is what the Organization's Space directory is
      // built from, and is applied locally straight after the parent write.
      // The activity event has nowhere to go: no product surface opens a
      // Space's conversation, so a feed row for it would be an entry nobody
      // asked for that nothing can navigate to. It is dropped rather than
      // queued because anything that reaches this outbox is delivered.
      expect(outboxKinds(state, SPACE_ID)).toEqual([]);
      expect(state.storage.sql.exec("SELECT space_id, title FROM spaces").toArray())
        .toEqual([{ space_id: SPACE_ID, title: "Hiring" }]);
      // Still recorded by the parent: it aggregates its child's state whether
      // or not it republishes it.
      expect(state.storage.sql.exec(
        "SELECT substream_id FROM parent_child_projections WHERE parent_id = ?", SPACE_ID,
      ).toArray()).toEqual([{ substream_id: "0" }]);
    });

    // A Channel forwards both, which is what makes the list above a decision:
    // its directory row lands locally and its activity waits in the outbox
    // for the alarm that sends it to the activity Queue.
    await workspace().receiveChildEffects({
      substreamId: "0",
      envelopes: [
        childEffect("workstream", CHANNEL_ID, DIRECTORY_EFFECT, 1),
        childEffect("workstream", CHANNEL_ID, ACTIVITY_EFFECT, 2),
      ],
    });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(outboxKinds(state, CHANNEL_ID)).toEqual(["activity_event"]);
      expect(state.storage.sql.exec("SELECT workstream_id FROM channels").toArray())
        .toEqual([{ workstream_id: CHANNEL_ID }]);
    });
  });

  it("refuses a child effect stamped with another parent kind", async () => {
    await seedParents();
    // Asserted inside the object rather than across the RPC boundary: a
    // rejection returned over a stub is also reported to the harness as an
    // unhandled error in the object, which is noise rather than a finding.
    await expect(runInDurableObject(workspace(), (instance) => instance.receiveChildEffects({
      substreamId: "0",
      envelopes: [childEffect("workstream", SPACE_ID, DIRECTORY_EFFECT, 1)],
    }))).rejects.toThrow(/workstream_effect_parent_kind_mismatch/u);
  });

  it("lands its directory effect in the Space directory rather than the Channel one", async () => {
    await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");

    const envelope = spaceDirectoryEnvelope();
    // Accepted and acknowledged. Phase 1 refused this by name because
    // WorkspaceDO had nowhere to put it; migration 61 gave it somewhere, and
    // the routing by parent kind is what keeps a Space out of the Channel
    // sidebar now that both effects reach the same handoff.
    expect(await consumeEffectBodies(env, [envelope])).toEqual({ acked: 1, retried: 0 });
    expect(await workspace().runInspectionSql({
      sql: "SELECT workstream_id FROM channels",
      bindings: [],
    })).toMatchObject({ rows: [] });
    expect(await workspace().runInspectionSql({
      sql: "SELECT space_id, title, scope FROM spaces",
      bindings: [],
    })).toMatchObject({ rows: [{ space_id: SPACE_ID, title: "Hiring", scope: "workspace" }] });
  });

  it("refuses a Channel product request addressed at its hidden main conversation", async () => {
    const conversation = env.SUBSTREAM_AGENTS.getByName(
      conversationObjectName("global", WORKSPACE_ID, SPACE_ID, asSubstreamId("0")),
    );
    await runInDurableObject(conversation, (instance) => {
      // The identity a provisioned Space's conversation carries. Written
      // through the object's own store rather than as SQL, because `parent_kind`
      // is the whole subject of this case.
      conversationInternals(instance).objectStore.ensureIdentity({
        workspaceId: WORKSPACE_ID, parentKind: "space", parentId: SPACE_ID,
      }, "global");
    });
    const auth = {
      sessionId: `space-conversation-${USER_ID}`,
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      region: "global" as const,
      role: "member" as const,
    };
    // A member with a live session, so the refusal below is the parent kind
    // and not a caller the object would have turned away anyway.
    await env.DB.batch([
      env.DB.prepare(`CREATE TABLE sessions (
        id TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, region TEXT,
        revoked_at TEXT, expires_at TEXT, workspace_incarnation TEXT DEFAULT 'existing-member'
      )`),
      env.DB.prepare(`CREATE TABLE workspace_members (
        workspace_id TEXT, user_id TEXT, status TEXT, role TEXT,
        access_class TEXT, incarnation TEXT DEFAULT 'existing-member'
      )`),
      env.DB.prepare(`CREATE TABLE workstream_authority_control (
        id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
        required_serving_contract_version INTEGER NOT NULL,
        serving_contract_version INTEGER NOT NULL
      )`),
      env.DB.prepare(`INSERT INTO workstream_authority_control
        (id, phase, generation, required_serving_contract_version, serving_contract_version)
        VALUES (1, 'durable_object_open', 1, 1, 1)`),
      env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, status, role, access_class)
        VALUES (?, ?, 'active', 'member', 'member')`).bind(WORKSPACE_ID, USER_ID),
      env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
        .bind(auth.sessionId, USER_ID, WORKSPACE_ID),
    ]);

    // What `PATCH /workstreams/<spaceId> { archived: true }` becomes: the route
    // addresses a conversation by id, and every member is handed every Space id
    // on the workspace socket. Without the parent-kind gate this archives
    // General without `prepareSpaceArchive` and without `space_protected`.
    const refused = await conversation.handleProductRequest({
      operation: "update", auth, input: { archived: true },
    });
    expect(refused.status).toBe(404);
    expect(JSON.parse(refused.bodyJson)).toMatchObject({
      error: "conversation_parent_kind_mismatch",
    });
    // And the same request, stating the parent kind this object actually has,
    // is answered by the object rather than by the address gate — so what is
    // refused above is the address and not a caller or an object with nothing
    // to say. This fixture wrote the identity and never provisioned the
    // conversation, so the answer past the gate is the object's own readiness
    // refusal, by name.
    //
    // Asserted positively. `not.toMatchObject({ error: … })` here was
    // satisfied by any answer at all, a 500 included, which is exactly the
    // shape of assertion the audience defect of 2026-09-19 survived.
    const asSpace = await conversation.handleProductRequest({
      operation: "update", parentKind: "space", auth, input: { archived: true },
    });
    expect(asSpace.status).toBe(503);
    expect(JSON.parse(asSpace.bodyJson)).toMatchObject({
      error: "workstream_maintenance",
    });
  });

  it("answers as retired once its workspace is closed, through the Organization's gate", async () => {
    await seedParents();
    // A hosted Space has no tombstone of its own: it is retired with the
    // Organization object that holds it.
    await workspace().retireObject({
      retiredAt: Date.now(),
      operationId: crypto.randomUUID(),
      actorUserId: ACTOR_ID,
      reason: "demo_replaced",
    });
    // The gate classifies `fetch` as a dropped door rather than a refused one,
    // so a retired Space answers instead of throwing at its caller, on the
    // parent socket door as on every other.
    const response = await workspace().fetch("https://workspace.test/parent-socket", {
      headers: { upgrade: "websocket", [RALLY_HEADERS.WORKSTREAM_ID]: SPACE_ID },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "workspace_retired" });
  });
});
