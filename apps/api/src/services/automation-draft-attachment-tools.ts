import type { HarnessTool } from "@rally/agent-harness";
import { asHarnessRunId, asWorkstreamId, type UserId, type WorkspaceId, type WorkstreamWorkflowInput } from "@rally/contracts";

import type { Env } from "../env";
import { sha256 } from "../lib/crypto";
import { createWorkstreamAttachmentTools } from "./workstream-attachment-tools";
import type {
  VisibleWorkstreamResourceRow,
  VisibleWorkstreamResourceSet,
} from "./workstream-resource-visibility";

const MAXIMUM_DRAFT_ATTACHMENTS = 10;

export interface AutomationDraftAttachmentScope {
  workspaceId: WorkspaceId;
  userId: UserId;
  scopeId: string;
  frozenResourceIds: readonly string[];
}

/**
 * Expose the shared attachment operations behind the automation compiler's
 * frozen request scope. The ID set is immutable, but every operation loads the
 * rows again so deletion, ownership change, or draft promotion revokes access.
 */
export function createAutomationDraftAttachmentTools(
  env: Env,
  scope: AutomationDraftAttachmentScope,
): HarnessTool[] {
  const frozenResourceIds = [...new Set(scope.frozenResourceIds)];
  // The draft scope id stands in for workstream/run ids, which do not exist yet.
  const toolInput: WorkstreamWorkflowInput = {
    region: env.AVALON_REGION,
    workspaceId: scope.workspaceId,
    workstreamId: asWorkstreamId(scope.scopeId),
    harnessRunId: asHarnessRunId(scope.scopeId),
    triggerMessageId: null,
    automationSubscriptionId: null,
    activityId: null,
    executionPrincipal: { type: "user", userId: scope.userId },
    reason: "automation_draft_attachments",
  };
  return createWorkstreamAttachmentTools(env, toolInput, {
    cursorNamespace: "automation-draft",
    modelToolPrefix: "automation",
    capabilityPrefix: "automation.attachments",
    loadVisibleResources: () => loadVisibleAutomationDraftResources(env.DB, {
      ...scope,
      frozenResourceIds,
    }),
  }).filter((tool) => tool.definition.name !== "list_resources");
}

export async function loadVisibleAutomationDraftResources(
  database: D1Database,
  scope: AutomationDraftAttachmentScope,
): Promise<VisibleWorkstreamResourceSet> {
  const frozenResourceIds = [...new Set(scope.frozenResourceIds)];
  if (frozenResourceIds.length > MAXIMUM_DRAFT_ATTACHMENTS) {
    throw new Error(`Automation drafts support at most ${MAXIMUM_DRAFT_ATTACHMENTS} attachments`);
  }
  if (frozenResourceIds.length === 0) return { rows: [], fingerprint: await sha256("[]") };
  const placeholders = frozenResourceIds.map(() => "?").join(", ");
  const result = await database.prepare(
    `SELECT r.*, 'automation_draft' AS relationship_type,
            r.created_at AS attached_at, 0 AS message_attachment,
            0 AS attached_watch_enabled, r.updated_at AS visibility_version
       FROM resources r
      WHERE r.id IN (${placeholders})
        AND r.workspace_id = ? AND r.provider = 'avalon_upload'
        AND r.uploaded_by_user_id = ? AND r.attachment_status = 'draft'`,
  ).bind(...frozenResourceIds, scope.workspaceId, scope.userId).all<VisibleWorkstreamResourceRow>();
  const rows = result.results ?? [];
  rows.sort((left, right) => right.attached_at.localeCompare(left.attached_at) || left.id.localeCompare(right.id));
  const fingerprint = await sha256(JSON.stringify({
    frozenResourceIds,
    visible: rows.map((row) => [row.id, row.updated_at, row.visibility_version]),
  }));
  return { rows, fingerprint };
}
