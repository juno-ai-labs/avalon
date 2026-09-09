import { useCallback, useEffect, useState } from 'react';
import { AccessRequestListSchema, DownloadGrantResultSchema, type AccessRequestListItem } from '@rally/contracts/private-access';
import { Button, EmptyState, Field, Panel } from './components/ui';

export function AccessView(): React.JSX.Element {
  const [requests, setRequests] = useState<AccessRequestListItem[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [link, setLink] = useState('');
  const [linkExpiry, setLinkExpiry] = useState<string | null>(null);
  const [timed, setTimed] = useState(false);
  const [expiry, setExpiry] = useState('');
  const [copied, setCopied] = useState(false);
  const expiryValid = !timed || new Date(expiry).getTime() > Date.now();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const reload = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/access/requests', { cache: 'no-store' });
      if (!response.ok) throw new Error('Request list is unavailable. Try again.');
      setRequests(AccessRequestListSchema.parse(await response.json()).requests);
    } catch { setError('Request list is unavailable. Try again.'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  async function generate(requestId?: string): Promise<void> {
    if (timed && !(new Date(expiry).getTime() > Date.now())) {
      setError('Choose a future expiry date and time.');
      return;
    }
    setGenerating(true); setError(''); setLink(''); setCopied(false);
    try {
      const response = await fetch('/api/access/downloads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, ...(timed ? { expiresAt: new Date(expiry).toISOString() } : {}) }),
      });
      if (response.status === 400) { setError('Choose a future expiry date and time.'); return; }
      if (!response.ok) throw new Error('Generation failed');
      const grant = DownloadGrantResultSchema.parse(await response.json());
      setLink(grant.url); setLinkExpiry(grant.expiresAt);
    } catch { setError('Could not generate a link. Please try again.'); }
    finally { setGenerating(false); }
  }
  return <main className="access-editor">
    <header className="editor-header"><div><p>Private preview</p><h1>Access</h1></div></header>
    <p>Anyone holding a link can download. Choose its lifetime before generating a standalone or request-linked download.</p>
    <Panel className="access-generator">
      <Field label="Link lifetime"><select value={timed ? 'timed' : 'single'} disabled={generating} onChange={(event) => setTimed(event.target.value === 'timed')}>
        <option value="single">Single use · no time expiry</option><option value="timed">Expires at a chosen time</option>
      </select></Field>
      {timed && <Field label={`Expires at (${timezone})`}><input type="datetime-local" value={expiry} disabled={generating} onChange={(event) => setExpiry(event.target.value)} required /></Field>}
      <p>{timed ? 'Repeat downloads are allowed until this time. Choose a future date and time.' : 'One download per link. Unused links do not expire.'}</p>
      <Button variant="primary" disabled={generating || !expiryValid} onClick={() => void generate()}>
        {generating ? 'Generating…' : 'Generate download link'}
      </Button>
    </Panel>
    {link && <Panel className="access-link"><Field label="New download link — copy it before leaving"><input readOnly value={link} onFocus={(event) => event.target.select()} /></Field>
      <Button onClick={() => { void navigator.clipboard.writeText(link).then(() => setCopied(true)).catch(() => setError('Select and copy the link manually.')); }}>{copied ? 'Copied' : 'Copy link'}</Button>
      <p role="status">{linkExpiry ? `Repeat downloads until ${new Date(linkExpiry).toLocaleString()} (${timezone}).` : 'Single use. No time expiry.'} No email was sent. This link is shown only now.</p></Panel>}
    <div className="section-title"><div><h2>Access requests</h2><p>{requests.length} requests · acknowledgement accepted by email provider, not confirmed inbox delivery</p></div><Button disabled={loading} onClick={() => void reload()}>Refresh</Button></div>
    <Field label="Find an email"><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search requests" /></Field>
    {error && <p role="alert">{error}</p>}
    {loading ? <p role="status">Loading requests…</p> : <div className="access-table-wrap"><table className="access-table"><thead><tr><th>Email</th><th>Requested</th><th>Acknowledgement</th><th>Download</th></tr></thead><tbody>
      {requests.filter((request) => request.email.includes(query.trim().toLowerCase())).map((request) => <tr key={request.id}>
        <td>{request.email}</td><td>{new Date(request.createdAt).toLocaleString()}</td><td>{request.acknowledgementStatus === 'sent' ? 'Accepted by provider' : request.acknowledgementStatus === 'skipped' ? 'Skipped (development)' : request.acknowledgementStatus}</td>
        <td><Button disabled={generating || !expiryValid} onClick={() => void generate(request.id)}>Generate link</Button></td>
      </tr>)}
    </tbody></table></div>}
    {!loading && !requests.length && !error && <EmptyState title="No requests yet" description="Requests from the landing page will appear here." />}
  </main>;
}
