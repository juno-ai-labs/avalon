/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Dictation admission, against the object that owns it.
 *
 * The ticket is one-time, two caps bound how many sessions are live, and a
 * refused admission does not hand the ticket back. All three are decided by
 * `WorkspaceDO.admitTranscriptionSession` in one critical section; they used to
 * be separate statements the service sent through the workspace runtime facade,
 * and the suite that covered them built its own SQLite tables to answer those
 * statements — a fixture that could drift from the object's real schema
 * (`STRICT`, the `CHECK`s, the identity fences) without any test noticing.
 * These are the same four properties, asserted where they actually hold.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import { WorkspaceTranscriptionAdmitResultSchema } from "../src/durable-objects/workspace-transcription-protocol";
import {
  MAX_CONCURRENT_USER_TRANSCRIPTION_SESSIONS,
  MAX_CONCURRENT_WORKSPACE_TRANSCRIPTION_SESSIONS,
  TRANSCRIPTION_SESSION_LEASE_SECONDS,
} from "../src/durable-objects/workspace-transcription-storage";

/** Its own workspace: a shared id makes this file queue behind its siblings. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000c1b00");
const USER = asUserId("00000000-0000-7000-8000-0000000c1b01");
const NOW_S = 1_800_000_000;

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
}

let sequence = 0;
function nextId(): string {
  sequence += 1;
  return `00000000-0000-7000-8000-${String(sequence).padStart(12, "0")}`;
}

async function admit(input: {
  ticketId?: string;
  userId?: string;
  nowSeconds?: number;
} = {}) {
  const nowSeconds = input.nowSeconds ?? NOW_S;
  return WorkspaceTranscriptionAdmitResultSchema.parse(await workspace().admitTranscriptionSession({
    workspaceId: WORKSPACE_ID,
    userId: input.userId ?? USER,
    ticketId: input.ticketId ?? nextId(),
    ticketExpiresAtSeconds: nowSeconds + 60,
    sessionId: nextId(),
    nowSeconds,
  }));
}

/** The session rows the object actually holds, so a test can read the lease. */
async function sessions(): Promise<Array<{ id: string; expires_at_s: number }>> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec<{
    id: string;
    expires_at_s: number;
  }>(`SELECT id, expires_at_s FROM realtime_transcription_sessions ORDER BY id`).toArray());
}

beforeEach(async () => {
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(`DELETE FROM realtime_transcription_sessions`);
    state.storage.sql.exec(`DELETE FROM realtime_transcription_ticket_receipts`);
  });
}, 30_000);

describe("dictation admission", () => {
  it("consumes each signed ticket exactly once", async () => {
    const ticketId = nextId();
    expect((await admit({ ticketId })).outcome).toBe("admitted");
    expect((await admit({ ticketId })).outcome).toBe("ticket_replayed");
  });

  it("leases the admitted session for the lease length, from the caller's clock", async () => {
    const result = await admit();
    expect(result.expiresAtSeconds).toBe(NOW_S + TRANSCRIPTION_SESSION_LEASE_SECONDS);
    expect((await sessions())[0]?.expires_at_s).toBe(NOW_S + TRANSCRIPTION_SESSION_LEASE_SECONDS);
  });

  it("bounds one person's concurrent sessions and keeps a refused ticket consumed", async () => {
    for (let index = 0; index < MAX_CONCURRENT_USER_TRANSCRIPTION_SESSIONS; index += 1) {
      expect((await admit()).outcome).toBe("admitted");
    }
    const refused = nextId();
    expect((await admit({ ticketId: refused })).outcome).toBe("concurrency_limit");

    // Freeing a slot does not make the spent ticket usable again: it was spent
    // on the attempt that was refused, and handing it back would turn one
    // ticket into two admissions.
    const [first] = await sessions();
    await workspace().releaseTranscriptionSession({ workspaceId: WORKSPACE_ID, sessionId: first!.id });
    expect((await admit({ ticketId: refused })).outcome).toBe("ticket_replayed");
    expect((await admit()).outcome).toBe("admitted");
  });

  it("bounds aggregate workspace concurrency across distinct people", async () => {
    for (let index = 0; index < MAX_CONCURRENT_WORKSPACE_TRANSCRIPTION_SESSIONS; index += 1) {
      expect((await admit({
        userId: asUserId(`00000000-0000-7000-8000-${String(index).padStart(9, "0")}b20`),
      })).outcome).toBe("admitted");
    }
    expect((await admit({
      userId: asUserId("00000000-0000-7000-8000-0000000c1b0f"),
    })).outcome).toBe("concurrency_limit");
  });

  it("sweeps a lapsed session so its slot comes back without anyone releasing it", async () => {
    // A socket that died without closing cleanly leaves its row behind. The
    // next admission is what collects it, which is why the caps are counted
    // against live rows rather than against every row.
    for (let index = 0; index < MAX_CONCURRENT_USER_TRANSCRIPTION_SESSIONS; index += 1) {
      expect((await admit()).outcome).toBe("admitted");
    }
    const later = NOW_S + TRANSCRIPTION_SESSION_LEASE_SECONDS + 1;
    expect((await admit({ nowSeconds: later })).outcome).toBe("admitted");
    expect(await sessions()).toHaveLength(1);
  });

  it("renews a live lease without replacing the session", async () => {
    await admit();
    const [session] = await sessions();
    const renewed = await workspace().renewTranscriptionSession({
      workspaceId: WORKSPACE_ID,
      sessionId: session!.id,
      nowSeconds: NOW_S + 60,
    });
    expect(renewed).toEqual({
      renewed: true,
      expiresAtSeconds: NOW_S + 60 + TRANSCRIPTION_SESSION_LEASE_SECONDS,
    });
    const after = await sessions();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(session!.id);
  });

  it("says so rather than resurrecting a lease for a session that is gone", async () => {
    await admit();
    const [session] = await sessions();
    await workspace().releaseTranscriptionSession({ workspaceId: WORKSPACE_ID, sessionId: session!.id });
    expect(await workspace().renewTranscriptionSession({
      workspaceId: WORKSPACE_ID,
      sessionId: session!.id,
      nowSeconds: NOW_S + 60,
    })).toEqual({ renewed: false, expiresAtSeconds: null });
    expect(await sessions()).toHaveLength(0);
  });

  it("refuses a request addressed to a different workspace", async () => {
    // Called on the instance rather than through a stub. An RPC call returns a
    // pipelining proxy that rejects separately from the promise the assertion
    // attaches to, so a refusal asserted over RPC leaves that second rejection
    // unhandled — noise in every run of this file, and a failure the day the
    // runner treats those as fatal. The subject is `assertWorkspace`, not the
    // transport.
    const outcome = await runInDurableObject(workspace(), async (instance) =>
      instance.admitTranscriptionSession({
        workspaceId: asWorkspaceId("00000000-0000-7000-8000-0000000c1b0e"),
        userId: USER,
        ticketId: nextId(),
        ticketExpiresAtSeconds: NOW_S + 60,
        sessionId: nextId(),
        nowSeconds: NOW_S,
      }).then(() => null, (error: unknown) => error));
    expect(String(outcome)).toContain("workspace_object_identity_mismatch");
  });
});
