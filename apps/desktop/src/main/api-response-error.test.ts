import { describe, expect, it } from 'vitest';
import {
  RallyApiResponseError,
  definitivelyInvalidatesStoredCredential,
  readJsonBody,
  refreshFailureIsTerminal,
  responseError,
  UnusableCredentialError,
  workspaceActivationBridgeError,
} from './api-response-error';
import { accountReconnectRequiredFailure } from '../common/workspace-activation-error';

describe('desktop API response errors', () => {
  it('marks only an HTTP 401 as a definitively invalid stored credential', async () => {
    const invalidToken = await responseError(new Response(JSON.stringify({
      error: { code: 'session_revoked', message: 'The refresh token is invalid or expired' },
    }), { status: 401 }));
    const unavailable = await responseError(new Response(null, { status: 503 }));
    const membershipEnded = await responseError(new Response(JSON.stringify({
      error: { code: 'workspace_access_denied', message: 'Workspace access is unavailable' },
    }), { status: 403 }));

    expect(invalidToken).toEqual(expect.objectContaining({
      message: 'The refresh token is invalid or expired',
      status: 401,
      code: 'session_revoked',
    }));
    expect(definitivelyInvalidatesStoredCredential(invalidToken)).toBe(true);
    expect(definitivelyInvalidatesStoredCredential(unavailable)).toBe(false);
    expect(definitivelyInvalidatesStoredCredential(new Error('offline'))).toBe(false);
    expect(definitivelyInvalidatesStoredCredential(membershipEnded)).toBe(false);
    expect(refreshFailureIsTerminal(membershipEnded)).toBe(true);
  });

  it('treats an unusable credential as terminal even though no 401 was involved', async () => {
    // A binding the service will never agree with cannot be retried into
    // working, so it must surrender the credential like a 401 does.
    const mismatch = new UnusableCredentialError('The refreshed session did not match the stored credential binding');
    const rejected = await responseError(new Response(null, { status: 401 }));
    const offline = new Error('net::ERR_INTERNET_DISCONNECTED');
    const unavailable = await responseError(new Response(null, { status: 503 }));

    expect(refreshFailureIsTerminal(mismatch)).toBe(true);
    expect(refreshFailureIsTerminal(rejected)).toBe(true);
    expect(refreshFailureIsTerminal(offline)).toBe(false);
    expect(refreshFailureIsTerminal(unavailable)).toBe(false);
    // The narrower predicate still means "the service rejected it".
    expect(definitivelyInvalidatesStoredCredential(mismatch)).toBe(false);
  });

  it('preserves the HTTP status when an error response has no JSON message', async () => {
    const error = await responseError(new Response('not-json', { status: 500 }));

    expect(error).toBeInstanceOf(RallyApiResponseError);
    expect(error.message).toBe('Rally authentication failed (500)');
    expect(error.status).toBe(500);
  });

  it('maps membership refusal and outages to stable bridge-owned failures', () => {
    expect(workspaceActivationBridgeError(
      new RallyApiResponseError('provider wording can change', 403, 'workspace_access_denied'),
    ).message).toContain('workspace_access_denied');
    expect(workspaceActivationBridgeError(
      new RallyApiResponseError('provider wording can change', 503, 'service_unavailable'),
    ).message).toContain('workspace_activation_unavailable');
  });

  it('lets a failure the bridge already named cross unchanged instead of reading it as an outage', () => {
    const missingIdentity = accountReconnectRequiredFailure();

    expect(workspaceActivationBridgeError(missingIdentity)).toBe(missingIdentity);
  });
});

describe('decoding a successful response body', () => {
  it('reads a no-content reply as null rather than as a failure', async () => {
    // `POST /work-opportunities/impressions` answers `c.body(null, 204)`. A
    // caller that decodes unconditionally reads every successful report as a
    // failure, and `response.ok` is true for a 204 so no error guard catches it.
    await expect(readJsonBody(new Response(null, { status: 204 }))).resolves.toBeNull();
    await expect(new Response(null, { status: 204 }).json()).rejects.toThrow();
  });

  it('reads an empty 200 body as null', async () => {
    await expect(readJsonBody(new Response('', { status: 200 }))).resolves.toBeNull();
    await expect(readJsonBody(new Response('   ', { status: 200 }))).resolves.toBeNull();
  });

  it('still decodes an ordinary JSON body', async () => {
    const response = new Response(JSON.stringify({ items: [1, 2] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(readJsonBody(response)).resolves.toEqual({ items: [1, 2] });
  });

  it('rejects a body that claims to be JSON and is not', async () => {
    await expect(readJsonBody(new Response('<html>502</html>', { status: 200 }))).rejects.toThrow();
  });
});
