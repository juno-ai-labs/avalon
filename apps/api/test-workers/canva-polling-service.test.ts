/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { asWorkspaceId } from "@rally/contracts";
import { WorkspaceConnectorEventQueueMessageSchema } from "../src/durable-objects/workspace-connector-event-protocol";
import { workspaceDOName } from "../src/durable-objects/names";
import { encryptString } from "../src/lib/crypto";
import { protectCanvaReference } from "../src/services/canva-resource-access";
import { commitConnectorCursor, pollConnectorConnection } from "../src/services/integrations";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

// Provider HTTP is the only double. Checkpoints survive actual object eviction;
// changed events go through the real Queue producer and WorkspaceDO ingress.
describe("Canva polling service", () => {
  it("resumes an explicit protected design watch, deduplicates delivery and stops a paused watch", async () => {
    const workspaceId = asWorkspaceId("00000000-0000-7000-8000-00000000cab1");
    const userId = "00000000-0000-7000-8000-00000000cab2";
    const connectionId = "00000000-0000-7000-8000-00000000cab3";
    const resourceId = "00000000-0000-7000-8000-00000000cab4";
    const pollScheduleId = "00000000-0000-7000-8000-00000000cab5";
    const workstreamId = "00000000-0000-7000-8000-00000000cab6";
    const testEnv = { ...env, CONNECTOR_CREDENTIALS_KEY: "canva-poll-test-key", CONNECTOR_CREDENTIALS_KEY_VERSION: "1" };
    await seedWorkspaceControlPlane(env.DB, { workspaceId, userId, sessionId: "canva-poll-session" });
    const workspace = env.WORKSPACE_DOS.getByName(workspaceDOName("global", workspaceId));
    await workspace.initializeWorkspace(workspaceId, "wnam");
    const sealed = await encryptString(JSON.stringify({ accessToken: "provider-fixture" }), testEnv.CONNECTOR_CREDENTIALS_KEY, connectionId);
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name, model_plugin_id,
         encrypted_credentials, credential_iv, credential_key_version, granted_scopes_json, created_at, updated_at)
        VALUES (?, ?, 'canva', 'personal', ?, 'Canva', 'canva-poll-fixture', ?, ?, 1, '["canva.personal.mcp"]', 'now', 'now')`,
      connectionId, workspaceId, userId, sealed.ciphertext, sealed.iv);
    });
    const accessUrl = "https://www.canva.com/design/design-fixture/edit?utm_content=fixture&token=private-fixture";
    const reference = await protectCanvaReference(testEnv, workspaceId, connectionId, accessUrl);
    await workspace.resolveConnectorResource({ workspaceId, candidateResourceId: resourceId, connectionId,
      provider: "canva", providerResourceId: "design-fixture", resourceType: "canva_design", title: "Fixture",
      canonicalUrl: reference.canonicalUrl, protectedAccessJson: reference.protectedAccessJson, at: new Date().toISOString() });
    await workspace.enableResourceWatch({ workspaceId, watchId: pollScheduleId, workstreamId, resourceId, connectionId,
      watchType: "incremental", nextPollAt: new Date().toISOString(), at: new Date().toISOString() });
    let revision = 10;
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      if (!request.id) return new Response(null, { status: 202 });
      if (request.method === "initialize") return Response.json({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18" } });
      if (request.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: request.id, result: { tools: ["get-design", "list-comments", "list-replies"].map(name => ({ name, inputSchema: { type: "object" } })) } });
      calls.push(request.params);
      const result = request.params.name === "get-design"
        ? { design: { id: "design-fixture", title: "Fixture", updated_at: revision } }
        : { items: [] };
      return Response.json({ jsonrpc: "2.0", id: request.id, result: { structuredContent: result } });
    });
    const send = vi.spyOn(env.ACTIVITY_QUEUE, "send");
    const scoped = withWorkspaceRuntimeDatabase(testEnv, workspaceId);
    const input = { workspaceId, connectionId, pollScheduleId };
    try {
      const baseline = await pollConnectorConnection(scoped, input);
      expect(baseline.activityIds).toEqual([]);
      expect(calls.find(call => call.name === "get-design")?.arguments.design_id).toBe(accessUrl);
      await commitConnectorCursor(scoped.DB, input, { baseCursorJson: baseline.baseCursorJson, cursorJson: JSON.stringify(baseline.cursor) }, new Date().toISOString());
      await evictDurableObject(workspace);
      revision = 11;
      const changed = await pollConnectorConnection(scoped, input);
      expect(changed.activityIds).toHaveLength(1);
      const message = WorkspaceConnectorEventQueueMessageSchema.parse(send.mock.calls.find(([body]) => (body as { kind?: string }).kind === "workspace_connector_event")?.[0]);
      expect(message).toBeDefined();
      const accepted = await workspace.ingestConnectorEvent(message.request);
      const replayed = await workspace.ingestConnectorEvent(message.request);
      expect(accepted.duplicate).toBe(false);
      expect(replayed).toMatchObject({ eventId: accepted.eventId, duplicate: true });
      await commitConnectorCursor(scoped.DB, input, { baseCursorJson: changed.baseCursorJson, cursorJson: JSON.stringify(changed.cursor) }, new Date().toISOString());
      expect((await pollConnectorConnection(scoped, input)).activityIds).toEqual([]);
      await scoped.DB.prepare("UPDATE resource_watches SET enabled = 0 WHERE id = ?").bind(pollScheduleId).run();
      const beforePaused = calls.length;
      expect((await pollConnectorConnection(scoped, input)).activityIds).toEqual([]);
      expect(calls).toHaveLength(beforePaused);
    } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
  });
});
