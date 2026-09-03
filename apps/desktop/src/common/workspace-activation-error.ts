export type WorkspaceActivationFailureCode =
  | 'account_reconnect_required'
  | 'workspace_access_denied'
  | 'workspace_activation_unavailable';

const WORKSPACE_ACTIVATION_FAILURE_CODES: readonly WorkspaceActivationFailureCode[] = [
  'account_reconnect_required',
  'workspace_access_denied',
  'workspace_activation_unavailable',
];

const WORKSPACE_ACTIVATION_FAILURE_PREFIX = '[rally-workspace-activation:';

/** Electron serializes rejected IPC errors as text, so activation carries a
 * bridge-owned marker instead of asking renderers to infer from API prose.
 * `detail` is the sentence a surface with no handling for the code may show. */
export function workspaceActivationFailure(code: WorkspaceActivationFailureCode, detail?: string): Error {
  return new Error(`${WORKSPACE_ACTIVATION_FAILURE_PREFIX}${code}]${detail ? ` ${detail}` : ''}`);
}

export function workspaceActivationFailureCode(error: unknown): WorkspaceActivationFailureCode | null {
  const message = error instanceof Error ? error.message : '';
  for (const code of WORKSPACE_ACTIVATION_FAILURE_CODES) {
    if (message.includes(`${WORKSPACE_ACTIVATION_FAILURE_PREFIX}${code}]`)) return code;
  }
  return null;
}

/**
 * This device holds no account identity credential, so the request was never
 * made. A sign-in through the browser restores the credential, after which
 * the same request is worth making again — the renderer does exactly that,
 * in place, rather than reporting it as a failure.
 */
export function accountReconnectRequiredFailure(): Error {
  return workspaceActivationFailure('account_reconnect_required', 'Sign in to Rally again to continue');
}

export function accountReconnectRequired(error: unknown): boolean {
  return workspaceActivationFailureCode(error) === 'account_reconnect_required';
}
