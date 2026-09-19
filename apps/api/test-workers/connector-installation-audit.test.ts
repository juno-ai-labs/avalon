/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { asUserId, asWorkspaceId, ConnectorInstallationSchema } from '@rally/contracts';
import type { WorkspaceDO } from '../src/durable-objects/workspace-do';
import { workspaceDOName } from '../src/durable-objects/names';
import { encryptString } from '../src/lib/crypto';
import { connectorMaintenanceOperatorRoutes } from '../src/routes/connector-maintenance-operations';
import { ConnectionService } from '../src/services/connection-service';
import { ConnectorMaintenanceOperationSchema } from '../src/services/connector-maintenance-service';
import { seedWorkspaceControlPlane } from './helpers/substream-fixture';

beforeEach(async () => { await reset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('connector administrative audit', () => {
  it('records the current authenticated operator for apply, resume and cancel independently of the preview author', async () => {
    await env.DB.batch([
      env.DB.prepare('CREATE TABLE connector_maintenance_operations (id TEXT PRIMARY KEY, document_json TEXT NOT NULL CHECK (json_valid(document_json)))'),
      env.DB.prepare(`CREATE TABLE connector_ingress_routes (connection_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL, region TEXT NOT NULL, connector_type TEXT NOT NULL,
        scope TEXT NOT NULL, status TEXT NOT NULL)`),
    ]);
    const principals = Array.from({ length: 4 }, () => ({ operatorId: crypto.randomUUID(), token: crypto.randomUUID() }));
    const testEnv = { ...env, LOG_LEVEL: 'info' as const, DEMO_OPERATORS_JSON: JSON.stringify(Object.fromEntries(
      principals.map(({ token, operatorId }) => [token, { operatorId, role: 'demos' }]),
    )) };
    const logs = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const previewResponse = await connectorMaintenanceOperatorRoutes.request('/preview', {
      method: 'POST', headers: { authorization: `Bearer ${principals[0]!.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'ashby', region: env.AVALON_REGION, version: 1 }),
    }, testEnv);
    expect(previewResponse.status).toBe(200);
    const preview = ConnectorMaintenanceOperationSchema.parse(await previewResponse.json());
    expect(preview.operatorId).toBe(principals[0]!.operatorId);
    for (const [index, action] of ['apply', 'resume', 'cancel'].entries()) {
      const response = await connectorMaintenanceOperatorRoutes.request(`/${preview.id}/${action}`, {
        method: 'POST', headers: { authorization: `Bearer ${principals[index + 1]!.token}` },
      }, testEnv);
      expect(response.status).toBe(200);
    }
    const AuditSchema = z.object({ event: z.literal('connector_maintenance_action_requested'),
      operation_id: z.string().uuid(), operator_id: z.string().uuid(), action: z.enum(['apply', 'resume', 'cancel']) });
    const records = logs.mock.calls.flatMap(([entry]) => {
      const parsed = AuditSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
    expect(records).toEqual(['apply', 'resume', 'cancel'].map((action, index) => ({
      event: 'connector_maintenance_action_requested', operation_id: preview.id,
      operator_id: principals[index + 1]!.operatorId, action,
    })));
    for (const principal of principals) expect(JSON.stringify(logs.mock.calls)).not.toContain(principal.token);
  });

  it('records the administrator who requests Test repair rather than the original installer', async () => {
    const workspaceId = asWorkspaceId(crypto.randomUUID());
    const installerId = asUserId(crypto.randomUUID());
    const actingAdmin = asUserId(crypto.randomUUID());
    const sessionId = crypto.randomUUID();
    await seedWorkspaceControlPlane(env.DB, { workspaceId, userId: actingAdmin, sessionId });
    await env.DB.prepare("UPDATE workspace_members SET role = 'admin' WHERE workspace_id = ? AND user_id = ?")
      .bind(workspaceId, actingAdmin).run();
    const connectionId = crypto.randomUUID();
    const providerId = crypto.randomUUID();
    const key = 'test-repair-audit-envelope-key';
    const stub = env.WORKSPACE_DOS.getByName(workspaceDOName(env.AVALON_REGION, workspaceId));
    await runInDurableObject(stub, (_instance: WorkspaceDO, state) => {
      state.storage.sql.exec(`INSERT INTO workspace_identity
        (id, workspace_id, region, placement_affinity, created_at, updated_at)
        VALUES (1, ?, ?, 'wnam', ?, ?)`, workspaceId, env.AVALON_REGION, Date.now(), Date.now());
    });
    const at = new Date().toISOString();
    const destination = `https://ashby.rallywith.ai/ingest/ashby/${connectionId}`;
    await stub.createConnectorInstallation({
      installation: ConnectorInstallationSchema.parse({
        workspaceId, connectionId, provider: 'ashby', attemptId: crypto.randomUUID(), generation: 1,
        desiredVersion: 1, appliedVersion: 1, state: 'current', selectedEvents: ['applicationSubmit'],
        createdAt: at, updatedAt: at, lastReceivedAt: null, error: null,
        registrations: [{ key: 'applicationSubmit', events: ['applicationSubmit'], providerId,
          destination, enabled: true, state: 'current', action: 'inspect', stepId: crypto.randomUUID(),
          verifiedAt: at, error: null, rotation: 'stable', rotationGeneration: 0,
          activeSecretRef: 'signing', pendingSecretRef: null }],
      }),
      userId: installerId, inputHash: 'audit-fixture',
      credentials: { ...await encryptString(JSON.stringify({ apiKey: 'fixture-api-key', signing: 'fixture-signing-secret' }), key, connectionId), keyVersion: 1 },
      capability: 'ashby.workspace.events', displayName: 'Ashby workspace events',
    });
    const provider = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== 'https://api.ashbyhq.com' || !['/webhook.info', '/apiKey.info'].includes(url.pathname)) {
        throw new Error('Test may only inspect the existing Ashby registration and API key');
      }
      return Response.json({ success: true, results: url.pathname === '/webhook.info'
        ? { id: providerId, enabled: true, requestUrl: destination, webhookType: 'applicationSubmit' } : {} });
    });
    vi.stubGlobal('fetch', provider);
    const service = new ConnectionService({ ...env, CONNECTOR_CREDENTIALS_KEY: key, CONNECTOR_CREDENTIALS_KEY_VERSION: '1' },
      { workspaceId, userId: actingAdmin, role: 'admin', sessionId, region: env.AVALON_REGION });
    expect(await service.test(connectionId)).toMatchObject({ ok: true });
    const audits = await vi.waitFor(async () => {
      const audits = (await env.AUDIT_DB.prepare(
      "SELECT actor_user_id, action, target_id, metadata_json FROM audit_events WHERE workspace_id = ? AND action = 'connector.installation.repair'",
      ).bind(workspaceId).all<{ actor_user_id: string; action: string; target_id: string; metadata_json: string }>()).results;
      expect(audits).toHaveLength(1);
      return audits;
    });
    expect(audits[0]).toMatchObject({ actor_user_id: actingAdmin, action: 'connector.installation.repair', target_id: connectionId });
    expect(JSON.parse(audits[0]!.metadata_json)).toMatchObject({ provider: 'ashby', generation: 2 });
    expect(JSON.stringify(audits)).not.toContain('fixture-api-key');
    expect(JSON.stringify(audits)).not.toContain('fixture-signing-secret');
    expect(provider.mock.calls.some(([input]) => String(input).endsWith('/webhook.info'))).toBe(true);
  });
});
