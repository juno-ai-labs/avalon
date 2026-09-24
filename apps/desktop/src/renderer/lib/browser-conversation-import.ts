import type { EmbeddedBrowserTab } from '../../common/embedded-browser';
import type { RallyDesktopBridge } from '../../common/desktop';

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

function conversationAt(value: string, title: string): BrowserConversation | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    for (const route of conversationRoutes) {
      const match = url.hostname === route.hostname ? route.path.exec(url.pathname) : null;
      if (match?.[1]) return { provider: route.provider, id: match[1], url: `${url.origin}${url.pathname.replace(/\/$/u, '')}`,
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
 * Electron replaces an error thrown by page script with a generic message, so
 * a failure comes back as a value. Only this reader's own messages are shown;
 * anything else thrown in the page is reported generically. A reader returns
 * the conversation text, or the text and the files it could not fetch itself.
 */
function inPage(body: string): string {
  return `(async () => {
    class Failure extends Error {}
    try {
      const read = await (async () => {${body}})();
      return typeof read === 'string' ? { text: read } : read;
    } catch (error) {
      return { error: error instanceof Failure ? error.message : null };
    }
  })()`;
}

/**
 * Bytes of one file the reader downloads from a provider before it is imported.
 *
 * Bounds: one file held in the import window's memory, then again as base64
 *   and across IPC, before the API's upload sees it.
 * Without it: a shared conversation holding a 1 GB video makes the reader hold
 *   ~1.3 GB before the API rejects the file, which can exhaust the renderer.
 *   Checked 2026-09-24: the API enforces its limit only after the bytes arrive.
 * Value: Rally's attachment upload limit, `MAX_ATTACHMENT_BYTES` in
 *   `apps/api/wrangler.global.jsonc` (25,000,000), chosen by the team on
 *   2026-09-24 so that no file the upload would accept is skipped. Keep the two
 *   equal.
 * Trips: the file is not downloaded and imports as unavailable, saying why.
 */
export const MAX_BROWSER_IMPORT_FILE_BYTES = 25_000_000;

/** The unavailable reason a skipped file carries into the import. */
const TOO_LARGE_REASON = `The file is larger than Rally's ${MAX_BROWSER_IMPORT_FILE_BYTES / 1_000_000} MB attachment limit.`;

/**
 * Page-script helpers that hold a download to the file budget: a size the
 * provider reports is checked before downloading, a declared length before
 * reading the body, and the body's own size after.
 */
const CAPPED_READS = `
    const maxFileBytes = ${MAX_BROWSER_IMPORT_FILE_BYTES};
    const tooLarge = ${JSON.stringify(TOO_LARGE_REASON)};
    const within = (size) => !(typeof size === 'number' && size > maxFileBytes);
    const readCapped = async (response) => {
      if (!within(Number(response.headers.get('content-length')) || undefined)) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      const blob = await response.blob();
      return within(blob.size) ? blob : null;
    };
`;

/**
 * A file the page may not fetch itself — another origin that does not allow
 * it — loaded instead with the tab's own session through DevTools' network
 * loader, which is not subject to the page's CORS rules.
 */
interface CrossOriginFile {
  /** Where the bytes go in the conversation JSON. */
  owner: string;
  path: string;
  contentType: string;
  url: string;
}

export async function loadThroughTab(bridge: ReaderBridge, tabId: string, frameId: string, url: string, maxBytes: number): Promise<string | null> {
  const loaded = await bridge.commandEmbeddedBrowser({ action: 'cdp', tabId, method: 'Network.loadNetworkResource',
    params: { frameId, url, options: { disableCache: false, includeCredentials: true } } });
  const resource = loaded.kind === 'value' ? (loaded.value as { resource?: { success?: boolean; httpStatusCode?: number; stream?: string } }).resource : undefined;
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
      if (binary.length > maxBytes) return null;
      done = value.eof !== false;
    }
  } finally {
    await bridge.commandEmbeddedBrowser({ action: 'cdp', tabId, method: 'IO.close', params: { handle: resource.stream } }).catch(() => undefined);
  }
  return btoa(binary);
}

