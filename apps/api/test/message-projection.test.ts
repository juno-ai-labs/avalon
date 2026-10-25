import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { applyWorkstreamObjectSchema } from "../src/durable-objects/workstream-object-schema";
import { WorkstreamMessageStorage } from "../src/durable-objects/workstream-message-storage";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import type { MessageObjectPort } from "../src/durable-objects/workstream-message-protocol";
import { MESSAGE_OPERATIONS } from "../src/durable-objects/workstream-message-protocol";
import { readMessage, transcriptLister } from "../src/runtime/message-projection";
import { createCloudflareTestBinding } from "./helpers/cloudflare-test";
import { createTestSqlStorage } from "./helpers/sql-storage";

const WORKSPACE = "1629dee4-8cc4-4531-81f9-b2be8614e062";
const WORKSTREAM = "8f2e1d40-5c3b-4a9e-9d21-6f7c8b0a1234";
const NOW = 1_787_000_000_000;
const IDENTITY = { workspaceId: WORKSPACE, workstreamId: WORKSTREAM };

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

/**
 * The object, and a port over it, with no transport in between.
 *
 * What this covers is the assembly the retired reader did inside its query: the
 * author, the mentions, the attachments and the page order. Whether the round
 * trip carrying it is atomic is the runtime's question and belongs in
 * `test-workers/`.
 */
