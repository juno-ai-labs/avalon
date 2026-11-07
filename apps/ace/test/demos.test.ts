import "../../../tests/isolated-region";
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import { createTestEnv } from './helpers/cloudflare-test';

/**
 * Ace relays; it does not decide. Each demo route asks the regional API with
 * the operator token and hands back what it answered, parsed with the shared
 * contract — and a regional refusal reaches the page as the API's own code and
 * message. Writes are same-origin.
 */

const OPERATION_ID = '00000000-0000-7000-8000-0000000000e2';
const WORKSPACE_ID = '00000000-0000-7000-8000-0000000000f1';
const PRESENTER_ID = '00000000-0000-7000-8000-0000000000a1';
const PRIYA_ID = '00000000-0000-7000-8000-0000000000a2';

function env(overrides: Partial<Env> = {}): Env {
  return createTestEnv({
    APP_ENV: 'development',
    ACE_DEV_AUTH: 'true',
    APP_VERSION: 'test',
    ASSETS: { fetch: vi.fn(async () => new Response('asset')) },
    RALLY_API_BASE_URL: 'https://api.rally.test',
    RALLY_ENTERPRISE_API_BASE_URL: 'https://enterprise.api.rally.test',
    RALLY_OPERATOR_TOKEN: 'operator-token-for-tests',
    RALLY_ENTERPRISE_OPERATOR_TOKEN: 'enterprise-operator-token-for-tests',
    ...overrides,
  });
}

const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;

function operation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationId: OPERATION_ID,
    companyName: 'Alto Capital',
    presenterUserId: PRESENTER_ID,
    presenterName: 'Adam',
    packVersion: 'canvases-2026-11',
    cast: { presenter: PRESENTER_ID },
    castNames: { presenter: 'Adam' },
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Alto Capital-demo',
    status: 'running',
    attempt: 1,
    failedPhase: null,
    error: null,
    createdAt: '2026-09-07T12:00:00.000Z',
    updatedAt: '2026-09-07T12:01:00.000Z',
    readyAt: null,
    retiredAt: null,
    phases: [{
      phase: 'seeding_conversations', status: 'running', attempt: 1, detail: { confirmed: 3, total: 9 },
      error: null, startedAt: '2026-09-07T12:00:30.000Z', finishedAt: null,
    }],
    seeding: { confirmed: 3, total: 9 },
    ...overrides,
  };
}

describe('the Demos routes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists operations from the regional API with the operator credential', async () => {
    const regional = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({ operations: [operation()] }));
    const response = await worker.fetch!(new Request('https://ace.internal.rallywith.ai/api/demos'), env(), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ operations: [{ operationId: OPERATION_ID, status: 'running' }] });
    expect(regional).toHaveBeenCalledWith('https://api.rally.test/internal/demos', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ authorization: 'Bearer operator-token-for-tests' }),
    }));
  });

  it('starts a preparation same-origin only, and relays the regional refusal by its own code', async () => {
    const body = JSON.stringify({ operationId: OPERATION_ID, companyName: 'Alto Capital', presenterUserId: PRESENTER_ID, cast: { priya: PRIYA_ID } });
    const crossOrigin = await worker.fetch!(new Request('https://ace.internal.rallywith.ai/api/demos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    }), env(), context);
    expect(crossOrigin.status).toBe(403);

    const regional = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ error: { code: 'demo_pack_role_unbound', message: 'Nobody is cast as "priya"' } }, { status: 422 }));
    const refused = await worker.fetch!(new Request('https://ace.internal.rallywith.ai/api/demos', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://ace.internal.rallywith.ai' }, body,
    }), env(), context);
    expect(refused.status).toBe(422);
    await expect(refused.json()).resolves.toEqual({ error: 'demo_pack_role_unbound', message: 'Nobody is cast as "priya"' });
    expect(regional).toHaveBeenCalledWith('https://api.rally.test/internal/demos', expect.objectContaining({ method: 'POST', body }));
  });

  it('answers a regional outage as unavailable rather than as an empty page', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const response = await worker.fetch!(new Request('https://ace.internal.rallywith.ai/api/demos'), env(), context);
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: 'regional_api_unavailable' });
  });

  it('refuses to start without the operator credential configured', async () => {
    const regional = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch!(new Request('https://ace.internal.rallywith.ai/api/demos'), env({ RALLY_OPERATOR_TOKEN: '' }), context);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'operator_token_not_configured' });
    expect(regional).not.toHaveBeenCalled();
  });

  it('retries and abandons through the regional API, same-origin', async () => {
    const regional = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json(operation({ attempt: 2 })))
      .mockResolvedValueOnce(Response.json(operation({ status: 'abandoned' })));
    const headers = { Origin: 'https://ace.internal.rallywith.ai' };
    const retried = await worker.fetch!(new Request(`https://ace.internal.rallywith.ai/api/demos/${OPERATION_ID}/retry`, { method: 'POST', headers }), env(), context);
    await expect(retried.json()).resolves.toMatchObject({ attempt: 2 });
    // Abandon retires the candidate, so it is refused until the page names the
    // operation, before the regional API is asked.
    const unconfirmed = await worker.fetch!(new Request(`https://ace.internal.rallywith.ai/api/demos/${OPERATION_ID}/abandon`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ confirmOperationId: WORKSPACE_ID }),
    }), env(), context);
    expect(unconfirmed.status).toBe(409);
    const abandoned = await worker.fetch!(new Request(`https://ace.internal.rallywith.ai/api/demos/${OPERATION_ID}/abandon`, {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ confirmOperationId: OPERATION_ID }),
    }), env(), context);
    await expect(abandoned.json()).resolves.toMatchObject({ status: 'abandoned' });
    expect(regional.mock.calls.map((call) => call[0])).toEqual([
      `https://api.rally.test/internal/demos/${OPERATION_ID}/retry`,
      `https://api.rally.test/internal/demos/${OPERATION_ID}/abandon`,
    ]);
    expect(JSON.parse(String(regional.mock.calls[1]?.[1]?.body))).toEqual({ confirmOperationId: OPERATION_ID });
  });
});
