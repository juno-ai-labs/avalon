/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TranscriptTurnSchema } from "@rally/contracts";
import { applyDurableObjectSqliteMigrations } from "../src/durable-objects/sqlite-migrations";
import { WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS } from "../src/durable-objects/workstream-object-schema";
import { WORKSPACE_DO_SCHEMA_MIGRATIONS } from "../src/durable-objects/workspace-do-migrations";
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
        `INSERT INTO workstream (
           id, workstream_key, parent_workspace_key, parent_do_id, parent_generation, region,
           authority_mode, authority_generation, title, description, preview, scope,
           exact_state, state_reason_code, next_sequence_number, next_attention_ordinal,
           unread_tracking_start_ordinal, authority_epoch, scope_epoch,
           source_authorization_floor, listing_epoch, deletion_epoch, run_revision,
           created_at, last_people_activity_at, state_changed_at, updated_at
         ) VALUES (
           1, 'workstream-1', 'workspace-1', NULL, 0, 'global',
           'authoritative', 1, 'Fixture', '', '', 'personal',
           'idle', 'seeded', 1, 1, 0, 0, 0,
           0, 0, 0, 0, 1, 1, 1, 1
         )`,
      );
      state.storage.sql.exec(
        `INSERT INTO participants
           (user_id, participation_reason, added_by_user_id, status, participant_epoch,
            added_at, removed_at, first_opened_at, updated_at)
         VALUES ('user-1', 'explicit', 'user-1', 'active', 0, 1, NULL, 1, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO workstream_resource_links
           (resource_id, attached_by_user_id, watch_enabled, relationship_type,
            resource_json, attached_at, updated_at)
         VALUES ('resource-1', 'user-1', 1, 'context',
                 '{"id":"resource-1","title":"Preserve this relation"}', 1, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO workstream_resource_links
           (resource_id, attached_by_user_id, watch_enabled, relationship_type,
            resource_json, attached_at, updated_at)
         VALUES ('resource-suggestion', 'user-1', 0, 'suggested_activity',
                 '{"id":"resource-suggestion","title":"Retain this attachment"}', 1, 1)`,
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
      expect(state.storage.sql.exec<{ relationship_type: string }>(
        `SELECT relationship_type
           FROM workstream_resource_links WHERE resource_id = 'resource-suggestion'`,
      ).one()).toEqual({ relationship_type: "attachment" });
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
            created_at, expires_at, resolved_at, resolved_by_user_id,
            resolution_client_id, share_intent_json, authored_message_id)
         VALUES ('action-1', 1, 'activity-1', 'delivery-1', 'workstream',
                 'source', 'selector', '{}', 1, 'Continue', 'Continue safely',
                 'accepted', 1, 9999, 2, 'user-1', 'resolution-1',
                 '{"sourceAudience":{"scope":"users","userIds":["user-1"]}}',
                 'message-1'),
                ('action-1', 2, 'activity-1', 'delivery-2', 'workstream',
                 'source', 'selector', '{}', 1, 'Continue v2', 'Continue safely',
                 'accepted', 2, 9999, 3, 'user-1', 'resolution-2',
                 '{"sourceAudience":{"scope":"users","userIds":["user-1"]}}',
                 'message-1')`,
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
      expect(state.storage.sql.exec(
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'suggested_actions'`,
      ).toArray()).toEqual([]);
      expect(state.storage.sql.exec(
        `SELECT fence_id, audience_json FROM content_audience_fences ORDER BY fence_id`,
      ).toArray()).toEqual([
        {
          fence_id: "action-1:1",
          audience_json: '{"scope":"users","userIds":["user-1"]}',
        },
        {
          fence_id: "action-1:2",
          audience_json: '{"scope":"users","userIds":["user-1"]}',
        },
      ]);
      expect(() => state.storage.sql.exec(
        `INSERT INTO participants
           (user_id, participation_reason, added_by_user_id, status, participant_epoch,
            added_at, removed_at, first_opened_at, updated_at)
         VALUES ('user-2', 'explicit', 'user-1', 'active', 0, 2, NULL, NULL, 2)`,
      )).toThrow(/workstream_audience_restricted_content/);
      state.storage.sql.exec(
        `INSERT INTO workstream (
           id, workstream_key, parent_workspace_key, parent_do_id, parent_generation, region,
           authority_mode, authority_generation, title, description, preview, scope,
           exact_state, state_reason_code, next_sequence_number, next_attention_ordinal,
           unread_tracking_start_ordinal, authority_epoch, scope_epoch,
           source_authorization_floor, listing_epoch, deletion_epoch, run_revision,
           created_at, last_people_activity_at, state_changed_at, updated_at
         ) VALUES (
           1, 'workstream-1', 'workspace-1', NULL, 0, 'global',
           'authoritative', 1, 'Fixture', '', '', 'personal',
           'idle', 'seeded', 1, 1, 0, 0, 0,
           0, 0, 0, 0, 1, 1, 1, 1
         ) ON CONFLICT(id) DO NOTHING`,
      );
      state.storage.sql.exec(`UPDATE workstream SET scope = 'personal' WHERE id = 1`);
      expect(state.storage.sql.exec(`SELECT scope FROM workstream WHERE id = 1`).one())
        .toEqual({ scope: "personal" });
      expect(state.storage.sql.exec<{ sql: string | null }>(
        `SELECT sql FROM sqlite_schema
          WHERE type = 'trigger' AND name = 'workstream_restricted_content_scope'`,
      ).one().sql).toContain("content_audience_fences");
      expect(() => state.storage.sql.exec(
        `UPDATE workstream SET scope = 'workspace' WHERE id = 1`,
      )).toThrow(/workstream_audience_restricted_content/);
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
      ).toArray()).toEqual(
        WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS
          .filter((migration) => migration.version >= 33)
          .map((migration) => ({ version: migration.version })),
      );
      const pendingImmutableSql = String(state.storage.sql.exec<{ sql: string | null }>(
        `SELECT sql FROM sqlite_schema
          WHERE type = 'trigger' AND name = 'pending_loop_inputs_prepared_immutable'`,
      ).one().sql ?? "");
      expect(pendingImmutableSql).toContain("BEFORE UPDATE OF");
      expect(pendingImmutableSql).not.toMatch(/\binput_sequence\b/);
      expect(state.storage.sql.exec(`PRAGMA foreign_key_check`).toArray()).toEqual([]);
      expect(state.storage.sql.exec(`PRAGMA foreign_keys`).one()).toEqual({ foreign_keys: 1 });
    });
  });
  it("widens the populated mailbox's vocabulary without orphaning a delivered input", async () => {
    const stub = env.MIGRATION_PROBE_DO!.getByName("populated-v35-upgrade");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 35),
        component: "substream_agent_do",
        workerVersionId: "worker-v35",
        now: 1_000,
      });
      state.storage.sql.exec(
        `INSERT INTO substream_loops
           (id, loop_id, revision, status, cycle_ordinal, step_ordinal, bind_state_revision,
            next_input_sequence, next_assistant_turn_sequence, next_execution_sequence,
            created_at, updated_at)
         VALUES (1, 'loop-1', 1, 'idle', 0, 0, 0, 3, 1, 1, 1, 1)`,
      );
      // A preparation still in flight when the Worker rolled, and one that had
      // already been promoted. The second is what makes this a referenced-parent
      // rebuild: pending_loop_inputs points at the mailbox row.
      state.storage.sql.exec(
        `INSERT INTO pending_loop_input_mailbox
           (input_id, loop_id, input_sequence, admitted_after_transcript_sequence,
            client_message_id, preparation_kind, envelope_json, state, terminal_code,
            created_at, updated_at)
         VALUES ('input-preparing', 'loop-1', 1, 0, 'client-preparing',
                 'external_message', '{"kind":"fixture"}', 'preparing', NULL, 1, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO pending_loop_input_mailbox
           (input_id, loop_id, input_sequence, admitted_after_transcript_sequence,
            client_message_id, preparation_kind, envelope_json, state, terminal_code,
            created_at, updated_at)
         VALUES ('input-ready', 'loop-1', 2, 0, 'client-ready',
                 'human_message', NULL, 'ready', NULL, 1, 1)`,
      );

      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSTREAM_OBJECT_SCHEMA_MIGRATIONS,
        component: "substream_agent_do",
        workerVersionId: "worker-current",
        now: 2_000,
      });

      expect(state.storage.sql.exec<{
        input_id: string; preparation_kind: string; state: string; envelope_json: string | null;
      }>(
        `SELECT input_id, preparation_kind, state, envelope_json
           FROM pending_loop_input_mailbox ORDER BY input_sequence`,
      ).toArray()).toEqual([
        {
          input_id: "input-preparing",
          preparation_kind: "external_message",
          state: "preparing",
          envelope_json: '{"kind":"fixture"}',
        },
        {
          input_id: "input-ready",
          preparation_kind: "human_message",
          state: "ready",
          envelope_json: null,
        },
      ]);
      // The new kind is admitted, and the vocabulary is still closed: a rebuild
      // that dropped the CHECK would pass every assertion above.
      state.storage.sql.exec(
        `INSERT INTO pending_loop_input_mailbox
           (input_id, loop_id, input_sequence, admitted_after_transcript_sequence,
            client_message_id, preparation_kind, envelope_json, state, terminal_code,
            created_at, updated_at)
         VALUES ('input-activation', 'loop-1', 3, 0, 'client-activation',
                 'automation_activation', '{"kind":"fixture"}', 'preparing', NULL, 2, 2)`,
      );
      expect(() => state.storage.sql.exec(
        `INSERT INTO pending_loop_input_mailbox
           (input_id, loop_id, input_sequence, admitted_after_transcript_sequence,
            client_message_id, preparation_kind, envelope_json, state, terminal_code,
            created_at, updated_at)
         VALUES ('input-invented', 'loop-1', 4, 0, 'client-invented',
                 'telepathy', '{"kind":"fixture"}', 'preparing', NULL, 2, 2)`,
      )).toThrow();
      // The guards come back with the table, not just its columns: without them
      // a reserved preparation could be retargeted at another client message.
      expect(() => state.storage.sql.exec(
        `UPDATE pending_loop_input_mailbox
            SET client_message_id = 'client-stolen' WHERE input_id = 'input-activation'`,
      )).toThrow();
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM sqlite_schema WHERE name LIKE '%_v36'`,
      ).one()).toEqual({ count: 0 });
      expect(state.storage.sql.exec(`PRAGMA foreign_key_check`).toArray()).toEqual([]);
      expect(state.storage.sql.exec(`PRAGMA foreign_keys`).one()).toEqual({ foreign_keys: 1 });
    });
  });
});

describe("workspace schema migration in workerd", () => {
  it("settles a v25 dispatch at zero notes so a retry across the deploy takes none", async () => {
    // A fresh-schema test cannot prove this: it builds the whole ledger at
    // once, so the row it inserts already has the column. What the cutover
    // claims is about rows that existed *before* v26 — an operation whose
    // confirmation named work streams and nothing else, because the batch
    // surface did not reach notes at all. Left NULL, a half-published one of
    // those retried after the deploy would read as "the note half has not run
    // yet" and archive notes its reader was never told about. Zero is the true
    // receipt for it, and only an object upgraded from v25 shows it land.
    const stub = env.MIGRATION_PROBE_DO!.getByName("workspace-v25-batch-dispatch-upgrade");
    await stub.ping();
    await runInDurableObject(stub, (_instance, state) => {
      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS.filter((migration) => migration.version <= 25),
        component: "workspace_do",
        workerVersionId: "worker-v25",
        now: 1_000,
      });
      // An operation mid-flight across the deploy: one chunk published, one
      // still pending, which is exactly the state the receipts exist to resume.
      state.storage.sql.exec(
        `INSERT INTO workspace_batch_dispatches
           (operation_id, request_hash, user_id, target_count, created_at, updated_at)
         VALUES ('operation-1', 'fnv1a64:1111111111111111', 'user-1', 2, 1, 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO workspace_batch_dispatch_targets
           (operation_id, workstream_id, dispatched_at)
         VALUES ('operation-1', 'workstream-1', 1)`,
      );
      state.storage.sql.exec(
        `INSERT INTO workspace_batch_dispatch_targets
           (operation_id, workstream_id, dispatched_at)
         VALUES ('operation-1', 'workstream-2', NULL)`,
      );

      applyDurableObjectSqliteMigrations({
        storage: state.storage,
        migrations: WORKSPACE_DO_SCHEMA_MIGRATIONS,
        component: "workspace_do",
        workerVersionId: "worker-current",
        now: 2_000,
      });

      expect(state.storage.sql.exec<{
        operation_id: string;
        request_hash: string;
        user_id: string;
        target_count: number;
        archived_note_count: number | null;
      }>(
        `SELECT operation_id, request_hash, user_id, target_count, archived_note_count
           FROM workspace_batch_dispatches`,
      ).toArray()).toEqual([{
        operation_id: "operation-1",
        request_hash: "fnv1a64:1111111111111111",
        user_id: "user-1",
        target_count: 2,
        archived_note_count: 0,
      }]);
      // And it froze no notes for it, so even a caller that ignored the receipt
      // would find nothing to take.
      expect(state.storage.sql.exec(
        `SELECT COUNT(*) AS count FROM workspace_batch_dispatch_note_targets`,
      ).one()).toEqual({ count: 0 });
      // The pending target is what a resumed dispatch re-sends; losing it would
      // silently drop half the operation across the deploy.
      expect(state.storage.sql.exec<{ workstream_id: string; dispatched_at: number | null }>(
        `SELECT workstream_id, dispatched_at FROM workspace_batch_dispatch_targets
          ORDER BY workstream_id`,
      ).toArray()).toEqual([
        { workstream_id: "workstream-1", dispatched_at: 1 },
        { workstream_id: "workstream-2", dispatched_at: null },
      ]);

      // The column arrives writable and constrained, so the receipt the note
      // archive writes onto one of these upgraded rows still cannot go negative.
      state.storage.sql.exec(
        `UPDATE workspace_batch_dispatches SET archived_note_count = 3 WHERE operation_id = ?`,
        "operation-1",
      );
      expect(state.storage.sql.exec<{ archived_note_count: number | null }>(
        `SELECT archived_note_count FROM workspace_batch_dispatches`,
      ).one()).toEqual({ archived_note_count: 3 });
      expect(() => state.storage.sql.exec(
        `UPDATE workspace_batch_dispatches SET archived_note_count = -1 WHERE operation_id = ?`,
        "operation-1",
      )).toThrow();
      // A dispatch created *after* the upgrade still starts unset, or the note
      // half would never run for anything.
      state.storage.sql.exec(
        `INSERT INTO workspace_batch_dispatches
           (operation_id, request_hash, user_id, target_count, created_at, updated_at)
         VALUES ('operation-2', 'fnv1a64:2222222222222222', 'user-1', 0, 2, 2)`,
      );
      expect(state.storage.sql.exec<{ archived_note_count: number | null }>(
        `SELECT archived_note_count FROM workspace_batch_dispatches
          WHERE operation_id = 'operation-2'`,
      ).one()).toEqual({ archived_note_count: null });
      expect(state.storage.sql.exec(`PRAGMA foreign_key_check`).toArray()).toEqual([]);
    });
  });
});
