import type {
  OnboardingChecklist,
  OnboardingChecklistStep,
  OnboardingStepSource,
  OnboardingStepState,
} from "@avalon/contracts";
import { nowIso } from "@avalon/db";
import type { AuthContext, Env } from "../env";
import { ApiError } from "../lib/api-error";
import {
  onboardingCatalog,
  onboardingStepsForRole,
  type OnboardingCatalog,
  type OnboardingStepDefinition,
} from "./onboarding-checklist-catalog";

interface ProgressRow {
  step_id: string;
  state: Exclude<OnboardingStepState, "pending">;
  source: OnboardingStepSource;
  resolved_at: string;
}

interface ChecklistStateRow {
  active_step_id: string | null;
  dismissed_version: string | null;
}

type ResolvedProgress = Map<string, ProgressRow>;

/**
 * Serves and records the post-organization onboarding checklist.
 *
 * The service knows nothing about individual steps. It reads the catalog,
 * evaluates each step's signal against real workspace data, records anything
 * newly satisfied, and merges that with whatever the member resolved by hand.
 * Steps carry no ordering constraints, so any of them can be finished, marked,
 * or skipped at any point.
 */
export class OnboardingChecklistService {
  constructor(
    private readonly env: Env,
    private readonly auth: AuthContext,
    private readonly catalog: OnboardingCatalog = onboardingCatalog,
  ) {}

  private get steps(): readonly OnboardingStepDefinition[] {
    return onboardingStepsForRole(this.auth.role, this.catalog);
  }

  private requireStep(stepId: string): OnboardingStepDefinition {
    const step = this.steps.find((candidate) => candidate.id === stepId);
    if (!step) {
      throw new ApiError(404, "onboarding_step_not_found", "This onboarding step is not available");
    }
    return step;
  }

  async state(): Promise<OnboardingChecklist> {
    const [progress, checklistState] = await Promise.all([this.loadProgress(), this.loadChecklistState()]);
    const recorded = await this.recordSatisfiedSignals(progress);
    return this.present(recorded, checklistState);
  }

  /**
   * Marking is deliberately unconditional: a member can complete a step ahead
   * of the others, skip one that does not apply to them, or move it back to
   * pending. A signal-backed step that is still genuinely satisfied returns to
   * completed on the next read, which keeps the checklist honest without
   * blocking anyone.
   */
  async setStepState(stepId: string, state: OnboardingStepState): Promise<OnboardingChecklist> {
    this.requireStep(stepId);
    if (state === "pending") {
      await this.env.DB.prepare(
        `DELETE FROM onboarding_step_progress
         WHERE workspace_id = ? AND user_id = ? AND step_id = ?`,
      )
        .bind(this.auth.workspaceId, this.auth.userId, stepId)
        .run();
    } else {
      await this.env.DB.prepare(
        `INSERT INTO onboarding_step_progress
           (workspace_id, user_id, step_id, state, source, resolved_at)
         VALUES (?, ?, ?, ?, 'manual', ?)
         ON CONFLICT(workspace_id, user_id, step_id) DO UPDATE SET
           state = excluded.state,
           source = excluded.source,
           resolved_at = excluded.resolved_at`,
      )
        .bind(this.auth.workspaceId, this.auth.userId, stepId, state, nowIso())
        .run();
    }
    return this.state();
  }

  async updateChecklist(input: {
    activeStepId?: string | null | undefined;
    dismissed?: boolean | undefined;
  }): Promise<OnboardingChecklist> {
    if (input.activeStepId) this.requireStep(input.activeStepId);
    const timestamp = nowIso();
    const existing = await this.loadChecklistState();
    const activeStepId = input.activeStepId === undefined
      ? existing?.active_step_id ?? null
      : input.activeStepId;
    const dismissedVersion = input.dismissed === undefined
      ? existing?.dismissed_version ?? null
      : input.dismissed ? this.catalog.version : null;

    await this.env.DB.prepare(
      `INSERT INTO onboarding_checklist_state
         (workspace_id, user_id, active_step_id, dismissed_version, dismissed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, user_id) DO UPDATE SET
         active_step_id = excluded.active_step_id,
         dismissed_version = excluded.dismissed_version,
         dismissed_at = excluded.dismissed_at,
         updated_at = excluded.updated_at`,
    )
      .bind(
        this.auth.workspaceId,
        this.auth.userId,
        activeStepId,
        dismissedVersion,
        dismissedVersion ? timestamp : null,
        timestamp,
        timestamp,
      )
      .run();
    return this.state();
  }

