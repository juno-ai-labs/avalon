import { asWorkspaceId, OnboardingJourneySchema, type UpdateOnboardingJourney } from '@rally/contracts';
import type { AuthContext, Env } from '../env';
import { workspaceDOName } from '../durable-objects/names';
import { durableObjectStubForWorkspace, workspacePlacementAffinity } from '../lib/durable-object-namespace';
import { ApiError } from '../lib/api-error';

export class OnboardingJourneyService {
  constructor(private readonly env: Env, private readonly auth: AuthContext) {}

  private async authority() {
    const row = await this.env.DB.prepare(`SELECT w.created_by_user_id, u.onboarding_eligible, u.presentation_json
      FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id
      JOIN users u ON u.id = m.user_id
      WHERE w.id = ? AND m.user_id = ? AND m.status = 'active' AND w.abandoned_at IS NULL`)
      .bind(this.auth.workspaceId, this.auth.userId).first<{ created_by_user_id: string; onboarding_eligible: number; presentation_json: string | null }>();
    if (!row) throw new ApiError(403, 'workspace_access_denied', 'Workspace access is unavailable.');
    if (!row.onboarding_eligible) throw new ApiError(409, 'onboarding_not_required', 'This account does not require onboarding.');
    const placementAffinity = await workspacePlacementAffinity(this.env, this.auth.workspaceId);
    const stub = await durableObjectStubForWorkspace(this.env, this.env.WORKSPACE_DOS, this.auth.workspaceId,
      workspaceDOName(this.env.AVALON_REGION, asWorkspaceId(this.auth.workspaceId)), placementAffinity);
    const input = { workspaceId: this.auth.workspaceId, userId: this.auth.userId, placementAffinity,
      path: row.created_by_user_id === this.auth.userId ? 'creator' as const : 'member' as const };
    return { stub, input, hasPresentation: Boolean(row.presentation_json) };
  }

  async get(update?: UpdateOnboardingJourney) {
    const { stub, input } = await this.authority();
    if (!update) {
      const current = OnboardingJourneySchema.parse(await stub.onboardingJourney(input));
      if (current.stage === 'example' || current.stage === 'skipped') update = { expectedRevision: current.revision, stage: 'complete' };
      else return current;
    }
    const result = await stub.onboardingJourney({ ...input, ...(update ? { update } : {}) });
    if (!result) throw new ApiError(409, 'onboarding_revision_conflict', 'Onboarding changed in another session. Resume from the current step.');
    return OnboardingJourneySchema.parse(result);
  }

}
