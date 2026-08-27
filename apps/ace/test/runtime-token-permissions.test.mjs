import { describe, expect, it, vi } from 'vitest';
import { verifyRuntimeQueuePermissions } from '../scripts/runtime-token-permissions.mjs';

function cloudflare(result, init) {
  return Response.json({ success: true, result }, init);
}

describe('Ace runtime token permission check', () => {
  it('dynamically selects a provisioned Queue and proves the token can peek it', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(cloudflare([{ queue_id: 'queue/id', queue_name: 'any-live-queue' }]))
      .mockResolvedValueOnce(cloudflare({ messages: [] }));

    await verifyRuntimeQueuePermissions({ accountId: 'account', token: 'runtime-secret', fetchImpl });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.cloudflare.com/client/v4/accounts/account/queues?per_page=1',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer runtime-secret' }) }),
    );
    expect(fetchImpl).toHaveBeenNthCalledWith(
      2,
      'https://api.cloudflare.com/client/v4/accounts/account/queues/queue%2Fid/messages/peek',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('fails deployment when the runtime token cannot peek Queue messages', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(cloudflare([{ queue_id: 'queue-id' }]))
      .mockResolvedValueOnce(Response.json({
        success: false,
        errors: [{ message: 'forbidden' }],
      }, { status: 403 }));

    await expect(verifyRuntimeQueuePermissions({ accountId: 'account', token: 'flagship-only', fetchImpl }))
      .rejects.toThrow('Queue permission check failed (403): forbidden');
  });
});
