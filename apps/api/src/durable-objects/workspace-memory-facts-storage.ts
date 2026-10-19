import type { SqlStorageValue } from "@cloudflare/workers-types";
import type { WorkspaceRelationship } from "@rally/contracts/scope-grants";

import { owningChannelAdmitsMember, sidekickAdmitsMember } from "../services/authorization-policy";
import {
  currentMemoryRevision,
  markMemoryDigestHoldersFor,
  nextMemoryRevision,
  recordMemoryDigestHolder,
} from "./memory-digest-sync";
import {
  admitsOrganizationWide,
  breakoutListedSql,
  channelListedSql,
  mainOpenableSql,
  spaceListedSql,
  type AccessClass,
} from "./listing-rules";
import { workspaceIdentityFencesFor } from "./workspace-domain-schema";
import {
  digestPrincipalKey,
  memoryConversationKeyOf,
  memorySourceOf,
  type MemoryConversation,
  type MemoryReviewScope,
  type MemoryDigestFact,
  type MemoryFact,
  type MemoryReader,
  type MemorySubjectKind,
  type MemorySweepPlacement,
  type MemorySweepRefusal,
  type WorkspaceMemoryApplySweepRequest,
  type WorkspaceMemoryApplySweepResult,
  type WorkspaceMemoryDigestRequest,
  type WorkspaceMemoryDigestResult,
  type WorkspaceMemoryForgetRequest,
  type WorkspaceMemoryForgetResult,
  type WorkspaceMemoryRecallRequest,
  type WorkspaceMemoryRecallResult,
  type WorkspaceMemoryRememberRequest,
  type WorkspaceMemoryRememberResult,
  type WorkspaceMemoryReviewForgetRequest,
  type WorkspaceMemoryReviewForgetResult,
  type WorkspaceMemoryReviewRequest,
  type WorkspaceMemoryReviewResult,
  type WorkspaceMemorySweepCandidatesRequest,
  type WorkspaceMemorySweepCandidatesResult,
} from "./workspace-memory-facts-protocol";

/**
 * The fact store behind agent memory, and the rules that decide who reads it.
 *
 * Three ideas, each its own function so the next reader can find the one that
 * moved:
 *
 * - **Sources.** Every fact carries the conversations it was learned from. A
 *   reader may see a fact only while they may open every one of those today
 *   (`openableSources`), which is how a conversation made private withdraws
 *   the facts promoted from it with no write.
 * - **Subjects.** The Organization's facts need a member; a Channel's need the
 *   Channel listed; a person's reach that person alone (`subjectAdmits`).
 * - **Audience.** Inside a conversation, a fact other people will read in the
 *   reply has to be one every current participant may open
 *   (`audienceMayOpen`); the acting person's own facts are exempt.
 *
 * Migration 116 creates the tables and imports the prose items of the retired
 * scoped-memory store. See `docs/agent-memory.md`.
 */

const inJsonList = (column: string, parameter = "?"): string =>
  `${column} IN (SELECT value FROM json_each(${parameter}))`;

/** Memory-domain SQL takes Unix milliseconds; the retired items carried ISO strings. */
const ISO_TO_MS = (column: string): string =>
  `CAST((julianday(${column}) - 2440587.5) * 86400000 AS INTEGER)`;

export const MEMORY_FACTS_MIGRATION: readonly string[] = [
  `CREATE TABLE memory_facts (
    fact_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    subject_kind TEXT NOT NULL CHECK (subject_kind IN ('organization', 'channel', 'thread', 'breakout', 'person', 'sidekick')),
    subject_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('standing', 'situational')),
    text TEXT NOT NULL,
    valid_from INTEGER CHECK (valid_from IS NULL OR valid_from >= 0),
    valid_until INTEGER CHECK (valid_until IS NULL OR valid_until >= 0),
    valid_until_basis TEXT CHECK (valid_until_basis IS NULL OR valid_until_basis IN ('stated', 'event', 'assumed')),
    derived_from TEXT NOT NULL CHECK (derived_from IN ('person', 'agent', 'external', 'mixed')),
    conflict INTEGER NOT NULL DEFAULT 0 CHECK (conflict IN (0, 1)),
    confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    evidence_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence_json)),
    source_conversations_json TEXT NOT NULL CHECK (json_valid(source_conversations_json) AND json_array_length(source_conversations_json) > 0),
    supersedes_fact_id TEXT,
    superseded_by_fact_id TEXT,
    retracted_at INTEGER CHECK (retracted_at IS NULL OR retracted_at >= 0),
    retracted_by TEXT,
    confirmed_at INTEGER CHECK (confirmed_at IS NULL OR confirmed_at >= 0),
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT`,
  `CREATE INDEX memory_facts_subject_idx
    ON memory_facts(subject_kind, subject_id, retracted_at, superseded_by_fact_id, updated_at DESC)`,
  ...workspaceIdentityFencesFor("memory_facts"),
  `CREATE VIRTUAL TABLE memory_facts_fts USING fts5(
    text, content = 'memory_facts', content_rowid = 'rowid', tokenize = 'unicode61'
  )`,
  `CREATE TRIGGER memory_facts_fts_insert AFTER INSERT ON memory_facts BEGIN
    INSERT INTO memory_facts_fts(rowid, text) VALUES (NEW.rowid, NEW.text); END`,
  `CREATE TRIGGER memory_facts_fts_delete AFTER DELETE ON memory_facts BEGIN
    INSERT INTO memory_facts_fts(memory_facts_fts, rowid, text) VALUES ('delete', OLD.rowid, OLD.text); END`,
  `CREATE TRIGGER memory_facts_fts_update AFTER UPDATE OF text ON memory_facts BEGIN
    INSERT INTO memory_facts_fts(memory_facts_fts, rowid, text) VALUES ('delete', OLD.rowid, OLD.text);
    INSERT INTO memory_facts_fts(rowid, text) VALUES (NEW.rowid, NEW.text); END`,
  // One row per conversation (keyed by `memoryConversationKeyOf`, so a Sidekick's
  // runs do not share its own conversation's row): the range the last sweep
  // applied. `applySweep` compares a delivery's `fromSeq` with `to_seq` to
  // tell a replay from a gap.
  `CREATE TABLE memory_sweep_receipts (
    conversation TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    from_seq INTEGER NOT NULL CHECK (from_seq >= 0),
    to_seq INTEGER NOT NULL CHECK (to_seq >= from_seq),
    operations_json TEXT NOT NULL CHECK (json_valid(operations_json)),
    model TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER,
    applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
  ) STRICT`,
  ...workspaceIdentityFencesFor("memory_sweep_receipts"),
  // The tool writes' replay receipts, keyed by the harness's provider
  // idempotency key: a retried `memory_remember` answers with its first result.
  `CREATE TABLE memory_fact_receipts (
    receipt_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    harness_run_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('remember', 'forget')),
    result_json TEXT NOT NULL CHECK (json_valid(result_json)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0)
  ) STRICT`,
  ...workspaceIdentityFencesFor("memory_fact_receipts"),
  // The import. Every live item of the retired store becomes a standing fact
  // the agent recorded; the scope kind says what it is about, and the
  // provenance's thread, the owner's Personal Channel, or General says where
  // it was learned. An item whose source cannot be named (a `user` item whose
  // owner was never seated and an Organization with no General yet) is not
  // imported; docs/agent-memory.md#import records the rule.
  `INSERT INTO memory_facts (
     fact_id, workspace_id, subject_kind, subject_id, kind, text,
     valid_from, valid_until, valid_until_basis, derived_from, conflict, confidence,
     evidence_json, source_conversations_json, supersedes_fact_id, superseded_by_fact_id,
     retracted_at, retracted_by, confirmed_at, created_by, created_at, updated_at)
   SELECT
     item.memory_item_id, item.workspace_id,
     CASE scope.kind
       WHEN 'user' THEN 'person'
       WHEN 'sidekick' THEN 'sidekick'
       WHEN 'workspace' THEN 'organization'
       WHEN 'workstream' THEN CASE WHEN sidekick_owner.automation_id IS NOT NULL THEN 'sidekick' ELSE 'thread' END
     END,
     scope.owner_id,
     'standing', item.text,
     NULL,
     CASE WHEN item.expires_at IS NULL THEN NULL ELSE ${ISO_TO_MS("item.expires_at")} END,
     CASE WHEN item.expires_at IS NULL THEN NULL ELSE 'stated' END,
     'agent', 0, NULL,
     '[]',
     json_array(
       CASE scope.kind
         WHEN 'user' THEN COALESCE(provenance_thread.workstream_id,
                                   CASE WHEN personal.space_id IS NULL THEN NULL ELSE 'space:' || personal.space_id END,
                                   CASE WHEN general.space_id IS NULL THEN NULL ELSE 'space:' || general.space_id END)
         WHEN 'workstream' THEN CASE WHEN thread_owner.workstream_id IS NOT NULL THEN thread_owner.workstream_id
                                     WHEN sidekick_owner.automation_id IS NOT NULL THEN 'sidekick:' || sidekick_owner.automation_id END
         WHEN 'sidekick' THEN 'sidekick:' || scope.owner_id
         WHEN 'workspace' THEN COALESCE(provenance_thread.workstream_id,
                                        CASE WHEN general.space_id IS NULL THEN NULL ELSE 'space:' || general.space_id END)
       END),
     NULL, NULL, NULL, NULL, NULL,
     'import',
     ${ISO_TO_MS("item.created_at")},
     ${ISO_TO_MS("item.updated_at")}
   FROM memory_items item
   JOIN memory_scopes scope ON scope.memory_scope_id = item.memory_scope_id
   LEFT JOIN channels provenance_thread
     ON provenance_thread.workstream_id = json_extract(item.provenance_json, '$.workstreamId')
   LEFT JOIN channels thread_owner
     ON scope.kind = 'workstream' AND thread_owner.workstream_id = scope.owner_id
   LEFT JOIN automation_directory sidekick_owner
     ON scope.kind = 'workstream' AND sidekick_owner.automation_id = scope.owner_id
   LEFT JOIN spaces personal
     ON scope.kind = 'user' AND personal.scope = 'individual' AND personal.created_by_user_id = scope.owner_id
   LEFT JOIN spaces general ON general.system_role = 'general'
   WHERE item.invalidated_at IS NULL
     AND (item.expires_at IS NULL OR ${ISO_TO_MS("item.expires_at")} > ${ISO_TO_MS("'now'")})
     AND CASE scope.kind
           WHEN 'user' THEN COALESCE(provenance_thread.workstream_id, personal.space_id, general.space_id)
           WHEN 'workstream' THEN COALESCE(thread_owner.workstream_id, sidekick_owner.automation_id)
           WHEN 'sidekick' THEN scope.owner_id
           WHEN 'workspace' THEN COALESCE(provenance_thread.workstream_id, general.space_id)
         END IS NOT NULL`,
  // Children first: `memory_mutations` and `memory_index_outbox` reference
  // `memory_items`, and the FTS shadow has to go before its content table.
  `DROP TABLE memory_index_outbox`,
  `DROP TABLE memory_mutations`,
  `DROP TABLE memory_items_fts`,
  `DROP TABLE memory_items`,
  // Migration 23 queued a `memory_index` maintenance task on every object; the
  // task no longer exists, and a drain that reached the row before the next
  // reconcile would throw `unknown_workspace_maintenance_task`.
  `DELETE FROM _internal_durable_alarms WHERE kind = 'maintenance' AND alarm_key = 'memory_index'`,
];

