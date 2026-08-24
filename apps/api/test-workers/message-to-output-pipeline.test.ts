/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The complete member-visible pipeline: a message goes in, something comes out.
 *
 * This drives the SubstreamAgent through its real product endpoint — the same
 * one WorkspaceDO's socket calls — with real D1 session auth, and then lets the
 * real alarm execute the run. Nothing is seeded into the object by hand; every
 * row the pipeline needs is created by the pipeline.
 *
 * The test worker has no model credentials, so no run can produce a model
 * reply. That is the point of the oracle here: a healthy pipeline must carry
 * the run all the way to the provider boundary and fail *there*, visibly.
 * Failing anywhere earlier — admission, claim, environment assembly — is a
 * pipeline defect this suite exists to catch, and failing *silently* anywhere
 * is the outage we just had. So each case asserts three things: the run
 * reaches a terminal state (nothing hangs), the member-visible work stream
 * state reflects it (nothing lies), and the recorded error is from the
 * provider boundary, not an earlier stage (nothing rots unnoticed).
 */

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { asWorkspaceId, asWorkstreamId } from "@avalon/contracts";

import { substreamAgentName, workspaceDOName } from "../src/durable-objects/names";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-0000000005a1");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-0000000005a2");
const USER_ID = "00000000-0000-7000-8000-0000000005a3";
const SESSION_ID = "00000000-0000-7000-8000-0000000005a4";

/** Failure codes that mean the run died before the provider boundary. */
const PRE_PROVIDER_FAILURES = [
  "harness_run_not_found",
  "workstream_run_start_fenced",
  "agent_run_dispatch_undecodable",
  "workstream_runtime_cross_authority_statement",
  "workstream_run_abandoned",
];

const AUTH = {
  sessionId: SESSION_ID,
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  region: "global" as const,
  role: "member" as const,
};

beforeEach(async () => {
  await reset();
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE workstream_authority_control (
      id INTEGER PRIMARY KEY, phase TEXT NOT NULL, generation INTEGER NOT NULL,
      required_serving_contract_version INTEGER NOT NULL,
      serving_contract_version INTEGER NOT NULL
    )`),
    env.DB.prepare(`INSERT INTO workstream_authority_control
      (id, phase, generation, required_serving_contract_version, serving_contract_version)
      VALUES (1, 'durable_object_open', 1, 1, 1)`),
    env.DB.prepare(`CREATE TABLE workspaces (
      id TEXT PRIMARY KEY, region TEXT NOT NULL, analytics_workspace_id TEXT
    )`),
    env.DB.prepare(`INSERT INTO workspaces(id, region) VALUES (?, 'global')`).bind(WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL,
      role TEXT NOT NULL, last_seen_at TEXT, PRIMARY KEY (workspace_id, user_id)
    )`),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', '2026-08-18T20:00:00.000Z')`).bind(WORKSPACE_ID, USER_ID),
    env.DB.prepare(`CREATE TABLE sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      region TEXT NOT NULL, revoked_at TEXT, expires_at TEXT NOT NULL
    )`),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`)
      .bind(SESSION_ID, USER_ID, WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT, name TEXT, avatar_url TEXT, timezone TEXT, created_at TEXT
    )`),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'member@example.com', 'Member', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
      .bind(USER_ID),
  ]);
  // The product's workspace reads route to the WorkspaceDO, which refuses
  // requests until it knows who it is — exactly as production bootstraps it.
  const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(
    workspaceDOName("global", WORKSPACE_ID),
  ));
  await workspace.initializeWorkspace(WORKSPACE_ID, "wnam");
});

function agentStub(): DurableObjectStub {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
  ));
}

async function product(stub: DurableObjectStub, body: unknown): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  const response = await stub.fetch("https://object.test/internal/product", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function initializeWorkstream(stub: DurableObjectStub, openingMessage: string): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  return product(stub, {
    operation: "initialize",
    auth: AUTH,
    input: {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      generation: 1,
      title: "Pipeline",
      objective: "",
      descriptionSource: "derived",
      titleStatus: "settled",
      emailAddress: null,
      creatorUserId: USER_ID,
      openingMessage,
      clientMessageId: "pipeline-open-1",
      participantUserIds: [],
      attachmentIds: [],
      modelOverride: null,
      executionPrincipal: { type: "user", userId: USER_ID },
      reason: "user_message",
    },
  });
}

interface RunRow extends Record<string, SqlStorageValue> {
  run_id: string;
  status: string;
  error_json: string | null;
  terminalized_at: number | null;
  final_part_id: string | null;
}

