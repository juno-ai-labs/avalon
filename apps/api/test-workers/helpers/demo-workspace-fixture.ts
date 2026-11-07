/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * One demo workspace on real workerd, for the seeder and the readiness barrier.
 *
 * The regional rows the creation paths write around the object calls, a
 * presenter and two cast members as active workspace members, and the register
 * row the receipts belong to. Column lists follow the checked-in migrations;
 * the foreign keys are left out because nothing here turns on them — the Node
 * suite proves those against the real migration.
 *
 * The pack is the placeholder's shape in miniature: a Canvas with a scripted
 * prompt, two versions of one artifact, a document, an unscripted line and a
 * question; a Canvas open to the Organization; and, in the Sidekick pack, a
 * Sidekick shared with the presenter whose one run wrote a Canvas, and a line
 * in its shared conversation.
 */

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";

import { asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";

import type { Env } from "../../src/env";
import { conversationObjectName, workspaceDOName } from "../../src/durable-objects/names";
import type { AgentLoopDO } from "../../src/durable-objects/agent-loop-do";
import { DemoPackSchema } from "../../src/services/demo-pack";
import {
  applyDemoSeedAction,
  openDemoSeedSession,
  settleDemoSeedAction,
  type DemoSeedReceipt,
  type DemoSeedSession,
} from "../../src/services/demo-seeder";
import { seedWorkspaceControlPlane } from "./substream-fixture";

export const DEMO_WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000d5a1");
export const DEMO_PRESENTER_ID = asUserId("00000000-0000-7000-8000-00000000d5a2");
export const DEMO_PRIYA_ID = asUserId("00000000-0000-7000-8000-00000000d5a3");
export const DEMO_MARCUS_ID = asUserId("00000000-0000-7000-8000-00000000d5a4");
export const DEMO_SESSION_ID = "00000000-0000-7000-8000-00000000d5a5";
export const DEMO_OPERATION_ID = "00000000-0000-7000-8000-00000000d5a6";

/**
 * Alarm delivery and the loop's drain under cross-file contention, never a
 * slow query; wide for the same reason the pipeline suite's budgets are.
 */
export const DEMO_RUN_SETTLE_TIMEOUT_MS = 15_000;

export const DEMO_OPENING_PROSE = "Here is the memo. The short version: bundle Insights into Growth.";
export const DEMO_QUESTION = "Which position should I write the renewal proposal against?";
export const DEMO_MEMO_V2 = "# Insights pricing\n\nRecommendation: bundle, at no uplift for Northgate.\n";

export const DEMO_TEST_PACK = DemoPackSchema.parse({
  version: "workerd-test",
  roles: ["presenter", "priya", "marcus"],
  roleLabels: { priya: "Product", marcus: "Sales" },
  steps: [
    {
      kind: "create_canvas",
      id: "memo-open",
      canvas: "memo",
      as: "priya",
      title: "Insights pricing",
      sharedWith: ["marcus"],
      prompt: "I need a decision memo on Insights pricing before the Northgate renewal.",
      assistant: { kind: "say", text: DEMO_OPENING_PROSE },
    },
    { kind: "canvas_artifact", id: "memo-v1", canvas: "memo", path: "insights-pricing.md", title: "Insights pricing",
      content: "# Insights pricing\n\nRecommendation: bundle.\n" },
    { kind: "canvas_artifact", id: "memo-v2", canvas: "memo", path: "insights-pricing.md", title: "Insights pricing",
      content: DEMO_MEMO_V2 },
    {
      kind: "upload",
      id: "memo-attach",
      canvas: "memo",
      as: "marcus",
      title: "Northgate usage",
      fileName: "northgate-usage.md",
      mimeType: "text/markdown",
      content: "# Northgate usage\n\nA year of Insights usage, weekly.\n",
    },
    { kind: "canvas_message", id: "marcus-1", canvas: "memo", as: "marcus", text: "Legally nothing. Practically, they have a year of usage." },
    {
      kind: "canvas_message",
      id: "marcus-2",
      canvas: "memo",
      as: "marcus",
      text: "Rally, take the positions above and tell me which one to write against.",
      assistant: {
        kind: "ask",
        prompt: DEMO_QUESTION,
        options: ["Include Insights at no uplift", "Include Insights at the $4k uplift"],
      },
    },
    {
      kind: "create_canvas",
      id: "plan-open",
      canvas: "plan",
      as: "marcus",
      title: "Renewal plan",
      sharedWith: "organization",
      prompt: "Draft the renewal plan.",
      assistant: { kind: "say", text: "Here is the renewal plan." },
    },
  ],
  verify: ["presenter"],
});

export const DEMO_SIDEKICK_NAME = "Morning briefing";
export const DEMO_BRIEFING_PROSE = "Two decisions have a date on them. Northgate is the near one.";
export const DEMO_BRIEFING_CANVAS = "Morning briefing · Nov 6";

/**
 * The test pack with a Sidekick after its Canvases: published, on a schedule,
 * shared with the presenter, one run behind it that wrote a Canvas, and a line
 * in its conversation.
 */
export const DEMO_SIDEKICK_PACK = DemoPackSchema.parse({
  ...DEMO_TEST_PACK,
  steps: [
    ...DEMO_TEST_PACK.steps,
    {
      kind: "sidekick",
      id: "morning-briefing",
      sidekick: "briefing",
      as: "priya",
      sharedWith: ["presenter"],
      name: DEMO_SIDEKICK_NAME,
      description: "Posts a short briefing each weekday morning.",
      overview: "Every weekday at 9am Pacific it writes one briefing on what needs a decision.",
      instructions: "Each weekday morning, write one briefing for the workspace. Keep it under 200 words.",
      schedule: {
        rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        timezone: "America/Los_Angeles",
        summary: "Every weekday at 9:00am Pacific",
      },
      firstRun: { kind: "say", text: DEMO_BRIEFING_PROSE },
      canvas: { title: DEMO_BRIEFING_CANVAS, path: "briefing.md", content: "# Briefing\n\nNorthgate first.\n" },
    },
    { kind: "sidekick_message", id: "briefing-reply", sidekick: "briefing", as: "priya", text: "@{presenter}, Northgate is yours." },
  ],
});

export function demoWorkspaceStub() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", DEMO_WORKSPACE_ID)));
}

