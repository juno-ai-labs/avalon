/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * External conversation bindings against the objects that hold them.
 *
 * A binding is only worth what its transactions are: a room's binding and its
 * Space commit together or not at all, a thread's pending binding commits with
 * its Channel's birth and placement, and a run's outbound binding commits with
 * the tool receipt of the send that opened its thread. Each of those is a
 * `transactionSync` over real Durable Object storage, and two of them cross
 * objects (the coordinator between D1 and WorkspaceDO; a run child's outbox
 * into WorkspaceDO), so they are proved here on workerd rather than over a
 * Node double. Slack itself is not in this file: the service's provider calls
 * are covered in the Node suite, and what the adapter decides is covered in
 * the connectors package.
 */

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  asSpaceId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  WorkspaceExternalEventMatchResultSchema,
  type SpaceId,
  type UserId,
} from "@rally/contracts";
import { writeSidekickDirectoryRow } from "./helpers/sidekick";

import type { AuthContext, Env } from "../src/env";
import { conversationObjectName, substreamLoopId, workspaceDOName } from "../src/durable-objects/names";
import { SubstreamLoopStorage } from "../src/durable-objects/substream-loop-storage";
import { externalBindingReplyAdmission } from "../src/services/slack-agent-service";
import { admitExternalWorkstreamMessage } from "../src/services/workstream-service";
import {
  bootstrapConversationChildRuntime,
  provisionWorkstreamObject,
} from "../src/services/workstream-runtime-database";
import {
  ExternalBindingResolutionSchema,
  type ExternalBindingClaim,
} from "../src/durable-objects/workspace-external-binding-protocol";
import {
  EXTERNAL_BINDING_OUTBOX_CHANNEL,
  drainExternalBindingOutbox,
  enqueueExternalBindingInTransaction,
} from "../src/durable-objects/external-binding-outbox";
import { SlackWorkspaceWorkstreamService } from "../src/services/slack-workspace-workstream-service";
import { SpaceService } from "../src/services/space-service";
import { WorkstreamEmailRoutingService } from "../src/services/workstream-email-routing-service";
import { WorkstreamObjectCreationService } from "../src/services/workstream-object-creation-service";
import {
  WORKSPACE_ID as RUN_WORKSPACE_ID,
  WORKSTREAM_ID as SIDEKICK_ID,
  boot,
  holdLoopExecuting,
  post,
  seedWorkspaceControlPlane,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ec0");
const USER_ID = asUserId("00000000-0000-7000-8000-000000000ec1");
const OTHER_USER_ID = asUserId("00000000-0000-7000-8000-000000000ec3");
const SESSION_ID = "00000000-0000-7000-8000-000000000ec2";
const INSTALLATION = "slack:T1";
const SIDEKICK = "00000000-0000-7000-8000-000000000ec5";
const RUN = "00000000-0000-7000-8000-000000000ec6";

const AUTH: AuthContext = {
  sessionId: SESSION_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "member",
};

function workspace(workspaceId: string = WORKSPACE_ID) {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", asWorkspaceId(workspaceId))));
}

/** The address allocator needs a key; it is configuration, not behaviour. */
function creationEnv(): Env {
  return new Proxy(env, {
    get: (current, property, receiver) => property === "WORKSTREAM_EMAIL_ADDRESS_KEY"
      ? "workerd-test-email-address-key-0123456789"
      : Reflect.get(current, property, receiver),
  });
}

const at = () => new Date().toISOString();
/** A claim no attempt has abandoned: its stale horizon is long past. */
const LIVE = "2000-01-01T00:00:00.000Z";

async function resolve(path: string[], input: { addressed?: boolean; claimKey?: string | null; staleBefore?: string } = {}) {
  return ExternalBindingResolutionSchema.parse(await workspace().resolveExternalConversation({
    workspaceId: WORKSPACE_ID,
    installationId: INSTALLATION,
    path,
    addressed: input.addressed ?? false,
    claimKey: input.claimKey ?? null,
    pendingStaleBefore: input.staleBefore ?? LIVE,
  }));
}

async function linkRoom(roomId: string, spaceId: string, input: {
  userId?: UserId;
  spaceMatch?: "matched" | "unmatched";
  name?: string;
} = {}) {
  return workspace().linkExternalRoom({
    workspaceId: WORKSPACE_ID,
    installationId: INSTALLATION,
    path: [roomId],
    userId: input.userId ?? USER_ID,
    spaceId,
    space: { name: input.name ?? `room ${roomId}` },
    ...(input.spaceMatch ? { spaceMatch: input.spaceMatch } : {}),
    at: at(),
  });
}

function claim(path: string[], claimKey: string): ExternalBindingClaim {
  return { installationId: INSTALLATION, path, claimKey, pendingStaleBefore: LIVE };
}

/** A Channel created by a linked member, for a thread, through the coordinator. */
async function createForThread(clientMessageId: string, spaceId: SpaceId, path: string[]) {
  return new WorkstreamObjectCreationService(creationEnv(), AUTH).createPrepared({
    title: `Thread ${clientMessageId}`,
    clientMessageId,
    participantUserIds: [],
    spaceIds: [spaceId],
  }, { messages: [{ role: "user", text: "A thread addressed to Rally" }] }, {
    externalBinding: claim(path, `event:${clientMessageId}`),
  });
}

/**
 * A person closing a run's binding. No surface does this yet; the state and
 * its reason exist, so the tests that must tell it apart from a disconnect
 * write it directly.
 */
async function closeRunBindings(runId: string) {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(
      `UPDATE external_conversation_bindings SET state = 'suspended', suspended_reason = 'closed'
        WHERE parent_kind = 'automation' AND substream_id = ?`,
      runId,
    );
  });
}

async function bindingRows() {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
    path_json: string; target_kind: string; parent_id: string | null; state: string;
  }>(
    "SELECT path_json, target_kind, parent_id, state FROM external_conversation_bindings ORDER BY path_json",
  ).toArray());
}

async function spaceIds(): Promise<string[]> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ space_id: string }>(
    "SELECT space_id FROM spaces WHERE system_role IS NULL ORDER BY space_id",
  ).toArray().map((row) => row.space_id));
}

beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: USER_ID, sessionId: SESSION_ID });
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT, verified_at TEXT,
      activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, object_name), UNIQUE (workstream_id, generation)
    )`),
    env.DB.prepare(`CREATE TABLE workstream_email_routes (
      email_address TEXT PRIMARY KEY COLLATE NOCASE, address_source TEXT NOT NULL,
      region TEXT NOT NULL, workspace_id TEXT NOT NULL, workstream_id TEXT,
      automation_subscription_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (region, workspace_id, workstream_id)
    )`),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-18T20:00:00.000Z')`).bind(WORKSPACE_ID, OTHER_USER_ID),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'other@example.com', 'Other', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`).bind(OTHER_USER_ID),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  // General first, which also opens the Space authority for writes.
  await new SpaceService(creationEnv(), AUTH).ensureGeneral();
}, 30_000);

describe("linking a shared room", () => {
  it("makes one Space when an invitation and a first mention race, and a redelivery changes nothing", async () => {
    // Two callers minted two creation identities; the binding decided inside
    // the reservation's transaction is what keeps the second from becoming a
    // second Space.
    const [first, second] = await Promise.all([
      linkRoom("C1", "00000000-0000-7000-8000-000000000e01"),
      linkRoom("C1", "00000000-0000-7000-8000-000000000e02"),
    ]);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.spaceId).toBe(second.spaceId);
    expect([first.outcome, second.outcome].sort()).toEqual(["existing", "linked"]);
    expect(await spaceIds()).toEqual([first.spaceId]);

    const replay = await linkRoom("C1", "00000000-0000-7000-8000-000000000e03");
    expect(replay).toEqual({ ok: true, outcome: "existing", spaceId: first.spaceId });
    expect(await spaceIds()).toEqual([first.spaceId]);
    expect(await bindingRows()).toEqual([
      { path_json: "[\"C1\"]", target_kind: "space", parent_id: null, state: "active" },
    ]);
  });

  it("gives a private room and a public room alike an Organization-wide Space that lists only its linker", async () => {
    const privateRoom = await linkRoom("G1", "00000000-0000-7000-8000-000000000e11");
    const publicRoom = await linkRoom("C1", "00000000-0000-7000-8000-000000000e12");
    if (!privateRoom.ok || !publicRoom.ok) throw new Error("link refused");
    for (const spaceId of [privateRoom.spaceId, publicRoom.spaceId]) {
      // Read by somebody who did not link the room: an Organization-wide
      // Space is theirs to see.
      const summary = await workspace().spaceSummary({
        workspaceId: WORKSPACE_ID, userId: OTHER_USER_ID, spaceId: asSpaceId(spaceId),
      });
      expect(summary).toMatchObject({ ok: true, space: { scope: "workspace", participants: [{ userId: USER_ID }] } });
      if (summary.ok) expect(summary.space.participants).toHaveLength(1);
    }
  });

  it("stops every thread when the bot is removed, and re-invitation reactivates the same binding and Space", async () => {
    const linked = await linkRoom("C1", "00000000-0000-7000-8000-000000000e21");
    if (!linked.ok) throw new Error("link refused");
    const created = await createForThread("removed", asSpaceId(linked.spaceId), ["C1", "1.0"]);
    expect(await resolve(["C1", "1.0"])).toMatchObject({ outcome: "deliver" });

    await workspace().suspendExternalConversationBindings({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path: ["C1"],
      reason: "provider_membership_ended", at: at(),
    });
    // The thread's own row is untouched and still active; its room stops it.
    expect(await resolve(["C1", "1.0"])).toEqual({
      outcome: "suspended", path: ["C1"], reason: "provider_membership_ended",
    });
    expect(await resolve(["C1", "2.0"], { addressed: true, claimKey: "event:new" })).toMatchObject({ outcome: "suspended" });

    const invited = await linkRoom("C1", "00000000-0000-7000-8000-000000000e22");
    expect(invited).toEqual({ ok: true, outcome: "reactivated", spaceId: linked.spaceId });
    expect(await resolve(["C1", "1.0"])).toEqual({
      outcome: "deliver",
      target: { kind: "conversation", parentKind: "workstream", parentId: created.workstream.id, substreamId: "0" },
    });
    expect(await spaceIds()).toEqual([linked.spaceId]);
  });
});

describe("a room named for an existing Space", () => {
  const match = async (name: string) => (await workspace().externalRoomSpaceMatch({ workspaceId: WORKSPACE_ID, name })).spaceId;
  const generalId = () => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ space_id: string }>(
    "SELECT space_id FROM spaces WHERE system_role = 'general'",
  ).one().space_id);

  it("matches the live Organization-wide Space of that name ignoring case, and links the room into it", async () => {
    const general = await generalId();
    const archived = await linkRoom("C2", "00000000-0000-7000-8000-000000000e32");
    if (!archived.ok) throw new Error("link refused");
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE spaces SET archived_at = 1 WHERE space_id = ?", archived.spaceId);
    });

    expect(await match("  gEnErAl ")).toBe(general);
    expect(await match("ROOM C2")).toBeNull();
    expect(await match("generals")).toBeNull();

    const linked = await linkRoom("C1", general, { spaceMatch: "matched", name: "general" });
    expect(linked).toEqual({ ok: true, outcome: "linked", spaceId: general });
    expect(await spaceIds()).toEqual([archived.spaceId]);
    expect(await resolve(["C1", "1.0"], { addressed: true, claimKey: "event:general" }))
      .toMatchObject({ outcome: "spawn", spaceId: general, spaceMatched: true });
    // The record survives Slack renumbering the room, which the id could not.
    await workspace().moveExternalConversationBindings({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, from: ["C1"], to: ["C9"], at: at(),
    });
    expect(await resolve(["C9", "1.0"], { addressed: true, claimKey: "event:moved" }))
      .toMatchObject({ outcome: "spawn", spaceId: general, spaceMatched: true });
    // A room's own Space is recorded as its own.
    const own = await linkRoom("C5", "00000000-0000-7000-8000-000000000e39", { spaceMatch: "unmatched", name: "launch" });
    if (!own.ok) throw new Error("link refused");
    expect(await resolve(["C5", "1.0"], { addressed: true, claimKey: "event:own" }))
      .toMatchObject({ outcome: "spawn", spaceId: own.spaceId, spaceMatched: false });
  });

  it("ignores spaces, dashes and underscores in a room's name, so `#room-c3`, `#room_c3` and `#roomc3` match \"room C3\"", async () => {
    const spaced = await linkRoom("C3", "00000000-0000-7000-8000-000000000e33");
    if (!spaced.ok) throw new Error("link refused");
    expect(await match("ROOM-C3")).toBe(spaced.spaceId);
    expect(await match("room--c3")).toBe(spaced.spaceId);
    expect(await match("roomc3")).toBe(spaced.spaceId);
    expect(await match("room_c3")).toBe(spaced.spaceId);
    expect(await match("room.c3")).toBeNull();
    // A name that is only separators matches nothing, not every such Space.
    const dashes = await linkRoom("C4", "00000000-0000-7000-8000-000000000e34", { name: "-" });
    if (!dashes.ok) throw new Error("link refused");
    expect(await match("--")).toBeNull();
  });

  it("does not offer a Space whose creator is no longer a member, so the room gets its own", async () => {
    const general = await generalId();
    expect(await match("general")).toBe(general);
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE spaces SET created_by_user_id = '00000000-0000-7000-8000-000000000ec9' WHERE space_id = ?", general,
      );
    });
    expect(await match("general")).toBeNull();
  });

  it("joins a Space that started matching after the caller's ask, rather than making a second one", async () => {
    const general = await generalId();
    // The caller asked while nothing matched and minted the room's own id.
    const linked = await linkRoom("C1", "00000000-0000-7000-8000-000000000e35", { spaceMatch: "unmatched", name: "general" });
    expect(linked).toEqual({ ok: true, outcome: "linked", spaceId: general });
    expect(await spaceIds()).toEqual([]);
    // Without a match, the room's own id is used.
    const own = await linkRoom("C2", "00000000-0000-7000-8000-000000000e36", { spaceMatch: "unmatched", name: "launch" });
    expect(own).toEqual({ ok: true, outcome: "linked", spaceId: "00000000-0000-7000-8000-000000000e36" });
  });

  it("refuses the link when the matched Space's creator leaves while the link is in flight", async () => {
    const general = await generalId();
    const result = await runInDurableObject(workspace(), async (instance) => {
      const target = instance as unknown as { spaceParentReservation: (spaceId: string) => Promise<unknown> };
      const original = target.spaceParentReservation.bind(instance);
      // The creator check has passed by now; the creator leaves before the commit.
      vi.spyOn(target, "spaceParentReservation").mockImplementation(async (spaceId: string) => {
        const state = (instance as unknown as { state: DurableObjectState }).state;
        state.storage.sql.exec("UPDATE workspace_member_status SET relationship_json = NULL WHERE user_id = ?", USER_ID);
        return original(spaceId);
      });
      return instance.linkExternalRoom({
        workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path: ["C1"], userId: USER_ID, spaceId: general,
        space: { name: "general" }, spaceMatch: "matched", at: at(),
      });
    });
    expect(result).toEqual({ ok: false, code: "space_not_found" });
    expect(await bindingRows()).toEqual([]);
  });

  it("refuses to link a room into a matched Space that was renamed, made private or archived before the link", async () => {
    const general = await generalId();
    const edits = [
      "UPDATE spaces SET title = 'Everyone' WHERE space_id = ?",
      "UPDATE spaces SET title = 'General', scope = 'personal' WHERE space_id = ?",
      "UPDATE spaces SET scope = 'workspace', archived_at = 1 WHERE space_id = ?",
    ];
    for (const edit of edits) {
      await runInDurableObject(workspace(), (_instance, state) => {
        state.storage.sql.exec(edit, general);
      });
      expect(await linkRoom("C1", general, { spaceMatch: "matched", name: "general" })).toEqual({ ok: false, code: "space_not_found" });
    }
    expect(await bindingRows()).toEqual([]);
  });
});

