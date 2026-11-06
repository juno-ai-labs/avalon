/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Sidekick's shared conversation keeps the wizard and run separation.
 *
 * Substream "0" under a Sidekick is its own conversation. A message there that
 * the addressing classifier sends to an agent is the wizard's when its sender
 * manages the Sidekick, and otherwise starts a run under the Sidekick's
 * definition with the message as its opening, the path a manual run takes.
 * Everything runs on real workerd: the Organization object that hosts the
 * Sidekick, the shared conversation and its persistent loop, the run child,
 * and the regional D1 the run authority reads members from. The model is the
 * OpenRouter double, so a turn reaches inference and ends, and what each loop
 * was asked is readable in the double's calls.
 */

import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  asAutomationId,
  asSubstreamId,
  asUserId,
  asWorkspaceId,
  type AutomationDraft,
} from "@rally/contracts";

import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { AuthContext, Env } from "../src/env";
import { createAutomation } from "../src/services/automation-service";
import { ConversationService } from "../src/services/conversation-service";
import { deliverChildEffects } from "./helpers/conversation-effects";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { useOpenRouterDouble, type ProviderReply } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { runSidekickAlarms, sidekickWorkspace } from "./helpers/sidekick";

/** Its own workspace: object names are shared across files, storage is not. */
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-00000000c8a0");
const AUTHOR_ID = asUserId("00000000-0000-7000-8000-00000000c8a1");
const MEMBER_ID = asUserId("00000000-0000-7000-8000-00000000c8a2");
const SESSION_ID = "00000000-0000-7000-8000-00000000c8a3";
const MEMBER_SESSION_ID = "00000000-0000-7000-8000-00000000c8a4";
const NOW = "2026-11-06T10:00:00.000Z";
const TEST_ENV: Env = env;
/** A turn reaches the double and ends; sized for a contended multi-suite run. */
const SETTLE_TIMEOUT_MS = 15_000;

function auth(userId: string): AuthContext {
  return { sessionId: userId === MEMBER_ID ? MEMBER_SESSION_ID : SESSION_ID, userId: asUserId(userId), workspaceId: WORKSPACE_ID, region: "global", role: "member" };
}

/** Reassigned per test, so a finished test's draining objects stay its own. */
let ordinal = 0;
let AUTOMATION_ID = asAutomationId("00000000-0000-7000-8000-0000000c8a00");

const DEFINITION: AutomationDraft = {
  name: "Release notes",
  description: "Answers questions about releases",
  overview: "Answers questions about releases",
  instructions: "Answer the question you were asked about releases.",
  triggers: [{ type: "manual" }],
  requiredCapabilities: [],
  expectedOutputs: [],
  defaultBehavior: {},
  recommendedPlugins: [],
  memoryTables: [],
  customTools: [],
  suggestedScope: "workspace",
  followUpQuestion: null,
  elicitation: null,
  ready: true,
};

let script: ProviderReply[] = [];
const provider = useOpenRouterDouble(() => script.shift() ?? { say: "Done." });
useSelectedModel();
useHeldEffectQueue();

function addressed() {
  return { workspaceId: WORKSPACE_ID, automationId: AUTOMATION_ID };
}

function actor(userId: string = AUTHOR_ID) {
  return { userId: asUserId(userId), actorRole: "member" as const, participantOfOwningWorkstream: false };
}

function workspaceStub() {
  return sidekickWorkspace(TEST_ENV, WORKSPACE_ID);
}

function conversationStub(substreamId = "0") {
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName("global", WORKSPACE_ID, AUTOMATION_ID, asSubstreamId(substreamId)),
  ));
}

