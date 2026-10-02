import { conversationSourceAt } from "@rally/contracts";

import { ApiError } from "../lib/api-error";

/**
 * The URLs a conversation import may name. The import itself is read by an
 * agent in the person's Rally browser (`session-import-run-service.ts`); this
 * module only decides which conversation a URL is and which provider owns it.
 */

/** Deliberately accept only public provider share routes; never follow arbitrary redirects. */
export function sessionShareUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new ApiError(422, "invalid_session_link", "Use an HTTPS ChatGPT or Claude share link");
  }
  const id = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
  const provider: "chatgpt" | "claude" | null = url.hostname === "chatgpt.com" ? "chatgpt" : url.hostname === "claude.ai" ? "claude" : null;
  if (!provider || !new RegExp(`^/share/${id}/?$`).test(url.pathname)) {
    if (url.hostname === "claude.ai" && /^\/code\/session_[a-zA-Z0-9]+$/.test(url.pathname)) {
      throw new ApiError(422, "session_login_required", "Claude Code sessions require signed-in access and cannot be imported from a URL.");
    }
    throw new ApiError(422, "invalid_session_link", "Use a ChatGPT or Claude public share link");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return { provider, url } as const;
}

/** Private browser URLs are provenance only; the API never fetches them. */
export function sessionSourceUrlProvider(value: string, sessionId: string): 'chatgpt' | 'claude' {
  const source = conversationSourceAt(value);
  if (source && !source.shared) {
    if (source.sessionId !== sessionId) {
      throw new ApiError(422, 'invalid_session_source', 'The sourceUrl names a different conversation than source.sessionId');
    }
    return source.provider;
  }
  if (source) return source.provider;
  return sessionShareUrl(value).provider;
}

/**
 * The conversation a browser URL names, for an import's provenance: its
 * provider, the id in its path, and the URL without query or fragment. The
 * routes are `conversationSourceAt`'s, shared with the desktop.
 */
export function browserConversationSource(value: string): {
  provider: "chatgpt" | "claude"; sessionId: string; url: string;
} {
  const source = conversationSourceAt(value);
  if (!source) {
    throw new ApiError(422, "invalid_session_source", "Open a ChatGPT or Claude conversation in Rally's browser");
  }
  return { provider: source.provider, sessionId: source.sessionId, url: source.url };
}
