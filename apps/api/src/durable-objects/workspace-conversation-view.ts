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
    // Plugin-only turns can consume an entire five-turn window. Read the
    // compact feed up to the existing wire budget, newest first, without
    // materializing an arbitrarily large conversation just to trim it below.
    const rows: ConversationViewContent[] = [];
    const encoder = new TextEncoder();
    let contentBytes = 0;
    for (const row of sql.exec<{ content_json: string }>(
      `SELECT content_json FROM conversation_view_turns
       WHERE parent_id = ? AND substream_id = ? AND content_json IS NOT NULL
       ORDER BY transcript_sequence DESC`,
      request.parentId, request.substreamId,
    )) {
      contentBytes += encoder.encode(row.content_json).byteLength;
      if (contentBytes > WORKSTREAM_REALTIME_MAX_FRAME_BYTES) {
        if (rows.length === 0) return empty;
        break;
      }
      rows.push(JSON.parse(row.content_json) as ConversationViewContent);
    }
    rows.reverse();
    const snapshotThrough = rows.at(-1)?.turn.transcriptSequence ?? 0;
    const transcript: WorkstreamTranscriptSnapshot = {
      snapshotId: uuidV7(), snapshotThrough, eventSequence: 0, snapshotAtUtc: new Date().toISOString(),
      unreadAnchorSequence: null, unreadReason: "no_unread",
      ranges: [], activities: [], activeActivities: [], activeTurns: [], pendingInputs: [], pluginRuns: [],
    };
    const answer = { ...empty, view: { header: JSON.parse(header.header_json) as ConversationViewHeader, transcript } };
    do {
      transcript.ranges = rows.length ? [{
        purpose: "latest",
        requested: { startInclusive: rows[0]!.turn.transcriptSequence, endExclusive: snapshotThrough + 1 },
        covered: { startInclusive: rows[0]!.turn.transcriptSequence, endExclusive: snapshotThrough + 1 },
        turns: rows.map((row) => ({ ...row.turn, blocks: row.turn.blocks.map((block) => ({ ...block, streaming: false })) })), activities: [], pluginRuns: [],
      }] : [];
      transcript.activities = rows.flatMap((row) => row.activities.filter((activity) => activity.state !== "active"));
      transcript.pluginRuns = rows.flatMap((row) => row.pluginRuns.map((run) => ({
        ...run, toolCallIds: [],
        durationMs: run.durationMs === null ? null : run.durationMs + (run.elapsedMsAtSnapshot ?? 0),
        elapsedMsAtSnapshot: null,
      })));
      // A stale cached run must not start a live work timer before attachment.
      transcript.activeActivities = [];
      if (encoder.encode(JSON.stringify(answer)).byteLength <= WORKSTREAM_REALTIME_MAX_FRAME_BYTES) {
        return answer;
      }
      rows.shift();
    } while (rows.length);
    // Oversized text never blocks the authoritative connection.
    return empty;
  }
}