describe("a thread addressed under a linked room", () => {
  it("becomes one Channel per thread in the room's Space; an unrelated message creates nothing", async () => {
    const linked = await linkRoom("C1", "00000000-0000-7000-8000-000000000e31");
    if (!linked.ok) throw new Error("link refused");
    const spaceId = asSpaceId(linked.spaceId);
    expect(await resolve(["C1", "1.0"], { addressed: true, claimKey: "event:one" }))
      .toMatchObject({ outcome: "spawn", spaceId, roomPath: ["C1"], space: { scope: "workspace", createdByUserId: USER_ID } });

    const one = await createForThread("one", spaceId, ["C1", "1.0"]);
    const two = await createForThread("two", spaceId, ["C1", "2.0"]);
    expect(one.workstream.id).not.toBe(two.workstream.id);
    for (const [path, created] of [[["C1", "1.0"], one], [["C1", "2.0"], two]] as const) {
      expect(await resolve([...path])).toEqual({
        outcome: "deliver",
        target: { kind: "conversation", parentKind: "workstream", parentId: created.workstream.id, substreamId: "0" },
      });
      // Placed in the room's Space, not General.
      expect(await workspace().channelSpaces({
        workspaceId: WORKSPACE_ID, userId: USER_ID, workstreamId: asWorkstreamId(created.workstream.id),
      })).toEqual({ spaceIds: [spaceId] });
    }
    // A second tag in a bound thread continues it rather than spawning.
    expect(await resolve(["C1", "1.0"], { addressed: true, claimKey: "event:again" })).toMatchObject({ outcome: "deliver" });
    // An untagged message in a thread nobody addressed resolves to nothing.
    expect(await resolve(["C1", "3.0"])).toEqual({ outcome: "none", roomBound: true });
  });

  it("holds a second event behind a pending binding, and lets the attempt that claimed it resume", async () => {
    const linked = await linkRoom("C1", "00000000-0000-7000-8000-000000000e41");
    if (!linked.ok) throw new Error("link refused");
    const reserved = await workspace().reserveChannelInSpaces({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      workstreamId: asWorkstreamId("00000000-0000-7000-8000-000000000e42"),
      spaceIds: [asSpaceId(linked.spaceId)],
      requestedScope: "workspace",
      requestedParticipantUserIds: [],
      authorityGeneration: 1,
      directory: { title: "Pending", description: "", emailAddress: null, titleStatus: "settled", createdAt: at() },
      externalBinding: claim(["C1", "1.0"], "event:first"),
    });
    expect(reserved.status).toBe("reserved");
    expect(await resolve(["C1", "1.0"], { addressed: true, claimKey: "event:second" })).toEqual({ outcome: "hold" });
    expect(await resolve(["C1", "1.0"])).toEqual({ outcome: "hold" });
    // The claiming attempt's own retry resumes; so does anyone once the claim
    // is older than the creation fence the caller runs under.
    expect(await resolve(["C1", "1.0"], { addressed: true, claimKey: "event:first" })).toMatchObject({ outcome: "spawn" });
    expect(await resolve(["C1", "1.0"], {
      addressed: true, claimKey: "event:third", staleBefore: new Date(Date.now() + 60_000).toISOString(),
    })).toMatchObject({ outcome: "spawn" });
  });

  it("removes its pending binding when the creation fails after the claim", async () => {
    const linked = await linkRoom("C1", "00000000-0000-7000-8000-000000000e51");
    if (!linked.ok) throw new Error("link refused");
    // The step after the reservation fails: the regional route cannot be
    // written, which is how D1 refuses the anchor batch.
    await env.DB.prepare("ALTER TABLE workstream_authority_routes RENAME TO routes_offline").run();
    const failure = await createForThread("fails", asSpaceId(linked.spaceId), ["C1", "1.0"])
      .then(() => null, (error: unknown) => error);
    await env.DB.prepare("ALTER TABLE routes_offline RENAME TO workstream_authority_routes").run();
    expect(failure).toBeInstanceOf(Error);
    // No live binding names the Channel that was never opened, and the next
    // attempt is free to create it rather than being held.
    expect((await bindingRows()).filter((row) => row.path_json !== "[\"C1\"]")).toEqual([]);
    expect(await resolve(["C1", "1.0"], { addressed: true, claimKey: "event:retry" })).toMatchObject({ outcome: "spawn" });
  });

  it("refuses a claim on a thread that already routes, writing nothing", async () => {
    const linked = await linkRoom("C1", "00000000-0000-7000-8000-000000000e61");
    if (!linked.ok) throw new Error("link refused");
    await workspace().recordOutboundExternalConversationBinding({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path: ["C1", "1.0"],
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId: RUN }, at: at(),
    });
    const workstreamId = asWorkstreamId("00000000-0000-7000-8000-000000000e62");
    const refused = await workspace().reserveChannelInSpaces({
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      workstreamId,
      spaceIds: [asSpaceId(linked.spaceId)],
      requestedScope: "workspace",
      requestedParticipantUserIds: [],
      authorityGeneration: 1,
      directory: { title: "Second", description: "", emailAddress: null, titleStatus: "settled", createdAt: at() },
      externalBinding: claim(["C1", "1.0"], "event:second"),
    });
    expect(refused).toEqual({ status: "binding_refused", outcome: "bound" });
    // The claim was the last write of the birth, so the birth went with it.
    const residue = await runInDurableObject(workspace(), (_instance, state) => ({
      parents: state.storage.sql.exec("SELECT parent_id FROM parent_metadata WHERE parent_id = ?", workstreamId).toArray(),
      memberships: state.storage.sql.exec("SELECT 1 FROM space_channel_memberships WHERE workstream_id = ?", workstreamId).toArray(),
    }));
    expect(residue).toEqual({ parents: [], memberships: [] });
  });

  it("starts two Channels for two addressed messages in a room without threads, for a sender with no Rally identity", async () => {
    const linked = await linkRoom("G1", "00000000-0000-7000-8000-000000000e71");
    if (!linked.ok) throw new Error("link refused");
    const created: string[] = [];
    for (const messageTs of ["5.0", "6.0"]) {
      const channel = await new SlackWorkspaceWorkstreamService(creationEnv(), WORKSPACE_ID).create({
        actor: {
          provider: "slack", providerAccountId: "T1", providerUserId: "UGUEST",
          displayName: "Guest", avatarUrl: null,
        },
        title: `Request ${messageTs}`,
        objective: "Look into it",
        text: "Look into it",
        clientMessageId: `event:group-${messageTs}`,
        creatorUserId: null,
        scope: "personal",
        slackOrigin: {
          teamId: "T1", channelId: "G1", channelName: null, threadTs: messageTs,
          invocationType: "app_mention", channelType: "private", matchedAvalonUserId: null,
          nearbyMessagesStatus: "not_applicable", nearbyMessages: [], attachments: [],
        },
        space: {
          spaceId: asSpaceId(linked.spaceId),
          actorUserId: USER_ID,
          externalBinding: claim(["G1", messageTs], `event:group-${messageTs}`),
        },
      });
      created.push(channel.workstream.id);
      expect(await resolve(["G1", messageTs])).toEqual({
        outcome: "deliver",
        target: { kind: "conversation", parentKind: "workstream", parentId: channel.workstream.id, substreamId: "0" },
      });
      expect(await workspace().channelSpaces({
        workspaceId: WORKSPACE_ID, userId: USER_ID, workstreamId: asWorkstreamId(channel.workstream.id),
      })).toEqual({ spaceIds: [linked.spaceId] });
    }
    expect(new Set(created).size).toBe(2);
    // Born in the room's Organization-wide Space, the Channels keep the
    // private room's audience, because a Space grants no reader, and are
    // ownerless: the sender has no Rally identity to credit.
    const rows = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
      workstream_id: string; scope: string; created_by_user_id: string | null;
    }>(
      `SELECT workstream_id, scope, created_by_user_id FROM channels WHERE workstream_id IN (?, ?)`,
      created[0]!, created[1]!,
    ).toArray());
    expect(rows.map((row) => ({ scope: row.scope, createdBy: row.created_by_user_id })))
      .toEqual([{ scope: "personal", createdBy: null }, { scope: "personal", createdBy: null }]);
  });

  it("re-enters the Channel a failed attempt reserved when the same event is retried", async () => {
    const linked = await linkRoom("G3", "00000000-0000-7000-8000-000000000e91");
    if (!linked.ok) throw new Error("link refused");
    const attempt = () => new SlackWorkspaceWorkstreamService(creationEnv(), WORKSPACE_ID).create({
      actor: {
        provider: "slack", providerAccountId: "T1", providerUserId: "UGUEST",
        displayName: "Guest", avatarUrl: null,
      },
      title: "Retried request",
      objective: "Look into it",
      text: "Look into it",
      clientMessageId: "event:retried",
      creatorUserId: null,
      scope: "personal",
      slackOrigin: {
        teamId: "T1", channelId: "G3", channelName: null, threadTs: "7.0",
        invocationType: "app_mention", channelType: "private", matchedAvalonUserId: null,
        nearbyMessagesStatus: "not_applicable", nearbyMessages: [], attachments: [],
      },
      space: {
        spaceId: asSpaceId(linked.spaceId),
        actorUserId: USER_ID,
        externalBinding: claim(["G3", "7.0"], "event:retried"),
      },
    });
    // The first attempt reserves and provisions its Channel in the Space,
    // then fails activating its email route.
    const activation = vi.spyOn(WorkstreamEmailRoutingService.prototype, "activateWorkstreamRoute")
      .mockRejectedValueOnce(new Error("email_route_unavailable"));
    const failure = await attempt().then(() => null, (error: unknown) => error);
    activation.mockRestore();
    expect(failure).toMatchObject({ message: "email_route_unavailable" });

    const channel = await attempt();
    const members = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
      workstream_id: string;
    }>(
      "SELECT workstream_id FROM space_channel_memberships WHERE space_id = ? AND state = 'active'",
      linked.spaceId,
    ).toArray().map((row) => row.workstream_id));
    expect(members).toEqual([channel.workstream.id]);
    expect(await resolve(["G3", "7.0"])).toEqual({
      outcome: "deliver",
      target: { kind: "conversation", parentKind: "workstream", parentId: channel.workstream.id, substreamId: "0" },
    });
  });


});

