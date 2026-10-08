import { onlineManager, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { LOW_QUOTA_PERCENT, OrganizationUsageSchema, PLANS, type OrganizationUsage, type PlanId } from '@rally/contracts/usage';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { RallyApi } from './api';
import { defineLocalCacheSlice, localCacheEpoch } from './local-cache';
import { useLocalCacheScope } from './local-cache-scope';

/**
 * The Organization's usage meter as this device last read it.
 *
 * `GET /workspace/usage` is a plain REST read: a figure that may lag by minutes
 * gains nothing from a push as usage accrues. So the reader fetches when a
 * surface that shows it opens, the Usage section of Settings or the
 * Organization menu, and paints the last answer this device saw while it waits.
 * A plan change is the exception: it moves the quota at once, so the API sends
 * the new meter on the workspace socket (`workspace_usage`) to every member,
 * and `applyPushedOrganizationUsage` writes it in.
 * `docs/local-cache.md` owns the `usage` slice; the usage quota PRD
 * (`docs/PRDs/2026-10-03_usage-quota-metering/prd.md`) owns what each state says.
 */

/** The surface only needs this one call, not the whole renderer client. */
export type OrganizationUsageApi = Pick<RallyApi, 'getWorkspaceUsage'>;

/** What Settings needs on top of the read: an administrator choosing the plan. */
export type OrganizationPlanApi = OrganizationUsageApi & Pick<RallyApi, 'setWorkspacePlan'>;

/** One answer and when it arrived, which is what the offline label names. */
export interface UsageReading {
  usage: OrganizationUsage;
  fetchedAt: string;
}

const USAGE_KEY = 'usage';

function parseUsageReading(value: unknown): UsageReading | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Record<string, unknown>;
  const usage = OrganizationUsageSchema.safeParse(candidate['usage']);
  const fetchedAt = candidate['fetchedAt'];
  if (!usage.success || typeof fetchedAt !== 'string' || Number.isNaN(Date.parse(fetchedAt))) return null;
  return { usage: usage.data, fetchedAt };
}

/**
 * One row per Organization scope. The response is parsed with the same schema
 * the API client uses, so a row this build cannot read is dropped on read
 * rather than painted.
 */
export const usageCacheSlice = defineLocalCacheSlice<UsageReading>({
  kind: 'usage',
  version: 1,
  parse: parseUsageReading,
});

/** Keyed by the cache scope (user, region, workspace), so a switch never reads another Organization's answer. */
export function organizationUsageQueryKey(scope: string | null): readonly ['workspace-usage', string | null] {
  return ['workspace-usage', scope] as const;
}

/**
 * Write a meter the workspace socket pushed after a plan change into the read
 * and the cache, so an open meter repaints with no request and a closed one
 * opens on it. A read already in flight is cancelled first: it may have seen
 * the old plan, and landing after the push would revert it.
 */
export function applyPushedOrganizationUsage(
  queryClient: QueryClient,
  scope: string | null,
  usage: OrganizationUsage,
): void {
  const key = organizationUsageQueryKey(scope);
  const epoch = localCacheEpoch();
  const reading = { usage, fetchedAt: new Date().toISOString() };
  void queryClient.cancelQueries({ queryKey: key });
  queryClient.setQueryData(key, reading);
  if (scope) void usageCacheSlice.write(scope, USAGE_KEY, reading, USAGE_KEY, epoch);
}

export type OrganizationUsageState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; reading: UsageReading; offline: boolean };

const subscribeOnline = (notify: () => void): (() => void) => onlineManager.subscribe(notify);
const readOnline = (): boolean => onlineManager.isOnline();

/**
 * Reads usage when the surface calling it mounts, and paints the cached row
 * until the answer lands. A cached row seeds only an empty query: an answer
 * already in memory from earlier in the session is newer than anything on disk.
 */