// -- Rows ---------------------------------------------------------------------

interface FactRow extends Record<string, SqlStorageValue> {
  fact_id: string;
  subject_kind: MemorySubjectKind;
  subject_id: string;
  kind: "standing" | "situational";
  text: string;
  valid_from: number | null;
  valid_until: number | null;
  valid_until_basis: "stated" | "event" | "assumed" | null;
  derived_from: MemoryFact["derivedFrom"];
  conflict: number;
  confidence: number | null;
  evidence_json: string;
  source_conversations_json: string;
  supersedes_fact_id: string | null;
  superseded_by_fact_id: string | null;
  retracted_at: number | null;
  confirmed_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

/** Qualified, because the FTS shadow table joined for a search carries a `text` column too. */
const FACT_COLUMNS = `fact.fact_id, fact.subject_kind, fact.subject_id, fact.kind, fact.text, fact.valid_from,
  fact.valid_until, fact.valid_until_basis, fact.derived_from, fact.conflict, fact.confidence, fact.evidence_json,
  fact.source_conversations_json, fact.supersedes_fact_id, fact.superseded_by_fact_id, fact.retracted_at,
  fact.confirmed_at, fact.created_by, fact.created_at, fact.updated_at`;

function factFromRow(row: FactRow): MemoryFact {
  return {
    factId: row.fact_id,
    subjectKind: row.subject_kind,
    subjectId: row.subject_id,
    kind: row.kind,
    text: row.text,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    validUntilBasis: row.valid_until_basis,
    derivedFrom: row.derived_from,
    conflict: row.conflict === 1,
    confidence: row.confidence,
    evidence: JSON.parse(row.evidence_json) as number[],
    sourceConversations: JSON.parse(row.source_conversations_json) as string[],
    supersedesFactId: row.supersedes_fact_id,
    supersededByFactId: row.superseded_by_fact_id,
    retractedAt: row.retracted_at,
    confirmedAt: row.confirmed_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** A fact that is still in force: not retracted, not superseded, and not past its horizon. */
const ACTIVE = (alias: string, now = "?"): string =>
  `${alias}.retracted_at IS NULL AND ${alias}.superseded_by_fact_id IS NULL
   AND (${alias}.valid_until IS NULL OR ${alias}.valid_until > ${now})`;

function subjectKey(kind: MemorySubjectKind, id: string): string {
  return `${kind}:${id}`;
}

function conversationSubject(conversation: MemoryConversation): { kind: MemorySubjectKind; id: string } {
  switch (conversation.parentKind) {
    case "workstream":
      return conversation.substreamId === "0"
        ? { kind: "thread", id: conversation.parentId }
        : { kind: "breakout", id: `${conversation.parentId}/${conversation.substreamId}` };
    case "automation":
      return { kind: "sidekick", id: conversation.parentId };
    case "space":
      return { kind: "channel", id: conversation.parentId };
  }
}

// -- Sources ------------------------------------------------------------------

type ParsedSource =
  | { kind: "thread"; workstreamId: string }
  | { kind: "breakout"; workstreamId: string; substreamId: string }
  | { kind: "space"; spaceId: string }
  | { kind: "sidekick"; automationId: string };

export function parseMemorySource(source: string): ParsedSource {
  if (source.startsWith("sidekick:")) return { kind: "sidekick", automationId: source.slice("sidekick:".length) };
  if (source.startsWith("space:")) return { kind: "space", spaceId: source.slice("space:".length) };
  const slash = source.indexOf("/");
  if (slash > 0) return { kind: "breakout", workstreamId: source.slice(0, slash), substreamId: source.slice(slash + 1) };
  return { kind: "thread", workstreamId: source };
}

interface SidekickRow extends Record<string, SqlStorageValue> {
  automation_id: string;
  scope: string;
  title: string;
  author_user_id: string;
  run_as_user_id: string | null;
  owning_workstream_id: string | null;
  owning_substream_id: string;
}

function sidekickRows(sql: SqlStorage, automationIds: readonly string[]): SidekickRow[] {
  if (automationIds.length === 0) return [];
  return sql.exec<SidekickRow>(
    `SELECT automation_id, scope, title, author_user_id, run_as_user_id, owning_workstream_id, owning_substream_id
       FROM automation_directory
      WHERE lifecycle <> 'deleted' AND ${inJsonList("automation_id")}`,
    JSON.stringify(automationIds),
  ).toArray();
}

function homeSourceOf(row: SidekickRow): string | null {
  if (!row.owning_workstream_id) return null;
  return row.owning_substream_id === "0"
    ? row.owning_workstream_id
    : `${row.owning_workstream_id}/${row.owning_substream_id}`;
}

/** A person as the object knows them: an active member or guest, or nobody. */
export interface ResolvedPerson {
  kind: "person";
  userId: string;
  accessClass: AccessClass;
  administrator: boolean;
}

export interface ResolvedSidekick {
  kind: "sidekick";
  automationId: string;
  /** `null` when the Sidekick is gone, which reads as nothing. */
  row: SidekickRow | null;
}

/** The conversation itself as the reader: what every current participant may open. */
export interface ResolvedConversation {
  kind: "conversation";
  audience: Audience;
}

export type ResolvedReader = ResolvedPerson | ResolvedSidekick | ResolvedConversation;

/**
 * A person's relationship does not depend on where they stand, so the review
 * surface resolves them with no conversation; the conversation reader is
 * nobody without one.
 */
export function resolveReader(
  sql: SqlStorage,
  reader: MemoryReader,
  relationship: WorkspaceRelationship | null,
  conversation: MemoryConversation | null,
): ResolvedReader | null {
  if (reader.kind === "sidekick") {
    return { kind: "sidekick", automationId: reader.automationId, row: sidekickRows(sql, [reader.automationId])[0] ?? null };
  }
  if (reader.kind === "conversation") {
    if (conversation === null) return null;
    const audience = conversationAudience(sql, conversation);
    return audience ? { kind: "conversation", audience } : null;
  }
  if (relationship?.status !== "active") return null;
  return {
    kind: "person",
    userId: reader.userId,
    accessClass: relationship.accessClass,
    administrator: relationship.role === "owner" || relationship.role === "admin",
  };
}

/**
 * Which of `sources` this person may open today, in four batched reads: one
 * per source kind, each over a JSON list, never one query per fact.
 */
function openableByPerson(sql: SqlStorage, person: ResolvedPerson, sources: ReadonlySet<string>): Set<string> {
  const open = new Set<string>();
  const threads: string[] = [];
  const breakouts: string[] = [];
  const spaces: string[] = [];
  const sidekicks: string[] = [];
  for (const source of sources) {
    const parsed = parseMemorySource(source);
    if (parsed.kind === "thread") threads.push(parsed.workstreamId);
    else if (parsed.kind === "breakout") breakouts.push(source);
    else if (parsed.kind === "space") spaces.push(parsed.spaceId);
    else sidekicks.push(parsed.automationId);
  }
  if (threads.length > 0) {
    for (const row of sql.exec<{ workstream_id: string }>(
      `SELECT directory.workstream_id FROM channels directory
         LEFT JOIN channel_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?1
          AND viewer.authority_generation = directory.authority_generation
        WHERE ${inJsonList("directory.workstream_id", "?2")} AND directory.archived_at IS NULL
          AND ${mainOpenableSql("directory", "viewer", person.accessClass)}`,
      person.userId, JSON.stringify(threads),
    ).toArray()) open.add(row.workstream_id);
  }
  if (breakouts.length > 0) {
    for (const row of sql.exec<{ source: string }>(
      `SELECT breakout.workstream_id || '/' || breakout.substream_id AS source FROM breakouts breakout
         JOIN channels directory ON directory.workstream_id = breakout.workstream_id
         LEFT JOIN channel_viewers viewer
           ON viewer.workstream_id = directory.workstream_id
          AND viewer.user_id = ?1
          AND viewer.authority_generation = directory.authority_generation
         LEFT JOIN breakout_viewers breakout_viewer
           ON breakout_viewer.workstream_id = breakout.workstream_id
          AND breakout_viewer.substream_id = breakout.substream_id
          AND breakout_viewer.user_id = ?1
          AND breakout_viewer.authority_generation = breakout.authority_generation
        WHERE ${inJsonList("breakout.workstream_id || '/' || breakout.substream_id", "?2")}
          AND breakout.archived_at IS NULL AND directory.archived_at IS NULL
          AND ${channelListedSql("directory", "viewer", person.accessClass, { breakouts: true, userId: "?1" })}
          AND ${breakoutListedSql("breakout", "breakout_viewer", person.accessClass)}`,
      person.userId, JSON.stringify(breakouts),
    ).toArray()) open.add(row.source);
  }
  if (spaces.length > 0) {
    for (const row of sql.exec<{ space_id: string }>(
      `SELECT space.space_id FROM spaces space
         LEFT JOIN space_viewers viewer
           ON viewer.space_id = space.space_id AND viewer.user_id = ?1 AND viewer.is_participant = 1
        WHERE ${inJsonList("space.space_id", "?2")} AND space.archived_at IS NULL
          AND ${spaceListedSql("space", "viewer", person.accessClass, { breakouts: true, userId: "?1" })}`,
      person.userId, JSON.stringify(spaces),
    ).toArray()) open.add(`space:${row.space_id}`);
  }
  if (sidekicks.length > 0) {
    const member = admitsOrganizationWide(person.accessClass);
    const rows = sidekickRows(sql, sidekicks);
    // A Channel-owned Sidekick is read through its home: a Thread home needs
    // this member to be its participant (`owningChannelAdmitsMember`), a
    // Breakout home needs the Breakout open to them. Asked once for every home.
    const breakoutHomes = new Set<string>();
    const threadHomes: string[] = [];
    for (const row of rows) {
      const home = homeSourceOf(row);
      if (row.scope !== "workstream" || home === null) continue;
      if (home.includes("/")) breakoutHomes.add(home); else threadHomes.push(home);
    }
    const openBreakoutHomes = breakoutHomes.size > 0 ? openableByPerson(sql, person, breakoutHomes) : new Set<string>();
    const participantThreadHomes = new Set<string>();
    if (threadHomes.length > 0 && member) {
      for (const row of sql.exec<{ workstream_id: string }>(
        `SELECT directory.workstream_id FROM channels directory
           JOIN channel_viewers viewer
             ON viewer.workstream_id = directory.workstream_id
            AND viewer.user_id = ?1
            AND viewer.authority_generation = directory.authority_generation
          WHERE ${inJsonList("directory.workstream_id", "?2")} AND directory.archived_at IS NULL
            AND viewer.is_participant = 1`,
        person.userId, JSON.stringify(threadHomes),
      ).toArray()) participantThreadHomes.add(row.workstream_id);
    }
    for (const row of rows) {
      const home = homeSourceOf(row);
      const readable = member && sidekickAdmitsMember({
        scope: row.scope,
        author: row.author_user_id === person.userId,
        executor: row.run_as_user_id === person.userId,
      });
      const throughHome = row.scope === "workstream" && home !== null
        && (home.includes("/")
          ? openBreakoutHomes.has(home)
          : member && owningChannelAdmitsMember({ archived: false, participant: participantThreadHomes.has(home) }));
      if (readable || throughHome) open.add(`sidekick:${row.automation_id}`);
    }
  }
  return open;
}

/** What a Sidekick may open: itself and its home conversation. */
function openableBySidekick(sidekick: ResolvedSidekick, sources: ReadonlySet<string>): Set<string> {
  const open = new Set<string>();
  if (!sidekick.row) return open;
  const own = `sidekick:${sidekick.automationId}`;
  const home = homeSourceOf(sidekick.row);
  for (const source of sources) {
    if (source === own || source === home) open.add(source);
  }
  return open;
}

/** Sources open to every member of the Organization: the audience of an Organization-wide conversation. */
function openableByEveryMember(sql: SqlStorage, sources: ReadonlySet<string>): Set<string> {
  const open = new Set<string>();
  const threads: string[] = [];
  const breakouts: string[] = [];
  const spaces: string[] = [];
  const sidekicks: string[] = [];
  for (const source of sources) {
    const parsed = parseMemorySource(source);
    if (parsed.kind === "thread") threads.push(parsed.workstreamId);
    else if (parsed.kind === "breakout") breakouts.push(source);
    else if (parsed.kind === "space") spaces.push(parsed.spaceId);
    else sidekicks.push(parsed.automationId);
  }
  if (threads.length > 0) {
    for (const row of sql.exec<{ workstream_id: string }>(
      `SELECT workstream_id FROM channels
        WHERE ${inJsonList("workstream_id")} AND archived_at IS NULL AND scope = 'workspace'`,
      JSON.stringify(threads),
    ).toArray()) open.add(row.workstream_id);
  }
  if (breakouts.length > 0) {
    for (const row of sql.exec<{ source: string }>(
      `SELECT breakout.workstream_id || '/' || breakout.substream_id AS source FROM breakouts breakout
         JOIN channels directory ON directory.workstream_id = breakout.workstream_id
        WHERE ${inJsonList("breakout.workstream_id || '/' || breakout.substream_id")}
          AND breakout.archived_at IS NULL AND directory.archived_at IS NULL
          AND breakout.scope = 'workspace' AND directory.scope = 'workspace'`,
      JSON.stringify(breakouts),
    ).toArray()) open.add(row.source);
  }
  if (spaces.length > 0) {
    for (const row of sql.exec<{ space_id: string }>(
      `SELECT space_id FROM spaces WHERE ${inJsonList("space_id")} AND archived_at IS NULL AND scope = 'workspace'`,
      JSON.stringify(spaces),
    ).toArray()) open.add(`space:${row.space_id}`);
  }
  for (const row of sidekickRows(sql, sidekicks)) {
    if (row.scope === "workspace") open.add(`sidekick:${row.automation_id}`);
  }
  return open;
}

function openableBy(sql: SqlStorage, reader: ResolvedReader, sources: ReadonlySet<string>): Set<string> {
  switch (reader.kind) {
    case "person": return openableByPerson(sql, reader, sources);
    case "sidekick": return openableBySidekick(reader, sources);
    case "conversation": return sourcesOpenToAudience(sql, reader.audience, sources);
  }
}

function sourcesOf(facts: readonly MemoryFact[]): Set<string> {
  const sources = new Set<string>();
  for (const fact of facts) for (const source of fact.sourceConversations) sources.add(source);
  return sources;
}

function everySourceIn(fact: MemoryFact, open: ReadonlySet<string>): boolean {
  return fact.sourceConversations.every((source) => open.has(source));
}

// -- Audience -----------------------------------------------------------------

/** Who reads a conversation today: every member, a list of people, or a Sidekick alone. */
type Audience =
  | { kind: "members" }
  | { kind: "people"; userIds: string[] }
  | { kind: "sidekick"; automationId: string };

function threadAudience(sql: SqlStorage, workstreamId: string): Audience | null {
  const thread = sql.exec<{ scope: string; authority_generation: number; archived_at: number | null }>(
    `SELECT scope, authority_generation, archived_at FROM channels WHERE workstream_id = ?`, workstreamId,
  ).toArray()[0];
  if (!thread || thread.archived_at !== null) return null;
  if (thread.scope === "workspace") return { kind: "members" };
  return {
    kind: "people",
    userIds: sql.exec<{ user_id: string }>(
      `SELECT user_id FROM channel_viewers
        WHERE workstream_id = ? AND authority_generation = ? AND is_participant = 1`,
      workstreamId, thread.authority_generation,
    ).toArray().map((row) => row.user_id),
  };
}

function conversationAudience(sql: SqlStorage, conversation: MemoryConversation): Audience | null {
  switch (conversation.parentKind) {
    case "workstream": {
      if (conversation.substreamId === "0") return threadAudience(sql, conversation.parentId);
      const breakout = sql.exec<{ scope: string; authority_generation: number; archived_at: number | null }>(
        `SELECT scope, authority_generation, archived_at FROM breakouts WHERE workstream_id = ? AND substream_id = ?`,
        conversation.parentId, conversation.substreamId,
      ).toArray()[0];
      if (!breakout || breakout.archived_at !== null) return null;
      // An Organization-wide Breakout inherits its Thread's audience.
      if (breakout.scope === "workspace") return threadAudience(sql, conversation.parentId);
      return {
        kind: "people",
        userIds: sql.exec<{ user_id: string }>(
          `SELECT user_id FROM breakout_viewers
            WHERE workstream_id = ? AND substream_id = ? AND authority_generation = ? AND is_participant = 1`,
          conversation.parentId, conversation.substreamId, breakout.authority_generation,
        ).toArray().map((row) => row.user_id),
      };
    }
    case "automation":
      return sidekickRows(sql, [conversation.parentId]).length === 1
        ? { kind: "sidekick", automationId: conversation.parentId }
        : null;
    case "space": {
      const space = sql.exec<{ scope: string; archived_at: number | null }>(
        `SELECT scope, archived_at FROM spaces WHERE space_id = ?`, conversation.parentId,
      ).toArray()[0];
      if (!space || space.archived_at !== null) return null;
      if (space.scope === "workspace") return { kind: "members" };
      return {
        kind: "people",
        userIds: sql.exec<{ user_id: string }>(
          `SELECT user_id FROM space_viewers WHERE space_id = ? AND is_participant = 1`, conversation.parentId,
        ).toArray().map((row) => row.user_id),
      };
    }
  }
}

function relationshipsOf(sql: SqlStorage, userIds: readonly string[]): Map<string, ResolvedPerson> {
  const people = new Map<string, ResolvedPerson>();
  if (userIds.length === 0) return people;
  for (const row of sql.exec<{ user_id: string; access_class: string | null; role: string | null }>(
    `SELECT user_id, json_extract(relationship_json, '$.accessClass') AS access_class,
            json_extract(relationship_json, '$.role') AS role
       FROM workspace_member_status WHERE active = 1 AND ${inJsonList("user_id")}`,
    JSON.stringify(userIds),
  ).toArray()) {
    people.set(row.user_id, {
      kind: "person",
      userId: row.user_id,
      accessClass: row.access_class === "guest" ? "guest" : "member",
      administrator: row.role === "owner" || row.role === "admin",
    });
  }
  return people;
}

/**
 * The sources every current participant of the conversation may open. For an
 * Organization-wide conversation that is every member, answered structurally
 * rather than one member at a time.
 */
function sourcesOpenToAudience(sql: SqlStorage, audience: Audience, sources: ReadonlySet<string>): Set<string> {
  if (audience.kind === "members") return openableByEveryMember(sql, sources);
  if (audience.kind === "sidekick") {
    const sidekick: ResolvedSidekick = {
      kind: "sidekick", automationId: audience.automationId, row: sidekickRows(sql, [audience.automationId])[0] ?? null,
    };
    return openableBySidekick(sidekick, sources);
  }
  const people = relationshipsOf(sql, audience.userIds);
  let open: Set<string> | null = null;
  for (const person of people.values()) {
    const theirs = openableByPerson(sql, person, sources);
    if (open === null) {
      open = theirs;
      continue;
    }
    const shared: Set<string> = open;
    open = new Set<string>([...shared].filter((source) => theirs.has(source)));
  }
  return open ?? new Set<string>();
}

// -- Subjects -----------------------------------------------------------------

interface SubjectSet {
  keys: string[];
  /** The Channels the conversation sits in, for the Channel-fact predicate and the sweep placement. */
  channels: Array<{ id: string; title: string }>;
}

function channelsOfThread(sql: SqlStorage, workstreamId: string): Array<{ id: string; title: string }> {
  return sql.exec<{ space_id: string; title: string }>(
    `SELECT space.space_id, space.title FROM space_channel_memberships placement
       JOIN spaces space ON space.space_id = placement.space_id
      WHERE placement.workstream_id = ? AND placement.state = 'active' AND space.archived_at IS NULL
      ORDER BY space.space_id`,
    workstreamId,
  ).toArray().map((row) => ({ id: row.space_id, title: row.title }));
}

/** The subjects a conversation reads: itself, its Thread, its Channels, the Organization. */
function conversationSubjects(sql: SqlStorage, workspaceId: string, conversation: MemoryConversation): SubjectSet {
  const keys = [subjectKey("organization", workspaceId)];
  let channels: Array<{ id: string; title: string }> = [];
  switch (conversation.parentKind) {
    case "workstream": {
      keys.push(subjectKey("thread", conversation.parentId));
      if (conversation.substreamId !== "0") {
        keys.push(subjectKey("breakout", `${conversation.parentId}/${conversation.substreamId}`));
      }
      channels = channelsOfThread(sql, conversation.parentId);
      break;
    }
    case "automation": {
      keys.push(subjectKey("sidekick", conversation.parentId));
      const row = sidekickRows(sql, [conversation.parentId])[0];
      if (row?.owning_workstream_id) {
        keys.push(subjectKey("thread", row.owning_workstream_id));
        if (row.owning_substream_id !== "0") {
          keys.push(subjectKey("breakout", `${row.owning_workstream_id}/${row.owning_substream_id}`));
        }
        channels = channelsOfThread(sql, row.owning_workstream_id);
      }
      break;
    }
    case "space":
      channels = sql.exec<{ space_id: string; title: string }>(
        `SELECT space_id, title FROM spaces WHERE space_id = ? AND archived_at IS NULL`, conversation.parentId,
      ).toArray().map((row) => ({ id: row.space_id, title: row.title }));
      break;
  }
  for (const channel of channels) keys.push(subjectKey("channel", channel.id));
  return { keys, channels };
}

/** Organization facts reach members, workspace-scoped Sidekicks, and conversations every member reads. */
function readsOrganizationFacts(reader: ResolvedReader): boolean {
  switch (reader.kind) {
    case "person": return admitsOrganizationWide(reader.accessClass);
    case "sidekick": return reader.row?.scope === "workspace";
    case "conversation": return reader.audience.kind === "members";
  }
}

/** The subject half of visibility; `channelsOpen` is the reader's answer for `space:<id>` sources. */
function subjectAdmits(
  reader: ResolvedReader,
  fact: MemoryFact,
  channelsOpen: ReadonlySet<string>,
): boolean {
  switch (fact.subjectKind) {
    case "organization":
      return readsOrganizationFacts(reader);
    case "channel":
      return channelsOpen.has(`space:${fact.subjectId}`);
    case "person":
      return reader.kind === "person" && fact.subjectId === reader.userId;
    case "thread":
    case "breakout":
    case "sidekick":
      return true;
  }
}

/**
 * The subject half for a sweep: the placement that bounds what a conversation
 * may file also bounds what its sweep may be shown or touch. `organization`
 * needs an Organization-wide conversation, `channel` a Channel every
 * participant may list, `person` one of the placement's own speakers.
 */
function sweepAdmits(placement: MemorySweepPlacement, fact: MemoryFact, channelsOpen: ReadonlySet<string>): boolean {
  switch (fact.subjectKind) {
    case "organization":
      return placement.organizationWide;
    case "channel":
      return channelsOpen.has(`space:${fact.subjectId}`);
    case "person":
      return placement.people.some((person) => person.id === fact.subjectId);
    case "thread":
    case "breakout":
    case "sidekick":
      return true;
  }
}

/**
 * The facts among `facts` a sweep of the conversation at `here` may be handed
 * or may touch: every source open to every current participant, and the
 * subject admitted by the placement. The first fence of §6.
 */
function sweepVisibleFacts(
  sql: SqlStorage,
  placed: { placement: MemorySweepPlacement; audience: Audience },
  here: string,
  facts: readonly MemoryFact[],
): MemoryFact[] {
  if (facts.length === 0) return [];
  const sources = sourcesOf(facts);
  for (const fact of facts) if (fact.subjectKind === "channel") sources.add(`space:${fact.subjectId}`);
  sources.delete(here);
  const open = sourcesOpenToAudience(sql, placed.audience, sources);
  open.add(here);
  return facts.filter((fact) => everySourceIn(fact, open) && sweepAdmits(placed.placement, fact, open));
}

/**
 * The facts among `facts` this reader may see from inside `conversation`:
 * every source openable, the subject admitting them, and, for every fact but
 * their own, every current participant able to open it too. With no
 * conversation (the review surface) there is no audience, so the first two
 * halves are the whole rule.
 */
function visibleFacts(
  sql: SqlStorage,
  reader: ResolvedReader,
  conversation: MemoryConversation | null,
  facts: readonly MemoryFact[],
): MemoryFact[] {
  if (facts.length === 0) return [];
  const sources = sourcesOf(facts);
  for (const fact of facts) if (fact.subjectKind === "channel") sources.add(`space:${fact.subjectId}`);
  const open = openableBy(sql, reader, sources);
  const own = facts.filter((fact) => everySourceIn(fact, open) && subjectAdmits(reader, fact, open));
  const shared = own.filter((fact) => !(reader.kind === "person" && fact.subjectKind === "person"));
  if (shared.length === 0 || conversation === null) return own;
  const audience = conversationAudience(sql, conversation);
  if (!audience) return own.filter((fact) => !shared.includes(fact));
  const audienceOpen = sourcesOpenToAudience(sql, audience, sourcesOf(shared));
  return own.filter((fact) => !shared.includes(fact) || everySourceIn(fact, audienceOpen));
}

// -- Reads --------------------------------------------------------------------

/**
 * An FTS5 expression from plain words: each token quoted, joined with OR, so
 * a query never reaches the FTS parser's own syntax. Null when nothing is left.
 */
export function memoryFtsMatch(words: readonly string[]): string | null {
  const tokens = new Set<string>();
  for (const word of words) {
    for (const token of word.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (token.length >= 2) tokens.add(token);
      if (tokens.size >= 48) break;
    }
  }
  if (tokens.size === 0) return null;
  return [...tokens].map((token) => `"${token}"`).join(" OR ");
}

/**
 * Active facts on the subjects, best match first for an FTS `match`, newest
 * first without one. `excludeExternal` leaves out facts derived from external
 * evidence before the limit, for the digest, which never renders them.
 */
function activeFactsOn(
  sql: SqlStorage,
  subjectKeys: readonly string[],
  now: number,
  limit: number,
  match: string | null,
  excludeExternal = false,
): MemoryFact[] {
  if (subjectKeys.length === 0) return [];
  const keyed = `(fact.subject_kind || ':' || fact.subject_id) IN (SELECT value FROM json_each(?))${
    excludeExternal ? " AND fact.derived_from <> 'external'" : ""}`;
  const rows = match === null
    ? sql.exec<FactRow>(
      `SELECT ${FACT_COLUMNS} FROM memory_facts fact
        WHERE ${keyed} AND ${ACTIVE("fact")}
        ORDER BY fact.updated_at DESC LIMIT ?`,
      JSON.stringify(subjectKeys), now, limit,
    ).toArray()
    : sql.exec<FactRow>(
      `SELECT ${FACT_COLUMNS} FROM memory_facts_fts
         JOIN memory_facts fact ON fact.rowid = memory_facts_fts.rowid
        WHERE memory_facts_fts MATCH ? AND ${keyed} AND ${ACTIVE("fact")}
        ORDER BY memory_facts_fts.rank LIMIT ?`,
      match, JSON.stringify(subjectKeys), now, limit,
    ).toArray();
  return rows.map(factFromRow);
}

function factById(sql: SqlStorage, factId: string): MemoryFact | null {
  const row = sql.exec<FactRow>(`SELECT ${FACT_COLUMNS} FROM memory_facts fact WHERE fact_id = ?`, factId).toArray()[0];
  return row ? factFromRow(row) : null;
}

/**
 * The facts this reader may see from inside the conversation, on its
 * subjects: best match first for an FTS `match`, newest first without one.
 * Recall and the digest both read through here, so the two cannot disagree on
 * who sees what.
 */
function readableFacts(
  sql: SqlStorage,
  request: Pick<WorkspaceMemoryRecallRequest, "workspaceId" | "reader" | "conversation" | "now" | "limit">,
  match: string | null,
  relationship: WorkspaceRelationship | null,
  excludeExternal = false,
): MemoryFact[] {
  const reader = resolveReader(sql, request.reader, relationship, request.conversation);
  if (!reader) return [];
  const subjects = conversationSubjects(sql, request.workspaceId, request.conversation);
  if (reader.kind === "person") subjects.keys.push(subjectKey("person", reader.userId));
  // Over-read so the visibility filter below still fills the page.
  const candidates = activeFactsOn(sql, subjects.keys, request.now, request.limit * 4, match, excludeExternal);
  return visibleFacts(sql, reader, request.conversation, candidates).slice(0, request.limit);
}

export function recallMemoryFacts(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryRecallRequest,
  relationship: WorkspaceRelationship | null,
): WorkspaceMemoryRecallResult {
  const sql = storage.sql;
  const match = request.query === null ? null : memoryFtsMatch([request.query]);
  const facts = readableFacts(sql, request, match, relationship);
  return { facts, titles: titlesFor(sql, facts) };
}

/**
 * What one principal's digest copy in this conversation is refreshed from:
 * recall with no query, newest first, `external` facts left out before the
 * limit (the digest never renders them), each fact cut to what the renderer
 * needs and its subject named, stamped with `memory_revision`. The
 * conversation is recorded as a holder of these facts in the same
 * transaction, so a change that withdraws one can reach this copy through the
 * copy-sync lane (`memory-digest-sync.ts`).
 */
export function memoryDigestFacts(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryDigestRequest,
  relationship: WorkspaceRelationship | null,
): WorkspaceMemoryDigestResult {
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const revision = currentMemoryRevision(sql);
    const facts = readableFacts(sql, request, null, relationship, true);
    const titles = new Map(titlesFor(sql, facts).map((entry) => [entry.key, entry.title]));
    recordMemoryDigestHolder(sql, {
      conversation: request.conversation,
      principal: digestPrincipalKey(request.reader),
      factIds: facts.map((fact) => fact.factId),
      now: Date.now(),
    });
    return {
      facts: facts.map((fact): MemoryDigestFact => ({
        factId: fact.factId,
        subjectKind: fact.subjectKind,
        // The Organization needs no name, and a person fact reaches only
        // the person it is about.
        subjectLabel: fact.subjectKind === "organization" || fact.subjectKind === "person"
          ? null
          : titles.get(subjectKey(fact.subjectKind, fact.subjectId)) ?? null,
        kind: fact.kind,
        text: fact.text,
        validFrom: fact.validFrom,
        validUntil: fact.validUntil,
        conflict: fact.conflict,
        derivedFrom: fact.derivedFrom,
        createdAt: fact.createdAt,
      })),
      revision,
    };
  });
}

/** Display titles for the subjects and sources of `facts`, read in one query per kind. */
function titlesFor(sql: SqlStorage, facts: readonly MemoryFact[]): Array<{ key: string; title: string }> {
  const threads = new Map<string, Set<string>>();
  const breakouts = new Map<string, Set<string>>();
  const spaces = new Map<string, Set<string>>();
  const sidekicks = new Map<string, Set<string>>();
  const want = (bucket: Map<string, Set<string>>, id: string, key: string) => {
    const keys = bucket.get(id) ?? new Set<string>();
    keys.add(key);
    bucket.set(id, keys);
  };
  for (const fact of facts) {
    switch (fact.subjectKind) {
      case "thread": want(threads, fact.subjectId, `thread:${fact.subjectId}`); break;
      case "breakout": want(breakouts, fact.subjectId, `breakout:${fact.subjectId}`); break;
      case "channel": want(spaces, fact.subjectId, `channel:${fact.subjectId}`); break;
      case "sidekick": want(sidekicks, fact.subjectId, `sidekick:${fact.subjectId}`); break;
      default: break;
    }
    for (const source of fact.sourceConversations) {
      const parsed = parseMemorySource(source);
      if (parsed.kind === "thread") want(threads, parsed.workstreamId, source);
      else if (parsed.kind === "breakout") want(breakouts, source, source);
      else if (parsed.kind === "space") want(spaces, parsed.spaceId, source);
      else want(sidekicks, parsed.automationId, source);
    }
  }
  const titles: Array<{ key: string; title: string }> = [];
  const emit = (bucket: Map<string, Set<string>>, id: string, title: string) => {
    for (const key of bucket.get(id) ?? []) titles.push({ key, title });
  };
  if (threads.size > 0) {
    for (const row of sql.exec<{ workstream_id: string; title: string }>(
      `SELECT workstream_id, title FROM channels WHERE ${inJsonList("workstream_id")}`, JSON.stringify([...threads.keys()]),
    ).toArray()) emit(threads, row.workstream_id, row.title);
  }
  if (breakouts.size > 0) {
    for (const row of sql.exec<{ source: string; title: string }>(
      `SELECT workstream_id || '/' || substream_id AS source, title FROM breakouts
        WHERE ${inJsonList("workstream_id || '/' || substream_id")}`, JSON.stringify([...breakouts.keys()]),
    ).toArray()) emit(breakouts, row.source, row.title);
  }
  if (spaces.size > 0) {
    for (const row of sql.exec<{ space_id: string; title: string }>(
      `SELECT space_id, title FROM spaces WHERE ${inJsonList("space_id")}`, JSON.stringify([...spaces.keys()]),
    ).toArray()) emit(spaces, row.space_id, row.title);
  }
  for (const row of sidekickRows(sql, [...sidekicks.keys()])) emit(sidekicks, row.automation_id, row.title);
  return titles;
}

// -- Tool writes --------------------------------------------------------------

function normalizedText(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ").trim().replace(/[.!]+$/u, "");
}

function receiptFor(sql: SqlStorage, request: { workspaceId: string; harnessRunId: string; receiptId: string }, operation: "remember" | "forget"): unknown | null {
  const row = sql.exec<{ result_json: string; operation: string }>(
    `SELECT result_json, operation FROM memory_fact_receipts
      WHERE receipt_id = ? AND workspace_id = ? AND harness_run_id = ?`,
    request.receiptId, request.workspaceId, request.harnessRunId,
  ).toArray()[0];
  if (!row) return null;
  if (row.operation !== operation) throw new Error("memory_fact_receipt_mismatch");
  return JSON.parse(row.result_json) as unknown;
}

function writeReceipt(sql: SqlStorage, request: { workspaceId: string; harnessRunId: string; receiptId: string; now: number }, operation: "remember" | "forget", result: unknown): void {
  sql.exec(
    `INSERT INTO memory_fact_receipts (receipt_id, workspace_id, harness_run_id, operation, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    request.receiptId, request.workspaceId, request.harnessRunId, operation, JSON.stringify(result), request.now,
  );
}

function insertFact(sql: SqlStorage, workspaceId: string, fact: MemoryFact): void {
  sql.exec(
    `INSERT INTO memory_facts (
       fact_id, workspace_id, subject_kind, subject_id, kind, text, valid_from, valid_until, valid_until_basis,
       derived_from, conflict, confidence, evidence_json, source_conversations_json, supersedes_fact_id,
       superseded_by_fact_id, retracted_at, retracted_by, confirmed_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    fact.factId, workspaceId, fact.subjectKind, fact.subjectId, fact.kind, fact.text, fact.validFrom, fact.validUntil,
    fact.validUntilBasis, fact.derivedFrom, fact.conflict ? 1 : 0, fact.confidence, JSON.stringify(fact.evidence),
    JSON.stringify(fact.sourceConversations), fact.supersedesFactId, fact.supersededByFactId, fact.retractedAt, null,
    fact.confirmedAt, fact.createdBy, fact.createdAt, fact.updatedAt,
  );
}

export function rememberMemoryFact(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryRememberRequest,
  relationship: WorkspaceRelationship | null,
): WorkspaceMemoryRememberResult {
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const replay = receiptFor(sql, request, "remember") as { fact: MemoryFact; deduplicated: boolean } | null;
    if (replay) return { outcome: "replayed", fact: replay.fact, deduplicated: replay.deduplicated };
    const reader = resolveReader(sql, request.reader, relationship, request.conversation);
    let subject: { kind: MemorySubjectKind; id: string };
    if (request.about === "me") {
      if (!reader || reader.kind !== "person") return { outcome: "personal_unavailable" };
      subject = { kind: "person", id: reader.userId };
    } else {
      subject = conversationSubject(request.conversation);
    }
    // The same sentence is the same fact, when the reader could see the first
    // one from here; a match they cannot open is written again rather than
    // reported as remembered and then never recalled.
    const wanted = normalizedText(request.text);
    const matches = sql.exec<FactRow>(
      `SELECT ${FACT_COLUMNS} FROM memory_facts fact
        WHERE fact.subject_kind = ? AND fact.subject_id = ? AND ${ACTIVE("fact")}
        ORDER BY fact.created_at DESC`,
      subject.kind, subject.id, request.now,
    ).toArray().map(factFromRow).filter((fact) => normalizedText(fact.text) === wanted);
    const existing = reader ? visibleFacts(sql, reader, request.conversation, matches)[0] : undefined;
    if (existing) {
      writeReceipt(sql, request, "remember", { fact: existing, deduplicated: true });
      return { outcome: "deduplicated", fact: existing };
    }
    const fact: MemoryFact = {
      factId: request.factId,
      subjectKind: subject.kind,
      subjectId: subject.id,
      kind: request.kind,
      text: request.text,
      validFrom: null,
      validUntil: request.validUntil,
      validUntilBasis: request.validUntil === null ? null : "stated",
      derivedFrom: request.derivedFrom,
      conflict: false,
      confidence: null,
      evidence: [],
      sourceConversations: [memorySourceOf(request.conversation)],
      supersedesFactId: null,
      supersededByFactId: null,
      retractedAt: null,
      confirmedAt: null,
      createdBy: `run:${request.harnessRunId}`,
      createdAt: request.now,
      updatedAt: request.now,
    };
    insertFact(sql, request.workspaceId, fact);
    nextMemoryRevision(sql);
    writeReceipt(sql, request, "remember", { fact, deduplicated: false });
    return { outcome: "written", fact };
  });
}

