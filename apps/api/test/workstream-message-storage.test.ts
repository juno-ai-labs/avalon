import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import { WorkstreamMessageStorage } from "../src/durable-objects/workstream-message-storage";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const NOW = 1_787_000_000_000;

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/**
 * A work stream's own object, at the counters a fresh one starts on.
 *
 * `next_sequence_number` and `next_attention_ordinal` both start at 1, which is
 * what makes the first append's ordinals worth asserting: the retired trigger
 * moved one of them and the caller's own second statement moved the other, and
 * an append that moves only one is the failure this fixture can see.
 */
function open(): {
  storage: WorkstreamMessageStorage;
  transcript: WorkstreamTranscriptStorage;
  sql: ReturnType<typeof createTestSqlStorage>;
} {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = createTestSqlStorage(database);
  const binding = createCloudflareTestBinding<DurableObjectStorage>({
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    transactionSync: (body: () => unknown) => body(),
    sql,
  });
  applyWorkstreamObjectSchema(binding, "v", 1);
  sql.exec(`INSERT INTO workstream (
      id, workstream_key, parent_workspace_key, parent_do_id, parent_generation, region,
      authority_mode, authority_generation, title, description, preview, scope,
      exact_state, state_reason_code, next_sequence_number, next_attention_ordinal,
      unread_tracking_start_ordinal, authority_epoch, scope_epoch,
      source_authorization_floor, listing_epoch, deletion_epoch, run_revision,
      created_at, last_people_activity_at, state_changed_at, updated_at
    ) VALUES (1,'S','W',NULL,0,'global','authoritative',1,'T','','','workspace',
              'idle','s',1,1,0,0,0,0,0,0,0,1,1,1,1)`);
  sql.exec(`INSERT INTO substreams (id,kind,inherit_mode,depth,return_mode,audience,tool_policy,status,created_at)
    VALUES ('0','main','none',0,'none','workspace','full','open',1)`);
  return {
    storage: new WorkstreamMessageStorage(binding),
    transcript: new WorkstreamTranscriptStorage(binding),
    sql,
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "message-1",
    clientMessageId: "client-1",
    authorType: "agent" as const,
    authorUserId: null,
    externalActorJson: null,
    messageType: "text" as const,
    text: "What changed?",
    structuredContentJson: null,
    producedByRunId: null,
    now: NOW,
    ...overrides,
  };
}

