export type WorkspaceActivationFailureCode =
  | 'workspace_access_denied'
  | 'workspace_activation_unavailable';

const WORKSPACE_ACTIVATION_FAILURE_PREFIX = '[rally-workspace-activation:';

/** Electron serializes rejected IPC errors as text, so activation carries a
 * bridge-owned marker instead of asking renderers to infer from API prose. */
export function workspaceActivationFailure(code: WorkspaceActivationFailureCode): Error {
  return new Error(`${WORKSPACE_ACTIVATION_FAILURE_PREFIX}${code}]`);
}

export function workspaceActivationFailureCode(error: unknown): WorkspaceActivationFailureCode | null {
  const message = error instanceof Error ? error.message : '';
  for (const code of ['workspace_access_denied', 'workspace_activation_unavailable'] as const) {
    if (message.includes(`${WORKSPACE_ACTIVATION_FAILURE_PREFIX}${code}]`)) return code;
  }
  return null;
}
