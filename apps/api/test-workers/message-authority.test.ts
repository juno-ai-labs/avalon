/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The durable transcript authority, on real workerd.
 *
 * The Node suite proves what the SQL decides — which columns an append writes,
 * which counters it moves, what a page contains. None of that needs the
 * runtime. Three things this slice claims do:
 *
 * - that an append and the directory projection it feeds are *one* commit,
 *   because `/internal/messages` runs the operation inside
 *   `commitRuntimeMutation` and nothing below the endpoint knows that;
 * - that the read-then-insert replay check inside `appendMessage` is atomic,
 *   which needs a `transactionSync` that can actually roll back rather than the
 *   Node double's `(body) => body()`;
 * - that a misrouted stub is refused before it writes into another work
 *   stream's transcript, which the Node double skips entirely.
 */

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { asSubstreamId } from "@rally/contracts";

import { substreamAgentName } from "../src/durable-objects/names";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import {
  WORKSPACE_ID,
  WORKSTREAM_ID,
  boot,
  post,
  seedParticipantMessage,
  seedOpenWorkstreamAuthority,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

beforeAll(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
});

let unique = 0;
/** A fresh object per test; a reused id would carry the last test's rows. */
function agent(): DurableObjectStub {
  unique += 1;
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    substreamAgentName(
      "global",
      WORKSPACE_ID,
      WORKSTREAM_ID,
      asSubstreamId(`00000000-0000-7000-8000-${String(unique).padStart(12, "0")}`),
    ),
  ));
}

/** Call the real endpoint, exactly as the Worker's port does. */
async function messages(
  stub: DurableObjectStub,
  operation: string,
  ...args: unknown[]
): Promise<{ status: number; value: unknown; error?: string }> {
  const { status, body } = await post(stub, "/internal/messages", {
    workspaceId: WORKSPACE_ID,
    workstreamId: WORKSTREAM_ID,
    operation,
    args,
  });
  const parsed = body as { value?: unknown; error?: string } | null;
  return { status, value: parsed?.value ?? null, ...(parsed?.error ? { error: parsed.error } : {}) };
}

function append(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: "00000000-0000-7000-8000-00000000ms01",
    clientMessageId: "client-1",
    authorType: "system",
    authorUserId: null,
    externalActorJson: null,
    messageType: "system",
    text: "The deploy finished.",
    structuredContentJson: null,
    producedByRunId: null,
    now: 1_787_000_000_000,
    ...overrides,
  };
}

