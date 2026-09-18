import "../../../tests/isolated-region";
/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { HonoAppEnv } from '../src/env';
import { errorHandler } from '../src/middleware/errors';
import { parseCrashUpload } from '../src/routes/telemetry';

function app(): Hono<HonoAppEnv> {
  const instance = new Hono<HonoAppEnv>();
  instance.post('/parse', async (c) => {
    const parsed = await parseCrashUpload(c);
    return c.json({ metadata: parsed.metadata, bytes: [...parsed.bytes] });
  });
  instance.onError(errorHandler);
  return instance;
}

function validForm(): FormData {
  const form = new FormData();
  form.set('metadata', JSON.stringify({
    uploadId: '018f22f2-4c22-7abc-8def-0123456789ab',
    installationId: '018f22f2-4c22-7abc-8def-0123456789ac',
    route: 'enterprise', release: '1.0.0', buildId: 'build', platform: 'linux',
    architecture: 'x64', processRole: 'renderer',
    launchId: '018f22f2-4c22-7abc-8def-0123456789ad', channel: 'stable',
  }));
  form.set('dump', new File([new TextEncoder().encode('MDMP')], 'report.dmp', {
    type: 'application/octet-stream',
  }));
  return form;
}

describe('telemetry multipart parsing in workerd', () => {
  it('parses one real workerd File and preserves validated metadata', async () => {
    const response = await app().request('/parse', { method: 'POST', body: validForm() }, {
      AVALON_REGION: 'enterprise', LOG_LEVEL: 'error',
    } as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      metadata: { route: 'enterprise', processRole: 'renderer' },
      bytes: [77, 68, 77, 80],
    });
  });

  it('rejects duplicate and unknown multipart fields without exposing parser details', async () => {
    const form = validForm();
    form.append('dump', new File([new Uint8Array([1])], 'second.dmp'));
    form.set('unknown', 'private-value');
    const response = await app().request('/parse', { method: 'POST', body: form }, {
      AVALON_REGION: 'global', LOG_LEVEL: 'error',
    } as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'crash_upload_invalid' } });
  });
});
