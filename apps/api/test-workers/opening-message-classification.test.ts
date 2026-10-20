/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { asSubstreamId, asUserId, asWorkspaceId } from "@rally/contracts";
import type { AuthContext, Env } from "../src/env";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { WorkstreamObjectClient } from "../src/services/workstream-object-client";
import { WorkstreamObjectCreationService } from "../src/services/workstream-object-creation-service";
import { SubstreamCreationService } from "../src/services/substream-creation-service";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";
import { SCOPE_SHARE_TABLES } from "./helpers/scope-share-tables";
import { useOpenRouterDouble } from "./helpers/openrouter-double";
import { useSelectedModel } from "./helpers/selected-model";

let workspaceId = asWorkspaceId(crypto.randomUUID());
const userId = asUserId("00000000-0000-7000-8000-00000000ad72");
const sessionId = "00000000-0000-7000-8000-00000000ad73";
const auth: AuthContext = { workspaceId, userId, sessionId, region: "global", role: "member" };
let classification = "conversation_description";
let confidence = 0.99;
let calls = 0;
const mutableEnv: { TYPESAFE_API_KEY?: string } = env;
const originalKey = mutableEnv.TYPESAFE_API_KEY;
useSelectedModel();
const provider = useOpenRouterDouble((call) => ({ say: call.stream
  ? "Here is the launch plan."
  : JSON.stringify(call.body.response_format ?? {}).includes("substream_context_summary")
    ? JSON.stringify({ summary: "Launch context." })
    : JSON.stringify({ title: "Launch planning", icon: "megaphone" }) }));

function workspace() {
  return env.WORKSPACE_DOS.getByName(workspaceDOName("global", workspaceId));
}
function conversation(workstreamId: string, substreamId = "0") {
  return env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", workspaceId, workstreamId, asSubstreamId(substreamId)));
}
function creationEnv(): Env {
  return new Proxy(env, { get: (current, property, receiver) => property === "WORKSTREAM_EMAIL_ADDRESS_KEY"
    ? "workerd-test-email-address-key-0123456789" : Reflect.get(current, property, receiver) });
}
function opening() {
  return { title: "Launch planning", openingMessage: "Launch planning", clientMessageId: "opening",
    participantUserIds: [], attachmentIds: [] };
}

beforeEach(async () => {
  await reset();
  workspaceId = asWorkspaceId(crypto.randomUUID());
  auth.workspaceId = workspaceId;
  classification = "conversation_description";
  confidence = 0.99;
  calls = 0;
  mutableEnv.TYPESAFE_API_KEY = "test-key";
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId, sessionId });
  await env.DB.batch([
    ...SCOPE_SHARE_TABLES.map((sql) => env.DB.prepare(sql)),
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
  ]);
  await workspace().initializeWorkspace(workspaceId, "wnam");
  // Only remote model providers are doubled; ingress, dispatch and activation
  // use the same services and bindings as production.
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === "https://api.typesafe.ai/v1/systemone") {
      const request = JSON.parse(String(init?.body));
      // Post-run classifiers are outside this admission test. Exercise their
      // unavailable-provider path without counting them as opening decisions.
      if (!request.questions?.opening_message) return new Response("", { status: 503 });
      calls++;
      return Response.json({ model: "jev-test",
        answers: { opening_message: { type: "choice", choice: classification, confidence } } });
    }
    return originalFetch(url, init);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete mutableEnv.TYPESAFE_API_KEY;
  else mutableEnv.TYPESAFE_API_KEY = originalKey;
});

async function texts(client: WorkstreamObjectClient) {
  return (await client.boot()).transcript.ranges.flatMap((range) => range.turns)
    .flatMap((turn) => turn.blocks).filter((block) => block.type === "text").map((block) => block.text);
}
async function reply(client: WorkstreamObjectClient, workstreamId: string, substreamId = "0") {
  await runDurableObjectAlarm(conversation(workstreamId, substreamId));
  await expect.poll(() => texts(client), { timeout: 30_000 }).toContain("Here is the launch plan.");
}
async function silent(client: WorkstreamObjectClient, workstreamId: string, substreamId = "0") {
  const stub = conversation(workstreamId, substreamId);
  await runDurableObjectAlarm(stub);
  expect(await runInDurableObject(stub, (_instance, state) =>
    state.storage.sql.exec("SELECT COUNT(*) AS n FROM runs").one().n)).toBe(0);
  expect(await texts(client)).toContain("Launch planning");
  expect(provider.calls.filter((call) => call.stream)).toHaveLength(0);
}

