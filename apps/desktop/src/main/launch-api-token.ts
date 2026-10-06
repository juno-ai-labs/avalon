import { ApiTokenSchema } from '@rally/contracts';

/** The environment variable a launch reads an API token from. See docs/api-tokens.md. */
export const LAUNCH_API_TOKEN_ENV = 'RALLY_API_TOKEN';

export class LaunchApiTokenError extends Error {
  readonly code = 'launch_api_token_malformed';
  constructor() {
    // Never the value: a mistyped token is still most of a credential.
    super(`${LAUNCH_API_TOKEN_ENV} is not a Rally API token (expected rally_at_ followed by 43 base64url characters)`);
  }
}

/**
 * Take the launch's API token out of the environment, once.
 *
 * The variable is deleted whether or not it parses, so no process this one
 * starts (the terminal sandbox, a helper, a crash reporter) inherits a
 * credential it was never meant to hold. Returns null when none was given.
 */
export function takeLaunchApiToken(env: NodeJS.ProcessEnv): string | null {
  const raw = env[LAUNCH_API_TOKEN_ENV];
  delete env[LAUNCH_API_TOKEN_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = ApiTokenSchema.safeParse(raw.trim());
  if (!parsed.success) throw new LaunchApiTokenError();
  return parsed.data;
}
