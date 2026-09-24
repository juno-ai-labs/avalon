import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { listLocalCodexSessions, readLocalCodexSession } from './local-codex-sessions';

const originalHome = process.env.CODEX_HOME;
let root: string | null = null;

afterEach(async () => {
  if (originalHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalHome;
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

it('lists top-level Codex tasks and reads only completed visible messages from the selected transcript', async () => {
  root = await mkdtemp(join(tmpdir(), 'rally-codex-import-'));
  process.env.CODEX_HOME = root;
  const sessions = join(root, 'sessions', '2026', '09', '23');
  await mkdir(sessions, { recursive: true });
  const id = '01a0cb17-2d26-7463-9ea1-3505300c3aa6';
  const childId = '01a0cb17-2d26-7463-9ea1-3505300c3aa7';
  const path = join(sessions, `rollout-2026-09-23T00-00-00-${id}.jsonl`);
  const childPath = join(sessions, `rollout-2026-09-23T00-00-00-${childId}.jsonl`);
  const line = (value: unknown) => JSON.stringify(value);
  await writeFile(path, [
    line({ type: 'session_meta', payload: { id } }),
    line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'user-1', content: [{ type: 'text', text: 'Question' }] } } }),
    line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'McpToolCall', id: 'tool-1', result: 'Secret tool output' } } }),
    line({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'AgentMessage', id: 'assistant-1', phase: 'final_answer', content: [{ type: 'Text', text: 'Answer' }] } } }),
    '{"type":"event_msg","payload":',
  ].join('\n'));
  await writeFile(childPath, '');
  const db = new DatabaseSync(join(root, 'state_5.sqlite'));
  db.exec('CREATE TABLE threads (id TEXT, name TEXT, title TEXT, first_user_message TEXT, rollout_path TEXT, updated_at INTEGER, updated_at_ms INTEGER, agent_path TEXT)');
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run(id, 'A recognizable title', 'Raw opening prompt', '', path, 1, 1234, null);
  insert.run(childId, null, 'Hidden subagent', '', childPath, 1, 1235, 'child');
  db.close();

  expect(await listLocalCodexSessions()).toEqual([{ id, title: 'A recognizable title', updatedAt: 1234 }]);
  const selected = JSON.parse(await readLocalCodexSession(id)) as { id: string; title: string; messages: unknown[] };
  expect(selected).toEqual({ id, title: 'A recognizable title', messages: [
    { role: 'user', text: 'Question', sourceMessageId: 'user-1' },
    { role: 'assistant', text: 'Answer', sourceMessageId: 'assistant-1' },
  ] });
  await expect(readLocalCodexSession(childId)).rejects.toThrow('unavailable');
});
