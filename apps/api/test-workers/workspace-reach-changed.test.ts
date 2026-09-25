/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * `workspace_reach_changed`, on real workerd.
 *
 * The event is a socket message and nothing else — nothing durable is written
 * for it — so the suite opens real workspace sockets and reads what each one
 * is sent. The addressing is the point: the person whose membership moved and
 * whoever holds an impersonation relationship to them hear it; nobody else
 * does, and nothing but a join or a leave sends it.
 */
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  asWorkstreamId,
  WorkspaceReachChangedEventSchema,
  WorkspaceSocketSyncEventSchema,
  WorkspaceWorkstreamStateEventSchema,
  type UserId,
  type WorkstreamId,
} from "@rally/contracts";
import {
  conversationEffectHash,
  ParentEffectEnvelopeSchema,
  type ParentEffect,
} from "@rally/contracts/conversation-effects";

import { workspaceDOName } from "../src/durable-objects/names";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000e200");
const OPERATOR = asUserId("00000000-0000-7000-8000-00000000e201");
const REPRESENTED = asUserId("00000000-0000-7000-8000-00000000e202");
const BYSTANDER = asUserId("00000000-0000-7000-8000-00000000e203");
const CHANNEL = asWorkstreamId("00000000-0000-7000-8000-00000000e204");
const BREAKOUT = asSubstreamId("00000000-0000-7000-8000-00000000e205");

const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", WORKSPACE_ID));

let effectSequence = 0;
function messageId(): string {
  effectSequence += 1;
  return `00000000-0000-7000-8000-${String(effectSequence).padStart(10, "0")}e2`;
}

