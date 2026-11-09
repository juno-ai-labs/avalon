import { logInfo } from '../observability/logger';
import { AccessRecoverySchema } from '@rally/contracts/private-access';
import { Hono } from 'hono';
import { z } from 'zod';
import type { HonoAppEnv } from '../env';
import { ApiError } from '../lib/api-error';
import { accessAcknowledgementContent } from '../services/access-request-content';
import { requestAccess } from '../services/access-request-service';
import { ACE_OPERATOR_ROLE, getOperator, requireAceOperator, requireOperatorRole } from '../telemetry/operator-auth';

export const accessOperatorRoutes = new Hono<HonoAppEnv>();
accessOperatorRoutes.use('*', requireAceOperator, requireOperatorRole(ACE_OPERATOR_ROLE));
accessOperatorRoutes.post('/requests/:id/recover', async (c) => {
  if (c.env.AVALON_REGION !== 'global') throw new ApiError(404, 'not_found', 'Not found');
  const id = z.string().uuid().safeParse(c.req.param('id'));
  const input = AccessRecoverySchema.safeParse(await c.req.json().catch(() => null));
  if (!id.success || !input.success) throw new ApiError(400, 'invalid_access_recovery', 'Confirm this recovery action.');
  const row = await c.env.DB.prepare(`SELECT email, acknowledgement_status AS status,
    acknowledgement_first_attempt_at AS firstAttemptAt, acknowledgement_generation AS generation
    FROM access_requests WHERE id = ?`).bind(id.data)
    .first<{ email: string; status: string; firstAttemptAt: string | null; generation: number }>();
  if (!row) throw new ApiError(404, 'not_found', 'Request not found');
  if (row.generation !== input.data.generation) throw new ApiError(409, 'access_recovery_conflict', 'This request changed. Refresh before continuing.');
  const action = input.data.action;
  // Recovery is an explicit operator attestation about the provider outcome,
  // not an automatic lease expiry. The generation fences any stale completion.
  if (action === 'retry') {
    if (!['pending', 'failed'].includes(row.status)) throw new ApiError(409, 'access_reconciliation_required', 'Check the provider outcome before retrying this request.');
  } else {
    if (action !== 'suppress' && ['sent', 'skipped', 'suppressed'].includes(row.status)) {
      throw new ApiError(409, 'access_already_resolved', 'This request is already resolved.');
    }
    const next = action === 'confirm_sent' ? 'sent' : action === 'suppress' ? 'suppressed' : 'pending';
    const reset = action === 'retry_reconciled';
    const result = await c.env.DB.prepare(`UPDATE access_requests SET acknowledgement_status = ?,
      acknowledgement_generation = acknowledgement_generation + 1,
      acknowledgement_first_attempt_at = CASE WHEN ? THEN NULL ELSE acknowledgement_first_attempt_at END,
      acknowledgement_from = CASE WHEN ? THEN ? ELSE acknowledgement_from END,
      acknowledgement_subject = CASE WHEN ? THEN ? ELSE acknowledgement_subject END,
      acknowledgement_markdown = CASE WHEN ? THEN ? ELSE acknowledgement_markdown END,
      acknowledged_at = CASE WHEN ? = 'sent' THEN ? ELSE acknowledged_at END
      WHERE id = ? AND acknowledgement_generation = ? AND acknowledgement_status = ? RETURNING id`)
      .bind(next, reset ? 1 : 0, reset ? 1 : 0, accessAcknowledgementContent.from,
        reset ? 1 : 0, accessAcknowledgementContent.subject, reset ? 1 : 0, accessAcknowledgementContent.markdown,
        next, new Date().toISOString(), id.data, row.generation, row.status).first();
    if (!result) throw new ApiError(409, 'access_recovery_conflict', 'This request changed. Refresh before continuing.');
  }
  logInfo(c.env, 'access_acknowledgement_recovery', { actor: getOperator(c).operatorId, accessRequestId: id.data, action });
  if (action === 'retry' || action === 'retry_reconciled') await requestAccess(c.env, row.email);
  return c.json({ accepted: true });
});
