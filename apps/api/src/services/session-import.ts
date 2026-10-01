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
    throw new ApiError(422, 'invalid_session_source', 'The sourceUrl names a different conversation than the decoded text');
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

function sourceFile(value: unknown, kind: ConversationFile["kind"]): ConversationFile {
  const file = object(value);
  // A reader that copied different bytes than the named file — a preview in
  // another format — names the copy for what it is.
  const extracted = text(file['extracted_content']);
  const name = (!extracted && text(file['inline_base64']) && text(file['inline_name']))
    || text(file['file_name']) || text(file['filename']) || text(file['name']) || text(file['title']) || "Imported file";
  const mimeType = text(file['mime_type']) || text(file['file_type']) || text(file['content_type']) || "application/octet-stream";
  const url = text(file['download_url']) || text(file['url']);
  // Bytes a signed-in browser reader fetched on the person's behalf.
  const bytes = text(file['inline_base64']);
  return { name: extracted ? `${name} (extracted text).txt` : withExtension(name, mimeType), mimeType: extracted ? "text/plain" : mimeType, kind, source:
    extracted ? { kind: "inline", encoding: "utf8", data: extracted }
    : bytes ? { kind: "inline", encoding: "base64", data: bytes }
    : url.startsWith('https://') ? { kind: "remote", url }
    : { kind: "unavailable", reference: url || text(file['id']) || text(file['asset_pointer']) || name,
      // A reader that declined to copy a file says why; otherwise it had no bytes.
      reason: text(file['rally_unavailable_reason']) || "The export does not contain downloadable file bytes." } };
}

function sourceFiles(value: unknown, kind: ConversationFile["kind"]): ConversationFile[] {
  const file = object(value);
  const extracted = text(file['extracted_content']);
  if (!extracted) return [sourceFile(value, kind)];
  const original = { ...file };
  delete original['extracted_content'];
  return [sourceFile(original, kind), sourceFile(value, kind)];
}

function claudeContentFile(part: Record<string, unknown>, kind: ConversationFile["kind"]): ConversationFile {
  const source = object(part['source']);
  const type = text(part['type']);
  return (source['type'] === 'base64' || (type === 'document' && source['type'] === 'text')) && typeof source['data'] === 'string'
    ? { name: text(part['title']) || text(part['name']) || `Imported ${type}`,
        mimeType: text(source['media_type']) || 'application/octet-stream', kind,
        source: { kind: 'inline', encoding: source['type'] === 'text' ? 'utf8' : 'base64', data: source['data'] } }
    : sourceFile({ ...part, url: source['url'] }, kind);
}

function visibleMessage(role: "user" | "assistant", body: string, files: ConversationFile[], sourceMessageId?: string) {
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
      source: { kind: "unavailable", reference: match[2]!, reason: "This sandbox file is not included in the source conversation." } });
  }
  return rendered.trim() || files.length ? [{ role, text: rendered, ...(files.length ? { files } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}) }] : [];
}

