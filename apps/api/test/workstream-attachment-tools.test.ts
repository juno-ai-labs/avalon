import { asHarnessRunId, asWorkstreamId } from "@rally/contracts";
import { asUserId, asWorkspaceId, readStructuredFailure } from "@rally/contracts";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkstreamWorkflowInput } from "@rally/contracts";
import { __integrationTesting } from "../src/services/integrations";
import { withToolPagination } from "../src/services/tool-pagination";
import { ATTACHMENT_TEXT_EXTRACTOR_VERSION } from "../src/services/attachment-derivative-service";
import {
  buildGifStoryboard,
  decodeTiffToPng,
  extractPdfText,
} from "../src/services/document-processing-codecs";
import type { DocumentProcessingRpcBinding } from "../src/services/document-processing-contract";
import {
  createWorkstreamAttachmentTools,
  rehydrateWorkstreamViewReceipt,
} from "../src/services/workstream-attachment-tools";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";
import {
  seedWorkstreamObjectRoot,
  seedWorkstreamRun,
  testSubstreamAgentsBinding,
  testWorkstreamObjectStore,
  seedToolReceipt,
} from "./helpers/durable-authority";
import { legacyProductSqliteDatabase, sqliteD1 } from "./helpers/sqlite-d1";
import { ensureResourceSlug } from "../src/services/resource-slug";
import { applyWorkspaceResourceSchema } from "./helpers/workspace-object-tables";
import { workspaceResourceMaintenanceRpcs } from "./helpers/workspace-object-rpcs";

const USER_ID = asUserId("00000000-0000-4000-8000-000000000000");
const OTHER_USER_ID = "00000000-0000-4000-8000-000000000009";
const WORKSPACE_ID = asWorkspaceId("00000000-0000-4000-8000-000000000001");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-4000-8000-000000000002");
const HARNESS_RUN_ID = asHarnessRunId("00000000-0000-4000-8000-000000000003");
const SOURCE_HASH = "a".repeat(64);
const DERIVATIVE_HASH = "b".repeat(64);
const documentProcessor = {
  extractText: extractPdfText,
  buildGifStoryboard: async (bytes: Uint8Array) => buildGifStoryboard(bytes),
  decodeTiffToPng: async (bytes: Uint8Array) => decodeTiffToPng(bytes),
} satisfies DocumentProcessingRpcBinding;

