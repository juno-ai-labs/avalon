import { contextBridge, ipcRenderer } from "electron";
import type { SidelineBridge, SidelineSession } from "../common/bridge";

const bridge: SidelineBridge = {
  getSession: () => ipcRenderer.invoke("sideline:session") as Promise<SidelineSession | null>,
  signIn: () => ipcRenderer.invoke("sideline:sign-in") as Promise<void>,
  signOut: () => ipcRenderer.invoke("sideline:sign-out") as Promise<void>,
  catalog: () => ipcRenderer.invoke("sideline:catalog"),
  send: (input) => ipcRenderer.invoke("sideline:send", input),
  openInRally: (input) => ipcRenderer.invoke("sideline:open-in-rally", input) as Promise<void>,
  onSessionChanged: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, session: SidelineSession | null): void => listener(session);
    ipcRenderer.on("sideline:session-changed", handler);
    return () => ipcRenderer.removeListener("sideline:session-changed", handler);
  },
  getDownloadedUpdate: () => ipcRenderer.invoke("sideline:downloaded-update") as Promise<string | null>,
  onUpdateDownloaded: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, version: string): void => listener(version);
    ipcRenderer.on("sideline:update-downloaded", handler);
    return () => ipcRenderer.removeListener("sideline:update-downloaded", handler);
  },
  installDownloadedUpdate: () => ipcRenderer.invoke("sideline:install-update") as Promise<void>,
  onCatalogStale: (listener) => {
    const handler = (): void => listener();
    ipcRenderer.on("sideline:catalog-stale", handler);
    return () => ipcRenderer.removeListener("sideline:catalog-stale", handler);
  },
};

contextBridge.exposeInMainWorld("sideline", bridge);
