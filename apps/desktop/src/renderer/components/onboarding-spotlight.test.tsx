import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OnboardingStateProvider, type OnboardingValue } from '../lib/onboarding';
import type { OnboardingChecklist as OnboardingChecklistData, OnboardingChecklistStep } from '../lib/types';
import { OnboardingSpotlight, onboardingAnchor } from './onboarding-spotlight';

const guidedStep: OnboardingChecklistStep = {
  id: 'connect-tools',
  title: 'Connect your tools',
  description: 'Bring Linear in',
  state: 'pending',
  source: null,
  resolvedAt: null,
  action: { kind: 'open_settings', section: 'connections' },
  spotlight: {
    anchor: 'settings-connections',
    title: 'Connect your first tool',
    body: 'Pick a provider here.',
    placement: 'right',
  },
};

const checklist: OnboardingChecklistData = {
  version: '2026-08-10.1',
  title: 'Get started with Avalon',
  completionTitle: "You're set up",
  completionBody: 'All done.',
  steps: [guidedStep, { ...guidedStep, id: 'invite-teammate', title: 'Invite a teammate' }],
  completedCount: 0,
  remainingCount: 2,
  totalCount: 2,
  activeStepId: guidedStep.id,
  complete: false,
  dismissed: false,
};

function renderSpotlight(
  overrides: Partial<OnboardingValue> = {},
  anchor: string | null = 'settings-connections',
): OnboardingValue {
  const value: OnboardingValue = {
    checklist,
    activeStep: guidedStep,
    startStep: vi.fn(),
    setStepState: vi.fn(),
    clearActiveStep: vi.fn(),
    dismiss: vi.fn(),
    ...overrides,
  };
  render(
    <OnboardingStateProvider value={value}>
      {anchor && <button type="button" {...onboardingAnchor(anchor)}>Connect Linear</button>}
      <OnboardingSpotlight />
    </OnboardingStateProvider>,
  );
  return value;
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});

describe('OnboardingSpotlight', () => {
  it('lights the anchor the active step points at and explains it', async () => {
    renderSpotlight();

    const card = await screen.findByRole('dialog', { name: 'Connect your first tool' });
    expect(card).toHaveTextContent('Pick a provider here.');
    expect(card).toHaveTextContent('Step 1 of 2');
    await waitFor(() => expect(card).toHaveFocus());
  });

  it('leaves the highlighted control clickable', async () => {
    renderSpotlight();
    await screen.findByRole('dialog', { name: 'Connect your first tool' });

    const scrim = document.querySelector('.onboarding-spotlight-scrim');
    expect(scrim).not.toBeNull();
    // The overlay guides without trapping: only the coach mark takes pointer
    // events, so the member can act on the control or ignore it entirely.
    expect(document.querySelector('.onboarding-spotlight')).toHaveStyle({ pointerEvents: 'none' });
    fireEvent.click(screen.getByRole('button', { name: 'Connect Linear' }));
  });

  it('shows nothing in a window that does not host the anchor', async () => {
    renderSpotlight({}, null);

    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows nothing when no step is being guided', async () => {
    renderSpotlight({ activeStep: null, checklist: { ...checklist, activeStepId: null } });

    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('stops guiding on escape, on Not now, and on the close control', async () => {
    const value = renderSpotlight();
    await screen.findByRole('dialog', { name: 'Connect your first tool' });

    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop guiding me' }));

    expect(value.clearActiveStep).toHaveBeenCalledTimes(3);
  });

  it('marks the guided step done from the coach mark', async () => {
    const value = renderSpotlight();
    await screen.findByRole('dialog', { name: 'Connect your first tool' });

    fireEvent.click(screen.getByRole('button', { name: /Mark as done/u }));

    expect(value.setStepState).toHaveBeenCalledWith('connect-tools', 'completed');
  });
});
