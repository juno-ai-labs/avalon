import { IconArrowUpRight } from '@tabler/icons-react';
import { RefreshCcw } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { prepareExternalLink } from '../lib/platform';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { BillingStatus } from '@rally/contracts/billing';
import type { OrganizationPlanApi } from '../lib/organization-usage';
import { useLocalCacheScope } from '../lib/local-cache-scope';
import { DropdownSelect, ErrorNotice, IconButton, Tip } from './primitives';

export function BillingSkeleton({ label }: { label: string }) {
  return <span role="status" className="billing-skeleton"><span className="sr-only">{label}</span><span aria-hidden="true" className="skeleton-bar" /></span>;
}

/** Disabled native controls still need a hover and keyboard target for their reason. */
export function BillingControl({ reason, children }: { reason?: string; children: ReactNode }) {
  return reason ? <Tip label={reason}><span className="billing-disabled-control" tabIndex={0} aria-label={reason}>{children}</span></Tip> : <>{children}</>;
}

type BillingProps = {
  api: OrganizationPlanApi | null;
  currentPlan?: string;
  billing?: BillingStatus;
  canManage: boolean;
  loading?: boolean;
  disabledReason?: string;
  readDisabledReason?: string;
  planControl?: ReactNode;
  beforePlan?: ReactNode;
  children?: ReactNode;
};

export function OrganizationBilling(props: BillingProps) {
  const scope = useLocalCacheScope();
  const billing = props.billing?.enabled ? props.billing : undefined;
  const key = `${scope}:${billing?.subscribed}:${billing?.paymentMethodReady}:${billing?.overageEnabled}:${props.canManage}:${props.disabledReason}`;
  // Discard pending external handoffs when the organization, permissions or subscription changes.
  return <>
    <BillingForm key={key} {...props} />
    {props.children}
    <OverageCredits api={props.api} readDisabledReason={props.readDisabledReason} />
  </>;
}

function OverageCredits({ api, readDisabledReason }: Pick<BillingProps, 'api' | 'readDisabledReason'>) {
  const scope = useLocalCacheScope();
  const credits = useQuery({
    queryKey: ['organization-billing-credits', scope],
    queryFn: () => api!.getBillingCredits!(),
    enabled: Boolean(api?.getBillingCredits) && !readDisabledReason,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
  });
  const loading = credits.isPending && credits.isFetching;
  const data = readDisabledReason ? undefined : credits.data;
  const reason = readDisabledReason ?? (!api?.getBillingCredits ? 'Credits are unavailable.' : credits.fetchStatus === 'paused' ? 'Connect to the internet to refresh credits.' : credits.isFetching ? 'Refreshing credits…' : undefined);
  const dollars = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  return <>
    <div className="settings-preference-row" aria-busy={credits.isFetching}>
      <span className="settings-row-copy"><strong>Overage credits</strong>
        {loading ? <BillingSkeleton label="Loading credits…" /> : <small>{data
          ? `${dollars(data.availableCents)} available for overage invoices. Subscription fees and included usage stay unchanged.`
          : readDisabledReason ?? 'Credit balance is unavailable.'}</small>}
      </span>
      <IconButton label="Refresh credits" disabledReason={reason} onClick={() => void credits.refetch()}>
        <RefreshCcw aria-hidden="true" size={14} className={credits.isFetching ? 'spin' : undefined} />
      </IconButton>
    </div>
    {data?.grants.map((grant) => <div className="settings-preference-row" key={grant.id}>
      <span className="settings-row-copy"><strong>{dollars(grant.amountCents)} credit</strong><small>{grant.voided ? 'Voided' : grant.expiresAt ? `${Date.parse(grant.expiresAt) <= Date.now() ? 'Expired' : 'Expires'} ${new Date(grant.expiresAt).toLocaleDateString()}` : 'No expiry'}</small></span>
      <span>{dollars(grant.availableCents)} available</span>
    </div>)}
    {credits.error && !readDisabledReason && <ErrorNotice>{credits.error.message}</ErrorNotice>}
  </>;
}

