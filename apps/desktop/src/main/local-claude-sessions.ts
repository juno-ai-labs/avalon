import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { deserialize } from 'node:v8';
import { zstdDecompressSync } from 'node:zlib';
import { uncompress } from 'snappyjs';

export interface LocalClaudeSession {
  id: string;
  kind: 'chat' | 'cowork';
  title: string;
  updatedAt: number;
  sourceSessionId: string;
}

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const appRoot = (): string => join(homedir(), 'Library/Application Support/Claude');
const blobRoot = (): string => join(appRoot(), 'IndexedDB/https_claude.ai_0.indexeddb.blob');
const coworkRoot = (): string => join(appRoot(), 'local-agent-mode-sessions');

async function nestedFiles(root: string, accept: (name: string) => boolean): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const groups = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return nestedFiles(path, accept);
    return entry.isFile() && accept(entry.name) ? [path] : [];
  }));
  return groups.flat();
}

function decodeBlob(bytes: Buffer): Row | null {
  // Chromium IndexedDB external values: version marker, Snappy payload, then
  // Blink's 15-byte wrapper around the V8 value. Treat unknown formats as absent.
  if (bytes[0] !== 0xff || bytes[1] !== 0x11 || bytes[2] !== 0x02) return null;
  try { return row(deserialize(Buffer.from(uncompress(bytes.subarray(3))).subarray(15))); }
  catch { return null; }
}

async function blobs(): Promise<Row[]> {
  const files = await nestedFiles(blobRoot(), () => true);
  return (await Promise.all(files.map(async (file) => decodeBlob(await readFile(file))))).filter((value): value is Row => value !== null);
}

function chatCatalog(values: Row[]): LocalClaudeSession[] {
  const result = new Map<string, LocalClaudeSession>();
  for (const value of values) for (const query of list(row(value['clientState'])['queries'])) {
    const item = row(query);
    if (list(item['queryKey'])[0] !== 'chat_conversation_list') continue;
    for (const page of list(row(row(item['state'])['data'])['pages'])) for (const entry of list(row(page)['data'])) {
      const chat = row(entry);
      const id = string(chat['uuid']);
      if (!id || !string(chat['name'])) continue;
      const updatedAt = Date.parse(string(chat['updated_at'])) || 0;
      if (!result.has(id) || result.get(id)!.updatedAt < updatedAt) result.set(id, { id, kind: 'chat', title: string(chat['name']), updatedAt, sourceSessionId: id });
    }
  }
  return [...result.values()];
}

interface CoworkRecord { session: LocalClaudeSession; transcript: string | null }
async function coworkSessions(): Promise<CoworkRecord[]> {
  const files = await nestedFiles(coworkRoot(), (name) => name.startsWith('local_') && name.endsWith('.json'));
  return (await Promise.all(files.map(async (file): Promise<CoworkRecord | null> => {
    try {
      const meta = row(JSON.parse(await readFile(file, 'utf8')) as unknown);
      const sessionId = string(meta['sessionId']);
      const cliSessionId = string(meta['cliSessionId']);
      if (!sessionId || !cliSessionId) return null;
      const root = file.slice(0, -5);
      const matches = await nestedFiles(join(root, '.claude/projects'), (name) => name === `${cliSessionId}.jsonl`);
      const transcript = matches[0] && (await stat(matches[0]).catch(() => null))?.size ? matches[0] : null;
      return { session: { id: `cowork:${sessionId}`, kind: 'cowork', title: string(meta['title']) || 'Untitled task',
        updatedAt: Number(meta['lastActivityAt']) || 0, sourceSessionId: cliSessionId }, transcript };
    } catch { return null; }
  }))).filter((value): value is CoworkRecord => value !== null);
}

/** Show only sessions with a complete local transcript, while keeping familiar catalog titles. */
export async function listLocalClaudeSessions(): Promise<LocalClaudeSession[]> {
  const [values, cowork] = await Promise.all([blobs(), coworkSessions()]);
  const catalog = chatCatalog(values);
  const available = new Set(values.flatMap((value) => {
    const id = string(value['conversationUuid']);
    return id && completeChat(value, id) ? [id] : [];
  }));
  const cached = await cachedChats(new Set(catalog.filter((item) => !available.has(item.id)).map((item) => item.id)));
  for (const id of cached.keys()) available.add(id);
  const sessions = new Map(catalog.filter((item) => available.has(item.id)).map((item) => [item.id, item]));
  for (const item of cowork) if (item.transcript) sessions.set(item.session.id, item.session);
  return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.title.localeCompare(b.title));
}

