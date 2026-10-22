import { SidekickActivityTargetSchema, UserIdSchema, WorkspaceIdSchema } from "@rally/contracts";
import type { z } from "zod";
import { sidekickAudienceAllows } from "./sidekick-audience";

export const SidekickActivityRequestSchema = SidekickActivityTargetSchema.extend({
  workspaceId: WorkspaceIdSchema,
  userId: UserIdSchema,
});
export type SidekickActivityRequest = z.input<typeof SidekickActivityRequestSchema>;
const RUNNING_STATES = ['running', 'scheduled', 'preparing_context', 'waiting_capacity', 'interrupting'];

/** Count Sidekicks, not executions: setup and concurrent runs still represent one helper. */
export function runningSidekickCount(sql: SqlStorage, target: SidekickActivityRequest, channelSidekickIds: readonly string[] = []): number {
  const candidates = sql.exec<{
    id: string; direct: number; scope: string; author_user_id: string;
    run_as_user_id: string | null; owning_workstream_id: string | null;
  }>(
    `WITH attached(id, instruction) AS (
       SELECT value, 1 FROM json_each(?4)
       UNION SELECT automation_id, 0 FROM automation_directory
         WHERE ?1 = 'workstream' AND owning_workstream_id = ?2 AND owning_substream_id = ?3
       UNION SELECT automation_id, 0 FROM sidekick_conversation_attachments
         WHERE ?1 = 'workstream' AND parent_id = ?2 AND substream_id = ?3
       UNION SELECT sidekick_id, 1 FROM parent_sidekicks WHERE ?1 = 'workstream' AND parent_id = ?2
       UNION SELECT value, 1 FROM parent_child_projections,
         json_each(effect_json, '$.sidekickAttachmentIds')
         WHERE ?1 = 'workstream' AND parent_id = ?2 AND substream_id = ?3
           AND json_extract(effect_json, '$.kind') = 'directory_common'
     )
     SELECT DISTINCT directory.automation_id AS id, directory.scope, directory.author_user_id,
         directory.run_as_user_id, directory.owning_workstream_id,
         EXISTS (SELECT 1 FROM attached WHERE id = directory.automation_id AND instruction = 0) AS direct
       FROM attached JOIN automation_directory directory ON directory.automation_id = attached.id
       JOIN sidekick_child_projections child ON child.sidekick_id = directory.automation_id
      WHERE directory.lifecycle <> 'deleted'
        AND json_extract(child.effect_json, '$.archivedAt') IS NULL
        AND COALESCE(json_extract(child.effect_json, '$.backgroundAgent'), 0) = 0
        AND json_extract(child.effect_json, '$.state') IN (SELECT value FROM json_each(?5))
        AND (child.substream_id = '0' OR (directory.lifecycle = 'active' AND EXISTS (
          SELECT 1 FROM sidekick_runs run WHERE run.sidekick_id = child.sidekick_id
            AND run.run_id = child.substream_id AND run.state IN ('pending', 'running', 'needs_input')
        )))`,
    target.parentKind, target.parentId, target.substreamId, JSON.stringify(channelSidekickIds), JSON.stringify(RUNNING_STATES),
  ).toArray();
  // Instruction-only links use the rail's audience rule. A home or explicit
  // posting attachment is already consent to show activity in this conversation.
  const scope = sql.exec<{ scope: 'personal' | 'workspace' }>(
    `SELECT json_extract(effect_json, '$.scope') AS scope FROM parent_child_projections
      WHERE parent_id = ? AND substream_id = ?`, target.parentId, target.substreamId,
  ).toArray()[0]?.scope ?? 'workspace';
  const audienceUserIds = candidates.some((row) => !row.direct && row.scope === 'personal')
    ? sql.exec<{ user_id: string }>(
      `SELECT user_id FROM parent_child_viewer_projections WHERE parent_id = ? AND substream_id = ?
        AND json_extract(effect_json, '$.isParticipant') = 1`, target.parentId, target.substreamId,
    ).toArray().map((row) => row.user_id) : [];
  return candidates.filter((row) => row.direct || sidekickAudienceAllows({
    scope: row.scope, authorUserId: row.author_user_id, runAsUserId: row.run_as_user_id,
    owningWorkstreamId: row.owning_workstream_id,
  }, {
    principalUserId: target.userId, conversationParentId: target.parentId,
    audienceScope: scope, audienceUserIds,
  })).length;
}

/** The same execution states as the count; lifecycle alone never means work is in flight. */
export function sidekickProjectionRunning(effect: { state: string; archivedAt: string | null; backgroundAgent?: boolean | undefined }): boolean {
  return effect.archivedAt === null && !effect.backgroundAgent
    && RUNNING_STATES.includes(effect.state);
}
