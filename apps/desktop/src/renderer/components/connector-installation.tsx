import { useState, useSyncExternalStore } from 'react';
import { onlineManager, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RallyApi } from '../lib/api';
import { Button, InlineError, Modal } from './primitives';
import { SettingLabel } from '../settings/setting-label';
import { settings } from '../settings/registry';
import { desktopBridge } from '../lib/platform';

const subscribeOnline = (notify: () => void) => onlineManager.subscribe(notify);
const readOnline = () => onlineManager.isOnline();
function requireOnline() {
  if (!readOnline()) throw new Error('Connection management is unavailable while offline. Try again when connected.');
}

const eventChoices = [
  { value: 'applicationSubmit', label: 'Application submitted' },
  { value: 'candidateStageChange', label: 'Application stage changed' },
] as const;

export function AshbyWorkspaceSetup({ api, attemptId, onSuccess, onClose }: { api: RallyApi; attemptId: string; onSuccess: () => void; onClose: () => void }) {
  const cache = useQueryClient();
  const online = useSyncExternalStore(subscribeOnline, readOnline);
  const [apiKey, setApiKey] = useState('');
  const [events, setEvents] = useState<string[]>(eventChoices.map((event) => event.value));
  const setup = useMutation({
    networkMode: 'always',
    mutationFn: () => { requireOnline(); return api.createAshbyWorkspaceConnection(apiKey.trim(), events, attemptId); },
    onSuccess: () => {
      setApiKey('');
      onSuccess();
      void cache.invalidateQueries({ queryKey: ['connections'] });
      onClose();
    },
  });
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title="Connect Ashby for workspace"
    description="One shared connection receives your Ashby organization's selected events. Personal Ashby sign-in does not create webhooks."
    footer={<><Button onClick={onClose}>Cancel</Button><Button className="button-primary" disabled={!online || !apiKey.trim() || !events.length || setup.isPending} onClick={() => setup.mutate()}>{setup.isPending ? 'Setting up…' : 'Connect for workspace'}</Button></>}>
    {!online && <InlineError>Connection management is unavailable while offline.</InlineError>}
    <p>In Ashby Admin → Integrations, create an API key with Read API Keys (apiKeysRead) and Write API Keys (apiKeysWrite) permissions. Paste it here, never in a work stream. The key stays encrypted in this workspace's Rally region. Ashby processes requests and delivers organization events outside Rally's regional storage boundary.</p>
    <p>These events concern the organization, including recruiting records whose visibility may differ from a personal query. Review the selected event scope with your Ashby administrator.</p>
    <Button onClick={() => void desktopBridge().openExternal('https://developers.ashbyhq.com/docs/authentication')}>Open Ashby's API key guide ↗</Button>
    <label className="form-field"><span><SettingLabel setting={settings.ashbyKey} /></span><input autoFocus autoComplete="off" type="password" value={apiKey} disabled={!online || setup.isPending} onChange={(event) => setApiKey(event.currentTarget.value)} /></label>
    <fieldset disabled={!online || setup.isPending}><legend><SettingLabel setting={settings.ashbyEvents} /></legend>{eventChoices.map((choice) => <label className="form-field" key={choice.value}><span><input type="checkbox" checked={events.includes(choice.value)} onChange={(event) => { const checked = event.currentTarget.checked; setEvents((previous) => checked ? [...previous, choice.value] : previous.filter((value) => value !== choice.value)); }} /> {choice.label}</span></label>)}</fieldset>
    <p>Workspace events do not provide recruiting query or update tools. Connect your account separately for personal tools.</p>
    {setup.error && <InlineError>{setup.error.message}</InlineError>}
  </Modal>;
}

