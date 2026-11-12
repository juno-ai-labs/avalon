import "../../../../../tests/isolated-region";
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingCredits } from '@rally/contracts/billing';
import { LocalCacheScopeProvider } from '../lib/local-cache-scope';
import { OrganizationBilling } from './organization-billing';
import type { OrganizationPlanApi } from '../lib/organization-usage';
import type { RallyDesktopBridge } from '../../common/desktop';
const openExternal = vi.fn<(url: string) => Promise<void>>(async () => undefined);
const bridge = { openExternal } satisfies Pick<RallyDesktopBridge, 'openExternal'>;
let native: Pick<RallyDesktopBridge, 'openExternal'> | undefined;

const billing = { enabled: true as const, status: 'none', subscribed: false, trialEndsAt: '2020-01-01T00:00:00Z',
  overageEnabled: false, offers: [{ id: 'grow', name: 'Grow', plan: 'growth' as const, currencies: ['usd'], overageAvailable: true }] };
const checkoutUrl = 'https://checkout.stripe.com/test';
function deferredCheckout() {
  let answer!: (value: { url: string }) => void;
  const api: OrganizationPlanApi = { getWorkspaceUsage: vi.fn(), setWorkspacePlan: vi.fn(),
    createBillingCheckout: vi.fn(() => new Promise<{ url: string }>((resolve) => { answer = resolve; })) };
  return { api, answer: () => answer({ url: checkoutUrl }) };
}
function browserTab() {
  native = undefined;
  const tab = { opener: window as Window | null, location: { href: '' }, document: document.implementation.createHTMLDocument(), closed: false, close: vi.fn() };
  const open = vi.mocked(window.open).mockReturnValue(tab as unknown as Window);
  return { tab, open };
}
beforeEach(() => {
  openExternal.mockReset();
  native = bridge;
  Object.defineProperty(window, 'rally', { configurable: true, get: () => native });
  vi.spyOn(window, 'open');
});

afterEach(() => { delete window.rally; });

describe('hosted billing handoff', () => {
  it('opens checkout immediately when a slow response arrives, with no second action', async () => {
    const { api, answer } = deferredCheckout();
    render(<OrganizationBilling api={api} currentPlan="Start plan" billing={billing} />);
    const action = screen.getByRole('button', { name: 'Continue to checkout' });
    fireEvent.click(action);
    expect(api.createBillingCheckout).toHaveBeenCalledWith('grow', 'usd', false);
    expect(screen.getByRole('button', { name: 'Opening…' })).toBeDisabled();
    expect(openExternal).not.toHaveBeenCalled();
    answer();
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(checkoutUrl));
    expect(screen.queryByText('Secure billing is ready')).toBeNull();
    expect(screen.queryByText('Open Stripe')).toBeNull();
    expect(action).toBeEnabled();
  });

  it('opens portal management from the same action', async () => {
    const api: OrganizationPlanApi = { getWorkspaceUsage: vi.fn(), setWorkspacePlan: vi.fn(),
      createBillingPortal: vi.fn(async () => ({ url: 'https://billing.stripe.com/test' })) };
    render(<OrganizationBilling api={api} currentPlan="Grow plan" billing={{ ...billing, subscribed: true, status: 'active' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage billing' }));
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://billing.stripe.com/test'));
  });

  it('reserves a browser tab on the initial click and navigates it after checkout returns', async () => {
    const { tab, open } = browserTab();
    const { api, answer } = deferredCheckout();
    render(<OrganizationBilling api={api} currentPlan="Start plan" billing={billing} />);
    const action = screen.getByRole('button', { name: 'Continue to checkout' });
    fireEvent.click(action);
    expect(open).toHaveBeenCalledOnce();
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe('');
    expect(tab.document.title).toBe('Opening link…');
    expect(tab.document.body.textContent).toBe('Opening link…');
    answer();
    await waitFor(() => expect(tab.location.href).toBe(checkoutUrl));
    expect(openExternal).not.toHaveBeenCalled();
    expect(tab.close).not.toHaveBeenCalled();
  });

  it('reports a blocked tab before requesting checkout and allows retry', async () => {
    const { open } = browserTab();
    open.mockReturnValue(null);
    const { api } = deferredCheckout();
    render(<OrganizationBilling api={api} currentPlan="Start plan" billing={billing} />);
    const action = screen.getByRole('button', { name: 'Continue to checkout' });
    fireEvent.click(action);
    expect(await screen.findByText('Allow pop-ups for Rally in this browser, then try again.')).toBeVisible();
    expect(api.createBillingCheckout).not.toHaveBeenCalled();
    expect(action).toBeEnabled();
  });

  it('closes the reserved tab and reports a failed checkout request', async () => {
    const { tab } = browserTab();
    const api: OrganizationPlanApi = { getWorkspaceUsage: vi.fn(), setWorkspacePlan: vi.fn(),
      createBillingCheckout: vi.fn().mockRejectedValue(new Error('Stripe is unavailable')) };
    render(<OrganizationBilling api={api} currentPlan="Start plan" billing={billing} />);
    const action = screen.getByRole('button', { name: 'Continue to checkout' });
    fireEvent.click(action);
    expect(await screen.findByText('Stripe is unavailable')).toBeVisible();
    expect(tab.close).toHaveBeenCalledOnce();
    expect(action).toBeEnabled();
  });

  it('reports an external browser launch failure', async () => {
    openExternal.mockRejectedValueOnce(new Error('Browser could not be opened'));
    const { api, answer } = deferredCheckout();
    render(<OrganizationBilling api={api} currentPlan="Start plan" billing={billing} />);
    const action = screen.getByRole('button', { name: 'Continue to checkout' });
    fireEvent.click(action);
    answer();
    expect(await screen.findByText('Browser could not be opened')).toBeVisible();
    expect(action).toBeEnabled();
  });

  it.each(['organization', 'subscription', 'unmount'])('discards a pending handoff on %s change', async (change) => {
    const { tab } = browserTab();
    const { api, answer } = deferredCheckout();
    const form = (scope: string, subscribed: boolean) => <LocalCacheScopeProvider scope={scope}><OrganizationBilling api={api} currentPlan="Start plan" billing={{ ...billing, subscribed }} /></LocalCacheScopeProvider>;
    const view = render(form('org-a', false));
    const action = screen.getByRole('button', { name: 'Continue to checkout' });
    fireEvent.click(action);
    if (change === 'unmount') view.unmount();
    else view.rerender(form(change === 'organization' ? 'org-b' : 'org-a', change === 'subscription'));
    expect(tab.close).toHaveBeenCalledOnce();
    await act(async () => { answer(); });
    expect(tab.location.href).toBe('');
    expect(openExternal).not.toHaveBeenCalled();
  });
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
  await waitFor(() => expect(openExternal).toHaveBeenCalledWith('https://billing.stripe.com/card'));
  expect(screen.queryByText('Open Stripe')).toBeNull();
  view.rerender(<OrganizationBilling api={api} currentPlan="Grow" billing={{ ...billing, paymentMethodReady: true }} />);
  expect(screen.getByRole('checkbox')).toBeEnabled();
  fireEvent.click(screen.getByRole('checkbox'));
  expect(api.setBillingOverages).toHaveBeenCalledWith(true);
  expect(await screen.findByRole('checkbox', { checked: true })).toBeChecked();
});
