import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { isMusicPage } from './music-shell';

// Columnas de las listas de canciones: orden, columnas ocultas y anchos, persistentes en
// columns.json (preferencias). La página las aplica sobre la tabla de Apple y, cuando el usuario las cambia (arrastre, ancho,
// menú), deja la configuración entera en un dataset; main la valida contra este conjunto cerrado y la guarda.
export const columnKeys = ['song', 'artist', 'album', 'released', 'label', 'genre', 'time'] as const;
export type ColumnKey = typeof columnKeys[number];
export interface ColumnConfig { order: ColumnKey[]; hidden: ColumnKey[]; widths: Partial<Record<ColumnKey, number>> }
export const columnLimits = { minWidth: 40, maxWidth: 1200, bytes: 4096 } as const;
// Canción primera por defecto.
export const defaultColumns: ColumnConfig = { order: ['song', 'artist', 'album', 'released', 'label', 'genre', 'time'], hidden: [], widths: {} };

const isKey = (value: unknown): value is ColumnKey => typeof value === 'string' && (columnKeys as readonly string[]).includes(value);
// Toda columna aparece una vez en el orden; Canción nunca se oculta (lleva el título); anchos enteros acotados, también el de Canción.
export function parseColumns(value: unknown): ColumnConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(key => !['order', 'hidden', 'widths'].includes(key))) return;
  const order = data.order, hidden = data.hidden ?? [], widths = data.widths ?? {};
  if (!Array.isArray(order) || order.length !== columnKeys.length || !order.every(isKey) || new Set(order).size !== columnKeys.length) return;
  if (!Array.isArray(hidden) || !hidden.every(isKey) || hidden.includes('song') || new Set(hidden).size !== hidden.length) return;
  if (!widths || typeof widths !== 'object' || Array.isArray(widths)) return;
  const result: ColumnConfig = { order: [...order], hidden: [...hidden], widths: {} };
  for (const [key, width] of Object.entries(widths as Record<string, unknown>)) {
    if (!isKey(key) || !Number.isInteger(width) || (width as number) < columnLimits.minWidth || (width as number) > columnLimits.maxWidth) return;
    result.widths[key] = width as number;
  }
  return result;
}

const configPath = (preferences: string): string => path.join(preferences, 'columns.json');
export function readColumns(preferences: string): ColumnConfig {
  const file = configPath(preferences);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(defaultColumns); throw new Error('COLUMNS_CONFIG_UNREADABLE'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > columnLimits.bytes) throw new Error('COLUMNS_CONFIG_INVALID');
  let data: unknown;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('COLUMNS_CONFIG_INVALID'); }
  const config = parseColumns(data);
  if (!config) throw new Error('COLUMNS_CONFIG_INVALID');
  return config;
}
export function saveColumns(preferences: string, config: ColumnConfig): void {
  readColumns(preferences); // Un archivo ajeno o ilegible no se pisa.
  const file = configPath(preferences), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('COLUMNS_TEMP_CLEANUP_FAILED'); } }
}

const guard = `if (top !== self || location.protocol !== 'https:' || location.hostname !== 'music.apple.com' || location.port || new URL(location.href).username || new URL(location.href).password) return null;`;
// La página guarda la configuración en un símbolo propio y vuelve a dibujar las listas.
export function columnsScript(config: ColumnConfig): string {
  return `(() => { ${guard}
    document.documentElement[Symbol.for('el-music.columns')] = ${JSON.stringify(config)};
    document.dispatchEvent(new Event('el-music-columns')); return true; })()`;
}
export const wakeMessage = 'elMusic.columns.changed';
export const takeColumnsScript = `(() => { ${guard}
  const root = document.documentElement, value = root.dataset.elMusicColumnsRequest;
  if (value === undefined) return null;
  delete root.dataset.elMusicColumnsRequest;
  return value.slice(0, ${columnLimits.bytes});
})()`;

export function installColumnPrefs(contents: WebContents, preferences: string, log: (event: string, fields?: Record<string, string | number | boolean>) => void): { current: () => ColumnConfig } {
  let config: ColumnConfig; let stopped = false, polling = false, broken = false;
  try { config = readColumns(preferences); }
  catch { config = structuredClone(defaultColumns); broken = true; log('Columnas: configuración ilegible, se usan las de fábrica sin guardar'); }
  log('Columnas: configuración cargada', { orden: config.order.join(','), ocultas: config.hidden.join(',') || '-', anchos: Object.keys(config.widths).length });
  const poll = async (): Promise<void> => {
    if (polling || stopped || contents.isDestroyed() || !isMusicPage(contents.getURL())) return;
    polling = true;
    try {
      const taken: unknown = await contents.mainFrame.executeJavaScript(takeColumnsScript);
      if (typeof taken !== 'string') return;
      let data: unknown;
      try { data = JSON.parse(taken); } catch { log('Columnas: pedido ilegible de la página'); return; }
      const next = parseColumns(data);
      if (!next) { log('Columnas: pedido rechazado', { bytes: taken.length }); return; }
      config = next;
      log('Columnas: cambio recibido', { orden: next.order.join(','), ocultas: next.hidden.join(',') || '-', anchos: Object.entries(next.widths).map(([key, width]) => key + '=' + width).join(',') || '-' });
      if (broken) return;
      try { saveColumns(preferences, next); } catch { log('Columnas: no se pudo guardar columns.json'); }
    } catch { /* Página en navegación: se vuelve a leer en el próximo ciclo. */ }
    finally { polling = false; }
  };
  const wake = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
    if (details.message === wakeMessage && details.frame === contents.mainFrame) void poll();
  };
  contents.on('console-message', wake);
  const timer = setInterval(() => void poll(), 2000);
  contents.once('destroyed', () => { stopped = true; clearInterval(timer); contents.removeListener('console-message', wake); });
  return { current: () => config };
}
