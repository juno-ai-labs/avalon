import { asUserId, asWorkspaceId } from "@rally/contracts";
import {
  conversationResourceLinks,
  loadVisibleWorkstreamResourceInventory,
  type ConversationResourceLinks,
  type VisibleWorkstreamResourceRow,
} from "../src/services/workstream-resource-visibility";
import {
  CHECKPOINT_TEMPLATE_VERSION,
  renderWorkstreamResourceInventory,
} from "../src/services/workstream-resource-inventory";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { __integrationTesting } from "../src/services/integrations";
import {
  createTestD1Database,
  createTestD1PreparedStatement,
  createTestD1Result,
} from "./helpers/cloudflare-test";
import {
  seedWorkstreamObjectRoot,
  testConversationResourceLinks,
  testResourcePort,
  testTranscriptPort,
  testWorkstreamObjectStore,
} from "./helpers/durable-authority";
import type { ResourceObjectPort } from "../src/durable-objects/workstream-resource-protocol";
import type { TranscriptObjectPort } from "../src/durable-objects/workstream-transcript-protocol";

const AS_OF = "2026-08-12T18:30:00.000Z";

function resource(
  id: string,
  title: string,
  mimeType: string | null,
  messageAttachment = false,
): VisibleWorkstreamResourceRow {
  return {
    id,
    slug: null,
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
    relationship_type: "attachment",
    attached_at: AS_OF,
    message_attachment: messageAttachment ? 1 : 0,
    attached_watch_enabled: 0,
    visibility_version: AS_OF,
  };
}

const WORKSPACE = "1629dee4-8cc4-4531-81f9-b2be8614e062";
const WORKSTREAM = "8f2e1d40-5c3b-4a9e-9d21-6f7c8b0a1234";
const CHECKPOINT_RUN = "00000000-0000-4000-8000-0000000000a1";

/** Attach one resource to the object, as the product service would have. */
function seedResourceLink(
  store: DatabaseSync,
  input: { resourceId: string; onMessage?: boolean },
): void {
  store.prepare(
    `INSERT INTO workstream_resource_links
       (resource_id, attached_by_user_id, watch_enabled, relationship_type,
        resource_json, attached_at, updated_at)
     VALUES (?, NULL, 0, 'attachment', '{}', ?, ?)`,
  ).run(input.resourceId, Date.parse(AS_OF), Date.parse(AS_OF));
  if (!input.onMessage) return;
  store.prepare(
    `INSERT INTO transcript_payloads
       (payload_id, audience, media_type, payload_json, payload_sha256, byte_length, created_at)
     VALUES (?, 'shared', 'application/json', '{"role":"user","content":"here","structuredContent":null}',
             ?, 64, ?)`,
  ).run(`payload-${input.resourceId}`, `hash-${input.resourceId}`, Date.parse(AS_OF));
  store.prepare(
    `INSERT INTO transcript_facts
       (fact_id, fact_kind, payload_id, origin_kind, created_at)
     VALUES (?, 'workstream_message', ?, 'canonical', ?)`,
  ).run(`fact-${input.resourceId}`, `payload-${input.resourceId}`, Date.parse(AS_OF));
  store.prepare(
    `INSERT OR IGNORE INTO participant_transcript_turns
       (transcript_sequence, turn_id, entry_kind, actor, author_user_id, root_fact_id,
        attention_ordinal, revision, created_at, updated_at, client_message_id,
        author_name_snapshot, author_avatar_url_snapshot)
     VALUES (1, ?, 'conversation', 'human',
             '4b2a1529-867b-4d69-8685-b1722ccd0149', ?, 1, 1, ?, ?, ?,
             'Test user', NULL)`,
  ).run(`part-${input.resourceId}`, `fact-${input.resourceId}`,
    Date.parse(AS_OF), Date.parse(AS_OF), `client-${input.resourceId}`);
  store.prepare(
    `INSERT OR IGNORE INTO participant_transcript_blocks
       (turn_id, block_id, block_index, block_kind, fact_id, revision, updated_at)
     VALUES (?, ?, 0, 'text', ?, 1, ?)`,
  ).run(`part-${input.resourceId}`, `part-${input.resourceId}:text:0`,
    `fact-${input.resourceId}`, Date.parse(AS_OF));
  store.prepare(
    `INSERT INTO participant_transcript_attachments (turn_id, resource_id, position, attachment_json)
     VALUES (?, ?, 0, '{}')`,
  ).run(`part-${input.resourceId}`, input.resourceId);
}

