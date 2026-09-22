import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

import {
  boundsWithoutConversationDetails,
  readMainWindowState,
  restoreMainWindowState,
  writeMainWindowState,
} from './main-window-state';

const minimum = { width: 860, height: 640 };
const displays = [
  { workArea: { x: 0, y: 0, width: 1440, height: 900 } },
  { workArea: { x: 1440, y: -200, width: 1920, height: 1080 } },
];
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('restores the last normal bounds and maximized state on the same display', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rally-window-'));
  directories.push(directory);
  const state = { bounds: { x: 1500, y: -100, width: 1180, height: 940 }, maximized: true };
  writeMainWindowState(directory, state);
  expect(readMainWindowState(directory, displays, minimum)).toEqual(state);
});

it('moves a window from a disconnected display into the primary work area', () => {
  expect(restoreMainWindowState({
    version: 1,
    bounds: { x: 1800, y: 100, width: 1180, height: 940 },
    maximized: false,
  }, [displays[0]!], minimum)).toEqual({
    bounds: { x: 260, y: 0, width: 1180, height: 900 },
    maximized: false,
  });
});

it('ignores malformed stored bounds', () => {
  expect(restoreMainWindowState({ version: 1, bounds: { x: 0, y: 0, width: -1, height: 900 } }, displays, minimum)).toBeNull();
  expect(restoreMainWindowState({
    version: 1,
    bounds: { x: 0, y: 0, width: 1180, height: 900 },
  }, displays, minimum)).toBeNull();
});

it('uses native minimum dimensions when a display is too small to contain them', () => {
  expect(restoreMainWindowState({
    version: 1,
    bounds: { x: 1600, y: 100, width: 1180, height: 940 },
    maximized: false,
  }, [{ workArea: { x: 100, y: 50, width: 800, height: 600 } }], minimum)).toEqual({
    bounds: { x: 100, y: 50, width: 860, height: 640 },
    maximized: false,
  });
});

it('removes only an unchanged temporary details-rail expansion', () => {
  const expanded = { x: 100, y: 50, width: 1480, height: 900 };
  expect(boundsWithoutConversationDetails(expanded, 300, 1480)).toEqual({ ...expanded, width: 1180 });
  expect(boundsWithoutConversationDetails({ ...expanded, width: 1530 }, 300, 1480)).toEqual({ ...expanded, width: 1530 });
});
