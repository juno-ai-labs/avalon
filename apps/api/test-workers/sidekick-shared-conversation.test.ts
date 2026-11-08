/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * A Sidekick's shared conversation keeps the wizard and run separation.
 *
 * Substream "0" under a Sidekick is its own conversation. A message there that
 * the addressing classifier sends to an agent starts a run under the
 * Sidekick's definition with the message as its opening, the path a manual run
 * takes, whoever sent it; it is the wizard's only when a manager marked it
 * `intent: "edit_sidekick"`. Each run then has a row in "0" kept current from
 * the Sidekick's runs.
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
  ConversationEffectEnvelopeSchema,
  WorkstreamDirectoryUserEffectSchema,
  conversationEffectHash,
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
/** An Organization admin who did not write the Sidekick: a manager of an Organization one by role. */
const ADMIN_ID = asUserId("00000000-0000-7000-8000-00000000c8a5");
const ADMIN_SESSION_ID = "00000000-0000-7000-8000-00000000c8a6";
/** A guest of the Organization, on a `people` Sidekick's list and not a delegate. */
const GUEST_ID = asUserId("00000000-0000-7000-8000-00000000c8a7");
const GUEST_SESSION_ID = "00000000-0000-7000-8000-00000000c8a8";
const NOW = "2026-11-06T10:00:00.000Z";
const TEST_ENV: Env = env;
/** A turn reaches the double and ends; sized for a contended multi-suite run. */
const SETTLE_TIMEOUT_MS = 15_000;

