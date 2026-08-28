import {
  insertPreparedCanonicalTranscriptFact,
  prepareCanonicalTranscriptFact,
  type PreparedCanonicalTranscriptFact,
} from "./canonical-payload-store";

export interface OrderedParticipantMessageInput {
  turnId: string;
  actor: "human" | "assistant" | "external" | "system";
  authorUserId: string | null;
  text: string;
  producedByRunId: string | null;
  createdAt: number;
  attentionOrdinal?: number | null;
}

export interface PreparedOrderedParticipantMessage {
  input: OrderedParticipantMessageInput;
  fact: PreparedCanonicalTranscriptFact;
}

export interface OrderedParticipantMessageRow {
  turnId: string;
  transcriptSequence: number;
  actor: OrderedParticipantMessageInput["actor"];
  authorUserId: string | null;
  content: string;
  createdAt: number;
}

/** Product-neutral participant turn/fact writer inside one owning DO. */
export class ParticipantTranscriptStore {
  constructor(private readonly sql: SqlStorage) {}

  async prepareMessage(input: OrderedParticipantMessageInput): Promise<PreparedOrderedParticipantMessage> {
    const fact = await prepareCanonicalTranscriptFact({
      factId: `${input.turnId}:message`,
      factKind: "participant_message",
      audience: "shared",
      payload: {
        role: input.actor === "assistant" ? "assistant" : input.actor === "system" ? "system" : "user",
        content: input.text,
        structuredContent: null,
      },
      origin: { originKind: "canonical", sourceKind: null, sourceId: null, sourceRevision: null },
      runId: input.producedByRunId,
      turnId: input.turnId,
      toolCallId: null,
    });
    return { input, fact };
  }

  appendPreparedMessage(prepared: PreparedOrderedParticipantMessage): number {
    const existing = this.sql.exec<{ transcript_sequence: number } & Record<string, SqlStorageValue>>(
      `SELECT transcript_sequence FROM participant_transcript_turns WHERE turn_id = ?`,
      prepared.input.turnId,
    ).toArray()[0];
    if (existing) return existing.transcript_sequence;
    insertPreparedCanonicalTranscriptFact(this.sql, prepared.fact, prepared.input.createdAt);
    const sequence = this.allocateSequence(prepared.input.createdAt);
    this.sql.exec(
      `INSERT INTO participant_transcript_turns
         (transcript_sequence, turn_id, entry_kind, actor, author_user_id,
          root_fact_id, activity_id, attention_ordinal, revision, created_at, updated_at)
       VALUES (?, ?, 'conversation', ?, ?, ?, NULL, ?, 1, ?, ?)`,
      sequence,
      prepared.input.turnId,
      prepared.input.actor,
      prepared.input.authorUserId,
      prepared.fact.material.factId,
      prepared.input.attentionOrdinal ?? null,
      prepared.input.createdAt,
      prepared.input.createdAt,
    );
    this.sql.exec(
      `INSERT INTO participant_transcript_blocks
         (turn_id, block_id, block_index, block_kind, fact_id, revision, updated_at)
       VALUES (?, ?, 0, 'text', ?, 1, ?)`,
      prepared.input.turnId,
      `${prepared.input.turnId}:text:0`,
      prepared.fact.material.factId,
      prepared.input.createdAt,
    );
    return sequence;
  }

  messages(): OrderedParticipantMessageRow[] {
    return this.sql.exec<{
      turn_id: string;
      transcript_sequence: number;
      actor: OrderedParticipantMessageInput["actor"];
      author_user_id: string | null;
      payload_json: string;
      created_at: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT turn.turn_id, turn.transcript_sequence, turn.actor, turn.author_user_id,
              payload.payload_json, turn.created_at
         FROM participant_transcript_turns turn
         JOIN transcript_facts fact ON fact.fact_id = turn.root_fact_id
         JOIN transcript_payloads payload ON payload.payload_id = fact.payload_id
        WHERE turn.entry_kind = 'conversation'
        ORDER BY turn.transcript_sequence`,
    ).toArray().map((row) => {
      const payload = JSON.parse(row.payload_json) as { content?: unknown };
      return {
        turnId: row.turn_id,
        transcriptSequence: row.transcript_sequence,
        actor: row.actor,
        authorUserId: row.author_user_id,
        content: typeof payload.content === "string" ? payload.content : "",
        createdAt: row.created_at,
      };
    });
  }

  private allocateSequence(now: number): number {
    const value = this.sql.exec<{ next_transcript_sequence: number } & Record<string, SqlStorageValue>>(
      `SELECT next_transcript_sequence FROM transcript_counters WHERE id = 1`,
    ).one().next_transcript_sequence;
    this.sql.exec(
      `UPDATE transcript_counters
          SET next_transcript_sequence = next_transcript_sequence + 1, updated_at = ?
        WHERE id = 1`,
      now,
    );
    return value;
  }
}
