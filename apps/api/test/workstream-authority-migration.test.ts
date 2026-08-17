import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  WORKSTREAM_AUTHORITY_IMPORT_STAGES,
  WORKSTREAM_AUTHORITY_CAMPAIGN_PREFIX,
  WorkstreamAuthorityImporter,
  workstreamAuthorityImportColumns,
  workstreamImportHash,
} from "../src/durable-objects/workstream-authority-import";
import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import { WorkstreamObjectStore } from "../src/durable-objects/workstream-object-storage";
import {
  normalizeWorkstreamAuthoritySourceRow,
  workstreamAuthoritySourceQuery,
} from "../src/services/workstream-authority-migration";
import {
  acceptsNewWorkstreamWork,
  requireWorkstreamIngress,
  WORKSTREAM_DO_SERVING_CONTRACT_VERSION,
} from "../src/services/workstream-authority";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { sqliteD1 } from "./helpers/sqlite-d1";
import { createTestSqlStorage } from "./helpers/sql-storage";

const migrationsDirectory = fileURLToPath(new URL("../../../packages/db/migrations/", import.meta.url));

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const fileName of readdirSync(migrationsDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(new URL(`../../../packages/db/migrations/${fileName}`, import.meta.url), "utf8"));
  }
  return database;
}

function objectStorage(database: DatabaseSync): DurableObjectStorage {
  return createCloudflareTestBinding<DurableObjectStorage>({
    get: async (key: string | string[]) => Array.isArray(key) ? new Map() : undefined,
    list: async () => new Map(),
    delete: async (key: string | string[]) => Array.isArray(key) ? 0 : false,
    transactionSync: (body: () => unknown) => body(),
    sql: createTestSqlStorage(database),
  });
}

const USER_ID = "00000000-0000-7000-8000-0000000000b1";
const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000b2";
const WORKSTREAM_ID = "00000000-0000-7000-8000-0000000000b3";
const RUN_ID = "00000000-0000-7000-8000-0000000000b4";
const OPENING_PART_ID = "00000000-0000-7000-8000-0000000000b5";
const TOOL_EFFECT_ID = "00000000-0000-7000-8000-0000000000b6";
const FINAL_PART_ID = "00000000-0000-7000-8000-0000000000b7";
const AT = "2026-08-17T00:00:00.000Z";
const COMPLETED_AT = "2026-08-17T00:01:00.000Z";

describe("the regional workstream authority serving fence", () => {
  it("keeps the import-only deployment closed even if D1 is incorrectly marked open", () => {
    expect(WORKSTREAM_DO_SERVING_CONTRACT_VERSION).toBe(0);
    expect(acceptsNewWorkstreamWork({
      phase: "durable_object_open",
      generation: 3,
      requiredServingContractVersion: 1,
      servingContractVersion: 1,
    })).toBe(false);
    expect(acceptsNewWorkstreamWork({
      phase: "legacy_open",
      generation: 0,
      requiredServingContractVersion: 1,
      servingContractVersion: 0,
    })).toBe(true);
  });

  it("returns a retryable gate to named regional ingress during maintenance", async () => {
    const database = migratedDatabase();
    try {
      await expect(requireWorkstreamIngress({ DB: sqliteD1(database) })).resolves.toMatchObject({
        phase: "legacy_open",
      });
      database.exec(`
        UPDATE workstream_authority_control
           SET phase = 'maintenance_draining', generation = 1,
               updated_at = '2026-08-17T00:00:00.000Z'
         WHERE id = 1;
      `);
      await expect(requireWorkstreamIngress({ DB: sqliteD1(database) })).rejects.toMatchObject({
        status: 503,
        code: "workstream_maintenance",
      });
    } finally {
      database.close();
    }
  });
});

