import { z } from 'zod';
import { UserIdSchema } from '@rally/contracts';
import { ApiError } from '../lib/api-error';
import { DEMO_CAST_EMAIL_DOMAIN } from './demo-cast';
import { DEMO_TEMPLATE_WORKSPACE_ID } from './demo-workspace-visibility';

/** Generic directed authority. Replay never reopens a revoked edge. */
export async function provisionImpersonationRelationships(
  db: D1Database, workspaceId: string, users: readonly string[], authorityBasis: string,
): Promise<void> {
  const at = new Date().toISOString();
  const ids = [...new Set(users)];
  // One statement avoids partial pair sets and variable-count limits.
  await db.prepare(`INSERT INTO impersonation_relationships
    (workspace_id, operator_user_id, represented_user_id, authority_basis, created_at)
    SELECT ?, operator.value, represented.value, ?, ?
    FROM json_each(?) operator CROSS JOIN json_each(?) represented WHERE true
    ON CONFLICT (workspace_id, operator_user_id, represented_user_id) DO NOTHING`)
    .bind(workspaceId, authorityBasis, at, JSON.stringify(ids), JSON.stringify(ids)).run();
}

export async function requireImpersonationRelationship(
  db: D1Database, workspaceId: string, operatorId: string, representedId: string,
): Promise<string> {
  const row = await db.prepare(`SELECT authority_basis FROM impersonation_relationships
    WHERE workspace_id = ? AND operator_user_id = ? AND represented_user_id = ? AND revoked_at IS NULL`)
    .bind(workspaceId, operatorId, representedId).first<{ authority_basis: string }>();
  if (!row) throw new ApiError(403, 'impersonation_denied', 'This participant is not available for impersonation');
  return row.authority_basis;
}

/** Sidecar availability is stricter than the generic relationship. No client hints. */
export async function requireDemoOperator(db: D1Database, workspaceId: string, operatorId: string, region: string) {
  const row = await db.prepare(`SELECT op.operation_id, op.cast_json, op.presenter_user_id, u.email, u.platform_user_id
    FROM demo_operations op JOIN workspaces w ON w.id = op.workspace_id
    JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
    JOIN users u ON u.id = m.user_id
    WHERE w.id = ? AND w.region = ? AND w.abandoned_at IS NULL
      AND m.status = 'active' AND m.access_class = 'member'
      AND op.status = 'ready' AND op.ready_at IS NOT NULL AND op.retired_at IS NULL`)
    .bind(operatorId, workspaceId, region).first<{
      operation_id: string; cast_json: string; presenter_user_id: string; email: string; platform_user_id: string | null;
    }>();
  const denied = () => new ApiError(403, 'demo_sidecar_denied', 'Demo sidecar is available only to the original company cast in an active demo organization');
  // Regional platform identities come only from verified Google/email sign-in.
  if (!row || workspaceId === DEMO_TEMPLATE_WORKSPACE_ID || !row.platform_user_id
    || row.email.split('@').length !== 2 || row.email.split('@')[1]?.toLowerCase() !== DEMO_CAST_EMAIL_DOMAIN) throw denied();
  let raw: unknown;
  try { raw = JSON.parse(row.cast_json); } catch { throw denied(); }
  const parsed = z.record(z.string(), UserIdSchema).safeParse(raw);
  if (!parsed.success || Object.keys(parsed.data).length === 0) throw denied();
  const cast = [...new Set([row.presenter_user_id, ...Object.values(parsed.data)])];
  if (!cast.includes(operatorId)) throw denied();
  return { operationId: row.operation_id, cast };
}
