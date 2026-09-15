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
  let ready!: () => void;
  const startup = new Promise<void>((resolve) => { ready = resolve; });
  const loaded = vi.fn();
  const created = vi.fn();
  class Window {
    webContents = { id: 1, on: vi.fn() };
    on = vi.fn();
    once = vi.fn();
    constructor() { created(); }
  }
  const create = runInNewContext(`${ts.transpile(declaration!.getText(parsed))}; createMainWindow`, {
    mainWindowStartup: startup, mainWindow: null, rendererReady: false,
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
  await opening;
  expect(created).toHaveBeenCalledTimes(1);
  expect(loaded).toHaveBeenCalledTimes(1);
  const release = source.indexOf('resolveMainWindowStartup();');
  expect(release).toBeGreaterThan(source.indexOf('await installRendererProtocol();'));
  expect(release).toBeGreaterThan(source.indexOf('    registerIpc();'));
  expect(release).toBeLessThan(source.indexOf('else await createMainWindow();'));
});