/** Put each loaded file beside the Artifact card that names its owner. */
async function attachCrossOriginFiles(bridge: ReaderBridge, tabId: string, text: string, files: CrossOriginFile[]): Promise<string> {
  if (!files.length) return text;
  const tree = await bridge.commandEmbeddedBrowser({ action: 'cdp', tabId, method: 'Page.getFrameTree' });
  const frameId = tree.kind === 'value' ? (tree.value as { frameTree?: { frame?: { id?: string } } }).frameTree?.frame?.id : undefined;
  if (!frameId) return text;
  const byOwner = new Map<string, Array<{ path: string; content_type: string; inline_base64: string }>>();
  for (const file of files) {
    const bytes = await loadThroughTab(bridge, tabId, frameId, file.url, MAX_BROWSER_IMPORT_FILE_BYTES).catch(() => null);
    if (bytes !== null) byOwner.set(file.owner, [...(byOwner.get(file.owner) ?? []), { path: file.path, content_type: file.contentType, inline_base64: bytes }]);
  }
  const data = JSON.parse(text) as { chat_messages?: Array<{ content?: Array<{ display_content?: Record<string, unknown> }> }> };
  for (const message of data.chat_messages ?? []) {
    for (const block of message.content ?? []) {
      const owner = block.display_content?.['published_artifact_id'];
      if (typeof owner === 'string' && byOwner.has(owner)) block.display_content!['rally_files'] = byOwner.get(owner);
    }
  }
  return JSON.stringify(data);
}

/**
 * Both scripts run inside the visited page, in its own origin and session.
 * Neither returns a credential: only the conversation JSON crosses IPC.
 */
function chatGptReader(conversation: BrowserConversation): string {
  // A person's own conversation and its files come from ChatGPT's signed-in
  // API, with the access token its own client takes from the same-origin
  // session endpoint; cookies alone can return a misleading guest 404. A shared
  // one comes from the same routes' anonymous counterparts, which address files
  // by the share rather than the conversation. Both return the same JSON.
  const id = conversation.id;
  const routes = conversation.shared ? {
    conversation: `'/backend-anon/share/${id}'`,
    file: `(file) => '/backend-anon/files/download/' + encodeURIComponent(file) + '?shared_conversation_id=${id}&inline=false'`,
    sandbox: `(message, path) => '/backend-anon/share/${id}/file_from_message/' + encodeURIComponent(message) + '?file_path=' + encodeURIComponent(path)`,
  } : {
    conversation: `'/backend-api/conversation/${id}'`,
    file: `(file) => '/backend-api/files/download/' + encodeURIComponent(file) + '?conversation_id=${id}&inline=false'`,
    sandbox: `(message, path) => '/backend-api/conversation/${id}/interpreter/download?message_id=' + encodeURIComponent(message) + '&sandbox_path=' + encodeURIComponent(path)`,
  };
  return inPage(`
    if (location.origin !== 'https://chatgpt.com' || location.pathname.replace(/\\/$/, '') !== ${JSON.stringify(new URL(conversation.url).pathname)})
      throw new Failure(${JSON.stringify(conversation.shared ? 'Open this shared ChatGPT conversation, then try again.' : 'Sign in to ChatGPT and open this conversation, then try again.')});
    const headers = {};
    if (${!conversation.shared}) {
      const sessionResponse = await fetch('/api/auth/session', { credentials: 'include' });
      if (!sessionResponse.ok) throw new Failure('Sign in to ChatGPT, then try again.');
      const browserSession = await sessionResponse.json();
      if (typeof browserSession.accessToken !== 'string' || !browserSession.accessToken)
        throw new Failure('Sign in to ChatGPT, then try again.');
      headers.Authorization = 'Bearer ' + browserSession.accessToken;
    }
    // A signed download link on another origin needs no cookies, and the
    // browser refuses a cross-origin read that sends them.
    const sameOrigin = (url) => new URL(url, location.href).origin === location.origin;${CAPPED_READS}
    const fileRoute = ${routes.file};
    const sandboxRoute = ${routes.sandbox};
    const response = await fetch(${routes.conversation}, { credentials: 'include', headers });
    if (!response.ok) throw new Failure('ChatGPT could not return this conversation.');
    const data = await response.json();
    if (data.conversation_id !== ${JSON.stringify(conversation.id)} || !data.mapping || !data.current_node)
      throw new Failure('ChatGPT returned an incomplete conversation.');
    // The conversation names its files but does not contain them. Fetch the
    // bytes of each file on the shown branch while this page is signed in, and
    // hand them to the decoder beside the reference they belong to. A file
    // that cannot be fetched is left as it was and imports as unavailable.
    const holders = new Map();
    const hold = (id, holder) => { if (id) holders.set(id, [...(holders.get(id) ?? []), holder]); };
    for (let at = data.current_node; at && data.mapping[at]; at = data.mapping[at].parent) {
      const message = data.mapping[at].message;
      // Only messages the transcript shows: a code run's working files are
      // never displayed, and a final tool message is a generated image.
      const role = message?.author?.role;
      if (role !== 'user' && role !== 'assistant' && !(role === 'tool' && message.channel === 'final')) continue;
      for (const attachment of message?.metadata?.attachments ?? []) hold(attachment.id, attachment);
      for (const part of message?.content?.parts ?? []) {
        // An uploaded image's part repeats its attachment; carry its bytes once.
        // A shared conversation's pointer carries the share as a query.
        const id = part?.content_type === 'image_asset_pointer' ? String(part.asset_pointer ?? '').replace(/^[a-z-]+:\\/\\//, '').split('?')[0] : '';
        if (id && !holders.has(id)) hold(id, part);
      }
    }
    const base64 = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    await Promise.all([...holders].map(async ([id, targets]) => {
      try {
        const link = await fetch(fileRoute(id), { credentials: 'include', headers });
        if (!link.ok) return;
        const { download_url: downloadUrl, mime_type: mimeType, file_size_bytes: fileSize } = await link.json();
        if (typeof downloadUrl !== 'string') return;
        const skip = () => { for (const target of targets) target.rally_unavailable_reason = tooLarge; };
        if (!within(fileSize)) return skip();
        const file = await fetch(downloadUrl, { credentials: sameOrigin(downloadUrl) ? 'include' : 'omit' });
        if (!file.ok) return;
        const blob = await readCapped(file);
        if (!blob) return skip();
        const bytes = await base64(blob);
        for (const target of targets) {
          target.inline_base64 = bytes;
          target.mime_type ??= mimeType || blob.type || undefined;
        }
      } catch {}
    }));
    // A file ChatGPT wrote in its code sandbox is offered as a sandbox: link in
    // the reply. Copy it through the same download ChatGPT's own link uses.
    for (let at = data.current_node; at && data.mapping[at]; at = data.mapping[at].parent) {
      const message = data.mapping[at].message;
      if (message?.author?.role !== 'assistant') continue;
      const text = (message.content?.parts ?? []).filter((part) => typeof part === 'string').join('\\n');
      const links = [...new Set([...text.matchAll(/\\]\\((sandbox:[^)\\s]+)\\)/g)].map((match) => match[1]))];
      if (!links.length) continue;
      message.metadata ??= {};
      message.metadata.rally_sandbox_files = (await Promise.all(links.map(async (link) => {
        try {
          const meta = await fetch(sandboxRoute(message.id, link.slice('sandbox:'.length)), { credentials: 'include', headers });
          if (!meta.ok) return null;
          const { download_url: downloadUrl, file_name: fileName, mime_type: mimeType, file_size_bytes: fileSize } = await meta.json();
          if (typeof downloadUrl !== 'string') return null;
          const name = String(fileName ?? link).split('/').pop();
          if (!within(fileSize)) return { link, name, rally_unavailable_reason: tooLarge };
          const file = await fetch(downloadUrl, { credentials: sameOrigin(downloadUrl) ? 'include' : 'omit' });
          if (!file.ok) return null;
          const blob = await readCapped(file);
          if (!blob) return { link, name, rally_unavailable_reason: tooLarge };
          return { link, name, mime_type: mimeType || blob.type || undefined, inline_base64: await base64(blob) };
        } catch { return null; }
      }))).filter(Boolean);
    }
    return JSON.stringify(data);
  `);
}