const openObjectStores: DatabaseSync[] = [];

afterEach(() => {
  for (const store of openObjectStores.splice(0)) store.close();
});

/**
 * A work stream's own object, for the half of these tests the port now reaches.
 *
 * The compaction rows moved off the compatibility view, so a fake `D1Database`
 * answering `FROM workstream_context_compactions` is answering a question
 * nothing asks any more. The real schema and the real statements run here; the
 * resource-inventory reads beside them are still routed, and still faked,
 * because that table belongs to a later slice.
 */
function objectStore(): {
  store: DatabaseSync;
  transcript: TranscriptObjectPort;
  attachments: ConversationResourceLinks;
  port: ResourceObjectPort;
} {
  const store = testWorkstreamObjectStore();
  openObjectStores.push(store);
  seedWorkstreamObjectRoot(store, { workstreamId: WORKSTREAM, workspaceId: WORKSPACE });
  store.prepare(
    `INSERT INTO runs
       (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
        next_action_cursor, input_fence_seq, revision, started_at,
        active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
        tool_count, input_tokens, output_tokens, cost_micros, output_bytes,
        origin, execution_principal_json, chain_depth, model, created_at, updated_at)
     VALUES (?, '0', 'running', '{}', 0, 0, '', 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
             'member_message', '{}', 0, 'test/model', 1, 1)`,
  ).run(CHECKPOINT_RUN);
  return {
    store,
    transcript: testTranscriptPort(store),
    attachments: testConversationResourceLinks(store),
    port: testResourcePort(store),
  };
}

/** Put the object's resource-inventory revision where a fence will accept it. */
function setInventoryRevision(store: DatabaseSync, revision: number): void {
  store.prepare(
    `INSERT INTO resource_inventory_revision (id, revision, updated_at)
     VALUES (1, ?, 1) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision`,
  ).run(revision);
}

/** One canonical stored checkpoint. */
function seedCheckpoint(store: DatabaseSync, input: {
  executionPrincipalKey: string;
  resourceVisibilityFingerprint: string;
  checkpointTemplateVersion: number;
  compactedThroughSequence: number;
  messagesJson: string;
  summary: string;
  model?: string;
}): void {
  const factId = `checkpoint:${input.executionPrincipalKey}:${input.compactedThroughSequence}`;
  const payloadId = `payload:${factId}`;
  store.prepare(
    `INSERT INTO transcript_payloads
       (payload_id, audience, media_type, payload_json, payload_sha256, byte_length, created_at)
     VALUES (?, 'model', 'application/json', ?, ?, 1, 1)`,
  ).run(payloadId, JSON.stringify({
    messages: JSON.parse(input.messagesJson), summary: input.summary,
    model: input.model ?? "test/model", compactedThroughSequence: input.compactedThroughSequence,
  }), `hash:${factId}`);
  store.prepare(
    `INSERT INTO transcript_facts
       (fact_id, fact_kind, payload_id, origin_kind, run_id, created_at)
     VALUES (?, 'compaction_checkpoint', ?, 'canonical', ?, 1)`,
  ).run(factId, payloadId, CHECKPOINT_RUN);
  store.prepare(
    `INSERT INTO transcript_compaction_checkpoints
       (checkpoint_fact_id, execution_principal_key, resource_visibility_fingerprint,
        checkpoint_template_version, run_id, compacted_through_sequence, model,
        context_tokens_before_compaction, context_window_tokens, input_tokens, output_tokens,
        cost_micros, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, 0, 0, 0, 1, 1)`,
  ).run(
    factId,
    input.executionPrincipalKey,
    input.resourceVisibilityFingerprint,
    input.checkpointTemplateVersion,
    CHECKPOINT_RUN,
    input.compactedThroughSequence,
    input.model ?? "test/model",
  );
}

