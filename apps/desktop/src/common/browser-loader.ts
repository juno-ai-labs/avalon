import type { RallyDesktopBridge } from './desktop';

type LoaderBridge = Pick<RallyDesktopBridge, 'commandEmbeddedBrowser'>;

/**
 * A file the page may not fetch itself — another origin that does not allow
 * it — loaded with the tab's own session through DevTools' network loader,
 * which is not subject to the page's CORS rules. Base64, or null when the
 * load failed or ran past `maxBytes`.
 */
export async function loadThroughTab(bridge: LoaderBridge, tabId: string, url: string, maxBytes: number): Promise<{ data: string; contentType: string | null } | 'too_large' | null> {
  const tree = await bridge.commandEmbeddedBrowser({ action: 'cdp', tabId, method: 'Page.getFrameTree' });
  const frameId = tree.kind === 'value' ? (tree.value as { frameTree?: { frame?: { id?: string } } }).frameTree?.frame?.id : undefined;
  if (!frameId) return null;
  const loaded = await bridge.commandEmbeddedBrowser({ action: 'cdp', tabId, method: 'Network.loadNetworkResource',
    params: { frameId, url, options: { disableCache: false, includeCredentials: true } } });
  const resource = loaded.kind === 'value'
    ? (loaded.value as { resource?: { success?: boolean; httpStatusCode?: number; stream?: string; headers?: Record<string, string> } }).resource
    : undefined;
  if (!resource?.stream) return null;
  let binary = '';
  try {
    if (!resource.success || resource.httpStatusCode !== 200) return null;
    for (let done = false; !done;) {
      const chunk = await bridge.commandEmbeddedBrowser({ action: 'cdp', tabId, method: 'IO.read', params: { handle: resource.stream } });
      const value = chunk.kind === 'value' ? chunk.value as { data?: string; base64Encoded?: boolean; eof?: boolean } : {};
      const data = value.data ?? '';
      // Decode each chunk on its own: base64 chunks cannot be concatenated.
      if (value.base64Encoded) binary += atob(data);
      else for (const byte of new TextEncoder().encode(data)) binary += String.fromCharCode(byte);
      if (binary.length > maxBytes) return 'too_large';
      done = value.eof !== false;
    }
  } finally {
    await bridge.commandEmbeddedBrowser({ action: 'cdp', tabId, method: 'IO.close', params: { handle: resource.stream } }).catch(() => undefined);
  }
  const headers = resource.headers ?? {};
  const contentType = Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? null;
  return { data: btoa(binary), contentType };
}