function claudeReader(conversation: BrowserConversation): string {
  // claude.ai scopes conversations by organization. The web client remembers
  // the one in use in a readable cookie; the organization list is the fallback.
  // The tree holds every edited branch, so keep only the path to the current
  // leaf — the conversation the person sees — before handing it to the decoder.
  return inPage(`
    if (location.origin !== 'https://claude.ai' || location.pathname.replace(/\\/$/, '') !== ${JSON.stringify(new URL(conversation.url).pathname)})
      throw new Failure('Sign in to Claude and open this conversation, then try again.');
    const id = ${JSON.stringify(conversation.id)};
    const read = async (organization) => {
      const response = await fetch('/api/organizations/' + encodeURIComponent(organization) + '/chat_conversations/' + id
        + '?tree=True&rendering_mode=messages&render_all_tools=true', { credentials: 'include' });
      return response.ok ? await response.json() : null;
    };
    const remembered = document.cookie.split('; ').find((entry) => entry.startsWith('lastActiveOrg='))?.slice('lastActiveOrg='.length);
    let organization = remembered ? decodeURIComponent(remembered) : '';
    let data = organization ? await read(organization) : null;
    if (!data) {
      const organizations = await fetch('/api/organizations', { credentials: 'include' });
      if (!organizations.ok) throw new Failure('Sign in to Claude, then try again.');
      for (const candidate of await organizations.json()) {
        if (typeof candidate?.uuid !== 'string' || candidate.uuid === remembered) continue;
        data = await read(candidate.uuid);
        if (data) { organization = candidate.uuid; break; }
      }
    }
    if (!data) throw new Failure('Claude could not return this conversation.');
    if (data.uuid !== id || !Array.isArray(data.chat_messages))
      throw new Failure('Claude returned an incomplete conversation.');
    if (data.current_leaf_message_uuid) {
      const byId = new Map(data.chat_messages.map((message) => [message.uuid, message]));
      const path = [];
      let at = data.current_leaf_message_uuid;
      for (; at && byId.has(at); at = byId.get(at).parent_message_uuid) {
        if (path.includes(byId.get(at))) throw new Failure('Claude returned an incomplete conversation.');
        path.unshift(byId.get(at));
      }
      // The walk must end at the root, not at an ancestor the response left out;
      // a suffix would silently drop the conversation's beginning.
      if (!path.length || (at && at !== '00000000-0000-4000-8000-000000000000'))
        throw new Failure('Claude returned an incomplete conversation.');
      data.chat_messages = path;
    }
    // Uploads are named in the conversation but not contained in it. The
    // original is in the conversation's file sandbox, under the path claude.ai
    // records or the name it gives the upload there, and is taken only when its
    // size is the recorded one. A chat without a sandbox still offers a PDF's
    // original and an image's full-size preview — the copy claude.ai's own
    // viewer shows — named for its real format. Anything else stays
    // unavailable, which the import reports.
    const base64 = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const types = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf',
      mp4: 'video/mp4', mov: 'video/quicktime', html: 'text/html', zip: 'application/zip', csv: 'text/csv', json: 'application/json',
      md: 'text/markdown', txt: 'text/plain' };
    const typeOf = (name) => types[String(name).split('.').pop().toLowerCase()] ?? '';
    const sandbox = (file) => typeof file.path === 'string' && file.path.startsWith('/mnt/user-data/uploads/') ? file.path
      : '/mnt/user-data/uploads/' + String(file.file_name ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
${CAPPED_READS}
    const take = async (url, expectedSize) => {
      const response = await fetch(url, { credentials: 'include' }).catch(() => null);
      if (!response?.ok) return null;
      const blob = await readCapped(response);
      return blob && (expectedSize === undefined || blob.size === expectedSize) ? blob : null;
    };
    await Promise.all(data.chat_messages.flatMap((message) => [...(message.files ?? []), ...(message.files_v2 ?? [])]).map(async (file) => {
      if (!file?.file_name || file.inline_base64) return;
      try {
        const size = typeof file.size_bytes === 'number' ? file.size_bytes : undefined;
        if (!within(size)) { file.rally_unavailable_reason = tooLarge; return; }
        let blob = await take('/api/organizations/' + encodeURIComponent(organization) + '/conversations/' + id
          + '/wiggle/download-file?path=' + encodeURIComponent(sandbox(file)), size);
        let name = file.file_name;
        const original = file.document_asset?.file_variant === 'original' && typeof file.document_asset.url === 'string'
          && file.document_asset.url.startsWith('/api/') ? file.document_asset.url : '';
        if (!blob && original) blob = await take(original, size);
        if (!blob && file.file_kind === 'image' && typeof file.preview_url === 'string' && file.preview_url.startsWith('/api/')) {
          blob = await take(file.preview_url);
          const extension = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' }[blob?.type];
          if (!extension) return;
          name = String(file.file_name).replace(/\\.[^.]+$/, '') + '.' + extension;
        }
        if (!blob) return;
        file.inline_base64 = await base64(blob);
        file.inline_name = name;
        file.mime_type = typeOf(name) || (blob.type && blob.type !== 'application/octet-stream' ? blob.type : 'application/octet-stream');
      } catch {}
    }));
    // A published Artifact is a live page; the conversation holds only its
    // card. Its current files are listed by claude.ai and served from the
    // Artifact's own host, which this page may not read, so the reader names
    // them for the tab's network loader. The type's shared runtime is not the
    // Artifact's content and stays behind.
    const artifacts = new Set();
    for (const message of data.chat_messages) for (const block of message.content ?? []) {
      const card = block?.display_content;
      if (block?.type === 'tool_result' && card?.type === 'file' && /^[0-9a-f-]{36}$/.test(card.published_artifact_id ?? '')) artifacts.add(card.published_artifact_id);
    }
    const files = [];
    for (const artifact of artifacts) {
      const manifest = await fetch('/api/frame/' + artifact + '?org=' + encodeURIComponent(organization), {
        credentials: 'include', headers: { 'X-Frame-CP': 'go', 'X-Frame-Platform': 'web' },
      }).then((response) => response.ok ? response.json() : null).catch(() => null);
      if (typeof manifest?.ver !== 'string' || typeof manifest?.assetToken !== 'string') continue;
      for (const file of manifest.files ?? []) {
        if (file?.src || typeof file?.path !== 'string' || !within(file.size)) continue;
        files.push({ owner: artifact, path: file.path, contentType: typeof file.contentType === 'string' ? file.contentType : '',
          url: 'https://' + artifact + '.frame.claudeusercontent.com/_f/' + encodeURIComponent(manifest.ver) + '/'
            + file.path.split('/').map(encodeURIComponent).join('/') + '?__frame_t=' + encodeURIComponent(manifest.assetToken) });
      }
    }
    return { text: JSON.stringify(data), files };
  `);
}

