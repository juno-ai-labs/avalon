import { AshbyEventLabels, type ConnectorInstallation } from "@rally/contracts";
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

const installationEventLabels: Record<string, string> = {
  ...AshbyEventLabels,
  'note.access_granted': 'Note access granted',
  'note.edited': 'Note edited',
  'note.generated': 'Note generated',
  'note.regenerated': 'Note regenerated',
};
const eventLabel = (event: string) => installationEventLabels[event] ?? event;

const installationStatus: Record<ConnectorInstallation['state'], { title: string; description: string }> = {
  setting_up: { title: 'Setting up', description: 'Rally is connecting your workspace events.' },
  current: { title: 'Connected', description: 'Your event subscriptions are connected.' },
  updating: { title: 'Updating', description: 'Rally is updating your event subscriptions.' },
  action_required: { title: 'Needs attention', description: 'Some events may not reach Rally. Test the connection, or get help if the issue continues.' },
  failed: { title: 'Couldn’t connect', description: 'Test the connection to check access and try to fix the problem.' },
  cleanup_pending: { title: 'Disconnected', description: 'Rally has stopped receiving events. Removing the subscriptions from your provider still needs attention.' },
  disconnected: { title: 'Disconnected', description: 'Rally is no longer receiving events from this connection.' },
};

/** A failed response can follow a durable reservation; recover it before offering another setup. */
export function useWorkspaceInstallationRecovery(api: RallyApi | null, provider: 'ashby' | 'granola', onRecovered: (connectionId: string) => void) {
  const cache = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: async () => {
      requireOnline();
      if (!api) throw new Error('Sign in before managing connections.');
      await cache.cancelQueries({ queryKey: ['connections'] });
      const connections = await api.getConnections();
      cache.setQueryData(['connections'], connections);
      return connections.find((connection) => connection.connectorType === provider && connection.scope === 'workspace' && connection.status !== 'disabled');
    },
    onSuccess: (connection) => { if (connection) onRecovered(connection.id); },
  });
}

export function AshbyWorkspaceSetup({ api, attemptId, onSuccess, onClose, onRecovered }: { api: RallyApi; attemptId: string; onSuccess: () => void; onClose: () => void; onRecovered: (connectionId: string) => void }) {
  const cache = useQueryClient();
  const online = useSyncExternalStore(subscribeOnline, readOnline);
  const [apiKey, setApiKey] = useState('');
  const recovery = useWorkspaceInstallationRecovery(api, 'ashby', (connectionId) => {
    setApiKey('');
    onSuccess();
    onRecovered(connectionId);
    onClose();
  });
  const setup = useMutation({
    networkMode: 'always',
    mutationFn: () => { requireOnline(); return api.createAshbyWorkspaceConnection(apiKey.trim(), attemptId); },
    onSuccess: () => {
      setApiKey('');
      onSuccess();
      void cache.invalidateQueries({ queryKey: ['connections'] });
      onClose();
    },
    onError: () => recovery.mutate(),
  });
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title="Connect Ashby for workspace"
    description="One shared connection receives your Ashby organization's recruiting events automatically. Personal Ashby sign-in does not create webhooks."
    footer={<><Button onClick={onClose}>Cancel</Button><Button className="button-primary" disabled={!online || !apiKey.trim() || setup.isPending || recovery.isPending || recovery.isError} onClick={() => setup.mutate()}>{setup.isPending ? 'Setting up…' : 'Connect for workspace'}</Button></>}>
    {!online && <InlineError>Connection management is unavailable while offline.</InlineError>}
    <p>In Ashby Admin → Integrations, create an API key with Read API Keys (apiKeysRead) and Write API Keys (apiKeysWrite) permissions. Paste it here, never in a work stream. The key stays encrypted in this workspace's Rally region. Ashby processes requests and delivers organization events outside Rally's regional storage boundary.</p>
    <p>These events concern the organization, including recruiting records whose visibility may differ from a personal query. Rally manages event subscriptions automatically; choose the events you want to act on when creating automations.</p>
    <Button onClick={() => void desktopBridge().openExternal('https://developers.ashbyhq.com/docs/authentication')}>Open Ashby's API key guide ↗</Button>
    <label className="form-field"><span><SettingLabel setting={settings.ashbyKey} /></span><input autoFocus autoComplete="off" type="password" value={apiKey} disabled={!online || setup.isPending} onChange={(event) => setApiKey(event.currentTarget.value)} /></label>
    <p>Workspace events do not provide recruiting query or update tools. Connect your account separately for personal tools.</p>
    {setup.error && <InlineError>{setup.error.message}</InlineError>}
    {recovery.isPending && <p role="status">Checking for an existing workspace installation…</p>}
    {recovery.error && <><InlineError>Existing installations could not be checked. Check again before retrying setup.</InlineError><Button disabled={!online || recovery.isPending} onClick={() => recovery.mutate()}>Find existing installation</Button></>}
  </Modal>;
}

