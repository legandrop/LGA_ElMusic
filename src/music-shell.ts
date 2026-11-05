import type { WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { nativePlayerFunction } from './player';
import { artistColorScript, defaultArtistColor } from './appearance';
import { pageLogFunctionScript } from './page-log';

export function isMusicPage(url: string): boolean {
  try { const value = new URL(url); return value.protocol === 'https:' && value.hostname === 'music.apple.com' &&
    !value.port && !value.username && !value.password; } catch { return false; }
}

// columns y pageLog: configuración de columnas y si la página debe acumular su log (categoría «page»), leídos en cada carga.
export function installMusicShell(contents: WebContents, onFailure: () => void, platform = process.platform,
  artistColor: () => string = () => defaultArtistColor, columns: () => unknown = () => undefined, pageLog: () => boolean = () => true): void {
  const font = fs.readFileSync(path.join(__dirname, 'ui', 'fonts', 'PretendardVariable.woff2')).toString('base64');
  const css = `@font-face { font-family: 'Pretendard Variable'; font-style: normal; font-weight: 100 900; font-display: swap; src: url(data:font/woff2;base64,${font}) format('woff2'); }\n` +
    fs.readFileSync(path.join(__dirname, 'ui', 'music-shell.css'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, 'ui', 'music-shell.js'), 'utf8');
  contents.on('dom-ready', () => {
    if (!isMusicPage(contents.getURL())) return;
    void contents.mainFrame.executeJavaScript(`(() => {
      if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return;
      document.documentElement.dataset.elMusicPlatform = ${JSON.stringify(platform === 'darwin' ? 'mac' : 'windows')};
      if (!document.getElementById('el-music-shell-style')) { const style = document.createElement('style');
        style.id = 'el-music-shell-style'; style.textContent = ${JSON.stringify(css)}; document.head.appendChild(style); }
      ${artistColorScript(artistColor())};
      document.documentElement[Symbol.for('el-music.columns')] = ${JSON.stringify(columns() ?? null)};
      document.documentElement[Symbol.for('el-music.log-enabled')] = ${pageLog() === true};
      ${pageLogFunctionScript}
      const readPlaying = ${nativePlayerFunction};
      ${script}
    })()`).catch(onFailure);
  });
}

// Back del menú (Alt+Left, 0.1.55): el Back de la página con la línea de carga encendida antes de la
// tarea larga con que Apple procesa el regreso. Devuelve false si la página no lo puede tomar (shell sin instalar o sin
// entrada anterior en este documento): main usa entonces el historial del navegador, como antes.
export const historyBackScript = `(() => {
  if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return false;
  if (!document.getElementById('el-music-navigation') || globalThis.navigation?.canGoBack !== true) return false;
  dispatchEvent(new CustomEvent('el-music:history', { detail: -1 })); return true;
})()`;
