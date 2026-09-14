import "../../../tests/isolated-region";
import { AshbyEventTypes, AshbyEventLabels, asWorkspaceId } from '@rally/contracts';
import { describe, expect, it } from 'vitest';
import { createAshbyConnector, verifyAshbyWebhook, AshbyCapabilities } from './ashby';
import { ConnectorRegistry } from './index';
import { authorizedConnection, type ConnectorConnectionContext } from './types';
import { neverAborts } from './test-signals';

const workspaceId = asWorkspaceId('22222222-2222-4222-8222-222222222222');
const redirectUri = 'https://api.example.test/connections/ashby/callback';
function connection(scope: 'personal' | 'workspace' = 'personal') {
  return authorizedConnection({ id: '11111111-1111-4111-8111-111111111111', workspaceId, scope,
    ownerUserId: scope === 'personal' ? '33333333-3333-4333-8333-333333333333' : null,
    grantedScopes: [scope === 'personal' ? AshbyCapabilities.personalMcp : AshbyCapabilities.workspaceEvents],
    credentials: scope === 'personal' ? { accessToken: 'test-access-token' } : { apiKey: 'test-workspace-key' },
    config: { selectedEvents: ['applicationSubmit', 'candidateStageChange'] }, cursor: {} } satisfies ConnectorConnectionContext);
}
async function signature(body: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

describe('Ashby protocol', () => {
  it('registers the documented operational triggers and personal dynamic tools', () => {
    const adapter = new ConnectorRegistry([createAshbyConnector({ redirectUri })]).get('ashby');
    expect(adapter.manifest.tools).toEqual([]);
    expect(adapter.manifest.activityTypes).toEqual([...AshbyEventTypes]);
    expect(adapter.manifest.activityTypes).toHaveLength(27);
    expect(adapter.manifest.activityTypes).not.toContain('ping');
    expect(adapter.dynamicAgentTools?.connectionScopes).toEqual(['personal']);
    expect(adapter.installationManagement?.support.rotate).toBe('manual');
  });

  it('discovers actual MCP tools conservatively without contacting workspace REST management', async () => {
    const calls: string[] = [];
    const adapter = createAshbyConnector({ redirectUri, fetch: async (url, init) => {
      expect(String(url)).toBe('https://mcp.ashbyhq.com/mcp/v1');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-access-token');
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      const request = JSON.parse(String(init?.body)); calls.push(request.method);
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: '2.0', id: request.id, result: request.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {} }
        : { tools: [{ name: 'provider_supplied_operation', description: 'Untrusted provider content', inputSchema: { type: 'object', properties: { lookup: { type: 'string' } } } }] } });
    } });
    const tools = await adapter.dynamicAgentTools!.discover(connection(), neverAborts());
    expect(tools.map((tool) => tool.name)).toEqual(['provider_supplied_operation']);
    expect(tools[0]?.mode).toBe('write');
    expect(calls).toContain('tools/list');
    await expect(adapter.dynamicAgentTools!.discover(connection('workspace'), neverAborts())).rejects.toMatchObject({ code: 'unsupported_capability' });
  });

  it.each(['https://api.rallywith.ai', 'https://enterprise.api.rallywith.ai'])('uses discovered OAuth metadata and rotates a personal grant for %s without webhook calls', async (origin) => {
    const redirect = `${origin}/connections/ashby/callback`;
    const calls: URL[] = [];
    const adapter = createAshbyConnector({ redirectUri: redirect, fetch: async (input, init) => {
      const url = new URL(String(input)); calls.push(url);
      if (url.pathname.includes('oauth-protected-resource')) return Response.json({ resource: 'https://mcp.ashbyhq.com/mcp/v1', authorization_servers: ['https://mcp-auth.ashbyhq.com/oidc'], scopes_supported: ['openid', 'mcp', 'offline_access'] });
      if (url.pathname.includes('oauth-authorization-server')) return Response.json({
        issuer: 'https://mcp-auth.ashbyhq.com/oidc', authorization_endpoint: 'https://mcp-auth.ashbyhq.com/oidc/auth',
        token_endpoint: 'https://mcp-auth.ashbyhq.com/oidc/token', registration_endpoint: 'https://mcp-auth.ashbyhq.com/oidc/reg',
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
      });
      if (url.pathname === '/oidc/reg') {
        expect(JSON.parse(String(init?.body))).toMatchObject({ redirect_uris: [redirect], token_endpoint_auth_method: 'client_secret_post' });
        return Response.json({ client_id: 'fixture-registered-client', client_secret: 'fixture-registration-secret', token_endpoint_auth_method: 'client_secret_post' });
      }
      expect(url.pathname).toBe('/oidc/token');
      const form = new URLSearchParams(String(init?.body));
      expect(form.get('resource')).toBe('https://mcp.ashbyhq.com/mcp/v1');
      if (form.get('grant_type') === 'authorization_code') {
        expect(form.get('redirect_uri')).toBe(redirect);
        expect(form.get('code_verifier')).toBe('fixture-pkce-verifier');
        return Response.json({ access_token: 'fixture-first-access', refresh_token: 'fixture-first-refresh', token_type: 'Bearer', expires_in: 3600 });
      }
      expect(form.get('refresh_token')).toBe('fixture-first-refresh');
      return Response.json({ access_token: 'fixture-next-access', refresh_token: 'fixture-next-refresh', token_type: 'Bearer', expires_in: 3600 });
    } });
    const started = await adapter.beginAuthorization!({ state: 'fixture-state', codeChallenge: 'fixture-challenge', connectionScope: 'personal' });
    expect(new URL(started.url).searchParams.get('state')).toBe('fixture-state');
    const credentials = await adapter.handleAuthorizationCallback!({ connectionScope: 'personal', authorizationState: started.state, code: 'fixture-code', codeVerifier: 'fixture-pkce-verifier' });
    expect(credentials).toMatchObject({ accessToken: 'fixture-first-access', providerAccountName: 'personal' });
    const personal = connection(); personal.credentials = credentials;
    expect(await adapter.refreshCredentials!(personal, neverAborts())).toMatchObject({ accessToken: 'fixture-next-access', refreshToken: 'fixture-next-refresh' });
    expect(calls.every((url) => url.hostname !== 'api.ashbyhq.com')).toBe(true);
    await expect(adapter.beginAuthorization!({ connectionScope: 'workspace' })).rejects.toMatchObject({ code: 'invalid_configuration' });
  });

  it('validates workspace authority without mutating webhook state during automatic health checks', async () => {
    const paths: string[] = [];
    const adapter = createAshbyConnector({ redirectUri, fetch: async (url, init) => {
      paths.push(new URL(String(url)).pathname);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Basic ${btoa('test-workspace-key:')}`);
      return Response.json({ success: true, results: {} });
    } });
    expect((await adapter.healthCheck(connection('workspace'), neverAborts())).ok).toBe(true);
    expect(paths).toEqual(['/apiKey.info']);
  });

  it('authenticates raw body bytes and signed pings before trusting JSON or accepting events', async () => {
    const raw = JSON.stringify({ action: 'ping', data: { webhookActionType: 'ping' } });
    expect((await verifyAshbyWebhook(raw, await signature(raw, 'key'), 'key')).action).toBe('ping');
    await expect(verifyAshbyWebhook(`${raw} `, await signature(raw, 'key'), 'key')).rejects.toMatchObject({ code: 'invalid_signature' });
    await expect(verifyAshbyWebhook(raw, await signature(raw, 'other'), 'key')).rejects.toMatchObject({ code: 'invalid_signature' });
    await expect(verifyAshbyWebhook(raw, null, 'key')).rejects.toMatchObject({ code: 'invalid_signature' });
    await expect(verifyAshbyWebhook('{', await signature('{', 'key'), 'key')).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('normalizes stable application identity and first observation without copying confidential candidate fields', async () => {
    const adapter = createAshbyConnector({ redirectUri });
    const rawBody = JSON.stringify({ action: 'applicationSubmit', webhookActionId: 'provider-action', data: { application: { id: 'application-id', candidate: { id: 'candidate-id', name: 'Private name', email: 'private@example.test' }, job: { id: 'job-id', title: 'Confidential role' } } } });
    const verified = await adapter.webhookActivity!.verify({ rawBody, receivedAt: new Date().toISOString(), now: Date.now(), headers: new Headers({ 'Ashby-Signature': await signature(rawBody, 'secret') }), verificationSecret: 'secret', maxBytes: rawBody.length * 4 });
    const activity = adapter.webhookActivity!.normalize(connection('workspace'), { ...verified, event: { ...verified.event as object, observedAt: '2026-09-12T12:00:00.000Z' } }, 'regional-payload-reference');
    expect(activity).toMatchObject({ providerEventId: 'provider-action', providerResourceId: 'application-id', occurredAt: '2026-09-12T12:00:00.000Z', metadata: { candidateId: 'candidate-id', jobId: 'job-id', timestampMeaning: 'first_observed' } });
    expect(JSON.stringify(activity)).not.toContain('Private name');
    expect(JSON.stringify(activity)).not.toContain('private@example.test');
    expect(JSON.stringify(activity)).not.toContain('Confidential role');
  });
  it.each(AshbyEventTypes)('normalizes the %s notification without promoting raw provider content', async (eventType) => {
    const adapter = createAshbyConnector({ redirectUri });
    const workspace = connection('workspace');
    workspace.config.selectedEvents = [...AshbyEventTypes];
    const rawBody = JSON.stringify({ action: eventType, webhookActionId: 'provider-action',
      data: { candidate: { id: 'candidate-id', name: 'Confidential candidate' }, watermark: 'opaque-delivery-watermark' } });
    const verified = await adapter.webhookActivity!.verify({ rawBody, receivedAt: '2026-09-12T12:00:00.000Z', now: Date.now(), headers: new Headers({ 'Ashby-Signature': await signature(rawBody, 'secret') }), verificationSecret: 'secret', maxBytes: rawBody.length * 4 });
    const activity = adapter.webhookActivity!.normalize(workspace, { ...verified, event: { ...verified.event as object, observedAt: '2026-09-12T12:00:00.000Z' } }, 'regional-payload-reference');
    expect(activity).toMatchObject({ eventType, title: AshbyEventLabels[eventType], providerEventId: 'provider-action', payloadRef: 'regional-payload-reference', visibility: { kind: "workspace" } });
    expect(JSON.stringify(activity)).not.toContain('Confidential candidate');
    expect(JSON.stringify(activity)).not.toContain('opaque-delivery-watermark');
  });

});
