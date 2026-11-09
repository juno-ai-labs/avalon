import { WorkspaceRetirementResultSchema } from '@rally/contracts';
import { WorkspacePlanChangeSchema, WorkspacePlanResultSchema } from '@rally/contracts/usage';
import { Hono } from 'hono';
import { z } from 'zod';

import type { HonoAppEnv } from '../env';
import { ApiError } from '../lib/api-error';
import { requestDeferral } from '../lib/defer';
import { zValidator } from '../middleware/validation';
import { publishOrganizationUsage, setWorkspacePlan } from '../services/usage-metering';
import { retireWorkspaceForOperator } from '../services/workspace-retirement-service';
import { ACE_OPERATOR_ROLE, getOperator, requireAceOperator, requireOperatorRole } from '../telemetry/operator-auth';

/**
 * The regional API Ace's workspaces tab talks to.
 *
 * Behind the operator credential in the `demos` role, from the region's
 * `DEMO_OPERATORS_JSON`: Ace holds one token per region, and that token can
 * retire a workspace and set its plan, and nothing else. The handlers
 * validate, delegate, and map; the rules live in
 * `workspace-retirement-service.ts` and `usage-metering.ts`.
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
workspaceOperatorRoutes.use('*', requireAceOperator, requireOperatorRole(ACE_OPERATOR_ROLE));

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
      operatorId: getOperator(c).operatorId,
    });
    return c.json(WorkspaceRetirementResultSchema.parse({ workspaceId, ...receipt }));
  },
);

// Move a workspace to a plan. The new weekly quota applies to the current week
// at once, and every connected member is sent the new meter; see
// docs/usage-metering.md.
workspaceOperatorRoutes.post(
  '/:workspaceId/plan',
  zValidator('param', WorkspaceParamSchema),
  zValidator('json', WorkspacePlanChangeSchema),
  async (c) => {
    const { workspaceId } = c.req.valid('param');
    const { plan } = c.req.valid('json');
    if (!await setWorkspacePlan(c.env, workspaceId, plan, Date.now())) {
      throw new ApiError(404, 'workspace_not_found', 'This region has no such workspace');
    }
    requestDeferral(c)(publishOrganizationUsage(c.env, workspaceId));
    return c.json(WorkspacePlanResultSchema.parse({ workspaceId, plan }));
  },
);
