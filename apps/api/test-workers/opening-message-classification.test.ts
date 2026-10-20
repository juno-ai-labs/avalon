/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { asSubstreamId, asUserId, asWorkspaceId, asWorkstreamId } from "@rally/contracts";
import type { AuthContext } from "../src/env";
import type { WorkstreamObjectProductService } from "../src/durable-objects/workstream-object-product";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000ad71");
const userId = asUserId("00000000-0000-7000-8000-00000000ad72");
const sessionId = "00000000-0000-7000-8000-00000000ad73";
const auth: AuthContext = { workspaceId, userId, sessionId, region: "global", role: "member" };
let ordinal = 0;
let workstreamId = asWorkstreamId("00000000-0000-7000-8000-00000000ad74");
let classification = "conversation_description";
let confidence = 0.99;
let calls = 0;

beforeEach(async () => {
  await reset();
  ordinal++;
  workstreamId = asWorkstreamId(`00000000-0000-7000-8000-${String(ordinal).padStart(8, "0")}ad74`);
  classification = "conversation_description";
  confidence = 0.99;
  calls = 0;
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId, sessionId });
  await env.WORKSPACE_DOS.getByName(workspaceDOName("global", workspaceId)).initializeWorkspace(workspaceId, "wnam");
  // Only JEV is doubled; product admission and persistence run on real workerd.
  const originalFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === "https://api.typesafe.ai/v1/systemone") {
      calls++;
      return Response.json({ model: "jev-test",
        answers: { opening_message: { type: "choice", choice: classification, confidence } } });
    }
    return originalFetch(url, init);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

function stub(substreamId = "0") {
  return env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", workspaceId, workstreamId, asSubstreamId(substreamId)));
}

// Direct product calls leave activation to their caller, allowing assertions on
// admission without starting an unrelated model loop.
function productOf(instance: unknown): WorkstreamObjectProductService {
  const host = instance as { product: WorkstreamObjectProductService };
  const runtime = host.product as unknown as { env: { TYPESAFE_API_KEY?: string } };
  runtime.env = { ...runtime.env, TYPESAFE_API_KEY: "test-key" };
  return host.product;
}

function opening() {
  return { workspaceId, workstreamId, generation: 1, title: "Launch planning", objective: "",
    descriptionSource: "derived" as const,
    titleStatus: "settled" as const, emailAddress: null, creatorUserId: userId,
    openingMessage: "Launch planning", clientMessageId: "opening", participantUserIds: [],
    attachmentIds: [], modelOverride: "test/primary", executionPrincipal: { type: "user", userId },
    reason: "opening_message" };
}

it.each(["human_to_human", "conversation_description"])("persists a silent Thread opening and replays it: %s", async (choice) => {
  classification = choice;
  await runInDurableObject(stub(), async (instance, state) => {
    const product = productOf(instance);
    const result = await product.initialize(auth, opening());
    expect(result.harnessRunId).toBeNull();
    expect(result.workflowInput).toBeNull();
    expect(state.storage.sql.exec("SELECT exact_state FROM workstream").one().exact_state).toBe("idle");
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM canonical_conversation_turn_details").one().n).toBe(1);
    expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM runs").one().n).toBe(0);
    classification = "prompt_to_process";
    const replay = await product.initialize(auth, opening());
    expect(replay.turnId).toBe(result.turnId);
    expect(replay.harnessRunId).toBeNull();
    expect(calls).toBe(1);
    const next = await product.createMessageForAdmittedSocket(auth, {
      text: "Draft a launch plan", clientMessageId: "followup", mentions: [],
      confirmedParticipantUserIds: [], attachmentIds: [],
    });
    expect(next.activationRequest).not.toBeNull();
    expect(calls).toBe(1);
  });
});

it.each([["prompt_to_process", 0.99], ["human_to_human", 0.5], ["invalid", 0.99]] as const)(
  "starts a Thread for %s at %s", async (choice, score) => {
    classification = choice;
    confidence = score;
    await runInDurableObject(stub(), async (instance, state) => {
      const result = await productOf(instance).initialize(auth, opening());
      expect(result.workflowInput).not.toBeNull();
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM runs").one().n).toBe(1);
    });
  },
);

it.each(["human_to_human", "conversation_description", "prompt_to_process"])("classifies the first Breakout message: %s", async (choice) => {
  classification = choice;
  const childId = "00000000-0000-7000-8000-00000000ad75";
  const child = stub(childId);
  expect((await child.bootstrapRuntime({ workspaceId, parentKind: "workstream",
    parentId: workstreamId, substreamId: childId, generation: 1 })).status).toBe(200);
  await runInDurableObject(child, async (instance, state) => {
    const product = productOf(instance);
    await product.provisionWorkstream({ workspaceId, workstreamId, title: "Launch planning", objective: "",
      scope: "workspace", createdByUserId: userId, participantUserIds: [userId], harnessStatus: "idle",
      emailAddress: null, emailRouteStatus: null, systemKind: null, modelOverride: null, now: Date.now() });
    const message = { text: "Launch planning", clientMessageId: "child-opening", mentions: [],
      confirmedParticipantUserIds: [], attachmentIds: [] };
    const result = await product.createMessageForAdmittedSocket(auth, message);
    expect(result.activationRequest !== null).toBe(choice === "prompt_to_process");
    expect(result.deliveryState).toBe(choice === "prompt_to_process" ? "pending" : "canonical");
    expect(calls).toBe(1);
    if (choice !== "prompt_to_process") {
      expect(state.storage.sql.exec("SELECT COUNT(*) AS n FROM runs").one().n).toBe(0);
      await product.createMessageForAdmittedSocket(auth, message);
      expect(calls).toBe(1);
      const next = await product.createMessageForAdmittedSocket(auth, { ...message,
        text: "Draft the launch plan", clientMessageId: "child-followup" });
      expect(next.activationRequest).not.toBeNull();
      expect(calls).toBe(1);
    }
  });
});
