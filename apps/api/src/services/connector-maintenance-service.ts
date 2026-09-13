import { ashbyIngressUrl } from '../lib/ashby-ingress';
import { planConnectorInstallation } from './connector-installation-plan';
import { encryptString } from '../lib/crypto';
import { decryptVersionedConnectorCredentials } from './connector-credential-envelope';
import { withAuthorizedConnection } from './connector-connection-access';
import { withWorkspaceRuntimeDatabase } from './workspace-runtime-database';
import { randomToken } from '../lib/crypto';
import { z } from 'zod';
import { ConnectorInstallationProviderSchema, ConnectorRegistrationSchema, asWorkspaceId } from '@rally/contracts';
import type { Env } from '../env';
import { ApiError } from '../lib/api-error';
import { uuidV7 } from '../lib/uuid-v7';
import { workspaceDOName } from '../durable-objects/names';
import { durableObjectStubForWorkspace } from '../lib/durable-object-namespace';
import { connectorRegistryForEnv } from '../lib/connector-registry';
import { workspaceRegionalDatabase } from './workspace-runtime-database';
import { runConnectorInstallation } from './connector-installation-service';
import { logInfo } from '../observability/logger';

export const ConnectorMaintenanceSelectionSchema = z.strictObject({
  provider: ConnectorInstallationProviderSchema, region: z.enum(['global', 'eu']), version: z.number().int().positive(),
  workspaceIds: z.array(z.string().uuid()).optional(),
});
const TargetSchema = z.strictObject({
  workspaceId: z.string().uuid(), connectionId: z.string().uuid(), generation: z.number().int().positive().nullable(),
  state: z.enum(['pending', 'current', 'failed', 'action_required', 'cancelled']),
  action: z.enum(['unchanged', 'repair', 'customer_action']), reason: z.string().nullable(),
  configuration: z.strictObject({ selectedEvents: z.array(z.string()).min(1), registrations: z.array(ConnectorRegistrationSchema) }).nullable(),
  steps: z.array(z.strictObject({ key: z.string(), action: z.enum(['create', 'inspect', 'update', 'remove', 'rotate', 'unchanged', 'customer_action']) })),
});
export const ConnectorMaintenanceOperationSchema = z.strictObject({
  id: z.string().uuid(), selection: ConnectorMaintenanceSelectionSchema, operatorId: z.string().min(1),
  state: z.enum(['preview', 'running', 'complete', 'cancelled']), targets: z.array(TargetSchema),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
});
export const ConnectorMaintenanceQueueSchema = z.strictObject({ kind: z.literal('connector_maintenance'), region: z.enum(['global', 'eu']), operationId: z.string().uuid() });
type Operation = z.infer<typeof ConnectorMaintenanceOperationSchema>;

async function objectFor(env: Env, workspace: string) {
  const workspaceId = asWorkspaceId(workspace);
  return durableObjectStubForWorkspace(env, env.WORKSPACE_DOS, workspaceId, workspaceDOName(env.AVALON_REGION, workspaceId));
}
export async function connectorMaintenanceStatus(env: Env, id: string): Promise<Operation> {
  const row = await workspaceRegionalDatabase(env).prepare('SELECT document_json FROM connector_maintenance_operations WHERE id = ?').bind(z.string().uuid().parse(id)).first<{ document_json: string }>();
  if (!row) throw new ApiError(404, 'connector_maintenance_not_found', 'Connector maintenance operation not found');
  return ConnectorMaintenanceOperationSchema.parse(JSON.parse(row.document_json));
}
async function saveTarget(env: Env, operationId: string, index: number, target: Operation['targets'][number]) {
  // Update one target only: concurrent Queue deliveries cannot overwrite a
  // sibling's completed outcome with their older copy of the operation document.
  await workspaceRegionalDatabase(env).prepare("UPDATE connector_maintenance_operations SET document_json = json_set(document_json, ?, json(?), '$.updatedAt', ?) WHERE id = ? AND json_extract(document_json, '$.state') = 'running' AND json_extract(document_json, ?) = 'pending'")
    .bind(`$.targets[${index}]`, JSON.stringify(TargetSchema.parse(target)), new Date().toISOString(), operationId, `$.targets[${index}].state`).run();
}

