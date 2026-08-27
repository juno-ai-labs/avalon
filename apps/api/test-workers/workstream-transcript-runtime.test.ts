/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { substreamAgentName } from "../src/durable-objects/names";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000701");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000702");

beforeEach(async () => reset());

describe("work-stream transcript on workerd SQLite", () => {
  it("refuses to renumber while a client holds an immutable transcript snapshot", async () => {
    const id = env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    );
    const stub = env.SUBSTREAM_AGENTS.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      const pair = new WebSocketPair();
      const server = pair[1];
      state.acceptWebSocket(server);
      server.serializeAttachment({
        connectionId: "00000000-0000-7000-8000-000000000710",
        workspaceId: WORKSPACE_ID,
        workstreamId: WORKSTREAM_ID,
        substreamId: "0",
        userId: "00000000-0000-7000-8000-000000000711",
        connectedAt: "2026-08-26T00:00:00.000Z",
        afterSequence: 0,
        subscribed: true,
        snapshotInFlight: false,
        transcriptSnapshot: {
          snapshotId: "snapshot-before-backfill",
          snapshotThrough: 1,
          snapshotAtUtc: "2026-08-26T00:00:00.000Z",
        },
      });

      await expect(instance.backfillLegacyTranscript({
        objectId: id.toString(),
        operatorRunId: "00000000-0000-7000-8000-000000000712",
        cutoverVersion: 27,
      })).rejects.toThrow("legacy_transcript_backfill_live_snapshot");
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count
        FROM legacy_transcript_backfills`).one().count).toBe(0);
    });
  });

  it("refuses to create a successful no-op receipt for an auxiliary substream", async () => {
    const id = env.SUBSTREAM_AGENTS.idFromName("auxiliary-substream-backfill-test");
    const stub = env.SUBSTREAM_AGENTS.get(id);
    await runInDurableObject(stub, async (instance, state) => {
      state.storage.sql.exec(`INSERT INTO substream_agent_identity
        (id, external_substream_id, created_at, updated_at)
        VALUES (1, '00000000-0000-7000-8000-000000000703', 0, 0)`);
      await expect(instance.backfillLegacyTranscript({
        objectId: id.toString(),
        operatorRunId: "00000000-0000-7000-8000-000000000700",
        cutoverVersion: 27,
      })).rejects.toThrow("legacy_transcript_backfill_requires_main_substream");
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count
        FROM legacy_transcript_backfills`).one().count).toBe(0);
    });
  });

  it("backfills through the production RPC with a real PITR bookmark and reconciles replay", async () => {
    const id = env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    );
    const stub = env.SUBSTREAM_AGENTS.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const cutover = Number(state.storage.sql.exec<{ applied_at: number }>(
        `SELECT applied_at FROM _sql_schema_migrations WHERE version = 27`,
      ).one().applied_at);
      state.storage.sql.exec(`INSERT INTO substreams
        (id, kind, inherit_mode, depth, return_mode, audience, tool_policy, status, created_at)
        VALUES ('0', 'main', 'none', 0, 'none', 'workspace', 'full', 'open', ?)` , cutover - 1);
      state.storage.sql.exec(`INSERT INTO parts
        (id, substream_id, sequence_number, attention_ordinal, role, kind, author_type,
         author_user_id, content, client_message_id, visibility, pinned, message_type,
         created_at, updated_at)
        VALUES ('legacy-workerd', '0', 1, 1, 'user', 'text', 'member', 'user-1',
                'Legacy', 'legacy-workerd-client', 'both', 0, 'text', ?, ?)`,
      cutover - 1, cutover - 1);
    });

    const first = await stub.backfillLegacyTranscript({
      objectId: id.toString(),
      operatorRunId: "00000000-0000-7000-8000-000000000701",
      cutoverVersion: 27,
    });
    expect(first).toMatchObject({
      applied: true,
      verified: true,
      sourcePartCount: 1,
      participantTurnCount: 1,
    });
    expect(first.preBackfillBookmark.length).toBeGreaterThan(0);

    const replay = await stub.backfillLegacyTranscript({
      objectId: id.toString(),
      operatorRunId: "00000000-0000-7000-8000-000000000702",
      cutoverVersion: 27,
    });
    expect(replay).toMatchObject({ applied: false, verified: true });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count
        FROM participant_transcript_turns`).one().count).toBe(1);
      expect(state.storage.sql.exec(`SELECT COUNT(*) AS count
        FROM legacy_transcript_backfills`).one().count).toBe(1);
    });
  });

  it("commits the exact loop and participant projections atomically and preserves snapshot fences", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await runInDurableObject(stub, async (_instance, state) => {
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      await transcript.commitBindTransition({
        kind: "state_initialized",
        loopId: "run-workerd",
        generation: 1,
        stateRevision: 1,
        systemProjection: {
          revision: 1,
          rendererVersion: "workstream-system-v1",
          inputHash: "system-input",
          message: { role: "system", content: "System" },
        },
        nonSystemMessages: [{ role: "user", content: "Question" }],
        nonSystemMessageOrigins: [{
          originKind: "derived",
          sourceKind: "participant_turn",
          sourceId: "message-1",
          sourceRevision: 1,
        }],
      });
      await transcript.commitBindTransition({
        kind: "assistant_accepted",
        loopId: "run-workerd",
        generation: 1,
        stateRevision: 2,
        turnId: "run-workerd:turn:1",
        modelTurnIndex: 1,
        message: {
          role: "assistant",
          content: "Before",
          tool_calls: [{
            id: "provider-call",
            type: "function",
            function: { name: "search", arguments: "{}" },
          }],
        },
      });

      const snapshot = transcript.createOpeningSnapshot({ unreadHighWaterAttentionOrdinal: null });
      expect(snapshot.ranges[0]!.turns[0]!.blocks.map((block) => block.type))
        .toEqual(["text", "tool"]);
      expect(transcript.readBindProjection("run-workerd")?.nonSystemMessages.map((message) => message.role))
        .toEqual(["user", "assistant"]);
      expect(state.storage.sql.exec<{
        origin_kind: string;
        source_kind: string | null;
        source_id: string | null;
      } & Record<string, SqlStorageValue>>(
        `SELECT fact.origin_kind, fact.source_kind, fact.source_id
           FROM bind_loop_state_messages projected
           JOIN transcript_facts fact ON fact.fact_id = projected.fact_id
          WHERE projected.loop_id = 'run-workerd'
            AND projected.state_revision = 2
            AND projected.message_position = 1`,
      ).one()).toMatchObject({
        origin_kind: "derived",
        source_kind: "participant_turn",
        source_id: "message-1",
      });

      await transcript.appendParticipantMessage({
        turnId: "after-fence",
        actor: "human",
        authorUserId: "user-1",
        text: "After",
        createdAtUtc: new Date().toISOString(),
        attentionOrdinal: 1,
      });
      expect(transcript.range(snapshot, { startInclusive: 1, endExclusive: 10 }).covered)
        .toEqual({ startInclusive: 1, endExclusive: 2 });
    });
  });
});
