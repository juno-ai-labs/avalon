import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OrganizationUsage } from '@rally/contracts/usage';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllLocalCache } from '../lib/local-cache';
import { LocalCacheScopeProvider } from '../lib/local-cache-scope';
import { usageCacheSlice, type OrganizationPlanApi, type OrganizationUsageApi } from '../lib/organization-usage';
import { OrganizationUsageMenuItem, UsageSettingsSection } from './organization-usage';

const SCOPE = 'user-1:global:workspace-1';

function usage(quotaRemainingPercent: number, amountMicrousd = 0): OrganizationUsage {
  return {
    plan: 'starter',
    quotaRemainingPercent,
    weekResetsAt: '2026-10-08T09:00:00.000Z',
    overage: {
      amountMicrousd,
      periodStart: '2026-10-03T09:00:00.000Z',
      periodEndsAt: '2026-11-03T09:00:00.000Z',
      billed: false,
    },
  };
}

function apiAnswering(...answers: Array<OrganizationUsage | Error>): OrganizationPlanApi & {
  getWorkspaceUsage: ReturnType<typeof vi.fn>;
  setWorkspacePlan: ReturnType<typeof vi.fn>;
} {
  let call = 0;
  return {
    getWorkspaceUsage: vi.fn(async () => {
      const answer = answers[Math.min(call, answers.length - 1)]!;
      call += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    }),
    setWorkspacePlan: vi.fn(async () => { throw new Error('not expected'); }),
  };
}

/** A request that never answers: what the screen shows while it waits. */
const pendingApi: OrganizationPlanApi = {
  getWorkspaceUsage: () => new Promise(() => undefined),
  setWorkspacePlan: () => new Promise(() => undefined),
};

function wrap(children: ReactNode, scope: string | null = SCOPE): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = <QueryClientProvider client={client}><Tooltip.Provider>{children}</Tooltip.Provider></QueryClientProvider>;
  return scope ? <LocalCacheScopeProvider scope={scope}>{tree}</LocalCacheScopeProvider> : tree;
}

function renderSection(api: OrganizationPlanApi, scope: string | null = SCOPE, canChangePlan = true): void {
  render(wrap(<UsageSettingsSection api={api} canChangePlan={canChangePlan} organizationName="Juno Labs" />, scope));
}