async function seedRegionalDatabase(): Promise<void> {
  await seedWorkspaceControlPlane(env.DB, { workspaceId: WORKSPACE_ID, userId: AUTHOR_ID, sessionId: SESSION_ID });
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'member', ?)`).bind(WORKSPACE_ID, MEMBER_ID, NOW),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'member@example.com', 'Member', NULL, 'UTC', ?)`).bind(MEMBER_ID, NOW),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(MEMBER_SESSION_ID, MEMBER_ID, WORKSPACE_ID),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstreams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, do_identity_anchor INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_create_receipts (
      workspace_id TEXT NOT NULL, creator_user_id TEXT NOT NULL, client_message_id TEXT NOT NULL,
      workstream_id TEXT NOT NULL, generation INTEGER NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, message_id TEXT, harness_run_id TEXT, error_code TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, creator_user_id, client_message_id), UNIQUE (workstream_id)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_authority_routes (
      workspace_id TEXT NOT NULL, workstream_id TEXT PRIMARY KEY, generation INTEGER NOT NULL,
      object_name TEXT NOT NULL, state TEXT NOT NULL, stage_index INTEGER NOT NULL DEFAULT 0,
      source_cursor INTEGER NOT NULL DEFAULT 0, source_fence_sequence INTEGER NOT NULL,
      source_hash TEXT, target_hash TEXT, row_counts_json TEXT, imported_at TEXT,
      verified_at TEXT, activated_at TEXT, last_error_code TEXT, updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS workstream_email_routes (
      local_part TEXT PRIMARY KEY COLLATE NOCASE, region TEXT NOT NULL,
      workspace_id TEXT NOT NULL, workstream_id TEXT, automation_subscription_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
  ]);
}

/** An active Organization Sidekick the author manages and the second member does not. */
async function activeSidekick(): Promise<void> {
  const created = await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID, scope: "workspace", owningWorkstreamId: null,
    automationId: AUTOMATION_ID,
  });
  expect(created).toEqual({ automationId: AUTOMATION_ID, created: true });
  await workspaceStub().sidekickSubmitDefinition({ ...addressed(), draft: DEFINITION, evaluatorRules: null, submittedByRunId: null });
  const detail = await runInDurableObject(workspaceStub(), (instance: WorkspaceDO) =>
    instance.sidekickApply({ ...addressed(), actor: actor() }));
  expect(detail.lifecycle).toBe("active");
}

/** The member allows the Sidekick to act for them, which is what lets their own message run it. */
async function allowDelegation(userId: string): Promise<void> {
  const request = { ...addressed(), userId: asUserId(userId), allowed: true, operationId: crypto.randomUUID() };
  const prepared = await workspaceStub().sidekickPrepareMyDelegation(request);
  await workspaceStub().sidekickSetDelegation({ ...request, expectedGeneration: prepared.generation, source: "self_service" });
}

/** A person's message in the shared conversation, as the Worker sends it. */
async function say(userId: string, text: string, clientMessageId: string): Promise<string> {
  // The Worker's own admission: the Sidekick decides who may read its
  // conversation, and the reader it admits is seated there before they post.
  await new ConversationService(TEST_ENV, auth(userId)).authorizeViewer(AUTOMATION_ID);
  const response = await conversationStub().fetch("https://object.test/internal/product", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: "create_message", parentKind: "automation", auth: auth(userId),
      input: { text, clientMessageId, mentions: [], confirmedParticipantUserIds: [], attachmentIds: [] },
    }),
  });
  const body = await response.json() as { turn?: { turnId: string } };
  expect(response.status, JSON.stringify(body)).toBe(200);
  await runDurableObjectAlarm(conversationStub());
  return body.turn!.turnId;
}

interface RunRow extends Record<string, SqlStorageValue> {
  run_id: string;
  occurrence_key: string;
  trigger_json: string;
  coordinator_user_id: string | null;
  opening_json: string | null;
}

async function sidekickRuns(): Promise<RunRow[]> {
  return runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<RunRow>(
    `SELECT run_id, occurrence_key, trigger_json, coordinator_user_id, opening_json FROM sidekick_runs
      WHERE sidekick_id = ? ORDER BY created_at, run_id`, AUTOMATION_ID,
  ).toArray());
}

/** Executions the shared conversation's own loop ran: the wizard's turns. */
async function wizardExecutions(): Promise<{ trigger: string | null; terminal: boolean }[]> {
  return runInDurableObject(conversationStub(), (_instance, state) => state.storage.sql.exec<{
    execution_context_json: string; terminalized_at: number | null;
  }>(`SELECT execution_context_json, terminalized_at FROM runs WHERE execution_context_json IS NOT NULL
      ORDER BY created_at, run_id`).toArray().map((row) => ({
    trigger: (JSON.parse(row.execution_context_json) as { triggerMessageId?: string | null }).triggerMessageId ?? null,
    terminal: row.terminalized_at !== null,
  })));
}

/** Whether the message has landed as a turn and nothing is still queued for the loop. */
async function landed(turnId: string): Promise<boolean> {
  return runInDurableObject(conversationStub(), (_instance, state) => state.storage.sql.exec<{ landed: number }>(
    `SELECT EXISTS (SELECT 1 FROM participant_transcript_turns WHERE turn_id = ?)
        AND NOT EXISTS (SELECT 1 FROM pending_loop_inputs) AS landed`, turnId,
  ).one().landed === 1);
}

