import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BillingCredits } from '@rally/contracts/billing';
import { LocalCacheScopeProvider } from '../lib/local-cache-scope';
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

it('reads remaining credits from Stripe on demand and shows an explicit error on refresh failure', async () => {
  const api: OrganizationPlanApi = { getWorkspaceUsage: vi.fn(), setWorkspacePlan: vi.fn(),
    getBillingCredits: vi.fn().mockResolvedValueOnce({ enabled: true, currency: 'usd', availableCents: 7500,
      grants: [{ id: 'credgr_1', amountCents: 10000, availableCents: 7500, effectiveAt: '2026-01-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z', voided: false }] }).mockRejectedValueOnce(new Error('Stripe is unavailable')) };
  render(<OrganizationBilling api={api} currentPlan="Grow plan" billing={{ enabled: true, status: 'active', subscribed: true,
    trialEndsAt: '2020-01-01T00:00:00Z', overageEnabled: true, offers: [], creditsAvailable: true }} />);
  expect(api.getBillingCredits).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'View credits' }));
  expect(await screen.findByText('$75.00 available for overage invoices. Subscription fees and included usage stay unchanged.')).toBeVisible();
  expect(screen.getByText('$100.00 credit')).toBeVisible();
  expect(screen.queryByRole('button', { name: /grant/i })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh credits' }));
  expect(await screen.findByText('Stripe is unavailable')).toBeVisible();
  expect(screen.queryByText('$100.00 credit')).toBeNull();
});


it('discards an in-flight credit balance when switching organizations', async () => {
  let resolve!: (credits: BillingCredits) => void;
  const api: OrganizationPlanApi = { getWorkspaceUsage: vi.fn(), setWorkspacePlan: vi.fn(),
    getBillingCredits: vi.fn(() => new Promise<BillingCredits>((done) => { resolve = done; })) };
  const billing = { enabled: true as const, status: 'active', subscribed: true, trialEndsAt: '2020-01-01T00:00:00Z', overageEnabled: true, offers: [], creditsAvailable: true };
  const view = render(<LocalCacheScopeProvider scope="org-a"><OrganizationBilling api={api} currentPlan="Grow plan" billing={billing} /></LocalCacheScopeProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'View credits' }));
  view.rerender(<LocalCacheScopeProvider scope="org-b"><OrganizationBilling api={api} currentPlan="Grow plan" billing={billing} /></LocalCacheScopeProvider>);
  resolve({ enabled: true, currency: 'usd', availableCents: 99900, grants: [] });
  expect(await screen.findByRole('button', { name: 'View credits' })).toBeVisible();
  expect(screen.queryByText(/999/)).toBeNull();
});

it('explains the automatic trial, collects billing details in Stripe, and enables overages only when ready', async () => {
  const api: OrganizationPlanApi = { getWorkspaceUsage: vi.fn(), setWorkspacePlan: vi.fn(),
    createBillingPortal: vi.fn(async () => ({ url: 'https://billing.stripe.com/card' })),
    setBillingOverages: vi.fn(async enabled => ({ enabled })) };
  const billing = { enabled: true as const, subscribed: true, status: 'trialing', trialEndsAt: '2027-03-31T10:30:00Z',
    overageEnabled: false, overageAvailable: true, paymentMethodReady: false, offers: [] };
  const view = render(<OrganizationBilling api={api} currentPlan="Grow" billing={billing} />);
  expect(screen.getByText(/Without billing details, your organization returns to Start/)).toBeVisible();
  expect(screen.getByRole('checkbox')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Add billing details' }));
  expect(await screen.findByRole('link', { name: 'Open Stripe' })).toHaveAttribute('href', 'https://billing.stripe.com/card');
  view.rerender(<OrganizationBilling api={api} currentPlan="Grow" billing={{ ...billing, paymentMethodReady: true }} />);
  expect(screen.getByRole('checkbox')).toBeEnabled();
  fireEvent.click(screen.getByRole('checkbox'));
  expect(api.setBillingOverages).toHaveBeenCalledWith(true);
  expect(await screen.findByRole('checkbox', { checked: true })).toBeChecked();
});
