import clsx from 'clsx';
import { ArrowRight, Check, PartyPopper, Undo2, X } from 'lucide-react';
import { useOnboarding, type OnboardingValue } from '../lib/onboarding';
import type { OnboardingChecklistStep } from '../lib/types';

function StepRow({
  isActive,
  setStepState,
  startStep,
  step,
}: Pick<OnboardingValue, 'setStepState' | 'startStep'> & {
  isActive: boolean;
  step: OnboardingChecklistStep;
}): React.JSX.Element {
  const resolved = step.state !== 'pending';

  return (
    <div className={clsx('onboarding-item', resolved && `is-${step.state}`, isActive && 'is-active')}>
      <button
        aria-label={step.state === 'completed' ? `Mark ${step.title} as not done` : `Mark ${step.title} as done`}
        aria-pressed={step.state === 'completed'}
        className="onboarding-check"
        onClick={() => setStepState(step.id, step.state === 'completed' ? 'pending' : 'completed')}
        type="button"
      >
        {step.state === 'completed' && <Check aria-hidden="true" size={12} strokeWidth={2.5} />}
      </button>
      <button
        className="onboarding-item-copy"
        onClick={() => startStep(step)}
        type="button"
      >
        <strong>{step.title}</strong>
        <small>{step.state === 'skipped' ? 'Skipped' : step.description}</small>
      </button>
      {step.state === 'skipped' ? (
        <button
          aria-label={`Restore ${step.title}`}
          className="onboarding-item-aside"
          onClick={() => setStepState(step.id, 'pending')}
          type="button"
        >
          <Undo2 aria-hidden="true" size={13} />
        </button>
      ) : step.state === 'pending' ? (
        <button
          aria-label={`Skip ${step.title}`}
          className="onboarding-item-aside"
          onClick={() => setStepState(step.id, 'skipped')}
          type="button"
        >
          <X aria-hidden="true" size={13} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * Renders whatever the server's onboarding catalog says, in the order it says
 * it. Steps carry no ordering rules here either — every row is pickable at any
 * time, and finishing one never gates another.
 */
export function OnboardingChecklist(): React.JSX.Element | null {
  const onboarding = useOnboarding();
  const checklist = onboarding?.checklist ?? null;
  if (!onboarding || !checklist || checklist.dismissed || checklist.totalCount === 0) return null;
  const { activeStep, dismiss, setStepState, startStep } = onboarding;

  if (checklist.complete) {
    return (
      <section aria-labelledby="onboarding-checklist-heading" className="onboarding-checklist is-complete">
        <header>
          <h2 id="onboarding-checklist-heading">{checklist.completionTitle}</h2>
          <PartyPopper aria-hidden="true" size={13} />
        </header>
        <p className="onboarding-complete-copy">{checklist.completionBody}</p>
        <button className="text-button onboarding-dismiss" onClick={dismiss} type="button">
          Hide this <ArrowRight aria-hidden="true" size={12} />
        </button>
      </section>
    );
  }

  return (
    <section aria-labelledby="onboarding-checklist-heading" className="onboarding-checklist">
      <header>
        <h2 id="onboarding-checklist-heading">{checklist.title}</h2>
        <span>{checklist.completedCount} / {checklist.totalCount}</span>
      </header>
      <div
        aria-label={`${checklist.completedCount} of ${checklist.totalCount} onboarding steps complete`}
        aria-valuemax={checklist.totalCount}
        aria-valuemin={0}
        aria-valuenow={checklist.completedCount}
        className="onboarding-progress"
        role="progressbar"
      >
        <span style={{ width: `${(checklist.completedCount / checklist.totalCount) * 100}%` }} />
      </div>
      <div className="onboarding-items">
        {checklist.steps.map((step) => (
          <StepRow
            isActive={activeStep?.id === step.id}
            key={step.id}
            setStepState={setStepState}
            startStep={startStep}
            step={step}
          />
        ))}
      </div>
    </section>
  );
}
