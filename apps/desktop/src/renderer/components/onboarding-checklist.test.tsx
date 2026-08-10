import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingStateProvider, type OnboardingValue } from '../lib/onboarding';
import type { OnboardingChecklist as OnboardingChecklistData, OnboardingChecklistStep } from '../lib/types';
import { OnboardingChecklist } from './onboarding-checklist';

function step(overrides: Partial<OnboardingChecklistStep> & { id: string }): OnboardingChecklistStep {
  return {
    title: `Step ${overrides.id}`,
    description: `Do ${overrides.id}`,
    state: 'pending',
    source: null,
    resolvedAt: null,
    action: { kind: 'navigate', path: `/${overrides.id}` },
    spotlight: null,
    ...overrides,
  };
}

function checklist(overrides: Partial<OnboardingChecklistData> = {}): OnboardingChecklistData {
  const steps = overrides.steps ?? [
    step({ id: 'connect-tools', title: 'Connect your tools', description: 'Bring Linear in' }),
    step({ id: 'create-automation', title: 'Create your first automation', description: 'Schedule a brief' }),
    step({ id: 'invite-teammate', title: 'Invite a teammate', description: 'Share a work stream' }),
  ];
  const remainingCount = steps.filter((item) => item.state === 'pending').length;
  return {
    version: '2026-08-10.1',
    title: 'Get started with Avalon',
    completionTitle: "You're set up",
    completionBody: 'Avalon is connected and shared.',
    steps,
    completedCount: steps.filter((item) => item.state === 'completed').length,
    remainingCount,
    totalCount: steps.length,
    activeStepId: null,
    complete: steps.length > 0 && remainingCount === 0,
    dismissed: false,
    ...overrides,
  };
}

function renderChecklist(
  data: OnboardingChecklistData | null,
  overrides: Partial<OnboardingValue> = {},
): OnboardingValue {
  const value: OnboardingValue = {
    checklist: data,
    activeStep: data?.steps.find((item) => item.id === data.activeStepId) ?? null,
    startStep: vi.fn(),
    setStepState: vi.fn(),
    clearActiveStep: vi.fn(),
    dismiss: vi.fn(),
    ...overrides,
  };
  render(
    <OnboardingStateProvider value={value}>
      <OnboardingChecklist />
    </OnboardingStateProvider>,
  );
  return value;
}

describe('OnboardingChecklist', () => {
  it('renders whatever steps the server sent, in order, with server copy', () => {
    renderChecklist(checklist());

    const region = screen.getByRole('region', { name: 'Get started with Avalon' });
    expect(within(region).getByText('0 / 3')).toBeVisible();
    expect(within(region).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(
      within(region).getAllByRole('button', { name: /^(Connect|Create|Invite)/u })
        .map((button) => button.textContent),
    ).toEqual([
      'Connect your toolsBring Linear in',
      'Create your first automationSchedule a brief',
      'Invite a teammateShare a work stream',
    ]);
  });

  it('starts a step when its row is picked, whichever row that is', () => {
    const value = renderChecklist(checklist());

    fireEvent.click(screen.getByRole('button', { name: 'Invite a teammateShare a work stream' }));

    expect(value.startStep).toHaveBeenCalledWith(expect.objectContaining({ id: 'invite-teammate' }));
  });

  it('marks any step done or not done without touching the others', () => {
    const value = renderChecklist(checklist({
      steps: [
        step({ id: 'connect-tools', title: 'Connect your tools' }),
        step({ id: 'create-automation', title: 'Create your first automation', state: 'completed', source: 'signal' }),
      ],
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Mark Connect your tools as done' }));
    expect(value.setStepState).toHaveBeenCalledWith('connect-tools', 'completed');

    fireEvent.click(screen.getByRole('button', { name: 'Mark Create your first automation as not done' }));
    expect(value.setStepState).toHaveBeenCalledWith('create-automation', 'pending');
  });

  it('skips and restores a step', () => {
    const value = renderChecklist(checklist({
      steps: [
        step({ id: 'connect-tools', title: 'Connect your tools' }),
        step({ id: 'invite-teammate', title: 'Invite a teammate', state: 'skipped', source: 'manual' }),
      ],
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Skip Connect your tools' }));
    expect(value.setStepState).toHaveBeenCalledWith('connect-tools', 'skipped');

    fireEvent.click(screen.getByRole('button', { name: 'Restore Invite a teammate' }));
    expect(value.setStepState).toHaveBeenCalledWith('invite-teammate', 'pending');
    expect(screen.getByText('Skipped')).toBeVisible();
  });

  it('counts progress from the completed steps the server reports', () => {
    renderChecklist(checklist({
      steps: [
        step({ id: 'connect-tools', state: 'completed', source: 'signal' }),
        step({ id: 'create-automation' }),
      ],
    }));

    expect(screen.getByText('1 / 2')).toBeVisible();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1');
  });

  it('closes out with the server completion copy and can be hidden', () => {
    const value = renderChecklist(checklist({
      steps: [
        step({ id: 'connect-tools', state: 'completed', source: 'signal' }),
        step({ id: 'create-automation', state: 'skipped', source: 'manual' }),
      ],
    }));

    expect(screen.getByRole('region', { name: "You're set up" })).toBeVisible();
    expect(screen.getByText('Avalon is connected and shared.')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: /Hide this/u }));
    expect(value.dismiss).toHaveBeenCalled();
  });

  it('renders nothing once dismissed, and nothing without onboarding state', () => {
    const { unmount } = render(<OnboardingChecklist />);
    expect(screen.queryByRole('region')).toBeNull();
    unmount();

    renderChecklist(checklist({ dismissed: true }));
    expect(screen.queryByRole('region')).toBeNull();
  });
});