describe("suspending bindings", () => {
  it("suspends every binding to a deleted Sidekick's runs", async () => {
    await workspace().recordOutboundExternalConversationBinding({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path: ["D1", "1.0"],
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId: RUN }, at: at(),
    });
    // Through the product path: a person archives the Sidekick.
    await workspace().sidekickCreate({
      workspaceId: WORKSPACE_ID, automationId: SIDEKICK, authorUserId: USER_ID,
      scope: "personal", owningWorkstreamId: null, authorityGeneration: 1,
    });
    await workspace().sidekickRemove({
      workspaceId: WORKSPACE_ID, automationId: SIDEKICK,
      actor: { userId: USER_ID, actorRole: "member", participantOfOwningWorkstream: false },
    });
    expect(await resolve(["D1", "1.0"])).toEqual({ outcome: "suspended", path: ["D1", "1.0"], reason: "sidekick_deleted" });
  });

  it("suspends an installation on disconnect and brings back only what the disconnect suspended", async () => {
    const outbound = (path: string[], runId: string) => workspace().recordOutboundExternalConversationBinding({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path,
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId: runId }, at: at(),
    });
    await outbound(["D1", "1.0"], RUN);
    await outbound(["D2", "1.0"], "00000000-0000-7000-8000-000000000ec7");
    // A person closes one run's binding first.
    await closeRunBindings("00000000-0000-7000-8000-000000000ec7");
    expect(await resolve(["D2", "1.0"])).toEqual({ outcome: "suspended", path: ["D2", "1.0"], reason: "closed" });

    await workspace().suspendExternalConversationBindings({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, reason: "connection_disconnected", at: at(),
    });
    expect(await resolve(["D1", "1.0"])).toMatchObject({ outcome: "suspended", reason: "connection_disconnected" });

    await workspace().reactivateExternalConversationBindings({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, at: at(),
    });
    expect(await resolve(["D1", "1.0"])).toMatchObject({ outcome: "deliver" });
    expect(await resolve(["D2", "1.0"])).toMatchObject({ outcome: "suspended", reason: "closed" });
  });
});