function auth(userId: string): AuthContext {
  const sessionId = userId === MEMBER_ID ? MEMBER_SESSION_ID : userId === ADMIN_ID ? ADMIN_SESSION_ID
    : userId === GUEST_ID ? GUEST_SESSION_ID : SESSION_ID;
  return { sessionId, userId: asUserId(userId), workspaceId: WORKSPACE_ID, region: "global",
    role: userId === ADMIN_ID ? "admin" : userId === GUEST_ID ? null : "member" };
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
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, last_seen_at)
      VALUES (?, ?, 'active', 'admin', ?)`).bind(WORKSPACE_ID, ADMIN_ID, NOW),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'admin@example.com', 'Admin', NULL, 'UTC', ?)`).bind(ADMIN_ID, NOW),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(ADMIN_SESSION_ID, ADMIN_ID, WORKSPACE_ID),
    env.DB.prepare(`INSERT INTO workspace_members(workspace_id, user_id, status, role, access_class, last_seen_at)
      VALUES (?, ?, 'active', NULL, 'guest', ?)`).bind(WORKSPACE_ID, GUEST_ID, NOW),
    env.DB.prepare(`INSERT INTO users(id, email, name, avatar_url, timezone, created_at)
      VALUES (?, 'guest@example.com', 'Guest', NULL, 'UTC', ?)`).bind(GUEST_ID, NOW),
    env.DB.prepare(`INSERT INTO sessions (id, user_id, workspace_id, region, revoked_at, expires_at)
      VALUES (?, ?, ?, 'global', NULL, '2099-01-01T00:00:00.000Z')`).bind(GUEST_SESSION_ID, GUEST_ID, WORKSPACE_ID),
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
async function activeSidekick(scope: "personal" | "workspace" = "workspace"): Promise<void> {
  const created = await createAutomation(TEST_ENV, {
    workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID, scope,
    automationId: AUTOMATION_ID,
  });
  expect(created).toEqual({ automationId: AUTOMATION_ID, created: true });
  await workspaceStub().sidekickSubmitDefinition({ ...addressed(), draft: { ...DEFINITION, suggestedScope: scope },
    evaluatorRules: null, submittedByRunId: null });
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

/**
 * A person's message in the shared conversation, as the Worker sends it;
 * `edit` marks it as a wizard edit, as a manager's composer does.
 */
async function say(userId: string, text: string, clientMessageId: string, edit = false): Promise<string> {
  // The Worker's own admission: the Sidekick decides who may read its
  // conversation, and the reader it admits is seated there before they post.
  await new ConversationService(TEST_ENV, auth(userId)).authorizeViewer(AUTOMATION_ID);
  const response = await conversationStub().fetch("https://object.test/internal/product", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operation: "create_message", parentKind: "automation", auth: auth(userId),
      input: {
        text, clientMessageId, mentions: [], confirmedParticipantUserIds: [], attachmentIds: [],
        ...(edit ? { intent: "edit_sidekick" } : {}),
      },
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
  requester_user_id: string | null;
  opening_json: string | null;
}

async function sidekickRuns(): Promise<RunRow[]> {
  return runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<RunRow>(
    `SELECT run_id, occurrence_key, trigger_json, coordinator_user_id, requester_user_id, opening_json FROM sidekick_runs
      WHERE sidekick_id = ? ORDER BY created_at, run_id`, AUTOMATION_ID,
  ).toArray());
}

/** Executions the shared conversation's own loop ran: the wizard's turns. */
async function wizardExecutions(): Promise<{ trigger: string | null; terminal: boolean; wizard: boolean }[]> {
  return runInDurableObject(conversationStub(), (_instance, state) => state.storage.sql.exec<{
    execution_context_json: string; terminalized_at: number | null;
  }>(`SELECT execution_context_json, terminalized_at FROM runs WHERE execution_context_json IS NOT NULL
      ORDER BY created_at, run_id`).toArray().map((row) => {
    const context = JSON.parse(row.execution_context_json) as { triggerMessageId?: string | null; sidekickWizard?: boolean };
    return { trigger: context.triggerMessageId ?? null, terminal: row.terminalized_at !== null, wizard: context.sidekickWizard === true };
  }));
}

/** Wait for the wizard's turn the message started to finish. */
async function wizardAnswered(turnId: string): Promise<void> {
  await expect.poll(async () => (await wizardExecutions()).find((execution) => execution.trigger === turnId)?.terminal,
    { timeout: SETTLE_TIMEOUT_MS }).toBe(true);
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

/** The run row turn's stored text, as `conversation_read` and gap-fill read it. */
async function storedRowContent(runId: string): Promise<string | null> {
  return runInDurableObject(conversationStub(), (_instance, state) => state.storage.sql.exec<{ content: string | null }>(
    `SELECT content FROM canonical_conversation_turn_details WHERE client_message_id = ?`, `sidekick-run:${runId}`,
  ).one().content);
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

  it("gives a manager's message marked as an edit to the wizard", async () => {
    await activeSidekick();
    const request = "Make the release notes shorter from now on.";
    const turnId = await say(AUTHOR_ID, request, "author-edit", true);
    await wizardAnswered(turnId);
    // The turn is marked as the wizard's, which is what loads the authoring tools.
    expect(await wizardExecutions()).toEqual([{ trigger: turnId, terminal: true, wizard: true }]);
    expect(await sidekickRuns()).toEqual([]);
    expect(callsThatSaw(request).length).toBeGreaterThan(0);
  });

  it("starts a run from a manager's message that is not marked as an edit", async () => {
    await activeSidekick();
    const turnId = await say(AUTHOR_ID, "What shipped this week?", "author-question");
    await expect.poll(() => landed(turnId), { timeout: SETTLE_TIMEOUT_MS }).toBe(true);
    expect(await wizardExecutions()).toEqual([]);
    const runs = await sidekickRuns();
    // A delegate's own message runs as that delegate, with delegate access.
    expect(runs).toEqual([expect.objectContaining({ occurrence_key: `message:${turnId}`, coordinator_user_id: AUTHOR_ID,
      requester_user_id: null })]);
    expect(JSON.parse(runs[0]!.trigger_json)).toEqual({ kind: "manual", requestedByUserId: AUTHOR_ID });
  });

  it("refuses an edit from someone who does not manage the Sidekick, and says why", async () => {
    await activeSidekick();
    await allowDelegation(MEMBER_ID);
    const turnId = await say(MEMBER_ID, "Stop including the importer.", "member-edit", true);
    await expect.poll(() => systemNotes("sidekick-message-refused:"), { timeout: SETTLE_TIMEOUT_MS })
      .toEqual([{ code: "sidekick_edit_requires_manager", turnId }]);
    expect(await landed(turnId)).toBe(true);
    expect(await wizardExecutions()).toEqual([]);
    expect(await sidekickRuns()).toEqual([]);
  });

  it("gives an Organization admin's edit to the wizard of an Organization Sidekick someone else wrote", async () => {
    await activeSidekick();
    const turnId = await say(ADMIN_ID, "Add the release date to every note.", "admin-edit", true);
    await wizardAnswered(turnId);
    expect(await wizardExecutions()).toEqual([{ trigger: turnId, terminal: true, wizard: true }]);
    expect(await sidekickRuns()).toEqual([]);
  });

  it("admits one run for a message however often its claim is retried", async () => {
    await activeSidekick();
    await allowDelegation(MEMBER_ID);
    const request = {
      ...addressed(), actor: actor(MEMBER_ID), messageId: "00000000-0000-7000-8000-00000000c8b1",
      intent: null, authorName: "Member", text: "What shipped?",
    };
    const first = await workspaceStub().sidekickAdmitConversationMessage(request);
    expect(first).toEqual({ route: "run", runId: expect.any(String), reused: false });
    const retried = await workspaceStub().sidekickAdmitConversationMessage(request);
    expect(retried).toEqual({ route: "run", runId: (first as { runId: string }).runId, reused: true });
    expect(await sidekickRuns()).toHaveLength(1);
  });

  it("takes an answer to the wizard's question only from someone who manages the Sidekick", async () => {
    await activeSidekick();
    script = [{
      callTool: {
        name: "request_elicitation",
        arguments: {
          prompt: "Which release?", responseType: "radio",
          options: [{ value: "4.2", label: "4.2", description: null }, { value: "4.3", label: "4.3", description: null }],
          minimumSelections: 1, maximumSelections: 1,
        },
      },
    }];
    const turnId = await say(AUTHOR_ID, "Ask me which release to cover.", "author-asks", true);
    await wizardAnswered(turnId);
    const elicitationId = await runInDurableObject(conversationStub(), (_instance, state) =>
      state.storage.sql.exec<{ elicitation_id: string }>(
        `SELECT elicitation_id FROM elicitation_requests WHERE status = 'pending'`,
      ).one().elicitation_id);
    const answer = (userId: string) => conversationStub().fetch("https://object.test/internal/product", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operation: "answer_elicitation", parentKind: "automation", auth: auth(userId),
        elicitationId, input: { answer: "4.2" },
      }),
    });
    await new ConversationService(TEST_ENV, auth(MEMBER_ID)).authorizeViewer(AUTOMATION_ID);
    const refused = await answer(MEMBER_ID);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "sidekick_edit_requires_manager" });
    // Still open, so the manager can answer it, and their answer is the wizard's.
    const accepted = await answer(AUTHOR_ID);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    await runDurableObjectAlarm(conversationStub());
    await expect.poll(async () => (await wizardExecutions()).filter((execution) => execution.terminal).length,
      { timeout: SETTLE_TIMEOUT_MS }).toBe(2);
    expect((await wizardExecutions()).every((execution) => execution.wizard)).toBe(true);
    expect(await sidekickRuns()).toEqual([]);
  });

  it("runs a non-delegate member's message under their own access, and keeps them as the run's principal", async () => {
    await activeSidekick();
    const turnId = await say(MEMBER_ID, "Summarize the release for me.", "member-without-delegation");
    await expect.poll(() => landed(turnId), { timeout: SETTLE_TIMEOUT_MS }).toBe(true);
    expect(await systemNotes("sidekick-message-refused:")).toEqual([]);
    const [run] = await sidekickRuns();
    expect(run).toMatchObject({ occurrence_key: `message:${turnId}`, coordinator_user_id: MEMBER_ID, requester_user_id: MEMBER_ID });
    // Its account view names only the member, though the author is a delegate.
    expect(await workspaceStub().sidekickReadExecutionDelegation({ ...addressed(), runId: run!.run_id }))
      .toMatchObject({ delegates: [{ userId: MEMBER_ID }], requesterUserId: MEMBER_ID });
    expect((await workspaceStub().sidekickReadExecutionDelegation(addressed())).delegates.map((grant) => grant.userId))
      .toEqual([AUTHOR_ID]);
    // Provisioned as the member, and continued as the member, never as a delegate.
    expect(await workspaceStub().sidekickRunProvisioning({ ...addressed(), runId: run!.run_id }))
      .toMatchObject({ runAsUserId: MEMBER_ID });
    expect(await runSidekickAlarms(TEST_ENV, WORKSPACE_ID)).toEqual([run!.run_id]);
    expect(await workspaceStub().sidekickContinueRun({ ...addressed(), runId: run!.run_id }))
      .toMatchObject({ outcome: "continue", executionPrincipal: { type: "user", userId: MEMBER_ID } });
  });

  it("runs a guest's message under the guest's own access when the Sidekick is shared with them", async () => {
    await activeSidekick("personal");
    await runInDurableObject(workspaceStub(), (instance: WorkspaceDO) => instance.sidekickSetAudience({
      ...addressed(), actor: actor(), update: { audience: "people", userIds: [GUEST_ID] } }));
    const turnId = await say(GUEST_ID, "Summarize the release for me.", "guest-on-the-list");
    await expect.poll(() => landed(turnId), { timeout: SETTLE_TIMEOUT_MS }).toBe(true);
    expect(await systemNotes("sidekick-message-refused:")).toEqual([]);
    const [run] = await sidekickRuns();
    expect(run).toMatchObject({ occurrence_key: `message:${turnId}`, coordinator_user_id: GUEST_ID, requester_user_id: GUEST_ID });
    expect(await runSidekickAlarms(TEST_ENV, WORKSPACE_ID)).toEqual([run!.run_id]);
    expect(await workspaceStub().sidekickContinueRun({ ...addressed(), runId: run!.run_id }))
      .toMatchObject({ outcome: "continue", executionPrincipal: { type: "user", userId: GUEST_ID } });
  });

  it("writes a run's row into the shared conversation and carries its reply when the run finishes", async () => {
    await activeSidekick();
    // One tool call, so the row's step count has something to count.
    script = [{ callTool: { name: "conversation_list", arguments: {} } }, { say: "Version 4.2 shipped the new importer." }];
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
      run: { state: "completed", stepCount: 1, reply: "Version 4.2 shipped the new importer." },
    });
    // The stored turn says the same, for every reader that reads it rather than the joined row.
    expect(await storedRowContent(started.runId)).toBe("Version 4.2 shipped the new importer.");
    // The wizard was not woken by the row.
    expect(await wizardExecutions()).toEqual([]);
  });

  it("carries a reply longer than the directory preview whole onto the run's row", async () => {
    await activeSidekick();
    // A data report past the 1,000-character directory preview: the row is
    // where the Sidekick's people read it, so it must not be cut there.
    const report = `Weekly report. ${"Signups rose in every region this week. ".repeat(60)}End of report.`;
    script = [{ say: report }];
    const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "row-run-long" });
    expect(await runSidekickAlarms(TEST_ENV, WORKSPACE_ID)).toEqual([started.runId]);
    await runSettled(started.runId);
    await deliverChildEffects(TEST_ENV, conversationStub(started.runId));
    const finished = await rowReaches(started.runId, "completed");
    expect(report.length).toBeGreaterThan(2_000);
    expect(finished.run?.reply).toBe(report);
    expect(await storedRowContent(started.runId)).toBe(report);
  });

  it("drops a projection older than the row it holds", async () => {
    await activeSidekick();
    script = [{ say: "Shipped." }];
    const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "row-run-0003" });
    await runSidekickAlarms(TEST_ENV, WORKSPACE_ID);
    await runSettled(started.runId);
    await deliverChildEffects(TEST_ENV, conversationStub(started.runId));
    const finished = await rowReaches(started.runId, "completed");
    const held = await runInDurableObject(conversationStub(), (_instance, state) => state.storage.sql.exec<{ source_version: number }>(
      `SELECT source_version FROM sidekick_run_rows WHERE run_id = ?`, started.runId,
    ).one().source_version);
    expect(await conversationStub().projectSidekickRunRow({
      ...addressed(), runId: started.runId, automationName: "Release notes", triggerKind: "manual",
      createdAt: held - 1, state: "running", stepCount: 0, reply: null, version: held - 1,
    })).toEqual({ outcome: "unchanged", code: "sidekick_run_row_stale" });
    expect(await runRow(started.runId)).toEqual(finished);
    expect(await storedRowContent(started.runId)).toBe("Shipped.");
  });

  it("rebuilds a run's row from the Sidekick's runs on a replay", async () => {
    await activeSidekick();
    const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "row-run-0002" });
    await runSidekickAlarms(TEST_ENV, WORKSPACE_ID);
    await rowReaches(started.runId, "running");
    await runSettled(started.runId);
    await deliverChildEffects(TEST_ENV, conversationStub(started.runId));
    await rowReaches(started.runId, "completed");
    // The conversation's copy drifts, and its version runs ahead of the run
    // (a clock step, a bad write), so an ordinary delivery would drop the
    // repair as stale. The Sidekick's run row does not drift.
    await runInDurableObject(conversationStub(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE sidekick_run_rows SET state = 'running', reply = NULL, source_version = source_version + 86400000
        WHERE run_id = ?`, started.runId);
    });
    expect((await runRow(started.runId)).run?.state).toBe("running");
    expect(await workspaceStub().sidekickReplayRunRows({ ...addressed(), actor: actor() })).toEqual({ armed: 1 });
    expect(await rowReaches(started.runId, "completed")).toMatchObject({ turns: 1, run: { reply: "Done." } });
  });
  it("lands a run's conversation_post that names no conversation in the Sidekick's own conversation, waking nobody", async () => {
    await activeSidekick();
    const report = "Release 4.2 is out; the importer is the headline.";
    script = [{ callTool: { name: "conversation_post", arguments: { text: report } } }, { say: "Posted." }];
    const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "post-own-0001" });
    await runSidekickAlarms(TEST_ENV, WORKSPACE_ID);
    await runSettled(started.runId);
    const posts = await runInDurableObject(conversationStub(), (_instance, state) => state.storage.sql.exec<{
      content: string; structured_content_json: string;
    }>(`SELECT content, structured_content_json FROM canonical_conversation_turn_details
        WHERE client_message_id LIKE 'conversation-post:%'`).toArray());
    expect(posts).toHaveLength(1);
    expect(posts[0]!.content).toBe(report);
    expect(JSON.parse(posts[0]!.structured_content_json)).toMatchObject({
      type: "automation_activation", automationId: AUTOMATION_ID, runId: started.runId, trigger: { kind: "manual" },
    });
    expect(await wizardExecutions()).toEqual([]);
  });

  it("opens a personal Sidekick's conversation only to its author and the people it is shared with", async () => {
    await activeSidekick("personal");
    const opens = (userId: string) => new ConversationService(TEST_ENV, auth(userId)).authorizeViewer(AUTOMATION_ID)
      .then(() => true, () => false);
    expect(await opens(AUTHOR_ID)).toBe(true);
    expect(await opens(MEMBER_ID)).toBe(false);
    const setAudience = (update: { audience: "personal" | "workspace" | "people"; userIds: string[] }) =>
      runInDurableObject(workspaceStub(), (instance: WorkspaceDO) => instance.sidekickSetAudience({
        ...addressed(), actor: actor(), update }));
    const shared = await setAudience({ audience: "people", userIds: [MEMBER_ID] });
    expect({ audience: shared.audience, sharedWithUserIds: shared.sharedWithUserIds })
      .toEqual({ audience: "people", sharedWithUserIds: [MEMBER_ID] });
    expect(await opens(MEMBER_ID)).toBe(true);
    // An admin who is not on the list does not read a personal Sidekick.
    expect(await opens(ADMIN_ID)).toBe(false);
    // The Organization audience admits any member, and clears the list.
    const opened = await setAudience({ audience: "workspace", userIds: [] });
    expect({ audience: opened.audience, sharedWithUserIds: opened.sharedWithUserIds })
      .toEqual({ audience: "workspace", sharedWithUserIds: [] });
    expect(await opens(ADMIN_ID)).toBe(true);
    // Someone outside the Organization cannot be named, and a list naming
    // only the author is not a `people` audience; each is refused by its code.
    await expect(setAudience({ audience: "people", userIds: [asUserId("00000000-0000-7000-8000-00000000c8ff")] }))
      .rejects.toMatchObject({ code: "sidekick_audience_not_member" });
    await expect(setAudience({ audience: "people", userIds: [AUTHOR_ID] }))
      .rejects.toMatchObject({ code: "sidekick_audience_people_empty" });
    // Someone it is shared with does not manage it.
    await expect(runInDurableObject(workspaceStub(), (instance: WorkspaceDO) => instance.sidekickSetAudience({
      ...addressed(), actor: actor(MEMBER_ID), update: { audience: "personal", userIds: [] },
    }))).rejects.toMatchObject({ code: "sidekick_forbidden" });
  });

  it("marks a Sidekick's sidebar row unread for a reader until they read its shared conversation", async () => {
    await activeSidekick();
    const unread = async (userId: string) => (await workspaceStub().listAutomationDirectory({
      workspaceId: WORKSPACE_ID, userId })).items.find((item) => item.id === AUTOMATION_ID)?.unread;
    const latest = () => runInDurableObject(conversationStub(), (_instance, state) => state.storage.sql.exec<{ latest: number }>(
      `SELECT next_attention_ordinal - 1 AS latest FROM workstream WHERE id = 1`).one().latest);
    const read = async (userId: string) => {
      const response = await conversationStub().fetch("https://object.test/internal/product", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "acknowledge_read", parentKind: "automation", auth: auth(userId),
          input: { readThroughSequenceNumber: await latest(), observedManualUnreadGeneration: 0 } }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      await deliverChildEffects(TEST_ENV, conversationStub());
    };
    await say(MEMBER_ID, "Morning, everyone.", "unread-0001");
    // Never opened: unread, as an unopened Channel is unseen.
    await deliverChildEffects(TEST_ENV, conversationStub());
    expect(await unread(ADMIN_ID)).toBe(true);
    // Its sender's own message is not news to them.
    expect(await unread(MEMBER_ID)).toBe(false);
    await read(MEMBER_ID);
    expect(await unread(MEMBER_ID)).toBe(false);
    await say(AUTHOR_ID, "Morning! The release went out.", "unread-0002");
    await deliverChildEffects(TEST_ENV, conversationStub());
    expect(await unread(MEMBER_ID)).toBe(true);
    await read(MEMBER_ID);
    expect(await unread(MEMBER_ID)).toBe(false);
  });

  it("keeps a Sidekick read for the person whose Run now is working, and marks it unread for its other readers", async () => {
    await activeSidekick();
    const unread = async (userId: string) => (await workspaceStub().listAutomationDirectory({
      workspaceId: WORKSPACE_ID, userId })).items.find((item) => item.id === AUTOMATION_ID)?.unread;
    const latest = () => runInDurableObject(conversationStub(), (_instance, state) => state.storage.sql.exec<{ latest: number }>(
      `SELECT next_attention_ordinal - 1 AS latest FROM workstream WHERE id = 1`).one().latest);
    const read = async (userId: string) => {
      const response = await conversationStub().fetch("https://object.test/internal/product", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "acknowledge_read", parentKind: "automation", auth: auth(userId),
          input: { readThroughSequenceNumber: await latest(), observedManualUnreadGeneration: 0 } }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      await deliverChildEffects(TEST_ENV, conversationStub());
    };
    await say(MEMBER_ID, "Morning, everyone.", "requester-0001");
    await deliverChildEffects(TEST_ENV, conversationStub());
    await read(AUTHOR_ID);
    await read(MEMBER_ID);
    expect([await unread(AUTHOR_ID), await unread(MEMBER_ID)]).toEqual([false, false]);
    // The author asks; the run's row lands in the shared conversation while it works.
    const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "requester-run-0001" });
    expect(await runSidekickAlarms(TEST_ENV, WORKSPACE_ID)).toEqual([started.runId]);
    await rowReaches(started.runId, "running");
    await deliverChildEffects(TEST_ENV, conversationStub());
    expect({ author: await unread(AUTHOR_ID), member: await unread(MEMBER_ID) }).toEqual({ author: false, member: true });
    // A teammate writes while the run works; the run's next step updates its
    // row in place. The teammate's message stays unread to the author.
    await say(MEMBER_ID, "I pushed a fix to the importer.", "requester-0002");
    await deliverChildEffects(TEST_ENV, conversationStub());
    const held = await runInDurableObject(conversationStub(), (_instance, state) => state.storage.sql.exec<{ source_version: number }>(
      `SELECT source_version FROM sidekick_run_rows WHERE run_id = ?`, started.runId).one().source_version);
    expect(await conversationStub().projectSidekickRunRow({
      ...addressed(), runId: started.runId, automationName: "Release notes", triggerKind: "manual",
      createdAt: held, state: "running", stepCount: 1, reply: null, version: held + 1, requesterUserId: AUTHOR_ID,
    })).toEqual({ outcome: "updated", code: "sidekick_run_row_updated" });
    await deliverChildEffects(TEST_ENV, conversationStub());
    expect(await unread(AUTHOR_ID)).toBe(true);
  });

  it("keeps a requester's manual unread mark when their own run's row lands", async () => {
    await activeSidekick();
    const unread = async (userId: string) => (await workspaceStub().listAutomationDirectory({
      workspaceId: WORKSPACE_ID, userId })).items.find((item) => item.id === AUTOMATION_ID)?.unread;
    const product = async (operation: string, input?: unknown) => {
      const response = await conversationStub().fetch("https://object.test/internal/product", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, parentKind: "automation", auth: auth(AUTHOR_ID), ...(input ? { input } : {}) }),
      });
      expect(response.status, await response.clone().text()).toBe(200);
      await deliverChildEffects(TEST_ENV, conversationStub());
    };
    await say(MEMBER_ID, "Morning, everyone.", "manual-0001");
    await deliverChildEffects(TEST_ENV, conversationStub());
    const latest = await runInDurableObject(conversationStub(), (_instance, state) => state.storage.sql.exec<{ latest: number }>(
      `SELECT next_attention_ordinal - 1 AS latest FROM workstream WHERE id = 1`).one().latest);
    await product("acknowledge_read", { readThroughSequenceNumber: latest, observedManualUnreadGeneration: 0 });
    // The author marks the Sidekick unread to come back to, then presses Run now.
    await product("mark_unread");
    expect(await unread(AUTHOR_ID)).toBe(true);
    const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "manual-run-0001" });
    expect(await runSidekickAlarms(TEST_ENV, WORKSPACE_ID)).toEqual([started.runId]);
    await rowReaches(started.runId, "running");
    await deliverChildEffects(TEST_ENV, conversationStub());
    expect(await unread(AUTHOR_ID)).toBe(true);
  });

  it("shows a run working, then the question it waits on, on its row and on the Sidekick's list row", async () => {
    await activeSidekick();
    const question = "Which release should the notes cover?";
    script = [{
      callTool: {
        name: "request_elicitation",
        arguments: {
          prompt: question, responseType: "radio",
          options: [{ value: "4.2", label: "4.2", description: null }, { value: "4.3", label: "4.3", description: null }],
          minimumSelections: 1, maximumSelections: 1,
        },
      },
    }];
    const listed = async () => {
      const item = (await workspaceStub().listAutomationDirectory({ workspaceId: WORKSPACE_ID, userId: AUTHOR_ID }))
        .items.find((candidate) => candidate.id === AUTOMATION_ID);
      const waterline = await runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{ waterline: number }>(
        `SELECT waterline FROM workspace_sidebar_list_state WHERE list = 'automations'`).one().waterline);
      return { row: { runState: item?.runState, pendingQuestion: item?.pendingQuestion, needsInput: item?.needsInput },
        lastRunAt: item?.lastRunAt, waterline };
    };
    const idle = await listed();
    expect(idle.row).toEqual({ runState: null, pendingQuestion: null, needsInput: false });
    expect(idle.lastRunAt).toBeNull();
    const before = Date.now();
    const started = await workspaceStub().sidekickRunNow({ ...addressed(), actor: actor(), idempotencyKey: "asking-run-0001" });
    const working = await listed();
    expect(working.row).toEqual({ runState: "working", pendingQuestion: null, needsInput: false });
    // The row is dated by when the run started, while it works and while it waits.
    expect(Date.parse(working.lastRunAt!)).toBeGreaterThanOrEqual(before);
    // The list is sent again when the run starts working.
    expect(working.waterline).toBeGreaterThan(idle.waterline);
    expect(await runSidekickAlarms(TEST_ENV, WORKSPACE_ID)).toEqual([started.runId]);
    await runSettled(started.runId);
    await deliverChildEffects(TEST_ENV, conversationStub(started.runId));
    const waiting = await rowReaches(started.runId, "needs_input");
    expect(waiting.run?.reply).toBe(question);
    const asking = await listed();
    expect(asking.row).toEqual({ runState: "needs_input", pendingQuestion: question, needsInput: true });
    expect(asking.lastRunAt).toBe(working.lastRunAt);
    expect(asking.waterline).toBeGreaterThan(working.waterline);
    // The Activity row of each person it tells (the requester, and the
    // Organization admin who manages it) carries the question as its preview.
    await expect.poll(async () => {
      await runDurableObjectAlarm(workspaceStub());
      return runInDurableObject(workspaceStub(), (_instance, state) => state.storage.sql.exec<{
        recipient_user_id: string; kind: string; run_id: string; preview: string | null;
      }>(`SELECT recipient_user_id, kind, run_id, preview FROM workspace_activity_items WHERE kind = 'needs_input'
          ORDER BY recipient_user_id`).toArray());
    }, { timeout: SETTLE_TIMEOUT_MS, interval: 100 }).toEqual([
      { recipient_user_id: AUTHOR_ID, kind: "needs_input", run_id: started.runId, preview: question },
      { recipient_user_id: ADMIN_ID, kind: "needs_input", run_id: started.runId, preview: question },
    ]);
  });

  it("sends the Sidekick list with the saved name and state in the save that makes a draft active", async () => {
    const created = await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID, scope: "workspace",
      automationId: AUTOMATION_ID });
    expect(created.created).toBe(true);
    const response = await env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)))
      .fetch("https://workspace.test/socket", { headers: {
        Upgrade: "websocket", "x-rally-workspace-id": WORKSPACE_ID, "x-rally-placement-affinity": "wnam",
        "x-rally-user-id": AUTHOR_ID, "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": crypto.randomUUID(),
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1000) + 60),
      } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const frames: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => { frames.push(JSON.parse(String(event.data)) as Record<string, unknown>); });
    socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
    try {
      await expect.poll(() => frames.some((frame) => frame.type === "workspace_sync"), { timeout: 5_000 }).toBe(true);
      const row = () => frames.filter((frame) => frame.type === "workspace_sidebar_list" && frame.list === "automations")
        .flatMap((frame) => frame.items as Array<{ id: string; name: string; status: string }>)
        .filter((item) => item.id === AUTOMATION_ID).at(-1);
      // The wizard's save: the definition, then Create, in one call.
      await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft: { ...DEFINITION, name: "Haiku writer" },
        evaluatorRules: null, submittedByRunId: null, actor: actor() });
      // Sent by the save itself, which the socket delivers as a message event.
      await expect.poll(row, { timeout: 5_000 }).toMatchObject({ name: "Haiku writer", status: "active" });
      // It wakes on request only: no schedule, so no zone.
      expect(row()).not.toHaveProperty("scheduleTimeZone");
    } finally {
      socket.close();
    }
  });

  it("sends the Sidekick list with the zone its next scheduled run is read in", async () => {
    const created = await createAutomation(TEST_ENV, { workspaceId: WORKSPACE_ID, authorUserId: AUTHOR_ID, scope: "workspace",
      automationId: AUTOMATION_ID });
    expect(created.created).toBe(true);
    const response = await env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)))
      .fetch("https://workspace.test/socket", { headers: {
        Upgrade: "websocket", "x-rally-workspace-id": WORKSPACE_ID, "x-rally-placement-affinity": "wnam",
        "x-rally-user-id": AUTHOR_ID, "x-rally-session-id": SESSION_ID,
        "x-rally-socket-ticket-id": crypto.randomUUID(),
        "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1000) + 60),
      } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const frames: Array<Record<string, unknown>> = [];
    socket.addEventListener("message", (event) => { frames.push(JSON.parse(String(event.data)) as Record<string, unknown>); });
    socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
    try {
      await expect.poll(() => frames.some((frame) => frame.type === "workspace_sync"), { timeout: 5_000 }).toBe(true);
      const row = () => frames.filter((frame) => frame.type === "workspace_sidebar_list" && frame.list === "automations")
        .flatMap((frame) => frame.items as Array<{ id: string; status: string; nextRunAt: string | null; scheduleTimeZone?: string }>)
        .filter((item) => item.id === AUTOMATION_ID).at(-1);
      await workspaceStub().sidekickSaveDefinition({ ...addressed(), draft: { ...DEFINITION, triggers: [
        { type: "manual" },
        { type: "calendar", rrule: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=14;BYMINUTE=0;BYSECOND=0", timezone: "America/Los_Angeles",
          summary: "Every Friday at 2:00 PM" },
      ] }, evaluatorRules: null, submittedByRunId: null, actor: actor() });
      await expect.poll(row, { timeout: 5_000 }).toMatchObject({ status: "active", scheduleTimeZone: "America/Los_Angeles" });
      // Read in that zone, the next run is the time the schedule's summary says.
      const next = row()!;
      expect(new Intl.DateTimeFormat("en-US", { timeZone: next.scheduleTimeZone, weekday: "long", hour: "numeric",
        minute: "2-digit" }).format(new Date(next.nextRunAt!))).toBe("Friday 2:00 PM");
    } finally {
      socket.close();
    }
  });

  it("sends a reader's own read of the shared conversation only to that reader's sockets", async () => {
    await activeSidekick();
    async function open(userId: string, sessionId: string) {
      const response = await env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)))
        .fetch("https://workspace.test/socket", { headers: {
          Upgrade: "websocket", "x-rally-workspace-id": WORKSPACE_ID, "x-rally-placement-affinity": "wnam",
          "x-rally-user-id": userId, "x-rally-session-id": sessionId,
          "x-rally-socket-ticket-id": crypto.randomUUID(),
          "x-rally-socket-ticket-expires-at": String(Math.floor(Date.now() / 1000) + 60),
        } });
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      socket.accept();
      const frames: Array<Record<string, unknown>> = [];
      socket.addEventListener("message", (event) => { frames.push(JSON.parse(String(event.data)) as Record<string, unknown>); });
      socket.send(JSON.stringify({ type: "subscribe", afterWaterline: 0 }));
      await expect.poll(() => frames.some((frame) => frame.type === "workspace_sync"), { timeout: 5_000 }).toBe(true);
      return { socket, frames };
    }
    const author = await open(AUTHOR_ID, SESSION_ID);
    const member = await open(MEMBER_ID, MEMBER_SESSION_ID);
    try {
      author.frames.length = 0;
      member.frames.length = 0;
      // The member's own read report from the shared conversation, as "0"
      // sends it: nothing else happens in the conversation meanwhile, so no
      // other change can move anyone's row.
      const effect = WorkstreamDirectoryUserEffectSchema.parse({ kind: "directory_user", userId: MEMBER_ID,
        isParticipant: true, unreadCount: 0, youAreMentioned: false, listable: true, seenAttentionOrdinal: 3 });
      const envelope = ConversationEffectEnvelopeSchema.parse({
        kind: "conversation_effect", contractVersion: 1, region: "global", workspaceId: WORKSPACE_ID,
        parentKind: "automation", parentId: AUTOMATION_ID, substreamId: "0", generation: 1,
        messageId: `read:${MEMBER_ID}:3`, partitionKey: `${AUTOMATION_ID}:0:user:${MEMBER_ID}`, sourceVersion: 1,
        requiredProjectionVersion: null, payloadHash: conversationEffectHash(effect), effect,
      });
      await runInDurableObject(workspaceStub(), (instance: WorkspaceDO) =>
        instance.receiveChildEffects({ substreamId: asSubstreamId("0"), envelopes: [envelope] }));
      const lists = (frames: Array<Record<string, unknown>>) => frames.filter((frame) =>
        frame.type === "workspace_sidebar_list" && frame.list === "automations");
      await expect.poll(() => lists(member.frames).length, { timeout: 5_000 }).toBe(1);
      expect(lists(member.frames)[0]).toMatchObject({ items: [expect.objectContaining({ id: AUTOMATION_ID, unread: false })] });
      // The author's row did not move, and their socket was told nothing.
      expect(lists(author.frames)).toEqual([]);
    } finally {
      author.socket.close();
      member.socket.close();
    }
  });
});
