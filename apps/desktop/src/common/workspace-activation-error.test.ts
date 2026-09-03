import { describe, expect, it } from 'vitest';
import {
  accountReconnectRequired,
  accountReconnectRequiredFailure,
  workspaceActivationFailure,
  workspaceActivationFailureCode,
} from './workspace-activation-error';

describe('workspace activation bridge failures', () => {
  it.each(['account_reconnect_required', 'workspace_access_denied', 'workspace_activation_unavailable'] as const)(
    'round-trips the stable %s code through Electron error serialization',
    (code) => {
      const serialized = new Error(
        `Error invoking remote method 'onboarding:activate-workspace': Error: ${workspaceActivationFailure(code).message}`,
      );

      expect(workspaceActivationFailureCode(serialized)).toBe(code);
    },
  );

  it('keeps a readable sentence after the code for a surface that does not handle it', () => {
    const failure = accountReconnectRequiredFailure();
    const serialized = new Error(`Error invoking remote method 'onboarding:create-workspace': Error: ${failure.message}`);

    expect(failure.message).toMatch(/\] Sign in to Rally again to continue$/u);
    expect(accountReconnectRequired(serialized)).toBe(true);
    expect(accountReconnectRequired(workspaceActivationFailure('workspace_activation_unavailable'))).toBe(false);
  });

  it('does not classify provider prose as an authorization result', () => {
    expect(workspaceActivationFailureCode(new Error('Workspace access is unavailable'))).toBeNull();
  });
});