it.each(["human_to_human", "conversation_description"])("creates and publicly replays a silent Thread, then answers a follow-up: %s", async (choice) => {
  classification = choice;
  const service = new WorkstreamObjectCreationService(creationEnv(), auth);
  const created = await service.create(opening());
  expect(created.harnessRunId).toBeNull();
  const client = new WorkstreamObjectClient(creationEnv(), auth, created.workstream.id);
  await silent(client, created.workstream.id);
  classification = "prompt_to_process";
  const replay = await service.create(opening());
  expect(replay.turnId).toBe(created.turnId);
  expect(replay.harnessRunId).toBeNull();
  expect(calls).toBe(1);
  await client.createMessage({ text: "Draft a launch plan", clientMessageId: "followup", mentions: [],
    confirmedParticipantUserIds: [], attachmentIds: [] });
  await reply(client, created.workstream.id);
  expect(calls).toBe(1);
});

it.each([["prompt_to_process", 0.99], ["human_to_human", 0.5], ["invalid", 0.99]] as const)(
  "answers a Thread opening for %s at %s", async (choice, score) => {
    classification = choice;
    confidence = score;
    const created = await new WorkstreamObjectCreationService(creationEnv(), auth).create(opening());
    expect(created.harnessRunId).not.toBeNull();
    await reply(new WorkstreamObjectClient(creationEnv(), auth, created.workstream.id), created.workstream.id);
  },
);

it.each(["human_to_human", "conversation_description", "prompt_to_process"])("classifies a Breakout's first local message and executes follow-ups: %s", async (choice) => {
  classification = choice;
  const parent = await new WorkstreamObjectCreationService(creationEnv(), auth).createPrepared({
    title: "Parent", clientMessageId: "parent", participantUserIds: [],
  }, { messages: [{ role: "user", text: "Source context" }] });
  const service = new SubstreamCreationService(creationEnv(), auth);
  const prepared = await service.prepare(parent.workstream.id, { operationId: crypto.randomUUID(),
    title: "Launch planning", throughTurnId: parent.turnId });
  const child = await service.confirm(parent.workstream.id, prepared.operationId);
  const client = new WorkstreamObjectClient(creationEnv(), auth, parent.workstream.id, child.substreamId);
  const message = { text: "Launch planning", clientMessageId: "child-opening", mentions: [],
    confirmedParticipantUserIds: [], attachmentIds: [] };
  await client.createMessage(message);
  expect(calls).toBe(1);
  if (choice !== "prompt_to_process") {
    await silent(client, parent.workstream.id, child.substreamId);
    await client.createMessage(message);
    expect(calls).toBe(1);
    await client.createMessage({ ...message, text: "Draft the launch plan", clientMessageId: "child-followup" });
  }
  await reply(client, parent.workstream.id, child.substreamId);
  expect(calls).toBe(1);
});

it.each(["slack", "opportunity"])("keeps explicit %s invocations out of opening classification", async (kind) => {
  const options = kind === "slack" ? { slackOrigin: {
    teamId: "T1", channelId: "C1", channelName: null, threadTs: "1.0",
    invocationType: "app_mention" as const, channelType: "public" as const, matchedAvalonUserId: userId,
    nearbyMessagesStatus: "not_applicable" as const, nearbyMessages: [], attachments: [],
  } } : { reason: "work_opportunity", opportunitySnapshot: {
    opportunityId: crypto.randomUUID(), version: 1, displayPromptHash: "display", executionPromptHash: "execution",
  } };
  const created = await new WorkstreamObjectCreationService(creationEnv(), auth).create(opening(), options);
  expect(created.harnessRunId).not.toBeNull();
  expect(calls).toBe(0);
  await reply(new WorkstreamObjectClient(creationEnv(), auth, created.workstream.id), created.workstream.id);
});