function BillingForm({ api, billing: status, currentPlan, canManage, loading, disabledReason, planControl, beforePlan }: BillingProps) {
  const scope = useLocalCacheScope();
  const queryClient = useQueryClient();
  const billing = status?.enabled ? status : undefined;
  const offers = billing?.offers.filter((item) => item.currencies.includes('usd')) ?? [];
  const [offerId, setOfferId] = useState(offers[0]?.id ?? '');
  const offer = offers.find((item) => item.id === offerId);
  const [overage, setOverage] = useState(billing?.overageEnabled ?? false);
  const [busy, setBusy] = useState(false);
  const pending = useRef<ReturnType<typeof prepareExternalLink> | null>(null);
  useEffect(() => () => {
    pending.current?.cancel();
    pending.current = null;
  }, []);
  const [error, setError] = useState<string | null>(null);
  const reason = disabledReason ?? (!canManage ? 'Only organization administrators can change billing.'
    : loading ? 'Loading billing details…'
    : !billing || !api ? 'Billing is unavailable.'
    : busy ? 'Wait for the current billing request.' : undefined);
  const subscribed = billing?.subscribed ?? false;
  const trial = subscribed && billing?.status === 'trialing';
  const actionReason = reason ?? (subscribed
    ? !api?.createBillingPortal ? 'Billing management is unavailable.' : undefined
    : !offer ? 'No billing plans are available in USD.' : !api?.createBillingCheckout ? 'Checkout is unavailable.' : undefined);
  const planReason = reason ?? (!offer ? 'No billing plans are available in USD.' : undefined);
  const overageReason = reason ?? (subscribed
    ? !['active', 'trialing'].includes(billing?.status ?? '') ? 'An active or trialing subscription is required to change overages.'
      : !api?.setBillingOverages ? 'Overage changes are unavailable.'
      : overage ? undefined
      : billing?.currency && billing.currency !== 'usd' ? 'Overages require billing in USD.'
      : !billing?.overageAvailable ? 'Overages are unavailable for this plan.'
      : !billing.paymentMethodReady ? 'Add a payment method and billing address to enable overages.' : undefined
    : !api?.createBillingCheckout ? 'Checkout is unavailable.'
      : !offer ? 'No billing plans are available in USD.'
      : !offer.overageAvailable ? 'Overages are unavailable for this plan.' : undefined);
  const open = async () => {
    if (actionReason || pending.current || !api || !billing) return;
    setBusy(true); setError(null);
    let link: ReturnType<typeof prepareExternalLink> | undefined;
    try {
      link = prepareExternalLink();
      pending.current = link;
      const result = billing.subscribed ? await api.createBillingPortal!() : await api.createBillingCheckout!(offerId, 'usd', overage);
      if (pending.current === link) await link.open(result.url);
    } catch (cause) {
      link?.cancel();
      if (!link || pending.current === link) setError(cause instanceof Error ? cause.message : 'Billing could not be opened');
    } finally {
      if (!link || pending.current === link) {
        pending.current = null;
        setBusy(false);
      }
    }
  };
  const saveOverages = async (enabled: boolean) => {
    if (overageReason || !api?.setBillingOverages) return;
    setBusy(true); setError(null);
    try {
      const result = await api.setBillingOverages(enabled);
      setOverage(result.enabled);
      queryClient.setQueryData<BillingStatus>(['organization-billing', scope], (previous) => previous?.enabled ? { ...previous, overageEnabled: result.enabled } : previous);
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Overages could not be updated'); }
    finally { setBusy(false); }
  };
  const currentOffer = billing?.offers.find((item) => item.id === billing.offerId);
  const currentPlanLabel = subscribed && currentOffer ? `${currentOffer.name} plan` : currentPlan;
  const displayedPlan = offerId || 'unavailable';
  return <>
    <div className="settings-preference-row"><span className="settings-row-copy"><strong>Trial</strong>
      {loading ? <BillingSkeleton label="Loading trial…" /> : <small>{!billing ? 'Trial details are unavailable.' : trial
        ? `Subscription fees are waived until ${new Date(billing.trialEndsAt).toLocaleDateString()}. ${billing.paymentMethodReady ? 'Subscription fees resume afterward unless you cancel. Opted-in overages are charged during the trial.' : 'Add a payment method and billing address to continue afterward. Without billing details, your organization returns to Start. Usage pauses when the included allowance is used up.'}`
        : 'No active trial.'}</small>}
    </span></div>
    <div className="settings-preference-row">
      <span className="settings-row-copy"><strong>Organization billing</strong>
        {loading ? <BillingSkeleton label="Loading billing…" /> : <small>{billing ? `${currentPlanLabel ?? 'Organization plan'} · ${subscribed ? `Subscription: ${billing.status}` : 'No subscription. One subscription for everyone; no seat charges.'}` : 'Billing is unavailable.'}</small>}
      </span>
      <BillingControl reason={actionReason}><button type="button" className="text-button external-link-button" disabled={Boolean(actionReason)} aria-busy={busy} onClick={() => void open()}><span>{busy ? 'Opening…' : trial && !billing?.paymentMethodReady ? 'Add billing details' : subscribed || !billing ? 'Manage billing' : 'Continue to checkout'}</span><IconArrowUpRight aria-hidden="true" size={16} /></button></BillingControl>
    </div>
    {beforePlan}
    <div className="settings-preference-row"><span className="settings-row-copy"><strong>Plan</strong><small>{subscribed ? 'Manage your subscribed plan in Stripe.' : 'Review pricing, discounts and taxes at checkout.'}</small></span>
      {planControl ?? (loading ? <BillingSkeleton label="Loading plan…" /> : subscribed ? <span>{currentOffer?.name ?? currentPlan ?? 'Unavailable'}</span> : <BillingControl reason={planReason}><DropdownSelect ariaLabel="Billing plan" value={displayedPlan} disabled={Boolean(planReason)} options={offers.length
        ? offers.map((item) => ({ value: item.id, label: item.name })) : [{ value: displayedPlan, label: currentPlan ?? 'Unavailable' }]}
        onValueChange={(id) => { setOfferId(id); setOverage(false); }} /></BillingControl>)}
    </div>
    <div className="settings-preference-row"><span className="settings-row-copy"><strong>Bill usage beyond shared quota</strong><small>Optional. Overages remain billable during a free trial.</small></span>
      <BillingControl reason={overageReason}><input aria-label="Bill usage beyond shared quota" type="checkbox" checked={overage} disabled={Boolean(overageReason)} onChange={(event) => { if (subscribed) void saveOverages(event.target.checked); else setOverage(event.target.checked); }} /></BillingControl>
    </div>
    {error && <ErrorNotice>{error}</ErrorNotice>}
  </>;
}
