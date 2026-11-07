/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { evictDurableObject, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asUserId, asWorkspaceId, type AutomationDraft } from "@rally/contracts";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import { encryptString } from "../src/lib/crypto";
import { createHarnessRunObjectPort } from "../src/runtime/harness-run-port";
import { createToolReceiptObjectPort } from "../src/runtime/tool-receipt-port";
import { claimHarnessAttempt } from "../src/runtime/harness-run-runtime";
import { __integrationTesting, reenterInterruptedWriteForRecovery } from "../src/services/integrations";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { seedExecutionReceipt, seedWorkspaceControlPlane, seedWorkstreamRoot, runInput } from "./helpers/substream-fixture";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";

const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000e500");
const creator = asUserId("00000000-0000-7000-8000-00000000e501");
const maya = asUserId("00000000-0000-7000-8000-00000000e502");
const sidekickId = "00000000-0000-7000-8000-00000000e503";
const creatorConnection = "00000000-0000-7000-8000-00000000e504";
const mayaConnection = "00000000-0000-7000-8000-00000000e505";
const eventId = "637e7ded325d22be7ba6058201ba155e68316e3d19fc36cac654558b5cda1644";
const workspace = () => env.WORKSPACE_DOS.getByName(workspaceDOName("global", workspaceId));
const address = { workspaceId, automationId: sidekickId };
useHeldEffectQueue();
afterEach(() => vi.unstubAllGlobals());
beforeEach(async () => {
  await reset();
  await seedWorkspaceControlPlane(env.DB, { workspaceId, userId: creator, sessionId: crypto.randomUUID() });
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users(id,name) VALUES (?,'Maya')").bind(maya),
    env.DB.prepare("INSERT INTO workspace_members(workspace_id,user_id,status,role) VALUES (?,?,'active','member')").bind(workspaceId, maya),
  ]);
  await workspace().sidekickCreate({ ...address, authorUserId: creator, scope: "workspace",
    authorityGeneration: 1 });
});
async function allowMaya(allowed: boolean) {
  const request = { ...address, userId: maya, allowed, operationId: crypto.randomUUID() };
  const prepared = await workspace().sidekickPrepareMyDelegation(request);
  return workspace().sidekickSetDelegation({ ...request, expectedGeneration: prepared.generation, source: "self_service" });
}

