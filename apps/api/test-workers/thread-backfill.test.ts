/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * One-off jobs over every thread, on real workerd.
 *
 * What this proves is WorkspaceDO's half (`thread-backfill.ts`): that the
 * work RPC answers Main and each open Breakout, settles a thread with nothing
 * to do, and that the lane keeps one batch in flight. The last case runs the
 * Queue consumer against a real Main conversation and checks the row settles;
 * the summary step itself is proved in `workstream-naming.test.ts`.
 */
import { env } from "cloudflare:workers";
import { createExecutionContext, createMessageBatch, getQueueResult, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import {
  conversationEffectHash,
  ParentEffectEnvelopeSchema,
  type ParentEffect,
} from "@rally/contracts/conversation-effects";

import { conversationObjectName } from "../src/durable-objects/names";
import { consumeActivityQueue } from "../src/queues/activity-consumer";
import { nextThreadBackfillAt, publishThreadBackfill } from "../src/durable-objects/thread-backfill";
import { hostedParentStub } from "./helpers/hosted-parent";
import { boot, seedWorkstreamRoot } from "./helpers/substream-fixture";
import { publishConversationViews } from "../src/durable-objects/conversation-view-projection";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000e800");
const OWNER = asUserId("00000000-0000-7000-8000-00000000e801");
const THREAD = asWorkstreamId("00000000-0000-7000-8000-00000000e802");
const BREAKOUT = asSubstreamId("00000000-0000-7000-8000-00000000e803");

const workspace = () => hostedParentStub(env, WORKSPACE_ID);

let effectSequence = 0;

function messageId(): string {
  effectSequence += 1;
  return `00000000-0000-7000-8000-${String(effectSequence).padStart(10, "0")}e8`;
}

async function establishWorkspace(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT, access_class TEXT NOT NULL DEFAULT 'member',
      last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces(id, region) VALUES (?, 'global')`)
      .bind(WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role, access_class) VALUES (?, ?, 'active', 'owner', 'member')`)
      .bind(WORKSPACE_ID, OWNER),
  ]);
  await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
}

function commonEffect(archivedAt: string | null = null): ParentEffect {
  return {
    kind: "directory_common",
    title: "Launch plan",
    description: "",
    preview: "",
    scope: "workspace",
    state: "idle",
    systemKind: null,
    lastActivityAt: "2026-10-12T00:00:00.000Z",
    completedAt: null,
    archivedAt,
    createdByUserId: OWNER,
    latestAttentionOrdinal: 0,
    unreadTrackingStartOrdinal: 0,
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    resourceLinks: [],
  };
}

/** A thread's (or, with `substreamId`, a Breakout's) projection, as the directory receives it. */
async function project(sourceVersion: number, substreamId?: string, archivedAt: string | null = null): Promise<void> {
  const effect = commonEffect(archivedAt);
  await workspace().applyWorkstreamDirectoryEffects({
    workspaceId: WORKSPACE_ID,
    envelopes: [ParentEffectEnvelopeSchema.parse({
      kind: "parent_effect",
      contractVersion: 1,
      region: "global",
      workspaceId: WORKSPACE_ID,
      parentKind: "workstream",
      parentId: THREAD,
      ...(substreamId ? { substreamId } : {}),
      generation: 1,
      messageId: messageId(),
      partitionKey: "common",
      sourceVersion,
      requiredProjectionVersion: null,
      payloadHash: conversationEffectHash(effect),
      effect,
    })],
  });
}

function message(workstreamId: string = THREAD, attempt = 1) {
  return {
    type: "thread_backfill" as const, job: "description_summary" as const,
    region: "global" as const, workspaceId: WORKSPACE_ID, workstreamId, attempt,
  };
}

/** Whether the thread is still listed for the job. */
async function listed(workstreamId: string = THREAD): Promise<boolean> {
  return runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
    "SELECT 1 FROM thread_backfill WHERE job = 'description_summary' AND workstream_id = ?", workstreamId,
  ).toArray().length > 0);
}

/** List a thread as migration 100 would have, had it existed when the migration ran. */
async function list(workstreamId: string = THREAD): Promise<void> {
  await runInDurableObject(workspace(), (_instance, state) => {
    state.storage.sql.exec(
      `INSERT INTO thread_backfill(job, workstream_id, attempts, not_before)
         VALUES ('description_summary', ?, 0, 0) ON CONFLICT DO NOTHING`,
      workstreamId,
    );
  });
}

