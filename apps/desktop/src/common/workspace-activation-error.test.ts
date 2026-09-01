import { describe, expect, it } from 'vitest';
import {
  workspaceActivationFailure,
  workspaceActivationFailureCode,
} from './workspace-activation-error';

describe('workspace activation bridge failures', () => {
  it.each(['workspace_access_denied', 'workspace_activation_unavailable'] as const)(
    'round-trips the stable %s code through Electron error serialization',
    (code) => {
      const serialized = new Error(
        `Error invoking remote method 'onboarding:activate-workspace': Error: ${workspaceActivationFailure(code).message}`,
      );

      expect(workspaceActivationFailureCode(serialized)).toBe(code);
    },
  );

  it('does not classify provider prose as an authorization result', () => {
    expect(workspaceActivationFailureCode(new Error('Workspace access is unavailable'))).toBeNull();
  });
});
