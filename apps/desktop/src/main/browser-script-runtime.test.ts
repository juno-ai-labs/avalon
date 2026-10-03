import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserScriptDriver } from './browser-script-driver';
import { BrowserScriptRuntime } from './browser-script-runtime';

// Node cannot create Electron views. This double controls evaluation/observation
// completion; the runtime lifecycle and byte transfer logic are the real subject.
const contents = vi.hoisted(() => ({
  setWindowOpenHandler: vi.fn(), on: vi.fn(), close: vi.fn(),
  session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
  debugger: { on: vi.fn(), attach: vi.fn(), sendCommand: vi.fn() },
  loadURL: vi.fn(), executeJavaScript: vi.fn(),
}));
vi.mock('electron', () => ({ WebContentsView: class { webContents = contents; } }));

function fixture() {
  const driver = new BrowserScriptDriver('tab', {
    getEmbeddedBrowserState: async () => ({ tabs: [], activeTabId: null }),
    commandEmbeddedBrowser: async () => ({ kind: 'value', value: null }),
  });
  driver.store.add({ ref: { handle: 'messages', kind: 'json', name: 'messages', mimeType: 'application/json', size: 2 }, data: '[]' });
  return { driver, runtime: new BrowserScriptRuntime('tab', driver) };
}

beforeEach(() => {
  vi.clearAllMocks();
  contents.loadURL.mockResolvedValue(undefined);
  contents.debugger.sendCommand.mockResolvedValue({});
  contents.executeJavaScript.mockResolvedValue([]);
});

describe('browser runtime cancellation', () => {
  it('fails a disposed evaluation instead of returning a successful partial byte transfer', async () => {
    let release!: () => void;
    let entered!: () => void;
    const evaluating = new Promise<void>(resolve => { entered = resolve; });
    contents.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') { entered(); await new Promise<void>(resolve => { release = resolve; }); }
      return {};
    });
    const { runtime, driver } = fixture();
    const call = runtime.execute('await rally.pageScript("return 1")');
    await evaluating;
    runtime.dispose();
    release();
    await expect(call).rejects.toThrow('runtime is closed');
    expect(driver.store.get('messages')).toBeUndefined();
    expect(contents.close).toHaveBeenCalledOnce();
  });

  it('fails disposal during the final output read before transferring handles', async () => {
    let release!: () => void;
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    contents.executeJavaScript.mockImplementation(async (code: string) => {
      if (code === 'globalThis.__rallyOutput.splice(0)') { entered(); await new Promise<void>(resolve => { release = resolve; }); }
      return [];
    });
    const { runtime } = fixture();
    const call = runtime.execute('1');
    await reading;
    runtime.dispose();
    release();
    await expect(call).rejects.toThrow('runtime is closed');
  });
});
