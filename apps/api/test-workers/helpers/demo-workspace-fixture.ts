/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * One demo workspace on real workerd, for the seeder and the readiness barrier.
 *
 * The regional rows the creation service writes around the object calls, a
 * presenter and two cast members as active workspace members with the names a
 * mention is validated against, and the register row the receipts belong to.
 * Column lists follow the checked-in migrations; the foreign keys are left out
 * because nothing here turns on them — the Node suite proves those against the
 * real migration.
 *
 * The pack is the two settled scenarios' shape in miniature: a scripted room,
 * a document, two unscripted lines, a mention of the presenter, and a question.
 */

import { env } from "cloudflare:workers";
import { runDurableObjectAlarm } from "cloudflare:test";

import { asSpaceId, asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";

import type { Env } from "../../src/env";
import { conversationObjectName, workspaceDOName } from "../../src/durable-objects/names";
import type { AgentLoopDO } from "../../src/durable-objects/agent-loop-do";
import { personalSpaceIdFor } from "../../src/durable-objects/workspace-space-protocol";
import { DemoPackSchema } from "../../src/services/demo-pack";
import {
  applyDemoSeedAction,
  openDemoSeedSession,
  settleDemoSeedAction,
  type DemoSeedReceipt,
  type DemoSeedSession,
} from "../../src/services/demo-seeder";
import { seatOrganizationMember } from "../../src/services/space-bootstrap-service";
import { claimParentAnchor } from "../../src/services/workstream-runtime-database";
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

export const DEMO_OPENING_PROSE = [
  "I have put the memo together, drawing on the Q4 plan in Drive and last week's",
  "pricing sync notes in Granola. The short version: bundle Insights into Growth.",
].join("\n");
export const DEMO_QUESTION = "Which position should I write the renewal proposal against?";
export const DEMO_MEMO_TITLE = "Insights pricing — decision memo";

export const DEMO_TEST_PACK = DemoPackSchema.parse({
  version: "workerd-test",
  roles: ["presenter", "priya", "marcus"],
  roleLabels: { priya: "Product", marcus: "Sales" },
  steps: [
    {
      kind: "create_workstream",
      id: "memo-open",
      room: "memo",
      as: "priya",
      title: "Insights pricing before the Northgate renewal",
      participants: ["marcus"],
      scope: "workspace",
      openingMessage: "I need a decision memo on Insights pricing before the Northgate renewal.",
      assistant: { kind: "say", text: DEMO_OPENING_PROSE },
    },
    {
      kind: "upload",
      id: "memo-attach",
      room: "memo",
      as: "priya",
      title: DEMO_MEMO_TITLE,
      fileName: "insights-pricing-decision-memo.md",
      mimeType: "text/markdown",
      content: "# Insights pricing — decision memo\n\nRecommendation: bundle.\n",
    },
    {
      kind: "message",
      id: "marcus-1",
      room: "memo",
      as: "marcus",
      text: "Legally nothing. Practically, they have a year of usage.",
    },
    {
      kind: "message",
      id: "priya-1",
      room: "memo",
      as: "priya",
      text: "@{presenter} you own the commercial call here.",
    },
    {
      kind: "message",
      id: "marcus-2",
      room: "memo",
      as: "marcus",
      text: "Rally, take the positions above and tell me which one to write against.",
      assistant: {
        kind: "ask",
        prompt: DEMO_QUESTION,
        options: ["Include Insights at no uplift", "Include Insights at the $4k uplift"],
      },
    },
  ],
  // The presenter is in the one room by Priya's mention and has opened nothing.
  expect: [{
    viewer: "presenter",
    attention: { waitingForYou: 1, waitingReason: "mentioned" },
    rooms: { memo: { unseen: true, hasUnread: true, mentioned: true } },
  }],
});

export const DEMO_SIDEKICK_NAME = "Morning briefing";
export const DEMO_BRIEFING_PROSE = "Two decisions have a date on them. Northgate is the near one.";

/**
 * The test pack with a Sidekick after its rooms: published, on a schedule, and
 * with one briefing already behind it. Separate from `DEMO_TEST_PACK` so the
 * room assertions there stay about rooms, and so a suite that does not need a
 * Sidekick does not pay for publishing one.
 */
export const DEMO_SIDEKICK_PACK = DemoPackSchema.parse({
  ...DEMO_TEST_PACK,
  steps: [
    ...DEMO_TEST_PACK.steps,
    {
      kind: "sidekick",
      id: "morning-briefing",
      as: "priya",
      scope: "workspace",
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
    },
  ],
});

/**
 * The test pack with one more room in front of it: a workspace-scoped room the
 * presenter is not in, so the barrier's expectation for a room somebody can
 * see without being in it — unread, not new, not mentioned — is proved against
 * the real directory rather than reasoned about, and so the listing has an
 * order to get wrong.
 */
export const DEMO_TWO_ROOM_PACK = DemoPackSchema.parse({
  ...DEMO_TEST_PACK,
  steps: [
    {
      kind: "create_workstream",
      id: "aside-open",
      room: "aside",
      as: "marcus",
      title: "Renewal quote template",
      participants: ["priya"],
      scope: "workspace",
      openingMessage: "Draft a renewal quote template we can reuse.",
      assistant: { kind: "say", text: "Here is a first pass at the template." },
    },
    ...DEMO_TEST_PACK.steps,
  ],
  expect: [{
    viewer: "presenter",
    attention: { waitingForYou: 1, waitingReason: "mentioned" },
    rooms: {
      aside: { unseen: false, hasUnread: true, mentioned: false },
      memo: { unseen: true, hasUnread: true, mentioned: true },
    },
  }],
});

export const DEMO_STARTING_CONTEXT = [
  "**Request.** Settle the memo's recommendation before the renewal.",
  "",
  "**Open.** Where the aside goes.",
].join("\n");
export const DEMO_CHILD_PROSE = "Both of you are answering different questions.";

/**
 * The test pack with a substream hanging off its one room.
 *
 * Three properties in one pack. A private child is created through the real
 * preparation, confirmation and membership path. Its starting context is the
 * pack's words, so nothing in creation reaches a model. And the presenter is
 * put in the child without being in its parent — the shape the shipped pack
 * uses, and the one that would break if parent membership were inferred from a
 * child's roster or the other way round.
 */
export const DEMO_SUBSTREAM_PACK = DemoPackSchema.parse({
  ...DEMO_TEST_PACK,
  version: "workerd-substream-test",
  steps: [
    DEMO_TEST_PACK.steps[0],
    {
      kind: "create_substream",
      id: "aside-open",
      room: "memo",
      substream: "aside",
      as: "priya",
      title: "Where the aside goes",
      participants: ["marcus", "presenter"],
      startingContext: DEMO_STARTING_CONTEXT,
    },
    {
      kind: "message",
      id: "aside-marcus-1",
      room: "memo",
      substream: "aside",
      as: "marcus",
      text: "Away from the main room: I would hold the line item.",
    },
    {
      kind: "message",
      id: "aside-priya-1",
      room: "memo",
      substream: "aside",
      as: "priya",
      text: "Rally, settle it.",
      assistant: { kind: "say", text: DEMO_CHILD_PROSE },
    },
  ],
  // The presenter can see the workspace-scoped room without being in it, and
  // is in its child — which contributes nothing here, because a private child
  // takes no directory row.
  expect: [{
    viewer: "presenter",
    attention: { waitingForYou: 0, waitingReason: null },
    rooms: { memo: { unseen: false, hasUnread: true, mentioned: false } },
  }],
});

export function demoWorkspaceStub() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", DEMO_WORKSPACE_ID)));
}

