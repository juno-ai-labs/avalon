import { describe, expect, it } from 'vitest';
import { LaunchApiTokenError, takeLaunchApiToken } from './launch-api-token';

const TOKEN = 'rally_at_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';

describe('takeLaunchApiToken', () => {
  it('returns the token and removes it from the environment', () => {
    const env: NodeJS.ProcessEnv = { RALLY_API_TOKEN: ` ${TOKEN}\n`, PATH: '/usr/bin' };
    expect(takeLaunchApiToken(env)).toBe(TOKEN);
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('returns null when no token was given', () => {
    expect(takeLaunchApiToken({})).toBeNull();
    expect(takeLaunchApiToken({ RALLY_API_TOKEN: '' })).toBeNull();
  });

  it('removes a malformed token too, and never repeats it in the error', () => {
    const env: NodeJS.ProcessEnv = { RALLY_API_TOKEN: 'rally_at_secret-but-short' };
    let thrown: unknown;
    try {
      takeLaunchApiToken(env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LaunchApiTokenError);
    expect((thrown as Error).message).not.toContain('secret-but-short');
    expect(env).toEqual({});
  });
});