function ownsPersonalChannel(sql: SqlStorage, userId: string, spaceId: string): boolean {
  return sql.exec(
    `SELECT 1 FROM spaces WHERE space_id = ? AND scope = 'individual' AND created_by_user_id = ?`, spaceId, userId,
  ).toArray().length > 0;
}

/**
 * Whether this reader may retract this fact, apart from being able to see it.
 * A person retracts their own facts; a participant retracts what the
 * conversation they stand in established (its own subject, or every source
 * here); a Channel's or the Organization's facts take an administrator; a
 * Sidekick retracts only what came from itself and its home. A Personal
 * Channel's facts are its owner's to retract too: nobody else is listed it,
 * so an administrator's rule alone would leave them removable by nobody. With no
 * conversation (a person's own review, or the Organization's) only the first
 * and third rules apply. The review surface reads removability from here too.
 */
function mayForget(sql: SqlStorage, reader: ResolvedReader, conversation: MemoryConversation | null, fact: MemoryFact): boolean {
  if (fact.subjectKind === "channel" || fact.subjectKind === "organization") {
    if (reader.kind !== "person") return false;
    if (reader.administrator) return true;
    return fact.subjectKind === "channel" && ownsPersonalChannel(sql, reader.userId, fact.subjectId);
  }
  if (fact.subjectKind === "person") return reader.kind === "person" && fact.subjectId === reader.userId;
  if (conversation === null) return false;
  const here = memorySourceOf(conversation);
  const subject = conversationSubject(conversation);
  if (fact.subjectKind === subject.kind && fact.subjectId === subject.id) return true;
  if (fact.sourceConversations.every((source) => source === here)) return true;
  if (reader.kind !== "sidekick") return false;
  const own = new Set([`sidekick:${reader.automationId}`, ...(reader.row ? [homeSourceOf(reader.row)] : [])]);
  return fact.sourceConversations.every((source) => own.has(source));
}