describe("the D1 to WorkstreamDO authority source", () => {
  it("keeps every allow-listed import query executable against the current D1 schema", () => {
    const database = migratedDatabase();
    try {
      database.exec(`
        INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
        VALUES ('source-user', 'source-subject', 'source@example.com', 'Source User',
                '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
        INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
        VALUES ('source-workspace', 'Source Workspace', 'source-workspace', 'global', 'source-user',
                '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
        INSERT INTO workstreams
          (id, workspace_id, title, objective, origin_type, created_by_user_id,
           harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
        VALUES ('source-workstream', 'source-workspace', 'Source', 'Source objective', 'ad_hoc',
                'source-user', 'completed', 1, '2026-08-17T00:00:00.000Z',
                '2026-08-17T00:00:00.000Z', '2026-08-17T00:00:00.000Z');
      `);

      const counts = Object.fromEntries(WORKSTREAM_AUTHORITY_IMPORT_STAGES.map((stage) => {
        const rows = database.prepare(workstreamAuthoritySourceQuery(stage))
          .all("source-workspace", "source-workstream", 0, 201);
        return [stage, rows.length];
      }));
      expect(counts).toEqual({
        ...Object.fromEntries(WORKSTREAM_AUTHORITY_IMPORT_STAGES.map((stage) => [stage, 0])),
        workstream: 1,
      });
    } finally {
      database.close();
    }
  });

  it("normalizes every source stage to exactly its allow-listed target columns", () => {
    for (const stage of WORKSTREAM_AUTHORITY_IMPORT_STAGES) {
      const normalized = normalizeWorkstreamAuthoritySourceRow(stage, { source_rowid: 1 }, "global");
      const targetColumns = workstreamAuthorityImportColumns(stage);
      expect(Object.keys(normalized).sort(), stage).toEqual([...targetColumns].sort());
      expect(targetColumns.length, stage).toBeLessThanOrEqual(100);
    }
  });

  it("preserves completion, nullable artifacts, and suggested-action display content", () => {
    expect(normalizeWorkstreamAuthoritySourceRow("workstream", {
      source_rowid: 1,
      id: WORKSTREAM_ID,
      workspace_id: WORKSPACE_ID,
      harness_status: "completed",
      next_sequence_number: 1,
      updated_at: COMPLETED_AT,
    }, "global").completed_at).toBe(Date.parse(COMPLETED_AT));
    expect(normalizeWorkstreamAuthoritySourceRow("legacy_artifacts", {
      source_rowid: 1,
      id: "artifact",
      content_ref: null,
      preview_text: null,
    }, "global")).toEqual(expect.objectContaining({ content_ref: null, preview_text: null }));
    expect(normalizeWorkstreamAuthoritySourceRow("suggested_actions", {
      source_rowid: 1,
      id: "suggestion",
      activity_id: "activity",
      activity_title: "Investigate the deployment",
      activity_summary: "The release pipeline failed after packaging.",
      status: "pending",
      created_at: AT,
    }, "global")).toEqual(expect.objectContaining({
      display_title: "Investigate the deployment",
      display_body: "The release pipeline failed after packaging.",
    }));
  });

  it("imports a non-empty completed transcript and preserves its model/UI boundaries", async () => {
    const source = migratedDatabase();
    const target = new DatabaseSync(":memory:");
    const storage = objectStorage(target);
    try {
      source.exec(`
        INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
        VALUES ('${USER_ID}', 'authority-subject', 'authority@example.com', 'Authority User',
                '${AT}', '${AT}');
        INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
        VALUES ('${WORKSPACE_ID}', 'Authority Workspace', 'authority-workspace', 'global',
                '${USER_ID}', '${AT}', '${AT}');
        INSERT INTO workstreams
          (id, workspace_id, title, objective, scope, origin_type, created_by_user_id,
           harness_status, next_sequence_number, latest_attention_sequence_number,
           unread_tracking_start_sequence_number, last_activity_at, created_at, updated_at)
        VALUES ('${WORKSTREAM_ID}', '${WORKSPACE_ID}', 'Imported work', 'Preserve this',
                'workspace', 'ad_hoc', '${USER_ID}', 'completed', 4, 3, 1,
                '${COMPLETED_AT}', '${AT}', '${COMPLETED_AT}');
        INSERT INTO workstream_participants
          (workstream_id, user_id, added_by_user_id, participation_reason, joined_at)
        VALUES ('${WORKSTREAM_ID}', '${USER_ID}', '${USER_ID}', 'creator', '${AT}');
        INSERT INTO harness_runs
          (id, workspace_id, workstream_id, origin, execution_principal_json, status,
           started_at, completed_at, model, created_at, attempt_id, attempt_number,
           terminalized_at)
        VALUES ('${RUN_ID}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', 'opening_message',
                '{"type":"user","userId":"${USER_ID}"}', 'completed', '${AT}',
                '${COMPLETED_AT}', 'openai/test', '${AT}', 'attempt-one', 1,
                '${COMPLETED_AT}');
        INSERT INTO messages
          (id, client_message_id, workspace_id, workstream_id, author_type, author_user_id,
           message_type, text_content, sequence_number, created_at)
        VALUES ('${OPENING_PART_ID}', 'opening', '${WORKSPACE_ID}', '${WORKSTREAM_ID}',
                'human', '${USER_ID}', 'text', 'Please inspect this', 1, '${AT}');
        INSERT INTO messages
          (id, client_message_id, workspace_id, workstream_id, author_type, message_type,
           text_content, structured_content_json, sequence_number, created_at)
        VALUES ('${TOOL_EFFECT_ID}', 'tool:${TOOL_EFFECT_ID}', '${WORKSPACE_ID}',
                '${WORKSTREAM_ID}', 'agent', 'tool', '', '{"invocation":{"status":"completed"}}',
                2, '${AT}');
        INSERT INTO messages
          (id, client_message_id, workspace_id, workstream_id, author_type, message_type,
           text_content, sequence_number, created_at, harness_run_id, harness_attempt_id)
        VALUES ('${FINAL_PART_ID}', 'harness:${RUN_ID}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}',
                'agent', 'text', 'Done', 3, '${COMPLETED_AT}', '${RUN_ID}', 'attempt-one');
        UPDATE harness_runs
           SET trigger_message_id = '${OPENING_PART_ID}', final_message_id = '${FINAL_PART_ID}'
         WHERE id = '${RUN_ID}';
        INSERT INTO tool_invocations
          (id, workspace_id, workstream_id, harness_run_id, tool_call_id, tool_name,
           input_hash, input_json, output_summary, status, started_at, completed_at,
           attempt_id, execution_plan_hash, execution_plan_json)
        VALUES ('${TOOL_EFFECT_ID}', '${WORKSPACE_ID}', '${WORKSTREAM_ID}', '${RUN_ID}',
                '${RUN_ID}:turn:0:tool:0', 'read_resource', 'input-hash', '{}', 'read it',
                'completed', '${AT}', '${COMPLETED_AT}', 'attempt-one', 'plan-hash',
                '{"mode":"read","capability":"workstream.resources.read"}');
        INSERT INTO workstream_read_states
          (workspace_id, workstream_id, user_id, read_through_sequence_number,
           manual_unread_generation, updated_at)
        VALUES ('${WORKSPACE_ID}', '${WORKSTREAM_ID}', '${USER_ID}', 1, 0, '${AT}');
      `);

      applyWorkstreamObjectSchema(storage, "authority-import-test");
      const store = new WorkstreamObjectStore(storage, "authority-import-test", "global");
      await store.waitUntilReady();
      store.ensureIdentity({ workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID }, "global");
      const importer = new WorkstreamAuthorityImporter(storage);
      const generation = 3;
      const campaignId = `${WORKSTREAM_AUTHORITY_CAMPAIGN_PREFIX}:${generation}`;
      importer.execute({
        operation: "begin",
        campaignId,
        generation,
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        sourceFence: 3,
        sourceHash: "frozen-source",
      });

      const pages: Array<Record<string, unknown>> = [];
      const counts: Record<string, number> = {};
      for (const stage of WORKSTREAM_AUTHORITY_IMPORT_STAGES) {
        const sourceRows = source.prepare(workstreamAuthoritySourceQuery(stage))
          .all(WORKSPACE_ID, WORKSTREAM_ID, 0, 201) as Array<Record<string, unknown> & { source_rowid: number }>;
        const rows = sourceRows.map((row) => normalizeWorkstreamAuthoritySourceRow(stage, row, "global"));
        const cursor = `end:${sourceRows.at(-1)?.source_rowid ?? 0}`;
        const request = {
          campaignId,
          generation,
          stage,
          priorCursor: null,
          cursor,
          rows,
          stageComplete: true,
        };
        pages.push({
          operation: "page",
          commandId: `${campaignId}:${stage}`,
          requestHash: workstreamImportHash(request),
          ...request,
        });
        counts[stage] = rows.length;
      }
      const batch = importer.execute({
        operation: "batch",
        campaignId,
        generation,
        pages: pages as Extract<
          Parameters<WorkstreamAuthorityImporter["execute"]>[0],
          { operation: "batch" }
        >["pages"],
      });
      const pageHash = String(batch.resultHash);
      importer.execute({
        operation: "verify",
        campaignId,
        generation,
        expectedPageHash: pageHash,
        expectedCounts: counts,
      });
      importer.execute({ operation: "activate", campaignId, generation });

      expect(target.prepare(
        `SELECT authority_mode, exact_state, completed_at, next_sequence_number
           FROM workstream WHERE id = 1`,
      ).get()).toEqual({
        authority_mode: "authoritative",
        exact_state: "completed",
        completed_at: Date.parse(COMPLETED_AT),
        next_sequence_number: 4,
      });
      expect(target.prepare(
        `SELECT id, kind, visibility, effect_intent_id, tool_mode, tool_status
           FROM parts ORDER BY sequence_number`,
      ).all()).toEqual([
        { id: OPENING_PART_ID, kind: "text", visibility: "both", effect_intent_id: null, tool_mode: null, tool_status: null },
        { id: TOOL_EFFECT_ID, kind: "tool_call", visibility: "people", effect_intent_id: TOOL_EFFECT_ID, tool_mode: "read", tool_status: "completed" },
        { id: FINAL_PART_ID, kind: "text", visibility: "both", effect_intent_id: null, tool_mode: null, tool_status: null },
      ]);
      expect(target.prepare(
        `SELECT mode, authority_revision, result_part_id FROM tool_effects WHERE effect_intent_id = ?`,
      ).get(TOOL_EFFECT_ID)).toEqual({
        mode: "read",
        authority_revision: "plan-hash",
        result_part_id: TOOL_EFFECT_ID,
      });
      expect(target.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      source.close();
      target.close();
    }
  });
});
