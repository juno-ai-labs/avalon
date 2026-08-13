import type { VisibleWorkstreamResourceRow } from "../src/services/workstream-resource-visibility";
import type { HarnessCompactionCheckpoint } from "@avalon/agent-harness";
import type { WorkstreamWorkflowInput } from "@avalon/contracts";
import {
  CHECKPOINT_TEMPLATE_VERSION,
  renderWorkstreamResourceInventory,
} from "../src/services/workstream-resource-inventory";
import { describe, expect, it } from "vitest";
import { __integrationTesting } from "../src/services/integrations";
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
    workspace_id: "workspace",
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
    model_index_ref: null,
    model_content_status: null,
    model_content_extractor_version: null,
    model_content_character_count: null,
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
    const database = createTestD1Database({
      prepare(sql: string) {
        return createTestD1PreparedStatement({
          bind() { return this; },
          async first<T>() {
            if (!sql.includes("FROM workstream_context_compactions")) return null;
            return {
              compacted_through_sequence: 42,
              messages_json: JSON.stringify([{ role: "user", content: "stale principal inventory" }]),
              summary: "# Request\nContinue the exact work.",
              checkpoint_template_version: 1,
            } as T;
          },
          async all<T>() {
            return createTestD1Result<T>({ success: true, results: currentRows as T[] });
          },
        });
      },
    });

    const checkpoint = await __integrationTesting.loadWorkstreamContextCompaction(
      database,
      "workspace",
      "workstream",
      { type: "user", userId: "viewer" },
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
    const replayAfterRemoval = await __integrationTesting.loadWorkstreamContextCompaction(
      database,
      "workspace",
      "workstream",
      { type: "user", userId: "viewer" },
      "2026-08-12T18:31:00.000Z",
    );
    expect(JSON.stringify(replayAfterRemoval?.messages)).toContain("Visible resources: 0");
    expect(JSON.stringify(replayAfterRemoval?.messages)).toContain("# Request\\nContinue the exact work.");
  });

  it("persists the raw summary checkpoint and template version without a live inventory", async () => {
    let sql = "";
    let bindings: unknown[] = [];
    const database = createTestD1Database({
      prepare(statement: string) {
        sql = statement;
        return createTestD1PreparedStatement({
          bind(...values: unknown[]) {
            bindings = values;
            return this;
          },
          async run() { return createTestD1Result({ success: true }); },
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
        workspaceId: "workspace",
        workstreamId: "workstream",
        harnessRunId: "run",
      } as WorkstreamWorkflowInput,
      42,
      checkpoint,
    );

    expect(sql).toContain("checkpoint_template_version");
    expect(bindings[5]).toBe(checkpoint.summary);
    expect(bindings[6]).toBe(CHECKPOINT_TEMPLATE_VERSION);
    expect(String(bindings[4])).toContain("# Request");
    expect(String(bindings[4])).not.toContain("Authoritative work-stream resource inventory");
  });

  it("keeps an unknown checkpoint template readable from its persisted base message", async () => {
    const database = createTestD1Database({
      prepare() {
        return createTestD1PreparedStatement({
          bind() { return this; },
          async first<T>() {
            return {
              compacted_through_sequence: 7,
              messages_json: JSON.stringify([{ role: "user", content: "future-version base checkpoint" }]),
              summary: "raw future summary",
              checkpoint_template_version: 99,
            } as T;
          },
        });
      },
    });

    await expect(__integrationTesting.loadWorkstreamContextCompaction(
      database,
      "workspace",
      "workstream",
      { type: "workspace", workspaceId: "workspace" },
      AS_OF,
    )).resolves.toEqual({
      compactedThroughSequence: 7,
      messages: [{ role: "user", content: "future-version base checkpoint" }],
    });
  });
});
