import { asUserId, asWorkspaceId } from "@avalon/contracts";
import {
  loadVisibleWorkstreamResourceInventory,
  type VisibleWorkstreamResourceRow,
} from "../src/services/workstream-resource-visibility";
import type { HarnessCompactionCheckpoint } from "@avalon/agent-harness";
import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import {
  CHECKPOINT_TEMPLATE_VERSION,
  renderWorkstreamResourceInventory,
} from "../src/services/workstream-resource-inventory";
import { describe, expect, it } from "vitest";
import { __integrationTesting } from "../src/services/integrations";
import { contextCompactionCheckpointHash } from "../src/lib/context-compaction-fence";
import {
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestD1Result,
} from "./helpers/cloudflare-test";

const AS_OF = "2026-08-12T18:30:00.000Z";

function resource(
  id: string,
  title: string,
  mimeType: string | null,
  messageAttachment = false,
): VisibleWorkstreamResourceRow {
  return {
    id,
    workspace_id: "1629dee4-8cc4-4531-81f9-b2be8614e062",
    resource_type: "file",
    provider: "avalon_upload",
    title,
    mime_type: mimeType,
    content_ref: null,
    content_sha256: null,
    metadata_json: "{}",
    updated_at: AS_OF,
    model_content_ref: null,
    model_mime_type: null,
    model_content_sha256: null,
    model_metadata_json: null,
    model_content_status: null,
    model_content_extractor_version: null,
    model_content_character_count: null,
    model_content_claimed_at: null,
    model_content_claim_id: null,
    model_content_error_code: null,
    relationship_type: "explicit",
    attached_at: AS_OF,
    message_attachment: messageAttachment ? 1 : 0,
    attached_watch_enabled: 0,
    visibility_version: AS_OF,
  };
}

