import "../../../../tests/isolated-region";
import { describe, expect, it, vi } from 'vitest';
import { claimActiveWorkspace } from './workspace-selection';

const workspaceId = '00000000-0000-7000-8000-000000000001';
const activeSession = {
  accessToken: 'active-token',
  workspace: { id: workspaceId, region: 'global' as const },
};

describe('claiming the active workspace for a link', () => {
  it('returns the active session and takes a selection intent when the link names it', () => {
    const nextSelectionIntent = vi.fn(() => 4);

    const claimed = claimActiveWorkspace(
      { region: 'global', workspaceId },
      { activeSession, nextSelectionIntent },
    );

    expect(claimed).toBe(activeSession);
    // The intent is what makes this the newest selection: an activation still
    // in flight for another workspace must not take over the window later.
    expect(nextSelectionIntent).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'another workspace', target: { region: 'global' as const, workspaceId: '00000000-0000-7000-8000-000000000002' } },
    { name: 'the same id in another region', target: { region: 'enterprise' as const, workspaceId } },
  ])('yields to platform activation for $name without taking an intent', ({ target }) => {
    const nextSelectionIntent = vi.fn(() => 5);

    expect(claimActiveWorkspace(target, { activeSession, nextSelectionIntent })).toBeNull();
    expect(nextSelectionIntent).not.toHaveBeenCalled();
  });

  it('yields to platform activation when nothing is active', () => {
    const nextSelectionIntent = vi.fn(() => 6);

    expect(claimActiveWorkspace(
      { region: 'global', workspaceId },
      { activeSession: { ...activeSession, workspace: null }, nextSelectionIntent },
    )).toBeNull();
    expect(claimActiveWorkspace(
      { region: 'global', workspaceId },
      { activeSession: null, nextSelectionIntent },
    )).toBeNull();
    expect(nextSelectionIntent).not.toHaveBeenCalled();
  });
});
