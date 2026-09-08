import { WorkspaceRetirementResultSchema } from '@rally/contracts';
import { Hono } from 'hono';
import { z } from 'zod';

import type { HonoAppEnv } from '../env';
import { ApiError } from '../lib/api-error';
import { zValidator } from '../middleware/validation';
import { retireWorkspaceForOperator } from '../services/workspace-retirement-service';
import { getTelemetryOperator, requireOperatorRole, requireTelemetryOperator } from '../telemetry/operator-auth';

/**
 * The regional API Ace's workspaces tab talks to.
 *
 * Behind the operator credential, in the `demos` role: Ace holds one token
 * per region, and that token can retire and nothing else. The handler
 * validates, delegates, and maps; the rules live in
 * `workspace-retirement-service.ts`.
 */

const WorkspaceParamSchema = z.strictObject({ workspaceId: z.string().uuid() });
/**
 * The confirmation the page collected: the operator typed or pasted the id
 * they are closing. Carried to the API and compared with the path, which
 * catches a page or a script that named one workspace and closed another; it
 * is a consistency check on the request, not a second confirmation — a caller
 * that sets both fields to the same id passes it, and the typed ceremony
 * itself is the page's.
 */
const RetireBodySchema = z.strictObject({ confirmWorkspaceId: z.string().uuid() });

export const workspaceOperatorRoutes = new Hono<HonoAppEnv>();
workspaceOperatorRoutes.use('*', requireTelemetryOperator, requireOperatorRole('demos'));

workspaceOperatorRoutes.post(
  '/:workspaceId/retire',
  zValidator('param', WorkspaceParamSchema),
  zValidator('json', RetireBodySchema),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    if (c.req.valid('json').confirmWorkspaceId !== workspaceId) {
      throw new ApiError(409, 'workspace_retirement_unconfirmed', 'The confirmation does not name this workspace');
    }
    const receipt = await retireWorkspaceForOperator(c.env, workspaceId, {
      operatorId: getTelemetryOperator(c).operatorId,
    });
    return c.json(WorkspaceRetirementResultSchema.parse({ workspaceId, ...receipt }));
  },
);
