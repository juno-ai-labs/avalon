/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The activity queue's two memory deliveries, through the real consumer on
 * workerd: a `memory_sweep` for a Canvas's Chat reaches the sweep, which
 * records the swept range on the Organization object, and a
 * `memory_digest_sync` reaches the Organization object, which settles a row
 * whose holder is gone. Both producers outlive the Thread code the consumer
 * once kept these branches beside; a message neither branch claims is acked
 * as a legacy message and does nothing.
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asUserId, asWorkspaceId } from "@rally/contracts";

import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { workspaceDOName } from "../src/durable-objects/names";
import type { Env } from "../src/env";
import { consumeActivityQueue } from "../src/queues/activity-consumer";
import { createCanvas } from "../src/services/canvas-service";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

let WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000cd000");
const CREATOR = asUserId("00000000-0000-7000-8000-0000000cd001");
const TEST_ENV: Env = env;

function workspace(): DurableObjectStub<WorkspaceDO> {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName(env.AVALON_REGION, WORKSPACE_ID)));
}

/** One message through the consumer, as the queue delivers it; returns whether it was acked. */
async function deliver(body: unknown): Promise<{ acked: boolean; retried: boolean }> {
  const outcome = { acked: false, retried: false };
  const message = {
    id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body,
    ack: () => { outcome.acked = true; }, retry: () => { outcome.retried = true; },
  } as unknown as Message<unknown>;
  await consumeActivityQueue({
    queue: "activity", messages: [message], ackAll: () => undefined, retryAll: () => undefined,
  } as unknown as MessageBatch<unknown>, TEST_ENV);
  return outcome;
}

beforeEach(async () => {
  await reset();
  WORKSPACE_ID = asWorkspaceId(crypto.randomUUID());
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: CREATOR, sessionId: `session-${CREATOR}` });
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_email_routes (
      local_part TEXT PRIMARY KEY COLLATE NOCASE, region TEXT NOT NULL,
      workspace_id TEXT NOT NULL, workstream_id TEXT, automation_subscription_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`),
  ]);
});

describe("the activity queue's memory deliveries", () => {
  it("runs a memory sweep for a Canvas's Chat, recording the range it swept", async () => {
    const { canvasId } = await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Launch plan" });
    // Nobody has spoken, so the sweep has nothing to read and records the range unswept.
    expect(await deliver({ type: "memory_sweep", region: env.AVALON_REGION, workspaceId: WORKSPACE_ID,
      parentKind: "canvas", parentId: canvasId, substreamId: "0", fromSeq: 0, toSeq: 3, attempt: 1 }))
      .toEqual({ acked: true, retried: false });
    const receipts = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      "SELECT conversation, from_seq, to_seq, model FROM memory_sweep_receipts").toArray());
    expect(receipts).toEqual([{ conversation: `canvas:${canvasId}`, from_seq: 0, to_seq: 3, model: "none" }]);
  });

  it("settles a digest sync row on the Organization object when its holder is gone", async () => {
    // A Canvas makes the Organization object know its Organization; the row names another, long gone.
    await createCanvas(TEST_ENV, { workspaceId: WORKSPACE_ID, creatorUserId: CREATOR, title: "Launch plan" });
    const conversation = `canvas:${crypto.randomUUID()}`;
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO memory_digest_sync (conversation, revision, attempts, not_before) VALUES (?, 7, 1, 0)", conversation);
    });
    expect(await deliver({ type: "memory_digest_sync", region: env.AVALON_REGION, workspaceId: WORKSPACE_ID,
      conversation, revision: 7 })).toEqual({ acked: true, retried: false });
    const rows = await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      "SELECT conversation FROM memory_digest_sync").toArray());
    expect(rows).toEqual([]);
  });
});
