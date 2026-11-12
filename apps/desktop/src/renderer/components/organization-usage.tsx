import { useLocalCacheScope } from '../lib/local-cache-scope';
import { useQuery } from '@tanstack/react-query';
import { OrganizationBilling } from './organization-billing';
import { ErrorNotice } from './primitives';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { PLAN_IDS, PlanIdSchema } from '@rally/contracts/usage';
import { useEffect, useRef } from 'react';
import { settings } from '../settings/registry';
import { SettingCopy, SettingLabel } from '../settings/setting-label';
import {
  formatMicrousd,
  usageAsOfLabel,
  usageMenuLabel,
  usagePeriodLabel,
  usagePlanLabel,
  usagePlanPriceLabel,
  usageRemainingLabel,
  usageResetLabel,
  usageTone,
  useOrganizationUsage,
  useSetOrganizationPlan,
  type OrganizationPlanApi,
  type OrganizationUsageApi,
  type UsageReading,
} from '../lib/organization-usage';
import { Badge, Button, DropdownSelect, Meter, Tip } from './primitives';
import { IconAlertCircle, IconAlertTriangle } from '@tabler/icons-react';
import { RailItem } from './rail-item';

const METER_LABEL = 'Weekly quota left';
const PLAN_OPTIONS = PLAN_IDS.map((plan) => ({
  value: plan,
  label: usagePlanLabel(plan),
  description: usagePlanPriceLabel(plan),
}));
export const USAGE_TOTAL_EXPLANATION = "This is usage beyond your allowance, not an invoice total. Charges for earlier opted-in usage may still appear after cancellation.";

/**
 * Settings → Organization → Usage. Every member sees it, whatever their role:
 * the quota is shared, so everyone spending it should be able to see it. Only
 * an administrator can change the plan; everyone else sees the picker locked.
 */
export function UsageSettingsSection({ api, canChangePlan, openRequest = 0, organizationName }: {
  api: OrganizationPlanApi | null;
  canChangePlan: boolean;
  /**
   * Counts the requests to open this section's pane. Mounting already fetches;
   * a change after that is the pane being asked for again in a window that
   * kept it mounted, which is an opening too.
   */
  openRequest?: number;
  organizationName: string;
}): React.JSX.Element {
  const state = useOrganizationUsage(api);
  const { retry } = state;
  const mountedRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest !== mountedRequest.current) retry();
  }, [openRequest, retry]);
  return (
    <div className="settings-subsection usage-settings">
      <div className="settings-pane-heading"><h2><SettingLabel setting={settings.usage} /></h2></div>
      <div className="settings-list-card">
        {state.status === 'ready' ? (
          <UsageReadingRows
            api={api}
            canChangePlan={canChangePlan}
            offline={state.offline}
            organizationName={organizationName}
            reading={state.reading}
          />
        ) : state.status === 'loading' ? (
          <div className="settings-preference-row">
            <SettingCopy setting={settings.quota} description={<span role="status">Checking usage…</span>} />
            <span className="usage-quota-value"><Meter label={METER_LABEL} value={null} /></span>
          </div>
        ) : (
          <div className="settings-preference-row">
            <span className="settings-row-copy"><strong>Usage isn't available right now.</strong></span>
            <Button onClick={state.retry}>Try again</Button>
          </div>
        )}
      </div>
    </div>
  );
}

