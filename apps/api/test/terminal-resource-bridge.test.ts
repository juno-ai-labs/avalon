import { asUserId } from "@rally/contracts";
import type { HarnessToolContext } from "@rally/agent-harness";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TerminalSandboxProvider } from "../src/services/terminal/daytona-provider";
import { createTerminalResourceBridge } from "../src/services/terminal/resource-bridge";
import { withWorkstreamRuntimeDatabase } from "../src/services/workstream-runtime-database";
import type { WorkstreamRuntimeResourceAttacher } from "../src/services/workstream-object-client";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import {
  executeWorkstreamObjectSql,
  openWorkstreamAuthorityForTest,
  seedWorkstreamObjectRoot,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  workstreamObjectGet,
  testTerminalPortFactory,
  seedToolReceipt,
} from "./helpers/durable-authority";
import { preRetirementProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";

const W = "10000000-0000-4000-8000-000000000001";
const S = "10000000-0000-4000-8000-000000000002";
const R = "10000000-0000-4000-8000-000000000003";
const U = asUserId("10000000-0000-4000-8000-000000000004");
const I = "10000000-0000-4000-8000-000000000005";
const RESOURCE = "10000000-0000-4000-8000-000000000006";

const context: HarnessToolContext = {
  workspaceId: W, workstreamId: S, harnessRunId: R, toolCallId: "resource-call",
  // Publication is keyed to the receipt, not the call: `terminal:<id>` is the
  // provider resource identity a retry has to land on again.
  effectIntentId: I,
  executionPrincipal: { type: "user", userId: U }, signal: new AbortController().signal,
};

const openDatabases: ReturnType<typeof preRetirementProductSqliteDatabase>[] = [];
afterEach(() => { for (const database of openDatabases.splice(0)) database.close(); });

function fixture(inObjectResourceAttacher?: WorkstreamRuntimeResourceAttacher) {
  const database = preRetirementProductSqliteDatabase();
  openDatabases.push(database);
  // Publishing attaches resources through the object's RPC surface, which
  // only exists once the durable-object authority is open.
  openWorkstreamAuthorityForTest(database);
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
  `);
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, { workstreamId: S, workspaceId: W });
  executeWorkstreamObjectSql(objectStore, [
    {
      sql: `INSERT INTO harness_runs
              (id, workspace_id, workstream_id, origin, execution_principal_json, status, created_at)
            VALUES (?, ?, ?, 'test', ?, 'running', '2026-08-13')`,
      params: [R, W, S, JSON.stringify({ type: "user", userId: U })],
    },

    {
      sql: `INSERT INTO terminal_workspace
              (id, provider, lifecycle_state, stable_name, sandbox_id, generation,
               authority_fingerprint, applied_network_revision, version, last_command_at,
               created_at, updated_at)
            VALUES (1, 'daytona', 'running', 'resource-sandbox', 'sandbox', 1,
                    'authority', 1, 1, ?, ?, ?)`,
      params: [
        Date.parse("2026-08-13T00:00:00.000Z"),
        Date.parse("2026-08-13T00:00:00.000Z"),
        Date.parse("2026-08-13T00:00:00.000Z"),
      ],
    },
  ]);
  // Terminal reads the receipt id off the tool context, but publication still
  // records its effect against this row.
  seedToolReceipt(objectStore, {
    id: I, runId: R, toolCallId: "resource-call", toolName: "terminal_publish_resource",
  });
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
  const baseEnv = createTestEnv({
    DB: sqliteD1(database), PAYLOADS: bucket, AVALON_REGION: "global", MAX_ATTACHMENT_BYTES: "25000000",
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore, {
      extra: {
        attachRuntimeResource: vi.fn((request: {
          resourceId: string;
          attachedByUserId: string | null;
          relationshipType?: string;
        }) => {
          objectStore.prepare(
            `INSERT OR IGNORE INTO workstream_resource_links
               (resource_id, attached_by_user_id, watch_enabled, relationship_type,
                resource_json, attached_at, updated_at)
             VALUES (?, ?, 0, ?, ?, ?, ?)`,
          ).run(
            request.resourceId,
            request.attachedByUserId,
            request.relationshipType ?? "generated",
            JSON.stringify({ id: request.resourceId }),
            Date.parse("2026-08-13T12:00:00.000Z"),
            Date.parse("2026-08-13T12:00:00.000Z"),
          );
          return { status: 200, bodyJson: JSON.stringify({ ok: true }) };
        }),
      },
    }),
  });
  const env = withWorkstreamRuntimeDatabase(
    baseEnv,
    W,
    S,
    "0",
    async (statements) => executeWorkstreamObjectSql(objectStore, statements),
  );
  const provider: TerminalSandboxProvider = {
    createSandbox: vi.fn(), getSandbox: vi.fn(), startSandbox: vi.fn(), stopSandbox: vi.fn(), archiveSandbox: vi.fn(), deleteSandbox: vi.fn(), updateNetworkPolicy: vi.fn(),
    configureGitHubReadAccess: vi.fn(), clearGitHubReadAccess: vi.fn(),
    readFile: vi.fn(), writeFile: vi.fn(async () => undefined),
    runUtilityCommand: vi.fn(),
    runCommand: vi.fn(async (_id, input) => {
      if (input.taskName.startsWith("avalon-import-check")) return { exitCode: 44, stdout: "", stderr: "" };
      if (input.taskName.startsWith("avalon-import-verify")) return { exitCode: 0, stdout: "14 8a6c44a03adda8a5af9627533116a8ab735dac8085f998c6f41cc13aef707169\n", stderr: "" };
      return { exitCode: input.command.startsWith("mkdir") ? 0 : 1, stdout: "", stderr: "" };
    }),
    publishGitBundle: vi.fn(async (input) => ({ publishedSha: input.headSha })),
  };
  const utilityImplementation = vi.mocked(provider.runCommand).getMockImplementation()!;
  provider.runUtilityCommand = vi.fn((id, input) => utilityImplementation(id, {
    ...input,
    taskName: input.operation === "resource.import.inspect"
      ? "avalon-import-check"
      : input.operation === "resource.import.finalize"
        ? "avalon-import-verify"
        : "terminal-utility",
  }));
  return {
    database,
    objectStore,
    objects,
    put,
    env,
    provider,
    bridge: createTerminalResourceBridge(
      env,
      testTerminalPortFactory(objectStore),
      inObjectResourceAttacher,
    ),
  };
}

describe("Terminal resource bridge", () => {
  it("imports only a currently visible resource and verifies its stored hash", async () => {
    const { database, objectStore, objects, provider, bridge } = fixture();
    const bytes = new TextEncoder().encode("attached data\n");
    const digest = "8a6c44a03adda8a5af9627533116a8ab735dac8085f998c6f41cc13aef707169";
    objects.set("global/source", bytes);
    database.prepare(
      `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, mime_type, content_ref, content_sha256,
        metadata_json, attachment_status, created_at, updated_at)
       VALUES (?, ?, 'uploaded_file', 'avalon_upload', 'Input data.csv', 'text/csv', 'global/source', ?, '{}', 'attached', '2026-08-13', '2026-08-13')`,
    ).run(RESOURCE, W, digest);
    // The attachment membership lives in the object's link table; the compat
    // view over it is read-only, so the fixture writes the table itself.
    objectStore.prepare(
      `INSERT INTO workstream_resource_links
         (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
       VALUES (?, ?, 0, 'attachment', ?, ?, ?)`,
    ).run(RESOURCE, U, JSON.stringify({ id: RESOURCE }), Date.parse("2026-08-13"), Date.parse("2026-08-13"));

    await expect(bridge.importResource(context, { resourceId: RESOURCE }, `.rally/resources/${RESOURCE}/resource`, 1, "sandbox", provider)).resolves.toEqual({
      resourceId: RESOURCE,
      filePath: `.rally/resources/${RESOURCE}/resource`,
      outcome: "created",
      mimeType: "text/csv",
      sizeBytes: 14,
      sourceSha256: digest,
    });
    expect(provider.writeFile).toHaveBeenCalledWith(
      "sandbox",
      expect.stringMatching(/^\/workspace\/\.rally\/tmp\//u),
      bytes,
      context.signal,
    );
    expect(provider.runUtilityCommand).toHaveBeenCalledWith("sandbox", expect.objectContaining({
      command: expect.stringMatching(new RegExp(`target='/workspace/\\.rally/resources/${RESOURCE}/resource'.*mv --`, "su")),
    }));
    expect(workstreamObjectGet(
      objectStore,
      `SELECT destination_path, source_sha256, size_bytes, state, imported_at IS NOT NULL AS imported
         FROM terminal_imported_resources`,
    )).toEqual({
      destination_path: `.rally/resources/${RESOURCE}/resource`,
      source_sha256: digest,
      size_bytes: 14,
      state: "completed",
      imported: 1,
    });
  });

  it("cleans an uploaded import temp file after a provider request failure", async () => {
    const { database, objectStore, objects, provider, bridge } = fixture();
    const bytes = new TextEncoder().encode("attached data\n");
    const digest = "8a6c44a03adda8a5af9627533116a8ab735dac8085f998c6f41cc13aef707169";
    objects.set("global/source", bytes);
    database.prepare(
      `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, mime_type, content_ref, content_sha256,
        metadata_json, attachment_status, created_at, updated_at)
       VALUES (?, ?, 'uploaded_file', 'avalon_upload', 'Input data.csv', 'text/csv', 'global/source', ?, '{}', 'attached', '2026-08-13', '2026-08-13')`,
    ).run(RESOURCE, W, digest);
    objectStore.prepare(
      `INSERT INTO workstream_resource_links
         (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
       VALUES (?, ?, 0, 'attachment', ?, ?, ?)`,
    ).run(RESOURCE, U, JSON.stringify({ id: RESOURCE }), Date.parse("2026-08-13"), Date.parse("2026-08-13"));
    vi.mocked(provider.runUtilityCommand)
      .mockResolvedValueOnce({ exitCode: 44, stdout: "", stderr: "" })
      .mockRejectedValueOnce(new Error("provider unavailable"))
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    await expect(bridge.importResource(
      context,
      { resourceId: RESOURCE },
      `.rally/resources/${RESOURCE}/resource`,
      1,
      "sandbox",
      provider,
    )).rejects.toThrow("provider unavailable");
    expect(provider.runUtilityCommand).toHaveBeenLastCalledWith("sandbox", expect.objectContaining({
      operation: "file.temp_cleanup",
      command: expect.stringMatching(/^rm -f -- /u),
    }));
  });

  it("fails helpfully when a resource is detached before import", async () => {
    const { provider, bridge } = fixture();
    await expect(bridge.importResource(context, { resourceId: RESOURCE }, "input.txt", 1, "sandbox", provider)).rejects.toMatchObject({
      code: "resource_not_found",
      message: expect.stringContaining("list_resources"),
    });
  });

  it("refuses to write through a non-regular explicit destination", async () => {
    const { database, objectStore, objects, provider, bridge } = fixture();
    const bytes = new TextEncoder().encode("attached data\n");
    const digest = "8a6c44a03adda8a5af9627533116a8ab735dac8085f998c6f41cc13aef707169";
    objects.set("global/source", bytes);
    database.prepare(
      `INSERT INTO resources
       (id, workspace_id, resource_type, provider, title, mime_type, content_ref, content_sha256,
        metadata_json, attachment_status, created_at, updated_at)
       VALUES (?, ?, 'uploaded_file', 'avalon_upload', 'Input data.csv', 'text/csv', 'global/source', ?, '{}', 'attached', '2026-08-13', '2026-08-13')`,
    ).run(RESOURCE, W, digest);
    objectStore.prepare(
      `INSERT INTO workstream_resource_links
         (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
       VALUES (?, ?, 0, 'attachment', ?, ?, ?)`,
    ).run(RESOURCE, U, JSON.stringify({ id: RESOURCE }), Date.parse("2026-08-13"), Date.parse("2026-08-13"));
    vi.mocked(provider.runUtilityCommand).mockImplementation(async (_id, input) => input.operation === "resource.import.inspect"
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
    const { database, objectStore, objects, put, bridge } = fixture();
    const bytes = new TextEncoder().encode("# Report\n");
    const result = await bridge.publishResource(context, { filePath: "report.md", displayName: "Analysis" }, bytes);

    expect(result).toMatchObject({ title: "Analysis", provider: "avalon_generated", mimeType: "text/markdown", sizeBytes: 9 });
    const resourceId = String(result.resourceId);
    // The resource row is workspace authority (D1) and the attachment is
    // object authority; the cross-store join production no longer performs is
    // asserted as its two halves.
    const row = database.prepare(
      `SELECT provider, title, mime_type, content_ref, attachment_status
         FROM resources WHERE id = ? AND workspace_id = ?`,
    ).get(resourceId, W);
    expect(row).toMatchObject({ provider: "avalon_generated", title: "Analysis", mime_type: "text/markdown", attachment_status: "attached" });
    // The object's own table, in its own vocabulary: the compatibility view
    // that let a test read it as `workstream_resources` is retired.
    expect(objectStore.prepare(
      "SELECT relationship_type FROM workstream_resource_links WHERE resource_id = ?",
    ).get(resourceId)).toEqual({ relationship_type: "generated" });
    expect(objects.has(String((row as { content_ref: string }).content_ref))).toBe(true);
    expect(put).toHaveBeenCalledOnce();
    expect(database.prepare("SELECT COUNT(*) AS count FROM resource_object_deletion_outbox").get()).toEqual({ count: 0 });
  });

  it("uses the resident resource attacher instead of same-object RPC", async () => {
    const attachResource = vi.fn(async () => undefined);
    const { bridge } = fixture(attachResource);

    const result = await bridge.publishResource(
      context,
      { filePath: "resident-report.md" },
      new TextEncoder().encode("resident output\n"),
    );

    expect(attachResource).toHaveBeenCalledOnce();
    expect(attachResource).toHaveBeenCalledWith({
      workspaceId: W,
      workstreamId: S,
      resourceId: result.resourceId,
      attachedByUserId: U,
    });
  });

  it("refuses to publish when the harness supplied no receipt identity", async () => {
    const { database, put, bridge } = fixture();
    const unreceipted: HarnessToolContext = { ...context };
    delete unreceipted.effectIntentId;

    await expect(bridge.publishResource(unreceipted, { filePath: "report.md" }, new TextEncoder().encode("# Report\n")))
      .rejects.toMatchObject({ code: "tool_receipt_missing" });
    // `terminal:<effect intent>` is what a retry recognizes. Publishing under
    // any other identity would create a second copy on every attempt.
    expect(put).not.toHaveBeenCalled();
    expect(database.prepare("SELECT COUNT(*) AS count FROM resources").get()).toEqual({ count: 0 });
  });

  it("publishes opaque binaries as download-only resources", async () => {
    const { bridge } = fixture();
    await expect(bridge.publishResource(context, { filePath: "program.bin" }, new Uint8Array([0, 255, 1])))
      .resolves.toMatchObject({ attachmentKind: "other", contentMode: "unsupported", derivativeStatus: "unsupported" });
  });
});
