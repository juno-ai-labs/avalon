import "../../../../tests/isolated-region";
import { describe, expect, it, vi } from 'vitest';
import { CredentialRefreshRegistry, credentialRefreshKey } from './credential-refresh';

const identity = { refreshToken: 'identity-refresh-token', binding: { workspaceId: null, region: 'global' } };
const workspace = {
  refreshToken: 'workspace-refresh-token',
  binding: { workspaceId: '00000000-0000-7000-8000-000000000002', region: 'enterprise' },
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe('credential refresh registry', () => {
  it('shares one rotation between requests that present the same refresh token', async () => {
    const registry = new CredentialRefreshRegistry<string>();
    const rotation = deferred<string>();
    const refresh = vi.fn(() => rotation.promise);

    const first = registry.run(identity, refresh);
    const second = registry.run(identity, refresh);
    expect(registry.pending).toBe(1);
    rotation.resolve('rotated-once');

    await expect(first).resolves.toBe('rotated-once');
    await expect(second).resolves.toBe('rotated-once');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(registry.pending).toBe(0);
  });

  it('refreshes again once the shared rotation has settled', async () => {
    const registry = new CredentialRefreshRegistry<string>();
    const refresh = vi.fn()
      .mockResolvedValueOnce('first-rotation')
      .mockResolvedValueOnce('second-rotation');

    await expect(registry.run(identity, refresh)).resolves.toBe('first-rotation');
    await expect(registry.run(identity, refresh)).resolves.toBe('second-rotation');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('keeps distinct tokens and distinct bindings on separate rotations', async () => {
    const registry = new CredentialRefreshRegistry<string>();
    const identityRotation = deferred<string>();
    const workspaceRotation = deferred<string>();
    const replacedIdentity = { ...identity, refreshToken: 'identity-refresh-token-rotated' };
    const replacedRotation = deferred<string>();

    const identityResult = registry.run(identity, () => identityRotation.promise);
    const workspaceResult = registry.run(workspace, () => workspaceRotation.promise);
    const replacedResult = registry.run(replacedIdentity, () => replacedRotation.promise);
    expect(registry.pending).toBe(3);
    identityRotation.resolve('identity');
    workspaceRotation.resolve('workspace');
    replacedRotation.resolve('replaced');

    await expect(identityResult).resolves.toBe('identity');
    await expect(workspaceResult).resolves.toBe('workspace');
    await expect(replacedResult).resolves.toBe('replaced');
    expect(credentialRefreshKey(identity)).not.toBe(credentialRefreshKey(replacedIdentity));
    expect(credentialRefreshKey(workspace)).toBe(`enterprise:${workspace.binding.workspaceId}:${workspace.refreshToken}`);
  });

  it('fails every sharer with the one failure and frees the token for a later attempt', async () => {
    const registry = new CredentialRefreshRegistry<string>();
    const rotation = deferred<string>();
    const first = registry.run(identity, () => rotation.promise);
    const second = registry.run(identity, () => rotation.promise);
    const failure = new Error('The refresh token is invalid or expired');
    rotation.reject(failure);

    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(registry.pending).toBe(0);
    await expect(registry.run(identity, async () => 'recovered')).resolves.toBe('recovered');
  });
});
