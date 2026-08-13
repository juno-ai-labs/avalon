import type { HarnessToolContext } from "@avalon/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { createTerminalResourceBridge } from "../src/services/terminal/resource-bridge";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import { migratedSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const W = "10000000-0000-4000-8000-000000000001";
const S = "10000000-0000-4000-8000-000000000002";
const R = "10000000-0000-4000-8000-000000000003";
const U = "10000000-0000-4000-8000-000000000004";
const I = "10000000-0000-4000-8000-000000000005";
const RESOURCE = "10000000-0000-4000-8000-000000000006";

const context: HarnessToolContext = {
  workspaceId: W, workstreamId: S, harnessRunId: R, toolCallId: "resource-call",
  executionPrincipal: { type: "user", userId: U }, signal: new AbortController().signal,
};

const openDatabases: ReturnType<typeof migratedSqliteDatabase>[] = [];
afterEach(() => { for (const database of openDatabases.splice(0)) database.close(); });

function fixture() {
  const database = migratedSqliteDatabase();
  openDatabases.push(database);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
    VALUES ('${U}', 'resource-user', 'resource@example.com', 'Resource', '2026-08-13', '2026-08-13');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
    VALUES ('${W}', 'Resource', 'terminal-resource', 'global', '${U}', '2026-08-13', '2026-08-13');
    INSERT INTO workstreams
      (id, workspace_id, title, objective, origin_type, created_by_user_id,
       harness_status, last_activity_at, created_at, updated_at)
    VALUES ('${S}', '${W}', 'Resource', 'Resource', 'ad_hoc', '${U}', 'idle',
            '2026-08-13', '2026-08-13', '2026-08-13');
    INSERT INTO harness_runs
      (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
    VALUES ('${R}', '${W}', '${S}', 'test', '{"type":"user","userId":"${U}"}', 'running', '2026-08-13');
    INSERT INTO tool_invocations
      (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name, input_hash, input_json, status)
    VALUES ('${I}', '${W}', '${S}', '${R}', 'resource-call', 'terminal_publish_resource', 'hash', '{}', 'started');
    INSERT INTO workstream_sandboxes
      (workspace_id, workstream_id, state, stable_name, provider_sandbox_id, generation,
       authority_fingerprint, applied_network_revision, version, last_activity_at,
       created_at, updated_at)
    VALUES ('${W}', '${S}', 'running', 'resource-sandbox', 'sandbox', 1,
            'authority', 1, 1, '2026-08-13', '2026-08-13', '2026-08-13');
  `);
  const objects = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, value: Uint8Array | string) => {
    objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : value);
  });
  const bucket = createCloudflareTestBinding<R2Bucket>({
    put,
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : null;
    }),
    delete: vi.fn(async (key: string) => { objects.delete(key); }),
  });
  const env = createTestEnv({
    DB: sqliteD1(database), PAYLOADS: bucket, AVALON_REGION: "global", MAX_ATTACHMENT_BYTES: "25000000",
  });
  const provider: TerminalSandboxProvider = {
    createSandbox: vi.fn(), getSandbox: vi.fn(), startSandbox: vi.fn(), stopSandbox: vi.fn(), archiveSandbox: vi.fn(), deleteSandbox: vi.fn(), updateNetworkPolicy: vi.fn(),
    configureGitHubReadAccess: vi.fn(), clearGitHubReadAccess: vi.fn(),
    readFile: vi.fn(), writeFile: vi.fn(async () => undefined),
    runCommand: vi.fn(async (_id, input) => {
      if (input.taskName.startsWith("avalon-import-check")) return { exitCode: 44, stdout: "", stderr: "" };
      if (input.taskName.startsWith("avalon-import-verify")) return { exitCode: 0, stdout: "14 8a6c44a03adda8a5af9627533116a8ab735dac8085f998c6f41cc13aef707169\n", stderr: "" };
      return { exitCode: input.command.startsWith("mkdir") ? 0 : 1, stdout: "", stderr: "" };
    }),
    publishGitBundle: vi.fn(async (input) => ({ publishedSha: input.headSha })),
  };
  return { database, objects, put, env, provider, bridge: createTerminalResourceBridge(env) };
}

describe("Terminal resource bridge", () => {
  it("imports only a currently visible resource and verifies its stored hash", async () => {
    const { database, objects, provider, bridge } = fixture();
    const bytes = new TextEncoder().encode("attached data\n");
    const digest = "8a6c44a03adda8a5af9627533116a8ab735dac8085f998c6f41cc13aef707169";
    objects.set("global/source", bytes);
    database.prepare(
      `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, mime_type, content_ref, content_sha256,
        metadata_json, attachment_status, created_at, updated_at)
       VALUES (?, ?, 'uploaded_file', 'avalon_upload', 'Input data.csv', 'text/csv', 'global/source', ?, '{}', 'attached', '2026-08-13', '2026-08-13')`,
    ).run(RESOURCE, W, digest);
    database.prepare(
      "INSERT INTO workstream_resources (workstream_id, resource_id, attached_by_user_id, relationship_type, attached_at) VALUES (?, ?, ?, 'attachment', '2026-08-13')",
    ).run(S, RESOURCE, U);

    await expect(bridge.importResource(context, { resourceId: RESOURCE }, `.avalon/resources/${RESOURCE}/resource`, 1, "sandbox", provider)).resolves.toEqual({
      resourceId: RESOURCE,
      filePath: `.avalon/resources/${RESOURCE}/resource`,
      outcome: "created",
      mimeType: "text/csv",
      sizeBytes: 14,
      sourceSha256: digest,
    });
    expect(provider.writeFile).toHaveBeenCalledWith("sandbox", `/workspace/.avalon/resources/${RESOURCE}/resource`, bytes, context.signal);
    expect(database.prepare(
      `SELECT destination_path, source_sha256, size_bytes, state, imported_at IS NOT NULL AS imported
         FROM sandbox_imported_resources WHERE workspace_id = ? AND workstream_id = ?`,
    ).get(W, S)).toEqual({
      destination_path: `.avalon/resources/${RESOURCE}/resource`,
      source_sha256: digest,
      size_bytes: 14,
      state: "completed",
      imported: 1,
    });
  });

  it("fails helpfully when a resource is detached before import", async () => {
    const { provider, bridge } = fixture();
    await expect(bridge.importResource(context, { resourceId: RESOURCE }, "input.txt", 1, "sandbox", provider)).rejects.toMatchObject({
      code: "resource_not_found",
      message: expect.stringContaining("list_resources"),
    });
  });

  it("refuses to write through a non-regular explicit destination", async () => {
    const { database, objects, provider, bridge } = fixture();
    const bytes = new TextEncoder().encode("attached data\n");
    const digest = "8a6c44a03adda8a5af9627533116a8ab735dac8085f998c6f41cc13aef707169";
    objects.set("global/source", bytes);
    database.prepare(
      `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, mime_type, content_ref, content_sha256,
        metadata_json, attachment_status, created_at, updated_at)
       VALUES (?, ?, 'uploaded_file', 'avalon_upload', 'Input data.csv', 'text/csv', 'global/source', ?, '{}', 'attached', '2026-08-13', '2026-08-13')`,
    ).run(RESOURCE, W, digest);
    database.prepare(
      "INSERT INTO workstream_resources (workstream_id, resource_id, attached_by_user_id, relationship_type, attached_at) VALUES (?, ?, ?, 'attachment', '2026-08-13')",
    ).run(S, RESOURCE, U);
    vi.mocked(provider.runCommand).mockImplementation(async (_id, input) => input.taskName.startsWith("avalon-import-check")
      ? { exitCode: 45, stdout: "", stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" });

    await expect(bridge.importResource(
      context,
      { resourceId: RESOURCE, destinationPath: "linked-input.csv", overwrite: true },
      "linked-input.csv",
      1,
      "sandbox",
      provider,
    )).rejects.toMatchObject({
      code: "destination_not_regular",
      message: expect.stringContaining("not a regular file"),
    });
    expect(provider.writeFile).not.toHaveBeenCalled();
  });

  it("publishes a supported regular file as an attached resource with durable cleanup ownership", async () => {
    const { database, objects, put, bridge } = fixture();
    const bytes = new TextEncoder().encode("# Report\n");
    const result = await bridge.publishResource(context, { filePath: "report.md", displayName: "Analysis" }, bytes);

    expect(result).toMatchObject({ title: "Analysis", provider: "avalon_generated", mimeType: "text/markdown", sizeBytes: 9 });
    const resourceId = String(result.resourceId);
    const row = database.prepare(
      `SELECT r.provider, r.title, r.mime_type, r.content_ref, r.attachment_status, wr.relationship_type
         FROM resources r JOIN workstream_resources wr ON wr.resource_id = r.id
        WHERE r.id = ? AND r.workspace_id = ? AND wr.workstream_id = ?`,
    ).get(resourceId, W, S);
    expect(row).toMatchObject({ provider: "avalon_generated", title: "Analysis", mime_type: "text/markdown", attachment_status: "attached", relationship_type: "generated" });
    expect(objects.has(String((row as { content_ref: string }).content_ref))).toBe(true);
    expect(put).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT COUNT(*) AS count FROM resource_object_deletion_outbox").get()).toEqual({ count: 0 });
  });

  it("publishes opaque binaries as download-only resources", async () => {
    const { bridge } = fixture();
    await expect(bridge.publishResource(context, { filePath: "program.bin" }, new Uint8Array([0, 255, 1])))
      .resolves.toMatchObject({ attachmentKind: "other", contentMode: "unsupported", derivativeStatus: "unsupported" });
  });
});
