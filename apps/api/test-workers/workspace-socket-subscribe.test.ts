/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A workspace socket's subscribe answer, on real workerd: a write that lands
 * while the subscribe is still answering reaches the new socket, either in the
 * answer's sidebar or as the push after it. A reconnecting desktop resubscribes
 * through exactly this path, so a write it misses here stays missing until the
 * next one. `docs/websocket-architecture.md` owns the handshake order.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import type { Env } from "../src/env";
import { createTestEnv } from "../test/helpers/cloudflare-test";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000c5000");
const USER = asUserId("00000000-0000-7000-8000-0000000c5001");
const CANVAS = "00000000-0000-7000-8000-0000000c50c1";

function workspace(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, WORKSPACE_ID)));
}

type Frame = Record<string, unknown> & { type?: string };
type CanvasList = { waterline: number; items: Array<{ id: string }> };

/**
 * Flagship cannot run here, and its answer is the subscribe's one wait. The
 * double holds every evaluation until released, and says when the first one
 * has started, so a write can be made to land inside that wait every time.
 */
async function holdFlagship(): Promise<{ entered: () => Promise<void>; release: () => void }> {
  // Flags, not promises: a promise settled in one Durable Object's context and
  // awaited in another's carries that context with it, and workerd refuses
  // the I/O the test then does.
  const gate = { entered: false, released: false };
  await runInDurableObject(workspace(), (instance: WorkspaceDO) => {
    (instance as unknown as { env: { FLAGS: Env["FLAGS"] | undefined } }).env.FLAGS = createTestEnv({ FLAGS: {
      getBooleanDetails: async () => {
        gate.entered = true;
        while (!gate.released) await new Promise((resolve) => setTimeout(resolve, 5));
        return { value: false, reason: "DEFAULT" };
      },
    } }).FLAGS;
  });
  return {
    entered: async () => { await expect.poll(() => gate.entered).toBe(true); },
    release: () => { gate.released = true; },
  };
}

async function openSocket(): Promise<{ socket: WebSocket; frames: Frame[]; drained: () => Promise<void> }> {
  const response = await workspace().fetch("https://workspace.test/socket", {
    headers: {
      Upgrade: "websocket",
      "x-rally-workspace-id": WORKSPACE_ID,
      "x-rally-placement-affinity": "wnam",
      "x-rally-user-id": USER,
      "x-rally-session-id": `session-${USER}`,
      "x-rally-socket-ticket-id": crypto.randomUUID(),
      "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1_000) + 60),
    },
  });
  if (response.status !== 101 || !response.webSocket) throw new Error(`workspace socket rejected: ${response.status}`);
  const socket = response.webSocket;
  socket.accept();
  const frames: Frame[] = [];
  let pongs = 0;
  socket.addEventListener("message", (event) => {
    if (String(event.data) === "pong") pongs += 1;
    else frames.push(JSON.parse(String(event.data)) as Frame);
  });
  const drained = async (): Promise<void> => {
    const before = pongs;
    socket.send("ping");
    await expect.poll(() => pongs).toBeGreaterThan(before);
  };
  return { socket, frames, drained };
}

/** The newest Canvas list a socket holds: the answer's, or a later push's. */
function newestCanvasList(frames: Frame[]): CanvasList | undefined {
  const lists = frames.flatMap((frame): CanvasList[] => {
    if (frame.type === "workspace_sync") {
      const canvases = (frame as { sidebar?: { canvases?: CanvasList } }).sidebar?.canvases;
      return canvases ? [canvases] : [];
    }
    return frame.type === "workspace_canvas_list" ? [frame as unknown as CanvasList] : [];
  });
  return lists.sort((a, b) => a.waterline - b.waterline).at(-1);
}

beforeEach(async () => {
  await reset();
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: USER, sessionId: `session-${USER}` });
});

describe("a workspace socket's subscribe", () => {
  it("delivers a Canvas created while it is still answering", async () => {
    await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
    const flagship = await holdFlagship();
    const { socket, frames, drained } = await openSocket();
    try {
      socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
      await flagship.entered();

      // Lands inside the subscribe, before its answer is sent.
      await workspace().canvasCreate({ workspaceId: WORKSPACE_ID, canvasId: CANVAS, title: "Launch",
        createdByUserId: USER, authorityGeneration: 1 });
      flagship.release();
      await expect.poll(() => frames.some((frame) => frame.type === "workspace_sync")).toBe(true);
      await drained();

      expect(newestCanvasList(frames)?.items.map((item) => item.id)).toEqual([CANVAS]);
    } finally {
      socket.close(1000, "test complete");
    }
  });
});
