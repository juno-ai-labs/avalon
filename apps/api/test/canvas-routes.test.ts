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

  it('names the field and the reason when it refuses a retitle, and a malformed Canvas id by name', async () => {
    const update = vi.spyOn(CanvasService.prototype, 'update');
    const patch = (id: string, body: unknown) => routedApp().request(`/canvases/${id}`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env());
    for (const [title, issue] of [['', 'too_small'], ['   ', 'too_small'], ['x'.repeat(301), 'too_big']] as const) {
      const response = await patch(CANVAS_ID, { title });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: {
        code: `canvas_rename_invalid:title:${issue}`, message: 'A Canvas title needs 1 to 300 characters other than spaces at either end', requestId: null } });
    }
    const malformed = await patch('not-a-canvas', { title: 'Launch plan' });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: {
      code: 'canvas_id_invalid:id:invalid_format', message: 'This is not a Canvas id', requestId: null } });
    expect(update).not.toHaveBeenCalled();
  });

  it('passes an appearance choice to the service, and refuses one outside the catalog or a body with nothing in it, by field', async () => {
    const update = vi.spyOn(CanvasService.prototype, 'update').mockResolvedValue({} as never);
    const patch = (body: unknown) => routedApp().request(`/canvases/${CANVAS_ID}`,
      { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env());
    await patch({ appearance: { icon: 'flag' } });
    expect(update).toHaveBeenCalledWith(CANVAS_ID, { appearance: { icon: 'flag' } });
    update.mockClear();
    const unknownIcon = await patch({ appearance: { icon: 'not-an-icon' } });
    expect(unknownIcon.status).toBe(400);
    expect(await unknownIcon.json()).toMatchObject({ error: { code: 'canvas_rename_invalid:appearance.icon:invalid_value' } });
    const empty = await patch({});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: { code: 'canvas_rename_invalid:-root-:custom' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('pins and unpins through the service, and refuses an id that is not one', async () => {
    const pin = vi.spyOn(CanvasService.prototype, 'pin').mockResolvedValue(undefined);
    expect((await routedApp().request(`/canvases/${CANVAS_ID}/pin`, json({ pinned: true }), env())).status).toBe(204);
    expect(pin).toHaveBeenCalledWith('canvas', CANVAS_ID, true);
    expect((await routedApp().request('/canvases/not-a-canvas/pin', json({ pinned: true }), env())).status).toBe(400);
  });
});
