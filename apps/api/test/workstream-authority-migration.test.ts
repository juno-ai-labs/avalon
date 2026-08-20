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
  __workstreamAuthorityMigrationTesting,
  normalizeWorkstreamAuthoritySourceRow,
  workstreamAuthoritySourceQuery,
} from "../src/services/workstream-authority-migration";
import { WORKSPACE_PRODUCT_IMPORT_STAGES } from "../src/durable-objects/workspace-product-import";
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
  it("opens only when D1 and the deployed Worker attest the complete serving contract", () => {
    expect(WORKSTREAM_DO_SERVING_CONTRACT_VERSION).toBe(1);
    expect(acceptsNewWorkstreamWork({
      phase: "durable_object_open",
      generation: 3,
      requiredServingContractVersion: 1,
      servingContractVersion: 1,
    })).toBe(true);
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

  it("recovers tool identity for legacy tool messages with no invocation row", () => {
    // The Global cutover quarantined on exactly this shape: an early tool
    // message whose tool_invocations row matches neither the message id nor
    // the embedded invocation id. The transcript fact must come from the
    // structured content, and a bare row must still satisfy the parts CHECK
    // with an explicit legacy name and a non-pending outcome.
    const embedded = normalizeWorkstreamAuthoritySourceRow("parts", {
      source_rowid: 7,
      id: "legacy-tool-part",
      author_type: "agent",
      message_type: "tool",
      text_content: "",
      structured_content_json: JSON.stringify({
        invocation: { id: "detached", toolName: "workstream.read", status: "completed" },
      }),
      sequence_number: 4,
      created_at: AT,
    }, "global");
    expect(embedded).toEqual(expect.objectContaining({
      kind: "tool_call",
      tool_name: "workstream.read",
      tool_status: "completed",
    }));
    const bare = normalizeWorkstreamAuthoritySourceRow("parts", {
      source_rowid: 8,
      id: "bare-tool-part",
      author_type: "agent",
      message_type: "tool",
      text_content: "",
      sequence_number: 5,
      created_at: AT,
    }, "global");
    expect(bare).toEqual(expect.objectContaining({
      kind: "tool_call",
      tool_name: "legacy.tool",
      tool_status: "ambiguous",
    }));
  });

  it("preserves completion and suggested-action display content", () => {
    expect(normalizeWorkstreamAuthoritySourceRow("workstream", {
      source_rowid: 1,
      id: WORKSTREAM_ID,
      workspace_id: WORKSPACE_ID,
      harness_status: "completed",
      next_sequence_number: 1,
      updated_at: COMPLETED_AT,
    }, "global").completed_at).toBe(Date.parse(COMPLETED_AT));
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

describe("the D1 to WorkspaceDO authority source", () => {
  it("keeps every workspace product import query executable against the current D1 schema", () => {
    const database = migratedDatabase();
    try {
      database.exec(`
        INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
        VALUES ('workspace-source-user', 'workspace-source-subject',
                'workspace-source@example.com', 'Workspace Source', '${AT}', '${AT}');
        INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
        VALUES ('workspace-source', 'Workspace Source', 'workspace-source', 'global',
                'workspace-source-user', '${AT}', '${AT}');
      `);
      for (const stage of WORKSPACE_PRODUCT_IMPORT_STAGES) {
        expect(() => database.prepare(
          __workstreamAuthorityMigrationTesting.workspaceProductSourceQuery(stage),
        ).all("workspace-source", 0, 101), stage).not.toThrow();
      }
    } finally {
      database.close();
    }
  });

  it("renumbers stacked provenance root positions and keeps one user link per identity", () => {
    // Legacy D1 enforced neither UNIQUE (opportunity_id, position) on roots nor
    // the object's link identity index; re-rootings stacked node sets onto the
    // same positions and duplicate NULL-user link assertions accumulated. Both
    // quarantined generation 3 of the Global cutover.
    const database = migratedDatabase();
    try {
      database.exec(`
        INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
        VALUES ('user-dup', 'subject-dup', 'dup@example.com', 'Dup', '${AT}', '${AT}');
        INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
        VALUES ('workspace-dup', 'Dup', 'workspace-dup', 'global', 'user-dup', '${AT}', '${AT}');
        INSERT INTO opportunity_provenance_nodes
          (id, workspace_id, node_kind, source_id, label, visibility_scope, created_at)
        SELECT value, 'workspace-dup', 'activity', value, value, 'workspace', '${AT}'
          FROM json_each('["node-a", "node-b", "node-c", "node-d"]');
        INSERT INTO work_opportunities
          (id, workspace_id, audience_scope, display_prompt, execution_prompt,
           admission_reasoning, source_fingerprint, display_prompt_hash,
           execution_prompt_hash, expires_at, created_at, updated_at)
        VALUES ('opp-dup', 'workspace-dup', 'workspace', 'prompt', 'prompt',
                'reasoning', 'fingerprint-dup', 'hash', 'hash', '${AT}', '${AT}', '${AT}');
        INSERT INTO work_opportunity_provenance_roots (opportunity_id, node_id, position) VALUES
          ('opp-dup', 'node-a', 0),
          ('opp-dup', 'node-b', 0),
          ('opp-dup', 'node-c', 1),
          ('opp-dup', 'node-d', 1);
        INSERT INTO work_opportunity_user_links
          (id, workspace_id, opportunity_id, user_id, role, resolution, reasoning,
           provenance_node_id, created_at, updated_at)
        VALUES
          ('link-old', 'workspace-dup', 'opp-dup', NULL, 'assignee', 'unresolved', 'old', NULL, '${AT}', '${AT}'),
          ('link-new', 'workspace-dup', 'opp-dup', NULL, 'assignee', 'unresolved', 'new', NULL, '${AT}', '${AT}'),
          ('link-node', 'workspace-dup', 'opp-dup', NULL, 'assignee', 'unresolved', 'kept', 'node-a', '${AT}', '${AT}');
      `);

      const rootsQuery = __workstreamAuthorityMigrationTesting
        .workspaceProductSourceQuery("work_opportunity_provenance_roots");
      const roots = database.prepare(rootsQuery).all("workspace-dup", 0, 101) as Array<{
        node_id: string;
        position: number;
      }>;
      // Dense rank in (original position, node_id) order: unique, gapless, and
      // the original relative order survives.
      expect(roots.map((row) => [row.node_id, row.position])).toEqual([
        ["node-a", 0],
        ["node-b", 1],
        ["node-c", 2],
        ["node-d", 3],
      ]);
      // Page boundaries must not change the assignment: walking one row at a
      // time yields the same positions as one shot, so retries and page splits
      // stay idempotent under the object's exact-match import check.
      let cursor = 0;
      const paged: Array<[string, number]> = [];
      for (;;) {
        const page = database.prepare(rootsQuery).all("workspace-dup", cursor, 1) as Array<{
          source_rowid: number;
          node_id: string;
          position: number;
        }>;
        if (page.length === 0) break;
        paged.push([page[0]!.node_id, page[0]!.position]);
        cursor = page[0]!.source_rowid;
      }
      expect(paged).toEqual(roots.map((row) => [row.node_id, row.position]));

      const links = database.prepare(
        __workstreamAuthorityMigrationTesting.workspaceProductSourceQuery("work_opportunity_user_links"),
      ).all("workspace-dup", 0, 101) as Array<{ id: string }>;
      // One row per object identity (opportunity, user, role, resolution,
      // provenance node), the latest assertion winning; the distinct-node link
      // is its own identity and survives.
      expect(links.map((row) => row.id)).toEqual(["link-new", "link-node"]);
    } finally {
      database.close();
    }
  });

  it("scrubs a workspace in resumable chunks and activates only when it is empty", async () => {
    // A whole workspace at once exceeds D1's per-batch CPU limit, so the scrub
    // spends a bounded row budget and returns; the route stays `verified` and
    // the next tick resumes. What must never happen is a route going `active`
    // over rows that are still there.
    const database = migratedDatabase();
    try {
      const { WORKSPACE_SCRUB_CHUNK, activateWorkspaceProductRoute } = __workstreamAuthorityMigrationTesting;
      database.exec(`
        INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
        VALUES ('scrub-user', 'scrub-subject', 'scrub@example.com', 'Scrub', '${AT}', '${AT}');
        INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
        VALUES ('scrub-workspace', 'Scrub', 'scrub-workspace', 'global', 'scrub-user', '${AT}', '${AT}');
        CREATE TABLE IF NOT EXISTS workspace_product_authority_routes_shim (unused INTEGER);
      `);
      // More rows than a single chunk, so the loop has to iterate.
      const rows = WORKSPACE_SCRUB_CHUNK + 25;
      const values = Array.from({ length: rows }, (_, index) => (
        `('event-${index}', 'scrub-workspace', 'workstream.message.posted', 'workstream', 'user', 'Imported', 'workspace', 0, '${AT}', '${AT}', 'workstream_message', 'dedupe-${index}', '{}')`
      )).join(",\n");
      database.exec(`
        INSERT INTO activity_events
          (id, workspace_id, event_type, subject_type, actor_type, title,
           audience_kind, digestible, occurred_at, created_at, source_kind,
           dedupe_key, metadata_json)
        VALUES ${values};
      `);
      database.exec(`
        UPDATE workstream_authority_control
           SET phase = 'maintenance_draining', generation = 1, updated_at = '${AT}' WHERE id = 1;
        UPDATE workstream_authority_control
           SET phase = 'maintenance_importing', updated_at = '${AT}' WHERE id = 1;
        UPDATE workstream_authority_routes SET state = 'verified' WHERE generation = 1;
        UPDATE workspace_product_authority_routes SET state = 'verified' WHERE generation = 1;
        UPDATE workstream_authority_control
           SET phase = 'maintenance_verified', updated_at = '${AT}' WHERE id = 1;
      `);

      // D1 reports `meta.changes` as zero for a chunked `DELETE ... WHERE rowid
      // IN (SELECT ...)`, which the local double does not reproduce. Zero it
      // deliberately: a scrub that reads progress from it stops after one
      // chunk per target and never empties anything.
      const database1 = sqliteD1(database);
      const env = {
        DB: {
          ...database1,
          prepare: (sql: string) => {
            const statement = database1.prepare(sql);
            const wrap = (bound: typeof statement): typeof statement => ({
              ...bound,
              bind: (...values: unknown[]) => wrap(bound.bind(...values)),
              run: async () => {
                const result = await bound.run();
                return { ...result, meta: { ...result.meta, changes: 0 } };
              },
            }) as typeof statement;
            return wrap(statement);
          },
        },
      } as never;
      const route = {
        workspace_id: "scrub-workspace",
        generation: 1,
        state: "verified",
        stage_index: 65,
        source_cursor: 0,
        row_counts_json: "{}",
      };
      await activateWorkspaceProductRoute(env, route as never);

      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM activity_events WHERE workspace_id = 'scrub-workspace'`,
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        `SELECT state FROM workspace_product_authority_routes WHERE workspace_id = 'scrub-workspace'`,
      ).get()).toEqual({ state: "active" });
    } finally {
      database.close();
    }
  });

  it("resumes a scrub across ticks and activates only once every target is empty", async () => {
    // The resume path: a route whose remaining rows exceed one tick's budget
    // must stay `verified` and finish on a later pass. Nothing covered this
    // before, because reaching the budget needs more rows than a fixture
    // usually carries and the budget was not reachable from a test.
    const database = migratedDatabase();
    try {
      const {
        WORKSPACE_SCRUB_CHUNK,
        WORKSPACE_SCRUB_ROW_BUDGET,
        activateWorkspaceProductRoute,
      } = __workstreamAuthorityMigrationTesting;
      database.exec(`
        INSERT INTO users (id, google_subject, email, name, created_at, updated_at)
        VALUES ('resume-user', 'resume-subject', 'resume@example.com', 'Resume', '${AT}', '${AT}');
        INSERT INTO workspaces (id, name, slug, region, created_by_user_id, created_at, updated_at)
        VALUES ('resume-workspace', 'Resume', 'resume-workspace', 'global', 'resume-user', '${AT}', '${AT}');
      `);
      // One row beyond what a single tick may delete.
      const rows = WORKSPACE_SCRUB_ROW_BUDGET + 1;
      for (let start = 0; start < rows; start += 500) {
        const values = Array.from(
          { length: Math.min(500, rows - start) },
          (_, index) => `('event-${start + index}', 'resume-workspace', 'workstream.message.posted', 'workstream', 'user', 'Imported', 'workspace', 0, '${AT}', '${AT}', 'workstream_message', 'dedupe-${start + index}', '{}')`,
        ).join(",");
        database.exec(`
          INSERT INTO activity_events
            (id, workspace_id, event_type, subject_type, actor_type, title,
             audience_kind, digestible, occurred_at, created_at, source_kind,
             dedupe_key, metadata_json)
          VALUES ${values};
        `);
      }
      database.exec(`
        UPDATE workstream_authority_control
           SET phase = 'maintenance_draining', generation = 1, updated_at = '${AT}' WHERE id = 1;
        UPDATE workstream_authority_control
           SET phase = 'maintenance_importing', updated_at = '${AT}' WHERE id = 1;
        UPDATE workstream_authority_routes SET state = 'verified' WHERE generation = 1;
        UPDATE workspace_product_authority_routes SET state = 'verified' WHERE generation = 1;
        UPDATE workstream_authority_control
           SET phase = 'maintenance_verified', updated_at = '${AT}' WHERE id = 1;
      `);
      const env = { DB: sqliteD1(database) } as never;
      const route = {
        workspace_id: "resume-workspace",
        generation: 1,
        state: "verified",
        stage_index: 65,
        source_cursor: 0,
        row_counts_json: "{}",
      } as never;

      // First tick: budget runs out, so the route is left for the next one.
      expect(await activateWorkspaceProductRoute(env, route)).toBe(false);
      expect(database.prepare(
        `SELECT state FROM workspace_product_authority_routes WHERE workspace_id = 'resume-workspace'`,
      ).get()).toEqual({ state: "verified" });
      const left = (database.prepare(
        `SELECT COUNT(*) AS count FROM activity_events WHERE workspace_id = 'resume-workspace'`,
      ).get() as { count: number }).count;
      expect(left).toBeGreaterThan(0);
      expect(left).toBeLessThan(rows);

      // Second tick: the remainder goes and the route activates.
      expect(await activateWorkspaceProductRoute(env, route)).toBe(true);
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM activity_events WHERE workspace_id = 'resume-workspace'`,
      ).get()).toEqual({ count: 0 });
      expect(database.prepare(
        `SELECT state FROM workspace_product_authority_routes WHERE workspace_id = 'resume-workspace'`,
      ).get()).toEqual({ state: "active" });
      expect(WORKSPACE_SCRUB_CHUNK).toBeLessThan(WORKSPACE_SCRUB_ROW_BUDGET);
    } finally {
      database.close();
    }
  });

  it("classifies infrastructure blips as retryable and import errors as terminal", () => {
    // A transient rejection must pause the tick, not quarantine the campaign:
    // generation 4 died when one platform blip quarantined the phase and the
    // in-flight sibling operations cascaded `not_active` over the first cause.
    const { isTransientCampaignError } = __workstreamAuthorityMigrationTesting;
    for (const transient of [
      "d1 fetch failed",
      "Network connection lost.",
      "Too many API requests by single worker invocation.",
      "Too many subrequests.",
      "internal error",
      "The Durable Object's code was updated, causing the object to be reset because its code was updated",
      "Durable Object is overloaded",
      "connect ETIMEDOUT 104.16.0.1:443",
      "HTTP 503 from the D1 gateway",
    ]) {
      expect(isTransientCampaignError(new Error(transient)), transient).toBe(true);
    }
    // D1 sheds load with 7429 rather than failing the write; quarantining a
    // healthy campaign for it is what generation 4 taught us not to do.
    for (const transient of [
      "D1_ERROR: D1 DB is overloaded. Requests queued for too long. [code: 7429]",
      "D1 DB is overloaded. Requests queued for too long.",
    ]) {
      expect(isTransientCampaignError(new Error(transient)), transient).toBe(true);
    }
    for (const terminal of [
      "workspace_product_import_conflict:work_opportunity_provenance_roots",
      "workspace_product_import_not_active",
      "workspace_product_import_integer_invalid:attempt_count",
      "workspace_import_conflict:notes",
      "workstream_import_page_chain_missing",
      "no such table: users",
    ]) {
      expect(isTransientCampaignError(new Error(terminal)), terminal).toBe(false);
    }
    expect(isTransientCampaignError("fetch failed")).toBe(false);
  });

  it("translates historical connector events into stable WorkspaceDO payload identities", async () => {
    const source = {
      source_rowid: 17,
      id: "00000000-0000-7000-8000-000000000601",
      workspace_id: WORKSPACE_ID,
      connection_id: "00000000-0000-7000-8000-000000000602",
      connector_type: "github",
      connection_scope: "workspace",
      connection_owner_user_id: null,
      provider: "github",
      provider_event_id: "delivery-17",
      event_type: "github.pull_request.edited",
      resource_type: "github_pull_request",
      provider_resource_id: "juno-ai-labs/avalon#17",
      actor_json: '{"displayName":"Ada"}',
      subject_json: '{"number":17}',
      occurred_at: "2026-08-17T00:00:00.000Z",
      received_at: "2026-08-17T00:00:01.000Z",
      title: "Pull request edited",
      summary: "Migration owns the event",
      text_snippet: "WorkspaceDO",
      payload_ref: "global/provider-webhooks/github/body.json",
      visibility_json: "{}",
      target_user_ids_json: `["${USER_ID}"]`,
      entity_keys_json: '["github:pr:17"]',
      dedupe_key: "github:delivery-17:edited",
      raw_content_hash: "raw-hash",
      metadata_json: "{}",
      external_people_json: "[]",
      processing_status: "processed",
    };
    const first = await __workstreamAuthorityMigrationTesting.productImportRow(
      "workspace_connector_events",
      source,
      "global",
    );
    const replay = await __workstreamAuthorityMigrationTesting.productImportRow(
      "workspace_connector_events",
      {
        ...source,
        source_rowid: 18,
        id: "00000000-0000-7000-8000-000000000603",
        received_at: "2026-08-17T00:00:02.000Z",
      },
      "global",
    );
    expect(first).toMatchObject({
      event_sequence: 17,
      event_id: source.id,
      connector_type: "github",
      processing_status: "processed",
      processing_attempt: 0,
      processed_at: Date.parse(source.received_at),
    });
    expect(first.payload_hash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(replay.payload_hash).toBe(first.payload_hash);
  });
});