describe("work-stream compaction resource inventory", () => {
  it("renders a bounded empty inventory with every allowed natural-language kind in guidance", () => {
    const rendered = renderWorkstreamResourceInventory({ asOf: AS_OF, rows: [] });

    expect(CHECKPOINT_TEMPLATE_VERSION).toBe(1);
    expect(rendered).toContain("Visible resources: 0");
    expect(rendered).toContain("Message attachments: 0");
    expect(rendered).toContain(
      "Allowed attachmentKind values: image, audio, markdown, pdf, document, spreadsheet, presentation, text, site, other.",
    );
    expect(rendered).not.toContain("Groups:\n-");
    expect(rendered.length).toBeLessThan(1_500);
  });

  it("groups all nine kinds in fixed order without leaking names, IDs, MIME types, or content", () => {
    const rows = [
      resource("image-secret-id", "private-image.png", "image/png", true),
      resource("audio-secret-id", "private-audio.mp3", "audio/mpeg", true),
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
    expect(rendered).toContain("Visible resources: 9");
    expect(rendered).toContain("Message attachments: 3");
    const orderedRows = [
      "- image: 1",
      "- audio: 1",
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
    expect(rendered).toContain("Use list_resources with attachmentKind and limit");
    expect(rendered).toContain('list_resources_next({ pageId: "<nextPageId>" })');
    expect(rendered).toContain("Follow nextPageId until it is null");
    expect(rendered).not.toMatch(/secret|private|image\/png|application\//u);
    expect(rendered.length).toBeLessThan(1_500);
  });

  it("rebuilds a stored current-version checkpoint from its raw summary and current principal visibility", async () => {
    let currentRows = [resource("current-id", "current-private.png", "image/png", true)];
    const storedFingerprint = "inventory:1";
    const { store, transcript, attachments } = objectStore();
    // The link half is the object's now, so it is seeded rather than faked. The
    // resource half is still the workspace's and still comes from the double
    // below — which is the whole point of the split this slice makes.
    setInventoryRevision(store, 1);
    seedResourceLink(store, { resourceId: "current-id", onMessage: true });
    seedCheckpoint(store, {
      executionPrincipalKey: "user:4b2a1529-867b-4d69-8685-b1722ccd0149",
      resourceVisibilityFingerprint: storedFingerprint,
      checkpointTemplateVersion: 1,
      compactedThroughSequence: 42,
      messagesJson: JSON.stringify([{ role: "user", content: "stale principal inventory" }]),
      summary: "# Request\nContinue the exact work.",
    });
    const database = createTestD1Database({
      prepare() {
        return createTestD1PreparedStatement({
          bind() { return this; },
          async first<T>() { return null as T; },
          async all<T>() {
            return createTestD1Result<T>({
              success: true,
              results: currentRows.map((row) => ({
                ...row,
                visibility_version: row.updated_at,
              })) as T[],
            });
          },
        });
      },
    });

    const checkpoint = await __integrationTesting.loadWorkstreamContextCompaction(
      database,
      transcript,
      attachments,
      WORKSPACE,
      WORKSTREAM,
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

    // The resource is gone from the workspace and the object's revision moved
    // with it, so the stored fingerprint no longer describes what is visible.
    currentRows = [];
    store.prepare(`DELETE FROM workstream_resource_links WHERE resource_id = 'current-id'`).run();
    setInventoryRevision(store, 2);
    const replayAfterRemoval = await __integrationTesting.loadWorkstreamContextCompaction(
      database,
      transcript,
      attachments,
      WORKSPACE,
      WORKSTREAM,
      { type: "user", userId: asUserId("4b2a1529-867b-4d69-8685-b1722ccd0149") },
      "2026-08-12T18:31:00.000Z",
    );
    expect(replayAfterRemoval).toBeNull();
  });

  it("never replays a raw attachment summary for a different execution principal", async () => {
    const { store, transcript, attachments } = objectStore();
    seedCheckpoint(store, {
      executionPrincipalKey: "user:original-viewer",
      resourceVisibilityFingerprint: "inventory:1",
      checkpointTemplateVersion: 1,
      compactedThroughSequence: 42,
      messagesJson: "[]",
      summary: "Consulted private-id and found a confidential decision.",
    });
    const database = createTestD1Database({
      prepare() {
        return createTestD1PreparedStatement({
          bind() { return this; },
          async first<T>() { return { revision: 1 } as T; },
          async all<T>() {
            return createTestD1Result<T>({
              success: true,
              results: [{ attachment_kind: "markdown", count: 1, message_attachments: 1 }] as T[],
            });
          },
        });
      },
    });

    // The checkpoint belongs to another principal, so the operation's own
    // `execution_principal_key` predicate never returns it. The routed SELECT
    // returned it and the caller compared afterwards; the row is simply not
    // this principal's to read.
    await expect(__integrationTesting.loadWorkstreamContextCompaction(
      database,
      transcript,
      attachments,
      WORKSPACE,
      WORKSTREAM,
      { type: "user", userId: asUserId("df345be8-2f51-49ed-873d-bd48ada54749") },
      AS_OF,
    )).resolves.toBeNull();
  });

  it("rejects a visibility change between inventory preparation and appendix rendering", async () => {
    const { store, port } = objectStore();
    const database = createTestD1Database({
      prepare() {
        return createTestD1PreparedStatement({
          bind() { return this; },
          async first<T>() { return null as T; },
          async all<T>() { return createTestD1Result<T>({ success: true, results: [] }); },
        });
      },
    });
    // Somebody attaches or detaches a resource while this read is in flight.
    // The revision is read twice, once on each side of the rows, and a test
    // cannot have a genuinely concurrent writer — so the second read is what
    // stands in, layered over the object's real one.
    setInventoryRevision(store, 1);
    let reads = 0;
    const shifting: ResourceObjectPort = {
      ...port,
      inventoryRevision: async () => {
        reads += 1;
        return reads === 1 ? port.inventoryRevision() : 2;
      },
    };

    await expect(loadVisibleWorkstreamResourceInventory(database, conversationResourceLinks(shifting), {
      workspaceId: "1629dee4-8cc4-4531-81f9-b2be8614e062",
      workstreamId: WORKSTREAM,
      principal: { type: "user", userId: asUserId("4b2a1529-867b-4d69-8685-b1722ccd0149") },
      expectedFingerprint: "inventory:1",
    })).rejects.toThrow("resource inventory changed");
    expect(reads).toBe(2);
  });

  it("keeps an unknown checkpoint template readable from its persisted base message", async () => {
    const { store, transcript, attachments } = objectStore();
    seedCheckpoint(store, {
      executionPrincipalKey: `workspace:${WORKSPACE}`,
      resourceVisibilityFingerprint: "inventory:0",
      checkpointTemplateVersion: 99,
      compactedThroughSequence: 7,
      messagesJson: JSON.stringify([{ role: "user", content: "future-version base checkpoint" }]),
      summary: "raw future summary",
    });
    const database = createTestD1Database({
      prepare() {
        return createTestD1PreparedStatement({
          bind() { return this; },
          async first<T>() { return { revision: 0 } as T; },
          async all<T>() { return createTestD1Result<T>({ success: true, results: [] }); },
        });
      },
    });

    await expect(__integrationTesting.loadWorkstreamContextCompaction(
      database,
      transcript,
      attachments,
      WORKSPACE,
      WORKSTREAM,
      { type: "workspace", workspaceId: asWorkspaceId(WORKSPACE) },
      AS_OF,
    )).resolves.toEqual({
      compactedThroughSequence: 7,
      messages: [{
        role: "user",
        content: "future-version base checkpoint",
        provenance: {
          originKind: "derived",
          sourceKind: "compaction_checkpoint",
          sourceId: `checkpoint:workspace:${WORKSPACE}:7`,
          sourceRevision: 7,
        },
      }],
    });
  });

});
