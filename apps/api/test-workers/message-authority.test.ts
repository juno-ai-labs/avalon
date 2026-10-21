/// <reference types="@cloudflare/vitest-pool-workers/types" />

/**
 * The durable transcript authority, on real workerd.
 *
 * Fixtures bootstrap objects without admitting agent runs or calling providers.
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
import { beforeEach, describe, expect, it } from "vitest";

import { asSubstreamId } from "@rally/contracts";

import { conversationObjectName } from "../src/durable-objects/names";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { useHeldEffectQueue } from "./helpers/effect-queue-hold";
import { pendingChildEffects } from "./helpers/conversation-effects";
import {
  WORKSPACE_ID,
  WORKSTREAM_ID,
  boot,
  post,
  seedParticipantMessage,
  seedOpenWorkstreamAuthority,
  seedWorkstreamRoot,
} from "./helpers/substream-fixture";

beforeEach(async () => {
  await seedOpenWorkstreamAuthority(env.DB);
  // Generous, and only because of the interleave: a sibling file's `reset()`
  // takes every object's input gate, so this hook can wait out a full reset
  // before it gets to run at all. The seed itself takes milliseconds — a
  // failure here is a hang, never a slow query.
}, 30_000);

let unique = 0;
/** A fresh object per test; a reused id would carry the last test's rows. */
function agent(): DurableObjectStub {
  unique += 1;
  return env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
    conversationObjectName(
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
  describe("source merge notices", () => {
    useHeldEffectQueue();

    it.each([false, true])("preserves every reader's unread state (existing unread: %s)", async (alreadyUnread) => {
      const stub = agent();
      await boot(stub);
      const merger = "00000000-0000-4000-8000-000000000111";
      const reader = "00000000-0000-4000-8000-000000000112";
      await runInDurableObject(stub, (_instance, state) => {
        seedWorkstreamRoot(state);
        for (const userId of [merger, reader]) {
          state.storage.sql.exec(`INSERT INTO participants
            (user_id, participation_reason, added_by_user_id, status, participant_epoch, added_at, updated_at)
            VALUES (?, 'creator', ?, 'active', 0, 1, 1)`, userId, merger);
        }
      });
      if (alreadyUnread) {
        expect((await messages(stub, "appendMessage", append())).status).toBe(200);
      }
      const notice = append({
        messageId: "merge-notice", clientMessageId: "merge-notice", text: "Merged into Thread",
        structuredContentJson: JSON.stringify({
          type: "conversation_merged_into", schemaVersion: 1, mergedByUserId: merger,
          messageId: "destination-merge", actingAgent: false,
          mergedInto: { kind: "thread", id: WORKSTREAM_ID, title: "Thread" },
        }),
        now: 1_787_000_005_000,
      });
      expect((await messages(stub, "appendMessage", notice)).value).toMatchObject({ outcome: "appended" });
      expect((await messages(stub, "appendMessage", notice)).value).toMatchObject({ outcome: "replayed" });

      const effects = (await pendingChildEffects(stub)).map((envelope) => envelope.effect);
      for (const userId of [merger, reader]) {
        expect(effects.filter((effect) => effect.kind === "directory_user" && effect.userId === userId).at(-1))
          .toMatchObject({ unreadCount: alreadyUnread ? 1 : 0, youAreMentioned: false });
      }
      await runInDurableObject(stub, (_instance, state) => {
        const transcript = new WorkstreamTranscriptStorage(state.storage).createOpeningSnapshot({
          unreadHighWaterAttentionOrdinal: alreadyUnread ? 1 : null,
        });
        expect(transcript.unreadAnchorSequence).toBe(alreadyUnread ? 1 : null);
        expect(transcript.ranges.flatMap((range) => range.turns).find((turn) => turn.turnId === "merge-notice"))
          .toMatchObject({ actor: "system", attentionOrdinal: null, blocks: [{ type: "text", text: "Merged into Thread" }] });
        expect(state.storage.sql.exec(`SELECT next_attention_ordinal, last_people_activity_at FROM workstream`).one())
          .toEqual({ next_attention_ordinal: alreadyUnread ? 2 : 1, last_people_activity_at: alreadyUnread ? 1_787_000_000_000 : 1 });
      });

      // The next ordinary message still gets the next unread ordinal.
      expect((await messages(stub, "appendMessage", append({ messageId: "after", clientMessageId: "after" }))).status).toBe(200);
      expect((await messages(stub, "messageByClientId", { clientMessageId: "after" })).value)
        .toMatchObject({ attention_ordinal: alreadyUnread ? 2 : 1 });
    });
  });

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
