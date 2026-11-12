import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OrganizationBilling } from './organization-billing';
import type { OrganizationPlanApi } from '../lib/organization-usage';
const openExternal = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../lib/platform', () => ({ desktopBridge: () => ({ openExternal }) }));

describe('hosted billing handoff', () => {
  it('waits for a direct link click after an arbitrarily slow checkout response', async () => {
    let answer!: (value: { url: string }) => void;
    const api: OrganizationPlanApi = { getWorkspaceUsage: vi.fn(), setWorkspacePlan: vi.fn(),
      createBillingCheckout: vi.fn(() => new Promise<{ url: string }>((resolve) => { answer = resolve; })) };
    render(<OrganizationBilling api={api} currentPlan="Start plan" billing={{ enabled: true, status: 'none', subscribed: false,
      trialEndsAt: '2020-01-01T00:00:00Z', overageEnabled: false, offers: [{ id: 'start', name: 'Start', plan: 'starter', currencies: ['usd'], overageAvailable: true }] }} />);
    fireEvent.click(screen.getByText('Continue to checkout'));
    expect(openExternal).not.toHaveBeenCalled();
    answer({ url: 'https://checkout.stripe.com/test' });
    const link = await screen.findByRole('link', { name: 'Open Stripe' });
    expect(openExternal).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(openExternal).toHaveBeenCalledWith('https://checkout.stripe.com/test');
  });
});

it('hides a prepared checkout when subscription state changes to portal management', async () => {
  const api: OrganizationPlanApi = { getWorkspaceUsage: vi.fn(), setWorkspacePlan: vi.fn(),
    createBillingCheckout: vi.fn(async () => ({ url: 'https://checkout.stripe.com/old' })),
    createBillingPortal: vi.fn(async () => ({ url: 'https://billing.stripe.com/new' })) };
  const billing = { enabled: true as const, status: 'none', subscribed: false, trialEndsAt: '2020-01-01T00:00:00Z',
    overageEnabled: false, offers: [{ id: 'start', name: 'Start', plan: 'starter' as const, currencies: ['usd'], overageAvailable: false }] };
  const view = render(<OrganizationBilling api={api} currentPlan="Start plan" billing={billing} />);
  fireEvent.click(screen.getByText('Continue to checkout'));
  expect(await screen.findByRole('link', { name: 'Open Stripe' })).toHaveAttribute('href', 'https://checkout.stripe.com/old');
  view.rerender(<OrganizationBilling api={api} currentPlan="Grow plan" billing={{ ...billing, subscribed: true, status: 'active' }} />);
  expect(screen.queryByRole('link', { name: 'Open Stripe' })).toBeNull();
  view.rerender(<OrganizationBilling api={api} currentPlan="Start plan" billing={billing} />);
  expect(screen.queryByRole('link', { name: 'Open Stripe' })).toBeNull();
  view.rerender(<OrganizationBilling api={api} currentPlan="Grow plan" billing={{ ...billing, subscribed: true, status: 'active' }} />);
  fireEvent.click(screen.getByText('Manage billing'));
  expect(await screen.findByRole('link', { name: 'Open Stripe' })).toHaveAttribute('href', 'https://billing.stripe.com/new');
  view.rerender(<OrganizationBilling api={api} currentPlan="Start plan" billing={billing} />);
  expect(screen.queryByRole('link', { name: 'Open Stripe' })).toBeNull();
});
