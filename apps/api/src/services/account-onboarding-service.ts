import { AccountOnboardingSchema, PersonalPresentationSchema, type AccountOnboarding, type UpdateAccountOnboarding } from '@rally/contracts';
import type { Env, IdentityAuthContext } from '../env';
import { ApiError } from '../lib/api-error';

/** Global identity preferences only; workspace progress lives in WorkspaceDO. */
export class AccountOnboardingService {
  constructor(private readonly env: Env, private readonly auth: IdentityAuthContext) {
    if (env.AVALON_REGION !== 'global' || auth.region !== 'global') {
      throw new ApiError(409, 'global_identity_required', 'Sign in through Rally to update your account.');
    }
  }

  async get(): Promise<AccountOnboarding> {
    const row = await this.env.DB.prepare(
      'SELECT onboarding_eligible, onboarding_introduced, onboarding_revision, presentation_json FROM users WHERE id = ?',
    ).bind(this.auth.userId).first<{ onboarding_eligible: number; onboarding_introduced: number; onboarding_revision: number; presentation_json: string | null }>();
    if (!row) throw new ApiError(401, 'identity_not_found', 'The signed-in user no longer exists.');
    return AccountOnboardingSchema.parse({
      eligible: row.onboarding_eligible === 1,
      introduced: row.onboarding_introduced === 1,
      revision: row.onboarding_revision,
      presentation: row.presentation_json ? PersonalPresentationSchema.parse(JSON.parse(row.presentation_json)) : null,
    });
  }

  async update(input: UpdateAccountOnboarding): Promise<AccountOnboarding> {
    const current = await this.get();
    // Replaying a lost save response is harmless, including after a new session.
    if (current.revision !== input.expectedRevision) {
      if ((!input.introduced || current.introduced) && (!input.presentation ||
        (current.presentation?.color === input.presentation.color && current.presentation.avatar === input.presentation.avatar && current.presentation.displayName === input.presentation.displayName && current.presentation.initials === input.presentation.initials))) return current;
      throw new ApiError(409, 'profile_revision_conflict', 'Your profile changed in another session. Review it and try again.');
    }
    const presentation = input.presentation
      ? { ...input.presentation, revision: current.revision + 1 }
      : current.presentation;
    const result = await this.env.DB.prepare(
      `UPDATE users SET name = COALESCE(?, name), onboarding_introduced = ?, presentation_json = ?, onboarding_revision = onboarding_revision + 1
       WHERE id = ? AND onboarding_revision = ?`,
    ).bind(presentation?.displayName ?? null, input.introduced || current.introduced ? 1 : 0, presentation ? JSON.stringify(presentation) : null,
      this.auth.userId, input.expectedRevision).run();
    if (result.meta.changes !== 1) throw new ApiError(409, 'profile_revision_conflict', 'Your profile changed in another session. Review it and try again.');
    return this.get();
  }
}