export function forgetMemoryFact(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryForgetRequest,
  relationship: WorkspaceRelationship | null,
): WorkspaceMemoryForgetResult {
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const replay = receiptFor(sql, request, "forget") as WorkspaceMemoryForgetResult | null;
    if (replay) return replay;
    const reader = resolveReader(sql, request.reader, relationship, request.conversation);
    const fact = factById(sql, request.factId);
    if (!fact) return { outcome: "not_found" };
    if (!reader || visibleFacts(sql, reader, request.conversation, [fact]).length === 0) return { outcome: "not_visible" };
    if (fact.retractedAt !== null) {
      const result: WorkspaceMemoryForgetResult = { outcome: "already_retracted", fact };
      writeReceipt(sql, request, "forget", result);
      return result;
    }
    if (!mayForget(sql, reader, request.conversation, fact)) {
      return { outcome: "not_forgettable", subjectKind: fact.subjectKind };
    }
    const by = reader.kind === "person" ? `person:${reader.userId}`
      : reader.kind === "sidekick" ? `sidekick:${reader.automationId}` : memorySourceOf(request.conversation);
    sql.exec(
      `UPDATE memory_facts SET retracted_at = ?, retracted_by = ?, updated_at = ? WHERE fact_id = ?`,
      request.now, by, request.now, request.factId,
    );
    // Every conversation whose copy was read with this fact may be showing
    // it; the copy-sync lane refreshes them (`memory-digest-sync.ts`).
    markMemoryDigestHoldersFor(sql, [fact.factId]);
    const result: WorkspaceMemoryForgetResult = {
      outcome: "retracted",
      fact: { ...fact, retractedAt: request.now, updatedAt: request.now },
      revision: nextMemoryRevision(sql),
    };
    writeReceipt(sql, request, "forget", result);
    return result;
  });
}

