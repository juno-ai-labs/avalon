import { isCookieSession, type ClientSession } from '@rally/contracts/client-session';
import type { RallyApi } from './api';
import { DEFAULT_CLIENT_FEATURE_FLAGS, useClientFeatureFlags } from './use-client-feature-flags';

/** The public macOS build, the same one the site and the browser's account rail link to. */
export const MAC_APP_DOWNLOAD_URL = 'https://downloads.rallywith.ai/stable/darwin/arm64/Rally.dmg';

/** What a connector the browser cannot start says, wherever it is listed. */
export const MAC_APP_CONNECT_NOTE = 'Download the Mac app to connect this.';

/**
 * Whether a connection asking for `capabilities` can start in a browser: every
 * capability it asks for has to be on the served list. A request is one
 * authorization, so it is offered whole or not at all.
 */
export function browserCanConnect(capabilities: readonly string[], allowed: readonly string[]): boolean {
  return capabilities.length > 0 && capabilities.every((capability) => allowed.includes(capability));
}

/**
 * Answers whether this client may start a connection for `capabilities`. The
 * Mac app may start any; a browser tab only what `browserConnectableCapabilities`
 * lists. Presentation only: the connection routes do not read the list.
 */
export function useConnectorStartAvailable(
  api: Pick<RallyApi, 'clientFeatureFlags'> | null,
  session: ClientSession | null,
): (capabilities: readonly string[]) => boolean {
  const flags = useClientFeatureFlags(api);
  const browser = isCookieSession(session);
  const allowed = (flags.data ?? DEFAULT_CLIENT_FEATURE_FLAGS).browserConnectableCapabilities;
  return (capabilities) => !browser || browserCanConnect(capabilities, allowed);
}
