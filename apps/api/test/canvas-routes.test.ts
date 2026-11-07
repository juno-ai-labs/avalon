import { asUserId, asWorkspaceId } from '@rally/contracts';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthContext, HonoAppEnv } from '../src/env';
import { errorHandler } from '../src/middleware/errors';
import { canvasRoutes } from '../src/routes/canvases';
import { CanvasService } from '../src/services/canvas-service';
import { createTestEnv } from './helpers/cloudflare-test';

const WORKSPACE_ID = asWorkspaceId('00000000-0000-7000-8000-0000000c8b01');
const USER_ID = asUserId('00000000-0000-7000-8000-0000000c8b02');
const CANVAS_ID = '00000000-0000-7000-8000-0000000c8b03';

afterEach(() => vi.restoreAllMocks());

function routedApp(role: AuthContext['role'] = 'member'): Hono<HonoAppEnv> {
  const app = new Hono<HonoAppEnv>();
  app.use('*', async (context, next) => {
    context.set('auth', { sessionId: 'session', workspaceId: WORKSPACE_ID, userId: USER_ID, region: 'global', role,
      ...(role === null ? { accessClass: 'guest' as const } : {}) });
    await next();
  });
  app.route('/canvases', canvasRoutes);
  app.onError(errorHandler);
  return app;
}

const env = () => createTestEnv({ AVALON_REGION: 'global', LOG_LEVEL: 'error' });
const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('the Canvas routes', () => {
  it('creates a Canvas with its first prompt through the service', async () => {
    const create = vi.spyOn(CanvasService.prototype, 'create').mockResolvedValue({ canvasId: CANVAS_ID as never, turnId: 'turn-1' });
    const response = await routedApp().request('/canvases', json({ title: 'Launch plan', prompt: { text: 'Draft it', clientMessageId: 'c-1' } }), env());
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ canvasId: CANVAS_ID, turnId: 'turn-1' });
    expect(create).toHaveBeenCalledWith({ title: 'Launch plan', prompt: { text: 'Draft it', clientMessageId: 'c-1' } });
  });

  it('refuses a guest making a Canvas, by name', async () => {
    const response = await routedApp(null).request('/canvases', json({}), env());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'canvas_create_member_required' } });
  });

  it('refuses an audience that names people for a creator-only Canvas before calling the service', async () => {
    const setAudience = vi.spyOn(CanvasService.prototype, 'setAudience');
    const response = await routedApp().request(`/canvases/${CANVAS_ID}/audience`,
      json({ visibility: 'creator', userIds: [USER_ID] }), env());
    expect(response.status).toBe(400);
    expect(setAudience).not.toHaveBeenCalled();
  });

  it('pins and unpins through the service, and refuses an id that is not one', async () => {
    const pin = vi.spyOn(CanvasService.prototype, 'pin').mockResolvedValue(undefined);
    expect((await routedApp().request(`/canvases/${CANVAS_ID}/pin`, json({ pinned: true }), env())).status).toBe(204);
    expect(pin).toHaveBeenCalledWith('canvas', CANVAS_ID, true);
    expect((await routedApp().request('/canvases/not-a-canvas/pin', json({ pinned: true }), env())).status).toBe(400);
  });
});
