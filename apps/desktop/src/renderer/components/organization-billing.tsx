import { desktopBridge } from '../lib/platform';
import { useState } from 'react';
import type { BillingStatus, BillingCredits } from '@rally/contracts/billing';
import type { OrganizationPlanApi } from '../lib/organization-usage';
import { useLocalCacheScope } from '../lib/local-cache-scope';
import { Button, DropdownSelect, ErrorNotice } from './primitives';

type BillingProps = { api: OrganizationPlanApi; currentPlan: string; billing: Extract<BillingStatus, { enabled: true }> };
export function OrganizationBilling(props: BillingProps) {
  const scope = useLocalCacheScope();
  const key = `${scope}:${props.billing.subscribed ? 'portal' : 'checkout'}:${props.billing.paymentMethodReady}:${props.billing.overageEnabled}`;
  // A subscription transition discards prepared links and in-flight responses,
  // including a later transition back to checkout after cancellation.
  return <><BillingForm key={key} {...props} />
    {props.billing.creditsAvailable && props.api.getBillingCredits && <OverageCredits key={key} load={props.api.getBillingCredits.bind(props.api)} />}
  </>;
}

function OverageCredits({ load }: { load: () => Promise<BillingCredits> }) {
  const [credits, setCredits] = useState<BillingCredits | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = async () => {
    setBusy(true); setError(null); setCredits(null);
    try { setCredits(await load()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Credits could not be loaded'); }
    finally { setBusy(false); }
  };
  const dollars = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  return <>
    <div className="settings-preference-row">
      <span className="settings-row-copy"><strong>Overage credits</strong><small>{credits ? `${dollars(credits.availableCents)} available for overage invoices. Subscription fees and included usage stay unchanged.` : 'Credits apply automatically to eligible overage invoices.'}</small></span>
      <Button disabled={busy} onClick={() => void refresh()}>{busy ? 'Loading credits…' : credits ? 'Refresh credits' : 'View credits'}</Button>
    </div>
    {credits?.grants.map((grant) => <div className="settings-preference-row" key={grant.id}>
      <span className="settings-row-copy"><strong>{dollars(grant.amountCents)} credit</strong><small>{grant.voided ? 'Voided' : grant.expiresAt ? `${Date.parse(grant.expiresAt) <= Date.now() ? 'Expired' : 'Expires'} ${new Date(grant.expiresAt).toLocaleDateString()}` : 'No expiry'}</small></span>
      <span>{dollars(grant.availableCents)} available</span>
    </div>)}
    {error && <ErrorNotice>{error}</ErrorNotice>}
  </>;
}

function BillingForm({ api, billing, currentPlan }: BillingProps) {
  const [offerId, setOfferId] = useState(billing.offers[0]?.id ?? '');
  const offer = billing.offers.find((item) => item.id === offerId);
  const [currency, setCurrency] = useState(offer?.currencies[0] ?? 'usd');
  const [overage, setOverage] = useState(billing.overageEnabled);
  const [busy, setBusy] = useState(false);
  const requestKey = billing.subscribed ? 'portal' : `${offerId}:${currency}:${overage}`;
  const [prepared, setPrepared] = useState<{ url: string; key: string } | null>(null);
  const url = prepared?.key === requestKey ? prepared.url : null;
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setBusy(true); setError(null); setPrepared(null);
    try {
      const result = billing.subscribed ? await api.createBillingPortal!() : await api.createBillingCheckout!(offerId, currency, overage);
      setPrepared({ url: result.url, key: requestKey });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Billing could not be opened'); }
    finally { setBusy(false); }
  };
  const saveOverages = async (enabled: boolean) => {
    setBusy(true); setError(null);
    try { const result = await api.setBillingOverages!(enabled); setOverage(result.enabled); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Overages could not be updated'); }
    finally { setBusy(false); }
  };
  const trial = billing.subscribed && billing.status === 'trialing';
  return <>
    {trial && <div className="settings-preference-row"><span className="settings-row-copy"><strong>{currentPlan} trial</strong><small>Subscription fees are waived until {new Date(billing.trialEndsAt).toLocaleDateString()}. {billing.paymentMethodReady ? 'Subscription fees resume afterward unless you cancel. Opted-in overages are charged during the trial.' : 'Add a payment method and billing address to continue afterward. Without billing details, your organization returns to Start. Usage pauses when the included allowance is used up.'}</small></span></div>}
    <div className="settings-preference-row">
      <span className="settings-row-copy"><strong>Organization billing</strong><small>{billing.subscribed ? `${currentPlan} · Subscription: ${billing.status}` : `${currentPlan}. Trial ${Date.parse(billing.trialEndsAt) < Date.now() ? 'ended' : 'ends'} ${new Date(billing.trialEndsAt).toLocaleDateString()}. One subscription for everyone; no seat charges.`}</small></span>
      <Button disabled={busy || (!billing.subscribed && !offer)} onClick={() => void open()}>{busy ? 'Preparing…' : trial && !billing.paymentMethodReady ? 'Add billing details' : billing.subscribed ? 'Manage billing' : 'Continue to checkout'}</Button>
    </div>
    {url && <div className="settings-preference-row"><span className="settings-row-copy"><strong>Secure billing is ready</strong><small>Open Stripe to complete your changes, then return here.</small></span><a className="button" href={url} target="_blank" rel="noopener noreferrer" onClick={(event) => { event.preventDefault(); void desktopBridge().openExternal(url).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Stripe could not be opened')); }}>Open Stripe</a></div>}
    {billing.subscribed && billing.overageAvailable && api.setBillingOverages && <label className="settings-preference-row"><span className="settings-row-copy"><strong>Bill usage beyond shared quota</strong><small>{billing.paymentMethodReady ? 'Optional. Overages remain billable during the free trial.' : 'Add a payment method and billing address in Stripe before enabling overages.'}</small></span><input type="checkbox" checked={overage} disabled={busy || (!billing.paymentMethodReady && !overage)} onChange={(event) => void saveOverages(event.target.checked)} /></label>}
    {!billing.subscribed && <>
      <div className="settings-preference-row"><span className="settings-row-copy"><strong>Plan</strong><small>Review pricing, discounts and taxes at checkout.</small></span>
        <DropdownSelect ariaLabel="Billing plan" value={offerId} disabled={busy} options={billing.offers.map((o) => ({ value: o.id, label: o.name }))} onValueChange={(id) => { setPrepared(null); setOfferId(id); setCurrency(billing.offers.find((o) => o.id === id)!.currencies[0]!); setOverage(false); }} />
      </div>
      <div className="settings-preference-row"><strong>Currency</strong><DropdownSelect ariaLabel="Billing currency" value={currency} disabled={busy} options={(offer?.currencies ?? []).map((value) => ({ value, label: value.toUpperCase() }))} onValueChange={(value) => { setPrepared(null); setCurrency(value); setOverage(false); }} /></div>
      {offer?.overageAvailable && currency === 'usd' && <label className="settings-preference-row"><span className="settings-row-copy"><strong>Bill usage beyond shared quota</strong><small>Optional. Charges appear on a later invoice after usage settles.</small></span><input type="checkbox" checked={overage} disabled={busy} onChange={(event) => { setPrepared(null); setOverage(event.target.checked); }} /></label>}
    </>}
    {error && <ErrorNotice>{error}</ErrorNotice>}
  </>;
}
