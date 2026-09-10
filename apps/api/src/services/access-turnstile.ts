import { z } from 'zod';
import type { Env } from '../env';
import { ApiError } from '../lib/api-error';

const ResultSchema = z.object({ success: z.boolean(), hostname: z.string().optional(), action: z.string().optional() });
/** The external verifier consumes each token once. Never accept client claims. */
export async function verifyAccessChallenge(env: Env, token: string | undefined, origin: string, address?: string): Promise<void> {
  if (env.APP_ENV !== 'production') return;
  if (!env.TURNSTILE_SECRET_KEY) throw new ApiError(503, 'access_verification_unavailable', 'Verification is unavailable. Please try again later.');
  if (!token) throw new ApiError(400, 'access_verification_failed', 'Please complete the verification.');
  let result: z.infer<typeof ResultSchema>;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(address ? { remoteip: address } : {}) }),
    });
    if (!response.ok) throw new Error('Verifier unavailable');
    result = ResultSchema.parse(await response.json());
  } catch { throw new ApiError(503, 'access_verification_unavailable', 'Verification is unavailable. Please try again later.'); }
  if (!result.success || result.hostname !== new URL(origin).hostname || result.action !== 'access_request') {
    throw new ApiError(400, 'access_verification_failed', 'Verification expired or failed. Please try again.');
  }
}
