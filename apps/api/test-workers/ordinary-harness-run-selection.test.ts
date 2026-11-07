/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A work stream's *ordinary* harness run, chosen against real object storage.
 *
 * Inline children live in `runs` beside the roots a member started and carry
 * `parent_tool_call_id`. Every reader that means "the run this work stream is
 * on" excludes them. Selecting one hands a subscriber a run it is not watching
 * and hands a scheduler a run it must not reuse.
 *
 * This replaces a suite that asserted four call sites' SQL *text*. That suite
 * could only fail when a string moved — which is exactly what happened: the
 * query moved into the object and the assertion was retargeted at the new
 * spelling rather than at the rule. The rule is asserted here instead, against
 * the object that decides it, with the fixture ordered so dropping the
 * exclusion returns the wrong run rather than none.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asWorkstreamId, type WorkstreamId } from "@rally/contracts";

import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { AgentLoopDO } from "../src/durable-objects/agent-loop-do";
import {
  USER_ID,
  WORKSPACE_ID,
  seedOpenWorkstreamAuthority,
} from "./helpers/substream-fixture";

const SESSION_ID = "00000000-0000-7000-8000-0000000009b1";
const ORDINARY = "00000000-0000-7000-8000-0000000009a1";
const INLINE_CHILD = "00000000-0000-7000-8000-0000000009a3";

const auth = {
  sessionId: SESSION_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  region: "global" as const,
  role: "member" as const,
};

