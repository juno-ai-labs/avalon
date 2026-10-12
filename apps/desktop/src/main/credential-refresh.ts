/**
 * One refresh in flight per stored refresh token.
 *
 * The API rotates the refresh token on every `/auth/refresh` and keeps
 * honouring the token it retired until the successor is first presented, so
 * a device whose response was lost can present the old one again, however
 * much later. Two *concurrent* refreshes with the same token are still
 * harmful: both succeed, the second keeps the old token valid and retires the
 * first answer's token at once, and if the desktop persists that first answer
 * its next refresh is a 401, which it reads as terminal. For the account
 * identity that ends the complete local session and shows the native sign-in
 * notice.
 *
 * Every path that renews a stored credential therefore goes through here, so
 * that two requests which found the same access token expired share one
 * rotation and both persist the same result.
 */
export interface RefreshableCredential {
  refreshToken: string;
  binding: {
    workspaceId: string | null;
    region: string;
  };
}

export function credentialRefreshKey(credential: RefreshableCredential): string {
  return `${credential.binding.region}:${credential.binding.workspaceId ?? 'account'}:${credential.refreshToken}`;
}

export class CredentialRefreshRegistry<Result> {
  private readonly inFlight = new Map<string, Promise<Result>>();

  /**
   * Run `refresh` for this credential unless a refresh of the same token is
   * already in flight, in which case its result — or its failure — is shared.
   * A credential that has been replaced since has a different token and a
   * different key, so it never waits on a rotation that is not its own.
   */
  run(credential: RefreshableCredential, refresh: () => Promise<Result>): Promise<Result> {
    const key = credentialRefreshKey(credential);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const started: Promise<Result> = refresh().finally(() => {
      if (this.inFlight.get(key) === started) this.inFlight.delete(key);
    });
    this.inFlight.set(key, started);
    return started;
  }

  /** How many distinct tokens are being refreshed right now. */
  get pending(): number {
    return this.inFlight.size;
  }
}
