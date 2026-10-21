import { AshbyEventLabels, connectorApiKeyAcceptable, isConnectorApiKeyProvider, type ConnectorInstallation } from "@rally/contracts";
import { CircleCheck } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { onlineManager, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RallyApi } from '../lib/api';
import { ConnectorApiKeyField, ConnectorApiKeyIssuingLink } from './connector-api-key-field';
import { Button, ErrorNotice, Modal } from './primitives';
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
};
const eventLabel = (event: string) => installationEventLabels[event] ?? event;

const installationStatus: Record<ConnectorInstallation['state'], { title: string; description: string }> = {
  setting_up: { title: 'Setting up', description: 'Rally is connecting your organization events.' },
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
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title="Connect Ashby for organization"
    description="One shared connection receives your Ashby organization's recruiting events automatically. Personal Ashby sign-in does not create webhooks."
    footer={<><Button onClick={onClose}>Cancel</Button><Button className="button-primary" disabled={!online || !connectorApiKeyAcceptable('ashby', apiKey) || setup.isPending || recovery.isPending || recovery.isError} onClick={() => setup.mutate()}>{setup.isPending ? 'Setting up…' : 'Connect for organization'}</Button></>}>
    {!online && <p role="status">Connect to the internet to manage this connection.</p>}
    <p>The button below opens the page that issues the key. Create one with Read API Keys (apiKeysRead) and Write API Keys (apiKeysWrite) permissions, then paste it here, never into a chat, thread or channel. The key stays encrypted in this organization's Rally region. Ashby processes requests and delivers organization events outside Rally's regional storage boundary.</p>
    <p>These events concern the organization, including recruiting records whose visibility may differ from a personal query. Rally manages event subscriptions automatically; choose the events you want to act on when creating automations.</p>
    <ConnectorApiKeyIssuingLink provider="ashby" variant="button" />
    <ConnectorApiKeyField autoFocus disabled={!online || setup.isPending} inputLabel="Ashby organization API key" label={<SettingLabel setting={settings.ashbyKey} />} onChange={setApiKey} provider="ashby" value={apiKey} />
    <p>Organization events do not provide recruiting query or update tools. Connect your account separately for personal tools.</p>
    {setup.error && <ErrorNotice occurrence={setup.error}>{setup.error.message}</ErrorNotice>}
    {recovery.isPending && <p role="status">Checking for an existing organization installation…</p>}
    {recovery.error && <><ErrorNotice>Existing installations could not be checked. Check again before retrying setup.</ErrorNotice><Button disabled={!online || recovery.isPending} onClick={() => recovery.mutate()}>Find existing installation</Button></>}
  </Modal>;
}

/**
 * The Test result as a verdict first and the details second.
 *
 * The result used to be one unstyled sentence under the buttons, the same
 * weight as the caption above it, so "Granola authorization is healthy.
 * Approved webhook configuration is verified" read like more instructions, and
 * an administrator who had just fixed a connection could not tell they were
 * done. Success stays with the connection; failures require acknowledgement.
 */