async function establishWorkspace(): Promise<void> {
  const members = [OPERATOR, REPRESENTED, BYSTANDER];
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT, access_class TEXT NOT NULL DEFAULT 'member',
      revision INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      workspace_incarnation TEXT DEFAULT 'existing-member',
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces(id, region) VALUES (?, 'global')`).bind(WORKSPACE_ID),
    ...members.flatMap((userId) => [
      env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
        (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', 'member', 'member')`)
        .bind(WORKSPACE_ID, userId),
      env.DB.prepare(`INSERT OR REPLACE INTO sessions
        (id, user_id, workspace_id, region, revoked_at, expires_at)
        VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
        .bind(`reach-session-${userId}`, userId, WORKSPACE_ID),
    ]),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await workspace().upsertImpersonationRelationships({
    workspaceId: WORKSPACE_ID,
    relationships: [{
      impersonatorUserId: OPERATOR,
      representedUserId: REPRESENTED,
      authorityBasis: "test:reach",
    }],
  });
}

function channelCommon(): ParentEffect {
  return {
    kind: "directory_common",
    title: "Launch",
    description: "",
    preview: "",
    scope: "workspace",
    state: "idle",
    systemKind: null,
    lastActivityAt: "2026-09-24T00:00:00.000Z",
    completedAt: null,
    archivedAt: null,
    createdByUserId: OPERATOR,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
    resourceLinks: [],
  };
}

function breakoutCommon(): ParentEffect {
  return {
    kind: "directory_common",
    title: "Pricing",
    description: "",
    preview: "",
    scope: "personal",
    state: "idle",
    systemKind: null,
    lastActivityAt: "2026-09-24T00:00:00.000Z",
    completedAt: null,
    archivedAt: null,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
  } as ParentEffect;
}

function viewer(userId: UserId, isParticipant: boolean, unreadCount = 0): ParentEffect {
  return {
    kind: "directory_user",
    userId,
    isParticipant,
    participantAddedAt: isParticipant ? "2026-09-24T00:00:00.000Z" : null,
    unreadCount,
    youAreMentioned: false,
    unseen: false,
    listable: true,
    seenAttentionOrdinal: 0,
    manualUnreadFromOrdinal: null,
    manualUnreadGeneration: 0,
    latestMentionAttentionOrdinal: 0,
  };
}

async function project(
  workstreamId: WorkstreamId,
  effects: readonly ParentEffect[],
  sourceVersion: number,
  substreamId?: string,
): Promise<void> {
  await workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: effects.map((effect) => ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect",
      contractVersion: 1,
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: workstreamId,
      ...(substreamId ? { substreamId } : {}),
      generation: 1,
      messageId: messageId(),
      partitionKey: effect.kind === "directory_user" ? `user:${effect.userId}` : "common",
      sourceVersion,
      requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(effect),
      effect,
    })),
  });
}

let ticketSequence = 0;

/** A subscribed workspace socket recording every reach event and Channel row it is sent. */
async function connect(userId: UserId): Promise<{ reach: string[][]; channelRows: number }> {
  ticketSequence += 1;
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": userId,
      "x-rally-session-id": `reach-session-${userId}`,
      "x-rally-socket-ticket-id": `00000000-0000-7000-8000-${String(ticketSequence).padStart(12, "0")}`,
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`workspace socket rejected: ${response.status} ${await response.text()}`);
  }
  const socket = response.webSocket;
  socket.accept();
  const received = { reach: [] as string[][], channelRows: 0 };
  const subscribed = new Promise<void>((resolve) => {
    socket.addEventListener("message", (event) => {
      const data = JSON.parse(String(event.data)) as unknown;
      const reach = WorkspaceReachChangedEventSchema.safeParse(data);
      if (reach.success) received.reach.push([...reach.data.userIds]);
      if (WorkspaceWorkstreamStateEventSchema.safeParse(data).success) received.channelRows += 1;
      if (WorkspaceSocketSyncEventSchema.safeParse(data).success) resolve();
    });
  });
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  await subscribed;
  return received;
}

beforeEach(async () => {
  await reset();
  effectSequence = 0;
  await establishWorkspace();
  await project(CHANNEL, [channelCommon()], 1);
});

describe("workspace_reach_changed", () => {
  it("tells the person and whoever can act as them when they join or leave a Channel, and nobody else", async () => {
    const operator = await connect(OPERATOR);
    const represented = await connect(REPRESENTED);
    const bystander = await connect(BYSTANDER);

    await project(CHANNEL, [viewer(REPRESENTED, true)], 2);
    await project(CHANNEL, [viewer(REPRESENTED, false)], 3);
    // The operator's own join names the operator: a marker no wrong event for
    // the represented person could be mistaken for. Its arrival on every socket
    // that should hear it bounds the wait for the silence of the others.
    await project(CHANNEL, [viewer(OPERATOR, true)], 4);
    await vi.waitFor(() => {
      expect(operator.reach).toEqual([[REPRESENTED], [REPRESENTED], [OPERATOR]]);
      expect(bystander.channelRows).toBeGreaterThan(2);
    });
    // Nobody acts as the operator, so the represented person never hears them.
    expect(represented.reach).toEqual([[REPRESENTED], [REPRESENTED]]);
    expect(bystander.reach).toEqual([]);
  });

  it("stays quiet for a projection that moves no membership", async () => {
    await project(CHANNEL, [viewer(REPRESENTED, true)], 2);
    const operator = await connect(OPERATOR);

    await project(CHANNEL, [viewer(REPRESENTED, true, 4)], 3);
    await project(CHANNEL, [viewer(BYSTANDER, true)], 4);
    await project(CHANNEL, [viewer(OPERATOR, true)], 5);
    await vi.waitFor(() => expect(operator.reach).toContainEqual([OPERATOR]));
    expect(operator.reach).toEqual([[OPERATOR]]);
  });

  it("tells the operator when the person they can act as joins or leaves a Breakout, and not on an unread move", async () => {
    await project(CHANNEL, [viewer(REPRESENTED, true)], 2);
    const operator = await connect(OPERATOR);

    await project(CHANNEL, [breakoutCommon(), viewer(REPRESENTED, true)], 1, BREAKOUT);
    await project(CHANNEL, [viewer(REPRESENTED, true, 2)], 2, BREAKOUT);
    await project(CHANNEL, [viewer(REPRESENTED, false)], 3, BREAKOUT);
    await project(CHANNEL, [viewer(OPERATOR, true)], 1, BREAKOUT);
    await vi.waitFor(() => expect(operator.reach).toContainEqual([OPERATOR]));
    expect(operator.reach).toEqual([[REPRESENTED], [REPRESENTED], [OPERATOR]]);
  });

  it("tells the operator when a Breakout drops the row of somebody who left the Organization", async () => {
    await project(CHANNEL, [viewer(REPRESENTED, true)], 2);
    await project(CHANNEL, [breakoutCommon(), viewer(REPRESENTED, true)], 1, BREAKOUT);
    const operator = await connect(OPERATOR);

    // Removal the way the product does it: D1 deletes the row and the
    // relationship change event tells the Organization object, whose member
    // table is what the directory reads.
    await env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
      .bind(WORKSPACE_ID, REPRESENTED).run();
    expect(await workspace().applyMemberStatus({
      workspaceId: WORKSPACE_ID,
      sequence: 1,
      removed: true,
      relationship: {
        workspaceId: WORKSPACE_ID, userId: REPRESENTED, accessClass: "member", role: "member",
        status: "active", incarnation: "existing-member", revision: 1,
      },
    })).toEqual({ applied: true });
    // The event drops their rows itself, in its own transaction, so the drop
    // is the moment the operator is owed the notice.
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT user_id FROM breakout_viewers WHERE user_id = ?", REPRESENTED,
      ).toArray()).toEqual([]);
    });
    // A projection still in flight for them is refused and moves nothing.
    await project(CHANNEL, [viewer(REPRESENTED, true, 1)], 2, BREAKOUT);
    await project(CHANNEL, [viewer(OPERATOR, true)], 1, BREAKOUT);
    await vi.waitFor(() => expect(operator.reach).toContainEqual([OPERATOR]));
    expect(operator.reach).toEqual([[REPRESENTED], [OPERATOR]]);
  });

  it("tells an operator their relationships changed, and goes quiet about somebody they can no longer act as", async () => {
    const operator = await connect(OPERATOR);

    await workspace().upsertImpersonationRelationships({
      workspaceId: WORKSPACE_ID,
      relationships: [{ impersonatorUserId: OPERATOR, representedUserId: BYSTANDER, authorityBasis: "test:reach" }],
    });
    await vi.waitFor(() => expect(operator.reach).toEqual([[OPERATOR]]));

    await workspace().revokeImpersonationRelationships({
      workspaceId: WORKSPACE_ID, impersonatorUserId: OPERATOR, representedUserId: REPRESENTED,
    });
    await vi.waitFor(() => expect(operator.reach).toEqual([[OPERATOR], [OPERATOR]]));

    await project(CHANNEL, [viewer(REPRESENTED, true)], 2);
    await project(CHANNEL, [viewer(BYSTANDER, true)], 3);
    await vi.waitFor(() => expect(operator.reach).toHaveLength(3));
    expect(operator.reach).toEqual([[OPERATOR], [OPERATOR], [BYSTANDER]]);
  });
});
