import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import type * as NodeOs from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize } from 'node:v8';
import { zstdCompressSync } from 'node:zlib';
import { compress } from 'snappyjs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

let home: string;
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>();
  return { ...original, homedir: () => home };
});
import { listLocalClaudeSessions, readLocalClaudeSession } from './local-claude-sessions';

beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'rally-claude-')); });
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

it('lists Claude chat titles and Cowork tasks, then reads only the chosen transcript', async () => {
  const root = join(home, 'Library/Application Support/Claude');
  const blobDir = join(root, 'IndexedDB/https_claude.ai_0.indexeddb.blob/1/01');
  await mkdir(blobDir, { recursive: true });
  const chatId = 'b0e003e5-ffb8-4058-ac46-ee5b10b8150a';
  const metadata = { clientState: { queries: [{ queryKey: ['chat_conversation_list'], state: { data: { pages: [{ data: [
    { uuid: chatId, name: 'Apple HIG navigation hierarchy', updated_at: '2026-09-17T17:53:18Z' },
    { uuid: 'ee7f9de9-96c1-4110-9c27-9b77e907d86f', name: 'Metadata only', updated_at: '2026-09-18T17:53:18Z' },
  ] }] } } }] } };
  const wrapped = (value: unknown): Buffer => Buffer.concat([Buffer.from([0xff, 0x11, 0x02]), Buffer.from(compress(Buffer.concat([Buffer.alloc(15), serialize(value)])))]);
  await writeFile(join(blobDir, 'list'), wrapped(metadata));
  const chat = { uuid: chatId, name: 'Apple HIG navigation hierarchy', updated_at: '2026-09-17T17:53:18Z',
    current_leaf_message_uuid: 'message-1', chat_messages: [{ uuid: 'message-1', sender: 'human', text: 'How should navigation work?' }] };
  await writeFile(join(blobDir, 'detail'), wrapped({ product: 'chat', conversationUuid: chatId, messageCount: 1, tree: chat }));
  const taskRoot = join(root, 'local-agent-mode-sessions/account/org');
  await mkdir(join(taskRoot, 'local_task/.claude/projects/project'), { recursive: true });
  await writeFile(join(taskRoot, 'local_task.json'), JSON.stringify({ title: 'Andrew Ng call lookup', sessionId: 'local_task',
    cliSessionId: 'cli-session', lastActivityAt: 1781730180815 }));
  await writeFile(join(taskRoot, 'local_task/.claude/projects/project/cli-session.jsonl'), '{"type":"user","sessionId":"cli-session","uuid":"first","message":{"content":"Find the call"}}\n');
  await writeFile(join(taskRoot, 'local_missing.json'), JSON.stringify({ title: 'Cowork metadata only', sessionId: 'local_missing',
    cliSessionId: 'missing-cli', lastActivityAt: 1781730180816 }));
  const items = await listLocalClaudeSessions();
  expect(items.map((item) => item.title)).toEqual(['Apple HIG navigation hierarchy', 'Andrew Ng call lookup']);
  expect(JSON.parse((await readLocalClaudeSession(chatId)).text)).toEqual(chat);
  expect((await readLocalClaudeSession('cowork:local_task')).provider).toBe('claude_code');
  await expect(readLocalClaudeSession('ee7f9de9-96c1-4110-9c27-9b77e907d86f')).rejects.toThrow('not saved on this Mac');
});

it('uses a complete selected HTTP cache snapshot when IndexedDB has only a title', async () => {
  const appRoot = join(home, 'Library/Application Support/Claude');
  const root = join(appRoot, 'Cache/Cache_Data');
  const blobDir = join(appRoot, 'IndexedDB/https_claude.ai_0.indexeddb.blob/1/01');
  await mkdir(root, { recursive: true });
  await mkdir(blobDir, { recursive: true });
  const id = 'db4ff63e-f0b6-4c8b-824f-e2f09e226b46';
  const absentId = 'ee7f9de9-96c1-4110-9c27-9b77e907d86f';
  const metadata = { clientState: { queries: [{ queryKey: ['chat_conversation_list'], state: { data: { pages: [{ data: [
    { uuid: id, name: 'Jon Hearty research', updated_at: '2026-09-17T17:53:18Z' },
    { uuid: absentId, name: 'Unavailable chat', updated_at: '2026-09-18T17:53:18Z' },
  ] }] } } }] } };
  await writeFile(join(blobDir, 'list'), Buffer.concat([Buffer.from([0xff, 0x11, 0x02]),
    Buffer.from(compress(Buffer.concat([Buffer.alloc(15), serialize(metadata)])))]));
  const chat = { uuid: id, name: 'Jon Hearty research', updated_at: '2026-09-17T17:53:18Z',
    chat_messages: [{ uuid: 'first', sender: 'human', text: 'Research this' },
      { uuid: 'second', sender: 'assistant', text: 'Here is the research' }] };
  await writeFile(join(blobDir, 'shorter-detail'), Buffer.concat([Buffer.from([0xff, 0x11, 0x02]),
    Buffer.from(compress(Buffer.concat([Buffer.alloc(15), serialize({ product: 'chat', conversationUuid: id,
      messageCount: 1, tree: { ...chat, chat_messages: chat.chat_messages.slice(0, 1) } })])))]));
  await writeFile(join(root, 'detail_0'), Buffer.concat([
    Buffer.from(`1/0/https://claude.ai/api/organizations/org/chat_conversations/${id}?tree=True`),
    zstdCompressSync(Buffer.from(JSON.stringify(chat))),
  ]));
  await writeFile(join(root, 'other_0'), Buffer.from('unrelated cache entry'));
  expect((await listLocalClaudeSessions()).map((item) => item.title)).toEqual(['Jon Hearty research']);
  expect(JSON.parse((await readLocalClaudeSession(id)).text)).toEqual(chat);
  const bytes = await readFile(join(root, 'detail_0'));
  expect(bytes.includes(Buffer.from('Research this'))).toBe(false);
});
