/**
 * Which AI conversation a web URL names, for an import: its provider, whether
 * it is the person's own or a public share, the id in its path, and the URL
 * without query or fragment.
 *
 * One table for the desktop, which decides when Import is offered, and the
 * API, which decides what an import is about. The id always comes from the
 * path and never from the agent that reads the page, so a model cannot attach
 * an import to a different conversation than the one the person opened.
 */

export type ConversationSourceProvider = "chatgpt" | "claude";

export interface ConversationSource {
  provider: ConversationSourceProvider;
  /** A public share link rather than the person's own conversation. */
  shared: boolean;
  /** The provider's id for the conversation, exactly as its path spells it. */
  sessionId: string;
  /** `https://<host>/<path>`: no query, no fragment, no trailing slash. */
  url: string;
  /** What to call it before the page has given it a title. */
  fallbackTitle: string;
}

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";

interface Route {
  provider: ConversationSourceProvider;
  hostname: string;
  /** Matches the whole path; group 1 is the id. */
  path: RegExp;
  shared: boolean;
  fallbackTitle: string;
  /** UUIDs compare case-insensitively; the other ids are case-sensitive tokens. */
  lowercase: boolean;
}

const ROUTES: readonly Route[] = [
  { provider: "chatgpt", hostname: "chatgpt.com", path: new RegExp(`^/c/(${UUID})/?$`, "iu"), shared: false, lowercase: true, fallbackTitle: "ChatGPT conversation" },
  { provider: "chatgpt", hostname: "chatgpt.com", path: new RegExp(`^/share/(${UUID})/?$`, "iu"), shared: true, lowercase: true, fallbackTitle: "Shared ChatGPT conversation" },
  // A shared Codex or agent task: `/s/cx_<hex>`.
  { provider: "chatgpt", hostname: "chatgpt.com", path: /^\/s\/([a-z]{1,8}_[a-f0-9]{16,64})\/?$/u, shared: true, lowercase: false, fallbackTitle: "Shared ChatGPT task" },
  { provider: "claude", hostname: "claude.ai", path: new RegExp(`^/chat/(${UUID})/?$`, "iu"), shared: false, lowercase: true, fallbackTitle: "Claude conversation" },
  { provider: "claude", hostname: "claude.ai", path: new RegExp(`^/share/(${UUID})/?$`, "iu"), shared: true, lowercase: true, fallbackTitle: "Shared Claude conversation" },
  // A Claude Code session on the web, readable only signed in as its owner.
  { provider: "claude", hostname: "claude.ai", path: /^\/code\/(session_[A-Za-z0-9]{8,64})\/?$/u, shared: false, lowercase: false, fallbackTitle: "Claude Code session" },
];

/** The conversation `value` names, or null for any other URL. */
export function conversationSourceAt(value: string): ConversationSource | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  for (const route of ROUTES) {
    if (url.hostname !== route.hostname) continue;
    const id = route.path.exec(url.pathname)?.[1];
    if (!id) continue;
    const sessionId = route.lowercase ? id.toLowerCase() : id;
    const path = url.pathname.replace(/\/$/u, "");
    const prefix = path.slice(0, path.length - id.length);
    return { provider: route.provider, shared: route.shared, sessionId, url: `https://${url.hostname}${prefix}${sessionId}`,
      fallbackTitle: route.fallbackTitle };
  }
  return null;
}
