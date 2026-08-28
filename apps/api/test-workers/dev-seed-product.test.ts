/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The development product seed, on real workerd.
 *
 * `pnpm db:open-authority` posts `packages/db/seed-product.json` at this route,
 * and every local stack's fixtures come from it. When transcript retirement
 * dropped `_runtime_messages` out from under a route still inserting into it,
 * the seed began failing with `no such table` and every seeded work stream
 * opened empty — for long enough to be written into `docs/dev-environment.md`
 * as known broken. Nothing in CI noticed, because the only other check that
 * covers this route (`pnpm smoke:local`) needs two running Workers.
 *
 * Three claims here need the runtime rather than the Node suite's stand-ins:
 * the seed reaches a real Durable Object through the same ports every
 * post-cutover producer writes through; the fixture's recorded sequence
 * numbers survive being *assigned* by the object's own counter rather than
 * carried in the insert; and posting twice — the repair
 * `scripts/open-local-authority.mjs` documents as idempotent — adds nothing.
 */

import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app";
import type { Env } from "../src/env";
import { createMessageObjectPort } from "../src/runtime/message-port";
import { seedOpenWorkstreamAuthority } from "./helpers/substream-fixture";

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000005d1";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000005d2";
const USER_ID = "00000000-0000-7000-8000-0000000005d3";
const RUN_ID = "00000000-0000-7000-8000-0000000005d4";

/**
 * The route refuses to run anywhere but a development Worker, and the workerd
 * test config is `APP_ENV=test` because every other suite in it should be
 * refused. Overriding the two variables for this app is the gate being
 * satisfied, not bypassed.
 */
function developmentEnv(): Env {
  return { ...env, APP_ENV: "development", RALLY_DEV_AUTH: "true" };
}

/**
 * A fixture in the shape `seed-product.json` uses, small enough to read.
 *
 * The two message types are the point: a `text` message is appended as a
 * participant message and a `tool` card is upserted under its own id, and the
 * retired view's insert trigger was the thing that used to tell them apart.
 */
function fixture(overrides: Record<string, unknown> = {}) {
  return {
    workspaceId: WORKSPACE_ID,
    workspaceTables: {},
    workstreams: [{
      id: WORKSTREAM_ID,
      title: "Seeded work stream",
      objective: "Prove the fixture reaches the object",
      harnessStatus: "needs_input",
      // Deliberately past the last message: a captured work stream has drawn
      // sequence numbers the transcript does not account for.
      nextSequenceNumber: 7,
      participants: [{
        user_id: USER_ID,
        added_by_user_id: USER_ID,
        participation_reason: "creator",
        joined_at: "2026-07-31T19:20:00.000Z",
      }],
      harnessRuns: [{
        id: RUN_ID,
        origin: "message",
        execution_principal_json: JSON.stringify({ type: "user", userId: USER_ID }),
        status: "completed",
        started_at: "2026-07-31T19:34:58.000Z",
        completed_at: "2026-07-31T19:40:00.000Z",
        terminalized_at: "2026-07-31T19:40:00.000Z",
        created_at: "2026-07-31T19:34:58.000Z",
      }],
      toolInvocations: [{
        id: "00000000-0000-7000-8000-0000000005d5",
        harness_run_id: RUN_ID,
        tool_call_id: "seed-tool-1",
        tool_name: "Search invoice error events",
        connection_id: null,
        input_hash: "seed-search-invoice-errors",
        input_json: JSON.stringify({ query: "invoice retry failures" }),
        output_summary: "Found 18 related events across three deploys.",
        status: "completed",
        started_at: "2026-07-31T19:35:00.000Z",
        completed_at: "2026-07-31T19:35:42.000Z",
      }],
      resourceIds: [],
      messages: [
        {
          id: "00000000-0000-7000-8000-0000000005e1",
          client_message_id: "seed-1",
          author_type: "human",
          author_user_id: USER_ID,
          message_type: "text",
          text_content: "Investigate the invoice retries.",
          structured_content_json: null,
          sequence_number: 1,
          created_at: "2026-07-31T19:20:00.000Z",
          harness_run_id: null,
        },
        {
          // No client message id, as a captured non-member message has none.
          id: "00000000-0000-7000-8000-0000000005e2",
          client_message_id: null,
          author_type: "agent",
          author_user_id: null,
          message_type: "tool",
          text_content: "",
          structured_content_json: JSON.stringify({
            invocation: {
              id: "00000000-0000-7000-8000-0000000005d5",
              harnessRunId: RUN_ID,
              toolCallId: "seed-tool-1",
              toolName: "Search invoice error events",
              connectionId: null,
              status: "completed",
              inputSummary: "Search recent invoice retry failures",
              outputSummary: "Found 18 related events across three deploys.",
              startedAt: "2026-07-31T19:35:00.000Z",
              completedAt: "2026-07-31T19:35:42.000Z",
              error: null,
            },
          }),
          sequence_number: 2,
          created_at: "2026-07-31T19:35:42.000Z",
          harness_run_id: RUN_ID,
        },
      ],
      ...overrides,
    }],
  };
}

