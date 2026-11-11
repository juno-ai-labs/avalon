import { useState } from 'react';
import type { BillingStatus } from '@rally/contracts/billing';
import type { OrganizationPlanApi } from '../lib/organization-usage';
import { desktopBridge } from '../lib/platform';
import { Button, DropdownSelect, ErrorNotice } from './primitives';

export function OrganizationBilling({ api, billing }: { api: OrganizationPlanApi; billing: Extract<BillingStatus, { enabled: true }> }) {
  const [offerId, setOfferId] = useState(billing.offers[0]?.id ?? '');
  const offer = billing.offers.find((item) => item.id === offerId);
  const [currency, setCurrency] = useState(offer?.currencies[0] ?? 'usd');
  const [overage, setOverage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    setBusy(true); setError(null);
    try {
      const result = billing.subscribed ? await api.createBillingPortal!() : await api.createBillingCheckout!(offerId, currency, overage);
      await desktopBridge().openExternal(result.url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Billing could not be opened'); }
    finally { setBusy(false); }
  };
  return <>
    <div className="settings-preference-row">
      <span className="settings-row-copy"><strong>Organization billing</strong><small>{billing.subscribed ? `Subscription: ${billing.status}` : `Trial ends ${new Date(billing.trialEndsAt).toLocaleDateString()}. One subscription for everyone; no seat charges.`}</small></span>
      <Button disabled={busy || (!billing.subscribed && !offer)} onClick={() => void open()}>{busy ? 'Opening…' : billing.subscribed ? 'Manage billing' : 'Continue to checkout'}</Button>
    </div>
    {!billing.subscribed && <>
      <div className="settings-preference-row"><span className="settings-row-copy"><strong>Plan</strong><small>Review pricing, discounts and taxes at checkout.</small></span>
        <DropdownSelect ariaLabel="Billing plan" value={offerId} disabled={busy} options={billing.offers.map((o) => ({ value: o.id, label: o.name }))} onValueChange={(id) => { setOfferId(id); setCurrency(billing.offers.find((o) => o.id === id)!.currencies[0]!); setOverage(false); }} />
      </div>
      <div className="settings-preference-row"><strong>Currency</strong><DropdownSelect ariaLabel="Billing currency" value={currency} disabled={busy} options={(offer?.currencies ?? []).map((value) => ({ value, label: value.toUpperCase() }))} onValueChange={(value) => { setCurrency(value); setOverage(false); }} /></div>
      {offer?.overageAvailable && currency === 'usd' && <label className="settings-preference-row"><span className="settings-row-copy"><strong>Bill usage beyond shared quota</strong><small>Optional. Charges appear on a later invoice after usage settles.</small></span><input type="checkbox" checked={overage} disabled={busy} onChange={(event) => setOverage(event.target.checked)} /></label>}
    </>}
    {error && <ErrorNotice>{error}</ErrorNotice>}
  </>;
}
