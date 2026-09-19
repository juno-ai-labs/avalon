/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { asSubstreamId, asWorkspaceId } from "@rally/contracts";
import { conversationObjectName, workspaceDOName } from "../src/durable-objects/names";
import type { WorkspaceDO } from "../src/durable-objects/workspace-do";
import { encryptString } from "../src/lib/crypto";
import { createToolReceiptObjectPort } from "../src/runtime/tool-receipt-port";
import { cleanupCanvaTransactions } from "../src/services/canva-transaction-cleanup";
import { boot, runInput, seedRun, seedWorkspaceControlPlane, seedWorkstreamRoot } from "./helpers/substream-fixture";

// Real object receipts, real encrypted WorkspaceDO credential storage and the
// normal credential door. Only Canva's external HTTP endpoint is doubled.
describe("Canva post-run cleanup", () => {
  it("cancels an abandoned transaction once and persists completion before replay", async () => {
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000caa1");
    const parentId = "00000000-0000-7000-8000-00000000caa2";
    const userId = "00000000-0000-7000-8000-00000000caa3";
    const runId = "00000000-0000-7000-8000-00000000caa4";
    const connectionId = "00000000-0000-7000-8000-00000000caa5";
    await seedWorkspaceControlPlane(env.DB, { workspaceId, userId, sessionId: "canva-session" });
    const workspace = env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", workspaceId))) as DurableObjectStub<WorkspaceDO>;
    await workspace.initializeWorkspace(workspaceId, "wnam");
    const encrypted = await encryptString(JSON.stringify({ accessToken: "provider-fixture" }), "canva-cleanup-test-key", connectionId);
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name, model_plugin_id,
         encrypted_credentials, credential_iv, credential_key_version, granted_scopes_json, created_at, updated_at)
        VALUES (?, ?, 'canva', 'personal', ?, 'Canva', 'canva-fixture', ?, ?, 1, '["canva.personal.mcp"]', 'now', 'now')`,
      connectionId, workspaceId, userId, encrypted.ciphertext, encrypted.iv);
    });
    const stub = env.SUBSTREAM_AGENTS.getByName(conversationObjectName("global", workspaceId, parentId, asSubstreamId("0")));
    await boot(stub);
    const input = runInput(runId, { workspaceId, parentId, executionPrincipal: { type: "user", userId } });
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId, workstreamId: parentId });
      seedRun(state, runId, "running");
      state.storage.sql.exec("UPDATE runs SET legacy_attempt_id = 'cleanup-attempt', lease_owner = 'cleanup-owner', lease_expires_at = ? WHERE run_id = ?", Date.now() + 600_000, runId);
    });
    const scopedEnv = { ...env, CANVA_CONNECTOR_ENABLED: "true", CONNECTOR_CREDENTIALS_KEY: "canva-cleanup-test-key", CONNECTOR_CREDENTIALS_KEY_VERSION: "1" };
    const receipts = createToolReceiptObjectPort(scopedEnv, workspaceId, parentId);
    const fence = { runId, attemptId: "cleanup-attempt", owner: "cleanup-owner" };
    await receipts.admit({ effectIntentId: "canva-start", runId, toolCallId: "canva-start", toolName: "start-editing-transaction",
      mode: "write", connectionId, requestHash: "request", inputJson: '{"design_id":"design-fixture"}',
      executionPlanHash: "plan", executionPlanJson: '{"mode":"write","capability":"canva.personal.mcp","canonicalToolName":"start-editing-transaction"}',
      compatiblePriorPlanHashes: [], providerIdempotencyKey: null, fence, now: Date.now() });
    await receipts.complete({ effectIntentId: "canva-start", checkpointIndex: 1, outputRef: "fixture-output", outputSummary: "Editing started",
      providerOperationId: "transaction-fixture", payloadJson: "{}", allowAmbiguousReconciliation: false, fence, now: Date.now() });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE runs SET status = 'failed', terminalized_at = ? WHERE run_id = ?", Date.now(), runId);
    });
    const cancellations: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name: string; arguments: unknown } };
      if (!request.id) return new Response(null, { status: 202 });
      if (request.method === "initialize") return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18" } });
      if (request.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: "cancel-editing-transaction", inputSchema: { type: "object" } }] } });
      cancellations.push(request.params);
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { structuredContent: { transaction: { id: "transaction-fixture", status: "cancelled" } } } });
    });
    try {
      expect(await cleanupCanvaTransactions(scopedEnv, input)).toBeNull();
      expect(cancellations).toEqual([{ name: "cancel-editing-transaction", arguments: {
        transaction_id: "transaction-fixture", user_intent: "Use Canva to cancel editing transaction.",
      } }]);
      expect(await receipts.canvaCleanupForRun({ runId })).toMatchObject([{ state: "closed" }]);
      expect(await cleanupCanvaTransactions(scopedEnv, input)).toBeNull();
      expect(cancellations).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); }
  });
});