describe("Sidekick provider recovery on real workerd", () => {
  it.each([
    { status: "executing", calendarId: "primary" },
    { status: "ambiguous", calendarId: "primary" },
    { status: "executing", calendarId: undefined },
  ])("keeps an uncertain Calendar create with Maya after eviction ($status, $calendarId)", async ({ status, calendarId }) => {
    await allowMaya(true);
    for (const [connectionId, owner, token] of [[creatorConnection, creator, "creator-token"], [mayaConnection, maya, "maya-token"]]) {
      const encrypted = await encryptString(JSON.stringify({ accessToken: token, expiresAt: "2099-01-01T00:00:00.000Z" }),
        env.CONNECTOR_CREDENTIALS_KEY!, connectionId);
      await runInDurableObject(workspace(), (_instance, state) => state.storage.sql.exec(`INSERT INTO connector_connections
        (id,workspace_id,connector_type,scope,owner_user_id,display_name,model_plugin_id,granted_scopes_json,status,
         encrypted_credentials,credential_iv,credential_key_version,created_at,updated_at)
        VALUES (?,?,'google','personal',?,'Calendar',?,'["calendar.read","calendar.write"]','healthy',?,?,1,'2026-10-22','2026-10-22')`,
      connectionId!, workspaceId, owner!, owner === maya ? "plugin_maya" : "plugin_creator", encrypted.ciphertext, encrypted.iv));
    }
    const requests: Array<{ method: string; token: string; id?: string }> = [];
    let created = false;
    vi.stubGlobal("fetch", async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(request instanceof Request ? request.url : String(request));
      if (url.hostname !== "www.googleapis.com") throw new Error(`unexpected_test_provider:${url.hostname}`);
      const token = new Headers(init?.headers).get("authorization")!;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as { id: string } : null;
      requests.push({ method, token, ...(body ? { id: body.id } : {}) });
      if (method === "POST") {
        if (!created) { created = true; throw new TypeError("Provider accepted; response lost"); }
        return Response.json({ error: { code: 409, errors: [{ reason: "duplicate" }] } }, { status: 409 });
      }
      expect(url.pathname).toBe(`/calendar/v3/calendars/primary/events/${eventId}`);
      return Response.json({ id: eventId, summary: "Review", status: "confirmed" });
    });
    const draft: AutomationDraft = { name: "Calendar helper", description: "Create an event", overview: "Create an event",
      instructions: "Create the requested calendar event.", definitionVersion: 2, triggers: [{ type: "manual" }],
      requiredCapabilities: [], expectedOutputs: [], defaultBehavior: {}, recommendedPlugins: [], memoryTables: [], customTools: [],
      suggestedScope: "workspace", followUpQuestion: null, elicitation: null, ready: true };
    await workspace().sidekickSubmitDefinition({ ...address, draft, evaluatorRules: null, submittedByRunId: null });
    const actor = { userId: creator, participantOfOwningWorkstream: false };
    await workspace().sidekickApply({ ...address, actor });
    const admitted = await workspace().sidekickRunNow({ ...address, actor, idempotencyKey: "calendar-recovery" });
    // The real receipt and Sidekick run are admitted, but no inference is activated.
    const child = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", workspaceId, sidekickId));
    const input = runInput(crypto.randomUUID(), { workspaceId, parentId: sidekickId, parentKind: "automation",
      executionPrincipal: { type: "user", userId: creator }, automationRun: { schemaVersion: 1, automationId: sidekickId, runId: admitted.runId, definitionRevision: 1,
        trigger: { kind: "manual", requestedByUserId: creator } } });
    await runInDurableObject(child, (_instance, state) => {
      seedWorkstreamRoot(state, Date.now(), { workspaceId, workstreamId: sidekickId });
      seedExecutionReceipt(state, input.harnessRunId, input, Date.now());
    });
    const runs = createHarnessRunObjectPort(env, workspaceId, sidekickId);
    const first = await claimHarnessAttempt(runs, input, { attemptId: crypto.randomUUID(), owner: "first", leaseSeconds: 300 });
    if (first.state !== "claimed") throw new Error("provider_recovery_claim_failed");
    const authoring = await __integrationTesting.loadHarnessTools(withWorkspaceRuntimeDatabase(env, workspaceId),
      { ...input, automationRun: undefined }, undefined, undefined, undefined, undefined, first.lease);
    expect(authoring.plugins.some((candidate) => candidate.canonicalId === `connection:${mayaConnection}`)).toBe(false);
    const inventory = await __integrationTesting.loadHarnessTools(withWorkspaceRuntimeDatabase(env, workspaceId), input,
      undefined, undefined, undefined, undefined, first.lease);
    const plugin = inventory.plugins.find((candidate) => candidate.canonicalId === `connection:${mayaConnection}`)!;
    const tool = plugin.tools.find((candidate) => candidate.definition.name === "calendar.create_event")!;
    const receipts = createToolReceiptObjectPort(env, workspaceId, sidekickId);
    const effectIntentId = crypto.randomUUID();
    const args = { calendarId, summary: "Review", start: "2026-10-23T09:00:00Z", end: "2026-10-23T10:00:00Z" };
    await receipts.admit({ effectIntentId, runId: input.harnessRunId, toolCallId: "create", toolName: "calendar.create_event",
      mode: "write", connectionId: mayaConnection, requestHash: "create-request", inputJson: JSON.stringify(args),
      executionPlanHash: "create-plan", executionPlanJson: JSON.stringify({ pluginId: plugin.canonicalId,
        canonicalToolName: tool.definition.name, capability: tool.definition.capability, mode: "write", idempotency: "provider_key" }),
      compatiblePriorPlanHashes: [], providerIdempotencyKey: "calendar-effect-1",
      fence: { runId: input.harnessRunId, attemptId: first.lease.attemptId, owner: first.lease.owner }, now: Date.now() });
    await expect(tool.execute(args, { workspaceId, workstreamId: sidekickId, harnessRunId: input.harnessRunId,
      toolCallId: "create", effectIntentId, providerIdempotencyKey: "calendar-effect-1", executionPrincipal: input.executionPrincipal,
      signal: new AbortController().signal })).rejects.toThrow("response lost");
    expect(requests).toEqual([{ method: "POST", token: "Bearer maya-token", id: eventId }]);
    await runInDurableObject(child, (_instance, state) => {
      state.storage.sql.exec("UPDATE runs SET lease_expires_at=? WHERE run_id=?", Date.now() - 1, input.harnessRunId);
      if (status === "ambiguous") state.storage.sql.exec("UPDATE tool_effects SET status='ambiguous' WHERE effect_intent_id=?", effectIntentId);
    });
    await evictDurableObject(child);
    const replacement = await claimHarnessAttempt(runs, input, { attemptId: crypto.randomUUID(), owner: "replacement", leaseSeconds: 300 });
    if (replacement.state !== "claimed") throw new Error("provider_recovery_replacement_failed");
    const interrupted = (await receipts.receiptForCall({ runId: input.harnessRunId, toolCallId: "create" }))!;
    await allowMaya(false);
    const denied = await reenterInterruptedWriteForRecovery(env, input, { ...interrupted, startedAt: interrupted.startedAt ?? 0 }, replacement.lease, runs);
    expect(denied.outcome).toBe("unknown");
    expect(requests).toEqual([{ method: "POST", token: "Bearer maya-token", id: eventId }]);
    await allowMaya(true);
    const recovered = await reenterInterruptedWriteForRecovery(env, input, { ...interrupted, startedAt: interrupted.startedAt ?? 0 }, replacement.lease, runs);
    if (!calendarId) {
      expect(recovered.outcome).toBe("unknown");
      expect(requests).toEqual([{ method: "POST", token: "Bearer maya-token", id: eventId }]);
      expect((await receipts.receiptForCall({ runId: input.harnessRunId, toolCallId: "create" }))!.status).not.toBe("completed");
      return;
    }
    expect(recovered).toMatchObject({ outcome: "completed", result: { providerOperationId: eventId,
      output: { id: eventId } } });
    expect(requests).toEqual([{ method: "POST", token: "Bearer maya-token", id: eventId },
      { method: "POST", token: "Bearer maya-token", id: eventId }, { method: "GET", token: "Bearer maya-token" }]);
    expect(await receipts.executionAccount({ runId: input.harnessRunId, effectIntentId })).toMatchObject({
      phase: "served", originalAccount: { connectionId: mayaConnection, grantGeneration: 1 },
      account: { connectionId: mayaConnection, grantGeneration: 3 },
    });
    const completed = (await receipts.receiptForCall({ runId: input.harnessRunId, toolCallId: "create" }))!;
    expect(completed.status).toBe("completed");
    expect(await (await env.PAYLOADS.get(completed.outputRef!))!.json()).toMatchObject({ replayVersion: 1,
      output: { id: eventId } });
  });
});
