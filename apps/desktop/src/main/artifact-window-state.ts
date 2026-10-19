import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WindowBounds } from './main-window-state';

export interface ArtifactWindowState {
  id: string;
  workspaceId: string;
  userId: string;
  kind: 'site' | 'generated';
  resourceId: string;
  version: number;
  title: string;
  mimeType?: string;
  annotationScope?: string;
  bounds: WindowBounds;
  displayId: number;
}

export function readArtifactWindows(directory: string): ArtifactWindowState[] {
  try {
    const value: unknown = JSON.parse(readFileSync(join(directory, 'artifact-windows.json'), 'utf8'));
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ArtifactWindowState => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Record<string, unknown>;
      const bounds = row.bounds as Record<string, unknown> | undefined;
      return typeof row.id === 'string' && typeof row.workspaceId === 'string'
        && typeof row.userId === 'string' && (row.kind === 'site' || row.kind === 'generated')
        && typeof row.resourceId === 'string' && Number.isSafeInteger(row.version)
        && (row.version as number) >= 0 && typeof row.title === 'string'
        && Number.isSafeInteger(row.displayId)
        && bounds !== undefined && ['x', 'y', 'width', 'height'].every((key) =>
          typeof bounds[key] === 'number' && Number.isFinite(bounds[key]));
    });
  } catch { return []; }
}

export function writeArtifactWindows(directory: string, windows: ArtifactWindowState[]): void {
  const path = join(directory, 'artifact-windows.json');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(windows)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
