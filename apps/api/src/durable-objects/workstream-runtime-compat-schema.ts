/**
 * D1-shaped SQL views used by the generic Workflow runtime during the authority
 * cutover, and — read this before deleting anything here — three objects that
 * are not compatibility artifacts at all.
 *
 * Most of this array is views and `INSTEAD OF` triggers over normalized
 * conversation (`AgentLoopDO`) tables, and all of that goes when the layer is retired. Three
 * statements do not:
 *
 * - `attachment_tool_receipts` and its index are a real `STRICT` data table
 *   holding live product data — the resource version each replayable attachment
 *   read depends on. It has no view, no trigger, and no compat vocabulary; it is
 *   here only because this is where it was written. Dropping it loses rows.
 * - `tool_effects_run_call_uq` is a unique index on real columns of a real
 *   table. It is what makes the routed `ON CONFLICT(harness_run_id,
 *   tool_call_id) DO NOTHING` mean what it says after `workstream-runtime-sql`
 *   strips the clause, so it is the replay dedup for every tool receipt.
 *   Dropping it changes nothing observable and then silently admits two receipts
 *   for one call.
 *
 * `_runtime_statement_changes` is the genuine counterexample: a data table that
 * really is compat machinery, and really does go.
 *
 * An earlier version of this comment claimed these statements "deliberately
 * create no compatibility data tables". That is the sentence a drop migration
 * would be written against, and it is false three lines below its own text. The
 * rule it should have carried: **derive a drop set from what each object is,
 * never from the file it lives in.** Retiring the views means first moving the
 * two keeps into `workstream-object-schema.ts`.
 */