/** A conversation of the demo workspace: a Canvas's Chat, a Sidekick's shared conversation, or one of its runs. */
export function demoConversationStub(parentId: string, substreamId = "0"): DurableObjectStub<AgentLoopDO> {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", DEMO_WORKSPACE_ID, parentId, asSubstreamId(substreamId)),
  )) as DurableObjectStub<AgentLoopDO>;
}

/**
 * The test Worker carries no email address key and no session signing key to
 * derive one from; the artifact hostname allocator needs one, and it is
 * configuration, not behaviour under test.
 */
export function demoSeedEnv(): Env {
  return new Proxy(env, {
    get: (current, property, receiver) => property === "WORKSTREAM_EMAIL_ADDRESS_KEY"
      ? "workerd-test-email-address-key-0123456789"
      : Reflect.get(current, property, receiver),
  });
}

/** Call after `reset()`: the regional rows, the cast, the register row, the workspace object. */
export async function seedDemoWorkspaceControlPlane(): Promise<void> {
  await seedWorkspaceControlPlane(env.DB, {
    workspaceId: DEMO_WORKSPACE_ID,
    userId: DEMO_PRESENTER_ID,
    sessionId: DEMO_SESSION_ID,
  });
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT, verified_at TEXT,
      activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, object_name), UNIQUE (workstream_id, generation)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_email_routes (
      email_address TEXT PRIMARY KEY COLLATE NOCASE, address_source TEXT NOT NULL,
      region TEXT NOT NULL, workspace_id TEXT NOT NULL, workstream_id TEXT,
      automation_subscription_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE (region, workspace_id, workstream_id)
    )`),
    env.DB.prepare(`INSERT INTO users (id, email, name, avatar_url, timezone, created_at) VALUES
      (?, 'priya@example.com', 'Priya Raman', NULL, 'UTC', '2026-01-01T00:00:00.000Z'),
      (?, 'marcus@example.com', 'Marcus Hale', NULL, 'UTC', '2026-01-01T00:00:00.000Z')`)
      .bind(DEMO_PRIYA_ID, DEMO_MARCUS_ID),
    env.DB.prepare(`INSERT INTO workspace_members (workspace_id, user_id, status, role, last_seen_at) VALUES
      (?, ?, 'active', 'member', NULL), (?, ?, 'active', 'member', NULL)`)
      .bind(DEMO_WORKSPACE_ID, DEMO_PRIYA_ID, DEMO_WORKSPACE_ID, DEMO_MARCUS_ID),
    env.DB.prepare(`CREATE TABLE demo_operations (
      operation_id TEXT PRIMARY KEY, company_name TEXT NOT NULL, presenter_user_id TEXT NOT NULL,
      pack_version TEXT NOT NULL, cast_json TEXT NOT NULL, workspace_id TEXT UNIQUE, status TEXT NOT NULL,
      attempt INTEGER NOT NULL, failed_phase TEXT, error_code TEXT, error_message TEXT,
      ready_at TEXT, retired_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`INSERT INTO demo_operations
      (operation_id, company_name, presenter_user_id, pack_version, cast_json, workspace_id, status, attempt, created_at, updated_at)
      VALUES (?, 'Alto Capital', ?, 'workerd-test', '{}', ?, 'running', 1, '2026-09-07T12:00:00.000Z', '2026-09-07T12:00:00.000Z')`)
      .bind(DEMO_OPERATION_ID, DEMO_PRESENTER_ID, DEMO_WORKSPACE_ID),
    env.DB.prepare(DEMO_SEED_RECEIPTS_TABLE),
  ]);
  await demoWorkspaceStub().initializeWorkspace(DEMO_WORKSPACE_ID, "wnam");
}

