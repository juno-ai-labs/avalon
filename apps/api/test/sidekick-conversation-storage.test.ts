/**
 * A Sidekick's home and attached conversations, against the checked-in
 * schemas.
 *
 * The migrations are claims about SQL: a column added with a default keeps
 * every existing row's home at its Channel's Main conversation, and the
 * attachment table's key makes a repeat attach one row. The scope reads are
 * claims about joins over `channels`, `breakouts` and their viewer rows. Both
 * are proved here against the object ledgers rather than in the workers suite;
 * what workerd adds (the RPC, the parent's admission) is proved in
 * `test-workers/conversation-tools.test.ts`.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do";
import {
  attachSidekickConversation,
  conversationIdOf,
  conversationsTitled,
  matchConversationReference,
  parseConversationId,
  scopeConversations,
} from "../src/durable-objects/workspace-sidekick-conversation-storage";
import { createTestSqlStorage } from "./helpers/sql-storage";

const WORKSPACE_ID = "00000000-0000-7000-8000-0000000000a1";
const AUTHOR = "00000000-0000-7000-8000-0000000000b1";
const STRANGER = "00000000-0000-7000-8000-0000000000b2";
const CHANNEL = "00000000-0000-7000-8000-0000000000c1";
const OTHER_CHANNEL = "00000000-0000-7000-8000-0000000000c2";
const BREAKOUT = "00000000-0000-7000-8000-0000000000d1";
const SIDEKICK = "00000000-0000-7000-8000-0000000000e1";
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

function seedSidekick(database: DatabaseSync, id = SIDEKICK, lifecycle = "active"): void {
  database.prepare(
    `INSERT INTO automation_directory
       (automation_id, workspace_id, author_user_id, source_version, payload_hash, lifecycle, scope,
        owning_workstream_id, title, description, next_run_at, projected_at)
     VALUES (?, ?, ?, 1, 'sha256:a', ?, 'workstream', ?, 'Weekly call prep', '', NULL, 1)`,
  ).run(id, WORKSPACE_ID, AUTHOR, lifecycle, CHANNEL);
}

function seedChannel(database: DatabaseSync, id: string, title: string, scope: "personal" | "workspace", archived = false): void {
  database.prepare(
    `INSERT INTO channels
       (workstream_id, authority_generation, waterline, source_event_id, payload_hash, title, description,
        preview, scope, exact_state, last_activity_at, origin_type, title_status, latest_attention_ordinal,
        unread_tracking_start_ordinal, source_created_at, source_updated_at, projected_at, archived_at)
     VALUES (?, 1, 1, ?, 'sha256:c', ?, '', '', ?, 'idle', 1, 'ad_hoc', 'settled', 0, 0, 1, 1, 1, ?)`,
  ).run(id, `event-${id}`, title, scope, archived ? 5 : null);
}

function seedChannelViewer(database: DatabaseSync, channel: string, userId: string, participant: boolean): void {
  database.prepare(
    `INSERT INTO channel_viewers
       (workstream_id, user_id, authority_generation, waterline, source_event_id, payload_hash, is_participant,
        unread_count, you_are_mentioned, listable, seen_attention_ordinal, manual_unread_generation,
        latest_mention_attention_ordinal, projected_at)
     VALUES (?, ?, 1, 1, ?, 'sha256:v', ?, 0, 0, 1, 0, 0, 0, 1)`,
  ).run(channel, userId, `viewer-${channel}-${userId}`, participant ? 1 : 0);
}

function seedBreakout(database: DatabaseSync, title: string, archived = false): void {
  database.prepare(
    `INSERT INTO breakouts
       (workstream_id, substream_id, authority_generation, waterline, source_event_id, payload_hash, title,
        description, scope, exact_state, title_status, last_activity_at, archived_at, latest_attention_ordinal,
        unread_tracking_start_ordinal, source_created_at, source_updated_at, projected_at)
     VALUES (?, ?, 1, 1, 'event-breakout', 'sha256:b', ?, '', 'personal', 'idle', 'settled', 1, ?, 0, 0, 1, 1, 1)`,
  ).run(CHANNEL, BREAKOUT, title, archived ? 5 : null);
}

function seedBreakoutMember(database: DatabaseSync, userId: string): void {
  database.prepare(
    `INSERT INTO breakout_viewers
       (workstream_id, substream_id, user_id, authority_generation, waterline, source_event_id, payload_hash,
        is_participant, unread_count, you_are_mentioned, unseen, listable, seen_attention_ordinal,
        manual_unread_generation, latest_mention_attention_ordinal, projected_at)
     VALUES (?, ?, ?, 1, 1, 'event-member', 'sha256:m', 1, 0, 0, 0, 1, 0, 0, 0, 1)`,
  ).run(CHANNEL, BREAKOUT, userId);
}

function migratedWorkspace(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  applyWorkspace(database, HOME_COLUMN_VERSION);
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

  it("holds one attachment per Sidekick and conversation", () => {
    const database = migratedWorkspace();
    const sql = createTestSqlStorage(database);
    seedSidekick(database);
    const address = { parentKind: "workstream" as const, parentId: OTHER_CHANNEL, substreamId: "0" };

    expect(attachSidekickConversation(sql, { automationId: SIDEKICK, address, userId: AUTHOR, now: 1 }))
      .toEqual({ alreadyAttached: false });
    expect(attachSidekickConversation(sql, { automationId: SIDEKICK, address, userId: STRANGER, now: 2 }))
      .toEqual({ alreadyAttached: true });
    // The home is attached without a row, so attaching it writes nothing.
    expect(attachSidekickConversation(sql, {
      automationId: SIDEKICK, address: { ...address, parentId: CHANNEL }, userId: AUTHOR, now: 3,
    })).toEqual({ alreadyAttached: true });
    expect(database.prepare(
      `SELECT parent_id, substream_id, attached_by_user_id FROM sidekick_conversation_attachments`,
    ).all()).toEqual([{ parent_id: OTHER_CHANNEL, substream_id: "0", attached_by_user_id: AUTHOR }]);
  });

  it("files a Canvas's Chat attachment under the canvas kind, and scopes it as one", () => {
    const database = migratedWorkspace();
    const sql = createTestSqlStorage(database);
    seedSidekick(database);
    // Migration 140 admits the canvas kind in the attachment CHECK.
    applyWorkspace(database, 140, HOME_COLUMN_VERSION);
    const canvasId = "00000000-0000-7000-8000-0000000000f1";
    attachSidekickConversation(sql, {
      automationId: SIDEKICK, address: { parentKind: "canvas", parentId: canvasId, substreamId: "0" }, userId: AUTHOR, now: 1,
    });
    expect(database.prepare(`SELECT parent_kind, parent_id FROM sidekick_conversation_attachments`).all())
      .toEqual([{ parent_kind: "canvas", parent_id: canvasId }]);
    // No Thread directory describes a Canvas, so it is never offered as a Thread.
    expect(scopeConversations(sql, { kind: "sidekick", automationId: SIDEKICK }, AUTHOR)
      .some((conversation) => conversation.parentId === canvasId)).toBe(false);
  });
});

describe("a conversation scope", () => {
  it("puts a Sidekick's own conversation first, then its Breakout home, and flags what a person cannot open or what is archived", () => {
    const database = migratedWorkspace();
    const sql = createTestSqlStorage(database);
    seedSidekick(database);
    database.prepare(`UPDATE automation_directory SET owning_substream_id = ?`).run(BREAKOUT);
    seedChannel(database, CHANNEL, "Investors", "personal");
    seedChannel(database, OTHER_CHANNEL, "Founders", "workspace", true);
    seedChannelViewer(database, CHANNEL, AUTHOR, true);
    seedBreakout(database, "Weekly call");
    seedBreakoutMember(database, AUTHOR);
    attachSidekickConversation(sql, { automationId: SIDEKICK,
      address: { parentKind: "workstream", parentId: OTHER_CHANNEL, substreamId: "0" }, userId: AUTHOR, now: 1 });
    attachSidekickConversation(sql, { automationId: SIDEKICK,
      address: { parentKind: "workstream", parentId: CHANNEL, substreamId: "0" }, userId: AUTHOR, now: 2 });

    const scope = { kind: "sidekick" as const, automationId: SIDEKICK };
    expect(scopeConversations(sql, scope, AUTHOR).map((conversation) => ({
      id: conversation.conversationId, kind: conversation.kind, home: conversation.isHome,
      readable: conversation.readable, archived: conversation.archived,
    }))).toEqual([
      // Its own conversation's id is the Sidekick's; the Sidekick admits it, so the directories mark it readable.
      { id: SIDEKICK, kind: "sidekick", home: false, readable: true, archived: false },
      { id: `${CHANNEL}/${BREAKOUT}`, kind: "breakout", home: true, readable: true, archived: false },
      { id: OTHER_CHANNEL, kind: "channel", home: false, readable: true, archived: true },
      { id: CHANNEL, kind: "channel", home: false, readable: true, archived: false },
    ]);
    // Someone in neither the private Channel nor the Breakout reaches only
    // the workspace-scoped Channel, and that one is archived.
    expect(scopeConversations(sql, scope, STRANGER).map((conversation) => [conversation.conversationId, conversation.readable]))
      .toEqual([[SIDEKICK, true], [`${CHANNEL}/${BREAKOUT}`, false], [OTHER_CHANNEL, true], [CHANNEL, false]]);
  });

  it("archives a Breakout with its Channel, and reaches nothing for a deleted Sidekick", () => {
    const database = migratedWorkspace();
    const sql = createTestSqlStorage(database);
    seedSidekick(database);
    database.prepare(`UPDATE automation_directory SET owning_substream_id = ?`).run(BREAKOUT);
    seedChannel(database, CHANNEL, "Investors", "personal", true);
    seedBreakout(database, "Weekly call");
    seedBreakoutMember(database, AUTHOR);

    expect(scopeConversations(sql, { kind: "sidekick", automationId: SIDEKICK }, AUTHOR)
      .find((conversation) => conversation.isHome)?.archived).toBe(true);
    database.prepare(`UPDATE automation_directory SET lifecycle = 'deleted'`).run();
    expect(scopeConversations(sql, { kind: "sidekick", automationId: SIDEKICK }, AUTHOR)).toEqual([]);
  });

  it("gives a Breakout loop its own conversation and its Channel's Main", () => {
    const database = migratedWorkspace();
    const sql = createTestSqlStorage(database);
    seedChannel(database, CHANNEL, "Investors", "workspace");
    seedBreakout(database, "Weekly call");
    seedBreakoutMember(database, AUTHOR);

    expect(scopeConversations(sql, { kind: "conversation", parentId: CHANNEL, substreamId: BREAKOUT }, AUTHOR)
      .map((conversation) => [conversation.conversationId, conversation.isOwn]))
      .toEqual([[`${CHANNEL}/${BREAKOUT}`, true], [CHANNEL, false]]);
  });

  it("finds a conversation a person can open by its title, ignoring case", () => {
    const database = migratedWorkspace();
    seedChannel(database, CHANNEL, "Investors", "personal");
    seedChannel(database, OTHER_CHANNEL, "Investors", "workspace");
    seedChannelViewer(database, CHANNEL, AUTHOR, true);
    seedBreakout(database, "Weekly call");
    seedBreakoutMember(database, AUTHOR);
    const sql = createTestSqlStorage(database);

    expect(conversationsTitled(sql, "investors", AUTHOR).map((conversation) => conversation.conversationId).sort())
      .toEqual([CHANNEL, OTHER_CHANNEL].sort());
    // The private Channel is not one a stranger can name.
    expect(conversationsTitled(sql, "Investors", STRANGER).map((conversation) => conversation.conversationId))
      .toEqual([OTHER_CHANNEL]);
    expect(conversationsTitled(sql, "weekly CALL", AUTHOR).map((conversation) => conversation.conversationId))
      .toEqual([`${CHANNEL}/${BREAKOUT}`]);
    expect(conversationsTitled(sql, "Weekly call", STRANGER)).toEqual([]);
  });
});

describe("a conversation reference", () => {
  it("reads `<channelId>` and `<channelId>/<breakoutId>`, and nothing else, as an id", () => {
    expect(parseConversationId(CHANNEL)).toEqual({ parentKind: "workstream", parentId: CHANNEL, substreamId: "0" });
    expect(parseConversationId(` ${CHANNEL}/${BREAKOUT} `))
      .toEqual({ parentKind: "workstream", parentId: CHANNEL, substreamId: BREAKOUT });
    expect(parseConversationId(`${CHANNEL}/0`)).toBeNull();
    expect(parseConversationId(`${CHANNEL}/${BREAKOUT}/x`)).toBeNull();
    expect(parseConversationId("Investors")).toBeNull();
    expect(conversationIdOf({ parentId: CHANNEL, substreamId: "0" })).toBe(CHANNEL);
  });

  it("matches an id exactly, or one title, and calls two titles ambiguous", () => {
    const candidates = [
      { conversationId: CHANNEL, title: "Investors" },
      { conversationId: `${CHANNEL}/${BREAKOUT}`, title: "Weekly call" },
      { conversationId: OTHER_CHANNEL, title: "weekly call" },
    ];
    expect(matchConversationReference(candidates, CHANNEL)).toEqual({ outcome: "found", conversation: candidates[0] });
    expect(matchConversationReference(candidates, "investors")).toEqual({ outcome: "found", conversation: candidates[0] });
    expect(matchConversationReference(candidates, "Weekly Call"))
      .toEqual({ outcome: "ambiguous", matches: [candidates[1], candidates[2]] });
    expect(matchConversationReference(candidates, "Somewhere else")).toEqual({ outcome: "missing" });
  });
});
