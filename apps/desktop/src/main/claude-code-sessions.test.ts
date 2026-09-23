import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listLocalClaudeCodeSessions, readLocalClaudeCodeSession } from './claude-code-sessions';

describe('local Claude Code session discovery', () => {
  let directory: string;
  let formerConfig: string | undefined;
  beforeEach(async () => {
    formerConfig = process.env.CLAUDE_CONFIG_DIR;
    directory = await mkdtemp(join(tmpdir(), 'rally-claude-code-'));
    process.env.CLAUDE_CONFIG_DIR = directory;
    await mkdir(join(directory, 'projects', 'project-a'), { recursive: true });
  });
  afterEach(async () => {
    if (formerConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = formerConfig;
    await rm(directory, { recursive: true, force: true });
  });

  it('lists transcripts without reading other project files and reads only the selected session', async () => {
    const selected = '{"type":"user","sessionId":"one","uuid":"u1","message":{"content":"First prompt"}}\n'
      + '{"type":"custom-title","customTitle":"Chosen session"}\n';
    await writeFile(join(directory, 'projects', 'project-a', 'one.jsonl'), selected);
    await writeFile(join(directory, 'projects', 'project-a', 'two.jsonl'), '{"type":"ai-title","aiTitle":"Other session"}\n');
    await writeFile(join(directory, 'projects', 'project-a', 'tool-results.txt'), 'not a session');
    const sessions = await listLocalClaudeCodeSessions();
    expect(sessions.map(({ id, title }) => ({ id, title }))).toEqual(expect.arrayContaining([
      { id: 'project-a/one.jsonl', title: 'Chosen session' },
      { id: 'project-a/two.jsonl', title: 'Other session' },
    ]));
    expect(sessions).toHaveLength(2);
    expect(await readLocalClaudeCodeSession('project-a/one.jsonl')).toBe(selected);
    await expect(readLocalClaudeCodeSession('../project-a/one.jsonl')).rejects.toThrow('Invalid local session selection');
  });

  it('uses the first visible prompt when earlier user records are summaries or sidechains', async () => {
    await writeFile(join(directory, 'projects', 'project-a', 'three.jsonl'), [
      { type: 'user', isCompactSummary: true, message: { content: 'Private summary' } },
      { type: 'user', isSidechain: true, message: { content: 'Subagent prompt' } },
      { type: 'user', message: { content: 'Visible question' } },
    ].map((event) => JSON.stringify(event)).join('\n'));
    expect((await listLocalClaudeCodeSessions()).find((session) => session.id === 'project-a/three.jsonl')?.title)
      .toBe('Visible question');
  });
});
