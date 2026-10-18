-- One export per conversation (a Thread's main substream "0", or a Breakout).
-- Run through the engineering MCP's run_substream_sql under the production-data
-- runbook; the result goes into the protected scratch directory only.
--
-- Row shapes, all under the same nine columns (k, seq, tid, at, mt, body, run, sc, ts):
--   meta       title in mt, description in body, scope in at, origin_type in run, exact_state in sc
--   turn       sequence_number, turn_id, author_type, message_type, content (bounded), produced_by_run_id,
--              structured_content_json (bounded), created_at
--   run        run_id in tid, status in at, terminal_reason in mt, final_turn_id in run, terminalized_at in ts
--   checkpoint compacted_through_sequence in seq, checkpoint_fact_id in tid, run_id in at, model in mt,
--              the compaction summary in body (bounded), created_at in ts
SELECT 'meta' AS k, NULL AS seq, NULL AS tid, scope AS at, title AS mt, description AS body,
       origin_type AS run, exact_state AS sc, NULL AS ts
  FROM workstream
UNION ALL
SELECT 'turn', sequence_number, turn_id, author_type, message_type, substr(content, 1, 8000),
       produced_by_run_id, substr(structured_content_json, 1, 2000), created_at
  FROM canonical_conversation_turn_details
UNION ALL
SELECT 'run', NULL, run_id, status, terminal_reason, NULL, final_turn_id, NULL, terminalized_at
  FROM runs
UNION ALL
SELECT 'checkpoint', c.compacted_through_sequence, c.checkpoint_fact_id, c.run_id, c.model,
       substr(json_extract(p.payload_json, '$.summary'), 1, 8000), NULL, NULL, c.created_at
  FROM transcript_compaction_checkpoints c
  JOIN transcript_facts f ON f.fact_id = c.checkpoint_fact_id
  JOIN transcript_payloads p ON p.payload_id = f.payload_id
ORDER BY k, seq;