export function demoRoomStub(workstreamId: string, substreamId = "0"): DurableObjectStub<AgentLoopDO> {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", DEMO_WORKSPACE_ID, workstreamId, asSubstreamId(substreamId)),
  )) as DurableObjectStub<AgentLoopDO>;
}

/**
 * The test Worker carries no email address key and no session signing key to
 * derive one from; the creation service's address allocator needs one, and it
 * is configuration, not behaviour under test.
 */
/** One Sidekick run's own conversation: a child substream under the Sidekick. */
export function demoRunStub(sidekickId: string, runId: string): DurableObjectStub<AgentLoopDO> {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", DEMO_WORKSPACE_ID, sidekickId, asSubstreamId(runId)),
  )) as DurableObjectStub<AgentLoopDO>;
}

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
    env.DB.prepare(`CREATE TABLE workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT, verified_at TEXT,
      activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL,
      UNIQUE (workspace_id, object_name), UNIQUE (workstream_id, generation)
    )`),
    env.DB.prepare(`CREATE TABLE workstream_email_routes (
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
    env.DB.prepare(`CREATE TABLE demo_seed_receipts (
      operation_id TEXT NOT NULL, action_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      kind TEXT NOT NULL, room TEXT, workstream_id TEXT, substream TEXT, substream_id TEXT,
      sidekick_id TEXT, sidekick_run_id TEXT, turn_id TEXT,
      harness_run_id TEXT, run_outcome TEXT, elicitation_id TEXT, resource_id TEXT,
      completed_at TEXT NOT NULL, PRIMARY KEY (operation_id, action_id),
      CHECK (
        CASE kind
          WHEN 'sidekick' THEN room IS NULL AND workstream_id IS NULL
            AND substream IS NULL AND substream_id IS NULL AND sidekick_id IS NOT NULL
          ELSE room IS NOT NULL AND workstream_id IS NOT NULL
            AND substream_id IS NOT NULL AND sidekick_id IS NULL
        END
      )
    )`),
  ]);
  // As preparation opens it: `createOwnedWorkspace` anchors General and the
  // presenter's Personal Channel and opens both in the one object call, and
  // `creating_workspace` then seats the cast in General and gives each theirs.
  const generalId = asSpaceId("00000000-0000-7000-8000-00000000d5b0");
  const personalSpaceId = await personalSpaceIdFor(DEMO_WORKSPACE_ID, DEMO_PRESENTER_ID);
  let authorityGeneration = 1;
  for (const spaceId of [generalId, personalSpaceId]) {
    ({ generation: authorityGeneration } = await claimParentAnchor(demoSeedEnv(), DEMO_WORKSPACE_ID, spaceId, "space"));
  }
  await demoWorkspaceStub().initializeWorkspace(DEMO_WORKSPACE_ID, "wnam", {
    creatorUserId: DEMO_PRESENTER_ID, spaceId: generalId, personalSpaceId, authorityGeneration,
  });
  for (const userId of [DEMO_PRIYA_ID, DEMO_MARCUS_ID]) {
    await seatOrganizationMember(demoSeedEnv(), DEMO_WORKSPACE_ID, userId);
  }
}

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
 * does — with the room's alarm forced once between the two, because under a
 * contended workers shard the seeder's own polling reads can starve the
 * auto-fired alarm that executes the run.
 */
export async function playDemoAction(
  session: DemoSeedSession,
  action: DemoSeedSession["actions"][number],
): Promise<DemoSeedReceipt> {
  const progress = await applyDemoSeedAction(demoSeedEnv(), session, action);
  if (progress.state === "run_pending") {
    // The conversation the turn landed in, which is the substream's own object
    // when the pack addressed one rather than the room's main conversation.
    await runDurableObjectAlarm(demoRoomStub(progress.workstreamId, progress.substreamId));
  }
  if (progress.state === "sidekick_run_pending") {
    // Two alarms, in order: the Organization's, which provisions the Sidekick's
    // run and hands it to its own conversation, and then that conversation's,
    // which executes it. Same reason as the room's above — a contended shard starves the
    // auto-fired alarm under the seeder's polling reads.
    await runDurableObjectAlarm(demoWorkspaceStub());
    await runDurableObjectAlarm(demoRunStub(progress.sidekickId, progress.sidekickRunId));
  }
  return settleDemoSeedAction(demoSeedEnv(), session, progress, {
    deadlineAt: Date.now() + DEMO_RUN_SETTLE_TIMEOUT_MS,
  });
}