/** `sediment://file_…` and `file-service://file-…` both end in the file's id; a share adds a query. */
function chatGptAssetFileId(pointer: unknown): string {
  return text(pointer).replace(/^[a-z-]+:\/\//u, '').split('?')[0]!;
}

/**
 * ChatGPT marks links and citations inline with private-use delimiters
 * (U+E200 … U+E201) and describes each one in `content_references`. A marker
 * with a written form — a link's `[label](url)` — becomes that text; anything
 * else, such as a citation whose sources live elsewhere in the response, is
 * dropped rather than shown as control characters.
 */
function chatGptVisibleText(value: string, metadata: Record<string, unknown>): string {
  let result = value;
  for (const reference of array(metadata['content_references'])) {
    const marker = text(object(reference)['matched_text']);
    if (marker.startsWith('\uE200')) result = result.split(marker).join(text(object(reference)['alt']));
  }
  return result.replace(/\uE200[^\uE201]*\uE201/gu, '').trim();
}

/**
 * A ChatGPT app can render its answer in a widget instead of a turn. Deep
 * Research does: its finished report is a complete assistant message stored
 * in the tool result's widget state, and the page shows it in an embedded
 * frame. That report is the answer the person asked for, so it imports as an
 * assistant message where the widget appears.
 */
function chatGptWidgetReport(message: Record<string, unknown>): SubstreamContent["messages"] | null {
  const state = text(object(object(message['metadata'])['chatgpt_sdk'])['widget_state']);
  if (!state) return null;
  let widget: unknown;
  try { widget = JSON.parse(state); } catch { return null; }
  const report = object(object(widget)['report_message']);
  const parts = array(object(report['content'])['parts']).filter((part): part is string => typeof part === 'string');
  const body = chatGptVisibleText(parts.join("\n\n"), object(report['metadata']));
  return body ? visibleMessage("assistant", body, [], text(report['id']) || text(message['id'])) : null;
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
  return nodes.flatMap((node, index) => {
    const message = object(object(node)['message']);
    const sourceMessageId = text(message['id']) || text(object(node)['id']) || `position:${index}`;
    const report = chatGptWidgetReport(message);
    if (report) return report;
    const sourceRole = object(message['author'])['role'];
    const role = sourceRole === "tool" && message['channel'] === "final" ? "assistant" : sourceRole;
    const metadata = object(message['metadata']);
    if ((role !== "user" && role !== "assistant") || metadata['is_visually_hidden_from_conversation'] === true
      // `commentary` is an agent's progress narration, shown only inside the
      // collapsed work log with its tool steps — not a turn of the conversation.
      || message['channel'] === "analysis" || message['channel'] === "summary" || message['channel'] === "commentary"
      || (message['recipient'] != null && message['recipient'] !== "all")) return [];
    const content = object(message['content']);
    if (["model_editable_context", "thoughts", "reasoning_recap"].includes(text(content['content_type']))) return [];
    // Only final image outputs are user-visible tool results. Preserve their files,
    // never the tool's prose, invocation, or intermediate/hidden image copies.
    if (sourceRole === "tool") {
      const images = array(content['parts']).filter((part) => object(part)['content_type'] === "image_asset_pointer");
      return visibleMessage("assistant", "", images.map((part) => sourceFile({
        ...object(part), name: text(metadata['image_gen_title']) || "Generated image",
      }, "artifact")), sourceMessageId);
    }
    const kind = role === "user" ? "attachment" : "artifact";
    const attachments = array(metadata['attachments']);
    const files = attachments.flatMap((file) => sourceFiles(file, kind));
    // An uploaded image is listed as an attachment and again as the part that
    // displays it; the attachment carries its name, so it stands for both.
    const attached = new Set(attachments.map((file) => text(object(file)['id'])).filter(Boolean));
    if (content['content_type'] !== "text" && content['content_type'] !== "multimodal_text") {
      throw new Error("Unsupported ChatGPT content.content_type");
    }
    if (!Array.isArray(content['parts'])) throw new Error("Expected ChatGPT content.parts array");
    const parts: string[] = [];
    for (const part of content['parts']) {
      if (typeof part === "string") parts.push(part);
      else if (object(part)['content_type'] === "image_asset_pointer") {
        if (!attached.has(chatGptAssetFileId(object(part)['asset_pointer']))) files.push(sourceFile(part, kind));
      }
      else throw new Error("Unsupported ChatGPT visible content part");
    }
    // A sandbox: link names a file ChatGPT wrote in its code sandbox. The
    // reader copies it; the dead link then reads as its label beside the file.
    const copied = new Map(array(metadata['rally_sandbox_files']).map(object)
      .filter((file) => text(file['link'])).map((file) => [text(file['link']), file]));
    const linked = new Set<string>();
    const body = chatGptVisibleText(parts.join("\n\n"), metadata).replace(/\[([^\]]*)\]\((sandbox:[^)\s]+)\)/gu, (whole, label: string, link: string) => {
      if (!linked.has(link)) {
        linked.add(link);
        const file = copied.get(link);
        files.push(file && text(file['inline_base64']) ? sourceFile(file, kind) : { name: text(file?.['name']) || link.split('/').at(-1) || 'Sandbox file', mimeType: 'application/octet-stream', kind,
          source: { kind: 'unavailable', reference: link, reason: text(file?.['rally_unavailable_reason']) || 'ChatGPT did not return this sandbox file. Download it from the conversation instead.' } });
      }
      return label || whole;
    });
    return visibleMessage(role, body, files, sourceMessageId);
  });
}

/**
 * claude.ai marks the span each web source supports and shows the source as a
 * chip after it. The chip becomes an inline `([host](url))` link after that
 * span, the form ChatGPT's own references take.
 */
const CLAUDE_FILE_TYPES: Record<string, string> = {
  md: 'text/markdown', html: 'text/html', htm: 'text/html', json: 'application/json', svg: 'image/svg+xml',
  csv: 'text/csv', js: 'text/javascript', ts: 'text/plain', py: 'text/x-python', css: 'text/css',
};

/** Only types that name one extension; plain text could be anything. */
const TYPE_EXTENSIONS: Record<string, string> = {
  'text/markdown': '.md', 'text/html': '.html', 'application/json': '.json', 'image/svg+xml': '.svg',
  'text/csv': '.csv', 'text/javascript': '.js', 'text/x-python': '.py', 'text/css': '.css',
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf',
};

