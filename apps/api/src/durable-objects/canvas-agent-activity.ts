import type { CanvasRunningActivity } from "@rally/contracts/canvases";

/** Execution, not lifecycle: a saved active Sidekick may have nothing to do. */
const RUNNING_STATES = ["scheduled", "running", "preparing_context", "waiting_capacity", "interrupting"];

export function projectionIsRunning(projection: { state: string; archivedAt: string | null } | null): boolean {
  return projection !== null && projection.archivedAt === null && RUNNING_STATES.includes(projection.state);
}

/**
 * Read the existing version-fenced child projections, scoped to admitted
 * Canvases. An attached Sidekick is one helper, including its authoring and
 * delegated work, however many conversations it currently runs.
 */
export function canvasRunningActivity(sql: SqlStorage, canvasIds: readonly string[], result = new Map<string, CanvasRunningActivity>()): Map<string, CanvasRunningActivity> {
  const missing = canvasIds.filter((id) => !result.has(id));
  if (missing.length === 0) return result;
  for (const row of sql.exec<{ canvas_id: string; background_agents: number; sidekicks: number }>(
    `WITH requested(canvas_id) AS (SELECT value FROM json_each(?1)),
      running AS (
        SELECT sidekick_id, substream_id,
          COALESCE(json_extract(effect_json, '$.backgroundAgent'), 0) AS background_agent,
          COALESCE(json_extract(effect_json, '$.backgroundAgentRootSubstreamId'), '0') AS root_substream_id
        FROM sidekick_child_projections
        WHERE sidekick_id IN (SELECT canvas_id FROM requested UNION
          SELECT automation_id FROM sidekick_conversation_attachments
          WHERE parent_kind = 'canvas' AND substream_id = '0' AND parent_id IN (SELECT canvas_id FROM requested))
          AND json_extract(effect_json, '$.archivedAt') IS NULL
          AND json_extract(effect_json, '$.state') IN ('scheduled', 'running', 'preparing_context', 'waiting_capacity', 'interrupting')
      )
      SELECT canvas_id,
        (SELECT COUNT(*) FROM running WHERE sidekick_id = requested.canvas_id
          AND background_agent = 1 AND root_substream_id = '0') AS background_agents,
        (SELECT COUNT(DISTINCT attachment.automation_id)
          FROM sidekick_conversation_attachments attachment
          JOIN automation_directory directory ON directory.automation_id = attachment.automation_id
          JOIN running ON running.sidekick_id = directory.automation_id
          WHERE attachment.parent_kind = 'canvas' AND attachment.parent_id = requested.canvas_id
            AND attachment.substream_id = '0' AND directory.lifecycle <> 'deleted'
            AND (running.substream_id = '0'
              OR (running.background_agent = 1 AND running.root_substream_id = '0')
              OR (directory.lifecycle = 'active' AND EXISTS (
                SELECT 1 FROM sidekick_runs run WHERE run.sidekick_id = running.sidekick_id
                  AND run.run_id = CASE WHEN running.background_agent = 1
                    THEN running.root_substream_id ELSE running.substream_id END
                  AND run.state IN ('pending', 'running', 'needs_input')
              )))) AS sidekicks
        FROM requested`,
    JSON.stringify(missing),
  ).toArray()) result.set(row.canvas_id, { backgroundAgents: row.background_agents, sidekicks: row.sidekicks });
  return result;
}
