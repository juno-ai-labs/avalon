import { contextBridge, ipcRenderer } from 'electron';
import type { DemoSidecarBridge } from '../common/demo-sidecar';
import { parseThemeChoice } from '../common/themes';
const bridge: DemoSidecarBridge = {
  catalog: () => ipcRenderer.invoke('demo-sidecar:catalog'),
  send: input => ipcRenderer.invoke('demo-sidecar:send', input),
  onThemeChanged: listener => {
    const receive = (_event: Electron.IpcRendererEvent, raw: unknown): void => {
      const choice = parseThemeChoice(raw);
      if (choice) listener(choice);
    };
    ipcRenderer.on('theme:changed', receive);
    return () => { ipcRenderer.removeListener('theme:changed', receive); };
  },
};
contextBridge.exposeInMainWorld('demoSidecar', bridge);