export function ConnectorInstallationDetails({ api, connectionId, onClose }: { api: RallyApi; connectionId: string; onClose: () => void }) {
  const cache = useQueryClient();
  const online = useSyncExternalStore(subscribeOnline, readOnline);
  const [providerId, setProviderId] = useState('');
  const [replacementKey, setReplacementKey] = useState('');
  const [registrationKey, setRegistrationKey] = useState('');
  const query = useQuery({ queryKey: ['connector-installation', connectionId], queryFn: () => api.connectorInstallation(connectionId) });
  const change = useMutation({
    networkMode: 'always',
    mutationFn: (action: 'repair' | 'forget_cleanup' | 'reconcile' | 'rotate') => { requireOnline(); return api.changeConnectorInstallation(connectionId, { action, ...(action === 'reconcile' ? { key: registrationKey, providerId: providerId.trim() } : {}) }); },
    onSuccess: () => { void query.refetch(); void cache.invalidateQueries({ queryKey: ['connections'] }); },
  });
  const test = useMutation({ networkMode: 'always', mutationFn: () => { requireOnline(); return api.testConnection(connectionId); },
    onSuccess: () => { void query.refetch(); void cache.invalidateQueries({ queryKey: ['connections'] }); },
  });
  const replaceKey = useMutation({ networkMode: 'always', mutationFn: () => { requireOnline(); return api.replaceInstallationApiKey(connectionId, replacementKey.trim()); },
    onSuccess: () => { setReplacementKey(''); void query.refetch(); void cache.invalidateQueries({ queryKey: ['connections'] }); },
  });
  const installation = query.data?.installation;
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title="Workspace event installation" description="Provider registrations and recovery for this shared workspace connection."
    footer={<Button onClick={onClose}>Close</Button>}>
    {!online && <InlineError>Connection management is unavailable while offline. Saved status may be out of date.</InlineError>}
    {query.isPending && <p>Loading installation…</p>}
    {query.error && <InlineError>{query.error.message}</InlineError>}
    {query.data && !installation && <p>This existing connection has not been adopted yet. Use Test on the connection to inspect and adopt its existing webhook.</p>}
    {installation && <>
      <p role="status">Status: {installation.state.replaceAll('_', ' ')}. Configuration {installation.appliedVersion ?? 'not verified'} / {installation.desiredVersion}.</p>
      <p>Last event received: {installation.lastReceivedAt ? new Date(installation.lastReceivedAt).toLocaleString() : 'None recorded'}.</p>
      {installation.error && <InlineError>{installation.error}</InlineError>}
      {installation.registrations.map((registration) => <section className="settings-list-card" style={{ padding: '1rem', marginBlock: '0.75rem' }} key={registration.key}>
        <h3>{registration.events.map((event) => eventChoices.find((choice) => choice.value === event)?.label ?? event).join(', ')}</h3>
        <p>{registration.state.replaceAll('_', ' ')} · {registration.enabled === null ? 'Enabled state unknown' : registration.enabled ? 'Enabled' : 'Disabled'}</p>
        <p>Provider ID: {registration.providerId ?? 'Not confirmed'}</p>
        <p style={{ overflowWrap: 'anywhere' }}>Destination: {registration.destination}</p>
        <p>Last verified: {registration.verifiedAt ? new Date(registration.verifiedAt).toLocaleString() : 'Not verified'}. Signing key: {registration.rotation}.</p>
        {registration.error && <InlineError>{registration.error}</InlineError>}
      </section>)}
      {installation.state !== 'cleanup_pending' && installation.state !== 'disconnected' && <details><summary>Replace workspace API key</summary>
        <p>Use a key from the same provider organization with webhook management access. Existing subscriptions and signing keys are preserved. Unknown provider outcomes still require inspection.</p>
        <label className="form-field"><span>New API key</span><input type="password" autoComplete="off" value={replacementKey} disabled={!online || replaceKey.isPending} onChange={(event) => setReplacementKey(event.currentTarget.value)} /></label>
        <Button disabled={!online || !replacementKey.trim() || replaceKey.isPending} onClick={() => replaceKey.mutate()}>Replace API key</Button>
        {replaceKey.error && <InlineError>{replaceKey.error.message}</InlineError>}
      </details>}
      <div className="provider-actions"><Button disabled={!online || query.isFetching} onClick={() => void query.refetch()}>Refresh status</Button>{installation.state !== 'cleanup_pending' && installation.state !== 'disconnected' && <Button disabled={!online || test.isPending} onClick={() => test.mutate()}>Test</Button>}{installation.state !== 'cleanup_pending' && installation.state !== 'disconnected' && <Button disabled={!online || change.isPending} onClick={() => change.mutate('rotate')}>Signing-key rotation guidance</Button>}</div>
      {installation.state !== 'cleanup_pending' && installation.state !== 'disconnected' && installation.registrations.some((registration) => !registration.providerId && ['unknown', 'action_required', 'dispatched'].includes(registration.state)) && <>
        <p>A create response is unconfirmed. Inspect the exact destination in the provider dashboard before supplying its ID. Retrying setup could create another webhook.</p>
        <label className="form-field"><span>Registration</span><select value={registrationKey} onChange={(event) => setRegistrationKey(event.currentTarget.value)}><option value="">Choose registration</option>{installation.registrations.filter((registration) => !registration.providerId).map((registration) => <option key={registration.key} value={registration.key}>{registration.events.join(', ')}</option>)}</select></label>
        <label className="form-field"><span>Existing provider webhook ID</span><input value={providerId} onChange={(event) => setProviderId(event.currentTarget.value)} /></label>
        <Button disabled={!online || !registrationKey || !providerId.trim() || change.isPending} onClick={() => change.mutate('reconcile')}>Verify existing webhook</Button>
      </>}
      {installation.state === 'cleanup_pending' && !installation.cleanupCredentialForgotten && <><p>Rally has disabled this connection. The recorded registrations still require removal. Forgetting the local cleanup credential leaves provider removal to your administrator.</p><Button disabled={!online || change.isPending} onClick={() => change.mutate('repair')}>Retry cleanup</Button><Button disabled={!online || change.isPending} onClick={() => change.mutate('forget_cleanup')}>Forget local cleanup credential</Button></>}
    </>}
    {test.data && <p role="status">{test.data.message}</p>}
    {test.error && <InlineError>{test.error.message}</InlineError>}
    {change.error && <InlineError>{change.error.message}</InlineError>}
  </Modal>;
}
