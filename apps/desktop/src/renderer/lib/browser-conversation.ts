import type { RallyDesktopBridge } from '../../common/desktop';
import type { EmbeddedBrowserTab } from '../../common/embedded-browser';

export type BrowserConversationProvider = 'chatgpt' | 'claude';

export interface BrowserConversation {
  provider: BrowserConversationProvider;
  id: string;
  url: string;
  title: string;
  /** A public share link rather than the person's own conversation. */
  shared: boolean;
}

const uuid = '([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})';
/** The conversation routes each provider's own web client shows: the person's own, and shared links. */
const conversationRoutes: Array<{ provider: BrowserConversationProvider; hostname: string; path: RegExp; shared: boolean; fallbackTitle: string }> = [
  { provider: 'chatgpt', hostname: 'chatgpt.com', path: new RegExp(`^/c/${uuid}/?$`, 'iu'), shared: false, fallbackTitle: 'ChatGPT conversation' },
  { provider: 'chatgpt', hostname: 'chatgpt.com', path: new RegExp(`^/share/${uuid}/?$`, 'iu'), shared: true, fallbackTitle: 'Shared ChatGPT conversation' },
  { provider: 'claude', hostname: 'claude.ai', path: new RegExp(`^/chat/${uuid}/?$`, 'iu'), shared: false, fallbackTitle: 'Claude conversation' },
  { provider: 'claude', hostname: 'claude.ai', path: new RegExp(`^/share/${uuid}/?$`, 'iu'), shared: true, fallbackTitle: 'Shared Claude conversation' },
];

export function conversationAt(value: string, title: string): BrowserConversation | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    for (const route of conversationRoutes) {
      const match = url.hostname === route.hostname ? route.path.exec(url.pathname) : null;
      if (match?.[1]) return { provider: route.provider, id: match[1].toLowerCase(), url: `${url.origin}${url.pathname.replace(/\/$/u, '')}`,
        title: title || route.fallbackTitle, shared: route.shared };
    }
    return null;
  } catch {
    return null;
  }
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
 * load files from: the provider's app and the hosts it serves files and
 * sign-in from. Everything else is refused before a navigation or a load, and
 * a tab found anywhere else after an action fails that action.
 */
const PROVIDER_SITES: Record<BrowserConversationProvider, readonly string[]> = {
  chatgpt: ['chatgpt.com', 'openai.com', 'oaiusercontent.com', 'oaistatic.com'],
  claude: ['claude.ai', 'anthropic.com', 'claudeusercontent.com'],
};

export function providerSiteAllows(provider: BrowserConversationProvider, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    return PROVIDER_SITES[provider].some((site) => url.hostname === site || url.hostname.endsWith(`.${site}`));
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