async function systemNotes(prefix: string): Promise<{ code: string; turnId: string }[]> {
  return runInDurableObject(conversationStub(), (_instance, state) => state.storage.sql.exec<{ structured_content_json: string }>(
    `SELECT structured_content_json FROM canonical_conversation_turn_details
      WHERE client_message_id LIKE ? ORDER BY sequence_number`, `${prefix}%`,
  ).toArray().map((row) => {
    const content = JSON.parse(row.structured_content_json) as { code: string; turnId: string };
    return { code: content.code, turnId: content.turnId };
  }));
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (
    typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""
  )).join("\n");
}

function callsThatSaw(marker: string) {
  return provider.calls.filter((call) => call.messages.some((message) => text(message.content).includes(marker)));
}


interface RunRowView {
  turns: number;
  text: string;
  run: { state: string; stepCount: number; reply: string | null } | undefined;
  runId: string | undefined;
}

/** A run's row in the shared conversation, read the way the room reads its turns. */
async function runRow(runId: string): Promise<RunRowView> {
  return runInDurableObject(conversationStub(), (instance, state) => {
    const ids = state.storage.sql.exec<{ id: string }>(
      `SELECT id FROM canonical_conversation_turn_details WHERE client_message_id = ?`, `sidekick-run:${runId}`,
    ).toArray();
    const transcript = (instance as unknown as { transcript: {
      participantTurn(turnId: string): { blocks: { type: string; text?: string; structuredContent?: Record<string, unknown> }[] } | null;
    } }).transcript;
    const block = ids[0] ? transcript.participantTurn(ids[0].id)?.blocks[0] : undefined;
    return {
      turns: ids.length,
      text: block?.text ?? "",
      run: block?.structuredContent?.run as RunRowView["run"],
      runId: block?.structuredContent?.runId as string | undefined,
    };
  });
}

/** Fire the Organization's alarm until the run's row says `state`; each change arms its own entry. */
async function rowReaches(runId: string, wanted: string): Promise<RunRowView> {
  let latest: RunRowView | undefined;
  await expect.poll(async () => {
    await runDurableObjectAlarm(workspaceStub());
    latest = await runRow(runId);
    return latest.run?.state;
  }, { timeout: SETTLE_TIMEOUT_MS, interval: 100 }).toBe(wanted);
  return latest!;
}

/** The run's first activation, once it has ended. */
async function runSettled(runId: string): Promise<void> {
  await expect.poll(() => runInDurableObject(conversationStub(runId), (_instance, state) => {
    try {
      return state.storage.sql.exec<{ terminal: number }>(
        `SELECT COUNT(*) AS terminal FROM runs WHERE execution_context_json IS NOT NULL AND terminalized_at IS NOT NULL`,
      ).one().terminal;
    } catch {
      return 0;
    }
  }), { timeout: SETTLE_TIMEOUT_MS, interval: 100 }).toBe(1);
}

beforeEach(async () => {
  script = [];
  ordinal += 1;
  AUTOMATION_ID = asAutomationId(`00000000-0000-7000-8000-${String(ordinal).padStart(4, "0")}0000c8a0`);
  await reset();
  await seedRegionalDatabase();
  await env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)))
    .initializeWorkspace(WORKSPACE_ID, "wnam");
});