// -- Review -------------------------------------------------------------------

/** Not retracted and not superseded: the review lists expired facts too, so the horizon is not part of it. */
const UNWITHDRAWN = "fact.retracted_at IS NULL AND fact.superseded_by_fact_id IS NULL";

/** The one subject a review scope lists. */
function reviewSubject(
  scope: MemoryReviewScope,
  workspaceId: string,
  person: ResolvedPerson,
): { kind: MemorySubjectKind; id: string } {
  switch (scope.kind) {
    case "own": return { kind: "person", id: person.userId };
    case "organization": return { kind: "organization", id: workspaceId };
    case "conversation": return conversationSubject(scope.conversation);
  }
}

/**
 * The conversation a scope's facts are read inside, for the audience half of
 * visibility. A Thread's or Breakout's review reads as recall does there, so it
 * lists what Rally would recall in that conversation. A Channel's reads with no
 * conversation, as the Organization's does: the Channel's review is where an
 * administrator reaches its facts, and a Channel fact learned in a private
 * Thread would otherwise be listed to nobody.
 */
function reviewAudience(scope: MemoryReviewScope): MemoryConversation | null {
  return scope.kind === "conversation" && scope.conversation.parentKind !== "space" ? scope.conversation : null;
}

/**
 * The facts among `facts` this scope's review lists to this person. Their own
 * facts are listed whether or not they may still open the conversation each
 * came from: design decision 14 gives a person authority over facts about
 * them apart from what they can see, and a fact learned in a room they have
 * since left must still reach them to be removed (recall and the digest still
 * hold it back, by the source rule). Every other scope goes through the
 * visibility rule recall uses, and a conversation scope also needs the
 * conversation itself openable.
 */
