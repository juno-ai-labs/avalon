// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  AvalonApiResponseError,
  definitivelyInvalidatesStoredCredential,
  refreshFailureIsTerminal,
  responseError,
  UnusableCredentialError,
} from './api-response-error';

describe('desktop API response errors', () => {
  it('marks only an HTTP 401 as a definitively invalid stored credential', async () => {
    const invalidToken = await responseError(new Response(JSON.stringify({
      error: { message: 'The refresh token is invalid or expired' },
    }), { status: 401 }));
    const unavailable = await responseError(new Response(null, { status: 503 }));

    expect(invalidToken).toEqual(expect.objectContaining({
      message: 'The refresh token is invalid or expired',
      status: 401,
    }));
    expect(definitivelyInvalidatesStoredCredential(invalidToken)).toBe(true);
    expect(definitivelyInvalidatesStoredCredential(unavailable)).toBe(false);
    expect(definitivelyInvalidatesStoredCredential(new Error('offline'))).toBe(false);
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

    expect(error).toBeInstanceOf(AvalonApiResponseError);
    expect(error.message).toBe('Avalon authentication failed (500)');
    expect(error.status).toBe(500);
  });
});
