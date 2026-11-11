/**
 * Auto-update gating for the shipped macOS arm64 and Linux x64 packages.
 * Unpacked Linux directories must not contact a feed they cannot install.
 */
export type UpdatePolicy =
  | { readonly kind: 'enabled' }
  | { readonly kind: 'disabled'; readonly reason: string };

export interface UpdatePolicyInput {
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly env: NodeJS.ProcessEnv;
  readonly linuxPackageType?: string;
}

/** Set to any non-empty value when updates are managed out of band. */
export const DISABLE_AUTO_UPDATE_ENV = 'RALLY_DISABLE_AUTO_UPDATE';

export function updatePolicy(input: UpdatePolicyInput): UpdatePolicy {
  if (!input.isPackaged) {
    return { kind: 'disabled', reason: 'not a packaged build' };
  }
  if (input.platform !== 'darwin' && input.platform !== 'linux') {
    return { kind: 'disabled', reason: `unsupported platform '${input.platform}'` };
  }
  if (input.arch !== (input.platform === 'linux' ? 'x64' : 'arm64')) {
    return { kind: 'disabled', reason: `unsupported architecture '${input.arch}'` };
  }
  if (input.platform === 'linux' && (!input.env.APPIMAGE && input.linuxPackageType !== 'deb' || input.env.SNAP)) {
    return { kind: 'disabled', reason: 'not an AppImage or Debian installation' };
  }
  if (input.env[DISABLE_AUTO_UPDATE_ENV]) {
    return { kind: 'disabled', reason: `${DISABLE_AUTO_UPDATE_ENV} is set` };
  }
  return { kind: 'enabled' };
}
