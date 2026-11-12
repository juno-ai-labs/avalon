import type { AutomationDraft } from "@rally/contracts";

import { ApiError } from "../lib/api-error";

/** Accepted definitions own bindings; a pause retains its name, an archive releases it. */
export function artifactSidekickBinding(sql: SqlStorage, artifactId: string, bindingName: string): string | null {
  return sql.exec<{ automation_id: string }>(
    `SELECT directory.automation_id
       FROM automation_directory directory
       JOIN sidekick_revisions revision ON revision.sidekick_id = directory.automation_id
         AND revision.definition_revision = directory.accepted_definition_revision,
            json_each(revision.definition_json, '$.triggers') trigger
      WHERE directory.lifecycle != 'deleted' AND json_extract(trigger.value, '$.type') = 'invocation'
        AND json_extract(trigger.value, '$.artifactId') = ?
        AND json_extract(trigger.value, '$.bindingName') = ?`,
    artifactId, bindingName,
  ).toArray()[0]?.automation_id ?? null;
}

/** Binding and artifact-tool write access use the same attached-Canvas relationship. */
export function assertArtifactSidekickTarget(sql: SqlStorage, sidekickId: string, artifactId: string) {
  const target = sql.exec<{ resource_id: string; current_version: number }>(
    `SELECT artifact.resource_id, artifact.current_version FROM artifact_registry artifact
       JOIN canvas_directory canvas ON canvas.canvas_id = artifact.workstream_id AND canvas.archived_at IS NULL
       JOIN sidekick_conversation_attachments attachment ON attachment.parent_id = canvas.canvas_id
         AND attachment.parent_kind = 'canvas' AND attachment.substream_id = '0' AND attachment.automation_id = ?
      WHERE artifact.artifact_id = ? AND artifact.mode = 'active'`, sidekickId, artifactId,
  ).toArray()[0];
  if (!target) throw new ApiError(409, "sidekick_invocation_artifact_unavailable",
    "invocation.artifactId must name an active app in an open Canvas attached to this Sidekick");
  return target;
}

export function assertArtifactSidekickBindings(sql: SqlStorage, sidekickId: string, triggers: AutomationDraft["triggers"]): void {
  for (const trigger of triggers) {
    if (trigger.type !== "invocation") continue;
    assertArtifactSidekickTarget(sql, sidekickId, trigger.artifactId);
    const bound = artifactSidekickBinding(sql, trigger.artifactId, trigger.bindingName);
    if (bound !== null && bound !== sidekickId) throw new ApiError(409, "sidekick_invocation_binding_taken",
      "invocation.bindingName is already bound to another Sidekick in this app");
  }
}
