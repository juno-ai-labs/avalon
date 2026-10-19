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
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { asWorkspaceId } from "@rally/contracts";

import { workspaceDOName } from "../src/durable-objects/names";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import {
  WorkspaceMemoryApplySweepResultSchema,
  WorkspaceMemoryRecallResultSchema,
  WorkspaceMemorySweepCandidatesResultSchema,
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

function workspace() {
  return env.WORKSPACE_DOS.get(env.WORKSPACE_DOS.idFromName(workspaceDOName("global", WORKSPACE_ID)));
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

describe("migration 115 on workerd", () => {
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
      for (const table of ["memory_facts", "memory_sweep_receipts", "memory_fact_receipts", "channel_viewers", "channels", "workspace_member_status"]) {
        sql.exec(`DELETE FROM ${table}`);
      }
      seedMember(sql, OWNER, "owner");
      seedMember(sql, MEMBER, "member");
      seedThread(sql, THREAD_OPEN, "workspace", "Launch", [OWNER, MEMBER]);
      seedThread(sql, THREAD_PRIVATE, "personal", "Owner's side room", [OWNER]);
    });
  }

  const openThread = { parentKind: "workstream" as const, parentId: THREAD_OPEN, substreamId: "0" };
  const privateThread = { parentKind: "workstream" as const, parentId: THREAD_PRIVATE, substreamId: "0" };

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
      model: "test/model", inputTokens: 10, outputTokens: 5, factIds: ["fact-release", "fact-codename"], now,
    }));
    expect(first).toEqual({
      outcome: "applied",
      receipt: { conversation: THREAD_OPEN, fromSeq: 0, toSeq: 12, appliedAt: now, operationCount: 2 },
      refused: [],
    });
    // A redelivery of the same range writes nothing and hands back the receipt.
    const replay = WorkspaceMemoryApplySweepResultSchema.parse(await workspace().applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: openThread, fromSeq: 0, toSeq: 12,
      operations: [add("thread", "A duplicate the replay must not write")],
      model: "test/model", inputTokens: 10, outputTokens: 5, factIds: ["fact-dup"], now: now + 1,
    }));
    expect(replay).toEqual({
      outcome: "already_applied",
      receipt: { conversation: THREAD_OPEN, fromSeq: 0, toSeq: 12, appliedAt: now, operationCount: 2 },
    });
    // A range starting past the store's cursor is a skipped sweep, not progress.
    expect(WorkspaceMemoryApplySweepResultSchema.parse(await workspace().applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: openThread, fromSeq: 40, toSeq: 50, operations: [],
      model: "test/model", inputTokens: null, outputTokens: null, factIds: [], now: now + 2,
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
      model: "test/model", inputTokens: null, outputTokens: null, factIds: ["fact-wide", "fact-room"], now,
    }));
    expect(applied).toMatchObject({ outcome: "applied", refused: [{ index: 0, code: "subject_above_placement" }] });
    await runInDurableObject(workspace(), (_instance, state) => {
      expect(state.storage.sql.exec<{ fact_id: string }>(`SELECT fact_id FROM memory_facts`).toArray()).toEqual([{ fact_id: "fact-room" }]);
    });
  });

  it("hands a sweep only the facts every current participant may open", async () => {
    await fresh();
    const now = Date.parse("2026-10-19T09:00:00.000Z");
    // An Organization fact learned in the owner's private room: promoted, but
    // sourced from a conversation the member cannot open.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE channels SET scope = 'workspace' WHERE workstream_id = ?`, THREAD_PRIVATE);
    });
    await workspace().applyMemorySweep({
      workspaceId: WORKSPACE_ID, conversation: privateThread, fromSeq: 0, toSeq: 3,
      operations: [add("organization", "Release day is Thursday")],
      model: "test/model", inputTokens: null, outputTokens: null, factIds: ["fact-release"], now,
    });
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE channels SET scope = 'personal' WHERE workstream_id = ?`, THREAD_PRIVATE);
    });
    const candidates = () => workspace().memorySweepCandidates({
      workspaceId: WORKSPACE_ID, conversation: openThread, terms: ["release", "thursday"], speakerIds: [OWNER, MEMBER], now, limit: 20,
    }).then((value) => WorkspaceMemorySweepCandidatesResultSchema.parse(value));
    // The open thread is read by every member, and a member who cannot open
    // the private room must not be handed its words through a candidate.
    expect(await candidates()).toMatchObject({ outcome: "ready", candidates: [] });
    // The recall a member makes from the open thread says the same thing.
    expect(WorkspaceMemoryRecallResultSchema.parse(await workspace().recallMemoryFacts({
      workspaceId: WORKSPACE_ID, reader: { kind: "person", userId: MEMBER }, conversation: openThread,
      query: "release day", now, limit: 10,
    })).facts).toEqual([]);
    // Once the private room is opened to every member, the fact follows.
    await runInDurableObject(workspace(), (_instance, state) => {
      state.storage.sql.exec(`UPDATE channels SET scope = 'workspace' WHERE workstream_id = ?`, THREAD_PRIVATE);
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
});
