import { desktopBridge } from '../lib/platform';
import { useState } from 'react';
import type { BillingStatus } from '@rally/contracts/billing';
import type { OrganizationPlanApi } from '../lib/organization-usage';
import { Button, DropdownSelect, ErrorNotice } from './primitives';

type BillingProps = { api: OrganizationPlanApi; currentPlan: string; billing: Extract<BillingStatus, { enabled: true }> };
export function OrganizationBilling(props: BillingProps) {
  // A subscription transition discards prepared links and in-flight responses,
  // including a later transition back to checkout after cancellation.
  return <BillingForm key={props.billing.subscribed ? 'portal' : 'checkout'} {...props} />;
}

function BillingForm({ api, billing, currentPlan }: BillingProps) {
  const [offerId, setOfferId] = useState(billing.offers[0]?.id ?? '');
  const offer = billing.offers.find((item) => item.id === offerId);
  const [currency, setCurrency] = useState(offer?.currencies[0] ?? 'usd');
  const [overage, setOverage] = useState(false);
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
  return <>
    <div className="settings-preference-row">
      <span className="settings-row-copy"><strong>Organization billing</strong><small>{billing.subscribed ? `${currentPlan} · Subscription: ${billing.status}` : `${currentPlan}. Trial ${Date.parse(billing.trialEndsAt) < Date.now() ? 'ended' : 'ends'} ${new Date(billing.trialEndsAt).toLocaleDateString()}. One subscription for everyone; no seat charges.`}</small></span>
      <Button disabled={busy || (!billing.subscribed && !offer)} onClick={() => void open()}>{busy ? 'Preparing…' : billing.subscribed ? 'Manage billing' : 'Continue to checkout'}</Button>
    </div>
    {url && <div className="settings-preference-row"><span className="settings-row-copy"><strong>Secure billing is ready</strong><small>Open Stripe to complete your changes, then return here.</small></span><a className="button" href={url} target="_blank" rel="noopener noreferrer" onClick={(event) => { event.preventDefault(); void desktopBridge().openExternal(url).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Stripe could not be opened')); }}>Open Stripe</a></div>}
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
