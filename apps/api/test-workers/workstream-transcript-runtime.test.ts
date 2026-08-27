/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { asWorkspaceId, asWorkstreamId } from "@rally/contracts";

import { substreamAgentName } from "../src/durable-objects/names";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";
import { seedWorkstreamRoot } from "./helpers/substream-fixture";

const WORKSPACE_ID = asWorkspaceId("00000000-0000-7000-8000-000000000701");
const WORKSTREAM_ID = asWorkstreamId("00000000-0000-7000-8000-000000000702");

beforeEach(async () => reset());

describe("work-stream transcript on workerd SQLite", () => {
  it("commits the exact loop and participant projections atomically and preserves snapshot fences", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
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

  it("preserves two canonical compaction replacements and both completed edges", async () => {
    const stub = env.SUBSTREAM_AGENTS.get(env.SUBSTREAM_AGENTS.idFromName(
      substreamAgentName("global", WORKSPACE_ID, WORKSTREAM_ID),
    ));
    await runInDurableObject(stub, async (_instance, state) => {
      seedWorkstreamRoot(state, 1, { workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
      const transcript = new WorkstreamTranscriptStorage(state.storage);
      const systemProjection = {
        revision: 1,
        rendererVersion: "workstream-system-v1",
        inputHash: "system-input",
        message: { role: "system" as const, content: "System" },
      };
      await transcript.commitBindTransition({
        kind: "state_initialized",
        loopId: "double-compaction",
        generation: 1,
        stateRevision: 1,
        systemProjection,
        nonSystemMessages: [{ role: "user", content: "Question" }],
        nonSystemMessageOrigins: [{
          originKind: "derived",
          sourceKind: "participant_turn",
          sourceId: "question",
          sourceRevision: 1,
        }],
      });
      for (let index = 1; index <= 2; index += 1) {
        const current = transcript.readBindProjection("double-compaction")!;
        const eventId = `double-compaction:compaction:${index}`;
        await transcript.reserveCompactionStatus({
          compactionEventId: eventId,
          runId: "double-compaction",
          trigger: "auto",
          occurredAtUtc: new Date(1_000 + index * 10).toISOString(),
        });
        transcript.upsertActivity({
          activityId: eventId,
          parentActivityId: null,
          scope: "compaction",
          subjectId: String(index),
          callIndex: index - 1,
          label: "Context automatically compacting",
          action: "start",
          revision: 1,
          occurredAtUtc: new Date(1_000 + index * 10).toISOString(),
        });
        if (index === 2) {
          const midCompactionOpen = transcript.createOpeningSnapshot({
            unreadHighWaterAttentionOrdinal: null,
            now: 1_005 + index * 10,
          });
          expect(midCompactionOpen.ranges.flatMap((range) => range.turns)).toContainEqual(
            expect.objectContaining({ turnId: eventId, entryKind: "status" }),
          );
          expect(midCompactionOpen.activeActivities).toContainEqual(expect.objectContaining({
            activityId: eventId,
            state: "active",
            intervals: [expect.objectContaining({ elapsedMsAtSnapshot: 5 })],
          }));
        }
        await transcript.commitBindCompaction({
          commit: {
            checkpoint: {
              trigger: "auto",
              summary: `Summary ${index}`,
              messages: [{ role: "user", content: `Summary ${index}` }],
              model: "openai/test",
              contextTokensBeforeCompaction: 90,
              contextWindowTokens: 100,
              inputTokens: 10,
              outputTokens: 2,
              costCents: 0.01,
            },
            transition: {
              kind: "state_replaced",
              loopId: "double-compaction",
              generation: current.generation,
              nextGeneration: current.generation + 1,
              stateRevision: current.stateRevision + 1,
              systemProjection,
              nonSystemMessages: [{ role: "user", content: `Summary ${index}` }],
              compactionEventId: eventId,
            },
          },
          continuation: {
            executionPrincipalKey: "user:user-1",
            resourceVisibilityFingerprint: "inventory:0",
            checkpointTemplateVersion: 1,
            compactedThroughSequence: index,
            expectedInventoryRevision: 0,
          },
          now: 1_005 + index * 10,
        });
      }
      expect(transcript.readBindProjection("double-compaction")).toMatchObject({
        generation: 3,
        nonSystemMessages: [{ role: "user", content: "Summary 2" }],
      });
      expect(transcript.createOpeningSnapshot({
        unreadHighWaterAttentionOrdinal: null,
        now: 2_000,
      }).activities.filter((activity) => activity.scope === "compaction")).toEqual([
        expect.objectContaining({ activityId: "double-compaction:compaction:1", state: "completed" }),
        expect.objectContaining({ activityId: "double-compaction:compaction:2", state: "completed" }),
      ]);
    });
  });
});