function listedInReview(
  sql: SqlStorage,
  person: ResolvedPerson,
  workspaceId: string,
  scope: MemoryReviewScope,
  facts: readonly MemoryFact[],
): MemoryFact[] {
  const subject = reviewSubject(scope, workspaceId, person);
  const onSubject = facts.filter((fact) => fact.subjectKind === subject.kind && fact.subjectId === subject.id);
  if (scope.kind === "own") return onSubject;
  return visibleFacts(sql, person, reviewAudience(scope), onSubject);
}

/** Whether this person may open the conversation a scope names; the Organization and their own need nothing. */
function reviewScopeOpen(sql: SqlStorage, person: ResolvedPerson, scope: MemoryReviewScope): boolean {
  if (scope.kind !== "conversation") return true;
  const here = memorySourceOf(scope.conversation);
  return openableBy(sql, person, new Set([here])).has(here);
}

function reviewPerson(
  sql: SqlStorage,
  userId: string,
  relationship: WorkspaceRelationship | null,
): ResolvedPerson | null {
  const reader = resolveReader(sql, { kind: "person", userId }, relationship, null);
  return reader?.kind === "person" ? reader : null;
}

/**
 * One scope of a person's review: its subject's active facts they may see,
 * newest first, expired included, each with whether they may remove it by the
 * one rule `memory_forget` uses (`mayForget`), so no caller re-derives it.
 */