beforeEach(async () => {
  vi.stubEnv('TZ', 'UTC');
  await clearAllLocalCache();
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('Usage in Settings', () => {
  it("never shows the previous Organization's usage after a switch", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (scope: string, api: OrganizationPlanApi) => (
      <LocalCacheScopeProvider scope={scope}>
        <QueryClientProvider client={client}><Tooltip.Provider>
          <UsageSettingsSection api={api} canChangePlan organizationName="Juno Labs" />
        </Tooltip.Provider></QueryClientProvider>
      </LocalCacheScopeProvider>
    );
    const { rerender } = render(tree(SCOPE, apiAnswering(usage(72))));
    expect(await screen.findByText('72% left')).toBeVisible();

    rerender(tree('user-1:global:workspace-2', pendingApi));

    expect(await screen.findByText('Checking usage…')).toBeVisible();
    expect(screen.queryByText('72% left')).not.toBeInTheDocument();
  });

  it('shows the plan, the meter and when the week resets', async () => {
    renderSection(apiAnswering(usage(72)));

    const meter = await screen.findByRole('meter', { name: 'Weekly quota left' });
    expect(meter).toHaveAttribute('aria-valuenow', '72');
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '100');
    expect(meter).not.toHaveClass('meter-warning');
    expect(screen.getByText('Starter plan')).toBeVisible();
    expect(screen.getByText('72% left')).toBeVisible();
    expect(screen.getByText('Resets Thursday, October 8 at 9:00 AM. Shared by everyone in Juno Labs.')).toBeVisible();
    expect(screen.queryByText('Usage beyond quota this month')).not.toBeInTheDocument();
  });

  it('lets an administrator move the Organization to another plan and repaints from the answer', async () => {
    const api = apiAnswering(usage(10));
    api.setWorkspacePlan.mockResolvedValue({ ...usage(44), plan: 'growth' });
    renderSection(api);

    const picker = await screen.findByRole('combobox', { name: 'Plan' });
    expect(picker).toHaveTextContent('Starter plan');
    fireEvent.click(picker);
    expect(screen.getByRole('option', { name: /Growth plan/ })).toHaveTextContent('$250 a month');
    fireEvent.keyDown(screen.getByRole('option', { name: /Growth plan/ }), { key: 'Enter' });

    expect(await screen.findByText('44% left')).toBeVisible();
    expect(api.setWorkspacePlan).toHaveBeenCalledWith('growth');
    expect(screen.getByRole('combobox', { name: 'Plan' })).toHaveTextContent('Growth plan');
    expect(await usageCacheSlice.read(SCOPE, 'usage')).toMatchObject({ usage: { plan: 'growth', quotaRemainingPercent: 44 } });
  });

  it('keeps the new plan when a read that started before the change answers after it', async () => {
    await usageCacheSlice.write(SCOPE, 'usage', { usage: usage(72), fetchedAt: '2026-10-03T14:14:00.000Z' });
    let answerRead: (value: OrganizationUsage) => void = () => undefined;
    const api: OrganizationPlanApi = {
      getWorkspaceUsage: () => new Promise((resolve) => { answerRead = resolve; }),
      setWorkspacePlan: async () => ({ ...usage(44), plan: 'growth' }),
    };
    renderSection(api);

    fireEvent.click(await screen.findByRole('combobox', { name: 'Plan' }));
    fireEvent.keyDown(screen.getByRole('option', { name: /Growth plan/ }), { key: 'Enter' });
    expect(await screen.findByText('44% left')).toBeVisible();

    answerRead(usage(72));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(screen.getByText('44% left')).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Plan' })).toHaveTextContent('Growth plan');
    expect(await usageCacheSlice.read(SCOPE, 'usage')).toMatchObject({ usage: { plan: 'growth' } });
  });

  it('says so when the plan could not be changed and keeps the plan it had', async () => {
    const api = apiAnswering(usage(72));
    api.setWorkspacePlan.mockRejectedValue(new Error('This action requires a workspace administrator'));
    renderSection(api);

    fireEvent.click(await screen.findByRole('combobox', { name: 'Plan' }));
    fireEvent.keyDown(screen.getByRole('option', { name: /Growth plan/ }), { key: 'Enter' });

    expect(await screen.findByText('The plan could not be changed. This action requires a workspace administrator')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.getByRole('combobox', { name: 'Plan' })).toHaveTextContent('Starter plan');
  });

  it('shows the plan to a member who is not an administrator but does not let them change it', async () => {
    renderSection(apiAnswering(usage(72)), SCOPE, false);

    const picker = await screen.findByRole('combobox', { name: 'Plan' });
    expect(picker).toHaveTextContent('Starter plan');
    expect(picker).toBeDisabled();
  });

  it('reads the reset in the viewer’s own time zone', async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    renderSection(apiAnswering(usage(72)));

    expect(await screen.findByText(/^Resets Thursday, October 8 at 2:00 AM./)).toBeVisible();
  });

  it('shows a full meter before anything has been used', async () => {
    renderSection(apiAnswering(usage(100)));

    expect(await screen.findByRole('meter', { name: 'Weekly quota left' })).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText('100% left')).toBeVisible();
  });

  it('turns the meter to the warning colour below 20% left', async () => {
    renderSection(apiAnswering(usage(19)));

    expect(await screen.findByRole('meter', { name: 'Weekly quota left' })).toHaveClass('meter-warning');
  });

  it('keeps the normal colour at exactly 20% left', async () => {
    renderSection(apiAnswering(usage(20)));

    expect(await screen.findByRole('meter', { name: 'Weekly quota left' })).not.toHaveClass('meter-warning');
  });

  it('says the quota is used at 0% and shows this month’s overage struck through and not billed', async () => {
    renderSection(apiAnswering(usage(0, 12_400_000)));

    expect(await screen.findByText('All used')).toBeVisible();
    expect(screen.getByRole('meter', { name: 'Weekly quota left' })).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByText('Usage beyond quota this month')).toBeVisible();
    expect(screen.getByText('Oct 3 to Nov 2')).toBeVisible();
    const amount = screen.getByText('$12.40');
    expect(amount.tagName).toBe('S');

    fireEvent.focus(screen.getByText('Not billed'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent("Rally isn't charging for usage beyond your plan yet.");
  });

  it('explains the Not billed tag on hover as well as focus', async () => {
    renderSection(apiAnswering(usage(40, 1_000_000)));

    fireEvent.pointerMove(await screen.findByText('Not billed'), { pointerType: 'mouse' });

    expect(await screen.findByRole('tooltip')).toHaveTextContent("Rally isn't charging for usage beyond your plan yet.");
  });

  it('draws an empty track and says it is checking while nothing is cached', () => {
    renderSection(pendingApi);

    expect(screen.getByRole('status')).toHaveTextContent('Checking usage…');
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(document.querySelector('.meter .meter-fill')).toBeNull();
  });

  it('paints the cached value right away while the refresh is in flight', async () => {
    await usageCacheSlice.write(SCOPE, 'usage', { usage: usage(55), fetchedAt: '2026-10-03T14:14:00.000Z' });
    renderSection(pendingApi);

    expect(await screen.findByText('55% left')).toBeVisible();
    expect(screen.queryByText(/^as of/u)).not.toBeInTheDocument();
  });

  it('shows the last cached value and when it was read while offline', async () => {
    await usageCacheSlice.write(SCOPE, 'usage', { usage: usage(55), fetchedAt: '2026-10-03T14:14:00.000Z' });
    onlineManager.setOnline(false);
    renderSection(apiAnswering(usage(10)));

    expect(await screen.findByText('55% left')).toBeVisible();
    expect(screen.getByText('as of 2:14 PM')).toBeVisible();
  });

  it('remembers the answer for the next time the section opens', async () => {
    renderSection(apiAnswering(usage(64)));
    await screen.findByText('64% left');

    await waitFor(async () => expect((await usageCacheSlice.read(SCOPE, 'usage'))?.usage.quotaRemainingPercent).toBe(64));
  });

  it('fetches again each time the section opens', async () => {
    const api = apiAnswering(usage(80), usage(61));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const section = <QueryClientProvider client={client}><UsageSettingsSection api={api} canChangePlan organizationName="Juno Labs" /></QueryClientProvider>;
    const first = render(section);
    await screen.findByText('80% left');
    first.unmount();

    render(section);

    expect(await screen.findByText('61% left')).toBeVisible();
    expect(api.getWorkspaceUsage).toHaveBeenCalledTimes(2);
  });

  it('fetches again when its pane is asked for in a window that kept it mounted', async () => {
    const api = apiAnswering(usage(80), usage(61));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const section = (openRequest: number): React.JSX.Element => (
      <QueryClientProvider client={client}>
        <UsageSettingsSection api={api} canChangePlan openRequest={openRequest} organizationName="Juno Labs" />
      </QueryClientProvider>
    );
    const { rerender } = render(section(3));
    await screen.findByText('80% left');

    rerender(section(4));

    expect(await screen.findByText('61% left')).toBeVisible();
    expect(api.getWorkspaceUsage).toHaveBeenCalledTimes(2);
  });

  it('says usage is unavailable and tries again on request', async () => {
    const api = apiAnswering(new Error('Service unavailable'), usage(33));
    renderSection(api);

    expect(await screen.findByText("Usage isn't available right now.")).toBeVisible();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('33% left')).toBeVisible();
    expect(api.getWorkspaceUsage).toHaveBeenCalledTimes(2);
  });
});

