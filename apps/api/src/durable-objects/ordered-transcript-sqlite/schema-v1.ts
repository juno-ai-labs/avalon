/**
 * Immutable schema installed by every Durable Object that owns an ordered
 * participant transcript and Bind loop. The statements are copied verbatim
 * from AgentLoopDO migration 27; changing bytes here would rewrite that
 * released migration hash. Add a new versioned delta for future changes.
 */
export const ORDERED_TRANSCRIPT_SCHEMA_V1: readonly string[] = [
      `CREATE TABLE transcript_counters (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        next_transcript_sequence INTEGER NOT NULL CHECK (next_transcript_sequence > 0),
        next_loop_sequence INTEGER NOT NULL CHECK (next_loop_sequence > 0),
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `INSERT INTO transcript_counters
         (id, next_transcript_sequence, next_loop_sequence, updated_at)
       VALUES (1, 1, 1, unixepoch() * 1000)`,
      `CREATE TABLE transcript_payloads (
        payload_id TEXT PRIMARY KEY,
        audience TEXT NOT NULL CHECK (audience IN ('shared', 'participant', 'model')),
        media_type TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        payload_sha256 TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        created_at INTEGER NOT NULL,
        UNIQUE(audience, payload_sha256, byte_length)
      ) STRICT`,
      `CREATE TABLE transcript_facts (
        fact_id TEXT PRIMARY KEY,
        fact_kind TEXT NOT NULL,
        payload_id TEXT NOT NULL REFERENCES transcript_payloads(payload_id),
        origin_kind TEXT NOT NULL CHECK (
          origin_kind IN ('canonical', 'protocol', 'derived', 'system_projection')
        ),
        source_kind TEXT,
        source_id TEXT,
        source_revision INTEGER,
        run_id TEXT,
        turn_id TEXT,
        tool_call_id TEXT,
        created_at INTEGER NOT NULL,
        CHECK ((source_kind IS NULL) = (source_id IS NULL)),
        CHECK (source_revision IS NULL OR source_revision >= 0),
        CHECK (
          (origin_kind IN ('canonical', 'protocol') AND source_id IS NULL)
          OR (origin_kind IN ('derived', 'system_projection') AND source_id IS NOT NULL)
        )
      ) STRICT`,
      `CREATE INDEX transcript_facts_turn_idx
         ON transcript_facts(turn_id, fact_kind, created_at)`,
      `CREATE INDEX transcript_facts_tool_idx
         ON transcript_facts(tool_call_id, fact_kind, created_at)
         WHERE tool_call_id IS NOT NULL`,
      `CREATE INDEX transcript_facts_source_idx
         ON transcript_facts(source_kind, source_id, source_revision)
         WHERE source_id IS NOT NULL`,
      `CREATE TABLE participant_transcript_turns (
        transcript_sequence INTEGER PRIMARY KEY CHECK (transcript_sequence > 0),
        turn_id TEXT NOT NULL UNIQUE,
        entry_kind TEXT NOT NULL CHECK (entry_kind IN ('conversation', 'status')),
        actor TEXT NOT NULL CHECK (actor IN ('human', 'assistant', 'external', 'system')),
        author_user_id TEXT,
        root_fact_id TEXT NOT NULL REFERENCES transcript_facts(fact_id),
        activity_id TEXT,
        attention_ordinal INTEGER,
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE INDEX participant_transcript_sequence_idx
         ON participant_transcript_turns(transcript_sequence)`,
      `CREATE INDEX participant_transcript_latest_conversation_idx
         ON participant_transcript_turns(entry_kind, transcript_sequence DESC)
         WHERE entry_kind = 'conversation'`,
      `CREATE INDEX participant_transcript_status_idx
         ON participant_transcript_turns(entry_kind, transcript_sequence DESC)
         WHERE entry_kind = 'status'`,
      `CREATE INDEX participant_transcript_attention_idx
         ON participant_transcript_turns(attention_ordinal, transcript_sequence)
         WHERE attention_ordinal IS NOT NULL AND entry_kind = 'conversation'`,
      `CREATE TABLE participant_transcript_blocks (
        turn_id TEXT NOT NULL REFERENCES participant_transcript_turns(turn_id) ON DELETE CASCADE,
        block_id TEXT NOT NULL UNIQUE,
        block_index INTEGER NOT NULL CHECK (block_index >= 0),
        block_kind TEXT NOT NULL CHECK (block_kind IN ('text', 'tool', 'thinking')),
        fact_id TEXT NOT NULL REFERENCES transcript_facts(fact_id),
        tool_call_id TEXT,
        plugin_id TEXT,
        tool_name TEXT,
        call_index INTEGER,
        lifecycle_state TEXT,
        activity_id TEXT,
        revision INTEGER NOT NULL CHECK (revision > 0),
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(turn_id, block_index),
        CHECK (call_index IS NULL OR call_index >= 0)
      ) STRICT`,
      `CREATE UNIQUE INDEX participant_transcript_tool_call_idx
         ON participant_transcript_blocks(tool_call_id)
         WHERE tool_call_id IS NOT NULL`,
      `CREATE INDEX participant_transcript_block_display_idx
         ON participant_transcript_blocks(turn_id, block_index)`,
      `CREATE TABLE bind_loop_heads (
        loop_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL CHECK (generation > 0),
        state_revision INTEGER NOT NULL CHECK (state_revision > 0),
        system_projection_revision INTEGER NOT NULL CHECK (system_projection_revision > 0),
        projector_version TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TABLE bind_loop_states (
        loop_id TEXT NOT NULL REFERENCES bind_loop_heads(loop_id) ON DELETE CASCADE,
        state_revision INTEGER NOT NULL CHECK (state_revision > 0),
        generation INTEGER NOT NULL CHECK (generation > 0),
        transition_kind TEXT NOT NULL,
        system_projection_revision INTEGER NOT NULL CHECK (system_projection_revision > 0),
        system_renderer_version TEXT NOT NULL,
        system_input_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(loop_id, state_revision)
      ) STRICT`,
      `CREATE INDEX bind_loop_generation_idx
         ON bind_loop_states(loop_id, generation, state_revision)`,
      `CREATE TABLE bind_loop_state_messages (
        loop_id TEXT NOT NULL,
        state_revision INTEGER NOT NULL,
        message_position INTEGER NOT NULL CHECK (message_position >= 0),
        loop_sequence INTEGER NOT NULL UNIQUE CHECK (loop_sequence > 0),
        fact_id TEXT NOT NULL REFERENCES transcript_facts(fact_id),
        PRIMARY KEY(loop_id, state_revision, message_position),
        FOREIGN KEY(loop_id, state_revision)
          REFERENCES bind_loop_states(loop_id, state_revision) ON DELETE CASCADE
      ) STRICT`,
      `CREATE INDEX bind_loop_state_projection_idx
         ON bind_loop_state_messages(loop_id, state_revision, message_position)`,
      `CREATE TABLE bind_provider_boundaries (
        loop_id TEXT NOT NULL REFERENCES bind_loop_heads(loop_id) ON DELETE CASCADE,
        state_revision INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        system_projection_revision INTEGER NOT NULL,
        projector_version TEXT NOT NULL,
        projected_hash TEXT NOT NULL,
        bind_hash TEXT NOT NULL,
        verified_at INTEGER NOT NULL,
        PRIMARY KEY(loop_id, state_revision),
        CHECK (projected_hash = bind_hash)
      ) STRICT`,
      `CREATE TABLE transcript_compaction_checkpoints (
        checkpoint_fact_id TEXT PRIMARY KEY REFERENCES transcript_facts(fact_id),
        execution_principal_key TEXT NOT NULL,
        resource_visibility_fingerprint TEXT NOT NULL,
        checkpoint_template_version INTEGER NOT NULL CHECK (checkpoint_template_version > 0),
        run_id TEXT NOT NULL,
        compacted_through_sequence INTEGER NOT NULL CHECK (compacted_through_sequence >= 0),
        model TEXT NOT NULL,
        context_tokens_before_compaction INTEGER NOT NULL CHECK (context_tokens_before_compaction >= 0),
        context_window_tokens INTEGER NOT NULL CHECK (context_window_tokens > 0),
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        cost_micros INTEGER NOT NULL CHECK (cost_micros >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
        UNIQUE(execution_principal_key, run_id, compacted_through_sequence)
      ) STRICT`,
      `CREATE INDEX transcript_compaction_fence_idx
         ON transcript_compaction_checkpoints(
           execution_principal_key, resource_visibility_fingerprint,
           compacted_through_sequence DESC, updated_at DESC
         )`,
      `CREATE TABLE transcript_activities (
        activity_id TEXT PRIMARY KEY,
        parent_activity_id TEXT REFERENCES transcript_activities(activity_id),
        scope TEXT NOT NULL CHECK (scope IN ('response', 'assistant_turn', 'plugin', 'tool_call', 'thinking', 'compaction')),
        subject_id TEXT NOT NULL,
        call_index INTEGER,
        label TEXT NOT NULL,
        lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'completed', 'failed', 'cancelled', 'abandoned')),
        revision INTEGER NOT NULL CHECK (revision > 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (call_index IS NULL OR call_index >= 0)
      ) STRICT`,
      `CREATE INDEX transcript_active_activity_idx
         ON transcript_activities(lifecycle_state, parent_activity_id, call_index, created_at)
         WHERE lifecycle_state = 'active'`,
      `CREATE INDEX transcript_activity_subject_idx
         ON transcript_activities(scope, subject_id, revision)`,
      `CREATE TABLE transcript_activity_intervals (
        activity_id TEXT NOT NULL REFERENCES transcript_activities(activity_id) ON DELETE CASCADE,
        interval_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        stopped_at INTEGER,
        duration_ms INTEGER,
        revision INTEGER NOT NULL CHECK (revision > 0),
        PRIMARY KEY(activity_id, interval_id),
        CHECK (stopped_at IS NULL OR stopped_at >= started_at),
        CHECK (duration_ms IS NULL OR duration_ms >= 0)
      ) STRICT`,
      `CREATE INDEX transcript_active_interval_idx
         ON transcript_activity_intervals(activity_id, started_at)
         WHERE stopped_at IS NULL`,
    ];
