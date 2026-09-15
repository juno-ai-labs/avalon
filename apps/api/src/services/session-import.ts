import { SessionImportPreviewSchema, type SessionImportPreviewRequestSchema, type SessionImportPreview, type SubstreamContent, type ConversationFile } from "@rally/contracts";
import { z } from "zod";
import { describeZodIssues } from "@rally/contracts/zod-diagnostics";
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

function sourceFile(value: unknown, kind: ConversationFile["kind"]): ConversationFile {
  const file = object(value);
  const name = text(file['file_name']) || text(file['filename']) || text(file['name']) || text(file['title']) || "Imported file";
  const mimeType = text(file['mime_type']) || text(file['file_type']) || text(file['content_type']) || "application/octet-stream";
  const url = text(file['download_url']) || text(file['url']);
  const extracted = text(file['extracted_content']);
  return { name: extracted ? `${name} (extracted text).txt` : name, mimeType: extracted ? "text/plain" : mimeType, kind, source:
    extracted ? { kind: "inline", encoding: "utf8", data: extracted }
    : url.startsWith('https://') ? { kind: "remote", url }
    : { kind: "unavailable", reference: url || text(file['id']) || text(file['asset_pointer']) || name,
      reason: "The export does not contain downloadable file bytes." } };
}

function sourceFiles(value: unknown, kind: ConversationFile["kind"]): ConversationFile[] {
  const file = object(value);
  const extracted = text(file['extracted_content']);
  if (!extracted) return [sourceFile(value, kind)];
  const original = { ...file };
  delete original['extracted_content'];
  return [sourceFile(original, kind), sourceFile(value, kind)];
}

function visibleMessage(role: "user" | "assistant", body: string, files: ConversationFile[]) {
  // Claude's share/export text can contain complete artifact documents. Preserve
  // them as files, never execute or deploy their HTML, JavaScript or SVG.
  const rendered = body.replace(/<antArtifact\b([^>]*)>([\s\S]*?)<\/antArtifact>/g, (_match, attributes: string, content: string) => {
    const attribute = (key: string) => new RegExp(`${key}="([^"]*)"`).exec(attributes)?.[1];
    const name = attribute("title") || attribute("identifier") || "Claude artifact";
    files.push({ name, mimeType: attribute("type") || "text/plain", kind: "artifact",
      source: { kind: "inline", encoding: "utf8", data: content } });
    return `[Artifact: ${name}]`;
  });
  for (const match of rendered.matchAll(/\[([^\]]+)\]\((sandbox:\/[^)]+)\)/g)) {
    files.push({ name: match[1]!, mimeType: "application/octet-stream", kind: role === "assistant" ? "artifact" : "attachment",
      source: { kind: "unavailable", reference: match[2]!, reason: "This sandbox file is not included in the export. Add the original file to import it." } });
  }
  return rendered.trim() || files.length ? [{ role, text: rendered, ...(files.length ? { files } : {}) }] : [];
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
    if (!Array.isArray(conversation['linear_conversation'])) throw new Error("Expected mapping/current_node or linear_conversation");
    nodes = conversation['linear_conversation'];
  }
  return nodes.flatMap((node) => {
    const message = object(object(node)['message']);
    const role = object(message['author'])['role'];
    const metadata = object(message['metadata']);
    if ((role !== "user" && role !== "assistant") || metadata['is_visually_hidden_from_conversation'] === true
      || message['channel'] === "analysis" || message['channel'] === "summary"
      || (message['recipient'] != null && message['recipient'] !== "all")) return [];
    const content = object(message['content']);
    const kind = role === "user" ? "attachment" : "artifact";
    const files = array(metadata['attachments']).flatMap((file) => sourceFiles(file, kind));
    if (content['content_type'] !== "text" && content['content_type'] !== "multimodal_text") {
      throw new Error("Unsupported ChatGPT content.content_type");
    }
    if (!Array.isArray(content['parts'])) throw new Error("Expected ChatGPT content.parts array");
    const parts: string[] = [];
    for (const part of content['parts']) {
      if (typeof part === "string") parts.push(part);
      else if (object(part)['content_type'] === "image_asset_pointer") files.push(sourceFile(part, kind));
      else throw new Error("Unsupported ChatGPT visible content part");
    }
    return visibleMessage(role, parts.join("\n\n"), files);
  });
}

