import { WebContentsView, ipcMain } from 'electron';
import type { BaseWindow, BaseWindowConstructorOptions } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { trustedLocalRequest } from './policy';

export const windowBarHeight = 54;

export function musicWindowOptions(platform = process.platform): BaseWindowConstructorOptions {
  return { titleBarStyle: 'hidden', autoHideMenuBar: true,
    ...(platform === 'darwin' ? { trafficLightPosition: { x: 14, y: 19 } } :
      { titleBarOverlay: { color: '#202020', symbolColor: '#d8d8d8', height: windowBarHeight } }) };
}

// El menú privilegiado vive en una vista local pequeña; Apple nunca recibe este puente.
export async function createWindowBar(window: BaseWindow, openMenu: () => void, captureOnly = false): Promise<WebContentsView> {
  const view = new WebContentsView({ webPreferences: {
    preload: path.join(__dirname, 'window-bar-preload.js'), nodeIntegration: false,
    contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, navigateOnDragDrop: false,
    ...(captureOnly ? { offscreen: true, backgroundThrottling: false } : {})
  } });
  const contents = view.webContents;
  const url = pathToFileURL(path.join(__dirname, 'ui', 'window-bar.html')).href;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const block = (event: Electron.Event): void => event.preventDefault();
  contents.on('will-navigate', block);
  contents.on('will-redirect', block);
  contents.on('will-frame-navigate', block);
  const channel = 'window-bar:menu';
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (window.isDestroyed() || contents.isDestroyed() || !trustedLocalRequest(
      event.sender.id, event.senderFrame === contents.mainFrame, event.senderFrame?.url ?? '',
      contents.id, url, args)) throw new Error('UNTRUSTED_WINDOW_MENU');
    openMenu();
  });
  contents.once('destroyed', () => ipcMain.removeHandler(channel));
  window.once('closed', () => { if (!contents.isDestroyed()) contents.close(); });
  try { await contents.loadURL(url); }
  catch (error) { if (!contents.isDestroyed()) contents.close(); throw error; }
  return view;
}

export function fitWindowBar(window: BaseWindow, view: WebContentsView): void {
  const [width] = window.getContentSize();
  view.setBounds({ x: process.platform === 'darwin' ? 78 : 0, y: 0,
    width: Math.min(60, width), height: windowBarHeight });
  window.contentView.addChildView(view);
}