describe("a Sidekick's shared conversation", () => {
  it("starts a run under the Sidekick's definition from a message addressed to it by someone who does not manage it", async () => {
    await activeSidekick();
    await allowDelegation(MEMBER_ID);
    const question = "What shipped in the last release?";
    const turnId = await say(MEMBER_ID, question, "member-question");
    await expect.poll(() => landed(turnId), { timeout: SETTLE_TIMEOUT_MS }).toBe(true);
    // The wizard did not answer: the conversation's own loop started nothing.
    expect(await wizardExecutions()).toEqual([]);
    const [run] = await sidekickRuns();
    expect(run).toMatchObject({ occurrence_key: `message:${turnId}`, coordinator_user_id: MEMBER_ID });
    expect(JSON.parse(run!.trigger_json)).toEqual({ kind: "manual", requestedByUserId: MEMBER_ID });
    expect(JSON.parse(run!.opening_json!)).toMatchObject({
      structuredContent: { kind: "sidekick_conversation_message", turnId, authorUserId: MEMBER_ID },
    });
    // The run reads the message as its opening, under the Sidekick's instructions.
    expect(await runSidekickAlarms(TEST_ENV, WORKSPACE_ID)).toEqual([run!.run_id]);
    await expect.poll(() => callsThatSaw(question).length, { timeout: SETTLE_TIMEOUT_MS }).toBeGreaterThan(0);
    // It ran in the run's own conversation, as the run, not in the wizard's.
    const runExecutions = await runInDurableObject(conversationStub(run!.run_id), (_instance, state) =>
      state.storage.sql.exec<{ execution_context_json: string }>(
        `SELECT execution_context_json FROM runs WHERE execution_context_json IS NOT NULL`,
      ).toArray().map((row) => JSON.parse(row.execution_context_json) as {
        automationRun?: { runId: string }; executionPrincipal: { userId: string };
      }));
    expect(runExecutions).toEqual([expect.objectContaining({
      automationRun: expect.objectContaining({ runId: run!.run_id }),
      executionPrincipal: { type: "user", userId: MEMBER_ID },
    })]);
    expect(await wizardExecutions()).toEqual([]);
    expect(await systemNotes("sidekick-message-refused:")).toEqual([]);
  });

  it("gives a manager's message to the wizard, as it always has", async () => {
    await activeSidekick();
    const request = "Make the release notes shorter from now on.";
    const turnId = await say(AUTHOR_ID, request, "author-edit");
    await expect.poll(async () => (await wizardExecutions()).find((execution) => execution.trigger === turnId)?.terminal,
      { timeout: SETTLE_TIMEOUT_MS }).toBe(true);
    expect(await sidekickRuns()).toEqual([]);
    expect(callsThatSaw(request).length).toBeGreaterThan(0);
  });

  it("starts no run, and says why, for a member who has not allowed the Sidekick to act for them", async () => {
    await activeSidekick();
    const turnId = await say(MEMBER_ID, "Summarize the release for me.", "member-without-delegation");
    await expect.poll(() => systemNotes("sidekick-message-refused:"), { timeout: SETTLE_TIMEOUT_MS })
      .toEqual([{ code: "run_no_eligible_delegate", turnId }]);
    expect(await landed(turnId)).toBe(true);
    expect(await sidekickRuns()).toEqual([]);
    expect(await wizardExecutions()).toEqual([]);
  });
  it("writes a run's row into the shared conversation and carries its reply when the run finishes", async () => {
    await activeSidekick();
    script = [{ say: "Version 4.2 shipped the new importer." }];
    const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "row-run-0001" });
    expect(await runSidekickAlarms(TEST_ENV, WORKSPACE_ID)).toEqual([started.runId]);
    const running = await rowReaches(started.runId, "running");
    expect(running).toMatchObject({ turns: 1, runId: started.runId, text: "Working on it.", run: { stepCount: 0, reply: null } });
    await runSettled(started.runId);
    // The run's finish reaches the Sidekick through its effects; the row follows the run row.
    await deliverChildEffects(TEST_ENV, conversationStub(started.runId));
    const finished = await rowReaches(started.runId, "completed");
    expect(finished).toEqual({
      turns: 1,
      runId: started.runId,
      text: "Version 4.2 shipped the new importer.",
      run: { state: "completed", stepCount: 0, reply: "Version 4.2 shipped the new importer." },
    });
    // The wizard was not woken by the row.
    expect(await wizardExecutions()).toEqual([]);
  });

  it("rebuilds a run's row from the Sidekick's runs on a replay", async () => {
    await activeSidekick();
    const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "row-run-0002" });
    await runSidekickAlarms(TEST_ENV, WORKSPACE_ID);
    await rowReaches(started.runId, "running");
    await runSettled(started.runId);
    await deliverChildEffects(TEST_ENV, conversationStub(started.runId));
    await rowReaches(started.runId, "completed");
    // The conversation's copy drifts; the Sidekick's run row does not.
    await runInDurableObject(conversationStub(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE sidekick_run_rows SET state = 'running', reply = NULL, source_version = 0 WHERE run_id = ?`, started.runId);
    });
    expect((await runRow(started.runId)).run?.state).toBe("running");
    expect(await workspaceStub().sidekickReplayRunRows({ ...addressed(), actor: actor() })).toEqual({ armed: 1 });
    expect(await rowReaches(started.runId, "completed")).toMatchObject({ turns: 1, run: { reply: "Done." } });
  });
});