export function ConnectorInstallationDetails({ api, connectionId, connectionEnabled = false, onClose }: { api: RallyApi; connectionId: string; connectionEnabled?: boolean; onClose: () => void }) {
  const cache = useQueryClient();
  const online = useSyncExternalStore(subscribeOnline, readOnline);
  const [advanced, setAdvanced] = useState(false);
  const [providerId, setProviderId] = useState('');
  const [replacementKey, setReplacementKey] = useState('');
  const [registrationKey, setRegistrationKey] = useState('');
  const query = useQuery({ queryKey: ['connector-installation', connectionId], queryFn: () => api.connectorInstallation(connectionId) });
  const change = useMutation({
    networkMode: 'always',
    mutationFn: (action: 'repair' | 'forget_cleanup' | 'reconcile' | 'rotate') => { requireOnline(); return api.changeConnectorInstallation(connectionId, { action, ...(action === 'reconcile' ? { key: registrationKey, providerId: providerId.trim() } : {}) }); },
    onSuccess: (_result, action) => {
      if (action === 'reconcile') { setProviderId(''); setRegistrationKey(''); }
      void query.refetch(); void cache.invalidateQueries({ queryKey: ['connections'] });
    },
  });
  const test = useMutation({ networkMode: 'always', mutationFn: () => { requireOnline(); return api.testConnection(connectionId); },
    onSuccess: () => { void query.refetch(); void cache.invalidateQueries({ queryKey: ['connections'] }); },
  });
  const replaceKey = useMutation({ networkMode: 'always', mutationFn: () => { requireOnline(); return api.replaceInstallationApiKey(connectionId, replacementKey.trim()); },
    onSuccess: () => { setReplacementKey(''); void query.refetch(); void cache.invalidateQueries({ queryKey: ['connections'] }); },
  });
  const installation = query.data?.installation;
  const reconcilableRegistrations = installation?.registrations.filter((registration) => !registration.providerId && ['unknown', 'action_required', 'dispatched'].includes(registration.state)) ?? [];
  const active = installation && installation.state !== 'cleanup_pending' && installation.state !== 'disconnected';
  const needsHelp = installation && ['action_required', 'failed', 'cleanup_pending'].includes(installation.state);
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title="Workspace events" description="Rally manages event subscriptions for this connection."
    footer={<Button onClick={onClose}>Close</Button>}>
    {!online && <InlineError>Connection management is unavailable while offline. Saved status may be out of date.</InlineError>}
    {query.isPending && <p>Loading connection…</p>}
    {query.error && <InlineError>{query.error.message}</InlineError>}
    {query.data && !installation && <><p>Test this connection to check that workspace events can reach Rally.</p>{connectionEnabled && <Button disabled={!online || test.isPending} onClick={() => test.mutate()}>Test</Button>}</>}
    {installation && <>
      <h3 role="status">{installationStatus[installation.state].title}</h3>
      <p>{installationStatus[installation.state].description}</p>
      {active && <>
        <p>Last event received: {installation.lastReceivedAt ? new Date(installation.lastReceivedAt).toLocaleString() : 'None yet'}.</p>
        <Button className="button-primary" disabled={!online || test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Testing…' : 'Test'}</Button>
        <p>Test checks access and attempts to repair event delivery.</p>
      </>}
      {installation.state === 'cleanup_pending' && !installation.cleanupCredentialForgotten && <Button disabled={!online || change.isPending} onClick={() => change.mutate('repair')}>Retry cleanup</Button>}
      {needsHelp && <Button onClick={() => void desktopBridge().openExternal('https://rallywith.ai/support/contact/')}>Get help</Button>}
    </>}
    {test.data && <p role="status">{test.data.message}</p>}
    {test.error && <InlineError>{test.error.message}</InlineError>}
    {change.error && <InlineError>{change.error.message}</InlineError>}
    {installation && <>
      <div style={{ marginBlockStart: '1rem' }}><Button aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>Advanced</Button></div>
      {advanced && <section aria-label="Advanced connection settings">
        <p>Technical details and recovery tools for workspace administrators and support.</p>
        <Button disabled={!online || query.isFetching} onClick={() => void query.refetch()}>Refresh status</Button>
        {active && <details><summary>Replace workspace API key</summary>
          <p>Use a key from the same provider organization with webhook management access. Existing subscriptions and signing keys are preserved. Unknown provider outcomes still require inspection.</p>
          <label className="form-field"><span>New API key</span><input type="password" autoComplete="off" value={replacementKey} disabled={!online || replaceKey.isPending} onChange={(event) => setReplacementKey(event.currentTarget.value)} /></label>
          <Button disabled={!online || !replacementKey.trim() || replaceKey.isPending} onClick={() => replaceKey.mutate()}>Replace API key</Button>
          {replaceKey.error && <InlineError>{replaceKey.error.message}</InlineError>}
        </details>}
        {active && <details><summary>Signing-key rotation guidance</summary><p>To replace the signing key, disconnect this workspace connection, finish cleanup of the recorded webhooks (or remove them in the provider dashboard), then connect workspace events again. Delivery is interrupted until the new registrations are verified. Reading this guidance changes no key or provider setting.</p></details>}
        {active && reconcilableRegistrations.length > 0 && <>
          <p>A create response is unconfirmed. Inspect the exact destination in the provider dashboard before supplying its ID. Retrying setup could create another webhook.</p>
          <label className="form-field"><span>Registration</span><select value={registrationKey} onChange={(event) => { setRegistrationKey(event.currentTarget.value); setProviderId(''); }}><option value="">Choose registration</option>{reconcilableRegistrations.map((registration) => <option key={registration.key} value={registration.key} title={registration.events.map(eventLabel).join(', ')}>{installation.provider === 'granola' && registration.events.length > 1 ? 'Granola note events' : registration.events.map(eventLabel).join(', ')}</option>)}</select></label>
          <label className="form-field"><span>Existing provider webhook ID</span><input value={providerId} onChange={(event) => setProviderId(event.currentTarget.value)} /></label>
          <Button disabled={!online || !reconcilableRegistrations.some((registration) => registration.key === registrationKey) || !providerId.trim() || change.isPending} onClick={() => change.mutate('reconcile')}>Verify existing webhook</Button>
        </>}
        {installation.state === 'cleanup_pending' && !installation.cleanupCredentialForgotten && <>
          <p>Forgetting the local cleanup credential leaves subscription removal to your provider administrator.</p>
          <Button disabled={!online || change.isPending} onClick={() => change.mutate('forget_cleanup')}>Forget local cleanup credential</Button>
        </>}
        <details><summary>Subscription details</summary>
          <p>Configuration {installation.appliedVersion ?? 'not verified'} / {installation.desiredVersion}.</p>
          {installation.error && <InlineError>{installation.error}</InlineError>}
          {installation.registrations.map((registration) => <section className="settings-list-card" style={{ padding: '1rem', marginBlock: '0.75rem' }} key={registration.key}>
            <h3>{registration.events.map(eventLabel).join(', ')}</h3>
            <p>{registration.state.replaceAll('_', ' ')} · {registration.enabled === null ? 'Enabled state unknown' : registration.enabled ? 'Enabled' : 'Disabled'}</p>
            <p>Provider ID: {registration.providerId ?? 'Not confirmed'}</p>
            <p style={{ overflowWrap: 'anywhere' }}>Destination: {registration.destination}</p>
            <p>Last verified: {registration.verifiedAt ? new Date(registration.verifiedAt).toLocaleString() : 'Not verified'}. Signing key: {registration.rotation}.</p>
            {registration.error && <InlineError>{registration.error}</InlineError>}
          </section>)}
        </details>
      </section>}
    </>}
  </Modal>;
}
