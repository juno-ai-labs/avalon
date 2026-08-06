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
