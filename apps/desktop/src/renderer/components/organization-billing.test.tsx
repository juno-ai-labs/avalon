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
