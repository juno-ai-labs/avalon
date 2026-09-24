/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The first-frame watch: a WorkspaceDO instance that accepts sockets but never
 * hears from them resets itself from its alarm.
 *
 * The production failure it answers cannot be staged here — nothing in workerd
 * can be told to stop delivering socket events — so the silent socket is a real
 * one whose client simply never sends, and the deadline is shortened on the
 * live instance. Everything else is the real object: the accept, the alarm
 * (`runDurableObjectAlarm`), the attachments, and `state.abort`.
 */

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";

const OWNER = asUserId("00000000-0000-7000-8000-000000000ff1");
let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ff0");
let workspaceSeq = 0;
let ticketSeq = 0;

/** The private members this suite drives, named once rather than cast at each use. */
interface WatchSurface {
  socketFirstFrameDeadlineMs: number;
  lastSocketEventAt: number | null;
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

/** Shorten the deadline on the live instance, so the real paths can be driven without waiting. */
async function setDeadline(ms: number): Promise<void> {
  await runInDurableObject(workspace(), (instance: WorkspaceDO) => {
    watch(instance).socketFirstFrameDeadlineMs = ms;
  });
}

async function silentSocketDeadline(): Promise<{ deadline: number; alarm: number | null; candidates: readonly number[] }> {
  return runInDurableObject(workspace(), async (instance: WorkspaceDO, state) => {
    const [server] = state.getWebSockets();
    const { connectedAt } = server!.deserializeAttachment() as { connectedAt: string };
    return {
      deadline: Date.parse(connectedAt) + watch(instance).socketFirstFrameDeadlineMs,
      alarm: await state.storage.getAlarm(),
      candidates: watch(instance).nextDerivedAlarmCandidates(),
    };
  });
}

async function currentInstance(): Promise<WorkspaceDO> {
  return runInDurableObject(workspace(), (instance: WorkspaceDO) => instance);
}

let errors: MockInstance<typeof console.error>;

beforeEach(async () => {
  workspaceSeq += 1;
  WORKSPACE_ID = asWorkspaceId(`00000000-0000-7000-8000-${String(workspaceSeq).padStart(9, "0")}ff0`);
  await establishWorkspace();
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  errors.mockRestore();
});

function resetLogged(): boolean {
  return errors.mock.calls.some(([entry]) =>
    (entry as { event?: unknown } | undefined)?.event === "workspace_socket_first_frame_missed");
}

describe("WorkspaceDO first-frame watch", () => {
  it("resets from its alarm when a socket stays silent and nothing else is heard", async () => {
    const socket = await openSilentSocket();
    const socketClosed = closed(socket);
    const before = await currentInstance();
    await setDeadline(0);

    // The real alarm path. It ends in `state.abort`, so the run itself fails.
    await runDurableObjectAlarm(workspace()).catch(() => undefined);

    expect((await socketClosed).code).toBe(1006);
    expect(await currentInstance()).not.toBe(before);
    // The reset is the signal an operator watches for, so it must be logged
    // before the abort ends the invocation.
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "workspace_socket_first_frame_missed",
      workspace_id: WORKSPACE_ID,
      missed_sockets: 1,
      open_sockets: 1,
    }));
  });

  it("still resets while the region is closed for maintenance", async () => {
    const socket = await openSilentSocket();
    const socketClosed = closed(socket);
    const before = await currentInstance();
    // A maintenance phase defers the whole alarm before its due work runs.
    await env.DB.prepare(`UPDATE workstream_authority_control SET phase = 'maintenance_draining' WHERE id = 1`).run();
    await setDeadline(0);

    await runDurableObjectAlarm(workspace()).catch(() => undefined);

    expect((await socketClosed).code).toBe(1006);
    expect(await currentInstance()).not.toBe(before);
    expect(resetLogged()).toBe(true);
  });

  // The three signals that say the object still hears sockets, each isolated:
  // one silent client must not reset everyone else, whichever way the others
  // are being heard from.
  it("does not reset while the runtime answers another socket's ping", async () => {
    const silent = await openSilentSocket();
    const idle = await openSilentSocket();
    const pong = new Promise<MessageEvent>((resolve) => idle.addEventListener("message", resolve, { once: true }));
    idle.send("ping");
    expect((await pong).data).toBe("pong");
    const before = await currentInstance();
    await setDeadline(0);

    await runDurableObjectAlarm(workspace());

    expect(await currentInstance()).toBe(before);
    expect(resetLogged()).toBe(false);
    idle.close(1000, "done");
    silent.close(1000, "done");
  });

  it("does not reset after a hibernation wake when a later socket has spoken", async () => {
    const silent = await openSilentSocket();
    const active = await openSilentSocket();
    await subscribe(active);
    const before = await currentInstance();
    await setDeadline(0);
    // What a hibernation wake forgets.
    await runInDurableObject(workspace(), (instance: WorkspaceDO) => {
      watch(instance).lastSocketEventAt = null;
    });

    await runDurableObjectAlarm(workspace());

    expect(await currentInstance()).toBe(before);
    expect(resetLogged()).toBe(false);
    active.close(1000, "done");
    silent.close(1000, "done");
  });

  it("does not reset when this instance has run a socket callback since", async () => {
    const earlier = await openSilentSocket();
    await subscribe(earlier);
    const silent = await openSilentSocket();
    const before = await currentInstance();
    // A close from a socket accepted before the silent one: no later socket
    // spoke and no ping was answered, so only the callback itself counts.
    earlier.close(1000, "done");
    await vi.waitFor(async () => {
      const heard = await runInDurableObject(workspace(), (instance: WorkspaceDO, state) => {
        const [server] = state.getWebSockets().filter((socket) =>
          !(socket.deserializeAttachment() as { subscribed: boolean }).subscribed);
        const { connectedAt } = server!.deserializeAttachment() as { connectedAt: string };
        return (watch(instance).lastSocketEventAt ?? 0) > Date.parse(connectedAt);
      });
      expect(heard).toBe(true);
    });
    await setDeadline(0);

    await runDurableObjectAlarm(workspace());

    expect(await currentInstance()).toBe(before);
    expect(resetLogged()).toBe(false);
    silent.close(1000, "done");
  });

  it("pulls the alarm in to a new socket's deadline", async () => {
    // Sooner than any wake reason the fixture workspace already has armed, so
    // only the accept-time arm can explain an alarm this early.
    await setDeadline(10_000);
    await openSilentSocket();

    const { deadline, alarm, candidates } = await silentSocketDeadline();

    expect(candidates).toContain(deadline);
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeLessThanOrEqual(deadline);
  });
});
