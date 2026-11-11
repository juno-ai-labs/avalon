import type { WorkspaceId } from "@rally/contracts";
import type { Env } from "../env";

/** The owning region's saved Organization presentation settings, independent of deployment defaults. */
export async function readOrganizationSettings(env: Env, orgId: WorkspaceId) {
  const row = await env.DB.prepare(
    "SELECT model_selector_visible FROM workspaces WHERE id = ? AND region = ? AND abandoned_at IS NULL",
  ).bind(orgId, env.AVALON_REGION).first<{ model_selector_visible: number }>();
  if (!row) throw new Error("engineering_organization_not_found");
  return { region: env.AVALON_REGION, orgId, modelSelectorVisible: row.model_selector_visible === 1 };
}

export async function updateOrganizationSettings(env: Env, orgId: WorkspaceId, modelSelectorVisible: boolean) {
  const row = await env.DB.prepare(
    `UPDATE workspaces SET model_selector_visible = ?, updated_at = ?
     WHERE id = ? AND region = ? AND abandoned_at IS NULL RETURNING model_selector_visible`,
  ).bind(Number(modelSelectorVisible), new Date().toISOString(), orgId, env.AVALON_REGION)
    .first<{ model_selector_visible: number }>();
  if (!row) throw new Error("engineering_organization_not_found");
  return { region: env.AVALON_REGION, orgId, modelSelectorVisible: row.model_selector_visible === 1 };
}
