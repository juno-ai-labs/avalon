import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import { __integrationTesting } from "../src/services/integrations";
import {
  createWorkstreamAttachmentTools,
  rehydrateWorkstreamViewReceipt,
} from "../src/services/workstream-attachment-tools";
import { createCloudflareTestBinding, createTestD1Database, createTestD1PreparedStatement, createTestD1Result, createTestEnv } from "./helpers/cloudflare-test";

const migrationsDirectory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));
const USER_ID = "00000000-0000-4000-8000-000000000000";
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000009";
const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
const WORKSTREAM_ID = "00000000-0000-4000-8000-000000000002";
const HARNESS_RUN_ID = "00000000-0000-4000-8000-000000000003";
const SOURCE_HASH = "a".repeat(64);
const DERIVATIVE_HASH = "b".repeat(64);

class SqliteStatement {
  private values: unknown[] = [];
  constructor(private readonly statement: StatementSync) {}
  bind(...values: unknown[]): SqliteStatement { this.values = values; return this; }
  async run(): Promise<D1Result<unknown>> {
    const result = this.statement.run(...this.values as SQLInputValue[]);
    return createTestD1Result<unknown>({ success: true, meta: { changes: Number(result.changes) } });
  }
  async first<T>(): Promise<T | null> { return (this.statement.get(...this.values as SQLInputValue[]) as T | undefined) ?? null; }
  async all<T>(): Promise<D1Result<T>> {
    return createTestD1Result<T>({ success: true, results: this.statement.all(...this.values as SQLInputValue[]) as T[], meta: { changes: 0 } });
  }
}

