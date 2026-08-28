/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TranscriptTurnSchema } from "@rally/contracts";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-object-schema";
import { WorkstreamTranscriptStorage } from "../src/durable-objects/workstream-transcript-storage";

describe("work-stream schema migration in workerd", () => {
  it("upgrades a populated v27 object through the pre-rebuild history with foreign keys enforced", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("populated-v27-upgrade");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 27),
        component: "substream_agent_do",
        workerVersionId: "worker-v27",
        now: 1_000,
      });
      state.storage.sql.exec(
        `INSERT INTO workstream_resource_links
           (resource_id, attached_by_user_id, watch_enabled, relationship_type,
            resource_json, attached_at, updated_at)
         VALUES ('resource-1', 'user-1', 1, 'context',
                 '{"id":"resource-1","title":"Preserve this relation"}', 1, 1)`,
      );

      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
        component: "substream_agent_do",
        workerVersionId: "worker-current",
        now: 2_000,
      });

      expect(state.storage.sql.exec<{ relationship_type: string; resource_json: string }>(
        `SELECT relationship_type, resource_json
           FROM workstream_resource_links WHERE resource_id = 'resource-1'`,
      ).one()).toEqual({
        relationship_type: "context",
        resource_json: '{"id":"resource-1","title":"Preserve this relation"}',
      });
      expect(state.storage.sql.exec(`PRAGMA foreign_key_check`).toArray()).toEqual([]);
    });
  });

  it("preserves canonical history while retiring populated v32 execution state", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("populated-v32-upgrade");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 32),
        component: "substream_agent_do",
        workerVersionId: "worker-v32",
        now: 1_000,
      });
      state.storage.sql.exec(
        `INSERT INTO substreams
           (id, kind, inherit_mode, depth, return_mode, origin_message_id,
            audience, tool_policy, status, created_at)
         VALUES ('0', 'main', 'none', 0, 'none', NULL, 'workspace', 'full', 'open', 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO transcript_payloads
           (payload_id, audience, media_type, payload_json, payload_sha256, byte_length, created_at)
         VALUES ('payload-1', 'shared', 'application/json',
                 '{"role":"user","content":"Preserve me","structuredContent":null}',
                 'payload-hash', 11, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO transcript_facts
           (fact_id, fact_kind, payload_id, origin_kind, turn_id, created_at)
         VALUES ('fact-1', 'workstream_message', 'payload-1', 'canonical', 'message-1', 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO participant_transcript_turns
           (transcript_sequence, turn_id, entry_kind, actor, author_user_id,
            root_fact_id, attention_ordinal, revision, created_at, updated_at)
         VALUES (1, 'message-1', 'conversation', 'human', 'user-1',
                 'fact-1', 1, 1, 1, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO participant_transcript_blocks
           (turn_id, block_id, block_index, block_kind, fact_id, revision, updated_at)
         VALUES ('message-1', 'message-1:text:0', 0, 'text', 'fact-1', 1, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO bind_loop_heads
           (loop_id, generation, state_revision, system_projection_revision,
            projector_version, updated_at)
         VALUES ('run-1', 1, 1, 1, 'legacy-run-head', 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO bind_loop_states
           (loop_id, state_revision, generation, transition_kind,
            system_projection_revision, system_renderer_version,
            system_input_hash, created_at)
         VALUES ('run-1', 1, 1, 'state_initialized', 1,
                 'legacy-run-head', 'legacy-input', 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO bind_loop_state_messages
           (loop_id, state_revision, message_position, loop_sequence, fact_id)
         VALUES ('run-1', 1, 0, 1, 'fact-1')`,
      );
      state.storage.sql.exec(
        `INSERT INTO bind_provider_boundaries
           (loop_id, state_revision, generation, system_projection_revision,
            projector_version, projected_hash, bind_hash, verified_at)
         VALUES ('run-1', 1, 1, 1, 'legacy-run-head',
                 'legacy-bind-hash', 'legacy-bind-hash', 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO workstream_message_records
           (id, substream_id, sequence_number, attention_ordinal, fact_id, role,
            kind, author_type, author_user_id, client_message_id, visibility,
            pinned, message_type, created_at, updated_at)
         VALUES ('message-1', '0', 1, 1, 'fact-1', 'user', 'text', 'member',
                 'user-1', 'client-1', 'both', 0, 'text', 1, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO substreams
           (id, kind, inherit_mode, depth, return_mode, origin_message_id,
            audience, tool_policy, status, created_at)
         VALUES ('child', 'chat', 'none', 1, 'none', 'message-1',
                 'workspace', 'full', 'open', 2)`,
      );
      state.storage.sql.exec(
        `INSERT INTO runs
           (run_id, substream_id, status, budget, attempt_epoch, model_iteration,
            next_action_cursor, input_fence_seq, revision, started_at,
            active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count,
            retry_count, tool_count, input_tokens, output_tokens, cost_micros,
            output_bytes, created_at, updated_at)
         VALUES ('run-1', '0', 'running', '{}', 0, 0, '', 0, 0, 1,
                 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO elicitation_requests
           (elicitation_id, run_id, prompt, response_type, options_json,
            minimum_selections, maximum_selections, target_user_id, status,
            answer_json, answered_by_user_id, external_actor_json, created_at, answered_at)
         VALUES ('legacy-elicitation', 'run-1', 'Legacy question', 'text', '[]',
                 0, NULL, NULL, 'pending', NULL, NULL, NULL, 1, NULL)`,
      );
      state.storage.sql.exec(
        `INSERT INTO workstream_message_attachments
           (message_id, resource_id, position, attachment_json)
         VALUES ('message-1', 'resource-1', 0, '{"fileName":"evidence.pdf"}')`,
      );
      state.storage.sql.exec(
        `INSERT INTO workstream_message_mentions
           (message_id, mention_index, mention_kind, target_user_id,
            start_offset, end_offset, attention_ordinal)
         VALUES ('message-1', 0, 'person', 'user-2', 0, 4, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO tool_effects
           (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key,
            tool_name, mode, request_hash, authority_revision, status,
            result_message_id, tool_call_id, input_json)
         VALUES
           ('effect-command', 'run-1', 0, 0, 'effect-command', 'run_command',
            'write', 'request-1', 'authority', 'executing', 'message-1', 'call-command', '{}'),
           ('effect-publish', 'run-1', 0, 1, 'effect-publish', 'publish',
            'write', 'request-2', 'authority', 'executing', NULL, 'call-publish', '{}')`,
      );
      state.storage.sql.exec(
        `INSERT INTO attachment_tool_receipts
           (workspace_id, resource_id, tool_invocation_id, derivative_sha256, created_at)
         VALUES ('workspace-1', 'resource-1', 'effect-command', 'derivative-hash', 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO tool_effect_checkpoints
           (checkpoint_id, effect_intent_id, run_id, attempt_id, checkpoint_index,
            phase, member_safe_payload_json, created_at)
         VALUES ('checkpoint-1', 'effect-command', 'run-1', 'attempt-1', 0,
                 'executing', '{}', 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO terminal_workspace
           (id, provider, sandbox_id, lifecycle_state, generation, stable_name,
            authority_fingerprint, applied_network_revision, version,
            created_at, updated_at)
         VALUES (1, 'daytona', 'sandbox-1', 'running', 1, 'rally-sandbox-1',
                 'authority', 1, 1, 1, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO terminal_tasks
           (task_id, run_id, effect_intent_id, sandbox_generation,
            provider_task_name, state, command_sha256, command_deadline_at,
            stdout_head, stdout_tail, stderr_head, stderr_tail,
            stdout_bytes, stderr_bytes, created_at, updated_at)
         VALUES ('task-1', 'run-1', 'effect-command', 1,
                 'rally-task-1', 'running', 'command-hash', 9999,
                 '', '', '', '', 0, 0, 1, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO terminal_publication_grants
           (grant_id, run_id, source_message_id, principal_key, repository_full_name,
            base_ref, head_ref, expires_at, consumed_by_effect_intent_id, consumed_at, created_at)
         VALUES ('grant-1', 'run-1', 'message-1', 'user:user-1',
                 'owner/repo', 'main', 'rally/change', 9999, 'effect-publish', 2, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO repository_publications
           (publication_id, effect_intent_id, grant_id, repository_full_name,
            base_ref, head_ref, requested_commit_sha, state, title, body, created_at, updated_at)
         VALUES ('publication-1', 'effect-publish', 'grant-1', 'owner/repo',
                 'main', 'rally/change', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                 'publishing', 'Title', 'Body', 1, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO run_steering (run_id, steering_message_id, requested_at)
         VALUES ('run-1', 'message-1', 2)`,
      );
      state.storage.sql.exec(
        `INSERT INTO agent_run_dispatches
           (run_id, input_json, state, attempt, available_at, created_at, updated_at)
         VALUES ('run-1', '{"source":"v32-fixture"}', 'queued', 0, 1, 1, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO suggested_actions
           (action_id, version, source_activity_id, delivery_id, audience_kind,
            provenance_ref, authorization_selector_hash, source_revisions_json,
            source_authorization_epoch, display_title, display_body, status,
            created_at, expires_at, authored_message_id)
         VALUES ('action-1', 1, 'activity-1', 'delivery-1', 'workstream',
                 'source', 'selector', '{}', 1, 'Continue', 'Continue safely',
                 'pending', 1, 9999, 'message-1')`,
      );
      state.storage.sql.exec(
        `INSERT INTO active_output_turns
           (run_id, attempt_epoch, turn_id, substream_id, status, durable_event_seq,
            durable_through_frame_seq, next_chunk_index, message_id,
            seen_turn_ids_json, turn_start_offset, started_at, checkpointed_at, updated_at)
         VALUES ('run-1', 0, 'run-1:turn:1', '0', 'streaming', 1, 1, 0,
                 'run-1', '["run-1:turn:1"]', 0, 1, 1, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO active_output_chunks
           (run_id, attempt_epoch, chunk_index, text, byte_length,
            first_frame_seq, through_frame_seq, content_hash, updated_at)
         VALUES ('run-1', 0, 0, 'partial', 7, 1, 1, 'partial-hash', 1)`,
      );
      expect(state.storage.sql.exec(`PRAGMA foreign_key_check`).toArray()).toEqual([]);
      expect(state.storage.sql.exec(`PRAGMA foreign_keys`).one()).toEqual({ foreign_keys: 1 });
    });

    // A deployed v32 object commits these rows before a newer worker wakes it.
    // The second event models that deployment boundary. The forward cutover
    // itself remains valid with foreign-key enforcement on at every statement.
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
        component: "substream_agent_do",
        workerVersionId: "worker-current",
        now: 2_000,
      });

      expect(state.storage.sql.exec<{ origin_message_id: string }>(
        `SELECT origin_message_id FROM substreams WHERE id = 'child'`,
      ).one()).toEqual({ origin_message_id: "message-1" });
      expect(state.storage.sql.exec(`SELECT run_id FROM runs`).toArray()).toEqual([]);
      expect(state.storage.sql.exec<{ content: string; author_name_snapshot: string }>(
        `SELECT view.content, turn.author_name_snapshot
           FROM canonical_conversation_turn_details view
           JOIN participant_transcript_turns turn ON turn.turn_id = view.id
          WHERE view.id = 'message-1'`,
      ).one()).toEqual({ content: "Preserve me", author_name_snapshot: "A workspace member" });
      expect(TranscriptTurnSchema.parse(
        new WorkstreamTranscriptStorage(state.storage).participantTurn("message-1"),
      ).authorSnapshot).toEqual({
        userId: "user-1",
        displayName: "A workspace member",
        avatarUrl: null,
      });
      expect(state.storage.sql.exec(`SELECT resource_id FROM participant_transcript_attachments`).toArray())
        .toEqual([{ resource_id: "resource-1" }]);
      expect(state.storage.sql.exec(`SELECT target_user_id FROM participant_transcript_mentions`).toArray())
        .toEqual([{ target_user_id: "user-2" }]);
      expect(state.storage.sql.exec(`SELECT task_id FROM terminal_tasks`).toArray()).toEqual([]);
      expect(state.storage.sql.exec(`SELECT sandbox_id FROM terminal_workspace`).toArray())
        .toEqual([{ sandbox_id: "sandbox-1" }]);
      expect(state.storage.sql.exec(`SELECT checkpoint_id FROM tool_effect_checkpoints`).toArray()).toEqual([]);
      expect(state.storage.sql.exec(
        `SELECT resource_id, tool_invocation_id FROM attachment_tool_receipts`,
      ).toArray()).toEqual([]);
      expect(state.storage.sql.exec(`SELECT effect_intent_id FROM tool_effects`).toArray()).toEqual([]);
      expect(state.storage.sql.exec(`SELECT elicitation_id FROM elicitation_requests`).toArray())
        .toEqual([]);
      expect(state.storage.sql.exec(`PRAGMA table_info(elicitation_requests)`).toArray()
        .map((column) => column.name)).toContain("tool_call_id");
      expect(state.storage.sql.exec(
        `SELECT grant_id, source_message_id, consumed_by_effect_intent_id
           FROM terminal_publication_grants`,
      ).toArray()).toEqual([]);
      expect(state.storage.sql.exec(`SELECT publication_id FROM repository_publications`).toArray())
        .toEqual([]);
      expect(state.storage.sql.exec(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name IN ('run_steering', 'agent_run_dispatches')`,
      ).toArray()).toEqual([]);
      expect(state.storage.sql.exec(`SELECT authored_message_id FROM suggested_actions`).toArray())
        .toEqual([{ authored_message_id: "message-1" }]);
      expect(state.storage.sql.exec(`SELECT stream_id FROM active_output_turns`).toArray())
        .toEqual([]);
      expect(state.storage.sql.exec(`SELECT text FROM active_output_chunks`).toArray())
        .toEqual([]);
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM bind_loop_heads`,
      ).one()).toEqual({ count: 0 });
      expect(state.storage.sql.exec(
        `SELECT name FROM sqlite_schema
          WHERE type = 'table' AND name = 'bind_loop_states'`,
      ).toArray()).toEqual([]);
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM bind_loop_state_messages`,
      ).one()).toEqual({ count: 0 });
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM bind_provider_boundaries`,
      ).one()).toEqual({ count: 0 });
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM sqlite_schema
          WHERE name IN ('workstream_message_records', 'workstream_message_details')`,
      ).one()).toEqual({ count: 0 });
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM sqlite_schema
          WHERE sql LIKE '%_v33%'`,
      ).one()).toEqual({ count: 0 });
      expect(state.storage.sql.exec(
        `SELECT version FROM _sql_schema_migrations WHERE version >= 33 ORDER BY version`,
      ).toArray()).toEqual([{ version: 33 }]);
      expect(state.storage.sql.exec(`PRAGMA foreign_key_check`).toArray()).toEqual([]);
      expect(state.storage.sql.exec(`PRAGMA foreign_keys`).one()).toEqual({ foreign_keys: 1 });
    });
  });
});
