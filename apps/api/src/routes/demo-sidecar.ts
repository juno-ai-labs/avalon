import { requireDemoOperator } from '../services/impersonation';
import { Hono } from 'hono';
import { DemoCatalogSchema, DemoMessageRequestSchema, DemoMessageResultSchema } from '@rally/contracts/demo-sidecar';
import type { HonoAppEnv } from '../env';
import { getAuth } from '../middleware/auth';
import { zValidator } from '../middleware/validation';
import { demoCatalog, sendDemoMessage } from '../services/demo-sidecar';

export const demoSidecarRoutes = new Hono<HonoAppEnv>();
demoSidecarRoutes.get('/eligibility', async c => {
  const auth = getAuth(c);
  await requireDemoOperator(c.env.DB, auth.workspaceId, auth.userId, c.env.AVALON_REGION);
  return c.json({ eligible: true });
});
demoSidecarRoutes.get('/catalog', async c => c.json(DemoCatalogSchema.parse(await demoCatalog(c.env, getAuth(c)))));
demoSidecarRoutes.post('/messages', zValidator('json', DemoMessageRequestSchema), async c =>
  c.json(DemoMessageResultSchema.parse(await sendDemoMessage(c.env, getAuth(c), c.req.valid('json'), c.get('requestId')))));
