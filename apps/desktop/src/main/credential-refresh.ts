/**
 * One refresh in flight per stored refresh token.
 *
 * The API rotates the refresh token on every `/auth/refresh`, and for sixty
 * seconds it also honours the token it just retired so that a device whose
 * response was lost can present the old one again. That grace clause makes a
 * *concurrent* pair of refreshes with the same token dangerous rather than
 * harmless: both succeed, each rotates, and the response that reaches the
 * desktop first is the one persisted — leaving the device holding a token
 * the service will only accept for the remainder of the grace window. The
 * next refresh after that is a 401, which the desktop reads as terminal and
 * answers by surrendering the credential. For the account identity that is
 * the "Reconnect account…" menu item and every discovered workspace gone
 * from the menu.
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
