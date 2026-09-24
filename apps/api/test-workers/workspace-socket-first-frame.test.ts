/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The first-frame watch: a WorkspaceDO instance that accepts sockets but never
 * hears from them resets itself from its alarm.
 *
 * The production failure it answers cannot be staged here — nothing in workerd
 * can be told to stop delivering socket events — so the silent socket is a real
 * one whose client simply never sends, and the alarm's clock is moved past the
 * deadline by passing `now`. Everything between is the real object: the
 * accepted socket, its attachment, `getWebSockets`, and `state.abort`.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import {
  WORKSPACE_SOCKET_FIRST_FRAME_DEADLINE_MS,
  type WorkspaceDO,
} from "../src/durable-objects/workspace-do";

const OWNER = asUserId("00000000-0000-7000-8000-000000000ff1");
let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ff0");
let workspaceSeq = 0;
let ticketSeq = 0;

/** The private members this suite drives, named once rather than cast at each use. */
interface WatchSurface {
  resetIfSocketsMissedFirstFrame(now: number, deadlineMs: number): void;
  nextDerivedAlarmCandidates(): readonly number[];
}

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

function watch(instance: WorkspaceDO): WatchSurface {
  return instance as unknown as WatchSurface;
}

async function establishWorkspace(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, access_class TEXT NOT NULL DEFAULT 'member',
      last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (workspace_incarnation TEXT DEFAULT 'existing-member',
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
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'owner')`).bind(WORKSPACE_ID, OWNER),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions
      (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(`first-frame-session-${WORKSPACE_ID}`, OWNER, WORKSPACE_ID),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}

/** Open a socket and, like a client that died right after open, send nothing. */
async function openSilentSocket(): Promise<WebSocket> {
  ticketSeq += 1;
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": OWNER,
      "x-rally-session-id": `first-frame-session-${WORKSPACE_ID}`,
      "x-rally-socket-ticket-id": `00000000-0000-7000-8000-${String(ticketSeq).padStart(9, "0")}fa0`,
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`workspace socket rejected: ${response.status} ${await response.text()}`);
  }
  response.webSocket.accept();
  return response.webSocket;
}

async function subscribe(socket: WebSocket): Promise<void> {
  const initial = new Promise<MessageEvent>((resolve) =>
    socket.addEventListener("message", resolve, { once: true }));
  socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
  expect(JSON.parse(String((await initial).data))).toMatchObject({ type: "workspace_sync" });
}

function closed(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => socket.addEventListener("close", resolve, { once: true }));
}

async function currentInstance(): Promise<WorkspaceDO> {
  return runInDurableObject(workspace(), (instance: WorkspaceDO) => instance);
}

beforeEach(async () => {
  workspaceSeq += 1;
  WORKSPACE_ID = asWorkspaceId(`00000000-0000-7000-8000-${String(workspaceSeq).padStart(9, "0")}ff0`);
  await establishWorkspace();
});

describe("WorkspaceDO first-frame watch", () => {
  it("resets the instance and closes a socket that never sent its first frame", async () => {
    const socket = await openSilentSocket();
    const socketClosed = closed(socket);
    const before = await currentInstance();

    await expect(runInDurableObject(workspace(), (instance: WorkspaceDO) => {
      watch(instance).resetIfSocketsMissedFirstFrame(
        Date.now() + WORKSPACE_SOCKET_FIRST_FRAME_DEADLINE_MS,
        WORKSPACE_SOCKET_FIRST_FRAME_DEADLINE_MS,
      );
    })).rejects.toThrow();

    expect((await socketClosed).code).toBe(1006);
    expect(await currentInstance()).not.toBe(before);
  });

  it("leaves the instance alone once the socket has subscribed", async () => {
    const socket = await openSilentSocket();
    await subscribe(socket);
    const before = await currentInstance();

    await runInDurableObject(workspace(), (instance: WorkspaceDO) => {
      watch(instance).resetIfSocketsMissedFirstFrame(
        Date.now() + WORKSPACE_SOCKET_FIRST_FRAME_DEADLINE_MS,
        WORKSPACE_SOCKET_FIRST_FRAME_DEADLINE_MS,
      );
    });

    expect(await currentInstance()).toBe(before);
    socket.close(1000, "done");
  });

  it("counts a socket still waiting for its first frame among the alarm's wake reasons", async () => {
    await openSilentSocket();

    const { deadline, candidates } = await runInDurableObject(
      workspace(),
      (instance: WorkspaceDO, state) => {
        const [server] = state.getWebSockets();
        const { connectedAt } = server!.deserializeAttachment() as { connectedAt: string };
        return {
          deadline: Date.parse(connectedAt) + WORKSPACE_SOCKET_FIRST_FRAME_DEADLINE_MS,
          candidates: watch(instance).nextDerivedAlarmCandidates(),
        };
      },
    );

    // The accept-time `ensureAlarmNoLaterThan` is not asserted here: a fixture
    // workspace always has an earlier wake reason armed, so its alarm reads the
    // same with or without it.
    expect(candidates).toContain(deadline);
  });
});
