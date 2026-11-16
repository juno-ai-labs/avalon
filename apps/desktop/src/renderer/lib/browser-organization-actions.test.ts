import '../../../../../tests/isolated-region';
import { afterEach, expect, it, vi } from 'vitest';
import { createOrganization, organizationPath } from '../../../../browser/src/organization-actions';

afterEach(() => { vi.unstubAllGlobals(); });

// HTTP is the boundary here; the route itself is proved against the real
// migrations in `apps/api/test/browser-sessions.test.ts`.
it('creates an organization on Global with the trimmed name and answers where it opens', async () => {
  const sent: Array<{ path: string; body: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    sent.push({ path: input, body: JSON.parse(String(init?.body)) });
    return Response.json({ region: 'global', workspaceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1' }, { status: 201 });
  }));
  const created = await createOrganization('  Acme Research ', '01920000-0000-7000-8000-000000000031');
  expect(sent).toEqual([{ path: '/regional/global/browser/workspace/create',
    body: { name: 'Acme Research', operationId: '01920000-0000-7000-8000-000000000031' } }]);
  expect(organizationPath(created)).toBe('/app/workspaces/global/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1');
});
