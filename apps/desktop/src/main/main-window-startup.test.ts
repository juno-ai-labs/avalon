import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

it('defers early main-window creation until renderer protocol and IPC setup completes', async () => {
  const source = readFileSync(`${process.cwd()}/src/main/index.ts`, 'utf8');
  const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'createMainWindow');
  expect(declaration).toBeDefined();
  const reveal = parsed.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'revealWindow');
  expect(reveal).toBeDefined();
  let ready!: () => void;
  const startup = new Promise<void>((resolve) => { ready = resolve; });
  let finishLoad!: () => void;
  const loading = new Promise<void>((resolve) => { finishLoad = resolve; });
  const loaded = vi.fn(() => loading);
  const created = vi.fn();
  const shown = vi.fn();
  let readyToShow!: () => void;
  class Window {
    webContents = { id: 1, on: vi.fn() };
    isDestroyed = () => false;
    isMinimized = () => false;
    show = shown;
    focus = vi.fn();
    on = vi.fn();
    once = (_event: string, callback: () => void) => { readyToShow = callback; };
    constructor() { created(); }
  }
  const create = runInNewContext(`${ts.transpile(reveal!.getText(parsed))}; ${ts.transpile(declaration!.getText(parsed))}; createMainWindow`, {
    mainWindowStartup: startup, mainWindowLoading: null, mainWindowReadyToShow: false, mainWindow: null, rendererReady: false,
    BrowserWindow: Window, process: { platform: 'darwin' }, app: { isPackaged: true },
    windowBackgroundColor: () => '#fff', preloadPath: () => '/preload',
    installWindowDiagnostics: vi.fn(), rendererUrl: () => 'app://rallywithai/index.html',
    loadRenderer: loaded,
  }) as () => Promise<void>;
  const opening = create();
  await Promise.resolve();
  expect(created).not.toHaveBeenCalled();
  expect(loaded).not.toHaveBeenCalled();
  ready();
  await Promise.resolve();
  const secondOpening = create();
  let secondFinished = false;
  void secondOpening.then(() => { secondFinished = true; });
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  expect(secondFinished).toBe(false);
  expect(shown).not.toHaveBeenCalled();
  finishLoad();
  await Promise.all([opening, secondOpening]);
  expect(created).toHaveBeenCalledTimes(1);
  expect(loaded).toHaveBeenCalledTimes(1);
  await create();
  expect(shown).not.toHaveBeenCalled();
  readyToShow();
  expect(shown).toHaveBeenCalledTimes(1);
  await create();
  expect(shown).toHaveBeenCalledTimes(2);
  const release = source.indexOf('resolveMainWindowStartup();');
  const protocolInstall = source.indexOf('await installRendererProtocol();');
  const ipcInstall = source.indexOf('    registerIpc();');
  expect(protocolInstall).toBeGreaterThanOrEqual(0);
  expect(ipcInstall).toBeGreaterThanOrEqual(0);
  expect(release).toBeGreaterThan(protocolInstall);
  expect(release).toBeGreaterThan(ipcInstall);
  expect(release).toBeLessThan(source.indexOf('else await createMainWindow();'));
});