function sqliteD1(database: DatabaseSync): D1Database {
  return createTestD1Database({
    prepare: (sql: string) => createTestD1PreparedStatement(new SqliteStatement(database.prepare(sql))),
    batch: async (statements: D1PreparedStatement[]) => {
      const results: D1Result<unknown>[] = [];
      database.exec("BEGIN");
      try {
        for (const statement of statements) results.push(await (statement as unknown as SqliteStatement).run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  });
}

class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();
  async get(key: string): Promise<{ text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> } | null> {
    const bytes = this.objects.get(key);
    return bytes ? {
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    } : null;
  }
  async put(key: string, value: string | ArrayBuffer): Promise<void> {
    this.objects.set(key, typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value));
  }
  async delete(key: string): Promise<void> { this.objects.delete(key); }
}

const openDatabases: DatabaseSync[] = [];
afterEach(() => { for (const database of openDatabases.splice(0)) database.close(); });

function fixture(options: { images?: ImagesBinding } = {}) {
  const database = new DatabaseSync(":memory:");
  openDatabases.push(database);
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`${migrationsDirectory}/${fileName}`, "utf8"));
  }
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES
      ('${USER_ID}', 'owner', 'owner@example.test', 'Owner', '2026-01-01', '2026-01-01'),
      ('${OTHER_USER_ID}', 'other', 'other@example.test', 'Other', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('${WORKSPACE_ID}', 'Attachments', 'attachments', 'global', '${USER_ID}', '2026-01-01', '2026-01-01');
    INSERT INTO workstreams (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status, last_activity_at, created_at, updated_at)
      VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Attachments', 'Read safely', 'ad_hoc', '${USER_ID}', 'running', '2026-01-01', '2026-01-01', '2026-01-01');
  `);
  const bucket = new MemoryBucket();
  return {
    database,
    bucket,
    env: createTestEnv({
      DB: sqliteD1(database), PAYLOADS: createCloudflareTestBinding<R2Bucket>(bucket),
      ...(options.images ? { IMAGES: options.images } : {}),
      SESSION_SIGNING_KEY: "attachment-test-session-signing-key", AVALON_REGION: "global", APP_ENV: "test",
    }),
  };
}

function imageTransformBinding(
  transforms: Array<{ width?: number; height?: number }>,
  failure = false,
): ImagesBinding {
  return createCloudflareTestBinding<ImagesBinding>({
    input() {
      const transformer = {
        transform(value: { width?: number; height?: number }) { transforms.push(value); return transformer; },
        async output() {
          if (failure) throw new Error("normalization failed");
          const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
          return { image: () => new Blob([bytes]).stream() };
        },
      };
      return transformer;
    },
  });
}

function input(principal: WorkstreamWorkflowInput["executionPrincipal"] = { type: "user", userId: USER_ID }): WorkstreamWorkflowInput {
  return {
    region: "global", workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, harnessRunId: HARNESS_RUN_ID,
    triggerMessageId: null, automationSubscriptionId: null, activityId: null, executionPrincipal: principal, reason: "test",
  };
}

function context(principal = input().executionPrincipal) {
  return {
    workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, harnessRunId: HARNESS_RUN_ID,
    toolCallId: "tool-call", executionPrincipal: principal, signal: new AbortController().signal,
  };
}

function insertReadyResource(database: DatabaseSync, bucket: MemoryBucket, ordinal: number, options: { mime?: string; title?: string } = {}): string {
  const id = `10000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`;
  const title = options.title ?? `Resource ${ordinal}`;
  const mime = options.mime ?? "text/markdown";
  const text = `# ${title}\n\nNeedle evidence ${ordinal}.\n\n${"bounded text ".repeat(1_500)}`;
  const contentRef = `original/${id}`;
  const modelRef = `model/${id}.md`;
  const indexRef = `model/${id}.json`;
  bucket.objects.set(contentRef, new TextEncoder().encode(text));
  bucket.objects.set(modelRef, new TextEncoder().encode(text));
  bucket.objects.set(indexRef, new TextEncoder().encode(JSON.stringify({
    offsetUnit: "utf16", totalCharacters: text.length,
    chunks: [{ ordinal: 0, start: 0, end: text.length, sectionLabel: title, terms: ["needle", "evidence", String(ordinal)] }],
  })));
  database.prepare(`
    INSERT INTO resources
      (id, workspace_id, resource_type, provider, title, mime_type, content_ref, metadata_json,
       created_at, updated_at, content_sha256, model_content_ref, model_mime_type,
       model_content_sha256, model_metadata_json, model_index_ref, model_content_status,
       model_content_extractor_version, model_content_character_count, model_content_extracted_at)
    VALUES (?, ?, 'file', 'avalon_upload', ?, ?, ?, '{"size":123}', ?, ?, ?, ?, 'text/markdown', ?, '{}', ?, 'ready',
            'attachment-text-v1', ?, ?)
  `).run(id, WORKSPACE_ID, title, mime, contentRef, `2026-08-12T00:${String(ordinal).padStart(2, "0")}:00.000Z`, `2026-08-12T00:${String(ordinal).padStart(2, "0")}:00.000Z`, SOURCE_HASH, modelRef, DERIVATIVE_HASH, indexRef, text.length, "2026-08-12T01:00:00.000Z");
  database.prepare(`
    INSERT INTO workstream_resources
      (workstream_id, resource_id, attached_by_user_id, watch_enabled, relationship_type, attached_at)
    VALUES (?, ?, ?, 0, 'context', ?)
  `).run(WORKSTREAM_ID, id, USER_ID, `2026-08-12T00:${String(ordinal).padStart(2, "0")}:00.000Z`);
  return id;
}

function insertReadyImage(database: DatabaseSync, bucket: MemoryBucket, ordinal: number): string {
  const id = `30000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`;
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const contentRef = `original/${id}.png`;
  const modelRef = `model/${id}.png`;
  const imageHash = createHash("sha256").update(bytes).digest("hex");
  bucket.objects.set(contentRef, bytes);
  bucket.objects.set(modelRef, bytes);
  database.prepare(`
    INSERT INTO resources
      (id, workspace_id, resource_type, provider, title, mime_type, content_ref, metadata_json,
       created_at, updated_at, content_sha256, model_content_ref, model_mime_type,
       model_content_sha256, model_metadata_json, model_index_ref, model_content_status,
       model_content_extractor_version, model_content_character_count, model_content_extracted_at)
    VALUES (?, ?, 'file', 'avalon_upload', 'Diagram', 'image/png', ?, '{"size":8}', ?, ?, ?, ?, 'image/png', ?, NULL, NULL, 'ready',
            'image-v1', NULL, ?)
  `).run(id, WORKSPACE_ID, contentRef, "2026-08-12T02:00:00.000Z", "2026-08-12T02:00:00.000Z", SOURCE_HASH, modelRef, imageHash, "2026-08-12T02:00:00.000Z");
  database.prepare(`
    INSERT INTO workstream_resources
      (workstream_id, resource_id, attached_by_user_id, watch_enabled, relationship_type, attached_at)
    VALUES (?, ?, ?, 0, 'context', ?)
  `).run(WORKSTREAM_ID, id, USER_ID, "2026-08-12T02:00:00.000Z");
  return id;
}