export function reviewMemoryFacts(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryReviewRequest,
  relationship: WorkspaceRelationship | null,
): WorkspaceMemoryReviewResult {
  const sql = storage.sql;
  const person = reviewPerson(sql, request.userId, relationship);
  if (!person || !reviewScopeOpen(sql, person, request.scope)) return { outcome: "not_found" };
  const subject = reviewSubject(request.scope, request.workspaceId, person);
  const candidates = sql.exec<FactRow>(
    `SELECT ${FACT_COLUMNS} FROM memory_facts fact
      WHERE fact.subject_kind = ? AND fact.subject_id = ? AND ${UNWITHDRAWN}
      ORDER BY fact.created_at DESC, fact.fact_id`,
    subject.kind, subject.id,
  ).toArray().map(factFromRow);
  const listed = listedInReview(sql, person, request.workspaceId, request.scope, candidates);
  const conversation = request.scope.kind === "conversation" ? request.scope.conversation : null;
  return {
    outcome: "listed",
    facts: listed.map((fact) => ({ fact, removable: mayForget(sql, person, conversation, fact) })),
    titles: reviewTitles(sql, person, request.scope, listed),
  };
}

/**
 * Titles for what a review renders: each fact's subject and its first source,
 * the "from" link. A person's own facts skip the source rule, but their
 * titles do not: a source they may no longer open goes untitled, so a
 * private Thread they were removed from does not keep telling them its name.
 * Every other scope already required every source openable, and a
 * conversation scope its own conversation.
 */
function reviewTitles(
  sql: SqlStorage,
  person: ResolvedPerson,
  scope: MemoryReviewScope,
  facts: readonly MemoryFact[],
): Array<{ key: string; title: string }> {
  const firsts = facts.map((fact) => fact.sourceConversations[0]!);
  const open = scope.kind === "own" ? openableBy(sql, person, new Set(firsts)) : new Set(firsts);
  return titlesFor(sql, facts.map((fact, index) => ({
    ...fact,
    sourceConversations: open.has(firsts[index]!) ? [firsts[index]!] : [],
  })));
}

/**
 * Remove one fact from a scope's review, when this person may by `mayForget`.
 * A fact the scope's review would not list to them answers `not_found`, so a
 * fact id learned elsewhere reveals nothing. Every digest holder is marked for
 * the copy-sync lane, as a `memory_forget` marks them.
 */
export function forgetReviewedMemoryFact(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryReviewForgetRequest,
  relationship: WorkspaceRelationship | null,
): WorkspaceMemoryReviewForgetResult {
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const person = reviewPerson(sql, request.userId, relationship);
    const fact = factById(sql, request.factId);
    if (!person || !fact || !reviewScopeOpen(sql, person, request.scope)) return { outcome: "not_found" };
    if (listedInReview(sql, person, request.workspaceId, request.scope, [fact]).length === 0) return { outcome: "not_found" };
    if (fact.retractedAt !== null) return { outcome: "already_retracted", fact, retractedAt: fact.retractedAt };
    // A sweep revised it since the review was read: the successor is what is
    // listed now, and retracting the inactive predecessor would leave it.
    if (fact.supersededByFactId !== null) return { outcome: "not_found" };
    const conversation = request.scope.kind === "conversation" ? request.scope.conversation : null;
    if (!mayForget(sql, person, conversation, fact)) return { outcome: "not_removable" };
    sql.exec(
      `UPDATE memory_facts SET retracted_at = ?, retracted_by = ?, updated_at = ? WHERE fact_id = ?`,
      request.now, `person:${person.userId}`, request.now, request.factId,
    );
    // As `memory_forget` does: the holders whose copy was read with this fact
    // are refreshed by the copy-sync lane, and the revision moves so a read
    // from before this removal cannot replace a copy read after it.
    markMemoryDigestHoldersFor(sql, [fact.factId]);
    nextMemoryRevision(sql);
    return {
      outcome: "retracted",
      fact: { ...fact, retractedAt: request.now, updatedAt: request.now },
      retractedAt: request.now,
    };
  });
}

// -- Sweep --------------------------------------------------------------------

function sweepPlacement(
  sql: SqlStorage,
  workspaceId: string,
  conversation: MemoryConversation,
  speakerIds: readonly string[],
): { placement: MemorySweepPlacement; audience: Audience; subjects: SubjectSet } | null {
  const audience = conversationAudience(sql, conversation);
  if (!audience) return null;
  const subjects = conversationSubjects(sql, workspaceId, conversation);
  let subject: MemorySweepPlacement["subject"];
  let thread: MemorySweepPlacement["thread"] = null;
  switch (conversation.parentKind) {
    case "workstream": {
      const row = sql.exec<{ title: string }>(`SELECT title FROM channels WHERE workstream_id = ?`, conversation.parentId).toArray()[0];
      if (!row) return null;
      if (conversation.substreamId === "0") {
        subject = { kind: "thread", id: conversation.parentId, title: row.title };
      } else {
        const breakout = sql.exec<{ title: string }>(
          `SELECT title FROM breakouts WHERE workstream_id = ? AND substream_id = ?`, conversation.parentId, conversation.substreamId,
        ).toArray()[0];
        if (!breakout) return null;
        subject = { kind: "breakout", id: `${conversation.parentId}/${conversation.substreamId}`, title: breakout.title };
        thread = { id: conversation.parentId, title: row.title };
      }
      break;
    }
    case "automation": {
      const row = sidekickRows(sql, [conversation.parentId])[0];
      if (!row) return null;
      subject = { kind: "sidekick", id: row.automation_id, title: row.title };
      if (row.owning_workstream_id) {
        const home = sql.exec<{ title: string }>(`SELECT title FROM channels WHERE workstream_id = ?`, row.owning_workstream_id).toArray()[0];
        if (home) thread = { id: row.owning_workstream_id, title: home.title };
      }
      break;
    }
    case "space": {
      const row = sql.exec<{ title: string }>(`SELECT title FROM spaces WHERE space_id = ?`, conversation.parentId).toArray()[0];
      if (!row) return null;
      subject = { kind: "channel", id: conversation.parentId, title: row.title };
      break;
    }
  }
  // People a fact may be about: those who spoke, and are in the audience today.
  const admitted = audience.kind === "members"
    ? new Set(relationshipsOf(sql, speakerIds).keys())
    : audience.kind === "people" ? new Set(audience.userIds) : new Set<string>();
  const people = speakerIds.filter((id) => admitted.has(id)).map((id) => ({ id }));
  for (const person of people) subjects.keys.push(subjectKey("person", person.id));
  const organizationWide = audience.kind === "members"
    || (audience.kind === "sidekick" && sidekickRows(sql, [audience.automationId])[0]?.scope === "workspace");
  return {
    placement: { conversation, subject, thread, channels: subjects.channels, organizationWide, people },
    audience,
    subjects,
  };
}

export function memorySweepCandidates(
  storage: DurableObjectStorage,
  request: WorkspaceMemorySweepCandidatesRequest,
): WorkspaceMemorySweepCandidatesResult {
  const sql = storage.sql;
  const placed = sweepPlacement(sql, request.workspaceId, request.conversation, request.speakerIds);
  if (!placed) return { outcome: "conversation_missing" };
  const match = memoryFtsMatch(request.terms);
  const matched = match === null ? [] : activeFactsOn(sql, placed.subjects.keys, request.now, request.limit, match);
  // Every situational fact on the subjects is a candidate whatever the window
  // says: the sweep's job includes noticing one has ended.
  const situational = sql.exec<FactRow>(
    `SELECT ${FACT_COLUMNS} FROM memory_facts fact
      WHERE (fact.subject_kind || ':' || fact.subject_id) IN (SELECT value FROM json_each(?))
        AND fact.kind = 'situational' AND ${ACTIVE("fact")}
      ORDER BY fact.updated_at DESC LIMIT ?`,
    JSON.stringify(placed.subjects.keys), request.now, request.limit,
  ).toArray().map(factFromRow);
  const byId = new Map<string, MemoryFact>();
  for (const fact of [...matched, ...situational]) byId.set(fact.factId, fact);
  const facts = [...byId.values()];
  return {
    outcome: "ready",
    placement: placed.placement,
    candidates: sweepVisibleFacts(sql, placed, memorySourceOf(request.conversation), facts).slice(0, request.limit),
  };
}