function UsageReadingRows({ api, canChangePlan, offline, organizationName, reading }: {
  api: OrganizationPlanApi | null;
  canChangePlan: boolean;
  offline: boolean;
  organizationName: string;
  reading: UsageReading;
}): React.JSX.Element {
  const { usage, fetchedAt } = reading;
  const setPlan = useSetOrganizationPlan(api);
  const scope = useLocalCacheScope();
  const billing = useQuery({ queryKey: ['organization-billing', scope], queryFn: () => api!.getBillingStatus!(), enabled: canChangePlan && Boolean(api?.getBillingStatus), refetchOnWindowFocus: false });
  useEffect(() => {
    if (!canChangePlan || !api?.getBillingStatus) return;
    const refresh = () => { void billing.refetch(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [api, canChangePlan, billing.refetch]);
  return <>
    {billing.data?.enabled && api ? <OrganizationBilling api={api} billing={billing.data} currentPlan={usagePlanLabel(usage.plan)} /> : <label className="settings-preference-row">
      <SettingCopy
        setting={settings.plan}
        description={setPlan.error
          ? <ErrorNotice>The plan could not be changed. {setPlan.error.message}</ErrorNotice>
          : undefined}
      />
      <DropdownSelect
        ariaLabel="Plan"
        disabled={!canChangePlan || !api || offline || setPlan.isPending || (Boolean(api?.getBillingStatus) && (billing.isError || billing.data?.enabled !== false))}
        onValueChange={(value) => {
          const plan = PlanIdSchema.parse(value);
          if (plan !== usage.plan) setPlan.mutate(plan);
        }}
        options={PLAN_OPTIONS}
        value={setPlan.isPending ? setPlan.variables ?? usage.plan : usage.plan}
        variant="secondary"
      />
    </label>}
    {billing.error && <><ErrorNotice>Billing could not be loaded. {billing.error.message}</ErrorNotice><div className="settings-preference-row"><span className="settings-row-copy"><strong>Billing unavailable</strong><small>Try again to load billing options.</small></span><Button onClick={() => void billing.refetch()} disabled={billing.isFetching}>Retry billing</Button></div></>}
    <div className="settings-preference-row">
      <SettingCopy
        setting={settings.quota}
        description={`${usageResetLabel(usage.weekResetsAt)}. Shared by everyone in ${organizationName}.`}
      />
      <span className="usage-quota-value">
        <Meter label={METER_LABEL} tone={usageTone(usage)} value={usage.quotaRemainingPercent} />
        <small>
          {usageRemainingLabel(usage.quotaRemainingPercent)}
          {offline && <span className="usage-as-of"> {usageAsOfLabel(fetchedAt)}</span>}
        </small>
      </span>
    </div>
    {usage.overage.amountMicrousd > 0 && (
      <div className="settings-preference-row usage-overage">
        <span className="settings-row-copy">
          <strong>Usage beyond quota this month</strong>
          <small>{usagePeriodLabel(usage.overage.periodStart, usage.overage.periodEndsAt)}</small>
        </span>
        <span className="usage-overage-value">
          <span>{formatMicrousd(usage.overage.amountMicrousd)}</span>
          <Tip label={usage.overage.billingEnabled ? "Overage charges appear on a later invoice after usage settles." : USAGE_TOTAL_EXPLANATION} side="top">
            <Badge className="usage-not-billed" tabIndex={0}>{usage.overage.billingEnabled ? "Overage enabled" : "Usage total"}</Badge>
          </Tip>
        </span>
      </div>
    )}
  </>;
}

/**
 * The thin meter under the active Organization's row in the Organization menu.
 * It mounts with the menu's content, so opening the menu is what refreshes it.
 * With nothing to show, loading or failed, it renders nothing rather than a
 * placeholder line in a menu.
 */
export function OrganizationUsageMenuItem({ api, onSelect }: {
  api: OrganizationUsageApi | null;
  onSelect: () => void;
}): React.JSX.Element | null {
  const state = useOrganizationUsage(api);
  if (state.status !== 'ready') return null;
  const { usage } = state.reading;
  const line = usageMenuLabel(usage);
  return (
    <DropdownMenu.Item aria-label={`Usage, ${line}`} className="menu-item workspace-usage-item" onSelect={onSelect}>
      <Meter label={METER_LABEL} size="thin" tone={usageTone(usage)} value={usage.quotaRemainingPercent} />
      <small>{line}</small>
    </DropdownMenu.Item>
  );
}

/**
 * At or below this share of the week's allowance left, the rail warns ahead of
 * the stop. The number is the product owner's (set 2026-11-12), not derived.
 */
export const USAGE_LOW_WARNING_PERCENT = 10;

/**
 * The rail's usage warning, above the account tile: red while new work is
 * refused, yellow at or below `USAGE_LOW_WARNING_PERCENT` while running out
 * would stop work. Driven by the server's admission decision, never re-derived.
 */
export function UsageLimitRailWarning({ api, onOpen }: {
  api: OrganizationUsageApi | null;
  onOpen: () => void;
}): React.JSX.Element | null {
  const state = useOrganizationUsage(api);
  if (state.status !== 'ready') return null;
  const { usage } = state.reading;
  const reset = `${usageResetLabel(usage.weekResetsAt)}.`;
  const warning = usage.allowanceExhausted === true
    ? {
        level: 'exhausted',
        name: 'Usage limit reached',
        explanation: `This week's included usage is used up and overage billing is off, so Rally, Sidekicks and background agents are paused. An administrator can turn on overage billing in Settings. ${reset}`,
      }
    : usage.stopsAtAllowance === true && usage.quotaRemainingPercent <= USAGE_LOW_WARNING_PERCENT
      ? {
          level: 'low',
          name: 'Usage running low',
          explanation: `${usage.quotaRemainingPercent}% of this week's included usage is left. When it runs out, Rally, Sidekicks and background agents pause unless an administrator turns on overage billing in Settings. ${reset}`,
        }
      : null;
  if (!warning) return null;
  const Icon = warning.level === 'exhausted' ? IconAlertCircle : IconAlertTriangle;
  return (
    <Tip describesTrigger={false} label={warning.explanation} side="right">
      <RailItem
        aria-label={`${warning.name}. ${warning.explanation}`}
        className="navigation-rail-usage-warning"
        icon={<Icon aria-hidden="true" className={`navigation-rail-usage-warning-icon is-${warning.level}`} size={22} stroke={1.9} />}
        label="Usage"
        onClick={onOpen}
      />
    </Tip>
  );
}