class MemoryBucket {
  readonly objects = new Map<string, Uint8Array>();
  async get(key: string): Promise<{ size: number; text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> } | null> {
    const bytes = this.objects.get(key);
    return bytes ? {
      size: bytes.byteLength,
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

function fixture(options: { images?: ImagesBinding; ai?: Ai } = {}) {
  const database = legacyProductSqliteDatabase();
  openDatabases.push(database);
  // The model's listing reads the alias beside each resource's UUID, and the
  // column is WorkspaceDO's — take it from the ledger rather than assume it.
  applyWorkspaceResourceSchema(database, WORKSPACE_ID);
  database.exec(`
    INSERT INTO users (id, google_subject, email, name, created_at, updated_at) VALUES
      ('${USER_ID}', 'owner', 'owner@example.test', 'Owner', '2026-01-01', '2026-01-01'),
      ('${OTHER_USER_ID}', 'other', 'other@example.test', 'Other', '2026-01-01', '2026-01-01');
    INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
      VALUES ('${WORKSPACE_ID}', 'Attachments', 'attachments', 'global', '${USER_ID}', '2026-01-01', '2026-01-01');
    INSERT INTO workstreams (id, workspace_id, title, objective, origin_type, created_by_user_id, harness_status, last_activity_at, created_at, updated_at)
      VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Attachments', 'Read safely', 'ad_hoc', '${USER_ID}', 'running', '2026-01-01', '2026-01-01', '2026-01-01');
  `);
  // The work stream's attachment links, run row, and tool receipts live in its
  // own object since migration 0090; the tools reach them through the runtime
  // router, so the env's DB is that router rather than the raw regional shim.
  const objectStore = testWorkstreamObjectStore();
  openDatabases.push(objectStore);
  seedWorkstreamObjectRoot(objectStore, {
    workstreamId: WORKSTREAM_ID,
    workspaceId: WORKSPACE_ID,
    title: "Attachments",
    description: "Read safely",
    originType: "ad_hoc",
    createdByUserId: USER_ID,
    exactState: "running",
  });
  seedWorkstreamRun(objectStore, { id: HARNESS_RUN_ID,
    executionPrincipalJson: JSON.stringify({ type: "user", userId: USER_ID }) });
  const bucket = new MemoryBucket();
  const baseEnv = createTestEnv({
    DB: sqliteD1(database),
    PAYLOADS: createCloudflareTestBinding<R2Bucket>(bucket),
    DOCUMENT_PROCESSOR: documentProcessor,
    ...(options.images ? { IMAGES: options.images } : {}),
    ...(options.ai ? { AI: options.ai } : {}),
    SESSION_SIGNING_KEY: "attachment-test-session-signing-key", AVALON_REGION: "global", APP_ENV: "test",
    // Receipts reach their object through the typed port now, not through the
    // routed D1 handle, so the binding has to be here for the port to resolve.
    SUBSTREAM_AGENTS: testSubstreamAgentsBinding(objectStore),
    // The alias claim is a typed WorkspaceDO method now, and the runtime
    // router this binding activates answers the tools' resource SQL over the
    // same fixture database rather than a second store.
    WORKSPACE_DOS: testSubstreamAgentsBinding(database, {
      extra: workspaceResourceMaintenanceRpcs(database),
    }),
  });
  return {
    database,
    objectStore,
    bucket,
    env: baseEnv,
  };
}

/**
 * Attach an existing workspace resource to the work-stream object the way the
 * product attach path does: a link row carrying the frozen descriptor copied
 * from the workspace row, plus an inventory-revision bump. The legacy
 * `workstream_resources` D1 table this file used to insert into was dropped by
 * migration 0090, and the compat view over the link table is read-only for
 * inserts — attachment is a product operation, not a runtime SQL write.
 */
function attachResourceLink(
  database: DatabaseSync,
  objectStore: DatabaseSync,
  resourceId: string,
  options: { attachedByUserId?: string | null; relationshipType?: string; attachedAt: string },
): void {
  const resource = database.prepare(
    `SELECT id, connection_id, resource_type, provider, provider_resource_id, title,
            mime_type, content_ref, canonical_url, metadata_json
       FROM resources WHERE id = ?`,
  ).get(resourceId) as Record<string, string | null>;
  const at = Date.parse(options.attachedAt);
  objectStore.prepare(
    `INSERT INTO workstream_resource_links
       (resource_id, attached_by_user_id, watch_enabled, relationship_type, resource_json, attached_at, updated_at)
     VALUES (?, ?, 0, ?, ?, ?, ?)`,
  ).run(
    resourceId,
    options.attachedByUserId === undefined ? USER_ID : options.attachedByUserId,
    options.relationshipType ?? "context",
    JSON.stringify({
      id: resourceId,
      connectionId: resource.connection_id,
      type: resource.resource_type,
      provider: resource.provider,
      providerResourceId: resource.provider_resource_id,
      title: resource.title,
      mimeType: resource.mime_type,
      contentRef: resource.content_ref,
      canonicalUrl: resource.canonical_url,
      metadata: JSON.parse(resource.metadata_json ?? "{}") as Record<string, unknown>,
    }),
    at,
    at,
  );
  objectStore.prepare(
    `INSERT INTO resource_inventory_revision(id, revision, updated_at) VALUES (1, 1, ?)
     ON CONFLICT(id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at`,
  ).run(at);
}

function blankPdf(): Uint8Array {
  const parts = [
    "%PDF-1.4\n",
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n",
  ];
  const offsets: number[] = [];
  let position = parts[0]!.length;
  for (const part of parts.slice(1)) {
    offsets.push(position);
    position += part.length;
  }
  const body = `${parts.join("")}xref\n0 4\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${position}\n%%EOF`;
  return new TextEncoder().encode(body);
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
    region: "global", workspaceId: WORKSPACE_ID, parentKind: "canvas", parentId: WORKSTREAM_ID,
    loopId: `workstream:${WORKSTREAM_ID}:substream:0:loop`, harnessRunId: HARNESS_RUN_ID,
    triggerMessageId: null, activityId: null, executionPrincipal: principal, reason: "test",
  };
}

function context(principal = input().executionPrincipal) {
  return {
    workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID, harnessRunId: HARNESS_RUN_ID,
    toolCallId: "tool-call", executionPrincipal: principal, signal: new AbortController().signal,
  };
}

function insertReadyResource(database: DatabaseSync, objectStore: DatabaseSync, bucket: MemoryBucket, ordinal: number, options: { mime?: string; title?: string } = {}): string {
  const id = `10000000-0000-4000-8000-${ordinal.toString().padStart(12, "0")}`;
  const title = options.title ?? `Resource ${ordinal}`;
  const mime = options.mime ?? "text/markdown";
  const text = `# ${title}\n\nNeedle evidence ${ordinal}.\n\n${"bounded text ".repeat(1_500)}`;
  const contentRef = `original/${id}`;
  const attachedAt = new Date(Date.UTC(2026, 7, 12, 0, ordinal)).toISOString();
  const modelRef = `model/${id}.md`;
  bucket.objects.set(contentRef, new TextEncoder().encode(text));
  bucket.objects.set(modelRef, new TextEncoder().encode(text));
  database.prepare(`
    INSERT INTO resources
      (id, workspace_id, resource_type, provider, title, mime_type, content_ref, metadata_json,
       created_at, updated_at, content_sha256, model_content_ref, model_mime_type,
       model_content_sha256, model_metadata_json, model_content_status,
       model_content_extractor_version, model_content_character_count, model_content_extracted_at)
    VALUES (?, ?, 'file', 'avalon_upload', ?, ?, ?, '{"size":123}', ?, ?, ?, ?, 'text/markdown', ?, '{}', 'ready',
            ?, ?, ?)
  `).run(id, WORKSPACE_ID, title, mime, contentRef, attachedAt, attachedAt, SOURCE_HASH, modelRef, DERIVATIVE_HASH, ATTACHMENT_TEXT_EXTRACTOR_VERSION, text.length, "2026-08-12T01:00:00.000Z");
  attachResourceLink(database, objectStore, id, { attachedAt });
  return id;
}

function insertReadyImage(database: DatabaseSync, objectStore: DatabaseSync, bucket: MemoryBucket, ordinal: number): string {
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
       model_content_sha256, model_metadata_json, model_content_status,
       model_content_extractor_version, model_content_character_count, model_content_extracted_at)
    VALUES (?, ?, 'file', 'avalon_upload', 'Diagram', 'image/png', ?, '{"size":8}', ?, ?, ?, ?, 'image/png', ?, NULL, 'ready',
            'image-v1', NULL, ?)
  `).run(id, WORKSPACE_ID, contentRef, "2026-08-12T02:00:00.000Z", "2026-08-12T02:00:00.000Z", SOURCE_HASH, modelRef, imageHash, "2026-08-12T02:00:00.000Z");
  attachResourceLink(database, objectStore, id, { attachedAt: "2026-08-12T02:00:00.000Z" });
  return id;
}

describe("work-stream attachment tools", () => {
  it("uses the production OCR binding for a scanned PDF and persists the reusable derivative", async () => {
    const toMarkdown = vi.fn(async () => ({
      name: "scan.pdf",
      mimeType: "application/pdf",
      format: "text" as const,
      data: "Recovered OCR evidence",
      tokens: 4,
    }));
    const ai = createCloudflareTestBinding<Ai>({ toMarkdown });
    const { database, objectStore, bucket, env } = fixture({ ai });
    const resourceId = "20000000-0000-4000-8000-000000000001";
    const sourceRef = `original/${resourceId}.pdf`;
    bucket.objects.set(sourceRef, blankPdf());
    database.prepare(`
      INSERT INTO resources
        (id, workspace_id, resource_type, provider, title, mime_type, content_ref,
         metadata_json, model_content_status, created_at, updated_at)
      VALUES (?, ?, 'file', 'avalon_upload', 'scan.pdf', 'application/pdf', ?,
              '{}', 'pending', '2026-08-12', '2026-08-12')
    `).run(resourceId, WORKSPACE_ID, sourceRef);
    attachResourceLink(database, objectStore, resourceId, {
      relationshipType: "attachment",
      attachedAt: "2026-08-12T00:00:00.000Z",
    });
    const read = __integrationTesting.createAvalonTools(env, input())
      .find((tool) => tool.definition.name === "read_resource")!;

    await expect(read.execute({ resourceId }, context())).resolves.toMatchObject({
      output: {
        resourceId,
        modelMimeType: "text/markdown",
        text: expect.stringContaining("Recovered OCR evidence"),
        charactersAfter: 0,
      },
    });
    expect(toMarkdown).toHaveBeenCalledOnce();
    expect(database.prepare(
      "SELECT model_content_status, model_content_error_code FROM resources WHERE id = ?",
    ).get(resourceId)).toEqual({ model_content_status: "ready", model_content_error_code: null });
  });

  it("reaches Markdown evidence beyond the retired 60,000-character projection boundary", async () => {
    const { database, objectStore, bucket, env } = fixture();
    const resourceId = insertReadyResource(database, objectStore, bucket, 50, { title: "Tuple transcript.md" });
    const text = `${"opening context. ".repeat(4_200)}\n# Later decision\nThe decisive second-half evidence is MONAD_ATTACHMENT_COMPLETE.\n`;
    const modelRef = `model/${resourceId}.md`;
    bucket.objects.set(modelRef, new TextEncoder().encode(text));
    database.prepare(
      "UPDATE resources SET model_content_character_count = ?, model_content_ref = ? WHERE id = ?",
    ).run(text.length, modelRef, resourceId);
    const tools = __integrationTesting.createAvalonTools(env, input());
    const read = tools.find((tool) => tool.definition.name === "read_resource")!;
    const search = tools.find((tool) => tool.definition.name === "search_resource")!;

    await expect(read.execute({ resourceId, startCharacter: 60_000 }, context())).resolves.toMatchObject({
      output: {
        resourceId,
        charactersBefore: 60_000,
        text: expect.stringContaining("MONAD_ATTACHMENT_COMPLETE"),
      },
    });
    await expect(search.execute({ resourceId, query: "MONAD_ATTACHMENT_COMPLETE" }, context())).resolves.toMatchObject({
      output: { returnedMatches: 1, passages: [{ text: expect.stringContaining("MONAD_ATTACHMENT_COMPLETE") }] },
    });
  });

  it("searches complete chunk text even when the query term falls outside bounded index hints", async () => {
    const { database, objectStore, bucket, env } = fixture();
    const resourceId = insertReadyResource(database, objectStore, bucket, 51, { title: "Dense vocabulary" });
    const vocabulary = Array.from({ length: 70 }, (_, index) => `token${String(index).padStart(2, "0")}`);
    const text = `# Dense vocabulary\n\n${vocabulary.join(" ")} late_unique_evidence`;
    const modelRef = `model/${resourceId}.md`;
    bucket.objects.set(modelRef, new TextEncoder().encode(text));
    database.prepare(
      "UPDATE resources SET model_content_character_count = ?, model_content_ref = ? WHERE id = ?",
    ).run(text.length, modelRef, resourceId);
    const search = __integrationTesting.createAvalonTools(env, input())
      .find((tool) => tool.definition.name === "search_resource")!;

    await expect(search.execute({ resourceId, query: "late_unique_evidence" }, context())).resolves.toMatchObject({
      output: {
        totalMatches: 1,
        returnedMatches: 1,
        passages: [{ text: expect.stringContaining("late_unique_evidence") }],
      },
    });
  });

  it("finds one-character and separated multi-term queries around actual matches", async () => {
    const { database, objectStore, bucket, env } = fixture();
    const resourceId = insertReadyResource(database, objectStore, bucket, 52, { title: "Query behavior" });
    const text = `# Query behavior\n\n${"padding ".repeat(430)}x marker ${"between ".repeat(20)}alpha evidence omega`;
    const modelRef = `model/${resourceId}.md`;
    bucket.objects.set(modelRef, new TextEncoder().encode(text));
    database.prepare(
      "UPDATE resources SET model_content_character_count = ?, model_content_ref = ? WHERE id = ?",
    ).run(text.length, modelRef, resourceId);
    const search = __integrationTesting.createAvalonTools(env, input())
      .find((tool) => tool.definition.name === "search_resource")!;

    await expect(search.execute({ resourceId, query: "x", maxPassageCharacters: 500 }, context())).resolves.toMatchObject({
      output: { returnedMatches: 1, passages: [{ text: expect.stringContaining("x marker") }] },
    });
    await expect(search.execute({ resourceId, query: "alpha omega", maxPassageCharacters: 500 }, context())).resolves.toMatchObject({
      output: { returnedMatches: 1, passages: [{ text: expect.stringContaining("alpha evidence omega") }] },
    });
  });

  it("lists more than fifty visible resources without duplicates and filters by every natural-language kind", async () => {
    const { database, objectStore, bucket, env } = fixture();
    let genericMarkdownId = "";
    for (let ordinal = 0; ordinal < 55; ordinal += 1) {
      const resourceId = insertReadyResource(database, objectStore, bucket, ordinal);
      if (ordinal === 54) genericMarkdownId = resourceId;
    }
    database.prepare("UPDATE resources SET mime_type = 'application/octet-stream', title = 'Legacy.md' WHERE id = ?")
      .run(genericMarkdownId);
    const imageId = insertReadyResource(database, objectStore, bucket, 55, { mime: "image/png", title: "Diagram" });
    const kindFixtures = {
      audio: insertReadyResource(database, objectStore, bucket, 56, { mime: "audio/mpeg", title: "Voice.mp3" }),
      pdf: insertReadyResource(database, objectStore, bucket, 57, { mime: "application/pdf", title: "Report.pdf" }),
      document: insertReadyResource(database, objectStore, bucket, 58, { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", title: "Brief.docx" }),
      spreadsheet: insertReadyResource(database, objectStore, bucket, 59, { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", title: "Data.xlsx" }),
      presentation: insertReadyResource(database, objectStore, bucket, 60, { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", title: "Pitch.pptx" }),
      text: insertReadyResource(database, objectStore, bucket, 61, { mime: "text/plain", title: "Notes.txt" }),
      other: insertReadyResource(database, objectStore, bucket, 62, { mime: "application/octet-stream", title: "Archive.bin" }),
    } as const;
    database.prepare(
      "UPDATE resources SET model_content_status = 'unsupported', model_mime_type = NULL WHERE id = ?",
    ).run(kindFixtures.other);
    const tools = __integrationTesting.createAvalonTools(env, input());
    expect(tools.some((tool) => tool.definition.name === "read")).toBe(false);
    const list = tools.find((tool) => tool.definition.name === "list_resources")!;
    expect(list.definition.description).toContain("image — an image the agent can view");
    expect(list.definition.description).toContain("other — a resource outside the readable or viewable kinds above");
    expect(list.definition.description).not.toContain("MIME filter");

    const ids: string[] = [];
    let result = await list.execute({ limit: 17 }, context());
    const inventoryCursor = result.pagination!.continuations[0]!.input.cursor;
    for (;;) {
      const output = result.output as { items: Array<{ resourceId: string }>; nextCursor: string | null; totalVisibleResources: number };
      expect(output.totalVisibleResources).toBe(63);
      ids.push(...output.items.map((item) => item.resourceId));
      const continuation = result.pagination!.continuations[0];
      if (!continuation) break;
      result = await list.execute(continuation.input, context());
    }
    expect(ids).toHaveLength(63);
    expect(new Set(ids).size).toBe(63);

    await expect(list.execute({ attachmentKind: "image" }, context())).resolves.toMatchObject({
      output: { totalMatchingResources: 1, items: [{ resourceId: imageId, attachmentKind: "image", contentMode: "view" }] },
      pagination: { continuations: [] },
    });
    for (const [attachmentKind, resourceId] of Object.entries(kindFixtures)) {
      await expect(list.execute({ attachmentKind }, context())).resolves.toMatchObject({
        output: {
          items: expect.arrayContaining([expect.objectContaining({
            resourceId,
            attachmentKind,
            contentMode: attachmentKind === "audio" || attachmentKind === "other" ? "unsupported" : "read",
          })]),
        },
      });
    }
    await expect(list.execute({ attachmentKind: "markdown" }, context())).resolves.toMatchObject({
      output: {
        totalMatchingResources: 55,
        items: expect.arrayContaining([
          expect.objectContaining({ resourceId: genericMarkdownId, attachmentKind: "markdown" }),
        ]),
      },
    });

    insertReadyResource(database, objectStore, bucket, 63);
    await expect(list.execute({ cursor: inventoryCursor }, context())).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  it("returns exact two-sided character coverage and rejects a changed or tampered continuation", async () => {
    const { database, objectStore, bucket, env } = fixture();
    const resourceId = insertReadyResource(database, objectStore, bucket, 1);
    const read = __integrationTesting.createAvalonTools(env, input()).find((tool) => tool.definition.name === "read_resource")!;

    const first = await read.execute({ resourceId, startCharacter: 7_000 }, context());
    expect(first.output).toMatchObject({
      resourceId, charactersBefore: 7_000, charactersReturned: 12_000,
      range: { start: 7_000, end: 19_000 }, totalCharacters: 19_534, charactersAfter: 534,
    });
    const firstOutput = {
      previousCursor: first.pagination!.continuations.find((page) => page.slot === "previousPageId")!.input.cursor,
      nextCursor: first.pagination!.continuations.find((page) => page.slot === "nextPageId")!.input.cursor,
    };
    await expect(read.execute({ cursor: firstOutput.previousCursor }, context())).resolves.toMatchObject({
      output: { range: { start: 0, end: 12_000 }, charactersBefore: 0 },
    });
    const later = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 60 * 60_000);
    try {
      await expect(read.execute({ cursor: firstOutput.nextCursor }, context())).resolves.toMatchObject({
        output: { range: { start: 19_000, end: 19_534 }, charactersAfter: 0 },
      });
    } finally {
      later.mockRestore();
    }
    await expect(read.execute({ cursor: `${firstOutput.nextCursor}tampered` }, context())).rejects.toMatchObject({ code: "invalid_cursor" });

    database.prepare("UPDATE resources SET model_content_sha256 = ? WHERE id = ?").run("c".repeat(64), resourceId);
    await expect(read.execute({ cursor: firstOutput.nextCursor }, context())).rejects.toMatchObject({
      code: "resource_version_changed",
      details: { resourceId },
    });
  });

  it("names the resource when a page from an earlier message was already read, so a restart clears the guard", async () => {
    // Run A issues page 2, run B reads it, run C copies the same ID from its
    // history. Run C's guard has no memory of the page, so a refusal without
    // the resource stays anonymous and replaces the reply even after the
    // model restarts the read.
    const { database, objectStore, bucket, env } = fixture();
    const resourceId = insertReadyResource(database, objectStore, bucket, 4);
    const read = __integrationTesting.createAvalonTools(env, input()).find((tool) => tool.definition.name === "read_resource")!;
    const first = await read.execute({ resourceId }, context());
    const consumed = first.pagination!.continuations.find((page) => page.slot === "nextPageId")!.input;
    const [, next] = withToolPagination(read, { prefix: "workstream", wirePrefix: "", connectionId: null,
      fence: { runId: HARNESS_RUN_ID, attemptId: "attempt", owner: "owner" }, receipts: {
        issuePage: vi.fn(async () => null),
        claimPage: vi.fn(async () => ({ refused: "page_already_consumed" as const, inputJson: JSON.stringify(consumed) })),
      } });
    const pageId = "workstream_coral_bright_vibrant_harriot";
    const error: unknown = await next!.execute({ pageId }, { ...context(), effectIntentId: "stale" }).catch((caught: unknown) => caught);
    expect(readStructuredFailure(error)).toEqual({ code: "page_already_consumed", details: { resourceId } });

    const guard = new __integrationTesting.AttachmentGroundingGuard();
    const policy = { capability: "workstream.resources.read" };
    guard.onStarted({ type: "tool_started", toolCallId: "stale", toolName: "read_resource_next", pluginId: "rally:workstream",
      policy, input: { pageId } } as never);
    guard.onFailed({ type: "tool_failed", toolCallId: "stale", toolName: "read_resource_next", pluginId: "rally:workstream",
      policy, error: (error as Error).message, data: readStructuredFailure(error), phase: "execution", outcome: "definitive_failure" } as never);
    expect(guard.boundary()).toContain(resourceId);
    const restarted = await read.execute({ resourceId }, context());
    guard.onStarted({ type: "tool_started", toolCallId: "restart", toolName: "read_resource", pluginId: "rally:workstream",
      policy, input: { resourceId } } as never);
    guard.onCompleted({ type: "tool_completed", toolCallId: "restart", toolName: "read_resource", pluginId: "rally:workstream",
      policy, result: restarted } as never);
    expect(guard.boundary()).toBeNull();
  });

  it("rejects an oversized derivative object before hydrating it into Worker memory", async () => {
    const { database, objectStore, bucket, env } = fixture();
    const resourceId = insertReadyResource(database, objectStore, bucket, 70);
    const row = database.prepare("SELECT model_content_ref FROM resources WHERE id = ?").get(resourceId) as { model_content_ref: string };
    bucket.objects.set(row.model_content_ref, new Uint8Array(8 * 1024 * 1024 + 1));
    const read = __integrationTesting.createAvalonTools(env, input())
      .find((tool) => tool.definition.name === "read_resource")!;

    await expect(read.execute({ resourceId }, context())).rejects.toMatchObject({
      code: "resource_conversion_failed",
      message: expect.stringContaining("exceeds the readable size limit"),
    });
  });

  it("never returns a page that begins or ends inside a surrogate pair", async () => {
    const { database, objectStore, bucket, env } = fixture();
    const resourceId = insertReadyResource(database, objectStore, bucket, 71);
    const row = database.prepare("SELECT model_content_ref FROM resources WHERE id = ?").get(resourceId) as { model_content_ref: string };
    const text = `A😀${"x".repeat(11_997)}😀Z`;
    await bucket.put(row.model_content_ref, text);
    database.prepare(
      "UPDATE resources SET model_content_character_count = ? WHERE id = ?",
    ).run(text.length, resourceId);
    const read = __integrationTesting.createAvalonTools(env, input()).find((tool) => tool.definition.name === "read_resource")!;

    const result = await read.execute({ resourceId, startCharacter: 2 }, context());
    const output = result.output as { range: { start: number; end: number }; text: string };
    expect(output.range.start).toBe(1);
    expect(output.text.charCodeAt(0)).toBeGreaterThanOrEqual(0xd800);
    expect(output.text.charCodeAt(1)).toBeLessThanOrEqual(0xdfff);
    expect(output.text).not.toContain("�");
    expect(output.range.end).toBe(12_000);
    expect(output.text.charCodeAt(output.text.length - 1)).not.toBeGreaterThanOrEqual(0xd800);
  });

  it("searches one authorized derivative, returns bounded ranked passages, and refuses deleted resources for workspace principals", async () => {
    const { database, objectStore, bucket, env } = fixture();
    const resourceId = insertReadyResource(database, objectStore, bucket, 2);
    const privateResourceId = "20000000-0000-4000-8000-000000000003";

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

  it("hands the model each resource's alias beside the UUID its tools take", async () => {
    const { database, objectStore, bucket, env } = fixture();
    const resourceId = insertReadyResource(database, objectStore, bucket, 1);
    const alias = await ensureResourceSlug(env, WORKSPACE_ID, resourceId);
    const list = __integrationTesting.createAvalonTools(env, input())
      .find((tool) => tool.definition.name === "list_resources")!;

    const result = await list.execute({}, context());

    // The UUID stays the argument every other tool takes; the alias rides
    // beside it so a citation the model writes costs a fraction of the tokens.
    expect((result.output as { items: Array<{ resourceId: string; slug: string | null }> }).items)
      .toEqual([expect.objectContaining({ resourceId, slug: alias })]);
    expect(alias).toMatch(/^[a-z]+-[a-z]+-[a-z]+-[a-z]+$/u);
  });

  it("views ordered image batches with ephemeral parts and self-heals mixed wrong kinds", async () => {
    const { database, objectStore, bucket, env } = fixture();
    const firstImageId = insertReadyImage(database, objectStore, bucket, 1);
    const textId = insertReadyResource(database, objectStore, bucket, 4);
    const secondImageId = insertReadyImage(database, objectStore, bucket, 2);
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
          suggestedCall: { tool: "read_resource", arguments: { resourceId: textId } },
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
      details: { suggestedCall: { tool: "read_resource", arguments: { resourceId: textId } } },
    });
  });

  it("names the tool a run actually advertises in every remediation it hands the model", async () => {
    // These remediations exist so a model can recover in one turn. They were
    // built by interpolating a `workstream_` prefix the plugin no longer
    // carries, which named tools no run offers — beside a `suggestedCall` in
    // the same payload that named them correctly. A literal-string rename
    // sweep cannot see an interpolated name, so this asserts on the text.
    const { database, objectStore, bucket, env } = fixture();
    const tools = __integrationTesting.createAvalonTools(env, input());
    const advertised = new Set(tools.map((tool) => tool.definition.name));
    expect(advertised).toContain("view_resource");
    expect(advertised).toContain("read_resource");

    const textId = insertReadyResource(database, objectStore, bucket, 91);
    const imageId = insertReadyImage(database, objectStore, bucket, 92);
    const view = tools.find((tool) => tool.definition.name === "view_resource")!;
    const read = tools.find((tool) => tool.definition.name === "read_resource")!;

    const mismatches = [
      await view.execute({ resourceIds: [textId] }, context()).catch((error: unknown) => error),
      await read.execute({ resourceId: imageId }, context()).catch((error: unknown) => error),
    ];
    for (const error of mismatches) {
      const message = (error as { message: string }).message;
      expect(message).not.toMatch(/\bworkstream_[a-z_]+/u);
      // Whatever tool the prose names, the run has to be offering it.
      for (const named of message.match(/\b(?:view_resource|read_resource|list_resources)\b/gu) ?? []) {
        expect(advertised, `${named} is named in a remediation but not advertised`).toContain(named);
      }
    }
    // The description that promises the suggestion names it the same way.
    expect(view.definition.description).toContain("read_resource");
    expect(view.definition.description).not.toContain("workstream_read_resource");
  });

  it("reauthorizes image receipts and re-executes when visual rehydration is unavailable", async () => {
    const { database, objectStore, bucket, env } = fixture();
    const imageId = insertReadyImage(database, objectStore, bucket, 62);
    const view = __integrationTesting.createAvalonTools(env, input())
      .find((tool) => tool.definition.name === "view_resource")!;
    const result = await view.execute({ resourceIds: [imageId], maxDimension: 2_048 }, context());
    expect(result.output).toMatchObject({ returned: 1, items: [{ status: "included" }] });
    const output = result.output as { items: Array<{ version: { sha256: string } | null }> };
    const invocationId = "70000000-0000-4000-8000-000000000001";
    const outputRef = "receipts/view.json";
    // The receipt and its dependency rows both live in the work-stream object,
    // so the object's own foreign keys are satisfied without switching any
    // enforcement off the way the dropped D1 copies needed.
    seedToolReceipt(objectStore, {
      id: invocationId,
      runId: HARNESS_RUN_ID,
      toolCallId: "view-call",
      toolName: "view_resource",
      status: "completed",
      inputJson: JSON.stringify({ resourceIds: [imageId], maxDimension: 2_048 }),
      outputRef,
      outputSummary: "Viewed image",
    });
    objectStore.prepare(
      `INSERT INTO attachment_tool_receipts
        (workspace_id, resource_id, tool_invocation_id, derivative_sha256, created_at)
      VALUES (?, ?, ?, ?, ?)`,
    ).run(WORKSPACE_ID, imageId, invocationId, output.items[0]!.version!.sha256, Date.parse("2026-08-12T00:00:00.000Z"));
    await bucket.put(outputRef, __integrationTesting.serializeToolReplayOutput(result.output));

    await expect(__integrationTesting.loadAuthorizedAttachmentReplay(env, input(), {
      invocationId,
      capability: "workstream.resources.view",
      canonicalToolName: "view_resource",
      rawInput: { resourceIds: [imageId], maxDimension: 2_048 },
      outputRef,
    })).resolves.toMatchObject({
      output: { returned: 1 },
      contentParts: [{ type: "image_url" }],
    });

    const refs = database.prepare(
      "SELECT content_ref, model_content_ref FROM resources WHERE id = ?",
    ).get(imageId) as { content_ref: string; model_content_ref: string };
    bucket.objects.delete(refs.content_ref);
    bucket.objects.delete(refs.model_content_ref);

    await expect(__integrationTesting.loadAuthorizedAttachmentReplay(env, input(), {
      invocationId,
      capability: "workstream.resources.view",
      canonicalToolName: "view_resource",
      rawInput: { resourceIds: [imageId], maxDimension: 2_048 },
      outputRef,
    })).resolves.toBeNull();
    expect(objectStore.prepare("SELECT COUNT(*) AS count FROM tool_effects WHERE effect_intent_id = ?").get(invocationId))
      .toEqual({ count: 0 });
    expect(database.prepare(
      "SELECT object_ref, object_kind FROM resource_object_deletion_outbox WHERE object_ref = ?",
    ).get(outputRef)).toEqual({ object_ref: outputRef, object_kind: "receipt" });
  });

  it("runs a focused isolated summary and verifies every returned citation range", async () => {
    const { database, objectStore, bucket, env } = fixture();
    const resourceId = insertReadyResource(database, objectStore, bucket, 7);
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
      citations: [{ label: "Needle evidence", range: { start: 0, end: 40 } }],
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

    const imageId = insertReadyImage(database, objectStore, bucket, 8);
    await expect(summarize.execute({ resourceId: imageId }, context())).rejects.toMatchObject({
      code: "resource_tool_mismatch",
      details: { suggestedCall: { tool: "view_resource", arguments: { resourceIds: [imageId] } } },
    });
  });

  it("enforces current-turn image dimensions and contains normalization failures to one batch item", async () => {
    const transforms: Array<{ width?: number; height?: number }> = [];
    const { database, objectStore, bucket, env } = fixture({ images: imageTransformBinding(transforms) });
    const imageId = insertReadyImage(database, objectStore, bucket, 9);
    const view = __integrationTesting.createAvalonTools(env, input()).find((tool) => tool.definition.name === "view_resource")!;

    await expect(view.execute({ resourceIds: [imageId], maxDimension: 64 }, context())).resolves.toMatchObject({
      output: { requested: 1, returned: 1, items: [{ status: "included", modelMimeType: "image/jpeg" }] },
    });
    expect(transforms).toEqual([expect.objectContaining({ width: 64, height: 64 })]);

    const failed = fixture({ images: imageTransformBinding([], true) });
    const failedImageId = insertReadyImage(failed.database, failed.objectStore, failed.bucket, 10);
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
    const { database, objectStore, bucket, env } = fixture();
    const imageId = insertReadyImage(database, objectStore, bucket, 11);
    const readable = ([
      ["text/markdown", "brief.md"],
      ["application/pdf", "brief.pdf"],
      ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "brief.docx"],
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "brief.xlsx"],
      ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "brief.pptx"],
      ["text/plain", "brief.txt"],
    ] as const).map(([mime, title], index) => insertReadyResource(database, objectStore, bucket, 20 + index, { mime, title }));
    const unsupportedId = insertReadyResource(database, objectStore, bucket, 30, { mime: "application/zip", title: "archive.zip" });
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
        details: { suggestedCall: { tool: "view_resource", arguments: { resourceIds: [imageId] } } },
      });
    }
    for (const resourceId of readable) {
      await expect(view.execute({ resourceIds: [resourceId] }, context())).rejects.toMatchObject({
        code: "resource_tool_mismatch",
        details: { suggestedCall: { tool: "read_resource", arguments: { resourceId } } },
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