/** A titled file — a generated image, a report — is named so it opens as its type. */
function withExtension(name: string, mimeType: string): string {
  return /\.[a-z0-9]{1,5}$/iu.test(name) ? name : `${name}${TYPE_EXTENSIONS[mimeType] ?? ''}`;
}

function claudeFileType(path: string): string {
  return CLAUDE_FILE_TYPES[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'text/plain';
}

function claudeCitedText(value: string, citations: unknown[]): string {
  const links = citations.flatMap((raw) => {
    const citation = object(raw);
    const end = citation['end_index'];
    const url = text(citation['url']);
    if (typeof end !== 'number' || !Number.isInteger(end) || end < 0 || end > value.length || !url.startsWith('https://')) return [];
    try { return [{ end, link: ` ([${new URL(url).hostname.replace(/^www\./u, '')}](${url}))` }]; } catch { return []; }
  });
  // Several sources can support one span; each distinct link appears once,
  // in the order claude.ai listed them.
  const byEnd = new Map<number, string[]>();
  for (const { end, link } of links) {
    const at = byEnd.get(end) ?? [];
    if (!at.includes(link)) at.push(link);
    byEnd.set(end, at);
  }
  let result = value;
  for (const end of [...byEnd.keys()].sort((a, b) => b - a)) result = result.slice(0, end) + byEnd.get(end)!.join('') + result.slice(end);
  return result;
}

function claudeMessages(value: unknown): SubstreamContent["messages"] {
  const messages = object(value)['chat_messages'];
  if (!Array.isArray(messages)) throw new Error("Expected Claude chat_messages");
  // An Artifact imports once, where the conversation first shows it: its
  // files are its current version, not the version a later card republished.
  const published = new Set<string>();
  return messages.flatMap((value, index) => {
    const message = object(value);
    const sender = message['sender'];
    const role = sender === "human" ? "user" : sender;
    if (role !== "user" && role !== "assistant") return [];
    const kind = role === "user" ? "attachment" : "artifact";
    // claude.ai lists uploads in `files` and, for newer ones, `files_v2`; an
    // upload in both is one file.
    const listed = [...array(message['files']), ...array(message['files_v2'])];
    const uploads = listed.filter((file, index) => {
      const id = text(object(file)['file_uuid']) || text(object(file)['uuid']);
      return !id || listed.findIndex((other) => (text(object(other)['file_uuid']) || text(object(other)['uuid'])) === id) === index;
    });
    const files = [...array(message['attachments']), ...uploads].flatMap((file) => sourceFiles(file, kind));
    if (message['truncated'] === true) throw new Error("Claude message is truncated");
    const reportedFiles = typeof message['file_count'] === "number" ? message['file_count'] : 0;
    if (reportedFiles > files.length) files.push({ name: "Hidden shared attachments", mimeType: "application/octet-stream", kind,
      source: { kind: "unavailable", reference: text(message['uuid']) || "hidden-attachments", reason: "The shared conversation hides attachment contents." } });
    const content = message['content'];
    const parts: string[] = [];
    const failed = new Set(array(content).map(object).filter((part) => part['type'] === 'tool_result' && part['is_error'] === true)
      .map((part) => text(part['tool_use_id'])));
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) for (const raw of content) {
      const part = object(raw);
      // claude.ai shows a published Artifact as a card on the tool step that
      // published it. The browser reader copies the Artifact's current files
      // onto that card; they import as the reply's files, once per Artifact.
      // Without them — a public share, or a copy that failed — the card's
      // link stands in so the reply does not silently lose what it made.
      const card = object(part['display_content']);
      const link = part['type'] === 'tool_result' && card['type'] === 'file' ? text(card['published_url']) : '';
      if (link.startsWith('https://') && !published.has(link)) {
        published.add(link);
        const copies = array(card['rally_files']).map(object).filter((file) => text(file['path']) && text(file['inline_base64']));
        for (const file of copies) files.push({ name: text(file['path']).split('/').at(-1)!, kind: 'artifact',
          mimeType: text(file['content_type']) || claudeFileType(text(file['path'])),
          source: { kind: 'inline', encoding: 'base64', data: text(file['inline_base64']) } });
        if (!copies.length) parts.push(`[${(text(card['title']) || 'Claude artifact').replace(/[[\]]/gu, '')}](${link})`);
        continue;
      }
      if (part['type'] === 'text') {
        if (typeof part['text'] !== 'string') throw new Error("Expected Claude text block text");
        parts.push(claudeCitedText(part['text'], array(part['citations'])));
      } else if (part['type'] === 'image' || part['type'] === 'document') {
        files.push(claudeContentFile(part, kind));
      } else if (part['type'] === 'artifact') {
        if (typeof part['content'] !== 'string') files.push(sourceFile(part, 'artifact'));
        else files.push({ name: text(part['title']) || 'Claude artifact', mimeType: text(part['mime_type']) || 'text/plain', kind: 'artifact',
          source: { kind: 'inline', encoding: 'utf8', data: part['content'] } });
      } else if (part['type'] === 'tool_use' && text(part['name']) === 'artifacts') {
        const artifact = object(part['input']);
        const path = text(artifact['file_path']);
        const mimeType = text(artifact['type']) || 'text/plain';
        const titled = text(artifact['title']) || text(artifact['id']) || 'Claude artifact';
        // A titled artifact has no file name; give it the extension its type
        // opens with. A Research report's sources are cited inside it.
        const name = path.split('/').at(-1) || withExtension(titled, mimeType);
        files.push({ name, mimeType, kind: 'artifact',
          source: typeof artifact['content'] === 'string'
            ? { kind: 'inline', encoding: 'utf8', data: claudeCitedText(artifact['content'], array(artifact['md_citations'])) }
            : { kind: 'unavailable', reference: path || text(artifact['id']) || name,
                reason: 'This artifact event does not contain a complete file. Add the original file instead.' } });
      } else if (part['type'] === 'tool_use' && text(part['name']) === 'create_file' && !failed.has(text(part['id']))) {
        // claude.ai's file tool: the document a person asked for, shown as the
        // tool step's code. A write the tool refused created nothing, and a
        // file written into an Artifact's publishing folder is a draft of that
        // Artifact, which imports as its published link instead.
        const input = object(part['input']);
        const path = text(input['path']);
        if (typeof input['file_text'] === 'string' && path && !path.startsWith('/mnt/user-data/outputs/artifacts/')) files.push({ name: path.split('/').at(-1) || 'Claude file',
          mimeType: claudeFileType(path), kind: 'artifact', source: { kind: 'inline', encoding: 'utf8', data: input['file_text'] } });
      } else if (part['type'] === 'tool_use' && text(part['name']).endsWith(':show_widget') && !failed.has(text(part['id']))) {
        // A visual drawn in the conversation. It is kept as a file, never run.
        const input = object(part['input']);
        const code = text(input['widget_code']);
        const svg = code.trimStart().startsWith('<svg');
        if (code) files.push({ name: `${text(input['title']) || 'Claude visual'}.${svg ? 'svg' : 'html'}`,
          mimeType: svg ? 'image/svg+xml' : 'text/html', kind: 'artifact', source: { kind: 'inline', encoding: 'utf8', data: code } });
      } else if (!['tool_use', 'tool_result', 'thinking', 'redacted_thinking', 'token_budget'].includes(text(part['type']))) {
        throw new Error("Unsupported Claude content block type");
      }
    }
    else if (typeof message['text'] === 'string') parts.push(message['text']);
    else throw new Error("Expected Claude visible message content");
    return visibleMessage(role, parts.join("\n\n").trim(), files,
      text(message['uuid']) || `position:${index}`);
  });
}


