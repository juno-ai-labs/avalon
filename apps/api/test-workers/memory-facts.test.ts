/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * Agent memory's fact store, against the object that owns it.
 *
 * Three things only real workerd can prove: that migration 116 imports a
 * populated item store into facts and then drops it (a `DROP TABLE` with FTS
 * shadow tables and cascading children behind it), that `applyMemorySweep`'s
 * cursor fence and the receipt it writes are one transaction, and that the
 * candidates a sweep is handed are fenced by what every participant of the
 * swept conversation may open. `docs/agent-memory.md` owns the rules.
 *
 * And the digest's half in this object (`memory-digest-sync.ts`): that a
 * digest read records its conversation as a holder of the facts it read in
 * the same transaction, that a retraction marks the holders of its fact and
 * the triggers on every visibility input mark the holders it can change, and
 * that the lane publishes one batch at a time and settles only the revision it
 * was sent.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import {
  completeMemoryDigestSync,
  markMemoryDigestHolders,
  memoryDigestSyncWork,
  publishMemoryDigestSync,
  releaseMemoryDigestSync,
  type MemoryDigestSyncMessage,
} from "../src/durable-objects/memory-digest-sync";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import {
  WorkspaceMemoryApplySweepResultSchema,
  WorkspaceMemoryDigestResultSchema,
  WorkspaceMemoryForgetResultSchema,
  WorkspaceMemoryRecallResultSchema,
  WorkspaceMemoryReviewForgetResultSchema,
  WorkspaceMemorySweepCandidatesResultSchema,
  type MemorySweepOperation,
} from "../src/durable-objects/workspace-memory-facts-protocol";

const FACTS_MIGRATION = 116;
const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000ad0");
const OWNER = "00000000-0000-7000-8000-000000000ad1";
const MEMBER = "00000000-0000-7000-8000-000000000ad2";
const THREAD_OPEN = "00000000-0000-7000-8000-000000000ad3";
const THREAD_PRIVATE = "00000000-0000-7000-8000-000000000ad4";
const SIDEKICK = "00000000-0000-7000-8000-000000000ad5";
const PERSONAL_SPACE = "00000000-0000-7000-8000-000000000ad6";
const GENERAL_SPACE = "00000000-0000-7000-8000-000000000ad7";
const AT = "2026-09-01T00:00:00.000Z";
const THREAD_PRICING = "00000000-0000-7000-8000-000000000ad8";
const SIDEKICK_RUN = "00000000-0000-7000-8000-000000000ad9";

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
}

/** A Canvas's directory row, open to every member or to its creator (the owner) and its participants. */
function seedCanvas(sql: SqlStorage, canvasId: string, visibility: "workspace" | "participants", title: string) {
  sql.exec(`INSERT INTO canvas_directory (canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at, visibility, authority_generation)
    VALUES (?, ?, ?, ?, 0, 0, ?, 1)`, canvasId, WORKSPACE_ID, title, OWNER, visibility);
}

/** A thread row in the directory projection, open to every member or to its participants. */
function seedThread(sql: SqlStorage, workstreamId: string, scope: "workspace" | "personal", title: string, participants: string[]) {
  sql.exec(`INSERT INTO channels (
      workstream_id, authority_generation, waterline, source_event_id, payload_hash,
      title, description, preview, scope, exact_state, origin_type, title_status,
      latest_attention_ordinal, unread_tracking_start_ordinal, last_activity_at,
      source_created_at, source_updated_at, projected_at
    ) VALUES (?, 1, 1, ?, 'hash', ?, '', '', ?, 'idle', 'ad_hoc', 'settled', 0, 0, 200, 200, 200, 200)`,
  workstreamId, `event-${workstreamId}`, title, scope);
  for (const userId of participants) {
    sql.exec(`INSERT INTO channel_viewers (
        workstream_id, user_id, authority_generation, waterline, source_event_id, payload_hash,
        is_participant, unread_count, you_are_mentioned, listable, seen_attention_ordinal,
        manual_unread_from_ordinal, manual_unread_generation, latest_mention_attention_ordinal, projected_at
      ) VALUES (?, ?, 1, 1, ?, 'hash', 1, 0, 0, 1, 0, NULL, 0, 0, 200)`,
    workstreamId, userId, `event-${workstreamId}-${userId}`);
  }
}

function seedMember(sql: SqlStorage, userId: string, role: "owner" | "member") {
  sql.exec(
    `INSERT INTO workspace_member_status (user_id, relationship_json, removed_incarnation, active, sequence, updated_at)
     VALUES (?, ?, NULL, 1, 1, 0) ON CONFLICT (user_id) DO UPDATE SET relationship_json = excluded.relationship_json, active = 1`,
    userId,
    JSON.stringify({ workspaceId: WORKSPACE_ID, userId, accessClass: "member", role, status: "active", incarnation: "i1", revision: 1 }),
  );
}