function claudeMessages(value: unknown): SubstreamContent["messages"] {
  const data = object(value);
  const messages = Array.isArray(value) ? value : Array.isArray(data['chat_messages']) ? data['chat_messages']
    : Object.hasOwn(data, 'message') ? [data] : null;
  if (!messages) throw new Error("Expected Claude chat_messages or Code message records");
  return messages.flatMap((value) => {
    const event = object(value);
    if (event['isCompactSummary'] === true || event['isMeta'] === true) return [];
    const message = Object.hasOwn(event, 'message') ? object(event['message']) : event;
    const sender = message['sender'] ?? message['role'];
    const role = sender === "human" ? "user" : sender;
    if (role !== "user" && role !== "assistant") return [];
    const kind = role === "user" ? "attachment" : "artifact";
    const files = [...array(message['attachments']), ...array(message['files'])].flatMap((file) => sourceFiles(file, kind));
    const content = message['content'];
    const parts: string[] = [];
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) for (const raw of content) {
      const part = object(raw);
      if (part['type'] === 'text') {
        if (typeof part['text'] !== 'string') throw new Error("Expected Claude text block text");
        parts.push(part['text']);
      } else if (part['type'] === 'image' || part['type'] === 'document') {
        const source = object(part['source']);
        files.push(source['type'] === 'base64' && typeof source['data'] === 'string'
          ? { name: text(part['title']) || text(part['name']) || `Imported ${part['type']}`, mimeType: text(source['media_type']) || 'application/octet-stream', kind,
              source: { kind: 'inline', encoding: 'base64', data: source['data'] } }
          : sourceFile({ ...part, url: source['url'] }, kind));
      } else if (part['type'] === 'artifact') {
        if (typeof part['content'] !== 'string') files.push(sourceFile(part, 'artifact'));
        else files.push({ name: text(part['title']) || 'Claude artifact', mimeType: text(part['mime_type']) || 'text/plain', kind: 'artifact',
          source: { kind: 'inline', encoding: 'utf8', data: part['content'] } });
      } else if (part['type'] === 'tool_use' && ['Write', 'artifacts'].includes(text(part['name']))) {
        const artifact = object(part['input']);
        const path = text(artifact['file_path']);
        const name = path.split('/').at(-1) || text(artifact['title']) || text(artifact['id']) || 'Claude artifact';
        files.push({ name, mimeType: text(artifact['type']) || 'text/plain', kind: 'artifact',
          source: typeof artifact['content'] === 'string'
            ? { kind: 'inline', encoding: 'utf8', data: artifact['content'] }
            : { kind: 'unavailable', reference: path || text(artifact['id']) || name,
                reason: 'This artifact event does not contain a complete file. Add the original file instead.' } });
      } else if (!['tool_use', 'tool_result', 'thinking', 'redacted_thinking'].includes(text(part['type']))) {
        throw new Error("Unsupported Claude content block type");
      }
    }
    else if (typeof message['text'] === 'string') parts.push(message['text']);
    else throw new Error("Expected Claude visible message content");
    return visibleMessage(role, parts.join("\n\n"), files);
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
    return SessionImportPreviewSchema.parse({
      title: text(data['title']) || text(data['snapshot_name']) || text(data['name']) || `Imported ${provider === "chatgpt" ? "ChatGPT" : "Claude"} conversation`,
      source: { provider, url: sourceUrl }, content: { messages },
    });
  } catch (error) {
    const detail = error instanceof z.ZodError ? `Invalid conversation fields: ${describeZodIssues(error)}`
      : error instanceof Error && !(error instanceof SyntaxError) ? error.message : "Malformed conversation data";
    throw new ApiError(422, "invalid_session_export", `${detail}. Import one conversation as JSON or a Claude Code JSONL export.`);
  }
}

export async function previewSessionImport(input: z.infer<typeof SessionImportPreviewRequestSchema>, fetcher: typeof fetch = fetch) {
  if (input.kind === "export") return parseSessionExport(input.provider, input.text);
  const { provider, url } = sessionShareUrl(input.url);
  const endpoint = provider === "claude"
    ? `https://claude.ai/api/chat_snapshots/${url.pathname.split('/').at(-1)}?rendering_mode=messages&render_all_tools=true`
    : url.href;
  let response: Response;
  let body: string;
  try {
    response = await fetcher(endpoint, { redirect: "manual" });
    body = await response.text();
  } catch {
    throw new ApiError(422, "session_unavailable", "The provider could not return this shared conversation. Import its JSON export instead.");
  }
  if (!response.ok || (provider === "claude" && body.trimStart().startsWith("<"))) {
    throw new ApiError(422, "session_unavailable", "The provider could not return this shared conversation. Import its JSON export instead.");
  }
  return parseSessionExport(provider, body, url.href);
}