/** `demo_seed_receipts` as D1 migration 0125 leaves it. */
export const DEMO_SEED_RECEIPTS_TABLE = `CREATE TABLE demo_seed_receipts (
  operation_id TEXT NOT NULL, action_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create_canvas', 'canvas_message', 'canvas_artifact', 'upload', 'sidekick', 'sidekick_message')),
  canvas TEXT, canvas_id TEXT, sidekick TEXT, sidekick_id TEXT, sidekick_run_id TEXT, turn_id TEXT,
  harness_run_id TEXT, run_outcome TEXT, elicitation_id TEXT, resource_id TEXT,
  completed_at TEXT NOT NULL, PRIMARY KEY (operation_id, action_id),
  CHECK (
    CASE kind
      WHEN 'sidekick' THEN canvas IS NULL AND sidekick IS NOT NULL AND sidekick_id IS NOT NULL
      WHEN 'sidekick_message' THEN canvas IS NULL AND canvas_id IS NULL
        AND sidekick IS NOT NULL AND sidekick_id IS NOT NULL AND turn_id IS NOT NULL
      ELSE canvas IS NOT NULL AND canvas_id IS NOT NULL AND sidekick IS NULL AND sidekick_id IS NULL
    END
  )
)`;

export async function openDemoTestSession(pack = DEMO_TEST_PACK): Promise<DemoSeedSession> {
  return openDemoSeedSession(demoSeedEnv(), {
    operationId: DEMO_OPERATION_ID,
    workspaceId: DEMO_WORKSPACE_ID,
    pack,
    roles: { presenter: DEMO_PRESENTER_ID, priya: DEMO_PRIYA_ID, marcus: DEMO_MARCUS_ID },
  });
}

/**
 * Apply one action and confirm it, the way the preparation operation's step
 * does — with the conversation's alarm forced between the two, because under
 * a contended workers shard the seeder's own polling reads can starve the
 * auto-fired alarm that executes the run.
 */
export async function playDemoAction(
  session: DemoSeedSession,
  action: DemoSeedSession["actions"][number],
): Promise<DemoSeedReceipt> {
  const progress = await applyDemoSeedAction(demoSeedEnv(), session, action);
  if (progress.state === "run_pending") {
    await runDurableObjectAlarm(demoConversationStub(progress.canvasId));
  }
  if (progress.state === "sidekick_run_pending") {
    // Two alarms, in order: the Organization's, which provisions the Sidekick's
    // run and hands it to its own conversation, and then that conversation's,
    // which executes it.
    await runDurableObjectAlarm(demoWorkspaceStub());
    await runDurableObjectAlarm(demoConversationStub(progress.sidekickId, progress.sidekickRunId));
  }
  return settleDemoSeedAction(demoSeedEnv(), session, progress, {
    deadlineAt: Date.now() + DEMO_RUN_SETTLE_TIMEOUT_MS,
  });
}