/** A shared Claude conversation is a snapshot claude.ai serves by its share id. */
function sharedClaudeReader(conversation: BrowserConversation): string {
  return inPage(`
    if (location.origin !== 'https://claude.ai' || location.pathname.replace(/\\/$/, '') !== ${JSON.stringify(new URL(conversation.url).pathname)})
      throw new Failure('Open this shared Claude conversation, then try again.');
    const response = await fetch('/api/chat_snapshots/${conversation.id}?rendering_mode=messages&render_all_tools=true', { credentials: 'include' });
    if (!response.ok) throw new Failure('Claude could not return this shared conversation.');
    const data = await response.json();
    if (!Array.isArray(data.chat_messages)) throw new Failure('Claude returned an incomplete shared conversation.');
    return JSON.stringify(data);
  `);
}

type ReaderBridge = Pick<RallyDesktopBridge, 'getEmbeddedBrowserState' | 'commandEmbeddedBrowser'>;

/**
 * Read one signed-in conversation through the browser's shared account
 * partition. A tab already showing it is read in place; otherwise, when asked,
 * a tab is opened on its URL for the read and closed afterwards, so a later
 * update does not depend on the person having kept the tab open.
 */
export async function readBrowserConversation(
  bridge: ReaderBridge,
  sourceUrl: string,
  { openIfMissing = false, tabId }: { openIfMissing?: boolean; tabId?: string } = {},
): Promise<{ provider: BrowserConversationProvider; text: string }> {
  const target = conversationAt(sourceUrl, '');
  if (!target) throw new Error('Choose a ChatGPT or Claude conversation in Rally’s browser.');
  const state = await bridge.getEmbeddedBrowserState();
  // Import reads the tab the person is looking at when several show the conversation.
  const showing = state.tabs.filter((candidate) => browserConversation(candidate)?.url === target.url);
  // An explicit tab — the foreground tab Import was pressed on — wins over any other.
  let tab = showing.find((candidate) => candidate.id === (tabId ?? state.activeTabId)) ?? showing[0];
  let opened: string | null = null;
  if (!tab && openIfMissing) {
    const result = await bridge.commandEmbeddedBrowser({ action: 'open', url: target.url });
    if (result.kind === 'state') {
      tab = result.state.tabs.find((candidate) => !state.tabs.some((existing) => existing.id === candidate.id));
      opened = tab?.id ?? null;
    }
  }
  if (!tab) throw new Error('Open this conversation in Rally’s browser, then try again.');
  try {
    const expression = target.provider === 'chatgpt' ? chatGptReader(target)
      : target.shared ? sharedClaudeReader(target) : claudeReader(target);
    const result = await bridge.commandEmbeddedBrowser({ action: 'evaluate', tabId: tab.id, expression });
    const value = result.kind === 'value' && result.value && typeof result.value === 'object' ? result.value as { text?: unknown; files?: unknown; error?: unknown } : {};
    if (typeof value.text === 'string') {
      const files = Array.isArray(value.files) ? value.files as CrossOriginFile[] : [];
      return { provider: target.provider, text: await attachCrossOriginFiles(bridge, tab.id, value.text, files) };
    }
    throw new Error(typeof value.error === 'string' ? value.error : 'The conversation could not be read. Reload the page and try again.');
  } finally {
    if (opened) await bridge.commandEmbeddedBrowser({ action: 'close', tabId: opened }).catch(() => undefined);
  }
}