describe("message authority on real workerd", () => {
  it("commits the appended row and the directory projection in one step", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const result = await messages(stub, "appendMessage", append());

    expect(result.status).toBe(200);
    expect(result.value).toMatchObject({ outcome: "appended", sequenceNumber: 1 });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM participant_transcript_turns WHERE entry_kind = 'conversation'`,
      ).one().count).toBe(1);
      const transcript = new WorkstreamTranscriptStorage(state.storage)
        .createOpeningSnapshot({ unreadHighWaterAttentionOrdinal: null });
      expect(transcript.ranges[0]!.turns[0]).toMatchObject({
        actor: "system",
        clientMessageId: "client-1",
        blocks: [{ type: "text", text: "The deploy finished.", messageType: "system" }],
      });
      // A transcript write changes the work stream's preview and its people
      // clock, both of which the sidebar reads. The routed path republished
      // that projection because the object matched `messages` in statement
      // text; running the operation inside `commitRuntimeMutation` is what
      // replaces it, and this is the assertion the conversion itself could not
      // make — the Node double calls the storage method directly.
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM projection_keys WHERE projection_key = 'common'`,
      ).one().count).toBe(1);
    });
  });

  it("rejects the retired compatibility tool-message operation without writing", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));
    const result = await messages(stub, "upsertToolMessage", {
      messageId: "tool-1",
      clientMessageId: "tool:tool-1",
      structuredContentJson: JSON.stringify({
        invocation: { toolName: "search", status: "pending" },
      }),
      createdAt: 1_787_000_010_000,
      editedAt: null,
    });

    expect(result).toMatchObject({ status: 400, error: "invalid_message_operation" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM participant_transcript_turns`,
      ).one().count).toBe(0);
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM durable_outbox`,
      ).one().count).toBe(0);
    });
  });

  it("leaves no projection behind for a read", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const result = await messages(stub, "messageByClientId", { clientMessageId: "client-1" });

    // Reads are the majority of this port's traffic. Committing a projection
    // for one would republish the sidebar on every transcript page a member
    // scrolls, which is why `mutatesTranscript` names the writers rather than
    // the endpoint assuming.
    expect(result.status).toBe(200);
    expect(result.value).toBeNull();
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM projection_keys`,
      ).one().count).toBe(0);
    });
  });

  it("answers a redelivery with the first row and takes no second position", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));
    await messages(stub, "appendMessage", append());

    // The replay check reads the canonical message records and then inserts, inside one
    // `transactionSync`. Over `node:sqlite` that transaction is a function
    // call; here it is the runtime's, which is what makes the read and the
    // write one decision rather than two.
    const replay = await messages(stub, "appendMessage", append({
      messageId: "00000000-0000-7000-8000-00000000ms02",
      now: 1_787_000_005_000,
    }));

    expect(replay.value).toMatchObject({
      outcome: "replayed",
      messageId: "00000000-0000-7000-8000-00000000ms01",
      sequenceNumber: 1,
    });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM participant_transcript_turns WHERE entry_kind = 'conversation'`,
      ).one().count).toBe(1);
      expect(state.storage.sql.exec(
        `SELECT next_sequence_number FROM workstream`,
      ).one().next_sequence_number).toBe(2);
    });
  });

  it("refuses a request naming another work stream", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const { status, body } = await post(stub, "/internal/messages", {
      workspaceId: WORKSPACE_ID,
      workstreamId: "00000000-0000-7000-8000-0000000000ff",
      operation: "appendMessage",
      args: [append()],
    });

    // A misrouted stub must fail rather than write a member's message into
    // somebody else's transcript. The check is against the object's own
    // identity row, not against the request that carried the ids.
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "workstream_message_identity_mismatch" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns`).one().count).toBe(0);
    });
  });

  it("refuses a write against an object that is no longer the authority", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => {
      seedWorkstreamRoot(state);
      state.storage.sql.exec(`UPDATE workstream SET authority_mode = 'quarantined' WHERE id = 1`);
    });

    const result = await messages(stub, "appendMessage", append());

    expect(result.status).toBe(409);
    expect(result.error).toBe("workstream_runtime_authority_fenced");
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns`).one().count).toBe(0);
    });
  });

  it("answers the description window's read through the endpoint", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));
    await messages(stub, "appendMessage", append());

    const count = await messages(stub, "saidMessageCount", {
      messageTypes: { exclude: ["tool"] },
      limit: 601,
      since: null,
    });
    const window = await messages(stub, "saidMessages", {
      messageTypes: { exclude: ["tool"] },
      order: "newest",
      limit: 200,
    });

    expect(count.value).toBe(1);
    expect(window.status).toBe(200);
    expect(window.value).toHaveLength(1);
  });

  it("reads a page wider than one statement can bind", async () => {
    const stub = agent();
    await boot(stub);
    const messageIds = Array.from({ length: 250 }, (_, index) => `m${String(index).padStart(3, "0")}`);
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state);
      for (const [index, id] of messageIds.entries()) {
        await seedParticipantMessage(state, {
          id,
          sequence: index + 1,
          text: "hi",
          authorUserId: `u${index}`,
          clientMessageId: `c${index}`,
          attentionOrdinal: index + 1,
          now: 1,
        });
        state.storage.sql.exec(
          `INSERT INTO participant_transcript_mentions
             (turn_id, mention_index, mention_kind, target_user_id, connector_type,
              start_offset, end_offset, attention_ordinal)
           VALUES (?, 0, 'person', ?, NULL, 0, 1, 1)`,
          id,
          `u${index}`,
        );
        state.storage.sql.exec(
          `INSERT INTO participants
             (user_id, participation_reason, added_by_user_id, status, participant_epoch,
              added_at, removed_at, updated_at)
           VALUES (?, 'message', ?, 'active', 0, 1, NULL, 1)`,
          `u${index}`,
          `u${index}`,
        );
        state.storage.sql.exec(
          `INSERT INTO workstream_resource_links
             (resource_id, attached_by_user_id, watch_enabled, relationship_type,
              resource_json, attached_at, updated_at)
           VALUES (?, NULL, 0, 'attachment', '{}', 1, 1)`,
          `r${index}`,
        );
        state.storage.sql.exec(
          `INSERT INTO participant_transcript_attachments (turn_id, resource_id, position, attachment_json)
           VALUES (?, ?, 0, '{}')`,
          id,
          `r${index}`,
        );
      }
    });

    // 250 is what `transcriptLister` asks the object for, and this engine binds
    // 100 parameters per statement. An unchunked `IN` list does not return a
    // short answer — the statement is refused and the whole page fails. Only
    // the runtime has that ceiling; `node:sqlite` accepts far more, which is
    // why this cannot live in the Node suite.
    const mentions = await messages(stub, "mentionsFor", { messageIds });
    const attachments = await messages(stub, "attachmentsFor", { messageIds });
    const authors = await messages(stub, "authorsFor", {
      userIds: messageIds.map((_, index) => `u${index}`),
    });

    expect(mentions.status).toBe(200);
    expect(mentions.value).toHaveLength(250);
    expect(attachments.value).toHaveLength(250);
    expect(authors.value).toHaveLength(250);
  });

  it("refuses an operation that is not on the contract", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const { status, body } = await post(stub, "/internal/messages", {
      workspaceId: WORKSPACE_ID,
      workstreamId: WORKSTREAM_ID,
      operation: "dropEverything",
      args: [],
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: "invalid_message_operation" });
  });

  it("refuses malformed append arguments at the object boundary", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const result = await messages(stub, "appendMessage", { ...append(), now: "not-a-clock" });

    expect(result).toMatchObject({ status: 400, error: "invalid_message_operation" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns`).one().count).toBe(0);
    });
  });

  it("refuses human authors on the unauthenticated runtime-writer port", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const result = await messages(stub, "appendMessage", {
      ...append(),
      authorType: "human",
      authorUserId: "user-1",
      messageType: "text",
      text: "This must use the authenticated participant path.",
    });

    expect(result).toMatchObject({ status: 400, error: "invalid_message_operation" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM participant_transcript_turns`,
      ).one().count).toBe(0);
    });
  });

  it("refuses an append too large for the participant message contract before writing", async () => {
    const stub = agent();
    await boot(stub);
    await runInDurableObject(stub, (_instance, state) => seedWorkstreamRoot(state));

    const result = await messages(stub, "appendMessage", {
      ...append(),
      text: "x".repeat(100_001),
    });

    expect(result).toMatchObject({ status: 400, error: "invalid_message_operation" });
    await runInDurableObject(stub, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count FROM participant_transcript_turns`).one().count).toBe(0);
      expect(state.storage.sql.exec(
        `SELECT next_sequence_number FROM workstream`,
      ).one().next_sequence_number).toBe(1);
    });
  });
});
