import { useLocalCacheScope } from '../lib/local-cache-scope';
import { onlineManager, useQuery, useQueryClient } from '@tanstack/react-query';
import { BillingControl, BillingSkeleton, OrganizationBilling } from './organization-billing';
import { ErrorNotice } from './primitives';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { PLAN_IDS, PlanIdSchema } from '@rally/contracts/usage';
import { useEffect, useRef, useSyncExternalStore } from 'react';
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
} from '../lib/organization-usage';
import { Badge, Button, DropdownSelect, Meter, Tip } from './primitives';

const METER_LABEL = 'Weekly quota left';
const subscribeOnline = (notify: () => void) => onlineManager.subscribe(notify);
const readOnline = () => onlineManager.isOnline();
const PLAN_OPTIONS = PLAN_IDS.map((plan) => ({
  value: plan,
  label: usagePlanLabel(plan),
  description: usagePlanPriceLabel(plan),
}));
export const USAGE_TOTAL_EXPLANATION = "This is usage beyond your allowance, not an invoice total. Charges for earlier opted-in usage may still appear after cancellation.";

/**
 * Settings → Organization → Billing. Every member sees it, whatever their role:
 * the quota is shared, so everyone spending it should be able to see it. Only
 * an administrator can change the plan; everyone else sees the picker locked.
 */
export function UsageSettingsSection({ api, canChangePlan, openRequest = 0, organizationName, billingAccessReason }: {
  api: OrganizationPlanApi | null;
  canChangePlan: boolean;
  openRequest?: number;
  organizationName: string;
  billingAccessReason?: string;
}): React.JSX.Element {
  const state = useOrganizationUsage(api);
  const online = useSyncExternalStore(subscribeOnline, readOnline);
  const { retry } = state;
  const scope = useLocalCacheScope();
  const queryClient = useQueryClient();
  const setPlan = useSetOrganizationPlan(api);
  const billing = useQuery({
    queryKey: ['organization-billing', scope],
    queryFn: () => api!.getBillingStatus!(),
    enabled: Boolean(api?.getBillingStatus) && !billingAccessReason,
    refetchOnWindowFocus: false,
  });
  const { refetch: refreshBilling } = billing;
  useEffect(() => {
    if (!api?.getBillingStatus || billingAccessReason) return;
    const refresh = () => { void refreshBilling(); };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [api, billingAccessReason, refreshBilling]);
  const mountedRequest = useRef(openRequest);
  useEffect(() => {
    if (openRequest === mountedRequest.current) return;
    mountedRequest.current = openRequest;
    retry();
    if (api?.getBillingStatus && !billingAccessReason) void refreshBilling();
    void queryClient.invalidateQueries({ queryKey: ['organization-billing-credits', scope] });
  }, [openRequest, retry, api, billingAccessReason, refreshBilling, queryClient, scope]);
  const reading = state.status === 'ready' ? state.reading : undefined;
  const usage = reading?.usage;
  const offline = !online || (state.status === 'ready' && state.offline);
  const billingLoading = !billingAccessReason && billing.isPending && billing.isFetching;
  const billingDisabledReason = billingAccessReason ?? (offline ? 'Connect to the internet to change billing.'
    : billing.error ? 'Retry loading billing details first.' : undefined);
  const legacyPlan = !api?.getBillingStatus || billing.data?.enabled === false;
  const planReason = billingAccessReason ?? (!canChangePlan ? 'Only organization administrators can change the plan.'
    : !api ? 'The organization is unavailable.' : offline ? 'Connect to the internet to change the plan.'
    : setPlan.isPending ? 'Updating the plan…' : !usage ? 'Wait for usage to load before changing the plan.' : undefined);
  return (
    <div className="settings-subsection usage-settings">
      <div className="settings-pane-heading"><h2><SettingLabel setting={settings.usage} /></h2></div>
      <div className="settings-list-card">
        <OrganizationBilling
          api={api}
          billing={billingAccessReason ? undefined : billing.data}
          currentPlan={usage ? usagePlanLabel(usage.plan) : undefined}
          canManage={canChangePlan}
          loading={billingLoading}
          disabledReason={billingDisabledReason}
          readDisabledReason={billingAccessReason}
          beforePlan={<div className="settings-preference-row">
            <SettingCopy setting={settings.quota} description={usage
              ? `${usageResetLabel(usage.weekResetsAt)}. Shared by everyone in ${organizationName}.`
              : state.status === 'loading' ? 'Checking the shared weekly quota.' : 'Usage is unavailable.'} />
            <span className="usage-quota-value">
              <Meter label={METER_LABEL} tone={usage ? usageTone(usage) : undefined} value={usage?.quotaRemainingPercent ?? null} />
              {usage ? <small>{usageRemainingLabel(usage.quotaRemainingPercent)}{offline && reading && <span className="usage-as-of"> {usageAsOfLabel(reading.fetchedAt)}</span>}</small>
                : state.status === 'loading' ? <BillingSkeleton label="Checking usage…" /> : <small>Unavailable</small>}
            </span>
          </div>}
          planControl={legacyPlan ? (usage ? <BillingControl reason={planReason}><DropdownSelect
            ariaLabel="Plan"
            disabled={Boolean(planReason)}
            onValueChange={(value) => {
              const plan = PlanIdSchema.parse(value);
              if (plan !== usage.plan) setPlan.mutate(plan);
            }}
            options={PLAN_OPTIONS}
            value={setPlan.isPending ? setPlan.variables ?? usage.plan : usage.plan}
            variant="secondary"
          /></BillingControl> : state.status === 'loading' ? <BillingSkeleton label="Loading plan…" /> : <span>Unavailable</span>) : undefined}
        >
          {setPlan.error && <ErrorNotice>The plan could not be changed. {setPlan.error.message}</ErrorNotice>}
          {billing.error && !billingAccessReason && <div className="settings-preference-row">
            <span className="settings-row-copy"><strong>Billing unavailable</strong><small>{billing.error.message}</small></span>
            <Button disabledReason={offline ? 'Connect to the internet to retry billing.' : billing.isFetching ? 'Loading billing details…' : undefined} onClick={() => void refreshBilling()}>Retry billing</Button>
          </div>}
          <div className="settings-preference-row usage-overage">
            <span className="settings-row-copy"><strong>Usage beyond quota this month</strong><small>{usage ? usagePeriodLabel(usage.overage.periodStart, usage.overage.periodEndsAt) : 'Monthly usage beyond the shared quota.'}</small></span>
            <span className="usage-overage-value">
              {usage ? <><span>{formatMicrousd(usage.overage.amountMicrousd)}</span>
                <Tip label={usage.overage.billingEnabled ? "Overage charges appear on a later invoice after usage settles." : USAGE_TOTAL_EXPLANATION} side="top">
                  <Badge className="usage-not-billed" tabIndex={0}>{usage.overage.billingEnabled ? "Overage enabled" : "Usage total"}</Badge>
                </Tip></> : state.status === 'loading' ? <BillingSkeleton label="Loading monthly usage…" /> : <span>Unavailable</span>}
            </span>
          </div>
          {state.status === 'error' && <div className="settings-preference-row"><span className="settings-row-copy"><strong>Usage isn't available right now.</strong></span><Button disabledReason={!api ? 'The organization is unavailable.' : offline ? 'Connect to the internet to retry usage.' : undefined} onClick={retry}>Try again</Button></div>}
        </OrganizationBilling>
      </div>
    </div>
  );
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
