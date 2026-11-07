/**
 * A Sidekick's reachable conversations and its Canvas attachments, against the
 * checked-in schemas.
 *
 * The attachment table's key makes a repeat attach one row, and the scope reads
 * are claims about joins over `automation_directory`, `canvas_directory` and
 * `sidekick_conversation_attachments`. Both are proved here against the object
 * ledger rather than in the workers suite; what workerd adds (the RPC, each
 * parent's admission of the acting person) is proved in
 * `test-workers/conversation-tools.test.ts`.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import {
  attachSidekickConversation,
  canvasesTitled,
  conversationIdOf,
  matchConversationReference,
  parseConversationId,
  scopeConversations,
} from "../src/durable-objects/workspace-sidekick-conversation-storage";
import { createTestSqlStorage } from "./helpers/sql-storage";

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000a1";
const AUTHOR = "00000000-0000-7000-8000-0000000000b1";
const STRANGER = "00000000-0000-7000-8000-0000000000b2";
const CHANNEL = "00000000-0000-7000-8000-0000000000c1";
const SIDEKICK = "00000000-0000-7000-8000-0000000000e1";
const OTHER_SIDEKICK = "00000000-0000-7000-8000-0000000000e2";
const WRITTEN = "00000000-0000-7000-8000-0000000000f1";
const NEWER_WRITTEN = "00000000-0000-7000-8000-0000000000f2";
const ATTACHED = "00000000-0000-7000-8000-0000000000f3";
const HOME_COLUMN_VERSION = 86;

function applyWorkspace(database: DatabaseSync, through: number, after = 0): void {
  for (const migration of WORKSPACE_DO_SCHEMA_MIGRATIONS) {
    if (migration.version <= after) continue;
    if (migration.version > through) break;
    for (const statement of migration.statements) database.exec(statement);
  }
}

function seedIdentity(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO workspace_identity (id, workspace_id, region, placement_affinity, created_at, updated_at)
     VALUES (1, ?, 'global', 'wnam', 0, 0)`,
  ).run(WORKSPACE_ID);
}

/** A Sidekick as migration 86 left one a Channel owned. */
function seedSidekick(database: DatabaseSync, id = SIDEKICK, lifecycle = "active"): void {
  database.prepare(
    `INSERT INTO automation_directory
       (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope,
        owning_workstream_id, title, description, next_run_at, projected_at)
     VALUES (?, ?, ?, 1, 'sha256:a', ?, 'workstream', ?, 'Weekly call prep', '', NULL, 1)`,
  ).run(id, WORKSPACE_ID, AUTHOR, lifecycle, CHANNEL);
}

function seedCanvas(database: DatabaseSync, id: string, title: string, createdAt: number, writer: string | null = null): void {
  database.prepare(
    `INSERT INTO canvas_directory
       (canvas_id, workspace_id, title, created_by_user_id, created_at, updated_at, writer_sidekick_id,
        visibility, authority_generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'creator', 1)`,
  ).run(id, WORKSPACE_ID, title, AUTHOR, createdAt, createdAt, writer);
}

/** Every WorkspaceDO migration, the way a current object holds them. */
function currentWorkspace(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  applyWorkspace(database, Number.POSITIVE_INFINITY);
  seedIdentity(database);
  return database;
}

describe("the WorkspaceDO home-conversation migration", () => {
  it("keeps every projected Sidekick's home at its Channel's Main conversation", () => {
    const database = new DatabaseSync(":memory:");
    applyWorkspace(database, HOME_COLUMN_VERSION - 2);
    seedIdentity(database);
    seedSidekick(database);

    applyWorkspace(database, HOME_COLUMN_VERSION, HOME_COLUMN_VERSION - 2);

    expect(database.prepare(
      `SELECT automation_id, owning_workstream_id, owning_substream_id FROM automation_directory`,
    ).all()).toEqual([{ automation_id: SIDEKICK, owning_workstream_id: CHANNEL, owning_substream_id: "0" }]);
  });

  it("holds one attachment per Sidekick and Canvas, filed under the canvas kind", () => {
    const database = currentWorkspace();
    const sql = createTestSqlStorage(database);
    seedSidekick(database);
    const address = { parentKind: "canvas" as const, parentId: ATTACHED, substreamId: "0" };

    expect(attachSidekickConversation(sql, { automationId: SIDEKICK, address, userId: AUTHOR, now: 1 }))
      .toEqual({ alreadyAttached: false });
    expect(attachSidekickConversation(sql, { automationId: SIDEKICK, address, userId: STRANGER, now: 2 }))
      .toEqual({ alreadyAttached: true });
    expect(database.prepare(
      `SELECT parent_kind, parent_id, substream_id, attached_by_user_id FROM sidekick_conversation_attachments`,
    ).all()).toEqual([{ parent_kind: "canvas", parent_id: ATTACHED, substream_id: "0", attached_by_user_id: AUTHOR }]);
  });
});

