WITH selected_runs AS (
 SELECT * FROM runs WHERE status='completed' AND final_turn_id IS NOT NULL ORDER BY created_at DESC LIMIT 6
)
SELECT json_object(
 'runs', json((SELECT json_group_array(json_object('run_id',r.run_id,'input_fence_seq',r.input_fence_seq,'trigger_part_id',r.trigger_part_id,'loop_input_id',r.loop_input_id,'final_turn_id',r.final_turn_id,'started_at',r.started_at,'terminalized_at',r.terminalized_at,'origin',r.origin,'parent_run_id',r.parent_run_id)) FROM selected_runs r)),
 'turns',json((SELECT json_group_array(json_object('seq',sequence_number,'id',turn_id,'role',role,'message_type',message_type,'content',content,'structured',structured_content_json,'created_at',created_at)) FROM canonical_conversation_turn_details WHERE content IS NOT NULL AND sequence_number <= (SELECT max(t.sequence_number) FROM canonical_conversation_turn_details t JOIN selected_runs r ON r.final_turn_id=t.turn_id))),
 'tools',json((SELECT json_group_array(json_object('run_id',run_id,'call_id',tool_call_id,'operation',tool_name,'mode',mode,'status',status,'input',input_json,'summary',output_summary,'error',error_json,'started_at',started_at,'settled_at',settled_at)) FROM tool_effects WHERE run_id IN (SELECT run_id FROM selected_runs))),
 'inputs',json((SELECT json_group_array(json_object('input_id',input_id,'turn_id',delivered_turn_id,'delivered_at',delivered_at)) FROM delivered_loop_inputs WHERE input_id IN (SELECT loop_input_id FROM selected_runs))),
 'meta',json((SELECT json_object('title',title,'description',description,'background_agent',(SELECT count(*) FROM background_agent)) FROM workstream))
) AS data;
