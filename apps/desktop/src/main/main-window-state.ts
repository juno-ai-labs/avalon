import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WindowBounds { x: number; y: number; width: number; height: number }
export interface WindowDisplay { workArea: WindowBounds }
export interface MainWindowState { bounds: WindowBounds; maximized: boolean }

/** Shared native-window geometry: keep a normal window visible after a display changes. */
export function clampWindowBounds(
  bounds: WindowBounds,
  area: WindowBounds,
  minimum: { width: number; height: number },
): WindowBounds {
  // A work area smaller than the native minimum cannot contain this window.
  // Keep constructor dimensions compatible with that minimum and anchor its
  // top-left corner at the work-area origin.
  const width = Math.max(minimum.width, Math.min(bounds.width, area.width));
  const height = Math.max(minimum.height, Math.min(bounds.height, area.height));
  return {
    x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)),
    width,
    height,
  };
}

const fileName = 'main-window-state.json';

function validBounds(value: unknown, minimum: { width: number; height: number }): value is WindowBounds {
  if (!value || typeof value !== 'object') return false;
  const bounds = value as Record<string, unknown>;
  return ['x', 'y', 'width', 'height'].every((key) =>
    typeof bounds[key] === 'number' && Number.isSafeInteger(bounds[key]))
    && (bounds.width as number) >= minimum.width
    && (bounds.height as number) >= minimum.height;
}

/** Restore into a visible work area after displays are unplugged or rearranged. */
export function restoreMainWindowState(
  stored: unknown,
  displays: readonly WindowDisplay[],
  minimum: { width: number; height: number },
): MainWindowState | null {
  if (!stored || typeof stored !== 'object' || displays.length === 0) return null;
  const candidate = stored as Record<string, unknown>;
  if (candidate.version !== 1 || !validBounds(candidate.bounds, minimum)
    || typeof candidate.maximized !== 'boolean') return null;
  const bounds = candidate.bounds;
  const overlap = (workArea: WindowBounds): number =>
    Math.max(0, Math.min(bounds.x + bounds.width, workArea.x + workArea.width) - Math.max(bounds.x, workArea.x))
    * Math.max(0, Math.min(bounds.y + bounds.height, workArea.y + workArea.height) - Math.max(bounds.y, workArea.y));
  const display = displays.reduce((best, next) =>
    overlap(next.workArea) > overlap(best.workArea) ? next : best);
  return {
    bounds: clampWindowBounds(bounds, display.workArea, minimum),
    maximized: candidate.maximized === true,
  };
}

/** Drop only the width Rally added for the transient details rail. */
export function boundsWithoutConversationDetails(
  bounds: WindowBounds,
  addedWidth: number,
  appliedWidth: number,
): WindowBounds {
  return addedWidth > 0 && bounds.width === appliedWidth
    ? { ...bounds, width: bounds.width - addedWidth }
    : bounds;
}

export function readMainWindowState(
  directory: string,
  displays: readonly WindowDisplay[],
  minimum: { width: number; height: number },
): MainWindowState | null {
  try {
    return restoreMainWindowState(JSON.parse(readFileSync(join(directory, fileName), 'utf8')) as unknown, displays, minimum);
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) return null;
    throw error;
  }
}

export function writeMainWindowState(directory: string, state: MainWindowState): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, fileName);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, ...state })}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}
