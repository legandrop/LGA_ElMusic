import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('windowMenu', Object.freeze({
  open: (...args: unknown[]) => ipcRenderer.invoke('window-bar:menu', ...args)
}));