describe("work-stream attachment tools", () => {
  it("lists more than fifty visible resources without duplicates and filters by every natural-language kind", async () => {
    const { database, bucket, env } = fixture();
    for (let ordinal = 0; ordinal < 55; ordinal += 1) insertReadyResource(database, bucket, ordinal);
    const imageId = insertReadyResource(database, bucket, 55, { mime: "image/png", title: "Diagram" });
    const tools = __integrationTesting.createAvalonTools(env, input());
    expect(tools.some((tool) => tool.definition.name === "read")).toBe(false);
    const list = tools.find((tool) => tool.definition.name === "list_resources")!;
    expect(list.definition.description).toContain("image — an image the agent can view");
    expect(list.definition.description).toContain("other — a resource outside the readable or viewable kinds above");
    expect(list.definition.description).not.toContain("MIME filter");

    const ids: string[] = [];
    let result = await list.execute({ limit: 17 }, context());
    for (;;) {
      const output = result.output as { items: Array<{ resourceId: string }>; nextCursor: string | null; totalVisibleResources: number };
      expect(output.totalVisibleResources).toBe(56);
      ids.push(...output.items.map((item) => item.resourceId));
      if (!output.nextCursor) break;
      result = await list.execute({ cursor: output.nextCursor }, context());
    }
    expect(ids).toHaveLength(56);
    expect(new Set(ids).size).toBe(56);

    await expect(list.execute({ attachmentKind: "image" }, context())).resolves.toMatchObject({
      output: { totalMatchingResources: 1, items: [{ resourceId: imageId, attachmentKind: "image", contentMode: "view" }], nextCursor: null },
    });
  });

  it("returns exact two-sided character coverage and rejects a changed or tampered continuation", async () => {
    const { database, bucket, env } = fixture();
    const resourceId = insertReadyResource(database, bucket, 1);
    const read = __integrationTesting.createAvalonTools(env, input()).find((tool) => tool.definition.name === "read_resource")!;

    const first = await read.execute({ resourceId, startCharacter: 7_000 }, context());
    expect(first.output).toMatchObject({
      resourceId, charactersBefore: 7_000, charactersReturned: 12_000,
      range: { start: 7_000, end: 19_000 }, totalCharacters: 19_534, charactersAfter: 534,
    });
    const firstOutput = first.output as { previousCursor: string; nextCursor: string };
    await expect(read.execute({ cursor: firstOutput.previousCursor }, context())).resolves.toMatchObject({
      output: { range: { start: 0, end: 12_000 }, charactersBefore: 0 },
    });
    await expect(read.execute({ cursor: `${firstOutput.nextCursor}tampered` }, context())).rejects.toMatchObject({ code: "invalid_cursor" });

    database.prepare("UPDATE resources SET model_content_sha256 = ? WHERE id = ?").run("c".repeat(64), resourceId);
    await expect(read.execute({ cursor: firstOutput.nextCursor }, context())).rejects.toMatchObject({ code: "resource_version_changed" });
  });

  it("searches one authorized derivative, returns bounded ranked passages, and hides private notes from workspace principals", async () => {
    const { database, bucket, env } = fixture();
    const resourceId = insertReadyResource(database, bucket, 2);
    const privateResourceId = insertReadyResource(database, bucket, 3, { title: "Private note" });
    database.prepare("UPDATE resources SET provider = 'avalon_note', resource_type = 'note' WHERE id = ?").run(privateResourceId);
    database.prepare(`INSERT INTO notes
      (id, workspace_id, owner_user_id, resource_id, scope, title, last_activity_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'personal', 'Private note', '2026-08-12', '2026-08-12', '2026-08-12')
    `).run("20000000-0000-4000-8000-000000000003", WORKSPACE_ID, USER_ID, privateResourceId);

    const userSearch = __integrationTesting.createAvalonTools(env, input()).find((tool) => tool.definition.name === "search_resource")!;
    await expect(userSearch.execute({ resourceId, query: "needle evidence" }, context())).resolves.toMatchObject({
      output: { resourceId, totalMatches: 1, returnedMatches: 1, passages: [{ rank: 1, sectionLabel: "Resource 2" }], truncated: false },
    });
    const workspacePrincipal = { type: "workspace" as const, workspaceId: WORKSPACE_ID };
    const workspaceTools = __integrationTesting.createAvalonTools(env, input(workspacePrincipal));
    const list = workspaceTools.find((tool) => tool.definition.name === "list_resources")!;
    await expect(list.execute({}, context(workspacePrincipal))).resolves.toMatchObject({ output: { totalVisibleResources: 1 } });
    const search = workspaceTools.find((tool) => tool.definition.name === "search_resource")!;
    await expect(search.execute({ resourceId: privateResourceId, query: "private" }, context(workspacePrincipal)))
      .rejects.toMatchObject({ code: "resource_not_found" });
  });

  it("views ordered image batches with ephemeral parts and self-heals mixed wrong kinds", async () => {
    const { database, bucket, env } = fixture();
    const firstImageId = insertReadyImage(database, bucket, 1);
    const textId = insertReadyResource(database, bucket, 4);
    const secondImageId = insertReadyImage(database, bucket, 2);
    const tools = __integrationTesting.createAvalonTools(env, input());
    const view = tools.find((tool) => tool.definition.name === "view_resource")!;

    const result = await view.execute({ resourceIds: [firstImageId, textId, secondImageId], maxDimension: 2_048 }, context());
    expect(result.output).toMatchObject({
      requested: 3,
      returned: 2,
      items: [
        { resourceId: firstImageId, status: "included", visualPartIndex: 0 },
        {
          resourceId: textId,
          status: "skipped",
          reasonCode: "resource_tool_mismatch",
          suggestedCall: { tool: "workstream_read_resource", arguments: { resourceId: textId } },
        },
        { resourceId: secondImageId, status: "included", visualPartIndex: 1 },
      ],
    });
    expect(result.contentParts).toHaveLength(2);
    expect(result.contentParts?.every((part) => part.type === "image_url" && part.image_url.url.startsWith("data:image/png;base64,"))).toBe(true);
    expect(JSON.stringify(result.output)).not.toContain("data:image/");

    bucket.objects.delete(`original/${firstImageId}.png`);
    await expect(rehydrateWorkstreamViewReceipt(
      env,
      input(),
      { resourceIds: [firstImageId], maxDimension: 2_048 },
      {
        requested: 1,
        returned: 1,
        items: [(result.output as { items: unknown[] }).items[0]],
      },
    )).resolves.toMatchObject([{ type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/u) } }]);

    await expect(view.execute({ resourceIds: [textId] }, context())).rejects.toMatchObject({
      code: "resource_tool_mismatch",
      details: { suggestedCall: { tool: "workstream_read_resource", arguments: { resourceId: textId } } },
    });
  });

  it("runs a focused isolated summary and verifies every returned citation range", async () => {
    const { database, bucket, env } = fixture();
    const resourceId = insertReadyResource(database, bucket, 7);
    const summarizeDerivative = async (request: { text: string; prompt: string | null; maxOutputCharacters: number }) => ({
      outline: [{ heading: "Resource 7", range: { start: 0, end: 40 } }],
      summary: `Focused: ${request.prompt}; ${request.text.slice(0, 20)}`,
      citations: [{ label: "Needle evidence", range: { start: 0, end: 40 } }],
      coverage: {
        status: "complete" as const,
        consideredCharacters: request.text.length,
        limitations: [],
      },
    });
    const tools = createWorkstreamAttachmentTools(env, input(), { summarizeDerivative });
    const summarize = tools.find((tool) => tool.definition.name === "summarize_resource")!;

    const result = await summarize.execute({
      resourceId,
      prompt: "Focus on the evidence",
      maxOutputCharacters: 4_000,
    }, context());
    expect(result.output).toMatchObject({
      resourceId,
      prompt: "Focus on the evidence",
      summary: expect.stringContaining("Focused: Focus on the evidence"),
      citations: [{ label: "Needle evidence", range: { start: 0, end: 40 }, readCursor: expect.any(String) }],
      coverage: { status: "complete", totalCharacters: 19_534, consideredCharacters: 19_534, limitations: [] },
    });

    const invalidTools = createWorkstreamAttachmentTools(env, input(), {
      summarizeDerivative: async () => ({
        outline: [], summary: "Invalid", citations: [{ label: "Outside", range: { start: 0, end: 99_999 } }],
        coverage: { status: "partial" as const, consideredCharacters: 1, limitations: ["test"] },
      }),
    });
    const invalid = invalidTools.find((tool) => tool.definition.name === "summarize_resource")!;
    await expect(invalid.execute({ resourceId }, context())).rejects.toMatchObject({ code: "resource_conversion_failed" });

    const imageId = insertReadyImage(database, bucket, 8);
    await expect(summarize.execute({ resourceId: imageId }, context())).rejects.toMatchObject({
      code: "resource_tool_mismatch",
      details: { suggestedCall: { tool: "workstream_view_resource", arguments: { resourceIds: [imageId] } } },
    });
  });

  it("enforces current-turn image dimensions and contains normalization failures to one batch item", async () => {
    const transforms: Array<{ width?: number; height?: number }> = [];
    const { database, bucket, env } = fixture({ images: imageTransformBinding(transforms) });
    const imageId = insertReadyImage(database, bucket, 9);
    const view = __integrationTesting.createAvalonTools(env, input()).find((tool) => tool.definition.name === "view_resource")!;

    await expect(view.execute({ resourceIds: [imageId], maxDimension: 64 }, context())).resolves.toMatchObject({
      output: { requested: 1, returned: 1, items: [{ status: "included", modelMimeType: "image/jpeg" }] },
    });
    expect(transforms).toEqual([expect.objectContaining({ width: 64, height: 64 })]);

    const failed = fixture({ images: imageTransformBinding([], true) });
    const failedImageId = insertReadyImage(failed.database, failed.bucket, 10);
    const failedView = __integrationTesting.createAvalonTools(failed.env, input()).find((tool) => tool.definition.name === "view_resource")!;
    await expect(failedView.execute({ resourceIds: [failedImageId], maxDimension: 64 }, context())).resolves.toMatchObject({
      output: {
        requested: 1,
        returned: 0,
        items: [{ status: "skipped", reasonCode: "resource_conversion_failed", suggestedCall: null }],
      },
    });
  });

  it("provides exact self-healing calls for every authorized natural-language kind without leaking unsupported or missing resources", async () => {
    const { database, bucket, env } = fixture();
    const imageId = insertReadyImage(database, bucket, 11);
    const readable = ([
      ["text/markdown", "brief.md"],
      ["application/pdf", "brief.pdf"],
      ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "brief.docx"],
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "brief.xlsx"],
      ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "brief.pptx"],
      ["text/plain", "brief.txt"],
    ] as const).map(([mime, title], index) => insertReadyResource(database, bucket, 20 + index, { mime, title }));
    const unsupportedId = insertReadyResource(database, bucket, 30, { mime: "application/zip", title: "archive.zip" });
    database.prepare("UPDATE resources SET model_content_status = 'unsupported', model_mime_type = NULL WHERE id = ?").run(unsupportedId);
    const tools = __integrationTesting.createAvalonTools(env, input());
    const read = tools.find((tool) => tool.definition.name === "read_resource")!;
    const search = tools.find((tool) => tool.definition.name === "search_resource")!;
    const summarize = tools.find((tool) => tool.definition.name === "summarize_resource")!;
    const view = tools.find((tool) => tool.definition.name === "view_resource")!;

    for (const tool of [read, search, summarize]) {
      const args = tool === search ? { resourceId: imageId, query: "diagram" } : { resourceId: imageId };
      await expect(tool.execute(args, context())).rejects.toMatchObject({
        code: "resource_tool_mismatch",
        details: { suggestedCall: { tool: "workstream_view_resource", arguments: { resourceIds: [imageId] } } },
      });
    }
    for (const resourceId of readable) {
      await expect(view.execute({ resourceIds: [resourceId] }, context())).rejects.toMatchObject({
        code: "resource_tool_mismatch",
        details: { suggestedCall: { tool: "workstream_read_resource", arguments: { resourceId } } },
      });
    }
    await expect(view.execute({ resourceIds: [unsupportedId] }, context())).resolves.toMatchObject({
      output: { returned: 0, items: [{ reasonCode: "resource_format_unsupported", suggestedCall: null }] },
    });
    const missingId = "90000000-0000-4000-8000-000000000099";
    await expect(view.execute({ resourceIds: [missingId] }, context())).resolves.toMatchObject({
      output: { returned: 0, items: [{ reasonCode: "resource_not_found", suggestedCall: null }] },
    });
  });
});
