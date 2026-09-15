import { SessionImportPreviewSchema, type SessionImportPreviewRequestSchema, type SessionImportPreview, type SubstreamContent } from "@rally/contracts";
import { preparedContentMessages } from "@rally/agent-harness";
import { z } from "zod";
import { ApiError } from "../lib/api-error";

const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value : "";

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
      throw new ApiError(422, "session_login_required", "Claude Code sessions require signed-in access. Export the session as JSONL and import the file instead.");
    }
    throw new ApiError(422, "invalid_session_link", "Use a ChatGPT or Claude public share link");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return { provider, url } as const;
}

/** Decode only the JSON reference table used by the observed ChatGPT share loader.
 * No script execution or arbitrary object constructors. Cyclic input fails closed.
 */
function chatGptHtmlData(html: string): unknown {
  const match = /streamController\.enqueue\(("(?:[^"\\]|\\.)*")\)/.exec(html);
  if (!match?.[1]) throw new Error("Share page has no conversation data");
  const table = z.array(z.unknown()).parse(JSON.parse(JSON.parse(match[1]) as string));
  const active = new Set<number>();
  const memo = new Map<number, unknown>();
  const decode = (index: number): unknown => {
    if (index < 0) return null;
    if (!Number.isInteger(index) || index >= table.length || active.has(index)) throw new Error("Invalid share reference");
    if (memo.has(index)) return memo.get(index);
    active.add(index);
    const value = table[index];
    const result: unknown = Array.isArray(value) ? value.map((item: unknown) => decode(z.number().parse(item)))
      : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, reference]) => {
        if (!/^_\d+$/.test(key)) throw new Error("Invalid share key");
        return [z.string().parse(decode(Number(key.slice(1)))), decode(z.number().parse(reference))];
      })) : value;
    active.delete(index);
    memo.set(index, result);
    return result;
  };
  // Decode the conversation itself, avoiding unrelated loader extensions.
  const dataKey = table.indexOf("linear_conversation");
  const entry = table.findIndex((value) => Object.hasOwn(object(value), `_${dataKey}`));
  if (entry < 0) throw new Error("Share page has no transcript");
  return decode(entry);
}

function chatGptMessages(value: unknown): SubstreamContent["messages"] {
  const conversation = object(value);
  let nodes: unknown[];
  const mapping = object(conversation['mapping']);
  if (text(conversation['current_node']) && Object.keys(mapping).length) {
    nodes = [];
    let id = text(conversation['current_node']);
    const visited = new Set<string>();
    while (id) {
      if (visited.has(id) || !Object.hasOwn(mapping, id)) throw new Error("Invalid conversation branch");
      visited.add(id);
      const node = object(mapping[id]);
      nodes.push(node);
      id = text(node['parent']);
    }
    nodes.reverse();
  } else {
    nodes = array(conversation['linear_conversation']);
  }
  return nodes.flatMap((node) => {
    const message = object(object(node)['message']);
    const role = object(message['author'])['role'];
    const metadata = object(message['metadata']);
    if ((role !== "user" && role !== "assistant") || metadata['is_visually_hidden_from_conversation'] === true
      || (message['channel'] === "analysis" || message['channel'] === "summary")
      || (message['recipient'] != null && message['recipient'] !== "all")) return [];
    const content = object(message['content']);
    if (content['content_type'] !== "text" && content['content_type'] !== "multimodal_text") return [];
    const body = array(content['parts']).filter((part): part is string => typeof part === "string").join("\n\n");
    return body.trim() ? [{ role, text: body }] : [];
  });
}

function claudeMessages(value: unknown): SubstreamContent["messages"] {
  const messages = Array.isArray(value) ? value : array(object(value)['chat_messages']);
  return messages.flatMap((value) => {
    const event = object(value);
    // Code exports wrap API messages and include separate progress/summary events.
    if (event['isCompactSummary'] === true || event['isMeta'] === true) return [];
    const message = Object.hasOwn(event, 'message') ? object(event['message']) : event;
    const sender = message['sender'] ?? message['role'];
    const role = sender === "human" ? "user" : sender;
    if (role !== "user" && role !== "assistant") return [];
    const content = message['content'];
    const body = typeof content === "string" ? content : Array.isArray(content)
      ? content.flatMap((part: unknown) => object(part)['type'] === "text" ? [text(object(part)['text'])] : []).join("\n\n")
      : text(message['text']);
    return body.trim() ? [{ role, text: body }] : [];
  });
}

export function parseSessionExport(provider: "chatgpt" | "claude", input: string, sourceUrl: string | null = null): SessionImportPreview {
  try {
    let value: unknown;
    if (provider === "chatgpt" && input.trimStart().startsWith("<")) value = chatGptHtmlData(input);
    else {
      try { value = JSON.parse(input) as unknown; }
      catch { value = input.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown); }
    }
    if (Array.isArray(value) && (provider === "chatgpt" || value.some((entry) => Array.isArray(object(entry)["chat_messages"])))) {
      if (value.length !== 1) throw new Error("Choose one conversation from the export");
      value = value[0];
    }
    const data = object(value);
    const messages = provider === "chatgpt" ? chatGptMessages(value) : claudeMessages(value);
    // The same projection is consumed by prepared demos and checkpoint fixtures.
    preparedContentMessages({ messages });
    return SessionImportPreviewSchema.parse({
      title: text(data['title']) || text(data['snapshot_name']) || text(data['name']) || `Imported ${provider === "chatgpt" ? "ChatGPT" : "Claude"} conversation`,
      source: { provider, url: sourceUrl }, content: { messages },
    });
  } catch {
    throw new ApiError(422, "invalid_session_export", "No readable conversation was found. Import one conversation as JSON or a Claude Code JSONL export.");
  }
}

export async function previewSessionImport(input: z.infer<typeof SessionImportPreviewRequestSchema>, fetcher: typeof fetch = fetch) {
  if (input.kind === "export") return parseSessionExport(input.provider, input.text);
  const { provider, url } = sessionShareUrl(input.url);
  const endpoint = provider === "claude"
    ? `https://claude.ai/api/chat_snapshots/${url.pathname.split('/').at(-1)}?rendering_mode=messages&render_all_tools=true`
    : url.href;
  const response = await fetcher(endpoint, { redirect: "manual" });
  const body = await response.text();
  if (!response.ok || (provider === "claude" && body.trimStart().startsWith("<"))) {
    throw new ApiError(422, "session_unavailable", "The provider could not return this shared conversation. Import its JSON export instead.");
  }
  return parseSessionExport(provider, body, url.href);
}
