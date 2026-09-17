import { useEffect, useRef, useState } from 'react';
import { AccessRequestPageSchema, DownloadGrantListSchema, DownloadGrantResultSchema, type AccessRequestListItem, type DownloadGrantListItem } from '@rally/contracts/private-access';
import { Button, EmptyState, Field, Panel } from './components/ui';
import { responseBody } from './response';

const acknowledgementLabels = {
  pending: 'Pending', sending: 'In progress', sent: 'Accepted by provider', failed: 'Retry available',
  rejected: 'Provider rejected', review_required: 'Needs provider review', skipped: 'Skipped (development)', suppressed: 'Suppressed',
} satisfies Record<AccessRequestListItem['acknowledgementStatus'], string>;

export function AccessView(): React.JSX.Element {
  const [requests, setRequests] = useState<AccessRequestListItem[]>([]);
  const [grants, setGrants] = useState<DownloadGrantListItem[]>([]);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [before, setBefore] = useState<string | null>(null);
  const [grantBefore, setGrantBefore] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [grantNext, setGrantNext] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState<{ id: string; url: string; expiresAt: string | null; recipient: string } | null>(null);
  const [timed, setTimed] = useState(true);
  const [expiry, setExpiry] = useState('');
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<AccessRequestListItem | null>(null);
  const [action, setAction] = useState('retry');
  const recoveryHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (selected) recoveryHeading.current?.focus(); }, [selected]);
  const [confirmed, setConfirmed] = useState(false);
  const expiryValid = !timed || new Date(expiry).getTime() > Date.now();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const refresh = () => setRevision((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const params = (cursor: string | null) => new URLSearchParams({ q: search, ...(cursor ? { before: cursor } : {}) });
    void Promise.all([
      fetch(`/api/access/requests?${params(before)}`, { cache: 'no-store', signal: controller.signal }),
      fetch(`/api/access/downloads?${params(grantBefore)}`, { cache: 'no-store', signal: controller.signal }),
    ]).then(async ([requestResponse, grantResponse]) => {
      if (!requestResponse.ok || !grantResponse.ok) throw new Error('List unavailable');
      const requestPage = AccessRequestPageSchema.parse(await requestResponse.json());
      const grantPage = DownloadGrantListSchema.parse(await grantResponse.json());
      if (controller.signal.aborted) return;
      setRequests(requestPage.requests); setNext(requestPage.nextCursor);
      setGrants(grantPage.grants); setGrantNext(grantPage.nextCursor);
    }).catch(() => { if (!controller.signal.aborted) setError('Access lists are unavailable. Please refresh.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [before, grantBefore, search, revision]);

  async function generate(request?: AccessRequestListItem): Promise<void> {
    if (!expiryValid || busy) return;
    setBusy(true); setError(''); setCopied(false);
    try {
      const response = await fetch('/api/access/downloads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: request?.id, ...(timed ? { expiresAt: new Date(expiry).toISOString() } : {}) }),
      });
      // The route says which field it refused; the page shows that sentence
      // rather than one of its own, the way `recover()` already does.
      const grant = await responseBody(response, (value) => DownloadGrantResultSchema.parse(value));
      setLink({ id: grant.id, url: grant.url, expiresAt: grant.expiresAt, recipient: request?.email ?? 'Standalone link' });
      refresh();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not generate a link. Check the expiry and try again.'); }
    finally { setBusy(false); }
  }
  async function revoke(id: string): Promise<void> {
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/access/downloads/${id}/revoke`, { method: 'POST' });
      if (!response.ok) throw new Error('Revocation failed');
      if (link?.id === id) setLink(null);
      refresh();
    } catch { setError('Could not revoke the link. Try again.'); }
    finally { setBusy(false); }
  }
  async function recover(): Promise<void> {
    if (!selected || !confirmed) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/access/requests/${selected.id}/recover`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, generation: selected.generation, confirmed }),
      });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? 'Recovery failed. Refresh and check the request.');
      setSelected(null);
    } catch (error) { setError(error instanceof Error ? error.message : 'Recovery failed.'); }
    finally { setBusy(false); refresh(); }
  }
  return <main className="access-editor">
    <header className="editor-header"><div><p>Early access</p><h1>Access</h1></div></header>
    <p>Anyone holding a link can download. Timed links let people retry interrupted downloads.</p>
    {error && <p role="alert">{error}</p>}
    <Panel className="access-generator">
      <Field label="Link lifetime"><select value={timed ? 'timed' : 'single'} disabled={busy} onChange={(event) => setTimed(event.target.value === 'timed')}>
        <option value="timed">Expires at a chosen time</option><option value="single">Single use · no time expiry</option>
      </select></Field>
      {timed && <Field label={`Expires at (${timezone})`}><input type="datetime-local" value={expiry} disabled={busy} onChange={(event) => setExpiry(event.target.value)} required /></Field>}
      <p>{timed ? 'Choose a future date and time. Downloads can restart until then.' : 'A failed or interrupted download needs a new link. Unused links do not expire.'}</p>
      <Button variant="primary" disabled={busy || !expiryValid} onClick={() => void generate()}>Generate download link</Button>
    </Panel>
    {link && <Panel className="access-link"><h2>{link.recipient}</h2><Field label="New download link — copy it before leaving"><input readOnly value={link.url} onFocus={(event) => event.target.select()} /></Field>
      <Button onClick={() => { void navigator.clipboard.writeText(link.url).then(() => setCopied(true)).catch(() => setError('Select and copy the link manually.')); }}>{copied ? 'Copied' : 'Copy link'}</Button>
      <p role="status">{link.expiresAt ? `Repeat downloads until ${new Date(link.expiresAt).toLocaleString()} (${timezone}).` : 'Single use. No time expiry.'} No email was sent. This link is shown only now.</p></Panel>}
    <form className="access-search" onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); setBefore(null); setGrantBefore(null); setError(''); refresh(); }}>
      <Field label="Find an email or grant ID"><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></Field><Button type="submit" disabled={loading}>Search</Button>
      <Button type="button" disabled={loading} onClick={() => { setError(''); refresh(); }}>Refresh</Button>
    </form>
    <h2>Access requests</h2><p>Up to 50 requests per page. “Accepted by provider” does not confirm inbox delivery. Pending messages can be retried when email capacity is available.</p>
    {loading ? <p role="status">Loading…</p> : <div className="access-table-wrap"><table className="access-table"><thead><tr><th>Email</th><th>Requested</th><th>Acknowledgement</th><th>Actions</th></tr></thead><tbody>
      {requests.map((request) => <tr key={request.id}>
        <td>{request.email}</td><td>{new Date(request.createdAt).toLocaleString()}</td><td>{acknowledgementLabels[request.acknowledgementStatus]}</td>
        <td><Button disabled={busy || !expiryValid} onClick={() => void generate(request)}>Generate link</Button> <Button disabled={busy} onClick={() => { setSelected(request); setConfirmed(false); setAction(['pending', 'failed'].includes(request.acknowledgementStatus) ? 'retry' : 'confirm_sent'); }}>Review email</Button></td>
      </tr>)}
    </tbody></table></div>}
    <div className="access-actions"><Button disabled={!before || loading} onClick={() => setBefore(null)}>Newest requests</Button><Button disabled={!next || loading} onClick={() => setBefore(next)}>Older requests</Button></div>
    {!loading && !requests.length && <EmptyState title="No matching requests" description="New requests from the landing page appear here." />}
    {selected && <Panel className="access-recovery"><h2 ref={recoveryHeading} tabIndex={-1}>Review email: {selected.email}</h2>
      <p>Request {selected.id} · {acknowledgementLabels[selected.acknowledgementStatus]}</p><p>First attempt: {selected.firstAttemptAt ? new Date(selected.firstAttemptAt).toLocaleString() : 'Not attempted'}</p>
      <p>Check this recipient and attempt time in Resend. Only start a new send after confirming the previous attempt was not accepted and no send is in flight.</p>
      <Field label="Recovery action"><select value={action} disabled={busy} onChange={(event) => { setAction(event.target.value); setConfirmed(false); }}>
        <option value="retry">Retry a pending or failed acknowledgement</option><option value="confirm_sent">Mark provider acceptance confirmed</option>
        <option value="retry_reconciled">Send again after confirming it was not accepted</option><option value="suppress">Suppress further acknowledgements</option>
      </select></Field>
      <p>{action === 'retry_reconciled' ? 'Starts a new send with the current sender and copy. Correct provider configuration before proceeding.' : 'Retries retain the original sender and copy. Suppression prevents future signup acknowledgements for this address.'}</p>
      <label className="access-confirmation"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} /> I checked this request and the provider outcome.</label>
      <div className="access-actions"><Button disabled={busy || !confirmed} onClick={() => void recover()}>Apply recovery</Button><Button disabled={busy} onClick={() => setSelected(null)}>Close</Button></div>
    </Panel>}
    <h2>Download history</h2><p>URLs cannot be recovered. Revoke an old grant and generate a replacement above. Revocation prevents new downloads; transfers already started may finish.</p>
    <div className="access-table-wrap"><table className="access-table"><thead><tr><th>Recipient / grant</th><th>Expires</th><th>First download</th><th>Actions</th></tr></thead><tbody>
      {grants.map((grant) => <tr key={grant.id}><td>{grant.email ?? 'Standalone'}<small className="access-grant-id">{grant.id}</small></td><td>{grant.expiresAt ? new Date(grant.expiresAt).toLocaleString() : 'Single use; no expiry'}</td><td>{grant.usedAt ? new Date(grant.usedAt).toLocaleString() : 'Not started'}</td><td>{grant.revokedAt ? 'Revoked' : <Button variant="danger" disabled={busy} onClick={() => void revoke(grant.id)}>Revoke</Button>}</td></tr>)}
    </tbody></table></div>
    <div className="access-actions"><Button disabled={!grantBefore || loading} onClick={() => setGrantBefore(null)}>Newest links</Button><Button disabled={!grantNext || loading} onClick={() => setGrantBefore(grantNext)}>Older links</Button></div>
  </main>;
}