function receiptRow(sql: SqlStorage, conversation: string) {
  return sql.exec<{ from_seq: number; to_seq: number; applied_at: number; operations_json: string }>(
    `SELECT from_seq, to_seq, applied_at, operations_json FROM memory_sweep_receipts WHERE conversation = ?`, conversation,
  ).toArray()[0];
}

export function applyMemorySweep(
  storage: DurableObjectStorage,
  request: WorkspaceMemoryApplySweepRequest,
): WorkspaceMemoryApplySweepResult {
  return storage.transactionSync(() => {
    const sql = storage.sql;
    const here = memorySourceOf(request.conversation);
    const receiptKey = memoryConversationKeyOf(request.conversation);
    const stored = receiptRow(sql, receiptKey);
    const storedToSeq = stored?.to_seq ?? 0;
    if (stored && request.fromSeq < stored.to_seq) {
      return {
        outcome: "already_applied",
        receipt: {
          conversation: receiptKey, fromSeq: stored.from_seq, toSeq: stored.to_seq, appliedAt: stored.applied_at,
          operationCount: (JSON.parse(stored.operations_json) as unknown[]).length,
        },
      };
    }
    if (request.fromSeq > storedToSeq) return { outcome: "cursor_ahead", storedToSeq };
    const placed = sweepPlacement(sql, request.workspaceId, request.conversation, request.speakerIds);
    const refused: Array<{ index: number; code: MemorySweepRefusal }> = [];
    let applied = false;
    // A retraction withdraws its fact from every copy read with it, so those
    // holders are marked. An update supersedes its predecessor without
    // withdrawing access: a copy showing the old wording is stale, not wrong
    // about who may read it, and catches up at its next refresh, as an add
    // or a confirm does (the swept conversation's own copies are refreshed by
    // the sweep consumer).
    const retracted: string[] = [];
    // An update, confirm or retract may touch only a fact this sweep was
    // handed as a candidate, and only while every participant may still open
    // it: the model reads a fact id off an untrusted transcript as readily as
    // off the candidate list.
    const candidateIds = new Set(request.candidateFactIds);
    const touched = request.operations.flatMap((operation) => {
      if (operation.op === "add" || !candidateIds.has(operation.factId)) return [];
      const fact = factById(sql, operation.factId);
      return fact ? [fact] : [];
    });
    const touchable = new Set(placed ? sweepVisibleFacts(sql, placed, here, touched).map((fact) => fact.factId) : []);
    request.operations.forEach((operation, index) => {
      if (operation.op === "add") {
        if (!placed) { refused.push({ index, code: "subject_above_placement" }); return; }
        const factId = request.factIds[index];
        if (!factId) { refused.push({ index, code: "fact_id_missing" }); return; }
        let subject: { kind: MemorySubjectKind; id: string } | null = null;
        switch (operation.subjectKind) {
          case "organization":
            subject = placed.placement.organizationWide ? { kind: "organization", id: request.workspaceId } : null;
            break;
          case "channel": {
            const channels = placed.placement.channels;
            const chosen = operation.subjectId === null && channels.length === 1
              ? channels[0]
              : channels.find((channel) => channel.id === operation.subjectId);
            if (!chosen) { refused.push({ index, code: "subject_id_not_in_placement" }); return; }
            subject = { kind: "channel", id: chosen.id };
            break;
          }
          case "thread":
            subject = placed.placement.thread
              ? { kind: "thread", id: placed.placement.thread.id }
              : placed.placement.subject.kind === "thread" ? { kind: "thread", id: placed.placement.subject.id } : null;
            break;
          case "breakout":
            subject = placed.placement.subject.kind === "breakout" ? { kind: "breakout", id: placed.placement.subject.id } : null;
            break;
          case "sidekick":
            subject = placed.placement.subject.kind === "sidekick" ? { kind: "sidekick", id: placed.placement.subject.id } : null;
            break;
          case "person": {
            if (!placed.placement.people.some((person) => person.id === operation.subjectId)) {
              refused.push({ index, code: "subject_id_not_in_placement" }); return;
            }
            subject = { kind: "person", id: operation.subjectId! };
            break;
          }
        }
        if (!subject) { refused.push({ index, code: "subject_above_placement" }); return; }
        if (operation.kind === "situational" && operation.validUntil === null) {
          refused.push({ index, code: "horizon_required" }); return;
        }
        insertFact(sql, request.workspaceId, {
          factId,
          subjectKind: subject.kind,
          subjectId: subject.id,
          kind: operation.kind,
          text: operation.text,
          validFrom: operation.validFrom,
          validUntil: operation.validUntil,
          validUntilBasis: operation.validUntil === null ? null : operation.validUntilBasis ?? "assumed",
          derivedFrom: operation.derivedFrom,
          conflict: operation.conflict,
          confidence: operation.confidence,
          evidence: operation.evidence,
          sourceConversations: [here],
          supersedesFactId: null,
          supersededByFactId: null,
          retractedAt: null,
          confirmedAt: null,
          createdBy: "sweep",
          createdAt: request.now,
          updatedAt: request.now,
        });
        applied = true;
        return;
      }
      if (!candidateIds.has(operation.factId)) { refused.push({ index, code: "fact_not_candidate" }); return; }
      const fact = factById(sql, operation.factId);
      if (!fact) { refused.push({ index, code: "fact_not_found" }); return; }
      if (fact.retractedAt !== null || fact.supersededByFactId !== null) { refused.push({ index, code: "fact_not_active" }); return; }
      if (!touchable.has(fact.factId)) { refused.push({ index, code: "fact_not_candidate" }); return; }
      if (operation.op === "confirm") {
        sql.exec(`UPDATE memory_facts SET confirmed_at = ?, updated_at = ? WHERE fact_id = ?`, request.now, request.now, fact.factId);
        applied = true;
        return;
      }
      if (operation.op === "retract") {
        sql.exec(
          `UPDATE memory_facts SET retracted_at = ?, retracted_by = 'sweep', updated_at = ? WHERE fact_id = ?`,
          request.now, request.now, fact.factId,
        );
        applied = true;
        retracted.push(fact.factId);
        return;
      }
      // An update is a new fact that supersedes and links its predecessor, and
      // carries every source that contributed: the second fence of §6.
      // `evidence` indexes the first source, so an update that cites this
      // window puts this conversation first; one that cites nothing keeps
      // the predecessor's evidence and order. Two trust classes make `mixed`.
      const factId = request.factIds[index];
      if (!factId) { refused.push({ index, code: "fact_id_missing" }); return; }
      const cites = operation.evidence.length > 0;
      const sources = cites
        ? [here, ...fact.sourceConversations.filter((source) => source !== here)]
        : [...new Set([...fact.sourceConversations, here])];
      insertFact(sql, request.workspaceId, {
        ...fact,
        factId,
        text: operation.text,
        validUntil: operation.validUntil ?? (fact.kind === "situational" ? fact.validUntil : null),
        validUntilBasis: operation.validUntil === null ? (fact.kind === "situational" ? fact.validUntilBasis : null) : "stated",
        derivedFrom: operation.derivedFrom === fact.derivedFrom ? fact.derivedFrom : "mixed",
        evidence: cites ? operation.evidence : fact.evidence,
        sourceConversations: sources,
        supersedesFactId: fact.factId,
        supersededByFactId: null,
        retractedAt: null,
        confirmedAt: null,
        createdBy: "sweep",
        createdAt: request.now,
        updatedAt: request.now,
      });
      sql.exec(`UPDATE memory_facts SET superseded_by_fact_id = ?, updated_at = ? WHERE fact_id = ?`, factId, request.now, fact.factId);
      applied = true;
    });
    const markedHolders = markMemoryDigestHoldersFor(sql, retracted);
    const revision = applied ? nextMemoryRevision(sql) : currentMemoryRevision(sql);
    sql.exec(
      `INSERT INTO memory_sweep_receipts (conversation, workspace_id, from_seq, to_seq, operations_json, model, input_tokens, output_tokens, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation) DO UPDATE SET
         from_seq = excluded.from_seq, to_seq = excluded.to_seq, operations_json = excluded.operations_json,
         model = excluded.model, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         applied_at = excluded.applied_at`,
      receiptKey, request.workspaceId, request.fromSeq, request.toSeq, JSON.stringify(request.operations), request.model,
      request.inputTokens, request.outputTokens, request.now,
    );
    return {
      outcome: "applied",
      receipt: { conversation: receiptKey, fromSeq: request.fromSeq, toSeq: request.toSeq, appliedAt: request.now, operationCount: request.operations.length },
      refused,
      revision,
      markedHolders,
    };
  });
}