export function parseSessionExport(provider: "chatgpt" | "claude", input: string, sourceUrl: string | null = null): SessionImportPreview {
  try {
    const value: unknown = JSON.parse(input);
    const data = object(value);
    const messages = provider === "chatgpt" ? chatGptMessages(value) : claudeMessages(value);
    const sourceSessionId = text(data['uuid']) || text(data['conversation_id']) || text(data['id']) || sourceUrl;
    return SessionImportPreviewSchema.parse({
      title: text(data['title']) || text(data['snapshot_name']) || text(data['name']) || `Imported ${provider === "chatgpt" ? "ChatGPT" : "Claude"} conversation`,
      source: { provider, url: sourceUrl, ...(sourceSessionId ? { sessionId: sourceSessionId } : {}) }, content: { messages },
    });
  } catch (error) {
    const detail = error instanceof z.ZodError ? `Invalid conversation fields: ${describeZodIssues(error)}`
      : error instanceof Error && !(error instanceof SyntaxError) ? error.message : "Malformed conversation data";
    throw new ApiError(422, "invalid_session_export", detail);
  }
}

/** The browser read the conversation; the API decodes it and checks its source. */
export async function previewSessionImport(input: z.infer<typeof SessionImportPreviewRequestSchema>) {
  const preview = parseSessionExport(input.provider, input.text, input.sourceUrl);
  if (sessionSourceUrlProvider(input.sourceUrl, preview.source.sessionId ?? '') !== input.provider) {
    throw new ApiError(422, 'invalid_session_source', 'The sourceUrl does not belong to the stated provider');
  }
  return preview;
}
