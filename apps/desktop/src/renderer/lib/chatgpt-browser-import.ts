import type { EmbeddedBrowserTab } from '../../common/embedded-browser';
import type { RallyDesktopBridge } from '../../common/desktop';

const conversationPath = /^\/c\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/iu;

export function chatGptBrowserConversation(tab: EmbeddedBrowserTab): { id: string; url: string; title: string } | null {
  try {
    const url = new URL(tab.url);
    const match = url.protocol === 'https:' && url.hostname === 'chatgpt.com' ? conversationPath.exec(url.pathname) : null;
    if (!match?.[1]) return null;
    return { id: match[1], url: `${url.origin}${url.pathname}`, title: tab.title || 'ChatGPT conversation' };
  } catch {
    return null;
  }
}

export function isChatGptConversationUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'chatgpt.com' && conversationPath.test(url.pathname);
  } catch {
    return false;
  }
}

/** Read one signed-in conversation in its own browser partition. The access token never crosses IPC. */
export async function readChatGptBrowserConversation(
  bridge: Pick<RallyDesktopBridge, 'getEmbeddedBrowserState' | 'commandEmbeddedBrowser'>,
  sourceUrl: string,
): Promise<string> {
  const state = await bridge.getEmbeddedBrowserState();
  const tab = state.tabs.find((candidate) => chatGptBrowserConversation(candidate)?.url === sourceUrl);
  if (!tab) throw new Error('Open this conversation in Rally’s browser, then try again.');
  const source = chatGptBrowserConversation(tab);
  if (!source) throw new Error('Choose a ChatGPT conversation in Rally’s browser.');
  // ChatGPT's own client uses an access token from its same-origin session
  // endpoint. Fetching with cookies alone can return a misleading guest 404.
  const expression = `(async () => {
    if (location.origin !== 'https://chatgpt.com' || location.pathname !== ${JSON.stringify(new URL(source.url).pathname)})
      throw new Error('The browser is no longer showing the selected conversation.');
    const sessionResponse = await fetch('/api/auth/session', { credentials: 'include' });
    if (!sessionResponse.ok) throw new Error('Sign in to ChatGPT in Rally’s browser, then try again.');
    const browserSession = await sessionResponse.json();
    if (typeof browserSession.accessToken !== 'string' || !browserSession.accessToken)
      throw new Error('Sign in to ChatGPT in Rally’s browser, then try again.');
    const response = await fetch('/backend-api/conversation/${source.id}', {
      credentials: 'include', headers: { Authorization: 'Bearer ' + browserSession.accessToken },
    });
    if (!response.ok) throw new Error('ChatGPT could not return this conversation.');
    const data = await response.json();
    if (data.conversation_id !== ${JSON.stringify(source.id)} || !data.mapping || !data.current_node)
      throw new Error('ChatGPT returned an incomplete conversation.');
    return JSON.stringify(data);
  })()`;
  const result = await bridge.commandEmbeddedBrowser({ action: 'evaluate', tabId: tab.id, expression });
  if (result.kind !== 'value' || typeof result.value !== 'string') throw new Error('ChatGPT did not return a conversation.');
  return result.value;
}
