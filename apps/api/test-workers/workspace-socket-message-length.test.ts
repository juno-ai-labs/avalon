/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * What the workspace command socket does with a message over the ceiling.
 *
 * Every other way a frame can be wrong on this socket is a client defect, and
 * closing the connection is the right answer to one. An over-long message is
 * not a defect — it is a person who pasted more than Avalon takes — and the two
 * answers are not interchangeable: a close drops the transcript they are
 * reading, carries no reason they can act on, and reconnects straight back into
 * the same refusal. The desktop stops this at the composer, so what is asserted
 * here is what a build that has not caught up is told instead.
 *
 * On real workerd because the decision is made inside `webSocketMessage`, the
 * platform's hibernation entry point, against an attachment the runtime
 * serializes onto the socket. A double for either would be asserting on the
 * double.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  asWorkspaceId,
  MESSAGE_MAX_CHARACTERS,
  MESSAGE_TOO_LONG_MESSAGE,
  WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
} from "@avalon/contracts";

import { workspaceDOName } from "../src/durable-objects/names";

/** Its own workspace, for the reason `workspace-directory-reads` states. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000009a0");
const USER_ID = "00000000-0000-7000-8000-0000000009a1";
const CLIENT_MESSAGE_ID = "00000000-0000-7000-8000-0000000009a2";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000009a3";

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

/**
 * A server socket carrying the attachment a connected client's would, plus the
 * frames the object sends back and whether it closed.
 *
 * `serializeAttachment` is the real one — the object reads its identity back
 * through `deserializeAttachment`, so an attachment written any other way would
 * be testing the test.
 */
function connectedSocket() {
  const { 1: server } = Object.values(new WebSocketPair()) as unknown as WebSocket[];
  if (!server) throw new Error("WebSocketPair produced no server socket");
  server.serializeAttachment({
    workspaceId: WORKSPACE_ID,
    userId: USER_ID,
    sessionId: "session-1",
    ticketId: "00000000-0000-7000-8000-0000000009b0",
    ticketExpiresAt: Date.now() + 60_000,
    connectionId: "00000000-0000-7000-8000-0000000009b1",
    connectedAt: new Date().toISOString(),
    subscribed: true,
    lastWaterline: 0,
  });

  const sent: string[] = [];
  const closed: Array<{ code: number; reason: string }> = [];
  const recording = new Proxy(server, {
    get(target, property) {
      if (property === "send") return (data: string) => { sent.push(data); };
      if (property === "close") return (code: number, reason: string) => { closed.push({ code, reason }); };
      // Bound to the real socket, not to the proxy: `deserializeAttachment` is
      // a native method and rejects a proxy as its `this`, which reaches the
      // object as an identity it cannot read rather than as the connection this
      // is standing in for.
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) as unknown : value;
    },
  });
  return { socket: recording, sent, closed };
}

function createMessageFrame(text: string): string {
  return JSON.stringify({
    type: "create_message",
    workstreamId: WORKSTREAM_ID,
    substreamId: "0",
    operationId: "00000000-0000-7000-8000-0000000009c0",
    payload: { text, clientMessageId: CLIENT_MESSAGE_ID, mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] },
  });
}

describe("an over-long message on the workspace command socket", () => {
  it("is answered on the socket rather than by closing it", async () => {
    const { socket, sent, closed } = connectedSocket();

    await runInDurableObject(workspace(), async (instance) => {
      await instance.webSocketMessage(socket, createMessageFrame("x".repeat(MESSAGE_MAX_CHARACTERS + 1)));
    });

    expect(closed).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0] ?? "null")).toEqual({
      type: "client_command_failed",
      command: "create_message",
      // Correlated, so the composer can retire the right optimistic turn rather
      // than the newest one.
      clientMessageId: CLIENT_MESSAGE_ID,
      error: { status: 400, code: "message_too_long", message: MESSAGE_TOO_LONG_MESSAGE },
    });
  });

  it("still closes on a frame that is malformed rather than long", async () => {
    // The guard runs ahead of the schema and must not have become the schema.
    // A frame this object cannot parse is a client defect, and the answer to one
    // is the invalid-command close rather than the recoverable message error.
    const { socket, sent, closed } = connectedSocket();

    await runInDurableObject(workspace(), async (instance) => {
      await instance.webSocketMessage(socket, JSON.stringify({ type: "create_message", payload: { text: 5 } }));
    });

    expect(sent).toEqual([]);
    expect(closed).toEqual([{
      code: WORKSPACE_SOCKET_INVALID_MESSAGE_CODE,
      reason: "Invalid workspace socket event",
    }]);
  });
});
