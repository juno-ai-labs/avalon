import { createReadStream } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

export interface LocalCodexSession {
  id: string;
  title: string;
  updatedAt: number;
}

interface CatalogRow {
  id: string;
  name: string | null;
  title: string;
  first_user_message: string;
  rollout_path: string;
  updated_at: number;
  updated_at_ms: number | null;
}

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === 'string' ? value : '';
const codexHome = (): string => process.env.CODEX_HOME || join(homedir(), '.codex');

function catalog(): DatabaseSync {
  return new DatabaseSync(join(codexHome(), 'state_5.sqlite'), { readOnly: true });
}

function parseCatalogRow(value: unknown): CatalogRow {
  const row = record(value);
  if (typeof row['id'] !== 'string' || typeof row['title'] !== 'string'
    || (row['name'] !== null && typeof row['name'] !== 'string')
    || typeof row['first_user_message'] !== 'string' || typeof row['rollout_path'] !== 'string'
    || typeof row['updated_at'] !== 'number'
    || (row['updated_at_ms'] !== null && typeof row['updated_at_ms'] !== 'number')) {
    throw new Error('The Codex session catalog has an unsupported format.');
  }
  return {
    id: row['id'], name: row['name'], title: row['title'], first_user_message: row['first_user_message'],
    rollout_path: row['rollout_path'], updated_at: row['updated_at'], updated_at_ms: row['updated_at_ms'],
  };
}

function catalogRow(id: string): CatalogRow | undefined {
  const db = catalog();
  try {
    const value = db.prepare('SELECT id, name, title, first_user_message, rollout_path, updated_at, updated_at_ms FROM threads WHERE id = ? AND agent_path IS NULL').get(id);
    return value ? parseCatalogRow(value) : undefined;
  } finally {
    db.close();
  }
}

function allowedPath(row: CatalogRow): boolean {
  if (!/^[a-f0-9-]{36}$/i.test(row.id) || !isAbsolute(row.rollout_path)
    || !basename(row.rollout_path).startsWith('rollout-')
    || !basename(row.rollout_path).endsWith(`-${row.id}.jsonl`)) return false;
  const root = codexHome();
  return [join(root, 'sessions'), join(root, 'archived_sessions')].some((base) => {
    const suffix = relative(base, row.rollout_path);
    return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
  });
}

function title(row: CatalogRow): string {
  return (row.name?.trim() || row.title.trim() || row.first_user_message.trim() || 'Untitled conversation').replace(/\s+/g, ' ');
}

/** The SQLite catalog is an index only. Every selected transcript is read from its JSONL file. */
export async function listLocalCodexSessions(): Promise<LocalCodexSession[]> {
  const db = catalog();
  let rows: CatalogRow[];
  try {
    rows = db.prepare('SELECT id, name, title, first_user_message, rollout_path, updated_at, updated_at_ms FROM threads WHERE agent_path IS NULL ORDER BY updated_at DESC, id DESC').all().map(parseCatalogRow);
  } finally {
    db.close();
  }
  return rows.filter(allowedPath).map((row) => ({
    id: row.id, title: title(row), updatedAt: row.updated_at_ms ?? row.updated_at * 1000,
  }));
}

function visibleItem(item: Record<string, unknown>): { role: 'user' | 'assistant'; text: string; sourceMessageId: string; files?: unknown[] } | null {
  const type = item['type'];
  if (type !== 'UserMessage' && type !== 'AgentMessage') return null;
  const role = type === 'UserMessage' ? 'user' : 'assistant';
  const id = string(item['id']);
  if (!id) throw new Error('Codex transcript has a visible message without an identity');
  const parts = item['content'];
  if (!Array.isArray(parts)) throw new Error('Codex transcript has unsupported visible content');
  const textParts: string[] = [];
  const files: unknown[] = [];
  for (const part of parts) {
    const block = record(part);
    if (block['type'] === 'text' || block['type'] === 'Text') textParts.push(string(block['text']));
    else if (block['type'] === 'local_image') files.push({
      name: 'Image attachment', mimeType: 'image/png', kind: 'attachment',
      source: { kind: 'unavailable', reference: `codex-image:${id}`,
        reason: 'The Codex transcript references a local image without portable image bytes.' },
    });
    else throw new Error('Codex transcript has unsupported visible content');
  }
  const text = textParts.join('\n\n').trim();
  return text || files.length ? { role, text, sourceMessageId: id, ...(files.length ? { files } : {}) } : null;
}

function legacyItem(payload: Record<string, unknown>, index: number) {
  if (payload['type'] !== 'message' || (payload['role'] !== 'user' && payload['role'] !== 'assistant')) return null;
  const role = payload['role'];
  const parts = payload['content'];
  if (!Array.isArray(parts)) throw new Error('Codex transcript has unsupported visible content');
  const textParts: string[] = [];
  const files: unknown[] = [];
  for (const part of parts) {
    const block = record(part);
    if (block['type'] === 'input_text' || block['type'] === 'output_text') textParts.push(string(block['text']));
    else if (block['type'] === 'input_image') files.push({
      name: 'Image attachment', mimeType: 'image/png', kind: 'attachment',
      source: { kind: 'unavailable', reference: `codex-image:position:${index}`,
        reason: 'The Codex transcript references a local image without portable image bytes.' },
    });
    else throw new Error('Codex transcript has unsupported visible content');
  }
  const text = textParts.join('\n\n').trim();
  return text || files.length ? { role, text, sourceMessageId: `position:${index}`, ...(files.length ? { files } : {}) } : null;
}

/** Read settled, user-visible events only. An active writer's final incomplete line is ignored. */
export async function readLocalCodexSession(id: string): Promise<string> {
  const row = catalogRow(id);
  if (!row || !allowedPath(row)) throw new Error('This Codex conversation is unavailable on this Mac.');
  const root = await realpath(codexHome());
  const path = await realpath(row.rollout_path);
  if (!path.startsWith(`${root}${sep}`)) throw new Error('Invalid local session selection');
  const events = new Map<string, ReturnType<typeof visibleItem>>();
  const legacy: NonNullable<ReturnType<typeof legacyItem>>[] = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  let index = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = record(JSON.parse(line) as unknown); }
    catch { continue; } // A running task may leave a partial final record.
    if (entry['type'] === 'event_msg') {
      const event = record(entry['payload']);
      if (event['type'] === 'item_completed') {
        const message = visibleItem(record(event['item']));
        if (message) events.set(message.sourceMessageId, message);
      }
    } else if (entry['type'] === 'response_item') {
      const message = legacyItem(record(entry['payload']), index++);
      if (message) legacy.push(message);
    }
  }
  const messages = events.size ? [...events.values()] : legacy;
  if (!messages.length) throw new Error('This Codex conversation has no completed messages to import yet.');
  return JSON.stringify({ id: row.id, title: title(row), messages });
}
