import { ConnectorRegistrationSchema, type ConnectorInstallation } from '@rally/contracts';
import type { ConnectorInstallationManagement } from '@rally/connectors';
import { uuidV7 } from '../lib/uuid-v7';

/** Reviewed declarations may narrow an existing grant, but never expand it. */
export function planConnectorInstallation(installation: ConnectorInstallation, management: ConnectorInstallationManagement, destination: string) {
  const selectedEvents = installation.selectedEvents.filter((event) => management.events.includes(event));
  if (!selectedEvents.length) return { selectedEvents, registrations: installation.registrations, manual: 'This configuration removes every selected event. Disconnect this installation.' };
  if (installation.registrations.some((registration) => ['dispatched', 'unknown', 'action_required'].includes(registration.state))) {
    return { selectedEvents, registrations: installation.registrations, manual: 'Resolve the recorded provider outcome before changing its configuration.' };
  }
  const groups = management.grouping === 'single_event' ? selectedEvents.map((event) => [event]) : [selectedEvents];
  const retained = new Set<string>();
  const registrations = groups.map((events) => {
    const key = [...events].sort().join('+');
    const existing = installation.registrations.find((registration) => registration.action !== 'remove' && registration.state !== 'removed'
      && JSON.stringify([...registration.events].sort()) === JSON.stringify([...events].sort()));
    if (existing) {
      retained.add(existing.key);
      if (existing.destination === destination) return existing;
      return { ...existing, destination, verifiedAt: null, stepId: uuidV7(),
        action: existing.providerId ? 'update' as const : 'create' as const,
        state: management.canUpdateDestination || !existing.providerId ? 'pending' as const : 'action_required' as const,
        error: management.canUpdateDestination || !existing.providerId ? null : management.manualInstructions };
    }
    return ConnectorRegistrationSchema.parse({ key: `${key}:v${management.version}`, events, providerId: null, destination, enabled: null,
      state: management.support.create === 'automatic' ? 'pending' : 'action_required', action: 'create', stepId: uuidV7(),
      verifiedAt: null, error: management.support.create === 'automatic' ? null : management.manualInstructions,
      rotation: 'stable', rotationGeneration: 0, activeSecretRef: `webhook_secret:${uuidV7()}`, pendingSecretRef: null });
  });
  // A replacement must be verified before a still-working registration is removed.
  const replacements = registrations.filter((registration) => !installation.registrations.some((old) => old.key === registration.key)).map((registration) => registration.key);
  for (const existing of installation.registrations) {
    if (retained.has(existing.key)) continue;
    if (existing.state === 'removed') { registrations.push(existing); continue; }
    registrations.push({ ...existing, action: 'remove', afterRegistrationKeys: replacements, stepId: uuidV7(),
      state: !existing.providerId ? 'removed' : existing.providerIdVerified && management.support.remove === 'automatic' ? 'pending' : 'action_required',
      error: management.support.remove === 'automatic' ? null : management.manualInstructions });
  }
  return { selectedEvents, registrations, manual: null };
}