function open(): {
  storage: WorkstreamMessageStorage;
  transcript: WorkstreamTranscriptStorage;
  port: MessageObjectPort;
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
    ) VALUES (1,?,?,NULL,0,'global','authoritative',1,'T','','','workspace',
              'idle','s',1,1,0,0,0,0,0,0,0,1,1,1,1)`, WORKSTREAM, WORKSPACE);
  sql.exec(`INSERT INTO substreams (id,kind,inherit_mode,depth,return_mode,audience,tool_policy,status,created_at)
    VALUES ('0','main','none',0,'none','workspace','full','open',1)`);
  const storage = new WorkstreamMessageStorage(binding);
  const port = Object.fromEntries(
    MESSAGE_OPERATIONS.map((operation) => [
      operation,
      async (...args: unknown[]) =>
        (storage[operation] as (...rest: unknown[]) => unknown).apply(storage, args),
    ]),
  ) as MessageObjectPort;
  return { storage, transcript: new WorkstreamTranscriptStorage(binding), port, sql };
}

async function append(
  storage: WorkstreamMessageStorage,
  index: number,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await storage.appendMessage({
    messageId: `message-${index}`,
    clientMessageId: `client-${index}`,
    authorType: "agent",
    authorUserId: null,
    externalActorJson: null,
    messageType: "text",
    text: `line ${index}`,
    structuredContentJson: null,
    producedByRunId: null,
    now: NOW + index,
    ...overrides,
  });
}

describe("the transcript the harness reads", () => {
  it("walks backward a page at a time and hands back reading order", async () => {
    const { storage, port } = open();
    for (let index = 1; index <= 5; index += 1) await append(storage, index);
    const list = transcriptLister(port, IDENTITY);

    // The fence walk the harness does: take the newest page, then page backward
    // from its first sequence until it reaches the prior compaction. Each page
    // comes back oldest-first, which is the order the model is given.
    const newest = await list(WORKSPACE, WORKSTREAM, 2);
    expect(newest.map((message) => message.textContent)).toEqual(["line 4", "line 5"]);
    const older = await list(WORKSPACE, WORKSTREAM, 2, newest[0]!.sequenceNumber);
    expect(older.map((message) => message.textContent)).toEqual(["line 2", "line 3"]);
  });

  it("caps a page at the limit the repository capped it at", async () => {
    const { storage, port } = open();
    for (let index = 1; index <= 3; index += 1) await append(storage, index);
    const asked: Array<{ beforeSequence: number; limit: number }> = [];
    const recording: MessageObjectPort = {
      ...port,
      messagesBefore: async (input) => {
        asked.push(input);
        return port.messagesBefore(input);
      },
    };

    await transcriptLister(recording, IDENTITY)(WORKSPACE, WORKSTREAM, 1_000);
    await transcriptLister(recording, IDENTITY)(WORKSPACE, WORKSTREAM, 10, 7);

    // Asserted on what the object is asked for, not on how many rows a small
    // fixture happens to hold. The cap is 250 and the cursor is exclusive with
    // no default — both are the walk's contract rather than suggestions: the
    // loader pages until a page comes back short, so a reader that quietly
    // answered with more, or started somewhere else, would end the walk early.
    expect(asked).toEqual([
      { beforeSequence: Number.MAX_SAFE_INTEGER, limit: 250 },
      { beforeSequence: 7, limit: 10 },
    ]);
  });

  it("assembles the author, mentions and attachments the query used to aggregate", async () => {
    const { transcript, port, sql } = open();
    await transcript.appendParticipantMessage({
      turnId: "message-1",
      actor: "human",
      authorUserId: "user-1",
      authorSnapshot: { displayName: "User at posting time", avatarUrl: null },
      clientMessageId: "client-1",
      messageType: "text",
      text: "line 1",
      structuredContentJson: null,
      externalActorJson: null,
      producedByRunId: null,
      messageSequenceNumber: 1,
      createdAtUtc: new Date(NOW + 1).toISOString(),
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
    sql.exec(
      `INSERT INTO participant_transcript_mentions
         (turn_id, mention_index, mention_kind, target_user_id, connector_type,
          start_offset, end_offset, attention_ordinal)
       VALUES ('message-1', 0, 'person', 'user-2', NULL, 0, 5, 1)`,
    );
    sql.exec(
      `INSERT INTO participant_transcript_attachments (turn_id, resource_id, position, attachment_json)
       VALUES ('message-1', 'resource-1', 0, '{}')`,
    );
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

    const message = await readMessage(port, IDENTITY, "client-1");

    expect(message).toMatchObject({
      id: "message-1",
      workspaceId: WORKSPACE,
      workstreamId: WORKSTREAM,
      textContent: "line 1",
      sequenceNumber: 1,
      // Still not a full profile (an empty email, no avatar), but the name is
      // the turn's own snapshot: the member's id stood in for it until a model
      // was handed that id as a person's display name.
      author: {
        type: "human",
        user: { id: "user-1", name: "User at posting time", email: "", avatarUrl: null, timezone: "UTC" },
      },
      mentions: [{ type: "person", userId: "user-2", displayName: "user-2", avatarUrl: null }],
      attachments: [{
        id: "resource-1",
        fileName: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 4096,
        contentAvailable: true,
      }],
    });
  });

  it("gives an agent message no author identity to look up", async () => {
    const { storage, port } = open();
    await append(storage, 1, { authorType: "agent", authorUserId: null });

    // An agent message has no member behind it, and the retired reader's
    // `LEFT JOIN users` produced nothing for it. Reading a participant row here
    // would be reading one that cannot exist.
    expect(await readMessage(port, IDENTITY, "client-1"))
      .toMatchObject({ author: { type: "agent" } });
  });

  it("carries an external actor through instead of an author", async () => {
    const { storage, port } = open();
    await append(storage, 1, {
      authorType: "external",
      authorUserId: null,
      externalActorJson: JSON.stringify({
        provider: "slack",
        providerAccountId: "T-1",
        providerUserId: "U-1",
        displayName: "Ana",
        avatarUrl: null,
      }),
    });

    // What a person said through Slack. Avalon has no account for them, so the
    // actor payload is the identity, and it takes precedence over the author
    // columns exactly as the retired reader's `toMessage` had it.
    expect(await readMessage(port, IDENTITY, "client-1")).toMatchObject({
      author: { type: "external", actor: { provider: "slack", displayName: "Ana" } },
    });
  });

  it("falls back to the author columns when the stored actor does not parse", async () => {
    const { storage, port } = open();
    await append(storage, 1, {
      authorType: "external",
      authorUserId: null,
      externalActorJson: JSON.stringify({ provider: "slack", displayName: "Ana" }),
    });

    // Half an actor, which is what a connector writing an older payload shape
    // would leave. The retired `toMessage` ran `safeParse` here and fell
    // through on failure; publishing this one unparsed would put a value that
    // is not an `ExternalActor` in front of every client on the work stream.
    expect(await readMessage(port, IDENTITY, "client-1"))
      .toMatchObject({ author: { type: "system" } });
  });
});
