/**
 * Pure auto-update gating. The production feed contains only the signed,
 * notarized Apple-silicon build, so development, unpackaged, non-macOS, and
 * non-arm64 processes must never contact it.
 */
export type UpdatePolicy =
  | { readonly kind: 'enabled' }
  | { readonly kind: 'disabled'; readonly reason: string };

export interface UpdatePolicyInput {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly env: NodeJS.ProcessEnv;
}

/** Set to any non-empty value when updates are managed out of band. */
export const DISABLE_AUTO_UPDATE_ENV = 'RALLY_DISABLE_AUTO_UPDATE';

export function updatePolicy(input: UpdatePolicyInput): UpdatePolicy {
  if (!input.isPackaged) {
    return { kind: 'disabled', reason: 'not a packaged build' };
  }
  if (input.platform !== 'darwin') {
    return { kind: 'disabled', reason: `unsupported platform '${input.platform}'` };
  }
  if (input.arch !== 'arm64') {
    return { kind: 'disabled', reason: `unsupported architecture '${input.arch}'` };
  }
  if (input.env[DISABLE_AUTO_UPDATE_ENV]) {
    return { kind: 'disabled', reason: `${DISABLE_AUTO_UPDATE_ENV} is set` };
  }
  return { kind: 'enabled' };
}
