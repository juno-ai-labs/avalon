import type { z } from 'zod';
import type { MobileAuthExchangeSchema } from '@rally/contracts';

// Shared by the native client and its system-browser sign-in page.
export const MOBILE_SIGN_IN_PATH = '/app/mobile/sign-in';
export const MOBILE_AUTH_CALLBACK = 'rally-mobile://auth/complete';
export type MobileAuthExchange = z.infer<typeof MobileAuthExchangeSchema>;
