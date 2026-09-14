import { asUserId, asWorkspaceId } from '@rally/contracts';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HonoAppEnv } from '../src/env';
import { errorHandler } from '../src/middleware/errors';
import { sidekickRoutes } from '../src/routes/automations';
import { AutomationService } from '../src/services/automation-service';
import { createTestEnv } from './helpers/cloudflare-test';

const WORKSPACE_ID = asWorkspaceId('00000000-0000-7000-8000-0000000008a1');
const USER_ID = asUserId('00000000-0000-7000-8000-0000000008a2');
const SIDEKICK_ID = '00000000-0000-7000-8000-0000000008a3';

afterEach(() => vi.restoreAllMocks());

function routedApp(): Hono<HonoAppEnv> {
  const app = new Hono<HonoAppEnv>();
  app.use('*', async (context, next) => {
    context.set('auth', {
      sessionId: 'session',
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      region: 'global',
      role: 'owner',
    });
    await next();
  });
  app.route('/sidekicks', sidekickRoutes);
  app.onError(errorHandler);
  return app;
}

describe('the Sidekick archive route', () => {
  it('routes a valid Sidekick id through the authorized service operation', async () => {
    const archive = vi.spyOn(AutomationService.prototype, 'archive').mockResolvedValue(undefined);

    const response = await routedApp().request(
      `/sidekicks/${SIDEKICK_ID}/archive`,
      { method: 'POST' },
      createTestEnv({ AVALON_REGION: 'global', LOG_LEVEL: 'error' }),
    );

    expect(response.status).toBe(204);
    expect(archive).toHaveBeenCalledWith(SIDEKICK_ID);
  });

  it('rejects an invalid Sidekick id before calling the service', async () => {
    const archive = vi.spyOn(AutomationService.prototype, 'archive').mockResolvedValue(undefined);

    const response = await routedApp().request(
      '/sidekicks/not-a-sidekick/archive',
      { method: 'POST' },
      createTestEnv({ AVALON_REGION: 'global', LOG_LEVEL: 'error' }),
    );

    expect(response.status).toBe(400);
    expect(archive).not.toHaveBeenCalled();
  });
});
