import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/env';
import { createTestEnv } from './helpers/cloudflare-test';

/**
 * Ace relays; it does not decide. The retirement route asks the regional API
 * that owns the workspace with that region's operator token and hands back
 * what it answered, parsed with the shared contract — and it refuses, before
 * the regional API is even asked, a confirmation that names another
 * workspace. Writes are same-origin.
 */

const WORKSPACE_ID = '00000000-0000-7000-8000-0000000000f1';
const OTHER_ID = '00000000-0000-7000-8000-0000000000e2';

function env(overrides: Partial<Env> = {}): Env {
  return createTestEnv({
    APP_ENV: 'development',
    ACE_DEV_AUTH: 'true',
    APP_VERSION: 'test',
    ASSETS: { fetch: vi.fn(async () => new Response('asset')) },
    RALLY_API_BASE_URL: 'https://api.rally.test',
    RALLY_EU_API_BASE_URL: 'https://eu.api.rally.test',
    RALLY_OPERATOR_TOKEN: 'operator-token-for-tests',
    RALLY_EU_OPERATOR_TOKEN: 'eu-operator-token-for-tests',
    ...overrides,
  });
}

const context = { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
const headers = { 'Content-Type': 'application/json', Origin: 'https://ace.internal.rallywith.ai' };

describe('the retirement route', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts the write from the Ace page only', async () => {
    const regional = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch!(new Request(`https://ace.internal.rallywith.ai/api/workspaces/${WORKSPACE_ID}/retire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: 'global', confirmWorkspaceId: WORKSPACE_ID }),
    }), env(), context);
    expect(response.status).toBe(403);
    expect(regional).not.toHaveBeenCalled();
  });

  it('refuses a confirmation that names another workspace before asking the region', async () => {
    const regional = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch!(new Request(`https://ace.internal.rallywith.ai/api/workspaces/${WORKSPACE_ID}/retire`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ region: 'global', confirmWorkspaceId: OTHER_ID }),
    }), env(), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'workspace_retirement_unconfirmed' });
    expect(regional).not.toHaveBeenCalled();
  });

  it('retires in the region that owns the workspace, with that region\'s token, carrying the confirmation', async () => {
    const receipt = { workspaceId: WORKSPACE_ID, complete: true, remaining: 0, retiredParents: 2, retiredChildren: 2, retainedOutbox: 0, failed: [] };
    const regional = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json(receipt));
    const response = await worker.fetch!(new Request(`https://ace.internal.rallywith.ai/api/workspaces/${WORKSPACE_ID}/retire`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ region: 'eu', confirmWorkspaceId: WORKSPACE_ID }),
    }), env(), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(receipt);
    expect(regional).toHaveBeenCalledWith(`https://eu.api.rally.test/internal/workspaces/${WORKSPACE_ID}/retire`, expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer eu-operator-token-for-tests' }),
      body: JSON.stringify({ confirmWorkspaceId: WORKSPACE_ID }),
    }));
  });

  it('relays a regional refusal by its own code, and an outage as unavailable', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ error: { code: 'workspace_not_found', message: 'No workspace with this id in this region' } }, { status: 404 }))
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const request = () => new Request(`https://ace.internal.rallywith.ai/api/workspaces/${WORKSPACE_ID}/retire`, {
      method: 'POST', headers, body: JSON.stringify({ region: 'global', confirmWorkspaceId: WORKSPACE_ID }),
    });
    const refused = await worker.fetch!(request(), env(), context);
    expect(refused.status).toBe(404);
    await expect(refused.json()).resolves.toEqual({ error: 'workspace_not_found', message: 'No workspace with this id in this region' });
    const outage = await worker.fetch!(request(), env(), context);
    expect(outage.status).toBe(502);
    await expect(outage.json()).resolves.toMatchObject({ error: 'regional_api_unavailable' });
  });

  it('refuses before asking when the operator credential is not configured', async () => {
    const regional = vi.spyOn(globalThis, 'fetch');
    const response = await worker.fetch!(new Request(`https://ace.internal.rallywith.ai/api/workspaces/${WORKSPACE_ID}/retire`, {
      method: 'POST', headers, body: JSON.stringify({ region: 'global', confirmWorkspaceId: WORKSPACE_ID }),
    }), env({ RALLY_OPERATOR_TOKEN: '' }), context);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: 'operator_token_not_configured' });
    expect(regional).not.toHaveBeenCalled();
  });
});