export const WORKSTREAM_RUNTIME_COMPAT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS attachment_tool_receipts (
    workspace_id TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    tool_invocation_id TEXT NOT NULL REFERENCES tool_effects(effect_intent_id) ON DELETE CASCADE,
    derivative_sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (resource_id, tool_invocation_id)
  ) STRICT`,
  `CREATE INDEX IF NOT EXISTS attachment_tool_receipts_invocation_idx
     ON attachment_tool_receipts(tool_invocation_id, resource_id)`,
  `CREATE TABLE IF NOT EXISTS _runtime_statement_changes (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    changes INTEGER NOT NULL DEFAULT 0 CHECK (changes >= 0)
  ) STRICT`,
  `INSERT OR IGNORE INTO _runtime_statement_changes(id, changes) VALUES (1, 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS tool_effects_run_call_uq
     ON tool_effects(run_id, tool_call_id)`,

  `CREATE VIEW IF NOT EXISTS _runtime_workstreams AS
     SELECT workstream_key AS id,
            parent_workspace_key AS workspace_id,
            title,
            description AS objective,
            origin_type,
            created_by_user_id,
            automation_subscription_id,
            automation_run_id,
            CASE WHEN planned_for IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', planned_for / 1000.0, 'unixepoch') END AS planned_for,
            CASE
              WHEN exact_state = 'scheduled' THEN 'scheduled'
              WHEN exact_state IN ('running', 'interrupting', 'preparing_context', 'waiting_capacity') THEN 'running'
              WHEN exact_state = 'needs_input' THEN 'needs_input'
              WHEN exact_state = 'completed' THEN 'completed'
              WHEN exact_state IN ('failed', 'budget_exhausted') THEN 'failed'
              ELSE 'idle'
            END AS harness_status,
            next_sequence_number,
            MAX(0, next_attention_ordinal - 1) AS latest_attention_sequence_number,
            unread_tracking_start_ordinal AS unread_tracking_start_sequence_number,
            strftime('%Y-%m-%dT%H:%M:%fZ', last_people_activity_at / 1000.0, 'unixepoch') AS last_activity_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch') AS created_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', updated_at / 1000.0, 'unixepoch') AS updated_at,
            CASE WHEN archived_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', archived_at / 1000.0, 'unixepoch') END AS archived_at,
            email_address,
            email_route_status,
            created_from_opportunity_id,
            opportunity_version,
            opportunity_display_prompt_hash,
            opportunity_execution_prompt_hash,
            description_source,
            system_kind,
            scope,
            title_status,
            model_override
       FROM workstream WHERE id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_workstreams_insert
     INSTEAD OF INSERT ON _runtime_workstreams BEGIN
       UPDATE workstream SET
          title = COALESCE(NEW.title, title),
          description = COALESCE(NEW.objective, description),
          origin_type = COALESCE(NEW.origin_type, origin_type),
          created_by_user_id = NEW.created_by_user_id,
          automation_subscription_id = NEW.automation_subscription_id,
          automation_run_id = NEW.automation_run_id,
          planned_for = CASE WHEN NEW.planned_for IS NULL THEN NULL
            ELSE CAST((julianday(NEW.planned_for) - 2440587.5) * 86400000 AS INTEGER) END,
          exact_state = CASE COALESCE(NEW.harness_status, 'idle')
            WHEN 'scheduled' THEN 'scheduled'
            WHEN 'running' THEN 'running'
            WHEN 'needs_input' THEN 'needs_input'
            WHEN 'completed' THEN 'completed'
            WHEN 'failed' THEN 'failed'
            ELSE 'idle' END,
          state_reason_code = 'runtime_created',
          next_sequence_number = MAX(1, COALESCE(NEW.next_sequence_number, 1)),
          next_attention_ordinal = MAX(1, COALESCE(NEW.latest_attention_sequence_number, 0) + 1),
          unread_tracking_start_ordinal = MAX(0, COALESCE(NEW.unread_tracking_start_sequence_number, 0)),
          last_people_activity_at = CAST((julianday(COALESCE(NEW.last_activity_at, NEW.created_at)) - 2440587.5) * 86400000 AS INTEGER),
          created_at = CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER),
          updated_at = CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER),
          archived_at = CASE WHEN NEW.archived_at IS NULL THEN NULL
            ELSE CAST((julianday(NEW.archived_at) - 2440587.5) * 86400000 AS INTEGER) END,
          email_address = NEW.email_address,
          email_route_status = COALESCE(NEW.email_route_status, email_route_status),
          created_from_opportunity_id = NEW.created_from_opportunity_id,
          opportunity_version = NEW.opportunity_version,
          opportunity_display_prompt_hash = NEW.opportunity_display_prompt_hash,
          opportunity_execution_prompt_hash = NEW.opportunity_execution_prompt_hash,
          description_source = COALESCE(NEW.description_source, description_source),
          system_kind = NEW.system_kind,
          scope = COALESCE(NEW.scope, scope),
          title_status = COALESCE(NEW.title_status, title_status),
          model_override = NEW.model_override,
          listing_epoch = listing_epoch + 1,
          state_changed_at = CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER)
        WHERE id = 1 AND workstream_key = NEW.id AND parent_workspace_key = NEW.workspace_id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_workstreams_update
     INSTEAD OF UPDATE ON _runtime_workstreams BEGIN
       UPDATE workstream
          SET title = NEW.title,
              description = NEW.objective,
              description_source = NEW.description_source,
              title_status = NEW.title_status,
              scope = NEW.scope,
              model_override = NEW.model_override,
              created_by_user_id = NEW.created_by_user_id,
              automation_subscription_id = NEW.automation_subscription_id,
              automation_run_id = NEW.automation_run_id,
              planned_for = CASE WHEN NEW.planned_for IS NULL THEN NULL
                ELSE CAST((julianday(NEW.planned_for) - 2440587.5) * 86400000 AS INTEGER) END,
              email_address = NEW.email_address,
              email_route_status = NEW.email_route_status,
              created_from_opportunity_id = NEW.created_from_opportunity_id,
              opportunity_version = NEW.opportunity_version,
              opportunity_display_prompt_hash = NEW.opportunity_display_prompt_hash,
              opportunity_execution_prompt_hash = NEW.opportunity_execution_prompt_hash,
              system_kind = NEW.system_kind,
              archived_at = CASE WHEN NEW.archived_at IS NULL THEN NULL
                ELSE CAST((julianday(NEW.archived_at) - 2440587.5) * 86400000 AS INTEGER) END,
              exact_state = CASE WHEN NEW.harness_status = OLD.harness_status
                THEN exact_state ELSE CASE NEW.harness_status
                  WHEN 'scheduled' THEN 'scheduled'
                  WHEN 'running' THEN 'running'
                  WHEN 'needs_input' THEN 'needs_input'
                  WHEN 'completed' THEN 'completed'
                  WHEN 'failed' THEN 'failed'
                  ELSE 'idle' END END,
              state_reason_code = CASE WHEN NEW.harness_status != OLD.harness_status
                THEN 'runtime_' || NEW.harness_status ELSE state_reason_code END,
              next_sequence_number = NEW.next_sequence_number,
              unread_tracking_start_ordinal = NEW.unread_tracking_start_sequence_number,
              last_people_activity_at = CAST((julianday(NEW.last_activity_at) - 2440587.5) * 86400000 AS INTEGER),
              state_changed_at = CASE WHEN NEW.harness_status != OLD.harness_status
                THEN CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER)
                ELSE state_changed_at END,
              completed_at = CASE WHEN NEW.harness_status = 'completed'
                THEN COALESCE(completed_at, CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER))
                ELSE completed_at END,
              updated_at = CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER)
        WHERE id = 1 AND workstream_key = OLD.id AND parent_workspace_key = OLD.workspace_id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_harness_runs AS
     SELECT run.run_id AS id,
            root.parent_workspace_key AS workspace_id,
            root.workstream_key AS workstream_id,
            run.origin,
            run.execution_principal_json,
            run.workflow_instance_id,
            run.parent_run_id AS parent_harness_run_id,
            CASE run.status WHEN 'admitted' THEN 'scheduled' WHEN 'cancelled' THEN 'stopped'
              WHEN 'waiting' THEN 'running' WHEN 'steering' THEN 'running' ELSE run.status END AS status,
            strftime('%Y-%m-%dT%H:%M:%fZ', run.started_at / 1000.0, 'unixepoch') AS started_at,
            CASE WHEN run.completed_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', run.completed_at / 1000.0, 'unixepoch') END AS completed_at,
            run.model,
            run.usage_json,
            run.error_json,
            run.created_at AS _created_at_epoch,
            strftime('%Y-%m-%dT%H:%M:%fZ', run.created_at / 1000.0, 'unixepoch') AS created_at,
            run.legacy_attempt_id AS attempt_id,
            run.attempt_epoch AS attempt_number,
            run.lease_owner,
            CASE WHEN run.lease_expires_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', run.lease_expires_at / 1000.0, 'unixepoch') END AS lease_expires_at,
            CASE WHEN run.heartbeat_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', run.heartbeat_at / 1000.0, 'unixepoch') END AS heartbeat_at,
            CASE WHEN run.cancellation_requested_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', run.cancellation_requested_at / 1000.0, 'unixepoch') END AS cancellation_requested_at,
            run.cancellation_reason,
            run.final_part_id AS final_message_id,
            CASE WHEN run.terminalized_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', run.terminalized_at / 1000.0, 'unixepoch') END AS terminalized_at,
            run.parent_tool_call_id,
            run.chain_root_run_id AS chain_root_harness_run_id,
            run.chain_depth,
            run.delegated_task_hash,
            run.inherited_scope_hash,
            run.child_result_json,
            run.child_result_hash,
            run.trigger_part_id AS trigger_message_id
       FROM runs run CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_harness_runs_insert
     INSTEAD OF INSERT ON _runtime_harness_runs BEGIN
       INSERT OR IGNORE INTO substreams
         (id, kind, inherit_mode, inherit_from_substream_id, inherit_fence_seq, depth,
          return_mode, origin_part_id, owner_user_id, audience, tool_policy, status, created_at, closed_at)
       SELECT 'run:' || NEW.id, 'agent', 'fork', '0', 0, MIN(4, COALESCE(NEW.chain_depth, 1)),
              'tool_result', NULL, NULL, 'system', 'read_only', 'open',
              CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER), NULL
        WHERE NEW.parent_tool_call_id IS NOT NULL;
       INSERT OR IGNORE INTO runs
         (run_id, substream_id, workflow_instance_id, status, budget, attempt_epoch,
          model_iteration, next_action_cursor, input_fence_seq, revision, started_at,
          active_elapsed_ms, idle_elapsed_ms, step_count, subrequest_count, retry_count,
          tool_count, input_tokens, output_tokens, cost_micros, output_bytes, terminal_reason,
          origin, execution_principal_json, parent_run_id, parent_tool_call_id, chain_root_run_id,
          chain_depth, model, usage_json, error_json, legacy_attempt_id, lease_owner,
          lease_expires_at, heartbeat_at, cancellation_requested_at, cancellation_reason,
          final_part_id, terminalized_at, delegated_task_hash, inherited_scope_hash,
          child_result_json, child_result_hash, trigger_part_id, completed_at, created_at, updated_at)
       VALUES (
         NEW.id, CASE WHEN NEW.parent_tool_call_id IS NULL THEN '0' ELSE 'run:' || NEW.id END,
         NEW.workflow_instance_id,
         CASE NEW.status WHEN 'scheduled' THEN 'admitted' WHEN 'stopped' THEN 'cancelled' ELSE NEW.status END,
         '{}', COALESCE(NEW.attempt_number, 0), 0, '', 0, 0,
         CAST((julianday(COALESCE(NEW.started_at, NEW.created_at)) - 2440587.5) * 86400000 AS INTEGER),
         0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
         CASE WHEN NEW.status = 'stopped' THEN 'cancelled' ELSE NULL END,
         NEW.origin, COALESCE(NEW.execution_principal_json, '{}'), NEW.parent_harness_run_id,
         NEW.parent_tool_call_id, NEW.chain_root_harness_run_id, COALESCE(NEW.chain_depth, 0),
         NEW.model, NEW.usage_json, NEW.error_json, NEW.attempt_id, NEW.lease_owner,
         CASE WHEN NEW.lease_expires_at IS NULL THEN NULL ELSE CAST((julianday(NEW.lease_expires_at) - 2440587.5) * 86400000 AS INTEGER) END,
         CASE WHEN NEW.heartbeat_at IS NULL THEN NULL ELSE CAST((julianday(NEW.heartbeat_at) - 2440587.5) * 86400000 AS INTEGER) END,
         CASE WHEN NEW.cancellation_requested_at IS NULL THEN NULL ELSE CAST((julianday(NEW.cancellation_requested_at) - 2440587.5) * 86400000 AS INTEGER) END,
         NEW.cancellation_reason, NEW.final_message_id,
         CASE WHEN NEW.terminalized_at IS NULL THEN NULL ELSE CAST((julianday(NEW.terminalized_at) - 2440587.5) * 86400000 AS INTEGER) END,
         NEW.delegated_task_hash, NEW.inherited_scope_hash, NEW.child_result_json,
         NEW.child_result_hash, NEW.trigger_message_id,
         CASE WHEN NEW.completed_at IS NULL THEN NULL ELSE CAST((julianday(NEW.completed_at) - 2440587.5) * 86400000 AS INTEGER) END,
         CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER),
         CAST((julianday(COALESCE(NEW.heartbeat_at, NEW.completed_at, NEW.created_at)) - 2440587.5) * 86400000 AS INTEGER));
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_harness_runs_update
     INSTEAD OF UPDATE ON _runtime_harness_runs BEGIN
       UPDATE runs SET
         workflow_instance_id = NEW.workflow_instance_id,
         status = CASE NEW.status WHEN 'scheduled' THEN 'admitted' WHEN 'stopped' THEN 'cancelled' ELSE NEW.status END,
         started_at = CAST((julianday(NEW.started_at) - 2440587.5) * 86400000 AS INTEGER),
         completed_at = CASE WHEN NEW.completed_at IS NULL THEN NULL ELSE CAST((julianday(NEW.completed_at) - 2440587.5) * 86400000 AS INTEGER) END,
         model = NEW.model, usage_json = NEW.usage_json, error_json = NEW.error_json,
         attempt_epoch = NEW.attempt_number, legacy_attempt_id = NEW.attempt_id,
         lease_owner = NEW.lease_owner,
         lease_expires_at = CASE WHEN NEW.lease_expires_at IS NULL THEN NULL ELSE CAST((julianday(NEW.lease_expires_at) - 2440587.5) * 86400000 AS INTEGER) END,
         heartbeat_at = CASE WHEN NEW.heartbeat_at IS NULL THEN NULL ELSE CAST((julianday(NEW.heartbeat_at) - 2440587.5) * 86400000 AS INTEGER) END,
         cancellation_requested_at = CASE WHEN NEW.cancellation_requested_at IS NULL THEN NULL ELSE CAST((julianday(NEW.cancellation_requested_at) - 2440587.5) * 86400000 AS INTEGER) END,
         cancellation_reason = NEW.cancellation_reason, final_part_id = NEW.final_message_id,
         terminalized_at = CASE WHEN NEW.terminalized_at IS NULL THEN NULL ELSE CAST((julianday(NEW.terminalized_at) - 2440587.5) * 86400000 AS INTEGER) END,
         child_result_json = NEW.child_result_json, child_result_hash = NEW.child_result_hash,
         updated_at = CAST((julianday(COALESCE(NEW.heartbeat_at, NEW.completed_at, NEW.created_at)) - 2440587.5) * 86400000 AS INTEGER)
        WHERE run_id = OLD.id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_messages AS
     SELECT part.id, part.client_message_id, root.parent_workspace_key AS workspace_id,
            root.workstream_key AS workstream_id,
            CASE part.author_type
              WHEN 'member' THEN 'human'
              WHEN 'agent' THEN 'agent'
              WHEN 'external' THEN 'external'
              ELSE 'system'
            END AS author_type,
            part.author_user_id, part.message_type,
            COALESCE(part.content, '') AS text_content, part.structured_content_json,
            part.sequence_number,
            strftime('%Y-%m-%dT%H:%M:%fZ', part.created_at / 1000.0, 'unixepoch') AS created_at,
            CASE WHEN part.edited_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', part.edited_at / 1000.0, 'unixepoch') END AS edited_at,
            part.produced_by_run_id AS harness_run_id,
            run.legacy_attempt_id AS harness_attempt_id,
            part.external_actor_json
       FROM parts part CROSS JOIN workstream root
       LEFT JOIN runs run ON run.run_id = part.produced_by_run_id
      WHERE root.id = 1 AND part.substream_id = '0'`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_messages_insert
     INSTEAD OF INSERT ON _runtime_messages BEGIN
       INSERT INTO parts
         (id, substream_id, sequence_number, attention_ordinal, role, kind, author_type,
          author_user_id, external_actor_json, content, client_message_id, effect_intent_id,
          produced_by_run_id, attempt_epoch, tool_name, tool_mode, tool_status, visibility,
          pinned, message_type, structured_content_json, edited_at, created_at, updated_at)
       VALUES (
         NEW.id, '0', NEW.sequence_number,
         CASE WHEN NEW.message_type = 'tool' THEN NULL ELSE (SELECT next_attention_ordinal FROM workstream WHERE id = 1) END,
         CASE NEW.author_type
           WHEN 'human' THEN 'user'
           WHEN 'agent' THEN 'assistant'
           WHEN 'external' THEN 'user'
           ELSE 'system'
         END,
         CASE WHEN NEW.message_type = 'tool' THEN 'tool_call' ELSE 'text' END,
         CASE NEW.author_type
           WHEN 'human' THEN 'member'
           WHEN 'agent' THEN 'agent'
           WHEN 'external' THEN 'external'
           ELSE 'system'
         END,
         NEW.author_user_id, NEW.external_actor_json, COALESCE(NEW.text_content, ''),
         NEW.client_message_id, CASE WHEN NEW.message_type = 'tool' THEN NEW.id ELSE NULL END,
         NEW.harness_run_id,
         (SELECT attempt_epoch FROM runs WHERE run_id = NEW.harness_run_id),
         CASE WHEN NEW.message_type = 'tool' THEN json_extract(NEW.structured_content_json, '$.invocation.toolName') ELSE NULL END,
         CASE WHEN NEW.message_type = 'tool' THEN 'read' ELSE NULL END,
         CASE WHEN NEW.message_type = 'tool' THEN CASE
           WHEN json_extract(NEW.structured_content_json, '$.invocation.status') = 'pending' THEN 'pending'
           WHEN json_extract(NEW.structured_content_json, '$.invocation.status') = 'started' THEN 'pending'
           WHEN json_extract(NEW.structured_content_json, '$.invocation.status') = 'ambiguous' THEN 'ambiguous'
           WHEN json_extract(NEW.structured_content_json, '$.invocation.status') = 'failed' THEN 'failed'
           ELSE 'completed' END ELSE NULL END,
         CASE WHEN NEW.message_type IN ('text', 'elicitation') THEN 'both' ELSE 'people' END,
         0, NEW.message_type, NEW.structured_content_json,
         CASE WHEN NEW.edited_at IS NULL THEN NULL ELSE CAST((julianday(NEW.edited_at) - 2440587.5) * 86400000 AS INTEGER) END,
         CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER),
         CAST((julianday(COALESCE(NEW.edited_at, NEW.created_at)) - 2440587.5) * 86400000 AS INTEGER))
       ON CONFLICT(id) DO UPDATE SET
         structured_content_json = excluded.structured_content_json,
         tool_status = excluded.tool_status,
         edited_at = excluded.edited_at,
         updated_at = excluded.updated_at
       WHERE parts.message_type = 'tool';
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
       UPDATE workstream SET
         next_attention_ordinal = next_attention_ordinal + CASE WHEN NEW.message_type = 'tool' THEN 0 ELSE 1 END,
         last_people_activity_at = CASE WHEN NEW.message_type = 'tool' THEN last_people_activity_at
           ELSE CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER) END,
         updated_at = CAST((julianday(COALESCE(NEW.edited_at, NEW.created_at)) - 2440587.5) * 86400000 AS INTEGER)
       WHERE id = 1 AND (SELECT changes FROM _runtime_statement_changes WHERE id = 1) > 0;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_run_scopes AS
     SELECT scope.run_id AS harness_run_id, root.parent_workspace_key AS workspace_id,
            root.workstream_key AS workstream_id, scope.attempt_id, scope.execution_principal_json,
            scope.eligible_connection_ids_json, scope.eligible_capabilities_json,
            scope.eligible_connection_capabilities_json, scope.trigger_policy_json,
            scope.routing_policy_version, scope.prompt_version, scope.tool_surface_hash,
            scope.limits_json, scope.scope_hash, scope.memory_context_hash,
            strftime('%Y-%m-%dT%H:%M:%fZ', scope.created_at / 1000.0, 'unixepoch') AS created_at
       FROM run_scopes scope CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_run_scopes_insert
     INSTEAD OF INSERT ON _runtime_run_scopes BEGIN
       INSERT OR IGNORE INTO run_scopes
         (run_id, attempt_id, execution_principal_json, eligible_connection_ids_json,
          eligible_capabilities_json, eligible_connection_capabilities_json, trigger_policy_json,
          routing_policy_version, prompt_version, tool_surface_hash, limits_json, scope_hash,
          memory_context_hash, created_at)
       VALUES (NEW.harness_run_id, NEW.attempt_id, NEW.execution_principal_json,
          NEW.eligible_connection_ids_json, NEW.eligible_capabilities_json,
          NEW.eligible_connection_capabilities_json, NEW.trigger_policy_json,
          NEW.routing_policy_version, NEW.prompt_version, NEW.tool_surface_hash,
          NEW.limits_json, NEW.scope_hash, NEW.memory_context_hash,
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER));
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_run_memory_contexts AS
     SELECT context.run_id AS harness_run_id, root.parent_workspace_key AS workspace_id,
            root.workstream_key AS workstream_id, context.attempt_id,
            context.memory_scope_ids_json, context.query_text, context.retrieval_mode,
            context.results_json, context.memory_context_hash,
            strftime('%Y-%m-%dT%H:%M:%fZ', context.created_at / 1000.0, 'unixepoch') AS created_at
       FROM run_memory_contexts context CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_run_memory_contexts_insert
     INSTEAD OF INSERT ON _runtime_run_memory_contexts BEGIN
       INSERT OR IGNORE INTO run_memory_contexts
         (run_id, attempt_id, memory_scope_ids_json, query_text, retrieval_mode,
          results_json, memory_context_hash, created_at)
       VALUES (NEW.harness_run_id, NEW.attempt_id, NEW.memory_scope_ids_json, NEW.query_text,
          NEW.retrieval_mode, NEW.results_json, NEW.memory_context_hash,
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER));
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_run_plugin_activations AS
     SELECT run_id AS harness_run_id, attempt_id, plugin_id, tool_surface_hash,
            strftime('%Y-%m-%dT%H:%M:%fZ', authorized_at / 1000.0, 'unixepoch') AS authorized_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', activated_at / 1000.0, 'unixepoch') AS activated_at
       FROM run_plugin_activations`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_run_plugin_activations_insert
     INSTEAD OF INSERT ON _runtime_run_plugin_activations BEGIN
       INSERT OR IGNORE INTO run_plugin_activations
         (run_id, attempt_id, plugin_id, tool_surface_hash, authorized_at, activated_at)
       VALUES (NEW.harness_run_id, NEW.attempt_id, NEW.plugin_id, NEW.tool_surface_hash,
          CAST((julianday(NEW.authorized_at) - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday(NEW.activated_at) - 2440587.5) * 86400000 AS INTEGER));
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_run_lifecycle_events AS
     SELECT event.event_id AS id, event.run_id AS harness_run_id,
            root.parent_workspace_key AS workspace_id, root.workstream_key AS workstream_id,
            event.attempt_id, event.event_key, event.event_type, event.status,
            event.member_safe_payload_json,
            strftime('%Y-%m-%dT%H:%M:%fZ', event.created_at / 1000.0, 'unixepoch') AS created_at
       FROM run_lifecycle_events event CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_run_lifecycle_events_insert
     INSTEAD OF INSERT ON _runtime_run_lifecycle_events BEGIN
       INSERT OR IGNORE INTO run_lifecycle_events
         (event_id, run_id, attempt_id, event_key, event_type, status, member_safe_payload_json, created_at)
       VALUES (NEW.id, NEW.harness_run_id, NEW.attempt_id, NEW.event_key, NEW.event_type,
          NEW.status, COALESCE(NEW.member_safe_payload_json, '{}'),
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER));
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_inference_attempts AS
     SELECT attempt.inference_attempt_id AS id, attempt.run_id AS harness_run_id,
            root.parent_workspace_key AS workspace_id, root.workstream_key AS workstream_id,
            attempt.attempt_id, attempt.turn_id, attempt.endpoint_attempt, attempt.fallback_attempt,
            attempt.provider, attempt.model, attempt.credential_source_hash,
            attempt.workspace_identity_hash, attempt.routing_decision_json, attempt.outcome,
            attempt.failure_classification, attempt.latency_ms, attempt.ttft_ms,
            attempt.input_tokens, attempt.output_tokens, attempt.reasoning_tokens,
            attempt.cached_tokens, attempt.cost_micros AS cost_microusd, attempt.response_bytes,
            strftime('%Y-%m-%dT%H:%M:%fZ', attempt.started_at / 1000.0, 'unixepoch') AS started_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', attempt.completed_at / 1000.0, 'unixepoch') AS completed_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', attempt.created_at / 1000.0, 'unixepoch') AS created_at
       FROM inference_attempts attempt CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_inference_attempts_insert
     INSTEAD OF INSERT ON _runtime_inference_attempts BEGIN
       INSERT OR IGNORE INTO inference_attempts
         (inference_attempt_id, run_id, attempt_id, turn_id, endpoint_attempt, fallback_attempt,
          provider, model, credential_source_hash, workspace_identity_hash, routing_decision_json,
          outcome, failure_classification, latency_ms, ttft_ms, input_tokens, output_tokens,
          reasoning_tokens, cached_tokens, cost_micros, response_bytes, started_at, completed_at, created_at)
       VALUES (NEW.id, NEW.harness_run_id, NEW.attempt_id, NEW.turn_id, NEW.endpoint_attempt,
          NEW.fallback_attempt, NEW.provider, NEW.model, NEW.credential_source_hash,
          NEW.workspace_identity_hash, NEW.routing_decision_json, NEW.outcome,
          NEW.failure_classification, NEW.latency_ms, NEW.ttft_ms, NEW.input_tokens,
          NEW.output_tokens, NEW.reasoning_tokens, NEW.cached_tokens, NEW.cost_microusd,
          NEW.response_bytes,
          CAST((julianday(NEW.started_at) - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday(NEW.completed_at) - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER));
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_tool_invocations AS
     SELECT effect.effect_intent_id AS id, root.parent_workspace_key AS workspace_id,
            root.workstream_key AS workstream_id, effect.run_id AS harness_run_id,
            effect.tool_call_id, effect.tool_name, effect.connection_id,
            effect.request_hash AS input_hash, effect.input_json, effect.output_ref,
            effect.output_summary, effect.provider_operation_id,
            CASE effect.status WHEN 'admitted' THEN 'pending' WHEN 'executing' THEN 'started' ELSE effect.status END AS status,
            CASE WHEN effect.started_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', effect.started_at / 1000.0, 'unixepoch') END AS started_at,
            CASE WHEN effect.settled_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', effect.settled_at / 1000.0, 'unixepoch') END AS completed_at,
            effect.error_json, run.legacy_attempt_id AS attempt_id,
            effect.execution_plan_hash, effect.execution_plan_json, effect.provider_idempotency_key,
            CASE WHEN run.lease_expires_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', run.lease_expires_at / 1000.0, 'unixepoch') END AS lease_expires_at,
            effect.checkpoint_index,
            (SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MAX(checkpoint.created_at) / 1000.0, 'unixepoch')
               FROM tool_effect_checkpoints checkpoint WHERE checkpoint.effect_intent_id = effect.effect_intent_id) AS last_checkpoint_at
       FROM tool_effects effect JOIN runs run ON run.run_id = effect.run_id
       CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_tool_invocations_insert
     INSTEAD OF INSERT ON _runtime_tool_invocations BEGIN
       INSERT OR IGNORE INTO tool_effects
         (effect_intent_id, run_id, attempt_epoch, tool_position, occurrence_key, tool_name,
          mode, request_hash, authority_revision, status, provider_operation_id, started_at,
          settled_at, result_hash, tool_call_id, connection_id, input_json, output_ref,
          output_summary, error_json, execution_plan_hash, execution_plan_json,
          provider_idempotency_key, checkpoint_index)
       VALUES (NEW.id, NEW.harness_run_id,
          (SELECT attempt_epoch FROM runs WHERE run_id = NEW.harness_run_id),
          (SELECT COUNT(*) FROM tool_effects WHERE run_id = NEW.harness_run_id),
          'runtime:' || NEW.id, NEW.tool_name,
          CASE WHEN json_extract(NEW.execution_plan_json, '$.mode') = 'write' THEN 'write' ELSE 'read' END,
          NEW.input_hash, COALESCE(NEW.execution_plan_hash, 'runtime'),
          CASE NEW.status WHEN 'pending' THEN 'admitted' WHEN 'started' THEN 'executing' ELSE NEW.status END,
          NEW.provider_operation_id,
          CASE WHEN NEW.started_at IS NULL THEN NULL ELSE CAST((julianday(NEW.started_at) - 2440587.5) * 86400000 AS INTEGER) END,
          CASE WHEN NEW.completed_at IS NULL THEN NULL ELSE CAST((julianday(NEW.completed_at) - 2440587.5) * 86400000 AS INTEGER) END,
          COALESCE(NEW.output_ref, NEW.output_summary), NEW.tool_call_id, NEW.connection_id,
          COALESCE(NEW.input_json, '{}'), NEW.output_ref, NEW.output_summary, NEW.error_json,
          NEW.execution_plan_hash, NEW.execution_plan_json, NEW.provider_idempotency_key,
          COALESCE(NEW.checkpoint_index, 0));
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_tool_invocations_update
     INSTEAD OF UPDATE ON _runtime_tool_invocations BEGIN
       UPDATE tool_effects SET
         status = CASE NEW.status WHEN 'pending' THEN 'admitted' WHEN 'started' THEN 'executing' ELSE NEW.status END,
         provider_operation_id = NEW.provider_operation_id,
         started_at = CASE WHEN NEW.started_at IS NULL THEN NULL ELSE CAST((julianday(NEW.started_at) - 2440587.5) * 86400000 AS INTEGER) END,
         settled_at = CASE WHEN NEW.completed_at IS NULL THEN NULL ELSE CAST((julianday(NEW.completed_at) - 2440587.5) * 86400000 AS INTEGER) END,
         result_hash = COALESCE(NEW.output_ref, NEW.output_summary, result_hash),
         output_ref = NEW.output_ref, output_summary = NEW.output_summary,
         error_json = NEW.error_json, checkpoint_index = NEW.checkpoint_index
        WHERE effect_intent_id = OLD.id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_tool_invocations_delete
     INSTEAD OF DELETE ON _runtime_tool_invocations BEGIN
       DELETE FROM tool_effects WHERE effect_intent_id = OLD.id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_tool_checkpoints AS
     SELECT checkpoint_id AS id, effect_intent_id AS tool_invocation_id,
            run_id AS harness_run_id, attempt_id, checkpoint_index, phase,
            member_safe_payload_json,
            strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch') AS created_at
       FROM tool_effect_checkpoints`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_tool_checkpoints_insert
     INSTEAD OF INSERT ON _runtime_tool_checkpoints BEGIN
       INSERT OR IGNORE INTO tool_effect_checkpoints
         (checkpoint_id, effect_intent_id, run_id, attempt_id, checkpoint_index,
          phase, member_safe_payload_json, created_at)
       VALUES (NEW.id, NEW.tool_invocation_id, NEW.harness_run_id, NEW.attempt_id,
          NEW.checkpoint_index, NEW.phase, COALESCE(NEW.member_safe_payload_json, '{}'),
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER));
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_elicitations AS
     SELECT request.elicitation_id AS id, root.parent_workspace_key AS workspace_id,
            root.workstream_key AS workstream_id, request.run_id AS harness_run_id,
            request.prompt, request.response_type, request.options_json,
            request.minimum_selections, request.maximum_selections, request.target_user_id,
            CASE request.status WHEN 'pending' THEN 'open' ELSE request.status END AS status,
            request.answer_json, request.answered_by_user_id,
            strftime('%Y-%m-%dT%H:%M:%fZ', request.created_at / 1000.0, 'unixepoch') AS created_at,
            CASE WHEN request.answered_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', request.answered_at / 1000.0, 'unixepoch') END AS answered_at,
            request.external_actor_json AS answered_by_external_actor_json
       FROM elicitation_requests request CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_elicitations_insert
     INSTEAD OF INSERT ON _runtime_elicitations BEGIN
       INSERT OR IGNORE INTO elicitation_requests
         (elicitation_id, run_id, prompt, response_type, options_json, minimum_selections,
          maximum_selections, target_user_id, status, answer_json, answered_by_user_id,
          external_actor_json, created_at, answered_at)
       VALUES (NEW.id, NEW.harness_run_id, NEW.prompt, NEW.response_type,
          COALESCE(NEW.options_json, '[]'), COALESCE(NEW.minimum_selections, 0),
          NEW.maximum_selections, NEW.target_user_id,
          CASE NEW.status WHEN 'open' THEN 'pending' ELSE NEW.status END,
          NEW.answer_json, NEW.answered_by_user_id, NEW.answered_by_external_actor_json,
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER),
          CASE WHEN NEW.answered_at IS NULL THEN NULL ELSE CAST((julianday(NEW.answered_at) - 2440587.5) * 86400000 AS INTEGER) END);
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_elicitations_update
     INSTEAD OF UPDATE ON _runtime_elicitations BEGIN
       UPDATE elicitation_requests SET
          status = CASE NEW.status WHEN 'open' THEN 'pending' ELSE NEW.status END,
          answer_json = NEW.answer_json,
          answered_by_user_id = NEW.answered_by_user_id,
          external_actor_json = NEW.answered_by_external_actor_json,
          answered_at = CASE WHEN NEW.answered_at IS NULL THEN NULL
            ELSE CAST((julianday(NEW.answered_at) - 2440587.5) * 86400000 AS INTEGER) END
        WHERE elicitation_id = OLD.id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_compactions AS
     SELECT root.parent_workspace_key AS workspace_id, root.workstream_key AS workstream_id,
            checkpoint.execution_principal_key, checkpoint.resource_visibility_fingerprint,
            checkpoint.checkpoint_template_version, checkpoint.run_id AS harness_run_id,
            checkpoint.compacted_through_sequence, checkpoint.messages_json, checkpoint.summary,
            checkpoint.model, checkpoint.context_tokens_before_compaction,
            checkpoint.context_window_tokens, checkpoint.input_tokens, checkpoint.output_tokens,
            checkpoint.cost_micros AS cost_microusd,
            strftime('%Y-%m-%dT%H:%M:%fZ', checkpoint.created_at / 1000.0, 'unixepoch') AS created_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', checkpoint.updated_at / 1000.0, 'unixepoch') AS updated_at
       FROM compaction_checkpoints checkpoint CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_compactions_insert
     INSTEAD OF INSERT ON _runtime_compactions BEGIN
       INSERT INTO compaction_checkpoints
         (projection_key, execution_principal_key, resource_visibility_fingerprint,
          checkpoint_template_version, run_id, compacted_through_sequence, messages_json,
          summary, model, context_tokens_before_compaction, context_window_tokens,
          input_tokens, output_tokens, cost_micros, created_at, updated_at)
       VALUES ('legacy:' || NEW.execution_principal_key || ':' || NEW.resource_visibility_fingerprint || ':v' || NEW.checkpoint_template_version,
          NEW.execution_principal_key, NEW.resource_visibility_fingerprint,
          NEW.checkpoint_template_version, NEW.harness_run_id, NEW.compacted_through_sequence,
          NEW.messages_json, NEW.summary, NEW.model, NEW.context_tokens_before_compaction,
          NEW.context_window_tokens, NEW.input_tokens, NEW.output_tokens, NEW.cost_microusd,
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER))
       ON CONFLICT(projection_key, run_id, compacted_through_sequence) DO UPDATE SET
          messages_json = excluded.messages_json, summary = excluded.summary,
          resource_visibility_fingerprint = excluded.resource_visibility_fingerprint,
          model = excluded.model,
          context_tokens_before_compaction = excluded.context_tokens_before_compaction,
          context_window_tokens = excluded.context_window_tokens,
          input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
          cost_micros = excluded.cost_micros, updated_at = excluded.updated_at;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_description_refreshes AS
     SELECT root.workstream_key AS workstream_id, root.parent_workspace_key AS workspace_id,
            CASE WHEN state.evaluated_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', state.evaluated_at / 1000.0, 'unixepoch') END AS evaluated_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', state.rest_until / 1000.0, 'unixepoch') AS rest_until,
            state.consecutive_keeps, state.evaluated_through_sequence,
            state.window_message_count, state.decision, state.rejection_code,
            state.confidence, state.model, state.previous_description, state.description,
            state.reasoning, state.version,
            strftime('%Y-%m-%dT%H:%M:%fZ', state.created_at / 1000.0, 'unixepoch') AS created_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', state.updated_at / 1000.0, 'unixepoch') AS updated_at
       FROM description_refresh_state state CROSS JOIN workstream root
      WHERE state.id = 1 AND root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_description_refreshes_insert
     INSTEAD OF INSERT ON _runtime_description_refreshes BEGIN
       INSERT INTO description_refresh_state
         (id, evaluated_at, rest_until, consecutive_keeps, evaluated_through_sequence,
          window_message_count, decision, rejection_code, confidence, model,
          previous_description, description, reasoning, version, created_at, updated_at)
       VALUES (1,
          CAST((julianday(NEW.evaluated_at) - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday(NEW.rest_until) - 2440587.5) * 86400000 AS INTEGER),
          COALESCE(NEW.consecutive_keeps, 0), NEW.evaluated_through_sequence,
          COALESCE(NEW.window_message_count, 0), NEW.decision, NEW.rejection_code,
          NEW.confidence, NEW.model, NEW.previous_description, NEW.description,
          NEW.reasoning, COALESCE(NEW.version, 1),
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER))
       ON CONFLICT(id) DO UPDATE SET
          evaluated_at = excluded.evaluated_at,
          rest_until = CASE WHEN excluded.decision = 'authored'
            THEN MAX(description_refresh_state.rest_until, excluded.rest_until)
            ELSE excluded.rest_until END,
          consecutive_keeps = CASE WHEN excluded.decision = 'authored'
            THEN description_refresh_state.consecutive_keeps ELSE excluded.consecutive_keeps END,
          evaluated_through_sequence = excluded.evaluated_through_sequence,
          window_message_count = excluded.window_message_count,
          decision = excluded.decision, rejection_code = excluded.rejection_code,
          confidence = excluded.confidence, model = excluded.model,
          previous_description = excluded.previous_description,
          description = excluded.description, reasoning = excluded.reasoning,
          version = description_refresh_state.version + 1, updated_at = excluded.updated_at
       WHERE excluded.decision = 'authored'
          OR description_refresh_state.rest_until <= excluded.evaluated_at;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_description_refreshes_update
     INSTEAD OF UPDATE ON _runtime_description_refreshes BEGIN
       UPDATE description_refresh_state SET
          evaluated_at = CASE WHEN NEW.evaluated_at IS NULL THEN evaluated_at ELSE CAST((julianday(NEW.evaluated_at) - 2440587.5) * 86400000 AS INTEGER) END,
          rest_until = CAST((julianday(NEW.rest_until) - 2440587.5) * 86400000 AS INTEGER),
          consecutive_keeps = NEW.consecutive_keeps,
          evaluated_through_sequence = NEW.evaluated_through_sequence,
          window_message_count = NEW.window_message_count, decision = NEW.decision,
          rejection_code = NEW.rejection_code, confidence = NEW.confidence,
          model = NEW.model, previous_description = NEW.previous_description,
          description = NEW.description, reasoning = NEW.reasoning,
          version = NEW.version,
          updated_at = CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER)
        WHERE id = 1;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_wakeups AS
     SELECT wakeup.wakeup_id AS id, root.parent_workspace_key AS workspace_id,
            root.workstream_key AS workstream_id,
            wakeup.created_by_run_id AS created_by_harness_run_id,
            wakeup.execution_principal_json, wakeup.prompt,
            strftime('%Y-%m-%dT%H:%M:%fZ', wakeup.due_at / 1000.0, 'unixepoch') AS due_at,
            wakeup.status, wakeup.idempotency_key,
            CASE WHEN wakeup.fired_at IS NULL THEN NULL
              ELSE strftime('%Y-%m-%dT%H:%M:%fZ', wakeup.fired_at / 1000.0, 'unixepoch') END AS fired_at,
            CASE WHEN wakeup.cancelled_at IS NULL THEN NULL
              ELSE strftime('%Y-%m-%dT%H:%M:%fZ', wakeup.cancelled_at / 1000.0, 'unixepoch') END AS cancelled_at,
            wakeup.version,
            strftime('%Y-%m-%dT%H:%M:%fZ', wakeup.created_at / 1000.0, 'unixepoch') AS created_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', wakeup.updated_at / 1000.0, 'unixepoch') AS updated_at
       FROM workstream_wakeups wakeup CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_wakeups_insert
     INSTEAD OF INSERT ON _runtime_wakeups BEGIN
       INSERT OR IGNORE INTO workstream_wakeups
         (wakeup_id, created_by_run_id, execution_principal_json, prompt, due_at,
          status, idempotency_key, fired_at, cancelled_at, version, created_at, updated_at)
       VALUES (NEW.id, NEW.created_by_harness_run_id, NEW.execution_principal_json,
          NEW.prompt, CAST((julianday(NEW.due_at) - 2440587.5) * 86400000 AS INTEGER),
          NEW.status, NEW.idempotency_key,
          CASE WHEN NEW.fired_at IS NULL THEN NULL ELSE CAST((julianday(NEW.fired_at) - 2440587.5) * 86400000 AS INTEGER) END,
          CASE WHEN NEW.cancelled_at IS NULL THEN NULL ELSE CAST((julianday(NEW.cancelled_at) - 2440587.5) * 86400000 AS INTEGER) END,
          NEW.version,
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER));
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_wakeups_update
     INSTEAD OF UPDATE ON _runtime_wakeups BEGIN
       UPDATE workstream_wakeups SET
          status = NEW.status,
          fired_at = CASE WHEN NEW.fired_at IS NULL THEN NULL ELSE CAST((julianday(NEW.fired_at) - 2440587.5) * 86400000 AS INTEGER) END,
          cancelled_at = CASE WHEN NEW.cancelled_at IS NULL THEN NULL ELSE CAST((julianday(NEW.cancelled_at) - 2440587.5) * 86400000 AS INTEGER) END,
          version = NEW.version,
          updated_at = CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER)
        WHERE wakeup_id = OLD.id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_wakeups_delete
     INSTEAD OF DELETE ON _runtime_wakeups BEGIN
       DELETE FROM workstream_wakeups WHERE wakeup_id = OLD.id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_plugin_hints AS
     SELECT root.workstream_key AS workstream_id, hint.plugin_id,
            strftime('%Y-%m-%dT%H:%M:%fZ', hint.activated_at / 1000.0, 'unixepoch') AS activated_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', hint.last_authorized_at / 1000.0, 'unixepoch') AS last_authorized_at
       FROM plugin_activation_hints hint CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_plugin_hints_insert
     INSTEAD OF INSERT ON _runtime_plugin_hints BEGIN
       INSERT INTO plugin_activation_hints(plugin_id, activated_at, last_authorized_at)
       VALUES (NEW.plugin_id,
          CAST((julianday(NEW.activated_at) - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday(NEW.last_authorized_at) - 2440587.5) * 86400000 AS INTEGER))
       ON CONFLICT(plugin_id) DO UPDATE SET last_authorized_at = excluded.last_authorized_at;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_resource_revisions AS
     SELECT root.parent_workspace_key AS workspace_id, root.workstream_key AS workstream_id,
            revision.revision,
            strftime('%Y-%m-%dT%H:%M:%fZ', revision.updated_at / 1000.0, 'unixepoch') AS updated_at
       FROM resource_inventory_revision revision CROSS JOIN workstream root
      WHERE root.id = 1 AND revision.id = 1`,
  `CREATE VIEW IF NOT EXISTS _runtime_workstream_resources AS
     SELECT root.workstream_key AS workstream_id, link.resource_id, link.attached_by_user_id,
            link.watch_enabled, link.relationship_type,
            strftime('%Y-%m-%dT%H:%M:%fZ', link.attached_at / 1000.0, 'unixepoch') AS attached_at
       FROM workstream_resource_links link CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_workstream_resources_update
     INSTEAD OF UPDATE ON _runtime_workstream_resources BEGIN
       UPDATE workstream_resource_links
          SET attached_by_user_id = NEW.attached_by_user_id,
              watch_enabled = NEW.watch_enabled,
              relationship_type = NEW.relationship_type,
              updated_at = CAST((julianday(COALESCE(NEW.attached_at, OLD.attached_at)) - 2440587.5) * 86400000 AS INTEGER)
        WHERE resource_id = OLD.resource_id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
       -- Every path that can change the authorized inventory advances the
       -- revision; the compaction checkpoint's visibility fingerprint is
       -- 'inventory:<revision>', so a compat-routed relationship change that
       -- skipped this bump would let a stale checkpoint keep matching.
       INSERT INTO resource_inventory_revision(id, revision, updated_at)
       VALUES (1, 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
       ON CONFLICT(id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_workstream_resources_delete
     INSTEAD OF DELETE ON _runtime_workstream_resources BEGIN
       DELETE FROM workstream_resource_links WHERE resource_id = OLD.resource_id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
       INSERT INTO resource_inventory_revision(id, revision, updated_at)
       VALUES (1, 1, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
       ON CONFLICT(id) DO UPDATE SET revision = revision + 1, updated_at = excluded.updated_at;
     END`,
  `CREATE VIEW IF NOT EXISTS _runtime_resources AS
     SELECT json_extract(resource_json, '$.id') AS id,
            root.parent_workspace_key AS workspace_id,
            json_extract(resource_json, '$.connectionId') AS connection_id,
            json_extract(resource_json, '$.type') AS resource_type,
            json_extract(resource_json, '$.provider') AS provider,
            json_extract(resource_json, '$.providerResourceId') AS provider_resource_id,
            json_extract(resource_json, '$.title') AS title,
            json_extract(resource_json, '$.mimeType') AS mime_type,
            json_extract(resource_json, '$.contentRef') AS content_ref,
            NULL AS content_sha256,
            NULL AS model_content_ref,
            NULL AS model_mime_type,
            NULL AS model_content_sha256,
            NULL AS model_metadata_json,
            'ready' AS model_content_status,
            NULL AS model_content_error_code,
            json_extract(resource_json, '$.canonicalUrl') AS canonical_url,
            json_extract(resource_json, '$.metadata') AS metadata_json,
            strftime('%Y-%m-%dT%H:%M:%fZ', attached_at / 1000.0, 'unixepoch') AS created_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', updated_at / 1000.0, 'unixepoch') AS updated_at
       FROM workstream_resource_links CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE VIEW IF NOT EXISTS _runtime_message_attachments AS
     SELECT attachment.part_id AS message_id, attachment.resource_id, attachment.position,
            strftime('%Y-%m-%dT%H:%M:%fZ', part.created_at / 1000.0, 'unixepoch') AS attached_at
       FROM part_attachments attachment JOIN parts part ON part.id = attachment.part_id`,
  `CREATE VIEW IF NOT EXISTS _runtime_message_mentions AS
     SELECT mention.part_id AS message_id, mention.mention_kind AS mention_type,
            mention.target_user_id AS mentioned_user_id, mention.connector_type,
            mention.start_offset, mention.end_offset
       FROM part_mentions mention`,
  `CREATE VIEW IF NOT EXISTS _runtime_users AS
     SELECT participant.user_id AS id, '' AS email, participant.user_id AS name,
            NULL AS avatar_url, 'UTC' AS timezone,
            strftime('%Y-%m-%dT%H:%M:%fZ', participant.added_at / 1000.0, 'unixepoch') AS created_at
       FROM participants participant`,
  `CREATE VIEW IF NOT EXISTS _runtime_workstream_participants AS
     SELECT root.workstream_key AS workstream_id, participant.user_id,
            participant.participation_reason,
            participant.added_by_user_id,
            strftime('%Y-%m-%dT%H:%M:%fZ', participant.added_at / 1000.0, 'unixepoch') AS joined_at,
            CASE WHEN participant.removed_at IS NULL THEN NULL
              ELSE strftime('%Y-%m-%dT%H:%M:%fZ', participant.removed_at / 1000.0, 'unixepoch') END AS removed_at
       FROM participants participant CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_workstream_participants_insert
     INSTEAD OF INSERT ON _runtime_workstream_participants BEGIN
       INSERT INTO participants
         (user_id, participation_reason, added_by_user_id, status,
          participant_epoch, added_at, removed_at, updated_at)
       VALUES (NEW.user_id, NEW.participation_reason, NEW.added_by_user_id,
          CASE WHEN NEW.removed_at IS NULL THEN 'active' ELSE 'removed' END,
          0, CAST((julianday(NEW.joined_at) - 2440587.5) * 86400000 AS INTEGER),
          CASE WHEN NEW.removed_at IS NULL THEN NULL ELSE CAST((julianday(NEW.removed_at) - 2440587.5) * 86400000 AS INTEGER) END,
          CAST((julianday(COALESCE(NEW.removed_at, NEW.joined_at)) - 2440587.5) * 86400000 AS INTEGER))
       ON CONFLICT(user_id) DO UPDATE SET
          status = excluded.status,
          removed_at = excluded.removed_at,
          participant_epoch = CASE WHEN participants.status = 'removed' AND excluded.status = 'active'
            THEN participants.participant_epoch + 1 ELSE participants.participant_epoch END,
          participation_reason = CASE WHEN participants.status = 'removed'
            THEN excluded.participation_reason ELSE participants.participation_reason END,
          added_by_user_id = CASE WHEN participants.status = 'removed'
            THEN excluded.added_by_user_id ELSE participants.added_by_user_id END,
          added_at = CASE WHEN participants.status = 'removed'
            THEN excluded.added_at ELSE participants.added_at END,
          updated_at = excluded.updated_at;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_workstream_participants_update
     INSTEAD OF UPDATE ON _runtime_workstream_participants BEGIN
       UPDATE participants SET participation_reason = NEW.participation_reason,
          added_by_user_id = NEW.added_by_user_id,
          status = CASE WHEN NEW.removed_at IS NULL THEN 'active' ELSE 'removed' END,
          removed_at = CASE WHEN NEW.removed_at IS NULL THEN NULL ELSE CAST((julianday(NEW.removed_at) - 2440587.5) * 86400000 AS INTEGER) END,
          participant_epoch = participant_epoch + CASE
            WHEN (OLD.removed_at IS NULL) != (NEW.removed_at IS NULL) THEN 1 ELSE 0 END,
          updated_at = CAST((julianday(COALESCE(NEW.removed_at, NEW.joined_at)) - 2440587.5) * 86400000 AS INTEGER)
        WHERE user_id = OLD.user_id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_workstream_participants_delete
     INSTEAD OF DELETE ON _runtime_workstream_participants BEGIN
       DELETE FROM participants WHERE user_id = OLD.user_id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_terminal_workspace AS
     SELECT root.parent_workspace_key AS workspace_id, root.workstream_key AS workstream_id,
            terminal.lifecycle_state AS state, terminal.stable_name,
            terminal.sandbox_id AS provider_sandbox_id, terminal.generation,
            COALESCE(json_extract(terminal.lifecycle_json, '$.authorityFingerprint'), '') AS authority_fingerprint,
            terminal.applied_network_revision, terminal.version,
            json_extract(terminal.lifecycle_json, '$.operationRunId') AS operation_run_id,
            json_extract(terminal.lifecycle_json, '$.operationLeaseExpiresAt') AS operation_lease_expires_at,
            json_extract(terminal.lifecycle_json, '$.lifecycleClaimId') AS lifecycle_claim_id,
            json_extract(terminal.lifecycle_json, '$.lifecycleClaimExpiresAt') AS lifecycle_claim_expires_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', terminal.last_command_at / 1000.0, 'unixepoch') AS last_activity_at,
            CASE WHEN terminal.idle_expires_at IS NULL THEN NULL
              ELSE strftime('%Y-%m-%dT%H:%M:%fZ', terminal.idle_expires_at / 1000.0, 'unixepoch') END AS warm_stop_due_at,
            json_extract(terminal.lifecycle_json, '$.archiveDueAt') AS archive_due_at,
            json_extract(terminal.lifecycle_json, '$.expireDueAt') AS expire_due_at,
            json_extract(terminal.lifecycle_json, '$.finalDiffResourceId') AS final_diff_resource_id,
            json_extract(terminal.lifecycle_json, '$.failureCode') AS failure_code,
            strftime('%Y-%m-%dT%H:%M:%fZ', terminal.created_at / 1000.0, 'unixepoch') AS created_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', terminal.updated_at / 1000.0, 'unixepoch') AS updated_at
       FROM terminal_workspace terminal CROSS JOIN workstream root
      WHERE terminal.id = 1 AND root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_terminal_workspace_insert
     INSTEAD OF INSERT ON _runtime_terminal_workspace BEGIN
       INSERT OR IGNORE INTO terminal_workspace
         (id, provider, sandbox_id, lifecycle_state, authority_epoch, last_command_at,
          idle_expires_at, created_at, updated_at, generation, stable_name,
          applied_network_revision, version, lifecycle_json)
       VALUES (1, 'daytona', NEW.provider_sandbox_id, NEW.state, COALESCE(NEW.version, 1),
          CAST((julianday(NEW.last_activity_at) - 2440587.5) * 86400000 AS INTEGER),
          CASE WHEN NEW.warm_stop_due_at IS NULL THEN NULL ELSE CAST((julianday(NEW.warm_stop_due_at) - 2440587.5) * 86400000 AS INTEGER) END,
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER),
          NEW.generation, NEW.stable_name, NEW.applied_network_revision, NEW.version,
          json_object('authorityFingerprint', NEW.authority_fingerprint,
            'operationRunId', NEW.operation_run_id,
            'operationLeaseExpiresAt', NEW.operation_lease_expires_at,
            'lifecycleClaimId', NEW.lifecycle_claim_id,
            'lifecycleClaimExpiresAt', NEW.lifecycle_claim_expires_at,
            'archiveDueAt', NEW.archive_due_at, 'expireDueAt', NEW.expire_due_at,
            'finalDiffResourceId', NEW.final_diff_resource_id, 'failureCode', NEW.failure_code));
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_terminal_workspace_update
     INSTEAD OF UPDATE ON _runtime_terminal_workspace BEGIN
       UPDATE terminal_workspace SET sandbox_id = NEW.provider_sandbox_id,
          lifecycle_state = NEW.state, authority_epoch = NEW.version,
          last_command_at = CAST((julianday(NEW.last_activity_at) - 2440587.5) * 86400000 AS INTEGER),
          idle_expires_at = CASE WHEN NEW.warm_stop_due_at IS NULL THEN NULL ELSE CAST((julianday(NEW.warm_stop_due_at) - 2440587.5) * 86400000 AS INTEGER) END,
          generation = NEW.generation, stable_name = NEW.stable_name,
          applied_network_revision = NEW.applied_network_revision, version = NEW.version,
          lifecycle_json = json_object('authorityFingerprint', NEW.authority_fingerprint,
            'operationRunId', NEW.operation_run_id,
            'operationLeaseExpiresAt', NEW.operation_lease_expires_at,
            'lifecycleClaimId', NEW.lifecycle_claim_id,
            'lifecycleClaimExpiresAt', NEW.lifecycle_claim_expires_at,
            'archiveDueAt', NEW.archive_due_at, 'expireDueAt', NEW.expire_due_at,
            'finalDiffResourceId', NEW.final_diff_resource_id, 'failureCode', NEW.failure_code),
          updated_at = CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER)
        WHERE id = 1;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_terminal_workspace_delete
     INSTEAD OF DELETE ON _runtime_terminal_workspace BEGIN
       DELETE FROM terminal_imported_resources;
       DELETE FROM terminal_workspace WHERE id = 1;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_terminal_tasks AS
     SELECT task.task_id AS id, root.parent_workspace_key AS workspace_id,
            root.workstream_key AS workstream_id, task.run_id AS harness_run_id,
            task.effect_intent_id AS tool_invocation_id, task.sandbox_generation,
            task.provider_task_name, task.provider_task_id, task.state, task.command_sha256,
            strftime('%Y-%m-%dT%H:%M:%fZ', task.command_deadline_at / 1000.0, 'unixepoch') AS command_deadline_at,
            task.exit_code, task.termination_reason, task.stdout_head, task.stdout_tail,
            task.stderr_head, task.stderr_tail, task.stdout_bytes, task.stderr_bytes,
            task.output_resource_id,
            CASE WHEN task.continuation_emitted_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', task.continuation_emitted_at / 1000.0, 'unixepoch') END AS continuation_emitted_at,
            CASE WHEN task.started_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', task.started_at / 1000.0, 'unixepoch') END AS started_at,
            CASE WHEN task.completed_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', task.completed_at / 1000.0, 'unixepoch') END AS completed_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', task.created_at / 1000.0, 'unixepoch') AS created_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', task.updated_at / 1000.0, 'unixepoch') AS updated_at
       FROM terminal_tasks task CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_terminal_tasks_insert
     INSTEAD OF INSERT ON _runtime_terminal_tasks BEGIN
       INSERT OR IGNORE INTO terminal_tasks
         (task_id, run_id, effect_intent_id, sandbox_generation, provider_task_name,
          provider_task_id, state, command_sha256, command_deadline_at, exit_code,
          termination_reason, stdout_head, stdout_tail, stderr_head, stderr_tail,
          stdout_bytes, stderr_bytes, output_resource_id, continuation_emitted_at,
          started_at, completed_at, created_at, updated_at)
       VALUES (NEW.id, NEW.harness_run_id, NEW.tool_invocation_id, NEW.sandbox_generation,
          NEW.provider_task_name, NEW.provider_task_id, NEW.state, NEW.command_sha256,
          CAST((julianday(NEW.command_deadline_at) - 2440587.5) * 86400000 AS INTEGER),
          NEW.exit_code, NEW.termination_reason, COALESCE(NEW.stdout_head, ''),
          COALESCE(NEW.stdout_tail, ''), COALESCE(NEW.stderr_head, ''),
          COALESCE(NEW.stderr_tail, ''), COALESCE(NEW.stdout_bytes, 0),
          COALESCE(NEW.stderr_bytes, 0), NEW.output_resource_id,
          CASE WHEN NEW.continuation_emitted_at IS NULL THEN NULL ELSE CAST((julianday(NEW.continuation_emitted_at) - 2440587.5) * 86400000 AS INTEGER) END,
          CASE WHEN NEW.started_at IS NULL THEN NULL ELSE CAST((julianday(NEW.started_at) - 2440587.5) * 86400000 AS INTEGER) END,
          CASE WHEN NEW.completed_at IS NULL THEN NULL ELSE CAST((julianday(NEW.completed_at) - 2440587.5) * 86400000 AS INTEGER) END,
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER));
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_terminal_tasks_update
     INSTEAD OF UPDATE ON _runtime_terminal_tasks BEGIN
       UPDATE terminal_tasks SET provider_task_id = NEW.provider_task_id, state = NEW.state,
          exit_code = NEW.exit_code, termination_reason = NEW.termination_reason,
          stdout_head = NEW.stdout_head, stdout_tail = NEW.stdout_tail,
          stderr_head = NEW.stderr_head, stderr_tail = NEW.stderr_tail,
          stdout_bytes = NEW.stdout_bytes, stderr_bytes = NEW.stderr_bytes,
          output_resource_id = NEW.output_resource_id,
          continuation_emitted_at = CASE WHEN NEW.continuation_emitted_at IS NULL THEN NULL ELSE CAST((julianday(NEW.continuation_emitted_at) - 2440587.5) * 86400000 AS INTEGER) END,
          started_at = CASE WHEN NEW.started_at IS NULL THEN NULL ELSE CAST((julianday(NEW.started_at) - 2440587.5) * 86400000 AS INTEGER) END,
          completed_at = CASE WHEN NEW.completed_at IS NULL THEN NULL ELSE CAST((julianday(NEW.completed_at) - 2440587.5) * 86400000 AS INTEGER) END,
          updated_at = CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER)
        WHERE task_id = OLD.id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_terminal_imported_resources AS
     SELECT root.parent_workspace_key AS workspace_id, root.workstream_key AS workstream_id,
            imported.sandbox_generation, imported.resource_id, imported.destination_path,
            imported.source_sha256, imported.size_bytes, imported.state,
            CASE WHEN imported.imported_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', imported.imported_at / 1000.0, 'unixepoch') END AS imported_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', imported.updated_at / 1000.0, 'unixepoch') AS updated_at
       FROM terminal_imported_resources imported CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_terminal_imported_resources_insert
     INSTEAD OF INSERT ON _runtime_terminal_imported_resources BEGIN
       INSERT OR IGNORE INTO terminal_imported_resources
         (sandbox_generation, resource_id, destination_path, source_sha256, size_bytes,
          state, imported_at, updated_at)
       VALUES (NEW.sandbox_generation, NEW.resource_id, NEW.destination_path,
          NEW.source_sha256, NEW.size_bytes, NEW.state,
          CASE WHEN NEW.imported_at IS NULL THEN NULL ELSE CAST((julianday(NEW.imported_at) - 2440587.5) * 86400000 AS INTEGER) END,
          CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER));
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_terminal_imported_resources_update
     INSTEAD OF UPDATE ON _runtime_terminal_imported_resources BEGIN
       UPDATE terminal_imported_resources SET source_sha256 = NEW.source_sha256,
          size_bytes = NEW.size_bytes, state = NEW.state,
          imported_at = CASE WHEN NEW.imported_at IS NULL THEN NULL ELSE CAST((julianday(NEW.imported_at) - 2440587.5) * 86400000 AS INTEGER) END,
          updated_at = CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER)
        WHERE sandbox_generation = OLD.sandbox_generation AND resource_id = OLD.resource_id
          AND destination_path = OLD.destination_path;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_terminal_repository AS
     SELECT root.parent_workspace_key AS workspace_id, root.workstream_key AS workstream_id,
            repository.connection_id, repository.repository_id,
            repository.repository_full_name, repository.base_ref, repository.base_sha,
            repository.head_ref, repository.state, repository.bootstrapped_sandbox_generation,
            CASE WHEN repository.read_token_expires_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', repository.read_token_expires_at / 1000.0, 'unixepoch') END AS read_token_expires_at,
            repository.selected_by_user_id, repository.remote_access,
            strftime('%Y-%m-%dT%H:%M:%fZ', repository.created_at / 1000.0, 'unixepoch') AS created_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', repository.updated_at / 1000.0, 'unixepoch') AS updated_at
       FROM terminal_repository repository CROSS JOIN workstream root
      WHERE repository.id = 1 AND root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_terminal_repository_insert
     INSTEAD OF INSERT ON _runtime_terminal_repository BEGIN
       INSERT INTO terminal_repository
         (id, connection_id, repository_id, repository_full_name, base_ref, base_sha,
          head_ref, state, bootstrapped_sandbox_generation, read_token_expires_at,
          selected_by_user_id, remote_access, created_at, updated_at)
       VALUES (1, NEW.connection_id, NEW.repository_id, NEW.repository_full_name,
          NEW.base_ref, NEW.base_sha, NEW.head_ref, NEW.state,
          NEW.bootstrapped_sandbox_generation,
          CASE WHEN NEW.read_token_expires_at IS NULL THEN NULL ELSE CAST((julianday(NEW.read_token_expires_at) - 2440587.5) * 86400000 AS INTEGER) END,
          NEW.selected_by_user_id, COALESCE(NEW.remote_access, 'full_access'),
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER))
       ON CONFLICT(id) DO UPDATE SET connection_id = excluded.connection_id,
          repository_id = excluded.repository_id, repository_full_name = excluded.repository_full_name,
          base_ref = excluded.base_ref, base_sha = excluded.base_sha, head_ref = excluded.head_ref,
          state = excluded.state, bootstrapped_sandbox_generation = NULL,
          read_token_expires_at = NULL, selected_by_user_id = excluded.selected_by_user_id,
          remote_access = excluded.remote_access, updated_at = excluded.updated_at;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_terminal_repository_update
     INSTEAD OF UPDATE ON _runtime_terminal_repository BEGIN
       UPDATE terminal_repository SET connection_id = NEW.connection_id,
          repository_id = NEW.repository_id, repository_full_name = NEW.repository_full_name,
          base_ref = NEW.base_ref, base_sha = NEW.base_sha, head_ref = NEW.head_ref,
          state = NEW.state,
          bootstrapped_sandbox_generation = NEW.bootstrapped_sandbox_generation,
          read_token_expires_at = CASE WHEN NEW.read_token_expires_at IS NULL THEN NULL ELSE CAST((julianday(NEW.read_token_expires_at) - 2440587.5) * 86400000 AS INTEGER) END,
          selected_by_user_id = NEW.selected_by_user_id, remote_access = NEW.remote_access,
          updated_at = CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER)
        WHERE id = 1;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_terminal_publication_grants AS
     SELECT grant.grant_id AS id, root.parent_workspace_key AS workspace_id,
            root.workstream_key AS workstream_id, grant.run_id AS harness_run_id,
            grant.source_part_id AS source_message_id, grant.principal_key,
            grant.repository_full_name, grant.base_ref, grant.head_ref,
            strftime('%Y-%m-%dT%H:%M:%fZ', grant.expires_at / 1000.0, 'unixepoch') AS expires_at,
            grant.consumed_by_effect_intent_id AS consumed_by_invocation_id,
            CASE WHEN grant.consumed_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', grant.consumed_at / 1000.0, 'unixepoch') END AS consumed_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', grant.created_at / 1000.0, 'unixepoch') AS created_at
       FROM terminal_publication_grants grant CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_terminal_publication_grants_insert
     INSTEAD OF INSERT ON _runtime_terminal_publication_grants BEGIN
       INSERT OR IGNORE INTO terminal_publication_grants
         (grant_id, run_id, source_part_id, principal_key, repository_full_name,
          base_ref, head_ref, expires_at, consumed_by_effect_intent_id, consumed_at, created_at)
       VALUES (NEW.id, NEW.harness_run_id, NEW.source_message_id, NEW.principal_key,
          NEW.repository_full_name, NEW.base_ref, NEW.head_ref,
          CAST((julianday(NEW.expires_at) - 2440587.5) * 86400000 AS INTEGER),
          NEW.consumed_by_invocation_id,
          CASE WHEN NEW.consumed_at IS NULL THEN NULL ELSE CAST((julianday(NEW.consumed_at) - 2440587.5) * 86400000 AS INTEGER) END,
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER));
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_terminal_publication_grants_update
     INSTEAD OF UPDATE ON _runtime_terminal_publication_grants BEGIN
       UPDATE terminal_publication_grants SET
          consumed_by_effect_intent_id = NEW.consumed_by_invocation_id,
          consumed_at = CASE WHEN NEW.consumed_at IS NULL THEN NULL ELSE CAST((julianday(NEW.consumed_at) - 2440587.5) * 86400000 AS INTEGER) END
        WHERE grant_id = OLD.id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_repository_publications AS
     SELECT publication.publication_id AS id, root.parent_workspace_key AS workspace_id,
            root.workstream_key AS workstream_id,
            publication.effect_intent_id AS tool_invocation_id, publication.grant_id,
            publication.repository_full_name, publication.base_ref, publication.head_ref,
            publication.expected_old_sha, publication.requested_commit_sha,
            publication.published_sha, publication.state, publication.pull_request_number,
            publication.pull_request_url, publication.pull_request_state,
            publication.title, publication.body, publication.failure_code,
            strftime('%Y-%m-%dT%H:%M:%fZ', publication.created_at / 1000.0, 'unixepoch') AS created_at,
            strftime('%Y-%m-%dT%H:%M:%fZ', publication.updated_at / 1000.0, 'unixepoch') AS updated_at,
            CASE WHEN publication.completed_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', publication.completed_at / 1000.0, 'unixepoch') END AS completed_at
       FROM repository_publications publication CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_repository_publications_insert
     INSTEAD OF INSERT ON _runtime_repository_publications BEGIN
       INSERT INTO repository_publications
         (publication_id, effect_intent_id, grant_id, repository_full_name, base_ref,
          head_ref, expected_old_sha, requested_commit_sha, published_sha, state,
          pull_request_number, pull_request_url, pull_request_state, title, body,
          failure_code, created_at, updated_at, completed_at)
       VALUES (NEW.id, NEW.tool_invocation_id, NEW.grant_id, NEW.repository_full_name,
          NEW.base_ref, NEW.head_ref, NEW.expected_old_sha, NEW.requested_commit_sha,
          NEW.published_sha, NEW.state, NEW.pull_request_number, NEW.pull_request_url,
          NEW.pull_request_state, NEW.title, NEW.body, NEW.failure_code,
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER),
          CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER),
          CASE WHEN NEW.completed_at IS NULL THEN NULL ELSE CAST((julianday(NEW.completed_at) - 2440587.5) * 86400000 AS INTEGER) END)
       ON CONFLICT(effect_intent_id) DO UPDATE SET grant_id = excluded.grant_id,
          expected_old_sha = excluded.expected_old_sha,
          requested_commit_sha = excluded.requested_commit_sha, state = excluded.state,
          title = excluded.title, body = excluded.body, failure_code = NULL,
          updated_at = excluded.updated_at;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_repository_publications_update
     INSTEAD OF UPDATE ON _runtime_repository_publications BEGIN
       UPDATE repository_publications SET published_sha = NEW.published_sha,
          state = NEW.state, pull_request_number = NEW.pull_request_number,
          pull_request_url = NEW.pull_request_url,
          pull_request_state = NEW.pull_request_state, failure_code = NEW.failure_code,
          updated_at = CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER),
          completed_at = CASE WHEN NEW.completed_at IS NULL THEN NULL ELSE CAST((julianday(NEW.completed_at) - 2440587.5) * 86400000 AS INTEGER) END
        WHERE publication_id = OLD.id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_block_dashboard_configurations AS
     SELECT configuration.configuration_version_id AS id,
            root.parent_workspace_key AS workspace_id, root.workstream_key AS workstream_id,
            configuration.version_number, configuration.blocks_json,
            configuration.created_by_user_id,
            strftime('%Y-%m-%dT%H:%M:%fZ', configuration.created_at / 1000.0, 'unixepoch') AS created_at
       FROM block_dashboard_configuration_versions configuration CROSS JOIN workstream root
      WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_block_dashboard_configurations_insert
     INSTEAD OF INSERT ON _runtime_block_dashboard_configurations BEGIN
       INSERT INTO block_dashboard_configuration_versions
         (configuration_version_id, version_number, blocks_json, created_by_user_id, created_at)
       VALUES (NEW.id, NEW.version_number, NEW.blocks_json, NEW.created_by_user_id,
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER));
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE VIEW IF NOT EXISTS _runtime_block_dashboard_preferences AS
     SELECT root.parent_workspace_key AS workspace_id, root.workstream_key AS workstream_id,
            preference.user_id, preference.visible,
            strftime('%Y-%m-%dT%H:%M:%fZ', preference.updated_at / 1000.0, 'unixepoch') AS updated_at
       FROM block_dashboard_user_preferences preference CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_block_dashboard_preferences_insert
     INSTEAD OF INSERT ON _runtime_block_dashboard_preferences BEGIN
       INSERT INTO block_dashboard_user_preferences(user_id, visible, updated_at)
       VALUES (NEW.user_id, NEW.visible,
          CAST((julianday(NEW.updated_at) - 2440587.5) * 86400000 AS INTEGER))
       ON CONFLICT(user_id) DO UPDATE SET visible = excluded.visible, updated_at = excluded.updated_at;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,

  `CREATE VIEW IF NOT EXISTS _runtime_block_dashboard_runs AS
     SELECT block.block_run_id AS id, root.parent_workspace_key AS workspace_id,
            root.workstream_key AS workstream_id, block.configuration_version_id,
            block.block_id, block.prompt, block.trigger_sequence, block.run_id AS harness_run_id,
            block.status, block.markdown, block.error_json,
            strftime('%Y-%m-%dT%H:%M:%fZ', block.created_at / 1000.0, 'unixepoch') AS created_at,
            CASE WHEN block.started_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', block.started_at / 1000.0, 'unixepoch') END AS started_at,
            CASE WHEN block.completed_at IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', block.completed_at / 1000.0, 'unixepoch') END AS completed_at
       FROM block_dashboard_block_runs block CROSS JOIN workstream root WHERE root.id = 1`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_block_dashboard_runs_insert
     INSTEAD OF INSERT ON _runtime_block_dashboard_runs BEGIN
       INSERT OR IGNORE INTO block_dashboard_block_runs
         (block_run_id, configuration_version_id, block_id, prompt, trigger_sequence,
          run_id, status, markdown, error_json, created_at, started_at, completed_at)
       VALUES (NEW.id, NEW.configuration_version_id, NEW.block_id, NEW.prompt,
          NEW.trigger_sequence, NEW.harness_run_id, NEW.status, NEW.markdown,
          NEW.error_json,
          CAST((julianday(NEW.created_at) - 2440587.5) * 86400000 AS INTEGER),
          CASE WHEN NEW.started_at IS NULL THEN NULL ELSE CAST((julianday(NEW.started_at) - 2440587.5) * 86400000 AS INTEGER) END,
          CASE WHEN NEW.completed_at IS NULL THEN NULL ELSE CAST((julianday(NEW.completed_at) - 2440587.5) * 86400000 AS INTEGER) END);
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
  `CREATE TRIGGER IF NOT EXISTS _runtime_block_dashboard_runs_update
     INSTEAD OF UPDATE ON _runtime_block_dashboard_runs BEGIN
       UPDATE block_dashboard_block_runs SET status = NEW.status, markdown = NEW.markdown,
         error_json = NEW.error_json,
         started_at = CASE WHEN NEW.started_at IS NULL THEN NULL ELSE CAST((julianday(NEW.started_at) - 2440587.5) * 86400000 AS INTEGER) END,
         completed_at = CASE WHEN NEW.completed_at IS NULL THEN NULL ELSE CAST((julianday(NEW.completed_at) - 2440587.5) * 86400000 AS INTEGER) END
       WHERE block_run_id = OLD.id;
       UPDATE _runtime_statement_changes SET changes = changes + changes() WHERE id = 1;
     END`,
] as const;
