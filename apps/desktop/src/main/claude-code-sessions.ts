import { createReadStream } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';

export interface LocalClaudeCodeSession {
  id: string;
  title: string;
  project: string;
  updatedAt: number;
}

function projectsDirectory(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
}

async function titleFromTranscript(path: string): Promise<string | null> {
  let customTitle: string | null = null;
  let generatedTitle: string | null = null;
  let firstPrompt: string | null = null;
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      value = parsed as Record<string, unknown>;
    } catch { continue; } // An active writer may leave a partial final line.
    if (value.type === 'custom-title' && typeof value.customTitle === 'string') customTitle = value.customTitle;
    if (value.type === 'ai-title' && typeof value.aiTitle === 'string') generatedTitle = value.aiTitle;
    if (!firstPrompt && value.type === 'user' && value.isMeta !== true
      && value.isCompactSummary !== true && value.isSidechain !== true) {
      const message = value.message as { content?: unknown } | undefined;
      const content = message?.content;
      if (typeof content === 'string') firstPrompt = content;
      else if (Array.isArray(content)) {
        const part = content.find((item: unknown) => item && typeof item === 'object'
          && (item as { type?: unknown }).type === 'text' && typeof (item as { text?: unknown }).text === 'string') as { text: string } | undefined;
        firstPrompt = part?.text ?? null;
      }
    }
  }
  return (customTitle || generatedTitle || firstPrompt)?.trim().replace(/\s+/g, ' ').slice(0, 120) || null;
}

/** Read-only discovery; transcript bytes remain local until the person imports one choice. */
export async function listLocalClaudeCodeSessions(): Promise<LocalClaudeCodeSession[]> {
  const root = projectsDirectory();
  const projects = await readdir(root, { withFileTypes: true }).catch(() => []);
  const sessions = (await Promise.all(projects.filter((entry) => entry.isDirectory()).map(async (project) => {
    const directory = join(root, project.name);
    const files = await readdir(directory, { withFileTypes: true }).catch(() => []);
    return Promise.all(files.filter((file) => file.isFile() && file.name.endsWith('.jsonl')).map(async (file) => {
      const path = join(directory, file.name);
      const info = await stat(path);
      return { id: `${project.name}/${file.name}`, project: project.name,
        title: await titleFromTranscript(path) || 'Untitled conversation', updatedAt: info.mtimeMs };
    }));
  }))).flat();
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export async function readLocalClaudeCodeSession(id: string): Promise<string> {
  const parts = id.split('/');
  if (parts.length !== 2 || parts.some((part) => !part || part === '.' || part === '..')
    || !parts[1]!.endsWith('.jsonl')) throw new Error('Invalid local session selection');
  const root = await realpath(projectsDirectory());
  const path = await realpath(resolve(root, parts[0]!, parts[1]!));
  if (!path.startsWith(`${root}${sep}`)) throw new Error('Invalid local session selection');
  return readFile(path, 'utf8');
}