function completeChat(value: Row, id: string): Row | null {
  const data = row(value['tree'] ?? value);
  const messages = list(data['chat_messages']);
  if (string(data['uuid']) !== id || !messages.length || value['headCut'] === true || data['headCut'] === true
    || data['truncated'] === true || messages.some((message) => row(message)['truncated'] === true)) return null;
  if (value['tree'] && (value['product'] !== 'chat' || value['messageCount'] !== messages.length)) return null;
  if (data['current_leaf_message_uuid'] && !messages.some((message) => row(message)['uuid'] === data['current_leaf_message_uuid'])) return null;
  return data;
}

async function cachedChats(ids: Set<string>): Promise<Map<string, Row>> {
  const latest = new Map<string, Row>();
  if (!ids.size) return latest;
  const root = join(appRoot(), 'Cache/Cache_Data');
  const files = await readdir(root).catch(() => []);
  const marker = Buffer.from('/chat_conversations/');
  const treeMarker = Buffer.from('tree=True');
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const bodies = files.filter((file) => file.endsWith('_0'));
  // Scan keys once for the requested catalog entries instead of traversing the
  // entire Chromium cache separately for each title in the picker.
  for (let offset = 0; offset < bodies.length; offset += 128) {
    const candidates = await Promise.all(bodies.slice(offset, offset + 128).map(async (file) => {
      const bytes = await readFile(join(root, file)).catch(() => null);
      if (!bytes || !bytes.includes(treeMarker)) return null;
      const markerAt = bytes.indexOf(marker);
      if (markerAt < 0) return null;
      const id = bytes.toString('ascii', markerAt + marker.length, markerAt + marker.length + 36);
      if (!ids.has(id)) return null;
      const frame = bytes.indexOf(magic);
      if (frame < 0) return null;
      try {
        const chat = completeChat(row(JSON.parse(zstdDecompressSync(bytes.subarray(frame)).toString('utf8')) as unknown), id);
        return chat ? { id, chat } : null;
      }
      catch { return null; }
    }));
    for (const candidate of candidates) {
      if (!candidate) continue;
      const previous = latest.get(candidate.id);
      if (!previous || Date.parse(string(candidate.chat['updated_at'])) > Date.parse(string(previous['updated_at']))
        || (candidate.chat['updated_at'] === previous['updated_at'] && list(candidate.chat['chat_messages']).length > list(previous['chat_messages']).length)) {
        latest.set(candidate.id, candidate.chat);
      }
    }
  }
  return latest;
}

async function cachedChat(id: string): Promise<Row | null> {
  return (await cachedChats(new Set([id]))).get(id) ?? null;
}

export async function readLocalClaudeSession(id: string): Promise<{ provider: 'claude' | 'claude_code'; text: string }> {
  if (id.startsWith('cowork:')) {
    const record = (await coworkSessions()).find((item) => item.session.id === id);
    if (!record?.transcript) throw new Error('This task’s transcript is not saved on this Mac. Choose another source.');
    const root = await realpath(coworkRoot());
    const path = await realpath(record.transcript);
    const part = relative(root, path);
    if (!part || part === '..' || part.startsWith(`..${sep}`)) throw new Error('Invalid local session selection');
    return { provider: 'claude_code', text: await readFile(path, 'utf8') };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id)) throw new Error('Invalid local session selection');
  const values = await blobs();
  const snapshots = values.map((value) => value['conversationUuid'] === id ? completeChat(value, id) : null).filter((value): value is Row => value !== null);
  const fromBlob = snapshots.sort((a, b) => Date.parse(string(b['updated_at'])) - Date.parse(string(a['updated_at'])))[0];
  const fromCache = await cachedChat(id);
  const latest = fromCache && (!fromBlob || Date.parse(string(fromCache['updated_at'])) > Date.parse(string(fromBlob['updated_at']))) ? fromCache : fromBlob;
  if (!latest) throw new Error('This chat’s messages are not saved on this Mac. Open it in Claude, then try again.');
  return { provider: 'claude', text: JSON.stringify(latest) };
}
