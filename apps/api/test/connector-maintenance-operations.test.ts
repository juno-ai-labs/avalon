import "../../../tests/isolated-region";
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { ConnectorMaintenanceOperationSchema } from '../src/services/connector-maintenance-service';
import { createTestEnv } from './helpers/cloudflare-test';
import { migratedSqliteDatabase, sqliteD1 } from './helpers/sqlite-d1';

const operatorId = '00000000-0000-4000-8000-000000000001';
const ace = 'fixture-ace-operator-token-0123456789abcdef';
const support = 'fixture-support-token-0123456789abcdef0123';
const misplaced = 'fixture-misplaced-token-0123456789abcdef0123';

describe('connector maintenance operator boundary', () => {
  it('accepts only the existing Ace credential and demos role, saving a regional preview without provider I/O', async () => {
    const database = migratedSqliteDatabase();
    const provider = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Preview cannot contact providers'));
    try {
      const env = createTestEnv({ DB: sqliteD1(database), AVALON_REGION: 'global', LOG_LEVEL: 'error',
        PUBLIC_API_BASE_URL: 'https://api.example.test', ALLOWED_ORIGINS: 'app://avalon',
        DEMO_OPERATORS_JSON: JSON.stringify({ [ace]: { operatorId, role: 'demos' }, [misplaced]: { operatorId, role: 'support' } }),
        TELEMETRY_OPERATORS_JSON: JSON.stringify({ [support]: { operatorId, role: 'security' } }),
      });
      const app = createApp();
      const preview = (token: string | null, body: object = { provider: 'ashby', region: 'global', version: 1 }) => app.request('/internal/connector-maintenance/preview', {
        method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
      }, env);
      expect((await preview(null)).status).toBe(401);
      expect((await preview(support)).status).toBe(401);
      expect((await preview(misplaced)).status).toBe(403);
      expect((await preview(ace, { provider: 'ashby', region: 'enterprise', version: 1 })).status).toBe(409);
      expect((await preview(ace, { provider: 'ashby', region: 'global', version: 1, destination: 'https://unapproved.example.test' })).status).toBe(400);
      const accepted = await preview(ace);
      expect(accepted.status).toBe(200);
      const operation = ConnectorMaintenanceOperationSchema.parse(await accepted.json());
      expect(operation).toMatchObject({ state: 'preview', operatorId, targets: [] });
      expect(database.prepare('SELECT id FROM connector_maintenance_operations').all()).toEqual([{ id: operation.id }]);
      expect((await app.request(`/internal/connector-maintenance/${operation.id}`, {}, env)).status).toBe(401);
      expect(provider).not.toHaveBeenCalled();
    } finally { provider.mockRestore(); database.close(); }
  });
});