describe("a lasting suspension during a disconnect", () => {
  it("keeps a deleted Sidekick's thread and a left room suspended through the reconnect", async () => {
    await workspace().recordOutboundExternalConversationBinding({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path: ["D1", "1.0"],
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId: RUN }, at: at(),
    });
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO external_conversation_bindings
           (installation_id, path_json, target_kind, space_id, state, created_at, updated_at)
         VALUES (?, '["C1"]', 'space', '00000000-0000-7000-8000-000000000ed1', 'active', ?, ?)`,
        INSTALLATION, at(), at(),
      );
    });
    await workspace().suspendExternalConversationBindings({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, reason: "connection_disconnected", at: at(),
    });
    // While disconnected: the bot is removed from the room, and the Sidekick is deleted.
    await workspace().suspendExternalConversationBindings({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path: ["C1"], reason: "provider_membership_ended", at: at(),
    });
    await writeSidekickDirectoryRow(env, {
      automationId: SIDEKICK, workspaceId: WORKSPACE_ID, authorUserId: USER_ID, lifecycle: "deleted",
      scope: "workspace", owningWorkstreamId: null, title: "Weekly call prep", description: "",
    });

    await workspace().reactivateExternalConversationBindings({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, at: at(),
    });

    expect(await resolve(["D1", "1.0"])).toEqual({ outcome: "suspended", path: ["D1", "1.0"], reason: "sidekick_deleted" });
    expect(await resolve(["C1", "5.0"])).toEqual({ outcome: "suspended", path: ["C1"], reason: "provider_membership_ended" });
  });
});

describe("a Slack Connect room whose ID changes", () => {
  it("moves the room and every path beneath it, keeping each target, and refuses to merge into a bound ID", async () => {
    const linked = await linkRoom("C1", "00000000-0000-7000-8000-000000000e91");
    if (!linked.ok) throw new Error("link refused");
    const created = await createForThread("moved", asSpaceId(linked.spaceId), ["C1", "1.0"]);
    // A path that only shares a prefix with the room's ID is not beneath it.
    await workspace().recordOutboundExternalConversationBinding({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path: ["C10", "1.0"],
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId: RUN }, at: at(),
    });

    expect(await workspace().moveExternalConversationBindings({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, from: ["C1"], to: ["C2"], at: at(),
    })).toEqual({ outcome: "moved", count: 2 });
    expect(await resolve(["C2", "1.0"])).toEqual({
      outcome: "deliver",
      target: { kind: "conversation", parentKind: "workstream", parentId: created.workstream.id, substreamId: "0" },
    });
    expect(await resolve(["C2", "9.0"], { addressed: true, claimKey: "event:new" }))
      .toMatchObject({ outcome: "spawn", spaceId: linked.spaceId });
    expect(await resolve(["C1", "1.0"])).toEqual({ outcome: "none", roomBound: false });
    expect(await resolve(["C10", "1.0"])).toMatchObject({ outcome: "deliver" });

    await linkRoom("C3", "00000000-0000-7000-8000-000000000e92");
    expect(await workspace().moveExternalConversationBindings({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, from: ["C2"], to: ["C3"], at: at(),
    })).toEqual({ outcome: "conflict" });
    expect(await resolve(["C2", "1.0"])).toMatchObject({ outcome: "deliver" });
  });
});

describe("outbound bindings", () => {
  it("keeps the first binding of a path, and a redelivery is a no-op", async () => {
    const record = (substreamId: string) => workspace().recordOutboundExternalConversationBinding({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path: ["D1", "1.0"],
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId }, at: at(),
    });
    expect(await record(RUN)).toEqual({ outcome: "bound" });
    expect(await record(RUN)).toEqual({ outcome: "already_bound" });
    expect(await record("00000000-0000-7000-8000-000000000ec8")).toEqual({ outcome: "conflict" });
    expect(await resolve(["D1", "1.0"])).toMatchObject({ outcome: "deliver", target: { substreamId: RUN } });
  });

  it("finds a bot DM's most recent open request, and nothing in a DM without one", async () => {
    const EARLIER_RUN = "00000000-0000-7000-8000-000000000ec9";
    const record = async (path: string[], runId: string) => {
      await workspace().recordOutboundExternalConversationBinding({
        workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path,
        target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId: runId }, at: at(),
      });
      await scheduler.wait(5);
    };
    // Recorded out of timestamp order, so the most recent is not the one
    // that sorts last by path.
    await record(["D1", "2.0"], EARLIER_RUN);
    await record(["D1", "1.0"], RUN);
    const latest = (prefix: string) => workspace().latestOutboundExternalConversation({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, prefix: [prefix],
    });
    expect(await latest("D1")).toEqual({ latest: { path: ["D1", "1.0"], sidekickId: SIDEKICK, runId: RUN } });
    expect(await latest("D2")).toEqual({ latest: null });
    // A closed request is no longer one to point at.
    await closeRunBindings(RUN);
    await closeRunBindings(EARLIER_RUN);
    expect(await latest("D1")).toEqual({ latest: null });
  });
});

describe("a Sidekick run's send", () => {
  const ATTEMPT = "attempt-1";
  const OWNER = "owner-1";
  const HARNESS_RUN = "00000000-0000-7000-8000-00000000ec99";
  let unique = 0;

  function runChild(): DurableObjectStub {
    unique += 1;
    return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(conversationObjectName(
      "global",
      RUN_WORKSPACE_ID,
      SIDEKICK_ID,
      asSubstreamId(`00000000-0000-7000-8000-${String(unique).padStart(12, "0")}`),
    )));
  }

  async function receipt(stub: DurableObjectStub, operation: string, args: Record<string, unknown>) {
    const { body } = await post(stub, "/internal/tool-receipt", {
      workspaceId: RUN_WORKSPACE_ID, workstreamId: SIDEKICK_ID, operation, args: [args],
    });
    return body as { ok: boolean; value?: unknown; error?: string };
  }

  async function sentMessage(stub: DurableObjectStub, externalBinding: Record<string, unknown> | null, owner = OWNER) {
    const fence = { runId: HARNESS_RUN, attemptId: ATTEMPT, owner: OWNER };
    await receipt(stub, "admit", {
      effectIntentId: "send", runId: HARNESS_RUN, toolCallId: "send", toolName: "send_message", mode: "write",
      connectionId: "slack-workspace", requestHash: "request-hash", inputJson: "{}", executionPlanHash: "plan-hash",
      executionPlanJson: '{"mode":"write"}', compatiblePriorPlanHashes: [], providerIdempotencyKey: null, fence, now: Date.now(),
    });
    return receipt(stub, "complete", {
      effectIntentId: "send", checkpointIndex: 1, outputRef: "send-output", outputSummary: "Sent",
      providerOperationId: "D9:1727.002", payloadJson: "{}", allowAmbiguousReconciliation: false,
      ...(externalBinding ? { externalBinding } : {}),
      fence: { ...fence, owner }, now: Date.now(),
    });
  }

  async function outboxRows(stub: DurableObjectStub) {
    return runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ payload_json: string }>(
      "SELECT payload_json FROM durable_outbox WHERE channel = ?", EXTERNAL_BINDING_OUTBOX_CHANNEL,
    ).toArray());
  }

  async function seedRunChild(stub: DurableObjectStub) {
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: RUN_WORKSPACE_ID, workstreamId: SIDEKICK_ID });
      state.storage.sql.exec("UPDATE workstream SET parent_kind = 'automation' WHERE id = 1");
      state.storage.sql.exec(
        `INSERT INTO runs (run_id, substream_id, status, budget, attempt_epoch,
           model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
           active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
           tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
           created_at, updated_at, legacy_attempt_id, lease_owner, lease_expires_at)
         VALUES (?,'0','running','{}',0,0,'',0,0,1,0,0,0,0,0,0,0,0,0,0,1,1,?,?,?)`,
        HARNESS_RUN, ATTEMPT, OWNER, Date.now() + 600_000,
      );
    });
  }

  // Where the send's replies arrive; the run child that commits it is the target.
  const binding = { installationId: INSTALLATION, path: ["D9", "1727.002"] };

  async function resolveRun(path: string[]) {
    return ExternalBindingResolutionSchema.parse(await workspace(RUN_WORKSPACE_ID).resolveExternalConversation({
      workspaceId: RUN_WORKSPACE_ID, installationId: INSTALLATION, path,
      addressed: false, claimKey: null, pendingStaleBefore: LIVE,
    }));
  }

  it("binds the reply thread with the receipt, and WorkspaceDO has it once the outbox drains", async () => {
    await workspace(RUN_WORKSPACE_ID).initializeWorkspace(RUN_WORKSPACE_ID, "wnam");
    const stub = runChild();
    await seedRunChild(stub);

    expect(await sentMessage(stub, binding)).toMatchObject({ ok: true, value: "persisted" });
    // The receipt schedules the outbox alarm for now, so workerd may already be
    // draining it: running the alarm here can find none pending and return
    // before that drain finishes. The row is deleted only once WorkspaceDO has
    // the binding, so wait for the empty outbox, not for the alarm call.
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(stub);
      expect(await outboxRows(stub)).toEqual([]);
    });
    expect(await resolveRun(["D9", "1727.002"])).toEqual({
      outcome: "deliver",
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK_ID, substreamId: "0" },
    });
  });

  it("parks a binding that can never be delivered, and keeps delivering the ones behind a failing one", async () => {
    const stub = runChild();
    await seedRunChild(stub);
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const now = Date.now();
      for (const [index, path] of [["D1", "1.0"], ["D2", "1.0"]].entries()) {
        enqueueExternalBindingInTransaction(sql, { ...binding, path, at: at() }, now + index);
      }
      // A row whose payload no longer parses, written ahead of both.
      sql.exec(
        `INSERT INTO durable_outbox
           (message_id, channel, destination_kind, destination_id, partition_key, source_version, source_epoch,
            contract_version, payload_json, payload_ref, payload_hash, state, attempts, not_before, created_at, acked_at)
         VALUES ('poisoned', ?, 'durable_object', ?, 'p', 1, 0, 1, '{"installationId":"slack:T1"}', NULL, 'h',
                 'pending', 0, ?, ?, NULL)`,
        EXTERNAL_BINDING_OUTBOX_CHANNEL, RUN_WORKSPACE_ID, now - 1, now - 1,
      );
      const delivered: string[] = [];
      const report = await drainExternalBindingOutbox(sql, async (payload) => {
        if (payload.path[0] === "D1") throw new Error("workspace_unavailable");
        delivered.push(payload.path[0]!);
        return "bound";
      }, now + 10);
      const rows = sql.exec<{ message_id: string; state: string; attempts: number }>(
        "SELECT message_id, state, attempts FROM durable_outbox WHERE channel = ? ORDER BY message_id",
        EXTERNAL_BINDING_OUTBOX_CHANNEL,
      ).toArray().map((row) => ({ ...row, message_id: row.message_id.includes("D1") ? "D1" : row.message_id }));
      return { delivered, report, rows };
    });
    // The failing row did not stop the one behind it.
    expect(result.delivered).toEqual(["D2"]);
    expect(result.rows).toEqual([
      { message_id: "D1", state: "pending", attempts: 1 },
      { message_id: "poisoned", state: "dead", attempts: 1 },
    ]);
    expect(result.report.dead).toEqual([{ messageId: "poisoned", code: expect.stringContaining("external_binding_payload_invalid") }]);
    expect(result.report.deferred).toEqual([{ messageId: expect.stringContaining("D1"), code: "workspace_unavailable" }]);
  });

  it("writes no binding for a send whose receipt did not commit, nor for one that carried none", async () => {
    await workspace(RUN_WORKSPACE_ID).initializeWorkspace(RUN_WORKSPACE_ID, "wnam");
    const lost = runChild();
    await seedRunChild(lost);
    // The fence refused the completion, so its binding went with it.
    expect(await sentMessage(lost, binding, "another-owner")).toMatchObject({ ok: true, value: "ownership_lost" });
    expect(await outboxRows(lost)).toEqual([]);

    // A send through a person's own connection reports no conversation, so
    // its completion carries no binding.
    const personal = runChild();
    await seedRunChild(personal);
    expect(await sentMessage(personal, null)).toMatchObject({ ok: true, value: "persisted" });
    expect(await outboxRows(personal)).toEqual([]);
  });
});

describe("a reply in a thread bound to a Sidekick run", () => {
  it("lands in the run child as the sender's external message, not in a new Channel", async () => {
    const runId = asSubstreamId("00000000-0000-7000-8000-000000000ed1");
    // The run child as a scheduled run provisions it: the Sidekick parent,
    // the run as its substream, personal to the run-as member.
    await bootstrapConversationChildRuntime(env, WORKSPACE_ID, "automation", SIDEKICK, runId);
    await provisionWorkstreamObject(env, {
      workspaceId: WORKSPACE_ID, workstreamId: SIDEKICK, substreamId: runId,
      title: "Weekly call prep", objective: "Ask the founders for updates", scope: "personal",
      createdByUserId: USER_ID, participantUserIds: [USER_ID], harnessStatus: "idle", titleStatus: "settled",
      emailAddress: null, emailRouteStatus: null, systemKind: null, modelOverride: null, now: Date.now(),
    });
    const child = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, SIDEKICK, runId),
    ));
    // Hold the run's loop, so the delivered input is observed as pending rather
    // than raced by its own activation.
    await runInDurableObject(child, (_instance, state) => {
      holdLoopExecuting(state, { loopId: substreamLoopId(SIDEKICK, runId) });
    });
    const actor = {
      provider: "slack", providerAccountId: "T1", providerUserId: "UADAM", displayName: "Adam", avatarUrl: null,
    };
    const admission = externalBindingReplyAdmission({
      workspaceId: WORKSPACE_ID,
      teamId: "T1",
      slackUserId: "UADAM",
      actor,
      matchedWorkspaceUserId: null,
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId: runId },
      message: {
        channelId: "D1", threadTs: "1727.002", messageTs: "1727.100", text: "Nothing from me",
        clientMessageId: "event:EvReply", channelType: "im",
      },
      now: Date.now(),
    });
    const admitted = await admitExternalWorkstreamMessage(env, admission);
    expect(admitted.deliveryState).toBe("pending");

    await runInDurableObject(child, (_instance, state) => {
      const pending = new SubstreamLoopStorage(state.storage).input(admission.messageId)!;
      expect(pending).toMatchObject({ actor: "external", external_actor_json: JSON.stringify(actor) });
      expect(JSON.parse(pending.authorization_json)).toMatchObject({ reason: "external_conversation_binding" });
      expect(state.storage.sql.exec<{ parent_kind: string; workstream_key: string }>(
        "SELECT parent_kind, workstream_key FROM workstream WHERE id = 1",
      ).one()).toEqual({ parent_kind: "automation", workstream_key: SIDEKICK });
    });
  });
});

describe("the connector side of a binding", () => {
  const CONNECTION = "00000000-0000-7000-8000-000000000ef1";
  const AUTOMATION = "00000000-0000-7000-8000-000000000ef2";

  async function seedSlackConnection() {
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO connector_connections
           (id, workspace_id, connector_type, scope, owner_user_id, provider_account_id, display_name,
            status, config_json, created_at, updated_at, model_plugin_id)
         VALUES (?, ?, 'slack', 'workspace', NULL, 'T1', 'Slack', 'healthy', '{}', ?, ?, 'plugin_slack_bindings')`,
        CONNECTION, WORKSPACE_ID, at(), at(),
      );
    });
  }

  it("claims a message in a bound thread, so it never also becomes Suggested Work", async () => {
    await seedSlackConnection();
    let ordinal = 0;
    const ingest = async () => {
      ordinal += 1;
      const eventId = `00000000-0000-7000-8000-00000000ef${String(10 + ordinal)}`;
      await workspace().ingestConnectorEvent({
        workspaceId: WORKSPACE_ID,
        ingressEventId: eventId,
        payloadHash: `sha256:${String(ordinal).padStart(2, "0").repeat(32)}`,
        event: {
          connectorType: "slack",
          activity: {
            id: eventId, workspaceId: WORKSPACE_ID, region: "global", connectionId: CONNECTION,
            connectionScope: "workspace", connectionOwnerUserId: null, provider: "slack",
            providerEventId: `Ev${ordinal}`, eventType: "slack.direct_message.received", resourceType: "slack_message",
            providerResourceId: `D1:1727.10${ordinal}`, actor: {}, subject: {}, occurredAt: at(), receivedAt: at(),
            title: "Slack direct message", summary: "", textSnippet: "Nothing from me", payloadRef: null,
            visibility: { kind: "workspace" }, targetUserIds: [], entityKeys: [], dedupeKey: `slack:${ordinal}`,
            rawContentHash: null, externalPeople: [],
            metadata: { teamId: "T1", channelId: "D1", threadTs: "1727.002", externalConversationPath: ["D1", "1727.002"], externalConversationInstallationId: INSTALLATION },
          },
        },
      });
      return WorkspaceExternalEventMatchResultSchema.parse(
        await workspace().matchExternalEventDestinations({ workspaceId: WORKSPACE_ID, eventId }),
      );
    };
    // Nothing binds the thread yet: an ordinary unclaimed event.
    expect(await ingest()).toEqual({ matched: false, deliveries: [] });
    await workspace().recordOutboundExternalConversationBinding({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path: ["D1", "1727.002"],
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId: RUN }, at: at(),
    });
    expect(await ingest()).toEqual({ matched: true, deliveries: [] });
  });

  it("does not also start the bound Sidekick from a reply its run receives, and still triggers others", async () => {
    await seedSlackConnection();
    for (const automationId of [SIDEKICK, AUTOMATION]) {
      await workspace().sidekickCreate({ workspaceId: WORKSPACE_ID, automationId, authorUserId: USER_ID,
        scope: "workspace", owningWorkstreamId: null, authorityGeneration: 1,
        creatorConsent: { requestId: crypto.randomUUID() } });
      await writeSidekickDirectoryRow(env, { automationId, workspaceId: WORKSPACE_ID, authorUserId: USER_ID,
        lifecycle: "active", scope: "workspace", owningWorkstreamId: null, title: "Reply watcher", description: "Watch replies" });
    }
    const register = (automationId: string, evaluatorId: string) => workspace().applyExternalEventRegistrations({
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      destination: { kind: "automation", automationId },
      evaluators: [{
        evaluatorId,
        source: { connectorType: "slack", connectionId: CONNECTION, eventType: "slack.direct_message.received" },
        when: { kind: "all", allOf: [{ kind: "string", attribute: "channelId", operator: "in", value: ["D1"] }] },
      }],
    });
    await register(SIDEKICK, "00000000-0000-7000-8000-000000000ef6");
    await register(AUTOMATION, "00000000-0000-7000-8000-000000000ef7");
    await workspace().recordOutboundExternalConversationBinding({
      workspaceId: WORKSPACE_ID, installationId: INSTALLATION, path: ["D1", "1727.002"],
      target: { kind: "conversation", parentKind: "automation", parentId: SIDEKICK, substreamId: RUN }, at: at(),
    });
    const eventId = "00000000-0000-7000-8000-00000000ef21";
    await workspace().ingestConnectorEvent({
      workspaceId: WORKSPACE_ID,
      ingressEventId: eventId,
      payloadHash: `sha256:${"21".repeat(32)}`,
      event: {
        connectorType: "slack",
        activity: {
          id: eventId, workspaceId: WORKSPACE_ID, region: "global", connectionId: CONNECTION,
          connectionScope: "workspace", connectionOwnerUserId: null, provider: "slack",
          providerEventId: "Ev21", eventType: "slack.direct_message.received", resourceType: "slack_message",
          providerResourceId: "D1:1727.121", actor: {}, subject: {}, occurredAt: at(), receivedAt: at(),
          title: "Slack direct message", summary: "", textSnippet: "Nothing from me", payloadRef: null,
          visibility: { kind: "workspace" }, targetUserIds: [], entityKeys: [], dedupeKey: "slack:21",
          rawContentHash: null, externalPeople: [],
          metadata: { teamId: "T1", channelId: "D1", threadTs: "1727.002", externalConversationPath: ["D1", "1727.002"], externalConversationInstallationId: INSTALLATION },
        },
      },
    });
    const matched = WorkspaceExternalEventMatchResultSchema.parse(
      await workspace().matchExternalEventDestinations({ workspaceId: WORKSPACE_ID, eventId }),
    );
    expect(matched.matched).toBe(true);
    expect(matched.deliveries.map((delivery) => delivery.destination))
      .toEqual([{ kind: "automation", automationId: AUTOMATION }]);
  });

  it("queues a join for the conversations a saved Slack source names, and links no Space", async () => {
    await seedSlackConnection();
    await workspace().applyExternalEventRegistrations({
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      destination: { kind: "automation", automationId: AUTOMATION },
      evaluators: [{
        evaluatorId: "00000000-0000-7000-8000-000000000ef3",
        source: { connectorType: "slack", connectionId: CONNECTION, eventType: "slack.message.posted" },
        when: { kind: "all", allOf: [
          { kind: "string", attribute: "channelId", operator: "in", value: ["C9", "C8"] },
          { kind: "string", attribute: "text", operator: "contains", value: "deploy" },
        ] },
      }],
    });
    const jobs = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
      id: string; connection_id: string; payload_json: string;
    }>("SELECT id, connection_id, payload_json FROM slack_ingress_jobs").toArray());
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.connection_id).toBe(CONNECTION);
    expect(JSON.parse(jobs[0]!.payload_json)).toMatchObject({
      team_id: "T1",
      event: { type: "rally_sidekick_source_join", channel_ids: ["C8", "C9"] },
    });
    // A join a Sidekick needs is not an invitation.
    expect(await bindingRows()).toEqual([]);
    expect(await spaceIds()).toEqual([]);
  });

  it("joins again on every accepted save of the same conversations, and not on a stale one", async () => {
    await seedSlackConnection();
    const save = (sourceGeneration: number, channels = ["C9"]) => workspace().applyExternalEventRegistrations({
      schemaVersion: 1,
      workspaceId: WORKSPACE_ID,
      destination: { kind: "automation", automationId: AUTOMATION },
      sourceGeneration,
      evaluators: [{
        evaluatorId: "00000000-0000-7000-8000-000000000ef4",
        source: { connectorType: "slack", connectionId: CONNECTION, eventType: "slack.message.posted" },
        when: { kind: "all", allOf: [{ kind: "string", attribute: "channelId", operator: "in", value: channels }] },
      }],
    });
    const jobs = () => runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{ id: string }>(
      "SELECT id FROM slack_ingress_jobs ORDER BY id",
    ).toArray().map((row) => row.id));
    await save(1);
    expect(await jobs()).toHaveLength(1);
    // The first join ran; the bot has since been removed from C9.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("UPDATE slack_ingress_jobs SET status = 'completed', payload_json = NULL");
    });
    await save(2);
    expect(await jobs()).toHaveLength(2);
    // A projection older than the one applied changes nothing, so it joins
    // nothing, whatever conversations it names.
    await save(1, ["C7"]);
    expect(await jobs()).toHaveLength(2);
  });
});
