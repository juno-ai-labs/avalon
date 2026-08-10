import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, type PropsWithChildren } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseDesktopSettingsSection } from '../../common/settings';
import { useAppSession } from './app-session';
import { desktopBridge } from './platform';
import type {
  OnboardingAction,
  OnboardingChecklist,
  OnboardingChecklistStep,
  OnboardingStepState,
} from './types';

export const onboardingChecklistQueryKey = ['onboarding-checklist'] as const;
const onboardingMutationKey = ['onboarding'] as const;

/** The checklist is derived from real workspace data, so a refetch is how the
 * client learns a step became true — no per-feature completion reporting. */
const ONBOARDING_REFRESH_INTERVAL_MS = 30_000;

export interface OnboardingValue {
  checklist: OnboardingChecklist | null;
  /** The step the member is currently being guided through, in any window. */
  activeStep: OnboardingChecklistStep | null;
  /** Picks a step up: runs whatever the server said it does, then guides. */
  startStep: (step: OnboardingChecklistStep) => void;
  setStepState: (stepId: string, state: OnboardingStepState) => void;
  clearActiveStep: () => void;
  dismiss: () => void;
}

const OnboardingContext = createContext<OnboardingValue | null>(null);

/**
 * Recomputes the checklist the way the server would, so an optimistic update
 * never shows a count that disagrees with the rows above it.
 */
export function withStepState(
  checklist: OnboardingChecklist,
  stepId: string,
  state: OnboardingStepState,
): OnboardingChecklist {
  const steps = checklist.steps.map((step) => (
    step.id === stepId ? { ...step, state, ...(state === 'pending' ? { source: null, resolvedAt: null } : {}) } : step
  ));
  const remainingCount = steps.filter((step) => step.state === 'pending').length;
  return {
    ...checklist,
    steps,
    completedCount: steps.filter((step) => step.state === 'completed').length,
    remainingCount,
    complete: steps.length > 0 && remainingCount === 0,
    activeStepId: checklist.activeStepId === stepId && state !== 'pending' ? null : checklist.activeStepId,
  };
}

/**
 * Null outside an onboarding provider — surfaces that never onboard anyone
 * (the meeting window, isolated component trees) simply render no guidance.
 */
export function useOnboarding(): OnboardingValue | null {
  return useContext(OnboardingContext);
}

/** The context boundary on its own, for callers that already hold the state. */
export function OnboardingStateProvider({
  children,
  value,
}: PropsWithChildren<{ value: OnboardingValue }>): React.JSX.Element {
  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}

/**
 * Performs a server-declared step action. The kinds are a closed set the shell
 * knows how to honour, which keeps step definitions data rather than code.
 */
export function useOnboardingActionRunner(): (action: OnboardingAction) => void {
  const navigate = useNavigate();
  return useCallback((action: OnboardingAction) => {
    switch (action.kind) {
      case 'navigate':
        navigate(action.path);
        return;
      case 'open_settings': {
        const section = parseDesktopSettingsSection(action.section);
        void desktopBridge().openSettings(section ?? undefined).catch(() => undefined);
        return;
      }
      case 'open_url':
        void desktopBridge().openExternal(action.url).catch(() => undefined);
        return;
      case 'none':
        return;
    }
  }, [navigate]);
}

export function OnboardingProvider({ children }: PropsWithChildren): React.JSX.Element {
  const { api } = useAppSession();
  const queryClient = useQueryClient();
  const runAction = useOnboardingActionRunner();

  const checklist = useQuery({
    queryKey: onboardingChecklistQueryKey,
    queryFn: ({ signal }) => api!.getOnboardingChecklist(signal),
    enabled: Boolean(api),
    staleTime: 10_000,
    refetchInterval: ONBOARDING_REFRESH_INTERVAL_MS,
    // Guidance follows the member between the main and settings windows, so a
    // window regaining focus re-reads which step is active.
    refetchOnWindowFocus: true,
  });

  const apply = useCallback(
    (next: OnboardingChecklist) => queryClient.setQueryData(onboardingChecklistQueryKey, next),
    [queryClient],
  );

  const stepMutation = useMutation({
    mutationKey: onboardingMutationKey,
    mutationFn: ({ stepId, state }: { stepId: string; state: OnboardingStepState }) =>
      api!.setOnboardingStepState(stepId, state),
    onSuccess: apply,
    onError: () => queryClient.invalidateQueries({ queryKey: onboardingChecklistQueryKey }),
  });

  const checklistMutation = useMutation({
    mutationKey: onboardingMutationKey,
    mutationFn: (input: { activeStepId?: string | null; dismissed?: boolean }) =>
      api!.updateOnboardingChecklist(input),
    onSuccess: apply,
    onError: () => queryClient.invalidateQueries({ queryKey: onboardingChecklistQueryKey }),
  });

  // Steps complete from real work rather than from the feature that did the
  // work telling onboarding about it. Any successful write is a cheap cue to
  // re-derive the checklist, which keeps new steps free of client wiring.
  useEffect(() => queryClient.getMutationCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    if (event.mutation.options.mutationKey?.[0] === onboardingMutationKey[0]) return;
    void queryClient.invalidateQueries({ queryKey: onboardingChecklistQueryKey });
  }), [queryClient]);

  const data = checklist.data ?? null;
  const updateChecklist = checklistMutation.mutate;
  const updateStep = stepMutation.mutate;

  const value = useMemo<OnboardingValue>(() => ({
    checklist: data,
    activeStep: data?.steps.find((step) => step.id === data.activeStepId) ?? null,
    startStep: (step) => {
      if (data) apply({ ...data, activeStepId: step.id });
      updateChecklist({ activeStepId: step.id });
      runAction(step.action);
    },
    setStepState: (stepId, state) => {
      if (data) apply(withStepState(data, stepId, state));
      updateStep({ stepId, state });
    },
    clearActiveStep: () => {
      if (!data?.activeStepId) return;
      apply({ ...data, activeStepId: null });
      updateChecklist({ activeStepId: null });
    },
    dismiss: () => {
      if (data) apply({ ...data, activeStepId: null, dismissed: true });
      updateChecklist({ activeStepId: null, dismissed: true });
    },
  }), [apply, data, runAction, updateChecklist, updateStep]);

  return <OnboardingContext.Provider value={value}>{children}</OnboardingContext.Provider>;
}
