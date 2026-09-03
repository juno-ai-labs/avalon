/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The conversation-parent contract, answered by both parents.
 *
 * A `SubstreamAgent` does not decide who may read it or whether it may still
 * be written; its parent does. `WorkstreamDO` answers from the room's scope
 * and participants, `AutomationDO` from the automation's author and scope and,
 * for a room's automation, from the room's participants through WorkspaceDO.
 * Both report an archive rather than folding it into the answer: an archived
 * parent's conversations stay readable and refuse every write, so a child
 * never outlives its parent's archive.
 *
 * The last test drives that rule end to end: the real socket ticket carries
 * the parent's archive into the admission, and the conversation object refuses
 * `create_message` on a socket admitted that way, even though its own row is
 * not archived (the automation's conversation is, by design, never archived
 * on its own; its room was).
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asAutomationId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import type { AutomationDO } from "../src/durable-objects/automation-do";
import {
  automationDOName,
  conversationObjectName,
  workspaceDOName,
  workstreamDOName,
} from "../src/durable-objects/names";
import type { AuthContext, Env } from "../src/env";
import { createAutomation } from "../src/services/automation-service";
import { ConversationService } from "../src/services/conversation-service";
import { SocketService, verifySocketTicket } from "../src/services/socket-service";
import {
  bootstrapWorkstreamRuntimeEnvironment,
  provisionWorkstreamObject,
} from "../src/services/workstream-runtime-database";
import { deliverEffectsToWorkspace, deliverParentEffects } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { post, seedWorkspaceControlPlane } from "./helpers/substream-fixture";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000ad30");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-00000000ad31");
const MEMBER_ID = asUserId("00000000-0000-7000-8000-00000000ad32");
const PARTICIPANT_ID = asUserId("00000000-0000-7000-8000-00000000ad33");
const SESSION_ID = "00000000-0000-7000-8000-00000000ad34";
const PERSONAL_ROOM_ID = asWorkstreamId("00000000-0000-7000-8000-00000000ad35");
const WORKSPACE_ROOM_ID = asWorkstreamId("00000000-0000-7000-8000-00000000ad36");
const NOW = "2026-08-29T10:00:00.000Z";
const TEST_ENV: Env = env;
// Not a credential: the test Worker declares no signing key, and a ticket has
// to be signed by the same key the upgrade verifies it with.
const SIGNING_KEY = "conversation-parent-contract-test-signing-key";
const SOCKET_FRAME_TIMEOUT_MS = 5_000;

const AUTH: AuthContext = {
  sessionId: SESSION_ID,
  userId: AUTHOR_ID,
  workspaceId: WORKSPACE_ID,
  region: "global",
  role: "member",
};

/** The Worker's environment with the one variable the socket path signs with. */
const socketEnv: Env = new Proxy(env, {
  get: (target, property, receiver) => (
    property === "SESSION_SIGNING_KEY" ? SIGNING_KEY : Reflect.get(target, property, receiver) as unknown
  ),
});

useHeldEffectQueue();

let ordinal = 0;

function nextAutomationId() {
  ordinal += 1;
  return asAutomationId(`00000000-0000-7000-8000-${String(ordinal).padStart(4, "0")}0000ad3f`);
}

function workspaceStub() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

function roomParent(roomId: string) {
  return env.WORKSTREAM_DOS.get(env.WORKSTREAM_DOS.idFromName(
    workstreamDOName("global", WORKSPACE_ID, asWorkstreamId(roomId)),
  ));
}

function conversation(parentId: string): DurableObjectStub {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, parentId),
  ));
}

function automationStub(automationId: string): DurableObjectStub<AutomationDO> {
  return env.AUTOMATION_DOS.get(env.AUTOMATION_DOS.idFromName(
    automationDOName("global", WORKSPACE_ID, asAutomationId(automationId)),
  ));
}

