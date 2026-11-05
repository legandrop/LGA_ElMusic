import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Categorías del log de diagnóstico: los errores se registran siempre; los eventos
// informativos de cada categoría se pueden apagar desde Help › Diagnostic log, para no inundar el log ni frenar la app.
// La elección queda en logging.json (preferencias); la variable ELMUSIC_LOG (all, none o lista separada por comas) manda
// sobre el archivo en una sesión de desarrollo. La categoría sale del prefijo del evento (tabla cerrada); lo que no
// coincide es «core» y no se apaga.
export const logCategories = ['labels', 'playlist', 'columns', 'page', 'related', 'releases', 'streamdeck'] as const;
export type LogCategory = typeof logCategories[number] | 'core';
export const logCategoryLabels: Record<typeof logCategories[number], string> = { labels: 'Record labels', playlist: 'Playlists', columns: 'Columns',
  page: 'Page script', related: 'Related music', releases: 'New releases', streamdeck: 'Stream Deck' };
const prefixes: Array<[RegExp, LogCategory]> = [
  [/^Sellos/i, 'labels'], [/^Playlist:/i, 'playlist'], [/^Columnas:/i, 'columns'], [/^Página:/i, 'page'], [/^Novedades:/i, 'releases'],
  [/^(?:Recomendaciones|Solicitud de reproducción Related|Configuración de recomendaciones|No se pudieron actualizar las recomendaciones)/i, 'related'],
  [/stream deck/i, 'streamdeck']];
const errorPattern = /^(?:No se pud|Falló|Error|Promesa rechazada|Proceso auxiliar|Página musical: proceso|Página musical sin responder|Canal Stream Deck no|Stream Deck no|Navegación bloqueada|Ventana bloqueada|Descarga bloqueada)|(?:: error|ilegible|rechazado|no se pudo|error en el script)/i;
export function categoryOf(event: string): LogCategory { return prefixes.find(([pattern]) => pattern.test(event))?.[1] ?? 'core'; }
export function isErrorEvent(event: string): boolean { return errorPattern.test(event); }

export type LogSettings = Record<typeof logCategories[number], boolean>;
export const defaultLogSettings: LogSettings = { labels: true, playlist: true, columns: true, page: true, related: true, releases: true, streamdeck: true };
const configPath = (preferences: string): string => path.join(preferences, 'logging.json');
export function parseLogSettings(data: unknown): LogSettings | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const values = data as Record<string, unknown>;
  if (Object.keys(values).some(key => !(logCategories as readonly string[]).includes(key) || typeof values[key] !== 'boolean')) return;
  return { ...defaultLogSettings, ...(values as Partial<LogSettings>) };
}
export function readLogSettings(preferences: string): LogSettings {
  const file = configPath(preferences);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaultLogSettings }; throw new Error('LOGGING_CONFIG_UNREADABLE'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('LOGGING_CONFIG_INVALID');
  let data: unknown;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('LOGGING_CONFIG_INVALID'); }
  const settings = parseLogSettings(data);
  if (!settings) throw new Error('LOGGING_CONFIG_INVALID');
  return settings;
}
export function saveLogSettings(preferences: string, settings: LogSettings): void {
  readLogSettings(preferences); // Un archivo ajeno o ilegible no se pisa.
  const file = configPath(preferences), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(settings)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('LOGGING_TEMP_CLEANUP_FAILED'); } }
}
// ELMUSIC_LOG=all | none | labels,page,… (sólo desarrollo): manda sobre logging.json mientras dura la sesión.
export function environmentLogSettings(value: string | undefined): LogSettings | undefined {
  if (value === undefined) return;
  const parts = value.split(',').map(part => part.trim().toLowerCase()).filter(Boolean);
  if (parts.includes('all')) return { ...defaultLogSettings };
  const settings = Object.fromEntries(logCategories.map(category => [category, parts.includes(category)])) as LogSettings;
  return settings;
}
// Un error se registra siempre; lo informativo, sólo con su categoría encendida.
export function shouldLog(event: string, settings: LogSettings): boolean {
  const category = categoryOf(event);
  return category === 'core' || isErrorEvent(event) || settings[category];
}
