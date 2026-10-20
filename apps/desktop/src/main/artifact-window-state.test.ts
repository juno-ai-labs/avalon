import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readArtifactWindows, writeArtifactWindows } from './artifact-window-state';

const directory = mkdtempSync(join(tmpdir(), 'rally-artifact-windows-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe('artifact window placement', () => {
  it('keeps the identity and monitor bounds of every open window across reads', () => {
    const windows = [
      { id: 'first', workspaceId: 'org', userId: 'person', region: 'global', editable: true, kind: 'site' as const,
        resourceId: 'site', version: 3, title: 'Dashboard',
        bounds: { x: -1100, y: 80, width: 900, height: 700 }, displayId: 2 },
      { id: 'second', workspaceId: 'org', userId: 'person', kind: 'generated' as const,
        resourceId: 'file', version: 1, title: 'Report', mimeType: 'application/pdf',
        bounds: { x: 250, y: 100, width: 800, height: 650 }, displayId: 1 },
    ];
    writeArtifactWindows(directory, windows);
    expect(readArtifactWindows(directory)).toEqual(windows);
  });

  it('drops malformed saved entries', () => {
    writeFileSync(join(directory, 'artifact-windows.json'), JSON.stringify([
      { id: 'bad', bounds: { x: 'elsewhere' } },
    ]));
    expect(readArtifactWindows(directory)).toEqual([]);
  });
});
