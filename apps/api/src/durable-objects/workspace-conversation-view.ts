import { uuidV7 } from "../lib/uuid-v7";
import { WORKSTREAM_REALTIME_MAX_FRAME_BYTES, type SubstreamId, type WorkstreamTranscriptSnapshot } from "@rally/contracts";
import type {
  ConversationViewContent, ConversationViewHeader, WorkspaceConversationViewEvent,
} from "@rally/contracts/conversation-view";
import { ConversationViewProjectionSchema } from "./conversation-view-projection";
import { parseRpcInput } from "../lib/rpc-input";

export const WORKSPACE_CONVERSATION_VIEW_MIGRATION: readonly string[] = [
  `CREATE TABLE conversation_view_headers (
    parent_id TEXT NOT NULL, substream_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation >= 0), revision INTEGER NOT NULL CHECK(revision > 0), header_json TEXT NOT NULL CHECK(json_valid(header_json)),
    PRIMARY KEY(parent_id, substream_id)
  ) STRICT`,
  `CREATE TABLE conversation_view_turns (
    parent_id TEXT NOT NULL, substream_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0), transcript_sequence INTEGER CHECK(transcript_sequence > 0),
    content_json TEXT CHECK(content_json IS NULL OR json_valid(content_json)),
    PRIMARY KEY(parent_id, substream_id, turn_id)
  ) STRICT`,
  `CREATE INDEX conversation_view_sequence_idx
    ON conversation_view_turns(parent_id, substream_id, transcript_sequence) WHERE content_json IS NOT NULL`,
  `INSERT OR IGNORE INTO thread_backfill(job, workstream_id, attempts, not_before)
    SELECT 'conversation_view', parent_id, 0, 0 FROM parent_children
    UNION SELECT 'conversation_view', sidekick_id, 0, 0 FROM sidekick_children
    UNION SELECT 'conversation_view', workstream_id, 0, 0 FROM channels
    UNION SELECT 'conversation_view', space_id, 0, 0 FROM spaces
    UNION SELECT 'conversation_view', parent_id, 0, 0 FROM parent_metadata`,
];

export class WorkspaceConversationView {
  constructor(private readonly storage: DurableObjectStorage) {}

  apply(input: unknown): void {
    const value = parseRpcInput(ConversationViewProjectionSchema, input, "conversation_view_projection");
    const sql = this.storage.sql;
    this.storage.transactionSync(() => {
      const previous = sql.exec<{ generation: number }>(
        "SELECT generation FROM conversation_view_headers WHERE parent_id = ? AND substream_id = ?",
        value.parentId, value.substreamId,
      ).toArray()[0];
      if (previous && previous.generation > value.generation) return;
      if (previous && previous.generation < value.generation) sql.exec(
        "DELETE FROM conversation_view_turns WHERE parent_id = ? AND substream_id = ?", value.parentId, value.substreamId,
      );
      sql.exec(
        `INSERT INTO conversation_view_headers VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(parent_id, substream_id) DO UPDATE SET
           generation = excluded.generation, revision = excluded.revision, header_json = excluded.header_json
         WHERE excluded.generation > conversation_view_headers.generation
           OR excluded.revision > conversation_view_headers.revision`,
        value.parentId, value.substreamId, value.generation, value.revision, JSON.stringify(value.header),
      );
      if (!value.turnId) return;
      // Keep a small deletion fence: an older delivery cannot resurrect removed text.
      sql.exec(
        `INSERT INTO conversation_view_turns VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(parent_id, substream_id, turn_id) DO UPDATE SET revision = excluded.revision,
           transcript_sequence = excluded.transcript_sequence, content_json = excluded.content_json
         WHERE excluded.revision > conversation_view_turns.revision`,
        value.parentId, value.substreamId, value.turnId, value.revision,
        value.content?.turn.transcriptSequence ?? null,
        value.content === null ? null : JSON.stringify(value.content),
      );
    });
  }