beforeEach(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_pins (
      workstream_id TEXT NOT NULL, user_id TEXT NOT NULL, position INTEGER,
      PRIMARY KEY (workstream_id, user_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS connector_connections (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, scope TEXT NOT NULL,
      owner_user_id TEXT, display_name TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT, abandoned_at TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (access_class TEXT NOT NULL DEFAULT 'member', incarnation TEXT DEFAULT 'existing-member',
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, last_seen_at TEXT, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (workspace_incarnation TEXT DEFAULT 'existing-member',
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL,
      impersonator_user_id TEXT
    )`),
    env.DB.prepare(`INSERT OR REPLACE INTO workspaces(id, region) VALUES (?, 'global')`)
      .bind(WORKSPACE_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO workspace_members
      (workspace_id, user_id, status, role) VALUES (?, ?, 'active', 'member')`)
      .bind(WORKSPACE_ID, USER_ID),
    env.DB.prepare(`INSERT OR REPLACE INTO sessions
      (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(SESSION_ID, USER_ID, WORKSPACE_ID),
  ]);
  // The detail projection reaches the workspace object for the viewer-facing
  // half of a work stream, and that object refuses every request until it knows
  // which workspace it is.
  await env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  )).initializeWorkspace(WORKSPACE_ID, "wnam");
  // Generous, and only because of the interleave: a sibling file's `reset()`
  // takes every object's input gate, so this hook can wait out a full reset
  // before it gets to run at all. The seed itself takes milliseconds — a
  // failure here is a hang, never a slow query.
}, 30_000);

let unique = 0;
/**
 * A fresh work stream per test; a reused object would carry the last one's runs.
 *
 * The *name* stays canonical — the object re-derives it and refuses a request
 * whose identity does not match — so the id it is derived from is what varies.
 */
function agent(): { stub: DurableObjectStub<AgentLoopDO>; workstreamId: WorkstreamId } {
  unique += 1;
  const workstreamId = asWorkstreamId(
    `00000000-0000-7000-8000-${String(unique).padStart(9, "0")}9a0`,
  );
  return {
    stub: env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      conversationObjectName("global", WORKSPACE_ID, workstreamId),
    )),
    workstreamId,
  };
}

function seedRun(
  state: DurableObjectState,
  runId: string,
  input: { origin: string; parentToolCallId: string | null; createdAt: number },
): void {
  // These are historical candidates, so make them completed rather than
  // introducing unrelated live executions into a selection test. Which run a
  // work stream *reports* does not turn on status.
  state.storage.sql.exec(
    `INSERT INTO runs
       (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
        next_action_cursor, input_fence_seq, revision, started_at, completed_at,
        active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
        tool_count, input_tokens, output_tokens, cost_micros, output_bytes, origin,
        parent_tool_call_id, execution_principal_json, chain_depth, created_at, updated_at)
     VALUES (?, '0', 'completed', '{}', 0, 0, '', 0, 0, ?, ?, 0, 0, 0, 0, 0, 0,
             0, 0, 0, 0, ?, ?, '{}', 0, ?, ?)`,
    runId,
    input.createdAt,
    input.createdAt,
    input.origin,
    input.parentToolCallId,
    input.createdAt,
    input.createdAt,
  );
}

/** Bootstrap, seat the reader, and give the object the title its contract requires. */
async function openWorkstream(
  stub: DurableObjectStub<AgentLoopDO>,
  workstreamId: WorkstreamId,
): Promise<void> {
  expect((await stub.bootstrapRuntime({
    workspaceId: WORKSPACE_ID,
    parentKind: "workstream",
    parentId: workstreamId,
    generation: 1,
  })).status).toBe(200);
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO participants
         (user_id, participation_reason, added_by_user_id, status, participant_epoch,
          added_at, removed_at, updated_at)
       VALUES (?, 'creator', ?, 'active', 0, 1, NULL, 1)`,
      USER_ID,
      USER_ID,
    );
    // `bootstrapRuntime` opens an untitled object and the detail contract
    // requires a title, so a fixture that skipped this would fail on the schema
    // rather than on the rule under test.
    state.storage.sql.exec(
      `UPDATE workstream SET title = 'Ordinary run selection' WHERE id = 1`,
    );
  });
}

async function latestRunId(stub: DurableObjectStub<AgentLoopDO>): Promise<string | null> {
  const detail = await stub.handleProductRequest({ operation: "get", auth });
  expect(detail.status).toBe(200);
  return (JSON.parse(detail.bodyJson) as { latestHarnessRunId: string | null })
    .latestHarnessRunId;
}

describe("the ordinary harness run a work stream reports", () => {
  it("is the member's run, not the newer inline child", async () => {
    const { stub, workstreamId } = agent();
    await openWorkstream(stub, workstreamId);
    await runInDurableObject(stub, (_instance, state) => {
      // Deliberately the losing order — the ordinary run is the *oldest*, so
      // `ORDER BY created_at DESC` reaches the machinery first. A fixture with
      // the ordinary run newest would pass with no exclusions at all.
      seedRun(state, ORDINARY, {
        origin: "user_message",
        parentToolCallId: null,
        createdAt: 1_000,
      });
      seedRun(state, INLINE_CHILD, {
        origin: "tool_call",
        parentToolCallId: "call-1",
        createdAt: 3_000,
      });
    });

    const detail = await stub.handleProductRequest({ operation: "get", auth });

    expect(detail.status).toBe(200);
    expect(JSON.parse(detail.bodyJson)).toMatchObject({
      latestHarnessRunId: ORDINARY,
      latestHarnessRun: { id: ORDINARY, origin: "user_message" },
    });
  });

  it("reports nothing rather than an inline child when that is all there is", async () => {
    const { stub, workstreamId } = agent();
    await openWorkstream(stub, workstreamId);
    await runInDurableObject(stub, (_instance, state) => {
      // The excluded rows are excluded, not merely out-ranked. A work stream
      // whose only rows are machinery has no run to show, and saying so is the
      // difference between an empty status and a member watching a block's run
      // as though it were their own.
      seedRun(state, INLINE_CHILD, {
        origin: "tool_call",
        parentToolCallId: "call-1",
        createdAt: 3_000,
      });
    });

    await expect(latestRunId(stub)).resolves.toBeNull();
  });

  it("prefers the newest ordinary run when a work stream has had several", async () => {
    const { stub, workstreamId } = agent();
    await openWorkstream(stub, workstreamId);
    const newerOrdinary = "00000000-0000-7000-8000-0000000009a4";
    await runInDurableObject(stub, (_instance, state) => {
      seedRun(state, ORDINARY, {
        origin: "user_message",
        parentToolCallId: null,
        createdAt: 1_000,
      });
      // Older than the inline child, so the exclusion cannot be mistaken for
      // ordering: a reader that kept the child would return the wrong row.
      seedRun(state, newerOrdinary, {
        origin: "user_message",
        parentToolCallId: null,
        createdAt: 2_500,
      });
      seedRun(state, INLINE_CHILD, {
        origin: "tool_call",
        parentToolCallId: "call-1",
        createdAt: 3_000,
      });
    });

    await expect(latestRunId(stub)).resolves.toBe(newerOrdinary);
  });
});