describe('Usage in the Organization menu', () => {
  // The line names the reset in local time; pin it so the literals hold on any host.
  beforeEach(() => { vi.stubEnv('TZ', 'UTC'); });

  function renderMenuItem(api: OrganizationUsageApi, onSelect = vi.fn()): ReturnType<typeof vi.fn> {
    render(wrap(
      <DropdownMenu.Root open>
        <DropdownMenu.Trigger>Organization</DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content>
            <DropdownMenu.Item>Juno Labs</DropdownMenu.Item>
            <OrganizationUsageMenuItem api={api} onSelect={onSelect} />
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>,
    ));
    return onSelect;
  }

  it('shows a thin meter and how much is left till the week resets, and opens Settings when chosen', async () => {
    const onSelect = renderMenuItem(apiAnswering(usage(72)));

    const item = await screen.findByRole('menuitem', { name: 'Usage, 72% left till Thu 9:00 AM' });
    expect(within(item).queryByText('Quota')).not.toBeInTheDocument();
    expect(within(item).getByText('72% left till Thu 9:00 AM')).toBeVisible();
    expect(within(item).getByRole('meter', { name: 'Weekly quota left' })).toHaveClass('meter-thin');

    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('says overage is enabled once the quota runs low', async () => {
    renderMenuItem(apiAnswering(usage(19)));

    expect(await screen.findByText('19% left till Thu 9:00 AM, overage enabled')).toBeVisible();
  });

  it('says overage is enabled at 0%', async () => {
    renderMenuItem(apiAnswering(usage(0, 5_000_000)));

    expect(await screen.findByText('0% left till Thu 9:00 AM, overage enabled')).toBeVisible();
    expect(screen.queryByText('Not billed')).not.toBeInTheDocument();
  });

  it('hides the line while loading with nothing cached', () => {
    renderMenuItem(pendingApi);

    expect(screen.getByRole('menuitem', { name: 'Juno Labs' })).toBeVisible();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('menuitem')).toHaveLength(1);
  });

  it('hides the line when usage could not be read, even over a cached value', async () => {
    await usageCacheSlice.write(SCOPE, 'usage', { usage: usage(55), fetchedAt: '2026-10-03T14:14:00.000Z' });
    let fail: (error: Error) => void = () => undefined;
    renderMenuItem({ getWorkspaceUsage: () => new Promise((_, reject) => { fail = reject; }) });
    expect(await screen.findByText('55% left till Thu 9:00 AM')).toBeVisible();

    fail(new Error('Service unavailable'));

    await waitFor(() => expect(screen.queryByText('55% left till Thu 9:00 AM')).not.toBeInTheDocument());
    expect(screen.queryAllByRole('menuitem')).toHaveLength(1);
  });
});