/** Polls the object until the run settles; a run that never settles fails here. */
async function settledRun(stub: DurableObjectStub, runId: string): Promise<RunRow> {
  // Invoke the public object alarm while holding the object-local test fence.
  // This joins an automatically consumed alarm instead of racing a wall-clock
  // poll against it, and proves the same production callback deterministically.
  await runInDurableObject(stub, async (instance) => {
    await (instance as unknown as { alarm(): Promise<void> }).alarm();
  });
  let lastRow: RunRow | null = null;
  let lastDispatches = "[]";
  let lastAlarm: number | null = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const row = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec<RunRow>(
        `SELECT run_id, status, error_json, terminalized_at, final_part_id
           FROM runs WHERE run_id = ?`,
        runId,
      ).toArray()[0] ?? null);
    if (row && row.terminalized_at !== null) return row;
    lastRow = row;
    const diagnostics = await runInDurableObject(stub, async (_instance, state) => ({
      alarm: await state.storage.getAlarm(),
      dispatches: state.storage.sql.exec(
        `SELECT run_id, state, attempt, available_at, lease_expires_at, last_error_code
           FROM agent_run_dispatches ORDER BY created_at, run_id`,
      ).toArray(),
    }));
    lastAlarm = diagnostics.alarm;
    lastDispatches = JSON.stringify(diagnostics.dispatches);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `run ${runId} never reached a terminal state — row=${JSON.stringify(lastRow)} `
    + `alarm=${String(lastAlarm)} dispatches=${lastDispatches}`,
  );
}

function failureCode(row: RunRow): string {
  const parsed = row.error_json ? JSON.parse(row.error_json) as { code?: string } : {};
  return parsed.code ?? "";
}

