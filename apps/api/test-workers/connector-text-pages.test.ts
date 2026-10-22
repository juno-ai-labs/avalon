/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { asUserId, asWorkspaceId } from "@rally/contracts";
import type { HarnessToolContext } from "@rally/agent-harness";
import { connectorTextPages } from "../src/services/connector-text-pages";
import { __integrationTesting } from "../src/services/integrations";
import { withWorkspaceRuntimeDatabase } from "../src/services/workspace-runtime-database";
import { workspaceDOName } from "../src/durable-objects/names";
import { encryptString } from "../src/lib/crypto";
import { seedWorkspaceControlPlane } from "./helpers/substream-fixture";

describe("connector text snapshots on real R2", () => {
  it("persists a snapshot across store instances and serves exact byte ranges within its scope", async () => {
    const scope = { region: "global", workspaceId: crypto.randomUUID(), workstreamId: "thread", substreamId: "0", connectionId: "connection" };
    const owned = async () => {};
    const first = connectorTextPages(env.PAYLOADS, scope, owned);
    const id = await first.write(new TextEncoder().encode("first page\nsecond page"));
    const resumed = connectorTextPages(env.PAYLOADS, scope, owned);
    const page = await resumed.read(id, 11, 11);
    expect(new TextDecoder().decode(page.bytes)).toBe("second page");
    expect(page.totalBytes).toBe(22);
    await expect(connectorTextPages(env.PAYLOADS, { ...scope, connectionId: "other" }, owned).read(id, 0, 11)).rejects.toMatchObject({ details: { reason: "text_snapshot_unavailable" } });
    await expect(connectorTextPages(env.PAYLOADS, { ...scope, substreamId: "private" }, owned).read(id, 0, 11)).rejects.toMatchObject({ details: { reason: "text_snapshot_unavailable" } });
  });

  it("refuses snapshot writes after authority is lost", async () => {
    let owned = true;
    const store = connectorTextPages(env.PAYLOADS, { region: "global", workspaceId: crypto.randomUUID(), workstreamId: "thread", substreamId: "0", connectionId: "connection" }, async () => { if (!owned) throw new Error("authority_lost"); });
    await store.write(new TextEncoder().encode("private source"));
    owned = false;
    await expect(store.write(new TextEncoder().encode("new source"))).rejects.toThrow("authority_lost");
  });

  it("pages large Sidekick-creator Docs through the actual host and R2, retaining current connection authorization", async () => {
    const workspaceId = asWorkspaceId(crypto.randomUUID());
    const userId = asUserId(crypto.randomUUID());
    const connectionId = crypto.randomUUID();
    const parentId = crypto.randomUUID();
    await seedWorkspaceControlPlane(env.DB, { workspaceId, userId, sessionId: "creator-text" });
    const workspace = env.WORKSPACE_DOS.getByName(workspaceDOName(env.AVALON_REGION, workspaceId));
    await workspace.initializeWorkspace(workspaceId, "wnam");
    const credentials = await encryptString(JSON.stringify({ accessToken: "test-google-token" }), env.CONNECTOR_CREDENTIALS_KEY, connectionId);
    await runInDurableObject(workspace, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO connector_connections
        (id, workspace_id, connector_type, scope, owner_user_id, display_name, encrypted_credentials, credential_iv,
         granted_scopes_json, model_plugin_id, status, created_at, updated_at)
        VALUES (?, ?, 'google', 'personal', ?, 'Google', ?, ?, '["drive.read","docs.read"]', 'plugin_google', 'healthy', 'now', 'now')`,
      connectionId, workspaceId, userId, credentials.ciphertext, credentials.iv);
    });
    // Google cannot run locally; host authorization, SQLite and R2 are real.
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => String(input).includes("docs.googleapis.com")
      ? Response.json({ documentId: "file", body: { textRun: { content: "x".repeat(640000) + "ending" } } })
      : Response.json({ id: "file", mimeType: "application/vnd.google-apps.document", capabilities: { canDownload: true } }));
    try {
      const testEnv = withWorkspaceRuntimeDatabase({ ...env, GOOGLE_CONNECTOR_OAUTH_CLIENT_ID: "test-client", GOOGLE_CONNECTOR_OAUTH_CLIENT_SECRET: "test-secret" }, workspaceId);
      const load = async () => {
        const catalog = await __integrationTesting.loadAutomationCreatorPluginCatalog(testEnv, workspaceId, userId, undefined, { parentId, substreamId: "0" });
        const tool = catalog.flatMap(plugin => plugin.tools).find(tool => tool.canonicalName === "docs.read_document");
        if (!tool?.execute) throw new Error("docs_reader_missing");
        return { ...tool, execute: tool.execute };
      };
      const context: HarnessToolContext = { workspaceId, workstreamId: parentId, harnessRunId: "creator-run", toolCallId: "read-doc",
        executionPrincipal: { type: "user", userId }, signal: new AbortController().signal };
      let page = await (await load()).execute({ documentId: "file" }, context);
      expect(page.output).toMatchObject({ bytes: 128000, hasMore: true, totalBytes: 640006 });
      const continuation = page.pagination!.continuations[0]!.input;
      while (page.pagination!.continuations.length) page = await (await load()).execute(page.pagination!.continuations[0]!.input, context);
      expect(page.output).toMatchObject({ textContent: "ending", hasMore: false });
      const retainedTool = await load();
      await runInDurableObject(workspace, (_instance, state) => { state.storage.sql.exec("UPDATE connector_connections SET status = 'disabled' WHERE id = ?", connectionId); });
      await expect(retainedTool.execute(continuation, context)).rejects.toMatchObject({ code: "unauthorized" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