/** Freeze the exact regional selection without contacting or repairing providers. */
export async function previewConnectorMaintenance(env: Env, raw: unknown, operatorId: string): Promise<Operation> {
  const selection = ConnectorMaintenanceSelectionSchema.parse(raw);
  if (selection.region !== env.AVALON_REGION) throw new ApiError(409, 'connector_maintenance_wrong_region', 'Use the selected region operator endpoint');
  const management = connectorRegistryForEnv(env).get(selection.provider).installationManagement;
  if (!management || management.version !== selection.version) throw new ApiError(422, 'connector_configuration_unavailable', 'The selected configuration is not the reviewed version in this deployment');
  const routes = await workspaceRegionalDatabase(env).prepare("SELECT workspace_id, connection_id FROM connector_ingress_routes WHERE connector_type = ? AND scope = 'workspace' AND region = ? AND status = 'active' ORDER BY connection_id")
    .bind(selection.provider, selection.region).all<{ workspace_id: string; connection_id: string }>();
  const targets: Operation['targets'] = [];
  for (const route of routes.results) {
    if (selection.workspaceIds && !selection.workspaceIds.includes(route.workspace_id)) continue;
    const installation = await (await objectFor(env, route.workspace_id)).connectorInstallation({ workspaceId: route.workspace_id, connectionId: route.connection_id });
    // Granola version 1 preserves the exact adopted destination. A future
    // reviewed declaration must explicitly provide a supported destination cutover.
    const destination = selection.provider === 'ashby' ? ashbyIngressUrl(env, route.connection_id) : installation?.registrations[0]?.destination;
    const plan = installation && destination ? planConnectorInstallation(installation, management, destination) : null;
    const current = installation?.state === 'current' && installation.appliedVersion === selection.version
      && plan?.registrations.every((registration) => registration.state === 'current' || registration.state === 'removed');
    const manual = !plan || Boolean(plan.manual);
    const configuration = plan && !plan.manual ? { selectedEvents: plan.selectedEvents, registrations: plan.registrations } : null;
    targets.push({ workspaceId: route.workspace_id, connectionId: route.connection_id, generation: installation?.generation ?? null,
      state: current ? 'current' : manual ? 'action_required' : 'pending', action: current ? 'unchanged' : manual ? 'customer_action' : 'repair',
      configuration,
      steps: (configuration?.registrations ?? installation?.registrations)?.map((registration) => ({ key: registration.key, action: registration.state === 'current' ? 'unchanged' : ['unknown', 'action_required'].includes(registration.state) ? 'customer_action' : registration.action })) ?? [],
      reason: !installation ? 'Use Test to adopt this existing connection before fleet maintenance.' : plan?.manual ?? null });
  }
  const at = new Date().toISOString();
  const operation = ConnectorMaintenanceOperationSchema.parse({ id: uuidV7(), selection, operatorId, state: 'preview', targets, createdAt: at, updatedAt: at });
  await workspaceRegionalDatabase(env).prepare('INSERT INTO connector_maintenance_operations (id, document_json) VALUES (?, ?)').bind(operation.id, JSON.stringify(operation)).run();
  return operation;
}

export async function applyConnectorMaintenance(env: Env, id: string, resume = false, operatorId?: string): Promise<Operation> {
  const operation = await connectorMaintenanceStatus(env, id);
  if (operatorId) logInfo(env, 'connector_maintenance_action_requested', {
    operation_id: id, operator_id: operatorId, action: resume ? 'resume' : 'apply', state: operation.state,
  });
  if (operation.state === 'cancelled') throw new ApiError(409, 'connector_maintenance_cancelled', 'Preview a new operation after cancellation');
  if (resume && operation.state === 'preview') throw new ApiError(409, 'connector_maintenance_not_applied', 'Apply the preview before resuming maintenance');
  if (operation.state === 'complete') return operation;
  await workspaceRegionalDatabase(env).prepare("UPDATE connector_maintenance_operations SET document_json = json_set(document_json, '$.state', 'running') WHERE id = ? AND json_extract(document_json, '$.state') = 'preview'").bind(id).run();
  if (resume) {
    for (const target of operation.targets) {
      if (target.state !== 'pending' || !target.generation) continue;
      const object = await objectFor(env, target.workspaceId);
      const installation = await object.connectorInstallation({ workspaceId: target.workspaceId, connectionId: target.connectionId });
      // Apply may still be waiting for its first Queue delivery. Only resume
      // prepared work; otherwise repair would stamp this operation's identity
      // before the queued preparation can install its frozen configuration.
      if (installation?.maintenanceOperationId !== id) continue;
      await object.prepareConnectorInstallationMaintenance({ workspaceId: target.workspaceId, connectionId: target.connectionId, operationId: id, generation: target.generation, version: operation.selection.version, resume: true });
    }
  }
  await env.ACTIVITY_QUEUE.send(ConnectorMaintenanceQueueSchema.parse({ kind: 'connector_maintenance', operationId: id, region: env.AVALON_REGION }));
  return connectorMaintenanceStatus(env, id);
}

export async function cancelConnectorMaintenance(env: Env, id: string, operatorId?: string): Promise<Operation> {
  const requested = await connectorMaintenanceStatus(env, id);
  if (operatorId) logInfo(env, 'connector_maintenance_action_requested', {
    operation_id: id, operator_id: operatorId, action: 'cancel', state: requested.state,
  });
  await workspaceRegionalDatabase(env).prepare("UPDATE connector_maintenance_operations SET document_json = json_set(document_json, '$.state', 'cancelled') WHERE id = ? AND json_extract(document_json, '$.state') <> 'complete'").bind(id).run();
  const operation = await connectorMaintenanceStatus(env, id);
  if (operation.state !== 'cancelled') return operation;
  for (const target of operation.targets) {
    if (target.state !== 'pending') continue;
    await (await objectFor(env, target.workspaceId)).cancelConnectorInstallationMaintenance({ workspaceId: target.workspaceId, connectionId: target.connectionId, operationId: id });
  }
  operation.state = 'cancelled';
  operation.targets = operation.targets.map((target) => target.state === 'pending' ? { ...target, state: 'cancelled', reason: 'Future maintenance dispatch was cancelled; see the installation receipt for any in-flight outcome.' } : target);
  await workspaceRegionalDatabase(env).prepare("UPDATE connector_maintenance_operations SET document_json = ? WHERE id = ? AND json_extract(document_json, '$.state') = 'cancelled'").bind(JSON.stringify(operation), id).run();
  return connectorMaintenanceStatus(env, id);
}

