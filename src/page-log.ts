import type { WebContents } from 'electron';
import { isMusicPage } from './music-shell';

// Log de la página musical. El script
// inyectado deja eventos en un arreglo propio del documento: un código de este conjunto cerrado, campos numéricos y, para
// los errores, un texto corto que main limpia (sin URLs, 160 caracteres). Main los toma de a tandas y los vuelca al
// diagnostic.log con el prefijo «Página:». Nada de la cuenta, de la sesión ni de la cola de Apple pasa por acá.
export const pageLogEvents: Record<string, string> = {
  'columns-applied': 'columnas aplicadas', 'columns-reorder': 'columna movida', 'columns-resize': 'columna redimensionada',
  'columns-toggle': 'columna mostrada u ocultada', 'columns-reset': 'columnas restablecidas', 'columns-menu': 'menú de columnas abierto',
  'list-sort': 'lista ordenada', 'label-years': 'años en la página del sello', 'label-table': 'lista de discos del sello dibujada',
  'label-table-sort': 'lista de discos del sello ordenada', 'label-page': 'página de sello detectada', 'album-link': 'enlace propio de álbum abierto', 'error': 'error en el script de la página',
  'columns-gesture': 'gesto en el encabezado', 'labels-state': 'estado de la columna Label', 'header-metrics': 'medidas del encabezado',
  'label-play': 'play en un disco del sello', 'play-wait': 'espera entre el clic en Play y la reacción del reproductor', 'sidebar-items': 'ítems propios en la barra lateral', 'sidebar-item-shape': 'la barra lateral de Apple cambió de forma: sin ítems propios',
  'header-play': 'clic en Play o Shuffle del encabezado', 'follow-playing': 'scroll al tema que suena', 'page-slow': 'página lenta (tareas largas del navegador)',
  'busy': 'espera entre un clic o un pegado y la página nueva en pantalla (línea de carga)', 'play-source': 'clic en la línea del LCD (canción: volver al origen del Play; álbum o artista)', 'play-source-set': 'origen del último Play recordado', 'artist-link': 'clic en un enlace de artista propio', 'columns-fit': 'anchos achicados en pantalla para que ninguna columna quede sin lugar',
  'panel-return': 'regreso con Back a un panel propio (New releases o sello) reabierto con su scroll',
  'panel-park': 'panel propio escondido al salir de su página y mostrado al volver con Back', 'release-detail': 'disco desplegado arriba de un panel propio'
};
export const pageLogLimits = { batch: 50, fields: 20, text: 160 } as const;
const guard = `if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return null;`;
export const wakeMessage = 'elMusic.log.ready';
export const takePageLogScript = `(() => { ${guard}
  const root = document.documentElement, key = Symbol.for('el-music.log'), entries = root[key];
  if (!Array.isArray(entries) || !entries.length) return null;
  root[key] = [];
  return JSON.stringify(entries.slice(0, ${pageLogLimits.batch})).slice(0, 20000);
})()`;

// Función que los scripts inyectados usan para registrar: no acumula nada con la categoría «page» apagada; tope 200.
export const pageLogFunctionScript = `const pageLog = (event, fields) => {
  try {
    const root = document.documentElement; if (root[Symbol.for('el-music.log-enabled')] === false) return;
    const entries = root[Symbol.for('el-music.log')] ||= []; if (entries.length >= 200) return;
    entries.push({ event, fields: fields || {} }); console.debug(${JSON.stringify(wakeMessage)});
  } catch { /* sin log */ }
};`;
export const pageLogEnabledScript = (enabled: boolean): string => `(() => { ${guard} document.documentElement[Symbol.for('el-music.log-enabled')] = ${enabled === true}; return true; })()`;
export interface PageLogEntry { event: string; fields: Record<string, number | string> }
const cleanText = (value: string): string => value.replace(/\b(?:https?|wss?|file|blob|data):[^\s]+/gi, '<url>').replace(/[^\p{L}\p{N} .,:;()<>'"_\-\/=+*#\[\]]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, pageLogLimits.text);
export function parsePageLog(value: unknown): PageLogEntry[] {
  if (typeof value !== 'string') return [];
  let data: unknown;
  try { data = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const entries: PageLogEntry[] = [];
  for (const item of data.slice(0, pageLogLimits.batch)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const { event, fields } = item as { event?: unknown; fields?: unknown };
    if (typeof event !== 'string' || !Object.hasOwn(pageLogEvents, event)) continue;
    const result: Record<string, number | string> = {};
    if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
      for (const [key, raw] of Object.entries(fields as Record<string, unknown>).slice(0, pageLogLimits.fields)) {
        if (!/^[a-zA-Z][\w]{0,30}$/.test(key)) continue;
        if (typeof raw === 'number' && Number.isFinite(raw)) result[key] = Math.round(raw * 1000) / 1000;
        else if (typeof raw === 'string' && ['texto', 'donde', 'clave', 'orden', 'ocultas'].includes(key)) { const text = cleanText(raw); if (text) result[key] = text; }
      }
    }
    entries.push({ event, fields: result });
  }
  return entries;
}

export function installPageLog(contents: WebContents, log: (event: string, fields?: Record<string, string | number | boolean>) => void): void {
  let polling = false, stopped = false;
  const poll = async (): Promise<void> => {
    if (polling || stopped || contents.isDestroyed() || !isMusicPage(contents.getURL())) return;
    polling = true;
    try {
      for (const entry of parsePageLog(await contents.mainFrame.executeJavaScript(takePageLogScript))) log('Página: ' + pageLogEvents[entry.event], entry.fields);
    } catch { /* Página en navegación: se lee en el próximo ciclo. */ }
    finally { polling = false; }
  };
  const wake = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
    if (details.message === wakeMessage && details.frame === contents.mainFrame) void poll();
  };
  contents.on('console-message', wake);
  const timer = setInterval(() => void poll(), 5000);
  contents.once('destroyed', () => { stopped = true; clearInterval(timer); contents.removeListener('console-message', wake); });
}
