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
