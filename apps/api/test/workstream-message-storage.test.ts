import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import { WorkstreamMessageStorage } from "../src/durable-objects/workstream-message-storage";
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
  return { storage: new WorkstreamMessageStorage(binding), sql };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    messageId: "message-1",
    clientMessageId: "client-1",
    authorType: "human" as const,
    authorUserId: "user-1",
    externalActorJson: null,
    messageType: "text",
    text: "What changed?",
    structuredContentJson: null,
    producedByRunId: null,
    now: NOW,
    ...overrides,
  };
}

describe("appending to the transcript", () => {
  it("takes one sequence number and one attention ordinal, and moves both counters", () => {
    const { storage, sql } = open();

    expect(storage.appendMessage(message())).toEqual({
      outcome: "appended",
      messageId: "message-1",
      sequenceNumber: 1,
    });

    // Two halves of one fact that used to live in two statements: the retired
    // trigger advanced `next_attention_ordinal` and the people clock, and the
    // caller's own `UPDATE workstreams` advanced `next_sequence_number`.
    expect(sql.exec(
      `SELECT sequence_number, attention_ordinal, role, author_type, visibility, content
         FROM parts`,
    ).toArray()).toEqual([{
      sequence_number: 1,
      attention_ordinal: 1,
      role: "user",
      author_type: "member",
      visibility: "both",
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

  it("answers a redelivery with the row the first delivery wrote", () => {
    const { storage, sql } = open();
    storage.appendMessage(message());

    // Every transcript write here is keyed by an id derived from what caused it
    // — a Slack delivery, a harness run, a digest — so a redelivery naming the
    // same id is ordinary. The routed statement expressed this as
    // `ON CONFLICT(workstream_id, client_message_id) DO NOTHING` and then
    // re-read the table to find out what had happened.
    expect(storage.appendMessage(message({ messageId: "message-2", text: "again" })))
      .toEqual({ outcome: "replayed", messageId: "message-1", sequenceNumber: 1 });
    expect(sql.exec(`SELECT COUNT(*) AS n FROM parts`).one().n).toBe(1);
    // And the counters do not move for a message that was not written.
    expect(sql.exec(`SELECT next_sequence_number FROM workstream`).one().next_sequence_number)
      .toBe(2);
  });

  it("maps each author vocabulary onto the role and author the object stores", () => {
    const { storage, sql } = open();
    storage.appendMessage(message({ authorType: "agent", authorUserId: null }));
    storage.appendMessage(message({
      messageId: "message-2",
      clientMessageId: "client-2",
      authorType: "external",
      authorUserId: null,
      externalActorJson: JSON.stringify({ provider: "slack", displayName: "Ana" }),
    }));
    storage.appendMessage(message({
      messageId: "message-3",
      clientMessageId: "client-3",
      authorType: "system",
      authorUserId: null,
    }));

    // The retired trigger's mapping, which is not one-to-one: `external` is a
    // `user` role written by an `external` author, because what a person says
    // through Slack is still something a person said.
    expect(sql.exec(`SELECT id, role, author_type FROM parts ORDER BY sequence_number`).toArray())
      .toEqual([
        { id: "message-1", role: "assistant", author_type: "agent" },
        { id: "message-2", role: "user", author_type: "external" },
        { id: "message-3", role: "system", author_type: "system" },
      ]);
  });

  it("reads a message back in the vocabulary the retired view projected", () => {
    const { storage } = open();
    storage.appendMessage(message());

    // `member` comes back as `human`, and `content` as `text_content`. Callers
    // still speak the view's names; what changed is that nothing translates
    // them in SQL on every read.
    expect(storage.messageByClientId({ clientMessageId: "client-1" })).toMatchObject({
      id: "message-1",
      author_type: "human",
      author_user_id: "user-1",
      text_content: "What changed?",
      sequence_number: 1,
    });
    expect(storage.messageByClientId({ clientMessageId: "absent" })).toBeUndefined();
  });
});

describe("a tool card in the transcript", () => {
  const card = (status: string) => JSON.stringify({
    invocation: { toolName: "linear.issue.get", status },
  });

  it("takes a sequence number but no attention ordinal, and leaves the people clock", () => {
    const { storage, sql } = open();

    expect(storage.upsertToolMessage({
      messageId: "invocation-1",
      clientMessageId: "tool:invocation-1",
      structuredContentJson: card("pending"),
      createdAt: NOW,
      editedAt: null,
    })).toEqual({ outcome: "appended", sequenceNumber: 1 });

    // A tool call is machinery a member did not do. It occupies a transcript
    // position, so it takes a sequence number; it is not something to come back
    // to, so it takes no attention ordinal and does not move the people clock.
    // That distinction was in the retired trigger rather than in any caller.
    expect(sql.exec(
      `SELECT sequence_number, attention_ordinal, tool_name, tool_status, visibility FROM parts`,
    ).toArray()).toEqual([{
      sequence_number: 1,
      attention_ordinal: null,
      tool_name: "linear.issue.get",
      tool_status: "pending",
      visibility: "people",
    }]);
    expect(sql.exec(
      `SELECT next_sequence_number, next_attention_ordinal, last_people_activity_at
         FROM workstream`,
    ).toArray()).toEqual([{
      next_sequence_number: 2,
      next_attention_ordinal: 1,
      last_people_activity_at: 1,
    }]);
  });

  it("refreshes the card in place when the call settles, without taking a second position", () => {
    const { storage, sql } = open();
    storage.upsertToolMessage({
      messageId: "invocation-1",
      clientMessageId: "tool:invocation-1",
      structuredContentJson: card("pending"),
      createdAt: NOW,
      editedAt: null,
    });

    // The same card, settled. Consuming another sequence number here would
    // leave a member with two rows for one tool call, which is why the routed
    // statement guarded its counter update on the insert having actually taken
    // the position it was about to consume.
    expect(storage.upsertToolMessage({
      messageId: "invocation-1",
      clientMessageId: "tool:invocation-1",
      structuredContentJson: card("completed"),
      createdAt: NOW,
      editedAt: NOW + 5_000,
    })).toEqual({ outcome: "refreshed", sequenceNumber: 1 });
    expect(sql.exec(`SELECT COUNT(*) AS n FROM parts`).one().n).toBe(1);
    expect(sql.exec(`SELECT tool_status, edited_at FROM parts`).toArray())
      .toEqual([{ tool_status: "completed", edited_at: NOW + 5_000 }]);
    expect(sql.exec(`SELECT next_sequence_number FROM workstream`).one().next_sequence_number)
      .toBe(2);
  });

  it("treats a started call as still pending, as the retired trigger did", () => {
    const { storage, sql } = open();
    storage.upsertToolMessage({
      messageId: "invocation-1",
      clientMessageId: "tool:invocation-1",
      structuredContentJson: card("started"),
      createdAt: NOW,
      editedAt: null,
    });

    // `started` is not a settled status. A tool the model has begun is still a
    // card a member is waiting on, and rendering it as completed would say the
    // work finished.
    expect(sql.exec(`SELECT tool_status FROM parts`).toArray())
      .toEqual([{ tool_status: "pending" }]);
  });
});

describe("reading a page of transcript", () => {
  function seed(storage: WorkstreamMessageStorage, count: number): void {
    for (let index = 1; index <= count; index += 1) {
      storage.appendMessage(message({
        messageId: `message-${index}`,
        clientMessageId: `client-${index}`,
        text: `line ${index}`,
        now: NOW + index,
      }));
    }
  }

  it("pages backward but answers in reading order", () => {
    const { storage } = open();
    seed(storage, 5);

    // Selected newest-first so the limit takes the *latest* page, answered
    // oldest-first so a caller can render it. The routed reader did that
    // reversal in TypeScript after the fact; it belongs with the query that
    // makes it necessary.
    expect(storage.messagesBefore({ beforeSequence: 4, limit: 2 })
      .map((row) => row.text_content)).toEqual(["line 2", "line 3"]);
    expect(storage.messagesAfter({ afterSequence: 3, limit: 10 })
      .map((row) => row.text_content)).toEqual(["line 4", "line 5"]);
  });

  it("reads mentions and attachments for a page in one query each", () => {
    const { storage, sql } = open();
    seed(storage, 2);
    sql.exec(
      `INSERT INTO part_mentions
         (part_id, mention_index, mention_kind, target_user_id, connector_type,
          start_offset, end_offset, attention_ordinal)
       VALUES ('message-1', 0, 'person', 'user-2', NULL, 0, 5, 1)`,
    );
    sql.exec(
      `INSERT INTO part_attachments (part_id, resource_id, position, attachment_json)
       VALUES ('message-2', 'resource-1', 0, ?)`,
      JSON.stringify({ fileName: "notes.md" }),
    );

    // One read per page rather than one per row, and the attachment's
    // descriptor comes from the object's own frozen copy — the routed reader
    // joined `resources` for it, which is what tied this read to a slice that
    // has not landed.
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
        attachment_json: JSON.stringify({ fileName: "notes.md" }),
      }]);
    // An empty page asks nothing, rather than building a query with no
    // placeholders in its `IN` list.
    expect(storage.mentionsFor({ messageIds: [] })).toEqual([]);
  });

  it("answers with a member's participant row, and nothing for one who has left", () => {
    const { storage, sql } = open();
    sql.exec(
      `INSERT INTO participants
         (user_id, participation_reason, added_by_user_id, status, participant_epoch,
          added_at, removed_at, updated_at)
       VALUES ('user-1', 'message', 'user-1', 'active', 0, ?, NULL, ?)`,
      NOW,
      NOW,
    );

    // The shape the retired `_runtime_users` view had, which is all the object
    // holds: a participant row. A member who authored a message and has since
    // been removed produced nothing through that view's `LEFT JOIN`, so they
    // produce nothing here either.
    expect(storage.authorsFor({ userIds: ["user-1", "user-2"] }))
      .toEqual([{ user_id: "user-1", added_at: NOW }]);
  });
});