async function seedRegionalDatabase(): Promise<void> {
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, sessionId: SESSION_ID });
  await env.DB.batch([
    ...[[MEMBER_ID, "member3@example.com"], [PARTICIPANT_ID, "participant@example.com"]].flatMap(([userId, email]) => [
      env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
        VALUES (?, ?, 'active', 'member', ?)`).bind(WORKSPACE_ID, userId, NOW),
      env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
        VALUES (?, ?, 'Person', NULL, 'UTC', ?)`).bind(userId, email, NOW),
    ]),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL
    )`),
  ]);
}

/**
 * A room made the way creation makes one: the parent reserves the main
 * conversation and puts the provisional directory row in the workspace, the
 * route is written, the conversation object is opened and told what the room
 * is and who is in it, and its first projection reaches the parent and the
 * workspace so every participant is in the workspace's viewer set.
 */
async function seedRoom(roomId: string, scope: "personal" | "workspace", participants: readonly string[]): Promise<void> {
  await roomParent(roomId).reserveChild({
    workspaceId: WORKSPACE_ID,
    parentId: roomId,
    substreamId: "0",
    kind: "main",
    createdByUserId: AUTHOR_ID,
    authorityGeneration: 1,
    directory: {
      title: scope === "personal" ? "Private room" : "Open room",
      description: "",
      scope,
      systemKind: null,
      emailAddress: null,
      titleStatus: "settled",
      createdAt: NOW,
    },
  });
  await bootstrapWorkstreamRuntimeEnvironment(TEST_ENV, WORKSPACE_ID, roomId, "workstream");
  await provisionWorkstreamObject(TEST_ENV, {
    workspaceId: WORKSPACE_ID,
    workstreamId: roomId,
    title: scope === "personal" ? "Private room" : "Open room",
    objective: "",
    scope,
    createdByUserId: AUTHOR_ID,
    participantUserIds: [...participants],
    harnessStatus: "idle",
    titleStatus: "settled",
    emailAddress: null,
    emailRouteStatus: null,
    systemKind: null,
    modelOverride: null,
    now: Date.now(),
  });
  await deliverEffectsToWorkspace(TEST_ENV, conversation(roomId));
}

/** Archived through the room's own surface, then both legs so every parent hears it. */
async function archiveRoom(roomId: string): Promise<void> {
  const archived = await post(conversation(roomId), "/internal/product", {
    operation: "update",
    auth: AUTH,
    input: { archived: true },
  });
  expect(archived.status).toBe(200);
  await deliverEffectsToWorkspace(TEST_ENV, conversation(roomId));
}

async function seedAutomation(scope: "personal" | "workspace" | "workstream", owningWorkstreamId: string | null): Promise<string> {
  const automationId = nextAutomationId();
  const created = await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID,
    authorUserId: AUTHOR_ID,
    scope,
    owningWorkstreamId,
    automationId,
  });
  expect(created.created).toBe(true);
  await deliverParentEffects(TEST_ENV, automationStub(automationId));
  return automationId;
}

function viewer(parentId: string, userId: string) {
  return { workspaceId: WORKSPACE_ID, parentId, userId };
}

function nextFrameOfType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type} frame within ${SOCKET_FRAME_TIMEOUT_MS}ms`)), SOCKET_FRAME_TIMEOUT_MS);
    const onMessage = (event: MessageEvent) => {
      try {
        const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
        if (frame.type !== type) return;
        clearTimeout(timer);
        socket.removeEventListener("message", onMessage);
        resolve(frame);
      } catch {
        // Heartbeats and non-JSON frames are not what this waits for.
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

beforeEach(async () => {
  await reset();
  await seedRegionalDatabase();
  await workspaceStub().initializeWorkspace(WORKSPACE_ID, "wnam");
});

describe("conversation parent contract", () => {
  it("WorkstreamDO admits a personal room's participants and every member of a workspace room", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID, PARTICIPANT_ID]);
    await seedRoom(WORKSPACE_ROOM_ID, "workspace", [AUTHOR_ID]);

    expect(await roomParent(PERSONAL_ROOM_ID).authorizeViewer(viewer(PERSONAL_ROOM_ID, AUTHOR_ID)))
      .toEqual({ authorized: true, archived: false });
    expect(await roomParent(PERSONAL_ROOM_ID).authorizeViewer(viewer(PERSONAL_ROOM_ID, PARTICIPANT_ID)))
      .toEqual({ authorized: true, archived: false });
    expect(await roomParent(PERSONAL_ROOM_ID).authorizeViewer(viewer(PERSONAL_ROOM_ID, MEMBER_ID)))
      .toEqual({ authorized: false, archived: false });
    expect(await roomParent(WORKSPACE_ROOM_ID).authorizeViewer(viewer(WORKSPACE_ROOM_ID, MEMBER_ID)))
      .toEqual({ authorized: true, archived: false });
    expect(await roomParent(PERSONAL_ROOM_ID).authority({ workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID }))
      .toEqual({ exists: true, authorityGeneration: 1, archived: false });
    expect(await roomParent(PERSONAL_ROOM_ID).listChildren({ workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID }))
      .toEqual({ children: [{ substreamId: "0", kind: "main", createdAt: expect.any(Number) }] });

    await archiveRoom(PERSONAL_ROOM_ID);

    // Reported, not folded in: an archived room is still its participants' to read.
    expect(await roomParent(PERSONAL_ROOM_ID).authorizeViewer(viewer(PERSONAL_ROOM_ID, AUTHOR_ID)))
      .toEqual({ authorized: true, archived: true });
    expect(await roomParent(PERSONAL_ROOM_ID).authority({ workspaceId: WORKSPACE_ID, parentId: PERSONAL_ROOM_ID }))
      .toEqual({ exists: true, authorityGeneration: 1, archived: true });
  });

  it("AutomationDO admits the author, every member of a workspace automation, and a room automation's participants", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID, PARTICIPANT_ID]);
    const personal = await seedAutomation("personal", null);
    const shared = await seedAutomation("workspace", null);
    const owned = await seedAutomation("workstream", PERSONAL_ROOM_ID);

    expect(await automationStub(personal).authorizeViewer(viewer(personal, AUTHOR_ID)))
      .toEqual({ authorized: true, archived: false });
    expect(await automationStub(personal).authorizeViewer(viewer(personal, MEMBER_ID)))
      .toEqual({ authorized: false, archived: false });
    expect(await automationStub(shared).authorizeViewer(viewer(shared, MEMBER_ID)))
      .toEqual({ authorized: true, archived: false });
    // The room's automation is the room's: a participant who never wrote it
    // may open it, a member outside the room may not.
    expect(await automationStub(owned).authorizeViewer(viewer(owned, PARTICIPANT_ID)))
      .toEqual({ authorized: true, archived: false });
    expect(await automationStub(owned).authorizeViewer(viewer(owned, MEMBER_ID)))
      .toEqual({ authorized: false, archived: false });
    expect(await automationStub(owned).listChildren({ workspaceId: WORKSPACE_ID, parentId: owned }))
      .toEqual({ children: [{ substreamId: "0", kind: "main", createdAt: expect.any(Number) }] });

    // Archiving the room archives its automation's conversations; deleting an
    // automation archives its own. The author still reads, with the archive
    // reported. A participant who never wrote it does not: WorkspaceDO's
    // participation predicate answers false for an archived room, so the
    // automation's room-scope answer closes with the room. That is what the
    // object does today; whether a former participant should keep reading a
    // finished room's automation, as they keep reading the room itself, is a
    // product decision this assertion exists to surface rather than settle.
    await archiveRoom(PERSONAL_ROOM_ID);
    expect(await automationStub(owned).authorizeViewer(viewer(owned, AUTHOR_ID)))
      .toEqual({ authorized: true, archived: true });
    expect(await automationStub(owned).authorizeViewer(viewer(owned, PARTICIPANT_ID)))
      .toEqual({ authorized: false, archived: true });
    expect(await automationStub(owned).authority({ workspaceId: WORKSPACE_ID, parentId: owned }))
      .toEqual({ exists: true, authorityGeneration: 1, archived: true });
    await automationStub(personal).remove({
      workspaceId: WORKSPACE_ID,
      automationId: personal,
      actor: { userId: AUTHOR_ID, actorRole: "member", participantOfOwningWorkstream: false },
    });
    expect(await automationStub(personal).authorizeViewer(viewer(personal, AUTHOR_ID)))
      .toEqual({ authorized: false, archived: true });
    expect(await automationStub(personal).authority({ workspaceId: WORKSPACE_ID, parentId: personal }))
      .toEqual({ exists: true, authorityGeneration: 1, archived: true });
  });

  it("carries a parent's archive into the socket admission, and the conversation then refuses a write", async () => {
    await seedRoom(PERSONAL_ROOM_ID, "personal", [AUTHOR_ID]);
    const owned = await seedAutomation("workstream", PERSONAL_ROOM_ID);
    const service = new ConversationService(socketEnv, AUTH);

    const live = await verifySocketTicket(socketEnv, (await service.socketTicket(owned)).ticket);
    expect(live).toMatchObject({ parentKind: "automation", parentId: owned, substreamId: "0" });
    expect(live.admission?.parentArchived).toBe(false);

    await archiveRoom(PERSONAL_ROOM_ID);

    const issued = await service.socketTicket(owned);
    const archived = await verifySocketTicket(socketEnv, issued.ticket);
    expect(archived.admission?.parentArchived).toBe(true);

    // The upgrade the Worker performs with that ticket, against the real
    // conversation object, which admits the reader and refuses the write.
    const response = await new SocketService(socketEnv).upgrade(owned, "0", issued.ticket, new Request(
      `https://api.test/socket/conversations/${owned}/0?ticket=${encodeURIComponent(issued.ticket)}`,
      { headers: { Upgrade: "websocket", Origin: "app://avalon" } },
    ));
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (!socket) throw new Error("the upgrade carried no socket");
    socket.accept();
    try {
      const failed = nextFrameOfType(socket, "client_command_failed");
      socket.send(JSON.stringify({
        type: "create_message",
        operationId: "00000000-0000-7000-8000-00000000ad3e",
        payload: { clientMessageId: "archived-parent-write", text: "Still there?" },
      }));
      expect(await failed).toMatchObject({
        command: "create_message",
        clientMessageId: "archived-parent-write",
        error: { status: 409, code: "conversation_parent_archived" },
      });
    } finally {
      socket.close(1000, "done");
    }
    const written = await runInDurableObject(conversation(owned), (_instance, state) =>
      state.storage.sql.exec<{ count: number }>(
        `SELECT COUNT(*) AS count FROM canonical_conversation_turn_details WHERE client_message_id = 'archived-parent-write'`,
      ).one().count);
    expect(written).toBe(0);
  });
});
