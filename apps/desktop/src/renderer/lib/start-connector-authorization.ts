import type { RallyApi } from './api';
import { desktopBridge } from './platform';

/** Start a provider authorization and open its consent page, from every entry surface alike. */
export async function startConnectorAuthorization(
  api: RallyApi,
  provider: Parameters<RallyApi['startProviderConnection']>[0],
  scope: 'you' | 'workspace',
  capabilities: string[],
) {
  const bridge = desktopBridge();
  const authorization = await api.startProviderConnection(provider, scope, capabilities);
  await bridge.openExternal(authorization.url);
  return authorization;
}