async function seed(body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await createApp().fetch(
    new Request("https://api.test/dev/seed-product", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    developmentEnv(),
  );
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Read the seeded transcript back through the authority that owns it. */
async function transcript(): Promise<Array<{ sequence: number; type: string; id: string }>> {
  const port = createMessageObjectPort(developmentEnv(), WORKSPACE_ID, WORKSTREAM_ID);
  const rows = await port.messagesAfter({ afterSequence: 0, limit: 50 });
  return rows.map((message) => ({
    sequence: message.sequence_number,
    type: message.message_type,
    id: message.id,
  }));
}

beforeAll(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
  // The directory projection the seed's identity writes commit alongside asks
  // D1 which of the work stream's participants is still an active member.
  // Declared so those background effects settle instead of throwing into the
  // pool as an unhandled rejection.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL,
    PRIMARY KEY (workspace_id, user_id)
  )`).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, status)
     VALUES (?, ?, 'active')`,
  ).bind(WORKSPACE_ID, USER_ID).run();
  // The post-0090 regional shape: D1 keeps the routing anchor, the object keeps
  // the product. `bootstrapWorkstreamRuntimeEnvironment` writes both rows.
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    do_identity_anchor INTEGER NOT NULL
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
    workspace_id TEXT NOT NULL,
    workstream_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL,
    object_name TEXT NOT NULL,
    state TEXT NOT NULL,
    stage_index INTEGER NOT NULL,
    source_cursor INTEGER NOT NULL,
    source_fence_sequence INTEGER NOT NULL,
    source_hash TEXT,
    target_hash TEXT,
    row_counts_json TEXT,
    imported_at TEXT,
    verified_at TEXT,
    activated_at TEXT,
    last_error_code TEXT,
    updated_at TEXT NOT NULL
  )`).run();
});

describe("the development product seed", () => {
  it("writes the fixture's transcript into the object with its recorded sequence numbers", async () => {
    const first = await seed(fixture());
    expect(first.status).toBe(200);
    expect((first.body as { workstreams: Array<{ copied: Record<string, number> }> })
      .workstreams[0]?.copied).toMatchObject({ messages: 2, tool_effects: 1 });

    expect(await transcript()).toEqual([
      { sequence: 1, type: "text", id: "00000000-0000-7000-8000-0000000005e1" },
      { sequence: 2, type: "tool", id: "00000000-0000-7000-8000-0000000005e2" },
    ]);
  });

  it("leaves the captured next sequence number in place for the next append", async () => {
    const port = createMessageObjectPort(developmentEnv(), WORKSPACE_ID, WORKSTREAM_ID);
    const appended = await port.appendMessage({
      messageId: "00000000-0000-7000-8000-0000000005e9",
      clientMessageId: "after-the-seed",
      authorType: "human",
      authorUserId: USER_ID,
      externalActorJson: null,
      messageType: "text",
      text: "And now a real send.",
      structuredContentJson: null,
      producedByRunId: null,
      now: Date.parse("2026-08-01T09:00:00.000Z"),
    });
    // The fixture's own numbers are 1 and 2; 7 is what the captured work stream
    // had reached. Restoring it before the transcript would have numbered the
    // seeded messages 7 and 8 and left this append at 9.
    expect(appended).toMatchObject({ outcome: "appended", sequenceNumber: 7 });
  });

  it("adds nothing when the seed is posted a second time", async () => {
    const before = await transcript();
    const second = await seed(fixture());
    expect(second.status).toBe(200);
    expect(await transcript()).toEqual(before);
  });
});