  /** Admission belongs to WorkspaceDO; this storage helper cannot grant access. */
  opening(request: { requestId: string; parentId: string; substreamId: SubstreamId }): WorkspaceConversationViewEvent {
    const sql = this.storage.sql;
    const header = sql.exec<{ header_json: string }>(
      "SELECT header_json FROM conversation_view_headers WHERE parent_id = ? AND substream_id = ?",
      request.parentId, request.substreamId,
    ).toArray()[0];
    const empty = { type: "workspace_conversation_view" as const, ...request, view: null };
    if (!header) return empty;
    const encoder = new TextEncoder();
    const transcript: WorkstreamTranscriptSnapshot = {
      snapshotId: uuidV7(), snapshotThrough: 0, eventSequence: 0, snapshotAtUtc: new Date().toISOString(),
      unreadAnchorSequence: null, unreadReason: "no_unread",
      ranges: [], activities: [], activeActivities: [], activeTurns: [], pendingInputs: [], pluginRuns: [],
    };
    const answer = { ...empty, view: { header: JSON.parse(header.header_json) as ConversationViewHeader, transcript } };
    const range = {
      purpose: "latest" as const,
      requested: { startInclusive: 1, endExclusive: 1 },
      covered: { startInclusive: 1, endExclusive: 1 },
      turns: [] as WorkstreamTranscriptSnapshot["ranges"][number]["turns"],
      activities: [], pluginRuns: [],
    };
    // Charge the exact wire representation once per row, including array
    // separators and range coordinates. No full-frame trim loop is needed.
    const arrayGrowth = (items: readonly unknown[], existingCount: number): number =>
      encoder.encode(JSON.stringify(items)).byteLength - 2 + (items.length > 0 && existingCount > 0 ? 1 : 0);
    let bytes = 0;
    for (const row of sql.exec<{ content_json: string }>(
      `SELECT content_json FROM conversation_view_turns
       WHERE parent_id = ? AND substream_id = ? AND content_json IS NOT NULL
       ORDER BY transcript_sequence DESC`,
      request.parentId, request.substreamId,
    )) {
      const content = JSON.parse(row.content_json) as ConversationViewContent;
      const turn = { ...content.turn, blocks: content.turn.blocks.map((block) => ({ ...block, streaming: false })) };
      const activities = content.activities.filter((activity) => activity.state !== "active");
      // A stale cached run must not start a live timer before attachment.
      const pluginRuns = content.pluginRuns.map((run) => ({
        ...run, toolCallIds: [],
        durationMs: run.durationMs === null ? null : run.durationMs + (run.elapsedMsAtSnapshot ?? 0),
        elapsedMsAtSnapshot: null,
      }));
      if (range.turns.length === 0) {
        transcript.snapshotThrough = turn.transcriptSequence;
        range.requested = { startInclusive: turn.transcriptSequence, endExclusive: turn.transcriptSequence + 1 };
        range.covered = { ...range.requested };
        transcript.ranges = [range];
        bytes = encoder.encode(JSON.stringify(answer)).byteLength;
      }
      const coordinateGrowth = 2 * (String(turn.transcriptSequence).length - String(range.covered.startInclusive).length);
      const nextBytes = bytes + coordinateGrowth + arrayGrowth([turn], range.turns.length)
        + arrayGrowth(activities, transcript.activities.length) + arrayGrowth(pluginRuns, transcript.pluginRuns.length);
      if (nextBytes > WORKSTREAM_REALTIME_MAX_FRAME_BYTES) {
        if (range.turns.length === 0) return empty;
        break;
      }
      bytes = nextBytes;
      range.requested.startInclusive = turn.transcriptSequence;
      range.covered.startInclusive = turn.transcriptSequence;
      range.turns.push(turn);
      transcript.activities.push(...activities);
      transcript.pluginRuns.push(...pluginRuns);
    }
    range.turns.reverse();
    // Keep a final wire check at the boundary as the response shape evolves.
    return encoder.encode(JSON.stringify(answer)).byteLength <= WORKSTREAM_REALTIME_MAX_FRAME_BYTES ? answer : empty;
  }
}