describe("a member's message travels the whole pipeline", () => {
  it("initialize admits a run and carries it to the provider boundary", async () => {
    const stub = agentStub();

    const opened = await initializeWorkstream(stub, "please look into this");
    expect(opened.status).toBe(200);
    const runId = opened.body.harnessRunId as string;
    expect(runId).toBeTruthy();

    const run = await settledRun(stub, runId);

    // Terminal, and honestly so: with no provider credentials the run must
    // fail — but *at* the provider, past admission, claim, transcript
    // projection, and prompt assembly. The recorded inference attempt is the
    // proof the pipeline reached the model: a run that died in plumbing never
    // writes one, whatever error code the wreck happens to carry. Both halves
    // of this incident — the misrouted transcript read and the unselectable
    // resources view — failed with the same catch-all code, which is why the
    // code alone is not the oracle.
    expect(run.status).toBe("failed");
    expect(PRE_PROVIDER_FAILURES).not.toContain(failureCode(run));
    // The Bind engine's member-safe sentence is the boundary marker: a run
    // that dies in plumbing is terminalized with the generic "could not
    // complete this run" from the drain's catch, while a run that survived
    // transcript projection and prompt assembly reaches the engine, whose
    // outcomes carry the "retrying/support" family. Both halves of this
    // incident — the misrouted transcript read and the unselectable resources
    // view — carried the same failure *code*, which is why the code alone is
    // not the oracle. (The test worker has no flag service, so the engine
    // stops at endpoint selection; that is as far as any credential-less
    // environment can prove.)
    const message = (JSON.parse(String(run.error_json)) as { message?: string }).message ?? "";
    expect(message).toMatch(/Retrying is unlikely to help|try again|support/iu);

    // The member sees the truth, not a spinner: the work stream reflects the
    // failure and the object holds no outstanding dispatch or alarm debt.
    //
    // Both land after the run settles, and the *dispatch* lands last: a run
    // reaching a terminal status is not the end of the drain, which then names
    // the work stream and refreshes its description before releasing the row.
    // So both halves wait, and on the same window — waiting on the state alone
    // and then asserting on the dispatch reads whatever the drain happens to
    // have reached, which is a race the drain wins or loses by milliseconds.
    let observed = "";
    let outstanding = -1;
    // Forty tenths, not sixty: the window has to end inside the 5s test timeout
    // or a drain that never releases its row reports as "timed out" rather than
    // as the thing that is wrong with it.
    for (let attempt = 0; attempt < 40; attempt += 1) {
      [observed, outstanding] = await runInDurableObject(stub, (_instance, state) => [
        state.storage.sql.exec<{ exact_state: string }>(
          `SELECT exact_state FROM workstream WHERE id = 1`,
        ).toArray()[0]!.exact_state,
        state.storage.sql.exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM agent_run_dispatches WHERE state IN ('queued','running')`,
        ).toArray()[0]!.n,
      ] as const);
      if (observed === "failed" && outstanding === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(observed, "run failed but the member still sees it running").toBe("failed");
    expect(outstanding, "the drain left a dispatch queued").toBe(0);
    // Long enough that the bounded wait above ends first, so a drain that never
    // releases its row reports as the assertion that names it rather than as a
    // timeout. This test drives a whole run to the provider boundary; the
    // default 5s left no room for the wait, which is why the dispatch half of
    // the assertion could not have one before.
  }, 20_000);

  it("a follow-up message starts a fresh run instead of wedging behind the failed one", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "first message");
    await settledRun(stub, opened.body.harnessRunId as string);

    const followUp = await product(stub, {
      operation: "create_message",
      auth: AUTH,
      input: {
        text: "are you still there?",
        clientMessageId: "pipeline-follow-1",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    });

    expect(followUp.status).toBe(200);
    const secondRunId = followUp.body.harnessRunId as string;
    // One participant means the agent is always addressed; a follow-up that
    // admits no run would strand the member without recourse.
    expect(secondRunId).toBeTruthy();
    expect(secondRunId).not.toBe(opened.body.harnessRunId);

    const second = await settledRun(stub, secondRunId);
    expect(PRE_PROVIDER_FAILURES).not.toContain(failureCode(second));
  });

  it("message writes are idempotent across the whole path", async () => {
    const stub = agentStub();
    await initializeWorkstream(stub, "first message");

    const input = {
      text: "exactly once",
      clientMessageId: "pipeline-dup-1",
      mentions: [],
      confirmedParticipantUserIds: [],
      attachmentIds: [],
    };
    const first = await product(stub, { operation: "create_message", auth: AUTH, input });
    const repeat = await product(stub, { operation: "create_message", auth: AUTH, input });

    expect(first.status).toBe(200);
    expect(repeat.status).toBe(200);
    // The replay returns the original message and admits no second run.
    expect((repeat.body.message as { id: string }).id)
      .toBe((first.body.message as { id: string }).id);
    expect(repeat.body.harnessRunId ?? null).toBeNull();

    await runInDurableObject(stub, (_instance, state) => {
      const copies = state.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM parts WHERE client_message_id = 'pipeline-dup-1'`,
      ).toArray()[0]!;
      expect(copies.n).toBe(1);
    });
  });

  it("a revoked session cannot write into the work stream", async () => {
    const stub = agentStub();
    await initializeWorkstream(stub, "first message");
    await env.DB.prepare(
      `UPDATE sessions SET revoked_at = '2026-08-18T00:00:00.000Z' WHERE id = ?`,
    ).bind(SESSION_ID).run();

    const attempt = await product(stub, {
      operation: "create_message",
      auth: AUTH,
      input: {
        text: "should not land",
        clientMessageId: "pipeline-revoked-1",
        mentions: [],
        confirmedParticipantUserIds: [],
        attachmentIds: [],
      },
    });

    expect(attempt.status).toBe(401);
    await runInDurableObject(stub, (_instance, state) => {
      const copies = state.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM parts WHERE client_message_id = 'pipeline-revoked-1'`,
      ).toArray()[0]!;
      expect(copies.n).toBe(0);
    });
  });

  it("the failed run leaves the transcript readable and ordered", async () => {
    const stub = agentStub();
    const opened = await initializeWorkstream(stub, "the opening message");
    await settledRun(stub, opened.body.harnessRunId as string);

    await runInDurableObject(stub, (_instance, state) => {
      const counters = state.storage.sql.exec<{
        next_sequence_number: number;
        next_attention_ordinal: number;
      }>(
        `SELECT next_sequence_number, next_attention_ordinal FROM workstream WHERE id = 1`,
      ).one();
      state.storage.sql.exec(
        `INSERT INTO parts
           (id, substream_id, sequence_number, attention_ordinal, role, kind, author_type,
            content, effect_intent_id, tool_name, tool_mode, tool_status, visibility,
            pinned, created_at, updated_at)
         VALUES ('00000000-0000-7000-8000-0000000005b1', '0', ?, NULL, 'assistant', 'tool_call', 'agent', '',
                 '00000000-0000-7000-8000-0000000005b3', 'attachment_read', 'read', 'completed', 'people',
                 0, ?, ?)`,
        counters.next_sequence_number,
        Date.now(),
        Date.now(),
      );
      state.storage.sql.exec(
        `INSERT INTO parts
           (id, substream_id, sequence_number, attention_ordinal, role, kind, author_type,
            content, visibility, pinned, created_at, updated_at)
         VALUES ('00000000-0000-7000-8000-0000000005b2', '0', ?, ?, 'assistant', 'text', 'agent',
                 'answer after tool', 'both', 0, ?, ?)`,
        counters.next_sequence_number + 1,
        counters.next_attention_ordinal,
        Date.now(),
        Date.now(),
      );
      state.storage.sql.exec(
        `UPDATE workstream
            SET next_sequence_number = ?, next_attention_ordinal = ?, updated_at = ?
          WHERE id = 1`,
        counters.next_sequence_number + 2,
        counters.next_attention_ordinal + 1,
        Date.now(),
      );
    });

    const listed = await product(stub, { operation: "messages", auth: AUTH, limit: 50 });

    expect(listed.status).toBe(200);
    const items = listed.body.items as {
      id: string;
      sequenceNumber: number;
      attentionSequenceNumber?: number | null;
      content?: string;
    }[];
    expect(items.length).toBeGreaterThan(0);
    const sequences = items.map((item) => item.sequenceNumber);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(items.some((item) => item.attentionSequenceNumber === 1)).toBe(true);
    expect(items.filter((item) => [
      "00000000-0000-7000-8000-0000000005b1",
      "00000000-0000-7000-8000-0000000005b2",
    ].includes(item.id)).map((item) => item.attentionSequenceNumber ?? null))
      .toEqual([null, 2]);
  });
});