beforeEach(async () => {
  await reset();
  effectSequence = 0;
  await establishWorkspace();
});

describe("a one-off job over every thread", () => {
  it("keeps a preview backfill claimed until WorkspaceDO receives the source projection", async () => {
    await project(1);
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO parent_children(parent_id, substream_id, kind, created_at)
        VALUES (?, '0', 'main', 1) ON CONFLICT DO NOTHING`, THREAD);
      state.storage.sql.exec(`INSERT INTO thread_backfill(job, workstream_id, attempts, not_before, in_flight)
        VALUES ('conversation_view', ?, 1, ?, 1) ON CONFLICT DO NOTHING`, THREAD, Date.now() + 60_000);
    });
    const main = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, THREAD));
    await boot(main);
    await runInDurableObject(main, (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: THREAD });
    });
    const consume = async (bodies: unknown[]) => {
      const batch = createMessageBatch("avalon-global-activity", bodies.map((body) => ({
        id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body,
      })));
      await consumeActivityQueue(batch, env);
      return getQueueResult(batch, createExecutionContext());
    };
    const backfill = { ...message(), job: "conversation_view" };
    expect((await consume([backfill])).retryMessages).toEqual([]);
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      "SELECT in_flight FROM thread_backfill WHERE job = 'conversation_view' AND workstream_id = ?", THREAD,
    ).toArray())).toEqual([{ in_flight: 1 }]);
    const identity = { type: "conversation_view_v1" as const, region: "global" as const,
      workspaceId: WORKSPACE_ID, parentId: THREAD, substreamId: asSubstreamId("0") };
    const claims = await runInDurableObject(main, async (_instance, state) => {
      await publishConversationViews(state.storage.sql, env.ACTIVITY_QUEUE, identity);
      return state.storage.sql.exec<{ turn_id: string; in_flight_revision: number }>(
        "SELECT turn_id, in_flight_revision FROM conversation_view_changes WHERE in_flight_revision IS NOT NULL",
      ).toArray();
    });
    await consume(claims.map((row) => ({ ...identity, turnId: row.turn_id, dispatchRevision: row.in_flight_revision })));
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      "SELECT parent_id FROM conversation_view_headers WHERE parent_id = ?", THREAD,
    ).toArray())).toEqual([{ parent_id: THREAD }]);
    await consume([backfill]);
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      "SELECT 1 FROM thread_backfill WHERE job = 'conversation_view' AND workstream_id = ?", THREAD,
    ).toArray())).toEqual([]);
  });

  it("settles a preview backfill whose Main is an identity-only placeholder", async () => {
    await project(1);
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO thread_backfill(job, workstream_id, attempts, not_before, in_flight)
        VALUES ('conversation_view', ?, 1, ?, 1) ON CONFLICT DO NOTHING`, THREAD, Date.now() + 60_000);
    });
    const main = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", WORKSPACE_ID, THREAD));
    await boot(main);
    await runInDurableObject(main, (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: THREAD });
      state.storage.sql.exec("UPDATE workstream SET authority_mode = 'preparing', authority_generation = 0 WHERE id = 1");
    });
    const batch = createMessageBatch("avalon-global-activity", [{
      id: crypto.randomUUID(), timestamp: new Date(), attempts: 1,
      body: { ...message(), job: 'conversation_view' },
    }]);
    await consumeActivityQueue(batch, env);
    expect((await getQueueResult(batch, createExecutionContext())).retryMessages).toEqual([]);
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(
      "SELECT 1 FROM thread_backfill WHERE job = 'conversation_view' AND workstream_id = ?", THREAD,
    ).toArray())).toEqual([]);
  });

  it("answers Main and each open Breakout, and settles only when told", async () => {
    await project(1);
    await project(1, BREAKOUT);
    await list();

    expect(await workspace().threadBackfillWork(message())).toEqual({ substreamIds: ["0", BREAKOUT] });
    expect(await listed()).toBe(true);
    expect(await workspace().completeThreadBackfill(message())).toBe(true);
    expect(await listed()).toBe(false);
    // A second delivery of the same row finds nothing to do.
    expect(await workspace().threadBackfillWork(message())).toBeNull();
  });

  it("settles a thread with nothing to do: archived, or never projected", async () => {
    await project(1, undefined, "2026-10-12T01:00:00.000Z");
    await list();
    expect(await workspace().threadBackfillWork(message())).toBeNull();
    expect(await listed()).toBe(false);

    const unknown = "00000000-0000-7000-8000-00000000e8ff";
    await list(unknown);
    expect(await workspace().threadBackfillWork(message(unknown))).toBeNull();
    expect(await listed(unknown)).toBe(false);
  });

  it("settles the thread when the Queue delivers it and the job has run over Main", async () => {
    await project(1);
    await list();
    const main = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, THREAD, asSubstreamId("0")),
    ));
    await boot(main);
    await runInDurableObject(main, (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: THREAD });
    });

    const batch = createMessageBatch("avalon-global-activity", [{
      id: crypto.randomUUID(), timestamp: new Date(), attempts: 1, body: message(),
    }]);
    await consumeActivityQueue(batch, env);
    await getQueueResult(batch, createExecutionContext());

    expect(await listed()).toBe(false);
  }, 60_000);

  it("keeps one batch in flight: later threads wait until the batch settles or is released", async () => {
    const [first, second, later] = ["e811", "e812", "e813"].map((suffix) => `00000000-0000-7000-8000-00000000${suffix}`);
    const publish = () => runInDurableObject(workspace(), async (_instance, state) => {
      const now = Date.now();
      await publishThreadBackfill({
        sql: state.storage.sql,
        queue: { sendBatch: async () => undefined },
        workspaceId: WORKSPACE_ID,
        region: "global",
        now,
        retryAt: () => now + 60_000,
      });
    });
    const claims = (workstreamId: string) => runInDurableObject(workspace(), (_instance, state) => state.storage.sql
      .exec<{ attempts: number }>("SELECT attempts FROM thread_backfill WHERE workstream_id = ?", workstreamId)
      .toArray()[0]?.attempts ?? null);
    await runInDurableObject(workspace(), async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM thread_backfill");
      // Arrange one batch atomically. Separate RPCs let the object's already
      // armed alarm claim the first row before the second one exists.
      state.storage.sql.exec(`INSERT INTO thread_backfill(job, workstream_id, attempts, not_before)
        VALUES ('description_summary', ?, 0, 0), ('description_summary', ?, 0, 0)`, first!, second!);
      // This test advances the publication lane explicitly below.
      await state.storage.deleteAlarm();
    });

    await publish();
    expect([await claims(first!), await claims(second!)]).toEqual([1, 1]);
    await list(later!);
    await publish();
    expect(await claims(later!)).toBe(0);
    // The wake waits for the batch's gate, not for the waiting row that is due now.
    expect(await runInDurableObject(workspace(), (_instance, state) => nextThreadBackfillAt(state.storage.sql)))
      .toBeGreaterThan(Date.now());

    expect(await workspace().completeThreadBackfill(message(first!))).toBe(true);
    await publish();
    expect(await claims(later!)).toBe(0);
    expect(await workspace().releaseThreadBackfill(message(second!))).toBe(true);
    await publish();
    expect(await claims(later!)).toBe(1);
  });

  it("refuses a release from a delivery the alarm has since claimed the row again for", async () => {
    await project(1);
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM thread_backfill");
      // Claimed twice: the first delivery outlived its gate and the alarm sent the row again.
      state.storage.sql.exec(
        `INSERT INTO thread_backfill(job, workstream_id, attempts, not_before, in_flight)
           VALUES ('description_summary', ?, 2, ?, 1)`,
        THREAD, Date.now() + 60_000,
      );
    });

    expect(await workspace().releaseThreadBackfill(message(THREAD, 1))).toBe(false);
    expect(await runInDurableObject(workspace(), (_instance, state) => state.storage.sql
      .exec<{ in_flight: number }>("SELECT in_flight FROM thread_backfill WHERE workstream_id = ?", THREAD).one().in_flight))
      .toBe(1);
    expect(await workspace().releaseThreadBackfill(message(THREAD, 2))).toBe(true);
  });
});