export function useOrganizationUsage(api: OrganizationUsageApi | null): OrganizationUsageState & { retry: () => void } {
  const scope = useLocalCacheScope();
  const online = useSyncExternalStore(subscribeOnline, readOnline);
  const [seed, setSeed] = useState<UsageReading | null>(null);
  const query = useQuery({
    queryKey: organizationUsageQueryKey(scope),
    queryFn: async ({ signal }): Promise<UsageReading> => {
      // Stated before the request so a sign-out while it is in flight drops
      // the write rather than restoring a row the wipe removed.
      const epoch = localCacheEpoch();
      const usage = await api!.getWorkspaceUsage(signal);
      const reading = { usage, fetchedAt: new Date().toISOString() };
      // A read cancelled for a plan change predates it; keep it off disk.
      if (scope && !signal.aborted) void usageCacheSlice.write(scope, USAGE_KEY, reading, USAGE_KEY, epoch);
      return reading;
    },
    enabled: Boolean(api),
    // Opening the surface is the refresh; only a plan change is pushed.
    refetchOnMount: 'always',
  });

  useEffect(() => {
    // A seed belongs to one scope; never paint it under another.
    setSeed(null);
    if (!scope) return undefined;
    let current = true;
    const epoch = localCacheEpoch();
    void usageCacheSlice.read(scope, USAGE_KEY).then((row) => {
      if (current && row && epoch === localCacheEpoch()) setSeed(row);
    });
    return () => { current = false; };
  }, [scope]);

  const { refetch } = query;
  // Stable, so a caller can refresh from an effect without refetching on every render.
  const retry = useCallback((): void => { void refetch(); }, [refetch]);
  const reading = query.data ?? seed;
  const offline = !online || query.fetchStatus === 'paused';
  if (offline) return reading ? { status: 'ready', reading, offline: true, retry } : { status: 'error', retry };
  if (query.isError && !query.isFetching) return { status: 'error', retry };
  return reading ? { status: 'ready', reading, offline: false, retry } : { status: 'loading', retry };
}

/**
 * Moves the Organization to a plan. The answer is the meter under the new plan,
 * written straight into the read and the cache, so the section repaints at once
 * without a second request. A read already in flight is cancelled first: it
 * may have seen the old plan, and landing after the change would revert it.
 */
export function useSetOrganizationPlan(api: OrganizationPlanApi | null) {
  const scope = useLocalCacheScope();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (plan: PlanId): Promise<UsageReading> => {
      await queryClient.cancelQueries({ queryKey: organizationUsageQueryKey(scope) });
      const epoch = localCacheEpoch();
      const usage = await api!.setWorkspacePlan(plan);
      const reading = { usage, fetchedAt: new Date().toISOString() };
      if (scope) void usageCacheSlice.write(scope, USAGE_KEY, reading, USAGE_KEY, epoch);
      return reading;
    },
    onSuccess: (reading) => queryClient.setQueryData(organizationUsageQueryKey(scope), reading),
  });
}

export function usageTone(usage: OrganizationUsage): 'normal' | 'warning' {
  return usage.quotaRemainingPercent < LOW_QUOTA_PERCENT ? 'warning' : 'normal';
}

export function usagePlanLabel(plan: PlanId): string {
  return `${PLANS[plan].name} plan`;
}

/** "$100 a month", under each plan in the picker. */
export function usagePlanPriceLabel(plan: PlanId): string {
  return `$${PLANS[plan].monthlyPriceUsd} a month`;
}

/** The value under the meter on the Weekly quota row in Settings. */
export function usageRemainingLabel(percent: number): string {
  return percent === 0 ? 'All used' : `${percent}% left`;
}

/** The one line under the active Organization in its menu. */
export function usageMenuLabel(percent: number): string {
  return percent === 0 ? 'Quota used this week' : `${percent}% left this week`;
}

// Formatters are built per call rather than at module load so they follow the
// viewer's time zone as it is now, not as it was when the module loaded.
function timeOfDay(at: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at);
}

/** "Resets Thursday, October 8 at 9:00 AM", in the viewer's local time. */
export function usageResetLabel(weekResetsAt: string): string {
  const at = new Date(weekResetsAt);
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(at);
  return `Resets ${day} at ${timeOfDay(at)}`;
}

/** "as of 2:14 PM": when the figure on screen was read. */
export function usageAsOfLabel(fetchedAt: string): string {
  return `as of ${timeOfDay(new Date(fetchedAt))}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "Oct 3 to Nov 2". The period ends at the next sign-up anniversary, which is
 * the first instant of the next period, so the last day named is the day before.
 */
export function usagePeriodLabel(periodStart: string, periodEndsAt: string): string {
  const format = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  return `${format.format(new Date(periodStart))} to ${format.format(new Date(Date.parse(periodEndsAt) - DAY_MS))}`;
}

/** Micro-USD as dollars and cents: 12_400_000 is "$12.40". */
export function formatMicrousd(amountMicrousd: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amountMicrousd / 1_000_000);
}
