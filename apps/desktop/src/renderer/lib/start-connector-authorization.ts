import type { RallyApi } from './api';
import { desktopBridge } from './platform';
import { reportTelemetryProductIntent, telemetryCountBucket, uuidV7 } from './telemetry';

/** Every entry surface uses the native listener when Canva needs its interim callback. */
export async function startConnectorAuthorization(
  api: RallyApi,
  provider: Parameters<RallyApi['startProviderConnection']>[0],
  scope: 'you' | 'workspace',
  capabilities: string[],
) {
  const bridge = desktopBridge();
  if (provider === 'canva' && scope === 'you' && bridge.connectCanva) {
    const operationId = uuidV7();
    reportTelemetryProductIntent({ kind: 'connector_setup_requested_v2', connector: 'canva',
      scope: 'personal', method: 'oauth', capabilityCount: telemetryCountBucket(capabilities.length), operationId });
    return bridge.connectCanva(operationId);
  }
  const authorization = await api.startProviderConnection(provider, scope, capabilities);
  await bridge.openExternal(authorization.url);
  return authorization;
}
