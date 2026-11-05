import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('elMusic', Object.freeze({
  getAppInfo: (...args: unknown[]) => ipcRenderer.invoke('local:getAppInfo', ...args).then(info => ({ ...info,
    rendererSandboxed: process.sandboxed, rendererContextIsolated: process.contextIsolated })),
  openDataDirectory: (...args: unknown[]) => ipcRenderer.invoke('local:openDataDirectory', ...args),
  copyDiagnostics: (...args: unknown[]) => ipcRenderer.invoke('local:copyDiagnostics', ...args),
  setLastFmKey: (...args: unknown[]) => ipcRenderer.invoke('local:setLastFmKey', ...args),
  setArtistColor: (...args: unknown[]) => ipcRenderer.invoke('local:setArtistColor', ...args),
  openLastFmSetup: (...args: unknown[]) => ipcRenderer.invoke('local:openLastFmSetup', ...args),
  closeRecommendationSettings: (...args: unknown[]) => ipcRenderer.invoke('local:closeRecommendationSettings', ...args)
}));