describe("appending to the transcript", () => {
  it("takes one sequence number and one attention ordinal, and moves both counters", async () => {
    const { storage, sql } = open();

    expect(await storage.appendMessage(message())).toEqual({
      outcome: "appended",
      messageId: "message-1",
      sequenceNumber: 1,
    });

    // Two halves of one fact that used to live in two statements: the retired
    // trigger advanced `next_attention_ordinal` and the people clock, and the
    // caller's own `UPDATE workstreams` advanced `next_sequence_number`.
    expect(sql.exec(
      `SELECT sequence_number, attention_ordinal, role, author_type, visibility, content
         FROM canonical_conversation_turn_details`,
    ).toArray()).toEqual([{
      sequence_number: 1,
      attention_ordinal: 1,
      role: "assistant",
      author_type: "agent",
      visibility: "people",
      content: "What changed?",
    }]);
    expect(sql.exec(
      `SELECT next_sequence_number, next_attention_ordinal, last_people_activity_at
         FROM workstream`,
    ).toArray()).toEqual([{
      next_sequence_number: 2,
      next_attention_ordinal: 2,
      last_people_activity_at: NOW,
    }]);
  });

  it("answers a redelivery with the row the first delivery wrote", async () => {
    const { storage, sql } = open();
    await storage.appendMessage(message());

    // Every transcript write here is keyed by an id derived from what caused it
    // — a Slack delivery, a harness run, a digest — so a redelivery naming the
    // same id is ordinary. The routed statement expressed this as
    // `ON CONFLICT(workstream_id, client_message_id) DO NOTHING` and then
    // re-read the table to find out what had happened.
    expect(await storage.appendMessage(message({ messageId: "message-2", text: "again" })))
      .toEqual({ outcome: "replayed", messageId: "message-1", sequenceNumber: 1 });
    expect(sql.exec(`SELECT COUNT(*) AS n FROM participant_transcript_turns`).one().n).toBe(1);
    // And the counters do not move for a message that was not written.
    expect(sql.exec(`SELECT next_sequence_number FROM workstream`).one().next_sequence_number)
      .toBe(2);
  });

  it("maps each author vocabulary onto the role and author the object stores", async () => {
    const { storage, sql } = open();
    await storage.appendMessage(message({ authorType: "agent", authorUserId: null }));
    await storage.appendMessage(message({
      messageId: "message-2",
      clientMessageId: "client-2",
      authorType: "external",
      authorUserId: null,
      externalActorJson: JSON.stringify({ provider: "slack", displayName: "Ana" }),
    }));
    await storage.appendMessage(message({
      messageId: "message-3",
      clientMessageId: "client-3",
      authorType: "system",
      authorUserId: null,
    }));

    // The retired trigger's mapping, which is not one-to-one: `external` is a
    // `user` role written by an `external` author, because what a person says
    // through Slack is still something a person said.
    expect(sql.exec(`SELECT id, role, author_type FROM canonical_conversation_turn_details ORDER BY sequence_number`).toArray())
      .toEqual([
        { id: "message-1", role: "assistant", author_type: "agent" },
        { id: "message-2", role: "user", author_type: "external" },
        { id: "message-3", role: "system", author_type: "system" },
      ]);
  });

  it("reads a message back in the vocabulary the retired view projected", async () => {
    const { storage } = open();
    await storage.appendMessage(message());

    // `agent` comes back in the reader's vocabulary, and `content` as
    // `text_content`. Callers still speak the view's names; what changed is
    // that nothing translates them in SQL on every read.
    expect(storage.messageByClientId({ clientMessageId: "client-1" })).toMatchObject({
      id: "message-1",
      author_type: "agent",
      author_user_id: null,
      text_content: "What changed?",
      sequence_number: 1,
    });
    expect(storage.messageByClientId({ clientMessageId: "absent" })).toBeUndefined();
  });
});