describe("migration 116 on workerd", () => {
  it("imports every live prose memory as a fact with its subject and source, drops the item store, and clears the retired alarm", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("memory-facts-v115");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      const before = WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version < FACTS_MIGRATION);
      expect(before.at(-1)?.version).toBe(FACTS_MIGRATION - 1);
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: before, component: "workspace_do", workerVersionId: "before-facts", now: 1,
      });
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
        VALUES (1, ?, 'global', 'wnam', 0, 0)`, WORKSPACE_ID);
      seedThread(sql, THREAD_OPEN, "workspace", "Launch", [OWNER]);
      sql.exec(`INSERT INTO spaces (space_id, title, scope, created_by_user_id, system_role, authority_generation, source_version,
          payload_hash, revision, created_at, updated_at)
        VALUES (?, 'Owner', 'individual', ?, NULL, 1, 1, 'space', 1, 0, 0), (?, 'General', 'workspace', NULL, 'general', 1, 1, 'space', 1, 0, 0)`,
      PERSONAL_SPACE, OWNER, GENERAL_SPACE);
      sql.exec(`INSERT INTO automation_directory
          (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope, owning_workstream_id, title, description, next_run_at, projected_at)
        VALUES (?, ?, ?, 1, 'hash', 'active', 'workspace', NULL, 'Digest', '', NULL, 1)`, SIDEKICK, WORKSPACE_ID, OWNER);
      for (const [id, kind, owner] of [
        ["scope-user", "user", OWNER], ["scope-thread", "workstream", THREAD_OPEN],
        ["scope-sidekick", "sidekick", SIDEKICK], ["scope-workspace", "workspace", WORKSPACE_ID],
      ] as const) {
        sql.exec(`INSERT INTO memory_scopes (memory_scope_id, workspace_id, kind, owner_id, created_at) VALUES (?, ?, ?, ?, ?)`,
          id, WORKSPACE_ID, kind, owner, AT);
      }
      const item = (id: string, scope: string, text: string, provenance: string, extra: { expires?: string | null; invalidated?: string | null } = {}) =>
        sql.exec(`INSERT INTO memory_items
            (memory_item_id, memory_scope_id, workspace_id, text, revision, expires_at, provenance_json,
             invalidated_at, invalidated_by_principal_json, invalidation_reason, last_mutation_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 'mutation', ?, ?)`,
        id, scope, WORKSPACE_ID, text, extra.expires ?? null, provenance, extra.invalidated ?? null,
        extra.invalidated ? "{}" : null, extra.invalidated ? "retired" : null, AT, AT);
      item("item-user-thread", "scope-user", "Owner prefers crimson reports", JSON.stringify({ workstreamId: THREAD_OPEN }));
      item("item-user-personal", "scope-user", "Owner starts late on Mondays", JSON.stringify({ workstreamId: "gone" }));
      item("item-thread", "scope-thread", "The launch codename is zephyr", JSON.stringify({ workstreamId: THREAD_OPEN }));
      item("item-sidekick", "scope-sidekick", "Use the crimson summary template", JSON.stringify({ workstreamId: SIDEKICK }));
      item("item-workspace", "scope-workspace", "Release day is Thursday", JSON.stringify({}));
      item("item-expired", "scope-workspace", "Chartreuse was the palette", "{}", { expires: "2020-01-01T00:00:00.000Z" });
      item("item-invalidated", "scope-user", "Retired preference", "{}", { invalidated: AT });
      item("item-future", "scope-thread", "Freeze until Friday", JSON.stringify({ workstreamId: THREAD_OPEN }), { expires: "2999-01-01T00:00:00.000Z" });
      sql.exec(`INSERT INTO _internal_durable_alarms (kind, alarm_key, due_at, created_at, updated_at)
        VALUES ('maintenance', 'memory_index', 1, 0, 0), ('maintenance', 'resource_slugs', 1, 0, 0)`);
    });

    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage, migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS, component: "workspace_do",
        workerVersionId: "with-facts", now: 2,
      });
      const sql = state.storage.sql;
      expect(sql.exec<{ fact_id: string; subject_kind: string; subject_id: string; source: string; valid_until: number | null }>(
        `SELECT fact_id, subject_kind, subject_id, json_extract(source_conversations_json, '$[0]') AS source, valid_until
           FROM memory_facts ORDER BY fact_id`,
      ).toArray()).toEqual([
        { fact_id: "item-future", subject_kind: "thread", subject_id: THREAD_OPEN, source: THREAD_OPEN, valid_until: Date.parse("2999-01-01T00:00:00.000Z") },
        { fact_id: "item-sidekick", subject_kind: "sidekick", subject_id: SIDEKICK, source: `sidekick:${SIDEKICK}`, valid_until: null },
        { fact_id: "item-thread", subject_kind: "thread", subject_id: THREAD_OPEN, source: THREAD_OPEN, valid_until: null },
        { fact_id: "item-user-personal", subject_kind: "person", subject_id: OWNER, source: `space:${PERSONAL_SPACE}`, valid_until: null },
        { fact_id: "item-user-thread", subject_kind: "person", subject_id: OWNER, source: THREAD_OPEN, valid_until: null },
        { fact_id: "item-workspace", subject_kind: "organization", subject_id: WORKSPACE_ID, source: `space:${GENERAL_SPACE}`, valid_until: null },
      ]);
      // The FTS shadow follows the content table: a match finds the import.
      expect(sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM memory_facts_fts WHERE memory_facts_fts MATCH '"zephyr"'`,
      ).one().n).toBe(1);
      expect(sql.exec<{ name: string }>(`SELECT name FROM sqlite_schema WHERE name IN
          ('memory_items', 'memory_items_fts', 'memory_mutations', 'memory_index_outbox')`).toArray()).toEqual([]);
      expect(sql.exec<{ alarm_key: string }>(
        `SELECT alarm_key FROM _internal_durable_alarms WHERE kind = 'maintenance' ORDER BY alarm_key`,
      ).toArray()).toEqual([{ alarm_key: "resource_slugs" }]);
      // The scopes and tables the sweep does not replace are untouched.
      expect(sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM memory_scopes`).one().n).toBe(4);
      expect(sql.exec("PRAGMA foreign_key_check").toArray()).toEqual([]);
    });
  });
});

describe("the fact store on workerd", () => {
  async function fresh() {
    await workspace().initializeWorkspace(WORKSPACE_ID, "wnam");
    await runInDurableObject(workspace(), (_instance, state) => {
      const sql = state.storage.sql;
      for (const table of [
        "memory_facts", "memory_sweep_receipts", "memory_fact_receipts", "memory_digest_holders", "memory_digest_holder_facts",
        "canvas_participants", "canvas_directory", "workspace_member_status", "automation_directory",
      ]) {
        sql.exec(`DELETE FROM ${table}`);
      }
      seedMember(sql, OWNER, "owner");
      seedMember(sql, MEMBER, "member");
      seedCanvas(sql, THREAD_OPEN, "workspace", "Launch");
      seedCanvas(sql, THREAD_PRIVATE, "participants", "Owner's side room");
      seedCanvas(sql, THREAD_PRICING, "workspace", "Pricing");
      sql.exec(`INSERT INTO automation_directory
          (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope, owning_workstream_id, title, description, next_run_at, projected_at)
        VALUES (?, ?, ?, 1, 'hash', 'active', 'workspace', NULL, 'Digest', '', NULL, 1)`, SIDEKICK, WORKSPACE_ID, OWNER);
      // Seeding fires the participant triggers, which advance both counters; each
      // has one row, the migration's seed, so it is reset rather than deleted.
      sql.exec("DELETE FROM memory_digest_sync");
      sql.exec(`UPDATE memory_digest_sync_state SET revision = 0`);
      sql.exec(`UPDATE memory_revision SET revision = 0`);
    });
  }

  const openThread = { parentKind: "canvas" as const, parentId: THREAD_OPEN, substreamId: "0" };
  const privateThread = { parentKind: "canvas" as const, parentId: THREAD_PRIVATE, substreamId: "0" };

  function add(subjectKind: "organization" | "thread", text: string) {
    return {
      op: "add" as const, subjectKind, subjectId: null, kind: "standing" as const, text,
      validFrom: null, validUntil: null, validUntilBasis: null, derivedFrom: "person" as const,
      conflict: false, confidence: 0.9, evidence: [1],
    };
  }

  it("applies a sweep once behind the cursor fence, answers a replay from its receipt, and refuses a gap", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    const first = WorkspaceMemoryApplySweepResultSchema.parse(await workspace().applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: openThread, fromSeq: 0, toSeq: 12,
      operations: [add("organization", "Release day is Thursday"), add("thread", "The launch codename is zephyr")],
      model: "test/model", inputTokens: 10, outputTokens: 5, factIds: ["fact-release", "fact-codename"], speakerIds: [], candidateFactIds: [], now,
    }));
    expect(first).toEqual({
      outcome: "applied",
      receipt: { conversation: `canvas:${THREAD_OPEN}`, fromSeq: 0, toSeq: 12, appliedAt: now, operationCount: 2 },
      refused: [],
      // One applied sweep, one advance of the ordering token, whatever it wrote.
      revision: 1,
      markedHolders: false,
    });
    // A redelivery of the same range writes nothing and hands back the receipt.
    const replay = WorkspaceMemoryApplySweepResultSchema.parse(await workspace().applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: openThread, fromSeq: 0, toSeq: 12,
      operations: [add("thread", "A duplicate the replay must not write")],
      model: "test/model", inputTokens: 10, outputTokens: 5, factIds: ["fact-dup"], speakerIds: [], candidateFactIds: [], now: now + 1,
    }));
    expect(replay).toEqual({
      outcome: "already_applied",
      receipt: { conversation: `canvas:${THREAD_OPEN}`, fromSeq: 0, toSeq: 12, appliedAt: now, operationCount: 2 },
    });
    // A range starting past the store's cursor is a skipped sweep, not progress.
    expect(WorkspaceMemoryApplySweepResultSchema.parse(await workspace().applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: openThread, fromSeq: 40, toSeq: 50, operations: [],
      model: "test/model", inputTokens: null, outputTokens: null, factIds: [], speakerIds: [], candidateFactIds: [], now: now + 2,
    }))).toEqual({ outcome: "cursor_ahead", storedToSeq: 12 });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec<{ fact_id: string }>(`SELECT fact_id FROM memory_facts ORDER BY fact_id`).toArray())
        .toEqual([{ fact_id: "fact-codename" }, { fact_id: "fact-release" }]);
    });
  });

  it("refuses a fact filed wider than the conversation's placement and applies the rest of the batch", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    const applied = WorkspaceMemoryApplySweepResultSchema.parse(await workspace().applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: privateThread, fromSeq: 0, toSeq: 3,
      operations: [add("organization", "Everyone works Fridays"), add("thread", "Owner wants the side room quiet")],
      model: "test/model", inputTokens: null, outputTokens: null, factIds: ["fact-wide", "fact-room"], speakerIds: [], candidateFactIds: [], now,
    }));
    expect(applied).toMatchObject({ outcome: "applied", refused: [{ index: 0, code: "subject_above_placement" }] });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec<{ fact_id: string }>(`SELECT fact_id FROM memory_facts`).toArray()).toEqual([{ fact_id: "fact-room" }]);
    });
  });

  it("touches only the candidates it was handed, and files a person fact only for a speaker", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    const common = { workspaceId: WORKSPACE_ID, conversation: openThread, model: "test/model", inputTokens: null, outputTokens: null };
    await workspace().applyMemorySweep({
      ...common, fromSeq: 0, toSeq: 3, operations: [add("thread", "The launch codename is zephyr")],
      factIds: ["fact-codename"], speakerIds: [], candidateFactIds: [], now,
    });
    const retract = { op: "retract" as const, factId: "fact-codename", reason: "The codename was dropped", evidence: [4] };
    const person = { ...add("thread", "Member prefers short standups"), subjectKind: "person" as const, subjectId: MEMBER };
    // A fact id the model read off the transcript rather than the candidate
    // list is refused, and so is a person who did not speak in the window.
    expect(WorkspaceMemoryApplySweepResultSchema.parse(await workspace().applyMemorySweep({
      ...common, fromSeq: 3, toSeq: 6, operations: [retract, person],
      factIds: ["fact-unused", "fact-standups"], speakerIds: [], candidateFactIds: [], now: now + 1,
    }))).toMatchObject({
      outcome: "applied",
      refused: [{ index: 0, code: "fact_not_candidate" }, { index: 1, code: "subject_id_not_in_placement" }],
    });
    // The same operations pass once the sweep was handed the fact and heard the member.
    expect(WorkspaceMemoryApplySweepResultSchema.parse(await workspace().applyMemorySweep({
      ...common, fromSeq: 6, toSeq: 9, operations: [retract, person],
      factIds: ["fact-unused", "fact-standups"], speakerIds: [MEMBER], candidateFactIds: ["fact-codename"], now: now + 2,
    }))).toMatchObject({ outcome: "applied", refused: [] });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec<{ fact_id: string; subject_kind: string; subject_id: string; retracted_at: number | null }>(
        `SELECT fact_id, subject_kind, subject_id, retracted_at FROM memory_facts ORDER BY fact_id`,
      ).toArray()).toEqual([
        { fact_id: "fact-codename", subject_kind: "thread", subject_id: THREAD_OPEN, retracted_at: now + 2 },
        { fact_id: "fact-standups", subject_kind: "person", subject_id: MEMBER, retracted_at: null },
      ]);
    });
  });

  it("keeps a cursor fence per Sidekick conversation, though they share one source", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    const sweep = (substreamId: string, fromSeq: number, toSeq: number, text: string, factId: string) => workspace().applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: { parentKind: "automation", parentId: SIDEKICK, substreamId }, fromSeq, toSeq,
      operations: [{ ...add("thread", text), subjectKind: "sidekick" as const }],
      model: "test/model", inputTokens: null, outputTokens: null, factIds: [factId], speakerIds: [], candidateFactIds: [], now,
    }).then((value) => WorkspaceMemoryApplySweepResultSchema.parse(value));
    // The Sidekick's own conversation and one of its runs, each from its own
    // transcript's start: neither range is the other's replay or gap.
    expect(await sweep("0", 0, 10, "The digest goes out at nine", "fact-main")).toMatchObject({ outcome: "applied", refused: [] });
    expect(await sweep(SIDEKICK_RUN, 0, 4, "The digest skips weekends", "fact-run")).toMatchObject({ outcome: "applied", refused: [] });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec<{ conversation: string; to_seq: number }>(
        `SELECT conversation, to_seq FROM memory_sweep_receipts ORDER BY to_seq`,
      ).toArray()).toEqual([
        { conversation: `sidekick:${SIDEKICK}/${SIDEKICK_RUN}`, to_seq: 4 },
        { conversation: `sidekick:${SIDEKICK}/0`, to_seq: 10 },
      ]);
      // What both learned is the Sidekick's, under the one source.
      expect(state.storage.sql.exec<{ fact_id: string; source: string }>(
        `SELECT fact_id, json_extract(source_conversations_json, '$[0]') AS source FROM memory_facts ORDER BY fact_id`,
      ).toArray()).toEqual([
        { fact_id: "fact-main", source: `sidekick:${SIDEKICK}` },
        { fact_id: "fact-run", source: `sidekick:${SIDEKICK}` },
      ]);
    });
  });

  it("files an update under the conversation its evidence came from, and marks two trust classes mixed", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    await workspace().applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: openThread, fromSeq: 0, toSeq: 3,
      operations: [add("organization", "Release day is Thursday")],
      model: "test/model", inputTokens: null, outputTokens: null, factIds: ["fact-release"], speakerIds: [], candidateFactIds: [], now,
    });
    const pricing = { parentKind: "canvas" as const, parentId: THREAD_PRICING, substreamId: "0" };
    const update = (evidence: number[]) => ({
      op: "update" as const, factId: "", text: "", validUntil: null, derivedFrom: "external" as const, evidence,
    });
    // A Slack message in another thread moves the date: new evidence, from there.
    expect(WorkspaceMemoryApplySweepResultSchema.parse(await workspace().applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: pricing, fromSeq: 0, toSeq: 9,
      operations: [{ ...update([7]), factId: "fact-release", text: "Release day is Friday" }],
      model: "test/model", inputTokens: null, outputTokens: null, factIds: ["fact-friday"], speakerIds: [], candidateFactIds: ["fact-release"], now: now + 1,
    }))).toMatchObject({ outcome: "applied", refused: [] });
    // Restated without citing anything new: the evidence and its conversation stay first.
    expect(WorkspaceMemoryApplySweepResultSchema.parse(await workspace().applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: openThread, fromSeq: 3, toSeq: 6,
      operations: [{ ...update([]), factId: "fact-friday", text: "Release day is Friday afternoon" }],
      model: "test/model", inputTokens: null, outputTokens: null, factIds: ["fact-afternoon"], speakerIds: [], candidateFactIds: ["fact-friday"], now: now + 2,
    }))).toMatchObject({ outcome: "applied", refused: [] });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec<{ fact_id: string; derived_from: string; evidence_json: string; source_conversations_json: string }>(
        `SELECT fact_id, derived_from, evidence_json, source_conversations_json FROM memory_facts ORDER BY created_at`,
      ).toArray()).toEqual([
        { fact_id: "fact-release", derived_from: "person", evidence_json: "[1]", source_conversations_json: JSON.stringify([`canvas:${THREAD_OPEN}`]) },
        { fact_id: "fact-friday", derived_from: "mixed", evidence_json: "[7]", source_conversations_json: JSON.stringify([`canvas:${THREAD_PRICING}`, `canvas:${THREAD_OPEN}`]) },
        { fact_id: "fact-afternoon", derived_from: "mixed", evidence_json: "[7]", source_conversations_json: JSON.stringify([`canvas:${THREAD_PRICING}`, `canvas:${THREAD_OPEN}`]) },
      ]);
    });
  });

  it("hands a sweep only the facts every current participant may open", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    // An Organization fact learned in the owner's private room: promoted, but
    // sourced from a conversation the member cannot open.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE canvas_directory SET visibility = 'workspace' WHERE canvas_id = ?`, THREAD_PRIVATE);
    });
    await workspace().applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: privateThread, fromSeq: 0, toSeq: 3,
      operations: [add("organization", "Release day is Thursday")],
      model: "test/model", inputTokens: null, outputTokens: null, factIds: ["fact-release"], speakerIds: [], candidateFactIds: [], now,
    });
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE canvas_directory SET visibility = 'participants' WHERE canvas_id = ?`, THREAD_PRIVATE);
    });
    const candidates = () => workspace().memorySweepCandidates({
      workspaceId: WORKSPACE_ID, conversation: openThread, terms: ["release", "thursday"], speakerIds: [OWNER, MEMBER], now, limit: 20,
    }).then((value) => WorkspaceMemorySweepCandidatesResultSchema.parse(value));
    // The open thread is read by every member, and a member who cannot open
    // the private room must not be handed its words through a candidate.
    expect(await candidates()).toMatchObject({ outcome: "ready", candidates: [] });
    // The owner may open the room, but the room is not Organization-wide, so
    // its own sweep is not handed Organization facts either: the subject is
    // fenced as well as the source.
    expect(WorkspaceMemorySweepCandidatesResultSchema.parse(await workspace().memorySweepCandidates({
      workspaceId: WORKSPACE_ID, conversation: privateThread, terms: ["release", "thursday"], speakerIds: [OWNER], now, limit: 20,
    }))).toMatchObject({ outcome: "ready", placement: { organizationWide: false }, candidates: [] });
    // The recall a member makes from the open thread says the same thing.
    expect(WorkspaceMemoryRecallResultSchema.parse(await workspace().recallMemoryFacts({
      workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: MEMBER }, conversation: openThread,
      query: "release day", now, limit: 10,
    })).facts).toEqual([]);
    // Once the private room is opened to every member, the fact follows.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE canvas_directory SET visibility = 'workspace' WHERE canvas_id = ?`, THREAD_PRIVATE);
    });
    expect(await candidates()).toMatchObject({
      outcome: "ready",
      placement: { organizationWide: true, people: [{ id: OWNER }, { id: MEMBER }] },
      candidates: [{ factId: "fact-release", subjectKind: "organization" }],
    });
    expect(WorkspaceMemoryRecallResultSchema.parse(await workspace().recallMemoryFacts({
      workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: MEMBER }, conversation: openThread,
      query: "release day", now, limit: 10,
    })).facts.map((fact) => fact.factId)).toEqual(["fact-release"]);
  });

  /** A recording queue, so a publish is read back rather than sent. */
  function recordingQueue() {
    const sent: Array<{ body: MemoryDigestSyncMessage }> = [];
    return { sent, queue: { sendBatch: async (messages: Array<{ body: MemoryDigestSyncMessage }>) => { sent.push(...messages); } } };
  }

  function syncRow(sql: SqlStorage) {
    return sql.exec<{ conversation: string; revision: number; attempts: number; not_before: number; in_flight: number }>(
      "SELECT conversation, revision, attempts, not_before, in_flight FROM memory_digest_sync",
    ).toArray();
  }

  it("answers a member's digest with the facts they may read here, newest first and named, and records the thread as a holder", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    const common = { workspaceId: WORKSPACE_ID, model: "test/model", inputTokens: null, outputTokens: null, candidateFactIds: [] };
    // An Organization fact learned in the owner's private room, while it was open.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE canvas_directory SET visibility = 'workspace' WHERE canvas_id = ?`, THREAD_PRIVATE);
    });
    await workspace().applyMemorySweep({
      ...common, conversation: privateThread, fromSeq: 0, toSeq: 3, operations: [add("organization", "Release day is Thursday")],
      factIds: ["fact-release"], speakerIds: [], now,
    });
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE canvas_directory SET visibility = 'participants' WHERE canvas_id = ?`, THREAD_PRIVATE);
    });
    await workspace().applyMemorySweep({
      ...common, conversation: openThread, fromSeq: 0, toSeq: 3, operations: [add("organization", "Standups are at ten")],
      factIds: ["fact-standups"], speakerIds: [], now: now + 1,
    });
    await workspace().applyMemorySweep({
      ...common, conversation: openThread, fromSeq: 3, toSeq: 6, operations: [add("thread", "The launch codename is zephyr")],
      factIds: ["fact-codename"], speakerIds: [], now: now + 2,
    });
    await workspace().applyMemorySweep({
      ...common, conversation: openThread, fromSeq: 6, toSeq: 9,
      operations: [{ ...add("thread", "Member prefers short updates"), subjectKind: "person" as const, subjectId: MEMBER }],
      factIds: ["fact-updates"], speakerIds: [MEMBER], now: now + 3,
    });

    const digest = WorkspaceMemoryDigestResultSchema.parse(await workspace().memoryDigest({
      workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: MEMBER }, conversation: openThread, now: now + 4, limit: 10,
    }));
    const shape = { kind: "standing", validFrom: null, validUntil: null, conflict: false, derivedFrom: "person" };
    // The room's fact stays out: the member cannot open where it was learned.
    expect(digest.facts).toEqual([
      { ...shape, factId: "fact-updates", subjectKind: "person", subjectLabel: null, text: "Member prefers short updates", createdAt: now + 3 },
      { ...shape, factId: "fact-codename", subjectKind: "thread", subjectLabel: "Launch", text: "The launch codename is zephyr", createdAt: now + 2 },
      { ...shape, factId: "fact-standups", subjectKind: "organization", subjectLabel: null, text: "Standups are at ten", createdAt: now + 1 },
    ]);
    // Four applied sweeps and two scope changes (each a mark) came before the read.
    expect(digest.revision).toBe(6);
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec(
        "SELECT conversation, parent_kind, parent_id, substream_id FROM memory_digest_holders",
      ).toArray()).toEqual([{ conversation: `canvas:${THREAD_OPEN}`, parent_kind: "canvas", parent_id: THREAD_OPEN, substream_id: "0" }]);
      expect(state.storage.sql.exec(
        "SELECT conversation, principal, fact_id FROM memory_digest_holder_facts ORDER BY fact_id",
      ).toArray()).toEqual([
        { conversation: `canvas:${THREAD_OPEN}`, principal: `user:${MEMBER}`, fact_id: "fact-codename" },
        { conversation: `canvas:${THREAD_OPEN}`, principal: `user:${MEMBER}`, fact_id: "fact-standups" },
        { conversation: `canvas:${THREAD_OPEN}`, principal: `user:${MEMBER}`, fact_id: "fact-updates" },
      ]);
    });
  });

  it("marks the holder of a retracted fact, publishes one batch at a time, and settles only the revision it sent", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    await workspace().applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: openThread, fromSeq: 0, toSeq: 3,
      operations: [add("thread", "The launch codename is zephyr")],
      model: "test/model", inputTokens: null, outputTokens: null, factIds: ["fact-codename"], speakerIds: [], candidateFactIds: [], now,
    });
    await workspace().memoryDigest({
      workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: MEMBER }, conversation: openThread, now, limit: 10,
    });
    expect(WorkspaceMemoryForgetResultSchema.parse(await workspace().forgetMemoryFact({
      workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: OWNER }, conversation: openThread,
      receiptId: "receipt-forget", harnessRunId: "run-forget", factId: "fact-codename", now: now + 1,
    })).outcome).toBe("retracted");

    // The retraction arms the alarm itself, so the lane claims the holder
    // without waiting on an unrelated wake. Its gate is a minute out.
    const claimed = await vi.waitFor(async () => {
      const rows = await runInDurableObject(workspace(), (_instance, state) => syncRow(state.storage.sql));
      expect(rows).toMatchObject([{ conversation: `canvas:${THREAD_OPEN}`, revision: 1, attempts: 1, in_flight: 1 }]);
      return rows[0]!;
    }, { timeout: 10_000 });

    await runInDurableObject(workspace(), async (_instance, state) => {
      const sql = state.storage.sql;
      const { sent, queue } = recordingQueue();
      const publish = (at: number) => publishMemoryDigestSync({
        sql, queue, workspaceId: WORKSPACE_ID, region: "global", now: at, retryAt: (attempt) => at + attempt * 60_000,
      });
      // The alarm's batch is in flight, so nothing more goes before its gate.
      expect(await publish(claimed.not_before - 1)).toBe(0);
      expect(sent).toEqual([]);
      // Released, the row waits on its own gate and holds nothing back.
      expect(releaseMemoryDigestSync(sql, `canvas:${THREAD_OPEN}`, 1)).toBe(true);
      expect(syncRow(sql)).toMatchObject([{ in_flight: 0 }]);
      expect(await publish(claimed.not_before - 1)).toBe(0);
      expect(await publish(claimed.not_before)).toBe(1);
      expect(sent).toEqual([{ body: { type: "memory_digest_sync", region: "global", workspaceId: WORKSPACE_ID, conversation: `canvas:${THREAD_OPEN}`, revision: 1 } }]);
      expect(syncRow(sql)).toMatchObject([{ attempts: 2, in_flight: 1 }]);
      // A second publish before that batch's gate sends nothing.
      expect(await publish(claimed.not_before + 1)).toBe(0);
      expect(sent).toHaveLength(1);

      expect(memoryDigestSyncWork(sql, { conversation: `canvas:${THREAD_OPEN}`, revision: 1 })).toEqual(openThread);
      expect(completeMemoryDigestSync(sql, `canvas:${THREAD_OPEN}`, 1)).toBe(true);
      expect(syncRow(sql)).toEqual([]);

      // A thread made private marks the holder again, numbered above the last.
      sql.exec(`UPDATE canvas_directory SET visibility = 'participants' WHERE canvas_id = ?`, THREAD_OPEN);
      expect(syncRow(sql)).toMatchObject([{ conversation: `canvas:${THREAD_OPEN}`, revision: 2, attempts: 0, not_before: 0, in_flight: 0 }]);
    });
  });

  it("marks the holders that read a fact an administrator removes from their review, and none when a member is refused", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    // The side room's copy is read before the fact exists: a holder that never held it.
    await workspace().memoryDigest({
      workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: OWNER }, conversation: privateThread, now, limit: 10,
    });
    await workspace().applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: openThread, fromSeq: 0, toSeq: 3,
      operations: [add("organization", "Release day is Thursday")],
      model: "test/model", inputTokens: null, outputTokens: null, factIds: ["fact-release"], speakerIds: [], candidateFactIds: [], now,
    });
    await workspace().memoryDigest({
      workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: MEMBER }, conversation: openThread, now, limit: 10,
    });
    const forget = async (userId: string) => WorkspaceMemoryReviewForgetResultSchema.parse(await workspace().forgetReviewedMemoryFact({
      workspaceId: WORKSPACE_ID, userId, scope: { kind: "organization" }, factId: "fact-release", now: now + 1,
    })).outcome;

    expect(await forget(MEMBER)).toBe("not_removable");
    await runInDurableObject(workspace(), (_instance, state) => expect(syncRow(state.storage.sql)).toEqual([]));
    expect(await forget(OWNER)).toBe("retracted");
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(syncRow(state.storage.sql)).toMatchObject([{ conversation: `canvas:${THREAD_OPEN}`, revision: 1 }]);
      expect(state.storage.sql.exec("SELECT retracted_by FROM memory_facts WHERE fact_id = 'fact-release'").toArray())
        .toEqual([{ retracted_by: `person:${OWNER}` }]);
    });
  });

  it("refuses a stale revision, leaving the newer mark, and settles a row whose holder is gone", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    await workspace().memoryDigest({
      workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: MEMBER }, conversation: openThread, now, limit: 10,
    });
    await runInDurableObject(workspace(), async (_instance, state) => {
      const sql = state.storage.sql;
      markMemoryDigestHolders(sql);
      const { queue } = recordingQueue();
      expect(await publishMemoryDigestSync({
        sql, queue, workspaceId: WORKSPACE_ID, region: "global", now, retryAt: () => now + 60_000,
      })).toBe(1);
      expect(releaseMemoryDigestSync(sql, `canvas:${THREAD_OPEN}`, 1)).toBe(true);
      expect(syncRow(sql)).toMatchObject([{ revision: 1, in_flight: 0, not_before: now + 60_000 }]);

      // The Canvas narrowing marks it again while revision 1 is out.
      sql.exec(`UPDATE canvas_directory SET visibility = 'participants' WHERE canvas_id = ?`, THREAD_OPEN);
      expect(syncRow(sql)).toMatchObject([{ revision: 2, attempts: 0, not_before: 0, in_flight: 0 }]);
      expect(memoryDigestSyncWork(sql, { conversation: `canvas:${THREAD_OPEN}`, revision: 1 })).toBeNull();
      expect(completeMemoryDigestSync(sql, `canvas:${THREAD_OPEN}`, 1)).toBe(false);
      expect(releaseMemoryDigestSync(sql, `canvas:${THREAD_OPEN}`, 1)).toBe(false);
      expect(syncRow(sql)).toMatchObject([{ revision: 2 }]);

      sql.exec("DELETE FROM memory_digest_holders");
      expect(memoryDigestSyncWork(sql, { conversation: `canvas:${THREAD_OPEN}`, revision: 2 })).toBeNull();
      expect(syncRow(sql)).toEqual([]);
    });
  });

  it("marks only the holders that read a fact a sweep retracts, and none for a confirm or an update", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    const common = { workspaceId: WORKSPACE_ID, conversation: openThread, model: "test/model", inputTokens: null, outputTokens: null, speakerIds: [] };
    await workspace().applyMemorySweep({
      ...common, fromSeq: 0, toSeq: 3,
      operations: [add("thread", "The launch codename is zephyr"), add("thread", "The launch is on Tuesday")],
      factIds: ["fact-codename", "fact-launch-day"], candidateFactIds: [], now,
    });
    // The open thread's copy holds both facts; the side room's holds neither.
    await workspace().memoryDigest({
      workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: MEMBER }, conversation: openThread, now, limit: 10,
    });
    await workspace().memoryDigest({
      workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: OWNER }, conversation: privateThread, now, limit: 10,
    });
    const apply = async (fromSeq: number, operation: MemorySweepOperation, factId: string) =>
      WorkspaceMemoryApplySweepResultSchema.parse(await workspace().applyMemorySweep({
        ...common, fromSeq, toSeq: fromSeq + 3, operations: [operation], factIds: ["fact-minted"],
        candidateFactIds: [factId], now: now + fromSeq,
      }));
    expect(await apply(3, { op: "confirm", factId: "fact-codename", evidence: [4] }, "fact-codename"))
      .toMatchObject({ outcome: "applied", refused: [], markedHolders: false });
    // A supersede withdraws nobody's access: the copy is stale until its next refresh.
    expect(await apply(6, { op: "update", factId: "fact-launch-day", text: "The launch is on Wednesday", validUntil: null, derivedFrom: "person", evidence: [7] }, "fact-launch-day"))
      .toMatchObject({ outcome: "applied", refused: [], markedHolders: false });
    await runInDurableObject(workspace(), (_instance, state) => expect(syncRow(state.storage.sql)).toEqual([]));
    expect(await apply(9, { op: "retract", factId: "fact-codename", reason: "The codename was dropped", evidence: [10] }, "fact-codename"))
      .toMatchObject({ outcome: "applied", refused: [], markedHolders: true });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(syncRow(state.storage.sql)).toMatchObject([{ conversation: `canvas:${THREAD_OPEN}`, revision: 1 }]);
    });
  });

  it("records every conversation of one Sidekick as its own holder, and hands each back to the lane", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    // `fresh()` seeds the Sidekick in the directory.
    const authoring = { parentKind: "automation" as const, parentId: SIDEKICK, substreamId: "0" };
    const run = { parentKind: "automation" as const, parentId: SIDEKICK, substreamId: "run-1" };
    for (const conversation of [authoring, run]) {
      await workspace().memoryDigest({
        workspaceId: WORKSPACE_ID, reader: { kind: "sidekick", automationId: SIDEKICK }, conversation, now, limit: 10,
      });
    }
    await runInDurableObject(workspace(), (_instance, state) => {
      const sql = state.storage.sql;
      expect(sql.exec("SELECT conversation, substream_id FROM memory_digest_holders ORDER BY conversation").toArray()).toEqual([
        { conversation: `sidekick:${SIDEKICK}/0`, substream_id: "0" },
        { conversation: `sidekick:${SIDEKICK}/run-1`, substream_id: "run-1" },
      ]);
      markMemoryDigestHolders(sql);
      expect(memoryDigestSyncWork(sql, { conversation: `sidekick:${SIDEKICK}/0`, revision: 1 })).toEqual(authoring);
      expect(memoryDigestSyncWork(sql, { conversation: `sidekick:${SIDEKICK}/run-1`, revision: 1 })).toEqual(run);
    });
  });

  /** The open thread held by the member and the side room by the owner, with nothing marked yet. */
  async function twoHolders(now: number) {
    await workspace().memoryDigest({
      workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: MEMBER }, conversation: openThread, now, limit: 10,
    });
    await workspace().memoryDigest({
      workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: OWNER }, conversation: privateThread, now, limit: 10,
    });
  }

  function markedConversations(sql: SqlStorage): string[] {
    return sql.exec<{ conversation: string }>("SELECT conversation FROM memory_digest_sync ORDER BY conversation")
      .toArray().map((row) => row.conversation);
  }

  it("marks the holders of the Canvas a participant joins, and not another Canvas's", async () => {
    await fresh();
    await twoHolders(Date.parse("2026-10-19T09:00:00.000Z"));
    await runInDurableObject(workspace(), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO canvas_participants (canvas_id, user_id, source, added_by_user_id, added_at) VALUES (?, ?, 'added', ?, 200)`, THREAD_PRIVATE, MEMBER, OWNER);
      expect(markedConversations(sql)).toEqual([`canvas:${THREAD_PRIVATE}`]);
    });
  });

  it("marks every copy holding a fact learned on a Canvas its person leaves, and no copy that never read one", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    const THREAD_OTHER = "00000000-0000-7000-8000-000000000ada";
    await runInDurableObject(workspace(), (_instance, state) => {
      const sql = state.storage.sql;
      // The member joins the side room, and a third open thread has the owner alone.
      sql.exec(`INSERT INTO canvas_participants (canvas_id, user_id, source, added_by_user_id, added_at) VALUES (?, ?, 'added', ?, 200)`, THREAD_PRIVATE, MEMBER, OWNER);
      seedCanvas(sql, THREAD_OTHER, "workspace", "Planning");
    });
    // A fact about the member, learned in the side room.
    expect(WorkspaceMemoryApplySweepResultSchema.parse(await workspace().applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: privateThread, fromSeq: 0, toSeq: 3,
      operations: [{ ...add("thread", "Member is interviewing elsewhere"), subjectKind: "person" as const, subjectId: MEMBER }],
      model: "test/model", inputTokens: null, outputTokens: null, factIds: ["fact-interviewing"],
      speakerIds: [MEMBER], candidateFactIds: [], now,
    }))).toMatchObject({ outcome: "applied", refused: [] });
    // The member's copy in the open thread holds it; the owner's copy in the
    // third thread never read it.
    const read = async (userId: string, workstreamId: string) => WorkspaceMemoryDigestResultSchema.parse(await workspace().memoryDigest({
      workspaceId: WORKSPACE_ID, reader: { kind: "person", userId },
      conversation: { parentKind: "canvas", parentId: workstreamId, substreamId: "0" }, now, limit: 10,
    })).facts.map((fact) => fact.factId);
    expect(await read(MEMBER, THREAD_OPEN)).toEqual(["fact-interviewing"]);
    expect(await read(OWNER, THREAD_OTHER)).toEqual([]);
    await runInDurableObject(workspace(), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DELETE FROM memory_digest_sync");
      sql.exec("DELETE FROM canvas_participants WHERE canvas_id = ? AND user_id = ?", THREAD_PRIVATE, MEMBER);
      expect(markedConversations(sql)).toEqual([`canvas:${THREAD_OPEN}`]);
    });
  });

  it("marks every holder when a member becomes a guest, and none for a revision that changed nothing they read", async () => {
    await fresh();
    await twoHolders(Date.parse("2026-10-19T09:00:00.000Z"));
    await runInDurableObject(workspace(), (_instance, state) => {
      const sql = state.storage.sql;
      const relationship = (accessClass: "member" | "guest", revision: number) => JSON.stringify({
        workspaceId: WORKSPACE_ID, userId: MEMBER, accessClass, role: "member", status: "active", incarnation: "i1", revision,
      });
      sql.exec("UPDATE workspace_member_status SET relationship_json = ? WHERE user_id = ?", relationship("member", 2), MEMBER);
      expect(markedConversations(sql)).toEqual([]);
      sql.exec("UPDATE workspace_member_status SET relationship_json = ? WHERE user_id = ?", relationship("guest", 3), MEMBER);
      expect(markedConversations(sql)).toEqual([`canvas:${THREAD_OPEN}`, `canvas:${THREAD_PRIVATE}`].sort());
    });
  });

  it("marks every holder when a source Canvas is deleted", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    await twoHolders(now);
    await runInDurableObject(workspace(), (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DELETE FROM canvas_directory WHERE canvas_id = ?", THREAD_PRIVATE);
      expect(markedConversations(sql)).toEqual([`canvas:${THREAD_OPEN}`, `canvas:${THREAD_PRIVATE}`].sort());
    });
  });

  it("drops the holder of a deleted Canvas when its row comes up, so it stops being marked", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    await workspace().memoryDigest({
      workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: MEMBER }, conversation: openThread, now, limit: 10,
    });
    await runInDurableObject(workspace(), (_instance, state) => {
      const sql = state.storage.sql;
      // The deletion marks the holder itself.
      sql.exec(`DELETE FROM canvas_directory WHERE canvas_id = ?`, THREAD_OPEN);
      expect(syncRow(sql)).toMatchObject([{ conversation: `canvas:${THREAD_OPEN}`, revision: 1 }]);
      expect(memoryDigestSyncWork(sql, { conversation: `canvas:${THREAD_OPEN}`, revision: 1 })).toBeNull();
      expect(syncRow(sql)).toEqual([]);
      expect(sql.exec("SELECT conversation FROM memory_digest_holders").toArray()).toEqual([]);
    });
  });
});
