import { describe, expect, it } from 'vitest';
import { WorkspaceChangeGuard } from './workspace-change-guard';

describe('WorkspaceChangeGuard', () => {
  it('blocks leaving a workspace while any meeting window records against it', () => {
    const guard = new WorkspaceChangeGuard();
    guard.recordingChanged(41, 'workspace-a', true);

    expect(guard.blocksChangeFrom('workspace-a', 'workspace-b')).toBe(true);
    expect(guard.blocksChangeFrom('workspace-a', undefined)).toBe(true);
  });

  it('allows reselecting the active workspace and changes from unrelated workspaces', () => {
    const guard = new WorkspaceChangeGuard();
    guard.recordingChanged(41, 'workspace-a', true);

    expect(guard.blocksChangeFrom('workspace-a', 'workspace-a')).toBe(false);
    expect(guard.blocksChangeFrom('workspace-b', 'workspace-c')).toBe(false);
  });

  it('blocks switching to a same-id workspace in another region', () => {
    const guard = new WorkspaceChangeGuard();
    guard.recordingChanged(41, 'global:workspace-a', true);

    expect(guard.blocksChangeFrom('global:workspace-a', 'eu:workspace-a')).toBe(true);
  });

  it('releases the guard when recording stops or its meeting window closes', () => {
    const guard = new WorkspaceChangeGuard();
    guard.recordingChanged(41, 'workspace-a', true);
    guard.recordingChanged(41, 'workspace-a', false);
    expect(guard.blocksChangeFrom('workspace-a', 'workspace-b')).toBe(false);

    guard.recordingChanged(42, 'workspace-a', true);
    guard.windowClosed(42);
    expect(guard.blocksChangeFrom('workspace-a', 'workspace-b')).toBe(false);
  });
});
