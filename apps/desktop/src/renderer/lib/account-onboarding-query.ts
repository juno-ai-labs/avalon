/**
 * The one spelling of the account onboarding read's query key. The read is
 * made at identity scope, so the answer is the same account's in every
 * workspace, and a workspace switch or creation carries it across the cache
 * reset (see `applyActivatedSession` in `app-session.tsx`).
 */
export function accountOnboardingQueryKey(email: string | undefined): readonly ['account-onboarding', string | undefined] {
  return ['account-onboarding', email];
}
