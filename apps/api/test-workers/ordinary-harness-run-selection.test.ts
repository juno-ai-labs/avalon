/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A work stream's *ordinary* harness run, chosen against real object storage.
 *
 * Two kinds of row live in `runs` beside the runs a member started: an inline
 * child, which a tool spawns and which carries `parent_tool_call_id`, and a
 * HyperSight block's own run, which carries `origin = 'block_dashboard_block'`.
 * Every reader that means "the run this work stream is on" excludes both.
 * Selecting one of them hands a subscriber a run it is not watching, and hands
 * a scheduler a run it must not reuse.
 *
 * This replaces a suite that asserted four call sites' SQL *text*. That suite
 * could only fail when a string moved — which is exactly what happened: the
 * query moved into the object and the assertion was retargeted at the new
 * spelling rather than at the rule. The rule is asserted here instead, against
 * the object that decides it, with the fixture ordered so that dropping either
 * exclusion returns the wrong run rather than none.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { asWorkstreamId, type WorkstreamId } from "@rally/contracts";

import { substreamAgentName, workspaceDOName } from "../src/durable-objects/names";
import type { SubstreamAgent } from "../src/durable-objects/substream-agent";
import {
  USER_ID,
  WORKSPACE_ID,
  seedOpenWorkstreamAuthority,
} from "./helpers/substream-fixture";

const SESSION_ID = "00000000-0000-7000-8000-0000000009b1";
const ORDINARY = "00000000-0000-7000-8000-0000000009a1";
const HYPERSIGHT = "00000000-0000-7000-8000-0000000009a2";
const INLINE_CHILD = "00000000-0000-7000-8000-0000000009a3";

const auth = {
  sessionId: SESSION_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  region: "global" as const,
  role: "member" as const,
};

beforeAll(async () => {
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
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL
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
});

let unique = 0;
/**
 * A fresh work stream per test; a reused object would carry the last one's runs.
 *
 * The *name* stays canonical — the object re-derives it and refuses a request
 * whose identity does not match — so the id it is derived from is what varies.
 */
function agent(): { stub: DurableObjectStub<SubstreamAgent>; workstreamId: WorkstreamId } {
  unique += 1;
  const workstreamId = asWorkstreamId(
    `00000000-0000-7000-8000-${String(unique).padStart(9, "0")}9a0`,
  );
  return {
    stub: env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, workstreamId),
    )),
    workstreamId,
  };
}

function seedRun(
  state: DurableObjectState,
  runId: string,
  input: { origin: string; parentToolCallId: string | null; createdAt: number },
): void {
  // `completed`, so `runs_mutating_substream_uq` — one live non-block run per
  // substream — stays out of the way. Which run a work stream *reports* does
  // not turn on status, and a fixture that had to keep three live runs on one
  // substream would be describing a state production forbids.
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
  stub: DurableObjectStub<SubstreamAgent>,
  workstreamId: WorkstreamId,
): Promise<void> {
  expect((await stub.bootstrapRuntime({
    workspaceId: WORKSPACE_ID,
    workstreamId,
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

async function latestRunId(stub: DurableObjectStub<SubstreamAgent>): Promise<string | null> {
  const detail = await stub.handleProductRequest({ operation: "get", auth });
  expect(detail.status).toBe(200);
  return (JSON.parse(detail.bodyJson) as { latestHarnessRunId: string | null })
    .latestHarnessRunId;
}

describe("the ordinary harness run a work stream reports", () => {
  it("is the member's run, not the newer HyperSight run or inline child", async () => {
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
      seedRun(state, HYPERSIGHT, {
        origin: "block_dashboard_block",
        parentToolCallId: null,
        createdAt: 2_000,
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

  it("reports nothing rather than a HyperSight run when that is all there is", async () => {
    const { stub, workstreamId } = agent();
    await openWorkstream(stub, workstreamId);
    await runInDurableObject(stub, (_instance, state) => {
      // The excluded rows are excluded, not merely out-ranked. A work stream
      // whose only rows are machinery has no run to show, and saying so is the
      // difference between an empty status and a member watching a block's run
      // as though it were their own.
      seedRun(state, HYPERSIGHT, {
        origin: "block_dashboard_block",
        parentToolCallId: null,
        createdAt: 2_000,
      });
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
      // Between the two machinery rows in time, so the exclusions cannot be
      // mistaken for the ordering: a reader that kept them but ranked by
      // insertion order would still pick the older ordinary run.
      seedRun(state, newerOrdinary, {
        origin: "user_message",
        parentToolCallId: null,
        createdAt: 2_500,
      });
      seedRun(state, HYPERSIGHT, {
        origin: "block_dashboard_block",
        parentToolCallId: null,
        createdAt: 2_000,
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
