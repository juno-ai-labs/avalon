import { conversationSourceAt, type ConversationSourceProvider } from '@rally/contracts';
import type { RallyDesktopBridge } from '../../common/desktop';
import type { EmbeddedBrowserTab } from '../../common/embedded-browser';

export type BrowserConversationProvider = ConversationSourceProvider;

export interface BrowserConversation {
  provider: BrowserConversationProvider;
  id: string;
  url: string;
  title: string;
  /** A public share link rather than the person's own conversation. */
  shared: boolean;
}

export function conversationAt(value: string, title: string): BrowserConversation | null {
  const source = conversationSourceAt(value);
  return source && { provider: source.provider, id: source.sessionId, url: source.url, title: title || source.fallbackTitle, shared: source.shared };
}

/** The importable conversation a browser tab is showing, if any. */
export function browserConversation(tab: EmbeddedBrowserTab): BrowserConversation | null {
  return conversationAt(tab.url, tab.title);
}

export function isBrowserConversationUrl(value: string | null): boolean {
  return value !== null && conversationAt(value, '') !== null;
}

/**
 * The sites an import of one provider's conversation may drive the tab to and
 * load files from: the provider's chat app, the hosts it serves files from,
 * and its sign-in host. Everything else is refused before a navigation or a
 * load, and a tab found anywhere else after an action fails that action.
 *
 * Named hosts, not the company's domain: the same signed-in browser holds the
 * person's API and billing consoles (platform.openai.com,
 * console.anthropic.com), which an import never needs and page content must
 * not be able to steer the agent onto. `*.` admits a domain's subdomains.
 */
const PROVIDER_SITES: Record<BrowserConversationProvider, readonly string[]> = {
  chatgpt: ['chatgpt.com', '*.chatgpt.com', 'auth.openai.com', '*.oaiusercontent.com', '*.oaistatic.com'],
  claude: ['claude.ai', '*.claude.ai', '*.claudeusercontent.com'],
};

export function providerSiteAllows(provider: BrowserConversationProvider, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    return PROVIDER_SITES[provider].some((site) => site.startsWith('*.')
      ? url.hostname.endsWith(site.slice(1))
      : url.hostname === site);
  } catch {
    return false;
  }
}

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
