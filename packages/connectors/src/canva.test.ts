import { asUserId } from '@rally/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createCanvaConnector } from './canva';
import { normalizeHostedMcpRedirect } from './hosted-mcp';
import { createCanvaPolling } from './canva-polling';
import { authorizedConnection, pollCheckpointedActivityStreams } from './types';
import { neverAborts } from './test-signals';
import type { FetchLike } from './provider-utils';

function connection() {
  return authorizedConnection({ id: 'connection', workspaceId: 'workspace', ownerUserId: 'owner',
    scope: 'personal', grantedScopes: ['canva.personal.mcp'], credentials: {}, cursor: {},
    config: { region: 'global', canvaWatch: { watchId: 'watch', designId: 'design' } } });
}

describe('Canva', () => {
  it('allows only the explicit native callback exception', () => {
    expect(normalizeHostedMcpRedirect('http://127.0.0.1:4321/callback', true)).toBe('http://127.0.0.1:4321/callback');
    for (const url of ['http://127.0.0.1:4321/callback', 'http://localhost:4321/callback', 'http://evil.test/callback',
      'http://127.0.0.1:4321/other', 'http://user@127.0.0.1:4321/callback', 'http://127.0.0.1:4321/callback?next=evil']) {
      expect(() => normalizeHostedMcpRedirect(url)).toThrow();
      if (url !== 'http://127.0.0.1:4321/callback') expect(() => normalizeHostedMcpRedirect(url, true)).toThrow();
    }
  });
  it('registers, exchanges and refreshes with the same resource and backend client credentials', async () => {
    const tokenBodies: URLSearchParams[] = [];
    const fetcher: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.includes('oauth-protected-resource')) {
        expect(url).toBe('https://mcp.canva.com/.well-known/oauth-protected-resource');
        return Response.json({ resource: 'https://mcp.canva.com', authorization_servers: ['https://mcp.canva.com'] });
      }
      if (url.includes('oauth-authorization-server')) return Response.json({ authorization_endpoint: 'https://mcp.canva.com/authorize', token_endpoint: 'https://mcp.canva.com/token', registration_endpoint: 'https://mcp.canva.com/register', revocation_endpoint: 'https://mcp.canva.com/token', code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'] });
      if (url.endsWith('/register')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ redirect_uris: ['http://127.0.0.1:4321/callback'], grant_types: ['authorization_code', 'refresh_token'] });
        return Response.json({ client_id: 'client', client_secret: 'secret', token_endpoint_auth_method: 'client_secret_post' });
      }
      if (url.endsWith('/token')) {
        tokenBodies.push(new URLSearchParams(String(init?.body)));
        if (tokenBodies.at(-1)?.has('token')) return new Response(null, { status: 200 });
        return Response.json({ access_token: 'access', refresh_token: tokenBodies.length === 1 ? 'refresh' : 'rotated', expires_in: 14400 });
      }
      throw new Error(`Unexpected request ${url}`);
    };
    const adapter = createCanvaConnector({ redirectUri: 'https://api.rallywith.ai/connections/canva/callback', allowLoopbackRedirect: true, fetch: fetcher });
    const start = await adapter.beginAuthorization!({ connectionScope: 'personal', state: 'state', codeChallenge: 'challenge', redirectUri: 'http://127.0.0.1:4321/callback' });
    expect(new URL(start.url).searchParams.get('resource')).toBe('https://mcp.canva.com');
    const credentials = await adapter.handleAuthorizationCallback!({ connectionScope: 'personal', authorizationState: start.state, code: 'code', codeVerifier: 'verifier' });
    const conn = connection(); conn.credentials = credentials;
    const refreshed = await adapter.refreshCredentials!(conn, neverAborts());
    expect(refreshed.refreshToken).toBe('rotated');
    conn.credentials = refreshed;
    await adapter.revoke!(conn, neverAborts());
    expect(Object.fromEntries(tokenBodies[2]!)).toMatchObject({ token: 'rotated', token_type_hint: 'refresh_token', client_secret: 'secret' });
    expect(Object.fromEntries(tokenBodies[0]!)).toMatchObject({ code: 'code', code_verifier: 'verifier', client_secret: 'secret', redirect_uri: 'http://127.0.0.1:4321/callback' });
    expect(Object.fromEntries(tokenBodies[1]!)).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh', client_secret: 'secret' });
  });
  it('records the editing transaction identity and replaces conversation-bearing user intent', async () => {
    const calls: unknown[] = [];
    const adapter = createCanvaConnector({ redirectUri: 'https://api.rallywith.ai/connections/canva/callback',
      fetch: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        if (!request.id) return new Response(null, { status: 202 });
        if (request.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18' } });
        if (request.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'start-editing-transaction', inputSchema: { type: 'object' } }] } });
        calls.push(request.params);
        return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ transaction: { transaction_id: 'transaction' } }) }] } });
      },
    });
    const conn = connection(); conn.credentials = { accessToken: 'fixture-token' };
    const result = await adapter.executeTool('start-editing-transaction', { design_id: 'design', user_intent: 'Unrelated confidential conversation' }, {
      connection: conn, principal: { type: 'user', userId: asUserId('owner') }, signal: neverAborts(),
    });
    expect(result.providerOperationId).toBe('transaction');
    expect(calls).toEqual([{ name: 'start-editing-transaction', arguments: { design_id: 'design', user_intent: 'Use Canva to start editing transaction.' } }]);
  });
  it('does no polling without an explicitly selected watch', async () => {
    const call = vi.fn(); const conn = connection(); conn.config = {};
    const result = await pollCheckpointedActivityStreams(createCanvaPolling(call), conn, neverAborts());
    expect(result.activities).toEqual([]); expect(call).not.toHaveBeenCalled();
  });
  it('baselines all thread and reply pages, then finds a reply on an old thread without a timestamp change', async () => {
    let scan = 0;
    const source = createCanvaPolling(async (_conn, name, args) => {
      if (name === 'get-design') return { design: { id: 'design', title: 'Deck', updated_at: 10 } };
      if (name === 'list-comments') return args.continuation
        ? { items: [] }
        : { items: [{ id: 'thread', created_at: 1 }], continuation: 'last-empty-page' };
      return { items: [{ id: 'old', created_at: 2 }, ...(scan ? [{ id: 'new', created_at: 3 }] : [])] };
    });
    const conn = connection();
    for (let page = 0; page < 3; page++) {
      const result = await pollCheckpointedActivityStreams(source, conn, neverAborts());
      expect(result.activities).toEqual([]); conn.cursor = result.cursor;
    }
    scan++;
    const delivered = [];
    for (let page = 0; page < 3; page++) {
      const result = await pollCheckpointedActivityStreams(source, conn, neverAborts());
      delivered.push(...result.activities); conn.cursor = result.cursor;
    }
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ eventType: 'design.commented', metadata: { threadId: 'thread', replyId: 'new' }, targetUserIds: ['owner'] });
    for (let page = 0; page < 3; page++) {
      const result = await pollCheckpointedActivityStreams(source, conn, neverAborts());
      expect(result.activities).toEqual([]); conn.cursor = result.cursor;
    }
  });
  it('preserves a failed discussion checkpoint while advancing a changed design', async () => {
    const conn = connection(); conn.cursor = { activityStreams: { 'watch:design': { highWatermark: { updatedAt: 10 } }, 'watch:discussion': { highWatermark: { baselineComplete: true, known: ['thread:old'] } } } };
    const source = createCanvaPolling(async (_conn, name) => {
      if (name === 'get-design') return { design: { id: 'design', title: 'Deck', updated_at: 11 } };
      throw new Error('provider unavailable');
    });
    const result = await pollCheckpointedActivityStreams(source, conn, neverAborts());
    expect(result.activities).toHaveLength(1);
    expect(result.cursor).toMatchObject({ activityStreams: { 'watch:design': { highWatermark: { updatedAt: 11 } }, 'watch:discussion': { highWatermark: { known: ['thread:old'] } } } });
    expect(result.streamErrors?.[0]?.streamId).toBe('watch:discussion');
  });
});