describe("the windows a reader asks for", () => {
  /** A transcript with one of each type the two readers disagree about. */
  async function mixed(storage: WorkstreamMessageStorage): Promise<void> {
    await storage.appendMessage(message({ messageId: "m1", clientMessageId: "c1", messageType: "text", text: "First" }));
    await storage.appendMessage(message({ messageId: "m2", clientMessageId: "c2", messageType: "system", text: "Host notice", now: NOW + 1_000 }));
    await storage.appendMessage(message({ messageId: "m4", clientMessageId: "c4", messageType: "text", text: "  ", now: NOW + 3_000 }));
    await storage.appendMessage(message({ messageId: "m5", clientMessageId: "c5", messageType: "text", text: "Last", now: NOW + 4_000 }));
  }

  it("answers naming's question and the description's differently, from the same rows", async () => {
    const { storage } = open();
    await mixed(storage);

    // Naming names an `include`: only what someone typed. The host notice and
    // the tool card are both excluded, and so is the whitespace-only message —
    // an empty turn is not something said.
    expect(storage.saidMessages({ messageTypes: { include: ["text"] }, order: "oldest", limit: 10 })
      .map((row) => row.id)).toEqual(["m1", "m5"]);
    // The description names an `exclude`: everything but a tool card. The host
    // notice counts, because it is part of where the work stream has got to.
    // The two are different questions about a column with no CHECK constraint,
    // which is why one list could not serve both.
    expect(storage.saidMessages({ messageTypes: { exclude: ["tool"] }, order: "oldest", limit: 10 })
      .map((row) => row.id)).toEqual(["m1", "m2", "m5"]);
  });

  it("reads the newest end in reading order, and bounds what it counts", async () => {
    const { storage } = open();
    await mixed(storage);

    // The description takes the most recent messages and renders them oldest
    // first. Selecting `DESC` and reversing is the only way to do both.
    expect(storage.saidMessages({ messageTypes: { exclude: ["tool"] }, order: "newest", limit: 2 })
      .map((row) => row.id)).toEqual(["m2", "m5"]);
    expect(storage.saidMessageCount({ messageTypes: { exclude: ["tool"] }, limit: 10 })).toBe(3);
    // The ceiling is the caller's, and it binds: neither reader wants the count
    // of a work stream that has been talking for a year.
    expect(storage.saidMessageCount({ messageTypes: { exclude: ["tool"] }, limit: 2 })).toBe(2);
    // And the window, which is what makes the description's count about the
    // last 72 hours rather than about everything.
    expect(storage.saidMessageCount({
      messageTypes: { exclude: ["tool"] },
      limit: 10,
      since: NOW + 2_000,
    })).toBe(1);
  });

  it("finds a message at a transcript position", async () => {
    const { storage } = open();
    await mixed(storage);

    // Sequence-addressed reads need the exact row at the frozen boundary.
    expect(storage.messageAtSequence({ sequenceNumber: 2 })?.id).toBe("m2");
    expect(storage.messageAtSequence({ sequenceNumber: 99 })).toBeUndefined();
  });

  it("answers Terminal's admission check only for a participant's own message", async () => {
    const { storage, transcript, sql } = open();
    await transcript.appendParticipantMessage({
      turnId: "m1",
      actor: "human",
      authorUserId: "user-1",
      authorSnapshot: { displayName: "User at posting time", avatarUrl: null },
      clientMessageId: "c1",
      messageType: "text",
      text: "What changed?",
      structuredContentJson: null,
      externalActorJson: null,
      producedByRunId: null,
      messageSequenceNumber: 1,
      createdAtUtc: new Date(NOW).toISOString(),
      attentionOrdinal: 1,
    });
    sql.exec(
      `INSERT INTO participants
         (user_id, participation_reason, added_by_user_id, status, participant_epoch,
          added_at, removed_at, updated_at)
       VALUES ('user-1', 'message', 'user-1', 'active', 0, ?, NULL, ?)`,
      NOW,
      NOW,
    );

    expect(storage.messageFromParticipant({ messageId: "m1", authorUserId: "user-1" }))
      .toEqual({ text_content: "What changed?" });
    // A repository command runs with the sender's authorization, so a message
    // whose author is not this caller must not admit one.
    expect(storage.messageFromParticipant({ messageId: "m1", authorUserId: "user-2" }))
      .toBeUndefined();
    // And a member who has left cannot keep authorizing commands through a
    // message they sent before leaving.
    sql.exec(
      `UPDATE participants SET status = 'removed', removed_at = ? WHERE user_id = 'user-1'`,
      NOW,
    );
    expect(storage.messageFromParticipant({ messageId: "m1", authorUserId: "user-1" }))
      .toBeUndefined();
  });

  it("counts the attachments on the opening message only", async () => {
    const { storage, sql } = open();
    await storage.appendMessage(message({ messageId: "m1", clientMessageId: "c1" }));
    await storage.appendMessage(message({ messageId: "m2", clientMessageId: "c2", now: NOW + 1_000 }));
    for (const [part, resource, position] of [["m1", "r1", 0], ["m1", "r2", 1], ["m2", "r3", 0]] as const) {
      sql.exec(
        `INSERT INTO participant_transcript_attachments (turn_id, resource_id, position, attachment_json)
         VALUES (?, ?, ?, '{}')`,
        part,
        resource,
        position,
      );
    }

    // Creation telemetry asks what a member started the work stream *with*, so
    // it is sequence 1 and nothing else — an attachment added later is not part
    // of how the work stream was created.
    expect(storage.openingAttachmentCount()).toBe(2);
  });
});