export async function runConnectorMaintenance(env: Env, id: string, signal: AbortSignal): Promise<void> {
  let operation = await connectorMaintenanceStatus(env, id);
  if (operation.state !== 'running') return;
  for (const [index, target] of operation.targets.entries()) {
    if (target.state !== 'pending') continue;
    signal.throwIfAborted();
    if ((await connectorMaintenanceStatus(env, id)).state !== 'running') return;
    try {
      const object = await objectFor(env, target.workspaceId);
      if (!target.generation) throw new Error('installation_not_adopted');
      let credentials: { ciphertext: string; iv: string; keyVersion: number } | undefined;
      const adapter = connectorRegistryForEnv(env).get(operation.selection.provider);
      if (target.configuration && adapter.installationManagement?.signingSecretSource === 'host') {
        const local = withWorkspaceRuntimeDatabase(env, asWorkspaceId(target.workspaceId));
        const row = await local.DB.prepare("SELECT * FROM connector_connections WHERE id = ? AND status <> 'disabled'").bind(target.connectionId).first<{
          id: string; encrypted_credentials: string; credential_iv: string; credential_key_version: number; granted_scopes_json: string; config_json: string;
        }>();
        if (!row) throw new Error('connector_disabled');
        const stored = z.record(z.string(), z.unknown()).parse(JSON.parse(await decryptVersionedConnectorCredentials(local, row)));
        await withAuthorizedConnection(local, { adapter, signal, connection: { id: target.connectionId, workspaceId: target.workspaceId,
          scope: 'workspace', ownerUserId: null, credentials: stored, grantedScopes: z.array(z.string()).parse(JSON.parse(row.granted_scopes_json)),
          config: z.record(z.string(), z.unknown()).parse(JSON.parse(row.config_json)), cursor: {} } }, async (authorized) => {
          const next = { ...authorized.credentials };
          for (const registration of target.configuration!.registrations) {
            if (registration.action === 'create' && registration.activeSecretRef && !next[registration.activeSecretRef]) next[registration.activeSecretRef] = randomToken(32);
          }
          credentials = { ...await encryptString(JSON.stringify(next), env.CONNECTOR_CREDENTIALS_KEY, target.connectionId), keyVersion: Number(env.CONNECTOR_CREDENTIALS_KEY_VERSION || 1) };
        });
      }
      await object.prepareConnectorInstallationMaintenance({ workspaceId: target.workspaceId, connectionId: target.connectionId,
        generation: target.generation, operationId: id, version: operation.selection.version,
        ...(target.configuration ? { configuration: target.configuration } : {}), ...(credentials ? { credentials } : {}) });
      if ((await connectorMaintenanceStatus(env, id)).state !== 'running') {
        await object.cancelConnectorInstallationMaintenance({ workspaceId: target.workspaceId, connectionId: target.connectionId, operationId: id });
        return;
      }
      const result = await runConnectorInstallation(env, target.workspaceId, target.connectionId, signal);
      // A stale claimant can observe the next runnable step before the owning
      // runner claims it. Only dependency-blocked pending work is terminal here.
      if (result?.registrations.some((registration) => registration.state === 'dispatched'
        || (registration.state === 'pending' && registration.afterRegistrationKeys.every((key) => result.registrations.some((dependency) => dependency.key === key && dependency.state === 'current'))))) continue;
      target.state = result?.state === 'current' ? 'current' : result?.state === 'failed' ? 'failed' : 'action_required';
      target.reason = target.state === 'current' ? null : 'Inspect the per-connection installation receipt for the remaining provider action.';
    } catch {
      signal.throwIfAborted();
      target.state = 'action_required'; target.reason = 'The connection changed or its authority is unavailable. Preview again after resolving its state.';
    }
    await saveTarget(env, operation.id, index, target);
  }
  operation = await connectorMaintenanceStatus(env, id);
  if (operation.state === 'running' && operation.targets.every((target) => target.state !== 'pending')) {
    await workspaceRegionalDatabase(env).prepare("UPDATE connector_maintenance_operations SET document_json = json_set(document_json, '$.state', 'complete', '$.updatedAt', ?) WHERE id = ? AND json_extract(document_json, '$.state') = 'running' AND NOT EXISTS (SELECT 1 FROM json_each(json_extract(document_json, '$.targets')) WHERE json_extract(value, '$.state') = 'pending')")
      .bind(new Date().toISOString(), id).run();
  }
}

/** Exercises concurrent target persistence independently of runner retries. */
export const __connectorMaintenanceTesting = { saveTarget };
