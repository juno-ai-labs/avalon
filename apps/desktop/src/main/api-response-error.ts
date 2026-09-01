import { workspaceActivationFailure } from '../common/workspace-activation-error';

export class RallyApiResponseError extends Error {
  override readonly name = 'RallyApiResponseError';

  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function workspaceActivationBridgeError(error: unknown): Error {
  return workspaceActivationFailure(
    error instanceof RallyApiResponseError
      && (error.code === 'workspace_access_denied' || error.code === 'workspace_access_revoked')
      ? 'workspace_access_denied'
      : 'workspace_activation_unavailable',
  );
}

export async function responseError(response: Response): Promise<RallyApiResponseError> {
  const body: unknown = await response.json().catch(() => null);
  const nested = body && typeof body === 'object' && 'error' in body
    ? (body as { error?: { code?: unknown; message?: string } }).error
    : undefined;
  return new RallyApiResponseError(
    nested?.message ?? `Rally authentication failed (${response.status})`,
    response.status,
    typeof nested?.code === 'string' ? nested.code : undefined,
  );
}

/** A refresh 401 means the durable refresh credential was revoked or expired.
 * Network failures and server errors must retain it so recovery can be retried. */
export function definitivelyInvalidatesStoredCredential(error: unknown): boolean {
  return error instanceof RallyApiResponseError && error.status === 401;
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
  return definitivelyInvalidatesStoredCredential(error)
    || (error instanceof RallyApiResponseError && error.code === 'workspace_access_denied')
    || error instanceof UnusableCredentialError;
}

/**
 * Decodes a successful Rally response, tolerating one that carries no body.
 *
 * `Response.ok` is true for a 204, and `response.json()` on an empty body
 * rejects with a `SyntaxError` — so a caller that decodes unconditionally reads
 * every successful no-content reply as a failure. Rally has several of those:
 * `POST /work-opportunities/impressions` answers `c.body(null, 204)`, and it is
 * the shape any future fire-and-forget endpoint will take.
 *
 * The length check covers a 200 with an empty body, which is not something
 * Rally returns today but costs nothing to survive.
 */
export async function readJsonBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.headers.get('content-length') === '0') return null;
  const body = await response.text();
  if (body.trim().length === 0) return null;
  return JSON.parse(body) as unknown;
}
