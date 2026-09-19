import { describe, expect, it, vi } from 'vitest';
import { startCanvaConnection } from './canva-loopback';

// Real Node HTTP listener, matching Electron main. Only the external provider/API is doubled.
describe('Canva desktop callback', () => {
  it('rejects a foreign state and forwards a valid code only to the authenticated API seam', async () => {
    let callback = '';
    let close = () => {};
    const completions: unknown[] = [];
    try {
      await startCanvaConnection({
        onClose: (value) => { close = value; },
        request: async (path, body) => {
          if (path.includes('/start')) {
            const input = body as { loopbackRedirectUri: string };
            callback = input.loopbackRedirectUri;
            const params = new URLSearchParams({ state: 'expected-state', redirect_uri: callback });
            return { url: `https://mcp.canva.com/authorize?${params}`, attemptId: 'attempt' };
          }
          completions.push(body);
          return { ok: true };
        },
        openExternal: vi.fn(async () => {}),
      });
      const foreign = await fetch(`${callback}?state=foreign&code=secret`);
      expect(foreign.status).toBe(400);
      expect(completions).toEqual([]);
      const valid = await fetch(`${callback}?state=expected-state&code=secret`);
      expect(valid.status).toBe(200);
      expect(await valid.text()).not.toContain('secret');
      expect(completions).toEqual([{ code: 'secret', state: 'expected-state' }]);
    } finally { close(); }
  });
});
