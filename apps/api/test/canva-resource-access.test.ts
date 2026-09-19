import { describe, expect, it } from 'vitest';
import { createTestEnv } from './helpers/cloudflare-test';
import { protectCanvaReference, readCanvaReference } from '../src/services/canva-resource-access';

describe('Canva protected resource access', () => {
  it('retains a share credential only in encrypted storage bound to its workspace, connection and design', async () => {
    const env = createTestEnv({ CONNECTOR_CREDENTIALS_KEY: 'test-key', CONNECTOR_CREDENTIALS_KEY_VERSION: '1' });
    const url = 'https://www.canva.com/design/design/link-access-token/view?utm_content=design';
    const stored = await protectCanvaReference(env, 'workspace', 'connection', url);
    expect(stored.canonicalUrl).toBe('https://www.canva.com/design/design/view');
    expect(JSON.stringify(stored)).not.toContain('link-access-token');
    await expect(readCanvaReference(env, 'workspace', 'connection', 'design', stored.protectedAccessJson)).resolves.toBe(url);
    await expect(readCanvaReference(env, 'other', 'connection', 'design', stored.protectedAccessJson)).rejects.toThrow();
    await expect(readCanvaReference(env, 'workspace', 'other', 'design', stored.protectedAccessJson)).rejects.toThrow();
    await expect(readCanvaReference(env, 'workspace', 'connection', 'other', stored.protectedAccessJson)).rejects.toThrow();
  });
});
