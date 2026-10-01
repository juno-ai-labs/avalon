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
  const url = new URL(value);
  const privateRoute = url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash
    ? /^\/(c|chat)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/iu.exec(url.pathname) : null;
  const privateProvider = privateRoute && url.hostname === 'chatgpt.com' && privateRoute[1] === 'c' ? 'chatgpt'
    : privateRoute && url.hostname === 'claude.ai' && privateRoute[1] === 'chat' ? 'claude' : null;
  if (privateProvider && privateRoute?.[2] === sessionId) return privateProvider;
  if (privateProvider) {
    throw new ApiError(422, 'invalid_session_source', 'The sourceUrl names a different conversation than source.sessionId');
  }
  return sessionShareUrl(value).provider;
}

/**
 * The conversation a browser URL names, for an import's provenance: its
 * provider, the id in its path, and the URL without query or fragment.
 *
 * Accepts the signed-in routes (`chatgpt.com/c/<id>`, `claude.ai/chat/<id>`)
 * and the public share routes (`/share/<id>`). The id comes from the path and
 * never from the agent that reads the page, so a model cannot attach an
 * import to a different conversation than the one the person opened.
 */
export function browserConversationSource(value: string): {
  provider: "chatgpt" | "claude"; sessionId: string; url: string;
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(422, "invalid_session_source", "Open a ChatGPT or Claude conversation in Rally's browser");
  }
  const route = url.protocol === "https:" && !url.username && !url.password && !url.port
    ? /^\/(c|chat|share)\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/?$/iu.exec(url.pathname) : null;
  const provider = route && url.hostname === "chatgpt.com" && (route[1] === "c" || route[1] === "share") ? "chatgpt"
    : route && url.hostname === "claude.ai" && (route[1] === "chat" || route[1] === "share") ? "claude" : null;
  if (!route || !provider) {
    throw new ApiError(422, "invalid_session_source", "Open a ChatGPT or Claude conversation in Rally's browser");
  }
  return { provider, sessionId: route[2]!.toLowerCase(), url: `https://${url.hostname}/${route[1]}/${route[2]!.toLowerCase()}` };
}