describe("work-stream compaction resource inventory", () => {
  it("renders a bounded empty inventory with every allowed natural-language kind in guidance", () => {
    const rendered = renderWorkstreamResourceInventory({ asOf: AS_OF, rows: [] });

    expect(CHECKPOINT_TEMPLATE_VERSION).toBe(1);
    expect(rendered).toContain("Visible resources: 0");
    expect(rendered).toContain("Message attachments: 0");
    expect(rendered).toContain(
      "Allowed attachmentKind values: image, markdown, pdf, document, spreadsheet, presentation, text, other.",
    );
    expect(rendered).not.toContain("Groups:\n-");
    expect(rendered.length).toBeLessThan(1_500);
  });

  it("groups all eight kinds in fixed order without leaking names, IDs, MIME types, or content", () => {
    const rows = [
      resource("image-secret-id", "private-image.png", "image/png", true),
      resource("markdown-secret-id", "private-notes.md", "text/markdown", true),
      resource("pdf-secret-id", "private-report.pdf", "application/pdf"),
      resource("document-secret-id", "private-brief.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      resource("spreadsheet-secret-id", "private-ledger.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
      resource("presentation-secret-id", "private-deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
      resource("text-secret-id", "private-data.json", "application/json"),
      resource("other-secret-id", "private-archive.zip", "application/zip"),
    ];

    const rendered = renderWorkstreamResourceInventory({ asOf: AS_OF, rows });

    expect(rendered).toContain(`As of: ${AS_OF}`);
    expect(rendered).toContain("Visible resources: 8");
    expect(rendered).toContain("Message attachments: 2");
    const orderedRows = [
      "- image: 1",
      "- markdown: 1",
      "- pdf: 1",
      "- document: 1",
      "- spreadsheet: 1",
      "- presentation: 1",
      "- text: 1",
      "- other: 1",
    ];
    expect(orderedRows.every((line) => rendered.includes(line))).toBe(true);
    for (let index = 1; index < orderedRows.length; index += 1) {
      expect(rendered.indexOf(orderedRows[index]!)).toBeGreaterThan(
        rendered.indexOf(orderedRows[index - 1]!),
      );
    }
    expect(rendered).toContain("Use workstream_list_resources with attachmentKind, limit, and cursor");
    expect(rendered).toContain("Follow nextCursor until it is null");
    expect(rendered).not.toMatch(/secret|private|image\/png|application\//u);
    expect(rendered.length).toBeLessThan(1_500);
  });

  it("rebuilds a stored current-version checkpoint from its raw summary and current principal visibility", async () => {
    let currentRows = [resource("current-id", "current-private.png", "image/png", true)];
    let revision = 1;
    const storedFingerprint = "inventory:1";
    const database = createTestD1Database({
      prepare(sql: string) {
        return createTestD1PreparedStatement({
          bind() { return this; },
          async first<T>() {
            if (!sql.includes("FROM workstream_context_compactions")) return { revision } as T;
            return {
              compacted_through_sequence: 42,
              messages_json: JSON.stringify([{ role: "user", content: "stale principal inventory" }]),
              summary: "# Request\nContinue the exact work.",
              checkpoint_template_version: 1,
              execution_principal_key: "user:4b2a1529-867b-4d69-8685-b1722ccd0149",
              resource_visibility_fingerprint: storedFingerprint,
            } as T;
          },
          async all<T>() {
            const results = sql.includes("FROM workstream_resources wr")
              ? currentRows.map((row) => ({
                resource_id: row.id,
                relationship_type: row.relationship_type,
                attached_at: row.attached_at,
                attached_watch_enabled: row.attached_watch_enabled,
                message_attachment: row.message_attachment,
              }))
              : currentRows.map((row) => ({ ...row, visibility_version: row.updated_at }));
            return createTestD1Result<T>({ success: true, results: results as T[] });
          },
        });
      },
    });

    const checkpoint = await __integrationTesting.loadWorkstreamContextCompaction(
      database,
      "1629dee4-8cc4-4531-81f9-b2be8614e062",
      "workstream",
      { type: "user", userId: asUserId("4b2a1529-867b-4d69-8685-b1722ccd0149") },
      AS_OF,
    );

    expect(checkpoint?.compactedThroughSequence).toBe(42);
    const replay = JSON.stringify(checkpoint?.messages);
    expect(replay).toContain("# Request\\nContinue the exact work.");
    expect(replay).toContain("Visible resources: 1");
    expect(replay).toContain("Message attachments: 1");
    expect(replay).toContain("- image: 1");
    expect(replay).not.toContain("stale principal inventory");
    expect(replay).not.toMatch(/current-id|current-private|image\/png/u);

    currentRows = [];
    revision = 2;
    const replayAfterRemoval = await __integrationTesting.loadWorkstreamContextCompaction(
      database,
      "1629dee4-8cc4-4531-81f9-b2be8614e062",
      "workstream",
      { type: "user", userId: asUserId("4b2a1529-867b-4d69-8685-b1722ccd0149") },
      "2026-08-12T18:31:00.000Z",
    );
    expect(replayAfterRemoval).toBeNull();
  });

  it("never replays a raw attachment summary for a different execution principal", async () => {
    const database = createTestD1Database({
      prepare(sql: string) {
        return createTestD1PreparedStatement({
          bind() { return this; },
          async first<T>() {
            if (!sql.includes("FROM workstream_context_compactions")) return { revision: 1 } as T;
            return {
              compacted_through_sequence: 42,
              messages_json: "[]",
              summary: "Consulted private-id and found a confidential decision.",
              checkpoint_template_version: 1,
              execution_principal_key: "user:original-viewer",
              resource_visibility_fingerprint: "inventory:1",
            } as T;
          },
          async all<T>() {
            return createTestD1Result<T>({
              success: true,
              results: [{ attachment_kind: "markdown", count: 1, message_attachments: 1 }] as T[],
            });
          },
        });
      },
    });

    await expect(__integrationTesting.loadWorkstreamContextCompaction(
      database,
      "1629dee4-8cc4-4531-81f9-b2be8614e062",
      "workstream",
      { type: "user", userId: asUserId("df345be8-2f51-49ed-873d-bd48ada54749") },
      AS_OF,
    )).resolves.toBeNull();
  });

  it("persists the raw summary checkpoint and template version without a live inventory", async () => {
    let sql = "";
    let bindings: unknown[] = [];
    const database = createTestD1Database({
      prepare(statement: string) {
        return createTestD1PreparedStatement({
          bind(...values: unknown[]) {
            if (statement.includes("INSERT INTO workstream_context_compactions")) {
              sql = statement;
              bindings = values;
            }
            return this;
          },
          async first<T>() { return { revision: 0 } as T; },
          async run() { return createTestD1Result({ success: true, meta: { changes: 1 } }); },
          async all<T>() { return createTestD1Result<T>({ success: true, results: [] }); },
        });
      },
    });
    const checkpoint: HarnessCompactionCheckpoint = {
      trigger: "auto",
      summary: "# Request\nContinue the exact work.",
      messages: [{ role: "user", content: "[Compaction checkpoint]\n\n# Request\nContinue the exact work." }],
      model: "test/model",
      contextTokensBeforeCompaction: 81,
      contextWindowTokens: 100,
      inputTokens: 82,
      outputTokens: 5,
      costCents: 0.25,
    };

    await __integrationTesting.persistWorkstreamContextCompaction(
      database,
      {
        workspaceId: "1629dee4-8cc4-4531-81f9-b2be8614e062",
        workstreamId: "workstream",
        harnessRunId: "run",
        executionPrincipal: { type: "user", userId: "4b2a1529-867b-4d69-8685-b1722ccd0149" },
      } as WorkstreamWorkflowInput,
      42,
      checkpoint,
      "inventory:0",
    );

    expect(sql).toContain("checkpoint_template_version");
    expect(bindings[5]).toBe(checkpoint.summary);
    expect(bindings[6]).toBe(CHECKPOINT_TEMPLATE_VERSION);
    expect(bindings[7]).toBe("user:4b2a1529-867b-4d69-8685-b1722ccd0149");
    expect(bindings[8]).toBe("inventory:0");
    expect(String(bindings[4])).toContain("# Request");
    expect(String(bindings[4])).not.toContain("Authoritative work-stream resource inventory");
  });

  it("rejects a visibility change between inventory preparation and appendix rendering", async () => {
    let revisionReads = 0;
    const database = createTestD1Database({
      prepare(sql: string) {
        return createTestD1PreparedStatement({
          bind() { return this; },
          async first<T>() {
            if (!sql.includes("workstream_resource_inventory_revisions")) return null;
            revisionReads += 1;
            return { revision: revisionReads } as T;
          },
          async all<T>() { return createTestD1Result<T>({ success: true, results: [] }); },
        });
      },
    });

    await expect(loadVisibleWorkstreamResourceInventory(database, {
      workspaceId: "1629dee4-8cc4-4531-81f9-b2be8614e062",
      workstreamId: "workstream",
      principal: { type: "user", userId: asUserId("4b2a1529-867b-4d69-8685-b1722ccd0149") },
      expectedFingerprint: "inventory:1",
    })).rejects.toThrow("resource inventory changed");
  });

  it("does not persist a summary when visibility changes at the final fenced insert", async () => {
    let revision = 1;
    const insertChanges = 0;
    const database = createTestD1Database({
      prepare(sql: string) {
        return createTestD1PreparedStatement({
          bind() { return this; },
          async first<T>() { return { revision } as T; },
          async all<T>() { return createTestD1Result<T>({ success: true, results: [] }); },
          async run() {
            if (sql.includes("INSERT INTO workstream_context_compactions")) {
              revision = 2;
              return createTestD1Result({ success: true, meta: { changes: insertChanges } });
            }
            return createTestD1Result({ success: true });
          },
        });
      },
    });
    const checkpoint: HarnessCompactionCheckpoint = {
      trigger: "auto",
      summary: "confidential summary",
      messages: [{ role: "user", content: "checkpoint" }],
      model: "test/model",
      contextTokensBeforeCompaction: 81,
      contextWindowTokens: 100,
      inputTokens: 82,
      outputTokens: 5,
      costCents: 0.25,
    };

    await expect(__integrationTesting.persistWorkstreamContextCompaction(
      database,
      {
        workspaceId: "1629dee4-8cc4-4531-81f9-b2be8614e062",
        workstreamId: "workstream",
        harnessRunId: "run",
        executionPrincipal: { type: "user", userId: "4b2a1529-867b-4d69-8685-b1722ccd0149" },
      } as WorkstreamWorkflowInput,
      42,
      checkpoint,
      "inventory:1",
    )).rejects.toThrow("compaction_resource_visibility_changed");
    expect(insertChanges).toBe(0);
  });

  it("keeps an unknown checkpoint template readable from its persisted base message", async () => {
    const database = createTestD1Database({
      prepare(sql: string) {
        return createTestD1PreparedStatement({
          bind() { return this; },
          async first<T>() {
            if (!sql.includes("FROM workstream_context_compactions")) return { revision: 0 } as T;
            return {
              compacted_through_sequence: 7,
              messages_json: JSON.stringify([{ role: "user", content: "future-version base checkpoint" }]),
              summary: "raw future summary",
              checkpoint_template_version: 99,
              execution_principal_key: "workspace:1629dee4-8cc4-4531-81f9-b2be8614e062",
              resource_visibility_fingerprint: "inventory:0",
            } as T;
          },
          async all<T>() { return createTestD1Result<T>({ success: true, results: [] }); },
        });
      },
    });

    await expect(__integrationTesting.loadWorkstreamContextCompaction(
      database,
      "1629dee4-8cc4-4531-81f9-b2be8614e062",
      "workstream",
      { type: "workspace", workspaceId: asWorkspaceId("1629dee4-8cc4-4531-81f9-b2be8614e062") },
      AS_OF,
    )).resolves.toEqual({
      compactedThroughSequence: 7,
      messages: [{ role: "user", content: "future-version base checkpoint" }],
    });
  });

  it("loads only the exact frozen compaction and detects changed checkpoint content", async () => {
    const checkpointRunId = "00000000-0000-4000-8000-0000000000a1";
    const stored = {
      executionPrincipalKey: "workspace:1629dee4-8cc4-4531-81f9-b2be8614e062",
      resourceVisibilityFingerprint: "inventory:0",
      checkpointTemplateVersion: 1,
      checkpointRunId,
      compactedThroughSequence: 12,
      messagesJson: JSON.stringify([{ role: "user", content: "old representation" }]),
      summary: "# Request\nContinue from the frozen point.",
      model: "test/model",
    };
    let compactionBindings: unknown[] = [];
    const database = createTestD1Database({
      prepare(sql: string) {
        return createTestD1PreparedStatement({
          bind(...values: unknown[]) {
            if (sql.includes("FROM workstream_context_compactions")) compactionBindings = values;
            return this;
          },
          async first<T>() {
            if (!sql.includes("FROM workstream_context_compactions")) return { revision: 0 } as T;
            return {
              harness_run_id: checkpointRunId,
              compacted_through_sequence: stored.compactedThroughSequence,
              messages_json: stored.messagesJson,
              summary: stored.summary,
              checkpoint_template_version: stored.checkpointTemplateVersion,
              execution_principal_key: stored.executionPrincipalKey,
              resource_visibility_fingerprint: stored.resourceVisibilityFingerprint,
              model: stored.model,
            } as T;
          },
          async all<T>() { return createTestD1Result<T>({ success: true, results: [] }); },
        });
      },
    });
    const fence = {
      checkpointRunId,
      compactedThroughSequence: stored.compactedThroughSequence,
      checkpointHash: contextCompactionCheckpointHash(stored),
    };

    await expect(__integrationTesting.loadWorkstreamContextCompaction(
      database,
      "1629dee4-8cc4-4531-81f9-b2be8614e062",
      "workstream",
      { type: "workspace", workspaceId: asWorkspaceId("1629dee4-8cc4-4531-81f9-b2be8614e062") },
      AS_OF,
      fence,
    )).resolves.toMatchObject({ compactedThroughSequence: 12 });
    expect(compactionBindings).toEqual([
      "1629dee4-8cc4-4531-81f9-b2be8614e062",
      "workstream",
      "workspace:1629dee4-8cc4-4531-81f9-b2be8614e062",
      checkpointRunId,
      12,
    ]);

    await expect(__integrationTesting.loadWorkstreamContextCompaction(
      database,
      "1629dee4-8cc4-4531-81f9-b2be8614e062",
      "workstream",
      { type: "workspace", workspaceId: asWorkspaceId("1629dee4-8cc4-4531-81f9-b2be8614e062") },
      AS_OF,
      { ...fence, checkpointHash: "fnv1a64:0000000000000000" },
    )).rejects.toMatchObject({ code: "compaction_fence_changed" });
  });
});
