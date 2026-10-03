import { conversationSourceAt, type ConversationSourceProvider } from '@rally/contracts';
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
