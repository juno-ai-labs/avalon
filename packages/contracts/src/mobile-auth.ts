import { z } from 'zod';
import { RegionSchema } from './regions';

export const MOBILE_SIGN_IN_PATH = '/app/mobile/sign-in';
export const MOBILE_AUTH_CALLBACK = 'rally-mobile://auth/complete';

// Same S256 binding as desktop sign-in. The verifier stays in the native
// process until redemption; only its challenge travels through the browser.
export const MobileAuthStartSchema = z.strictObject({
  attemptId: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});
export const MobileAuthTicketSchema = z.strictObject({
  ticket: z.string().min(20).max(500),
  region: RegionSchema,
  attemptId: MobileAuthStartSchema.shape.attemptId,
});
export const MobileAuthExchangeSchema = MobileAuthTicketSchema.extend({
  codeVerifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/u),
});
export type MobileAuthExchange = z.infer<typeof MobileAuthExchangeSchema>;
