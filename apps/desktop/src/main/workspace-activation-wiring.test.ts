import { describe, expect, it, vi } from 'vitest';
import { RallyApiResponseError } from './api-response-error';
import { revalidateWorkspaceActivation } from './workspace-activation';

const target = {
  region: 'global' as const,
  workspaceId: '00000000-0000-7000-8000-000000000001',
};

describe('workspace activation authorization', () => {
  it('requests the control plane on every explicit activation, including the current workspace', async () => {
    const request = vi.fn(async () => ({ workspace: target.workspaceId }));
    const dependencies = {
      nextSelectionIntent: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(11),
      request,
    };

    await revalidateWorkspaceActivation(target, undefined, dependencies);
    await revalidateWorkspaceActivation(target, undefined, dependencies);

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, {
      body: target,
      expectedRegion: 'global',
      expectedWorkspaceId: target.workspaceId,
      operationId: undefined,
      path: '/onboarding/workspace/activate',
      selectionIntent: 11,
    });
  });

  it('finishes the change and emits a stable denial when revalidation refuses membership', async () => {

    await expect(revalidateWorkspaceActivation(target, undefined, {
      nextSelectionIntent: () => 12,
      request: async () => {
        throw new RallyApiResponseError('mutable service prose', 403, 'workspace_access_denied');
      },
    })).rejects.toThrow('rally-workspace-activation:workspace_access_denied');
  });
});
