export class AvalonApiResponseError extends Error {
  override readonly name = 'AvalonApiResponseError';

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function responseError(response: Response): Promise<AvalonApiResponseError> {
  const body: unknown = await response.json().catch(() => null);
  const nested = body && typeof body === 'object' && 'error' in body
    ? (body as { error?: { message?: string } }).error
    : undefined;
  return new AvalonApiResponseError(
    nested?.message ?? `Avalon authentication failed (${response.status})`,
    response.status,
  );
}

/** A refresh 401 means the durable refresh credential was revoked or expired.
 * Network failures and server errors must retain it so recovery can be retried. */
export function definitivelyInvalidatesStoredCredential(error: unknown): boolean {
  return error instanceof AvalonApiResponseError && error.status === 401;
}

/** A stored credential that can never produce a usable session: its binding no
 * longer matches what the service returns, or the service answered with
 * something this build cannot use. Retrying these is futile, so they are
 * terminal even though no 401 was involved. */
export class UnusableCredentialError extends Error {
  override readonly name = 'UnusableCredentialError';
}

/** True when a refresh failure can never succeed on a later attempt, and the
 * stored credential must therefore be surrendered rather than retried. */
export function refreshFailureIsTerminal(error: unknown): boolean {
  return definitivelyInvalidatesStoredCredential(error) || error instanceof UnusableCredentialError;
}
