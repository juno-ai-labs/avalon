import {
  DemoOperationAbandonRequestSchema,
  DemoOperationListSchema,
  DemoOperationStartRequestSchema,
  DemoOperationStatusSchema,
  DemoTemplateSchema,
  IdSchema,
} from '@rally/contracts';
import { Hono } from 'hono';
import { z } from 'zod';

import type { HonoAppEnv } from '../env';
import { ApiError } from '../lib/api-error';
import { zValidator } from '../middleware/validation';
import {
  abandonDemoOperation,
  demoOperationStatus,
  demoTemplate,
  listDemoOperations,
  retryDemoOperation,
  startDemoOperation,
} from '../services/demo-preparation';
import { getTelemetryOperator, requireOperatorRole, requireTelemetryOperator } from '../telemetry/operator-auth';

/**
 * The regional API Ace's Demos page talks to.
 *
 * Behind the operator credential, in the `demos` role: Ace holds one token
 * per region, and that token can prepare a demo and retire a workspace
 * (`workspace-operations.ts`) and nothing else. Every handler validates,
 * delegates, and maps; the rules live in `demo-preparation.ts`.
 */

const OperationParamSchema = z.strictObject({ operationId: IdSchema });

export const demoOperatorRoutes = new Hono<HonoAppEnv>();
demoOperatorRoutes.use('*', requireTelemetryOperator, requireOperatorRole('demos'));

demoOperatorRoutes.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(DemoOperationListSchema.parse({ operations: await listDemoOperations(c.env) }));
});

demoOperatorRoutes.get('/template', async (c) => {
  c.header('Cache-Control', 'no-store');
  return c.json(DemoTemplateSchema.parse(await demoTemplate(c.env)));
});

demoOperatorRoutes.post('/', zValidator('json', DemoOperationStartRequestSchema), async (c) => {
  // The operator's id travels into the region's own log: this creates a
  // workspace and copies credentials into it, and the region should be able
  // to say who asked without Ace's logs.
  const status = await startDemoOperation(c.env, c.req.valid('json'), { operatorId: getTelemetryOperator(c).operatorId });
  return c.json(DemoOperationStatusSchema.parse(status));
});

demoOperatorRoutes.get('/:operationId', zValidator('param', OperationParamSchema), async (c) => {
  c.header('Cache-Control', 'no-store');
  const status = await demoOperationStatus(c.env, c.req.valid('param').operationId);
  if (!status) throw new ApiError(404, 'demo_operation_not_found', 'No such demo preparation');
  return c.json(DemoOperationStatusSchema.parse(status));
});

demoOperatorRoutes.post('/:operationId/retry', zValidator('param', OperationParamSchema), async (c) => {
  const status = await retryDemoOperation(c.env, c.req.valid('param').operationId);
  return c.json(DemoOperationStatusSchema.parse(status));
});

demoOperatorRoutes.post(
  '/:operationId/abandon',
  zValidator('param', OperationParamSchema),
  zValidator('json', DemoOperationAbandonRequestSchema),
  async (c) => {
    const status = await abandonDemoOperation(c.env, c.req.valid('param').operationId, {
      confirmOperationId: c.req.valid('json').confirmOperationId,
      operatorId: getTelemetryOperator(c).operatorId,
    });
    return c.json(DemoOperationStatusSchema.parse(status));
  },
);