describe("reading a page of transcript", () => {
  async function seed(storage: WorkstreamMessageStorage, count: number): Promise<void> {
    for (let index = 1; index <= count; index += 1) {
      await storage.appendMessage(message({
        messageId: `message-${index}`,
        clientMessageId: `client-${index}`,
        text: `line ${index}`,
        now: NOW + index,
      }));
    }
  }

  it("pages backward but answers in reading order", async () => {
    const { storage } = open();
    await seed(storage, 5);

    // Selected newest-first so the limit takes the *latest* page, answered
    // oldest-first so a caller can render it. The routed reader did that
    // reversal in TypeScript after the fact; it belongs with the query that
    // makes it necessary.
    expect(storage.messagesBefore({ beforeSequence: 4, limit: 2 })
      .map((row) => row.text_content)).toEqual(["line 2", "line 3"]);
    expect(storage.messagesAfter({ afterSequence: 3, limit: 10 })
      .map((row) => row.text_content)).toEqual(["line 4", "line 5"]);
  });

  it("reads mentions and attachments for a page in one query each", async () => {
    const { storage, sql } = open();
    await seed(storage, 2);
    sql.exec(
      `INSERT INTO participant_transcript_mentions
         (turn_id, mention_index, mention_kind, target_user_id, connector_type,
          start_offset, end_offset, attention_ordinal)
       VALUES ('message-1', 0, 'person', 'user-2', NULL, 0, 5, 1)`,
    );
    sql.exec(
      `INSERT INTO participant_transcript_attachments (turn_id, resource_id, position, attachment_json)
       VALUES ('message-2', 'resource-1', 0, ?)`,
      JSON.stringify({ attachedAt: new Date(NOW).toISOString() }),
    );
    // The descriptor the object froze when the resource was attached. The
    // retired reader's `JSON resources` join read exactly this, through a view
    // that `json_extract`ed it back out.
    sql.exec(
      `INSERT INTO workstream_resource_links
         (resource_id, attached_by_user_id, watch_enabled, relationship_type,
          resource_json, attached_at, updated_at)
       VALUES ('resource-1', NULL, 0, 'attachment', ?, ?, ?)`,
      JSON.stringify({
        id: "resource-1",
        title: "notes.md",
        mimeType: "text/markdown",
        contentRef: "r2://notes",
        metadata: { size: 4096 },
      }),
      NOW,
      NOW,
    );

    // One read per page rather than one per row. The link is what the object
    // owns; the resource behind it is still read from `resources` by the
    // caller, because the object's own copy of the descriptor is frozen at
    // attach time and swapping a live read for it is the resources slice's
    // decision to make.
    expect(storage.mentionsFor({ messageIds: ["message-1", "message-2"] }))
      .toEqual([{
        part_id: "message-1",
        mention_kind: "person",
        target_user_id: "user-2",
        connector_type: null,
        start_offset: 0,
        end_offset: 5,
      }]);
    expect(storage.attachmentsFor({ messageIds: ["message-1", "message-2"] }))
      .toEqual([{
        part_id: "message-2",
        resource_id: "resource-1",
        position: 0,
        title: "notes.md",
        mime_type: "text/markdown",
        content_ref: "r2://notes",
        metadata_json: JSON.stringify({ size: 4096 }),
        attached_at: NOW,
      }]);
    // An empty page asks nothing, rather than building a query with no
    // placeholders in its `IN` list.
    expect(storage.mentionsFor({ messageIds: [] })).toEqual([]);
  });

  it("answers for a removed member as well as a current one, and for no one else", () => {
    const { storage, sql } = open();
    sql.exec(
      `INSERT INTO participants
         (user_id, participation_reason, added_by_user_id, status, participant_epoch,
          added_at, removed_at, updated_at)
       VALUES ('user-1', 'message', 'user-1', 'active', 0, ?, NULL, ?)`,
      NOW,
      NOW,
    );
    sql.exec(
      `INSERT INTO participants
         (user_id, participation_reason, added_by_user_id, status, participant_epoch,
          added_at, removed_at, updated_at)
       VALUES ('user-2', 'message', 'user-1', 'removed', 0, ?, ?, ?)`,
      NOW,
      NOW,
      NOW,
    );

    // `user-2` is the case that matters. The retired
    // `_runtime_workstream_participants` upsert kept a removed member's row and
    // set `status = 'removed'`, and `_runtime_users` selected `FROM
    // participants` with no status predicate — so a removed author did join,
    // and rendered with the same fabricated name as anyone else. `user-3` never
    // joined at all, and is the only author the view answered nothing for.
    expect(storage.authorsFor({ userIds: ["user-1", "user-2", "user-3"] }))
      .toEqual([{ user_id: "user-1", added_at: NOW }, { user_id: "user-2", added_at: NOW }]);
  });
});
