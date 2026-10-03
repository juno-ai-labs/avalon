import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OrganizationUsage } from '@rally/contracts/usage';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllLocalCache } from '../lib/local-cache';
import { LocalCacheScopeProvider } from '../lib/local-cache-scope';
import { usageCacheSlice, type OrganizationUsageApi } from '../lib/organization-usage';
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

function apiAnswering(...answers: Array<OrganizationUsage | Error>): OrganizationUsageApi & { getWorkspaceUsage: ReturnType<typeof vi.fn> } {
  let call = 0;
  return {
    getWorkspaceUsage: vi.fn(async () => {
      const answer = answers[Math.min(call, answers.length - 1)]!;
      call += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  };
}

/** A request that never answers: what the screen shows while it waits. */
const pendingApi: OrganizationUsageApi = { getWorkspaceUsage: () => new Promise(() => undefined) };

function wrap(children: ReactNode, scope: string | null = SCOPE): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = <QueryClientProvider client={client}><Tooltip.Provider>{children}</Tooltip.Provider></QueryClientProvider>;
  return scope ? <LocalCacheScopeProvider scope={scope}>{tree}</LocalCacheScopeProvider> : tree;
}

function renderSection(api: OrganizationUsageApi, scope: string | null = SCOPE): void {
  render(wrap(<UsageSettingsSection api={api} organizationName="Juno Labs" />, scope));
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
    const tree = (scope: string, api: OrganizationUsageApi) => (
      <LocalCacheScopeProvider scope={scope}>
        <QueryClientProvider client={client}><Tooltip.Provider>
          <UsageSettingsSection api={api} organizationName="Juno Labs" />
        </Tooltip.Provider></QueryClientProvider>
      </LocalCacheScopeProvider>
    );
    const { rerender } = render(tree(SCOPE, apiAnswering(usage(72))));
    expect(await screen.findByText("72% of this week's quota left")).toBeVisible();

    rerender(tree('user-1:global:workspace-2', pendingApi));

    expect(await screen.findByText('Checking usage…')).toBeVisible();
    expect(screen.queryByText("72% of this week's quota left")).not.toBeInTheDocument();
  });

  it('shows the plan, the meter and when the week resets', async () => {
    renderSection(apiAnswering(usage(72)));

    const meter = await screen.findByRole('meter', { name: 'Weekly quota left' });
    expect(meter).toHaveAttribute('aria-valuenow', '72');
    expect(meter).toHaveAttribute('aria-valuemin', '0');
    expect(meter).toHaveAttribute('aria-valuemax', '100');
    expect(meter).not.toHaveClass('meter-warning');
    expect(screen.getByText('Starter plan')).toBeVisible();
    expect(screen.getByText("72% of this week's quota left")).toBeVisible();
    expect(screen.getByText('Resets Thursday, October 8 at 9:00 AM')).toBeVisible();
    expect(screen.getByText('Shared by everyone in Juno Labs.')).toBeVisible();
    expect(screen.queryByText('Usage beyond quota this month')).not.toBeInTheDocument();
  });

  it('reads the reset in the viewer’s own time zone', async () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    renderSection(apiAnswering(usage(72)));

    expect(await screen.findByText('Resets Thursday, October 8 at 2:00 AM')).toBeVisible();
  });

  it('shows a full meter before anything has been used', async () => {
    renderSection(apiAnswering(usage(100)));

    expect(await screen.findByRole('meter', { name: 'Weekly quota left' })).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText("100% of this week's quota left")).toBeVisible();
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

    expect(await screen.findByText('Quota used for this week')).toBeVisible();
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

    expect(await screen.findByText("55% of this week's quota left")).toBeVisible();
    expect(screen.queryByText(/^as of/u)).not.toBeInTheDocument();
  });

  it('shows the last cached value and when it was read while offline', async () => {
    await usageCacheSlice.write(SCOPE, 'usage', { usage: usage(55), fetchedAt: '2026-10-03T14:14:00.000Z' });
    onlineManager.setOnline(false);
    renderSection(apiAnswering(usage(10)));

    expect(await screen.findByText("55% of this week's quota left")).toBeVisible();
    expect(screen.getByText('as of 2:14 PM')).toBeVisible();
  });

  it('remembers the answer for the next time the section opens', async () => {
    renderSection(apiAnswering(usage(64)));
    await screen.findByText("64% of this week's quota left");

    await waitFor(async () => expect((await usageCacheSlice.read(SCOPE, 'usage'))?.usage.quotaRemainingPercent).toBe(64));
  });

  it('fetches again each time the section opens', async () => {
    const api = apiAnswering(usage(80), usage(61));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const section = <QueryClientProvider client={client}><UsageSettingsSection api={api} organizationName="Juno Labs" /></QueryClientProvider>;
    const first = render(section);
    await screen.findByText("80% of this week's quota left");
    first.unmount();

    render(section);

    expect(await screen.findByText("61% of this week's quota left")).toBeVisible();
    expect(api.getWorkspaceUsage).toHaveBeenCalledTimes(2);
  });

  it('fetches again when its pane is asked for in a window that kept it mounted', async () => {
    const api = apiAnswering(usage(80), usage(61));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const section = (openRequest: number): React.JSX.Element => (
      <QueryClientProvider client={client}>
        <UsageSettingsSection api={api} openRequest={openRequest} organizationName="Juno Labs" />
      </QueryClientProvider>
    );
    const { rerender } = render(section(3));
    await screen.findByText("80% of this week's quota left");

    rerender(section(4));

    expect(await screen.findByText("61% of this week's quota left")).toBeVisible();
    expect(api.getWorkspaceUsage).toHaveBeenCalledTimes(2);
  });

  it('says usage is unavailable and tries again on request', async () => {
    const api = apiAnswering(new Error('Service unavailable'), usage(33));
    renderSection(api);

    expect(await screen.findByText("Usage isn't available right now.")).toBeVisible();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText("33% of this week's quota left")).toBeVisible();
    expect(api.getWorkspaceUsage).toHaveBeenCalledTimes(2);
  });
});

describe('Usage in the Organization menu', () => {
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

  it('shows a thin meter and how much is left this week, and opens Settings when chosen', async () => {
    const onSelect = renderMenuItem(apiAnswering(usage(72)));

    const item = await screen.findByRole('menuitem', { name: 'Usage, 72% left this week' });
    expect(within(item).getByText('72% left this week')).toBeVisible();
    expect(within(item).getByRole('meter', { name: 'Weekly quota left' })).toHaveClass('meter-thin');

    fireEvent.click(item);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('says the quota is used at 0%', async () => {
    renderMenuItem(apiAnswering(usage(0, 5_000_000)));

    expect(await screen.findByText('Quota used this week')).toBeVisible();
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
    expect(await screen.findByText('55% left this week')).toBeVisible();

    fail(new Error('Service unavailable'));

    await waitFor(() => expect(screen.queryByText('55% left this week')).not.toBeInTheDocument());
    expect(screen.queryAllByRole('menuitem')).toHaveLength(1);
  });
});