describe("a Sidekick's scope", () => {
  it("puts its own conversation first, then the Canvases it writes newest made first, then its attachments in order", () => {
    const database = currentWorkspace();
    const sql = createTestSqlStorage(database);
    seedSidekick(database);
    seedSidekick(database, OTHER_SIDEKICK);
    seedCanvas(database, WRITTEN, "Monday brief", 10, SIDEKICK);
    seedCanvas(database, NEWER_WRITTEN, "Tuesday brief", 20, SIDEKICK);
    seedCanvas(database, ATTACHED, "Launch", 5);
    // Another Sidekick's Canvas is not this one's.
    seedCanvas(database, "00000000-0000-7000-8000-0000000000f4", "Elsewhere", 30, OTHER_SIDEKICK);
    attachSidekickConversation(sql, { automationId: SIDEKICK,
      address: { parentKind: "canvas", parentId: ATTACHED, substreamId: "0" }, userId: AUTHOR, now: 1 });
    // A Canvas both written and attached is listed once, where it is written.
    attachSidekickConversation(sql, { automationId: SIDEKICK,
      address: { parentKind: "canvas", parentId: WRITTEN, substreamId: "0" }, userId: AUTHOR, now: 2 });
    // An attachment of a Thread from before the cutover names nothing.
    database.prepare(`INSERT INTO sidekick_conversation_attachments
      (automation_id, parent_kind, parent_id, substream_id, attached_by_user_id, attached_at)
      VALUES (?, 'workstream', ?, '0', ?, 3)`).run(SIDEKICK, CHANNEL, AUTHOR);

    const listed = (authoring?: boolean) => scopeConversations(sql, { kind: "sidekick", automationId: SIDEKICK,
      ...(authoring ? { authoring } : {}) }).map((conversation) => [conversation.conversationId, conversation.kind,
      conversation.title, conversation.isOwn, conversation.isParent]);
    expect(listed(true)).toEqual([
      [SIDEKICK, "sidekick", "Weekly call prep", true, false],
      [NEWER_WRITTEN, "canvas", "Tuesday brief", false, false],
      [WRITTEN, "canvas", "Monday brief", false, false],
      [ATTACHED, "canvas", "Launch", false, false],
    ]);
    // A run sits inside the Sidekick's own conversation.
    expect(listed()[0]).toEqual([SIDEKICK, "sidekick", "Weekly call prep", false, true]);
  });

  it("drops a deleted Canvas and reaches nothing for a deleted Sidekick", () => {
    const database = currentWorkspace();
    const sql = createTestSqlStorage(database);
    seedSidekick(database);
    seedCanvas(database, ATTACHED, "Launch", 5);
    attachSidekickConversation(sql, { automationId: SIDEKICK,
      address: { parentKind: "canvas", parentId: ATTACHED, substreamId: "0" }, userId: AUTHOR, now: 1 });
    database.prepare(`DELETE FROM canvas_directory WHERE canvas_id = ?`).run(ATTACHED);
    expect(scopeConversations(sql, { kind: "sidekick", automationId: SIDEKICK }).map((conversation) => conversation.conversationId))
      .toEqual([SIDEKICK]);
    database.prepare(`UPDATE automation_directory SET lifecycle = 'deleted'`).run();
    expect(scopeConversations(sql, { kind: "sidekick", automationId: SIDEKICK })).toEqual([]);
  });

  it("finds every Canvas by its title, ignoring case, for the caller to admit", () => {
    const database = currentWorkspace();
    seedCanvas(database, WRITTEN, "Investors", 1);
    seedCanvas(database, ATTACHED, "investors", 2);
    seedCanvas(database, NEWER_WRITTEN, "Founders", 3);
    const sql = createTestSqlStorage(database);

    expect(canvasesTitled(sql, " INVESTORS ").map((conversation) => conversation.conversationId))
      .toEqual([WRITTEN, ATTACHED]);
    expect(canvasesTitled(sql, "Weekly call")).toEqual([]);
  });
});

describe("a conversation reference", () => {
  it("reads one Canvas or Sidekick id, and nothing else, as an id", () => {
    expect(parseConversationId(` ${WRITTEN.toUpperCase()} `)).toEqual({ parentId: WRITTEN, substreamId: "0" });
    // A Breakout's `<threadId>/<breakoutId>` went with Breakouts.
    expect(parseConversationId(`${CHANNEL}/${WRITTEN}`)).toBeNull();
    expect(parseConversationId("Investors")).toBeNull();
    expect(conversationIdOf({ parentId: WRITTEN, substreamId: "0" })).toBe(WRITTEN);
  });

  it("matches an id exactly, or one title, and calls two titles ambiguous", () => {
    const candidates = [
      { conversationId: WRITTEN, title: "Investors" },
      { conversationId: NEWER_WRITTEN, title: "Weekly call" },
      { conversationId: ATTACHED, title: "weekly call" },
    ];
    expect(matchConversationReference(candidates, WRITTEN)).toEqual({ outcome: "found", conversation: candidates[0] });
    expect(matchConversationReference(candidates, "investors")).toEqual({ outcome: "found", conversation: candidates[0] });
    expect(matchConversationReference(candidates, "Weekly Call"))
      .toEqual({ outcome: "ambiguous", matches: [candidates[1], candidates[2]] });
    expect(matchConversationReference(candidates, "Somewhere else")).toEqual({ outcome: "missing" });
  });
});