function ConnectionTestOutcome({ kind, message }: { kind: 'passed' | 'failed' | 'unavailable'; message: string }) {
  // `unavailable` is the request failing — offline, a timeout, a 5xx — not the
  // connection failing the test. The test never ran, so a red "failed" would
  // send someone off to fix a connection that may be fine.
  const heading = { passed: 'Connection test passed', failed: 'Connection test failed', unavailable: 'Couldn’t run the connection test' }[kind];
  if (kind !== 'passed') return <ErrorNotice title={heading}>{message}</ErrorNotice>;
  return (
    <div className={`connection-test-outcome is-${kind}`} role="status">
      <CircleCheck aria-hidden="true" size={18} />
      <div>
        <strong>{heading}</strong>
        <p>{message}</p>
      </div>
    </div>
  );
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
  return <Modal open onOpenChange={(open) => { if (!open) onClose(); }} title="Organization events" description="Rally manages event subscriptions for this connection."
    footer={<Button onClick={onClose}>Close</Button>}>
    {!online && <p role="status">Connect to the internet to manage this connection. Saved status may be out of date.</p>}
    {query.isPending && <p>Loading connection…</p>}
    {query.error && <ErrorNotice occurrence={query.error}>{query.error.message}</ErrorNotice>}
    {/* Four groups with more space between them than within one — status,
        the actions each beside its own caption, the verdict, Advanced — so a
        caption reads as its button's and not as the next line of prose. The
        old body was one column of equally spaced lines, and "Test checks
        access…" sat as close to Get help below it as to Test above. */}
    {query.data && !installation && <div className="installation-panel">
      <section className="installation-status"><p>Test this connection to check that organization events can reach Rally.</p></section>
      {connectionEnabled && <section className="installation-actions">
        <div className="installation-action"><Button className="button-primary" disabled={!online || test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Testing…' : 'Test'}</Button><p>Checks access and attempts to repair event delivery.</p></div>
      </section>}
      {test.data && <ConnectionTestOutcome kind={test.data.ok ? 'passed' : 'failed'} message={test.data.message} />}
      {test.error && <ConnectionTestOutcome kind="unavailable" message={test.error.message} />}
    </div>}
    {installation && <div className="installation-panel">
      <section className="installation-status">
        <h3 role="status">{installationStatus[installation.state].title}</h3>
        <p>{installationStatus[installation.state].description}</p>
        {active && <p className="installation-status-meta">Last event received: {installation.lastReceivedAt ? new Date(installation.lastReceivedAt).toLocaleString() : 'None yet'}.</p>}
        {installation.state === 'cleanup_pending' && installation.registrations.every((registration) => !registration.providerId) && (
          // Keyed on the registrations carrying no provider identity, which is
          // what a provider with no webhook API leaves behind: there is nothing
          // for Rally to delete, so Retry cleanup would be a button that cannot
          // do anything. Say what the administrator has to do instead.
          <p role="status">Rally can't remove the webhook from your provider for you. Delete it there, or leave it — deliveries to a removed connection are rejected.</p>
        )}
      </section>
      {(active || needsHelp) && <section className="installation-actions">
        {active && <div className="installation-action"><Button className="button-primary" disabled={!online || test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Testing…' : 'Test'}</Button><p>Checks access and attempts to repair event delivery.</p></div>}
        {installation.state === 'cleanup_pending' && !installation.cleanupCredentialForgotten
          // Verified, because that is what the cleanup runner requires before
          // it will remove a webhook; an unverified id would make this a
          // button that does nothing.
          && installation.registrations.some((registration) => registration.providerId && registration.providerIdVerified)
          && <div className="installation-action"><Button disabled={!online || change.isPending} onClick={() => change.mutate('repair')}>Retry cleanup</Button><p>Asks the provider again to remove the recorded webhook.</p></div>}
        {needsHelp && <div className="installation-action"><Button onClick={() => void desktopBridge().openExternal('https://rallywith.ai/help/help-and-glossary/contact-support/')}>Get help</Button><p>Opens Rally support, for a problem Test does not fix.</p></div>}
      </section>}
      {test.data && <ConnectionTestOutcome kind={test.data.ok ? 'passed' : 'failed'} message={test.data.message} />}
      {test.error && <ConnectionTestOutcome kind="unavailable" message={test.error.message} />}
      {change.error && <ErrorNotice occurrence={change.error}>{change.error.message}</ErrorNotice>}
      <section className="installation-advanced">
        <div className="installation-action"><Button aria-expanded={advanced} onClick={() => setAdvanced((value) => !value)}>Advanced</Button><p>Technical details and recovery tools for organization administrators and support.</p></div>
      {advanced && <section aria-label="Advanced connection settings">
        <Button disabled={!online || query.isFetching} onClick={() => void query.refetch()}>Refresh status</Button>
        {active && isConnectorApiKeyProvider(installation.provider) && <details><summary>Replace organization API key</summary>
          <p>Use a key from the same provider organization with webhook management access. Existing subscriptions and signing keys are preserved. Unknown provider outcomes still require inspection.</p>
          <ConnectorApiKeyIssuingLink provider={installation.provider} />
          <ConnectorApiKeyField disabled={!online || replaceKey.isPending} inputLabel="New API key" label="New API key" onChange={setReplacementKey} provider={installation.provider} value={replacementKey} />
          <Button disabled={!online || !connectorApiKeyAcceptable(installation.provider, replacementKey) || replaceKey.isPending} onClick={() => replaceKey.mutate()}>Replace API key</Button>
          {replaceKey.error && <ErrorNotice occurrence={replaceKey.error}>{replaceKey.error.message}</ErrorNotice>}
        </details>}
        {active && reconcilableRegistrations.length > 0 && <>
          <p>A create response is unconfirmed. Inspect the exact destination in the provider dashboard before supplying its ID. Retrying setup could create another webhook.</p>
          <label className="form-field"><span>Registration</span><select value={registrationKey} onChange={(event) => { setRegistrationKey(event.currentTarget.value); setProviderId(''); }}><option value="">Choose registration</option>{reconcilableRegistrations.map((registration) => <option key={registration.key} value={registration.key} title={registration.events.map(eventLabel).join(', ')}>{installation.provider === 'granola' && registration.events.length > 1 ? 'Granola note events' : registration.events.map(eventLabel).join(', ')}</option>)}</select></label>
          <label className="form-field"><span>Existing provider webhook ID</span><input value={providerId} onChange={(event) => setProviderId(event.currentTarget.value)} /></label>
          <Button disabled={!online || !reconcilableRegistrations.some((registration) => registration.key === registrationKey) || !providerId.trim() || change.isPending} onClick={() => change.mutate('reconcile')}>Verify existing webhook</Button>
        </>}
        {installation.state === 'cleanup_pending' && !installation.cleanupCredentialForgotten && <>
          <p>Forgetting the local cleanup credential leaves subscription removal to your provider administrator, and removes this connection from the list. Copy the provider IDs from Subscription details first if you plan to delete the webhooks there.</p>
          <Button disabled={!online || change.isPending} onClick={() => change.mutate('forget_cleanup')}>Forget local cleanup credential</Button>
        </>}
        <details><summary>Subscription details</summary>
          <p>Configuration {installation.appliedVersion ?? 'not verified'} / {installation.desiredVersion}.</p>
          {installation.error && <ErrorNotice automatic={false} detailsLabel="Installation details">{installation.error}</ErrorNotice>}
          {installation.registrations.map((registration) => <section className="settings-list-card" style={{ padding: '1rem', marginBlock: '0.75rem' }} key={registration.key}>
            <h3>{registration.events.map(eventLabel).join(', ')}</h3>
            <p>{registration.state.replaceAll('_', ' ')} · {registration.enabled === null ? 'Enabled state unknown' : registration.enabled ? 'Enabled' : 'Disabled'}</p>
            <p>Provider ID: {registration.providerId ?? 'Not confirmed'}</p>
            <p style={{ overflowWrap: 'anywhere' }}>Destination: {registration.destination}</p>
            <p>Last verified: {registration.verifiedAt ? new Date(registration.verifiedAt).toLocaleString() : 'Not verified'}. Signing key: {registration.rotation}.</p>
            {registration.error && <ErrorNotice automatic={false} detailsLabel="Subscription details">{registration.error}</ErrorNotice>}
          </section>)}
        </details>
      </section>}
      </section>
    </div>}
  </Modal>;
}