  private async loadProgress(): Promise<ResolvedProgress> {
    const result = await this.env.DB.prepare(
      `SELECT step_id, state, source, resolved_at FROM onboarding_step_progress
       WHERE workspace_id = ? AND user_id = ?`,
    )
      .bind(this.auth.workspaceId, this.auth.userId)
      .all<ProgressRow>();
    return new Map((result.results ?? []).map((row) => [row.step_id, row]));
  }

  private async loadChecklistState(): Promise<ChecklistStateRow | null> {
    return this.env.DB.prepare(
      `SELECT active_step_id, dismissed_version FROM onboarding_checklist_state
       WHERE workspace_id = ? AND user_id = ?`,
    )
      .bind(this.auth.workspaceId, this.auth.userId)
      .first<ChecklistStateRow>();
  }

  /**
   * Evaluates every unresolved step's signal in one round trip and persists the
   * ones that now hold. Recording is what makes completion durable: disconnecting
   * a connector later does not undo the step the member already finished.
   */
  private async recordSatisfiedSignals(progress: ResolvedProgress): Promise<ResolvedProgress> {
    const pending = this.steps.flatMap((step) =>
      step.signal && progress.get(step.id)?.state !== "completed"
        ? [{ step, signal: step.signal }]
        : [],
    );
    if (pending.length === 0) return progress;

    const context = { workspaceId: this.auth.workspaceId, userId: this.auth.userId };
    const results = await this.env.DB.batch(
      pending.map(({ signal }) => this.env.DB.prepare(signal.sql).bind(...signal.binds(context))),
    );
    const satisfied = pending
      .filter((_, index) => (results[index]?.results?.length ?? 0) > 0)
      .map(({ step }) => step);
    if (satisfied.length === 0) return progress;

    const resolvedAt = nowIso();
    await this.env.DB.batch(
      satisfied.map((step) =>
        this.env.DB.prepare(
          `INSERT INTO onboarding_step_progress
             (workspace_id, user_id, step_id, state, source, resolved_at)
           VALUES (?, ?, ?, 'completed', 'signal', ?)
           ON CONFLICT(workspace_id, user_id, step_id) DO UPDATE SET
             state = 'completed',
             source = 'signal',
             resolved_at = excluded.resolved_at
           WHERE onboarding_step_progress.state != 'completed'`,
        ).bind(this.auth.workspaceId, this.auth.userId, step.id, resolvedAt),
      ),
    );

    const merged: ResolvedProgress = new Map(progress);
    for (const step of satisfied) {
      merged.set(step.id, {
        step_id: step.id,
        state: "completed",
        source: "signal",
        resolved_at: resolvedAt,
      });
    }
    return merged;
  }

  private present(progress: ResolvedProgress, checklistState: ChecklistStateRow | null): OnboardingChecklist {
    const steps: OnboardingChecklistStep[] = this.steps.map((step) => {
      const resolved = progress.get(step.id);
      return {
        id: step.id,
        title: step.title,
        description: step.description,
        state: resolved?.state ?? "pending",
        source: resolved?.source ?? null,
        resolvedAt: resolved?.resolved_at ?? null,
        action: step.action,
        spotlight: step.spotlight,
      };
    });
    const completedCount = steps.filter((step) => step.state === "completed").length;
    const remainingCount = steps.filter((step) => step.state === "pending").length;
    const activeStepId = steps.some(
      (step) => step.id === checklistState?.active_step_id && step.state === "pending",
    )
      ? checklistState?.active_step_id ?? null
      : null;

    return {
      version: this.catalog.version,
      title: this.catalog.title,
      completionTitle: this.catalog.completionTitle,
      completionBody: this.catalog.completionBody,
      steps,
      completedCount,
      remainingCount,
      totalCount: steps.length,
      activeStepId,
      complete: steps.length > 0 && remainingCount === 0,
      dismissed: checklistState?.dismissed_version === this.catalog.version,
    };
  }
}
